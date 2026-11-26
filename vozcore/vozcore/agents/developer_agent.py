"""Agent 7 — Developer Agent (secure coding assistant + isolated sandbox).

Capabilities:
- Generate code, debug errors, review code quality, generate unit tests,
  explain programming issues, and create technical documentation.
- Analyze workspace source files safely (`analyze_source_file` — jailed to repo,
  blocks `.env`, `.git`, `.data`, secrets).
- Execute & verify Python code / unit tests inside an isolated sandbox
  (`run_sandboxed_code` — CPU, memory, file-size, timeout, AST, and zero-secret
  env isolation, no unrestricted shell).
- Analyze authorized GitHub repositories (`inspect_github_repo`).
- Require explicit human approval before pushing code or modifying production
  repositories (`propose_repo_push`).
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from pydantic import BaseModel, Field

from .. import external_providers, sandbox
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)

FILE_PATH_RE = re.compile(r"\b([A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|mjs|sql|json|md))\b")
GITHUB_REPO_RE = re.compile(r"\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)\b")


class GeneratedCodeArtifact(BaseModel):
    filename: str = "solution.py"
    language: str = "python"
    code: str = ""
    unit_tests: str = ""


class DeveloperLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    code_artifacts: list[GeneratedCodeArtifact] = Field(default_factory=list)
    run_verification_in_sandbox: bool = False
    verification_python_snippet: str = ""
    code_review_findings: list[str] = Field(default_factory=list)
    request_repo_push: bool = False
    missing_information: list[str] = Field(default_factory=list)


class DeveloperAgent(BaseAgent):
    agent_id = "developer"
    name = "Developer Agent"
    description = (
        "Generates and reviews code, debugs issues, writes documentation and unit tests, "
        "verifies snippets in a CPU/memory/env-isolated sandbox, and analyzes authorized repos."
    )
    icon = "code-xml"
    selection_hints = [
        "code",
        "bug",
        "debug",
        "api",
        "refactor",
        "implement",
        "unit test",
        "test",
        "documentation",
        "review",
        "github",
        "repository",
        "python",
        "typescript",
        "function",
    ]
    capabilities = [
        CapabilitySpec("code_gen_and_debug", "Code generation & debugging", "Generate clean implementations, diagnose bugs, and explain root causes."),
        CapabilitySpec("code_review_and_docs", "Code review & documentation", "Review source files for correctness/security and write developer docs."),
        CapabilitySpec("unit_test_sandbox", "Unit tests & isolated sandbox", "Generate unit tests and execute Python verification in a resource-limited sandbox."),
        CapabilitySpec("github_analysis", "Authorized GitHub analysis", "Inspect authorized GitHub repositories read-only via OAuth."),
        CapabilitySpec("gated_repo_changes", "Approval-gated repo pushes", "Require explicit human approval before pushing or modifying repositories."),
    ]
    system_instructions = (
        "You are the Developer Agent in the VozPilot autonomous workforce. "
        "Deliver production-grade code, debugging diagnoses, code reviews, unit tests, "
        "and technical documentation.\n"
        "- Reference ONLY source files actually loaded in `INSPECTED SOURCE FILES` or user input.\n"
        "- Never expose environment variables, keys, or secrets.\n"
        "- When writing Python code or unit tests that can be self-verified with standard library "
        "Python (`unittest`/`assert`, no network or OS access), populate `verification_python_snippet` "
        "and set `run_verification_in_sandbox=true`.\n"
        "- Never claim to have pushed code to a remote repository — pushes require human approval."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned software engineering subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("workspace.source_read", "workspace", "Read non-sensitive source files inside the workspace repository.", default_allowed=True),
        PermissionSpec("sandbox.execute", "sandbox", "Execute Python snippets inside the CPU/memory/env-isolated sandbox.", default_allowed=True),
        PermissionSpec("github.read", "oauth:github", "Read authorized GitHub repositories.", default_allowed=True),
        PermissionSpec("github.push", "oauth:github", "Push commits or modify remote repositories (always requires approval).", default_allowed=True, requires_approval=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="analyze_source_file",
                name="Analyze Workspace Source File",
                description="Read a workspace source file safely (blocks .env, .git, secrets and path traversal).",
                handler=self._tool_read_source,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="run_sandboxed_code",
                name="Run Code in Isolated Sandbox",
                description="Execute Python code/tests with CPU, memory, filesystem, AST and zero-secret isolation.",
                handler=self._tool_run_sandbox,
                category="sandbox",
            ),
            ToolSpec(
                tool_key="inspect_github_repo",
                name="Inspect Authorized GitHub Repo",
                description="Read repository metadata or file contents via GitHub OAuth.",
                handler=self._tool_github_inspect,
                category="oauth_read",
                required_integration="github",
            ),
            ToolSpec(
                tool_key="propose_repo_push",
                name="Push / Modify Repository (Approval Gate)",
                description="Request human approval before pushing code or modifying a repository.",
                handler=self._tool_propose_push,
                category="oauth_write",
                requires_approval=True,
                required_integration="github",
            ),
        ]

    async def _tool_read_source(self, ctx: AgentExecutionContext, path: str) -> dict[str, Any]:
        ctx.check_permission("workspace.source_read")
        return await asyncio.to_thread(sandbox.read_workspace_source_safely, path)

    async def _tool_run_sandbox(self, ctx: AgentExecutionContext, code: str, language: str = "python") -> dict[str, Any]:
        ctx.check_permission("sandbox.execute")
        return await asyncio.to_thread(sandbox.run_in_sandbox, code, language)

    async def _tool_github_inspect(self, ctx: AgentExecutionContext, owner_repo: str, path: str = "") -> dict[str, Any]:
        ctx.check_permission("github.read")
        return await external_providers.github_inspect_repo(ctx.user_id, owner_repo=owner_repo, path=path)

    async def _tool_propose_push(self, ctx: AgentExecutionContext, repo: str, summary: str, artifacts: list[dict[str, Any]]) -> dict[str, Any]:
        ctx.check_permission("github.push")
        return {"pushed": False, "repo": repo, "summary": summary}

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        combined = f"{ctx.input.title}\n{ctx.input.description}"

        # 1. Inspect any referenced workspace source files safely
        source_blocks: list[str] = []
        explicit_files = list(ctx.input.parameters.get("files") or []) + FILE_PATH_RE.findall(combined)
        seen_paths: set[str] = set()
        if explicit_files and ctx.tool_states.get("analyze_source_file", {}).get("enabled", True):
            for candidate in explicit_files[:4]:
                if candidate in seen_paths:
                    continue
                seen_paths.add(candidate)
                file_res = await ctx.invoke_tool("analyze_source_file", path=candidate)
                if file_res.get("exists") and file_res.get("content"):
                    source_blocks.append(f"--- FILE: {file_res['path']} ---\n{file_res['content'][:8000]}")
                    ctx.add_source(title=f"Workspace file: {file_res['path']}", source_type="workspace_file", verified=True)

        # 2. Optional GitHub repo inspection if explicitly passed in parameters
        github_block = ""
        gh_repo = ctx.input.parameters.get("github_repo")
        if gh_repo and ctx.tool_states.get("inspect_github_repo", {}).get("enabled", True):
            gh_res = await ctx.invoke_tool(
                "inspect_github_repo",
                owner_repo=str(gh_repo),
                path=str(ctx.input.parameters.get("github_path") or ""),
            )
            github_block = f"\nGITHUB_INSPECTION ({gh_repo}): {gh_res}\n"
            if gh_res.get("connected") and not gh_res.get("error"):
                ctx.add_source(title=f"GitHub: {gh_repo}", url=f"https://github.com/{gh_repo}", source_type="github", verified=True)

        # 3. Direct sandbox execution if `parameters.sandbox_code` was explicitly supplied
        direct_sandbox_result: dict[str, Any] | None = None
        if ctx.input.parameters.get("sandbox_code"):
            direct_sandbox_result = await ctx.invoke_tool(
                "run_sandboxed_code",
                code=str(ctx.input.parameters["sandbox_code"]),
                language=str(ctx.input.parameters.get("language") or "python"),
            )
            ctx.add_artifact("sandbox_execution", "Isolated Sandbox Run", direct_sandbox_result)

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + ("INSPECTED SOURCE FILES:\n" + "\n\n".join(source_blocks) + "\n\n" if source_blocks else "")
            + github_block
            + (f"SANDBOX PRE-RUN RESULT:\n{direct_sandbox_result}\n\n" if direct_sandbox_result else "")
            + "Provide the structured engineering deliverable."
        )

        parsed: DeveloperLLMOutput = await ctx.call_llm_structured(schema=DeveloperLLMOutput, prompt=prompt)

        for item in parsed.code_artifacts[:6]:
            ctx.add_artifact("code_artifact", f"Code: {item.filename}", item.model_dump())

        if parsed.code_review_findings:
            ctx.add_artifact("code_review", "Code Review Findings", {"findings": parsed.code_review_findings})

        if (
            parsed.run_verification_in_sandbox
            and parsed.verification_python_snippet.strip()
            and ctx.tool_states.get("run_sandboxed_code", {}).get("enabled", True)
        ):
            sbx_res = await ctx.invoke_tool(
                "run_sandboxed_code",
                code=parsed.verification_python_snippet,
                language="python",
            )
            ctx.add_artifact("sandbox_verification", "Sandbox Unit-Test / Verification Run", sbx_res)

        await_approval = False
        wants_push = bool(
            ctx.input.parameters.get("push")
            or re.search(r"\b(git\s+push|push\s+to\s+(main|production|github|origin)|modify\s+production\s+repo)\b", combined, re.I)
        )
        if wants_push or parsed.request_repo_push:
            gate = await ctx.invoke_tool(
                "propose_repo_push",
                repo=str(gh_repo or "workspace-repository"),
                summary=parsed.result_summary or ctx.input.title,
                artifacts=[a.model_dump() for a in parsed.code_artifacts[:3]],
            )
            if isinstance(gate, dict) and gate.get("approvalRequired"):
                await_approval = True
                ctx.add_artifact("approval_gate", "Repository push held for approval", gate)

        return {
            "status": "completed" if parsed.completed else "failed",
            "await_approval": await_approval,
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
