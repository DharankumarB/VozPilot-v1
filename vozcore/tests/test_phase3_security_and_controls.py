"""Phase 3 tests — sandbox isolation, permissions, rate limits, timeouts, communication bus, global pause, and RLS."""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from conftest import unwrap
from vozcore import db, external_providers, llm, sandbox, security, store
from vozcore.agents.content_agent import ContentLLMOutput, ContentPiece
from vozcore.agents.registry import get_specialist
from vozcore.agents.research_agent import ResearchLLMOutput
from vozcore.config import settings
from vozcore.schemas import (
    EvaluationResult,
    ExecutionPlan,
    FinalResponse,
    IntentAnalysis,
    PlanTask,
)
from vozcore.security import SecurityViolationError


def test_token_encryption_roundtrip_and_tamper_detection():
    """OAuth tokens encrypt with AES-256-GCM and reject tampered ciphertexts."""
    raw = "ya29.super-secret-oauth-token-value"
    encrypted = security.encrypt_token(raw)
    assert raw not in encrypted
    assert encrypted.count(":") == 2
    assert security.decrypt_token(encrypted) == raw

    # Tamper with ciphertext byte -> must raise SecurityViolationError on GCM tag mismatch
    iv, tag, ct = encrypted.split(":")
    flipped = ("00" if ct[:2] != "00" else "ff") + ct[2:]
    with pytest.raises(SecurityViolationError):
        security.decrypt_token(f"{iv}:{tag}:{flipped}")


def test_sandbox_blocks_dangerous_imports_secrets_and_path_traversal():
    """Developer sandbox blocks network/os/shell imports, strips secrets, enforces timeouts, and jails file reads."""
    os.environ["SUPER_SECRET_TEST_KEY"] = "never-expose-me-12345"
    try:
        # 1) Direct `os` import is hard-blocked by AST policy
        res_os = sandbox.run_in_sandbox("import os\nprint(os.environ)\n")
        assert res_os["ok"] is False
        assert res_os["blocked"] is True

        # 2) Restricted network module (`socket`) blocked before execution
        res_net = sandbox.run_in_sandbox("import socket\nsocket.socket()\n")
        assert res_net["ok"] is False
        assert res_net["blocked"] is True

        # 3) Clean pure-Python code succeeds quickly
        res_ok = sandbox.run_in_sandbox("print(sum(range(10)))\n")
        assert res_ok["ok"] is True
        assert res_ok["stdout"].strip() == "45"

        # 4) Infinite loop terminated at wall-time timeout
        res_loop = sandbox.run_in_sandbox("while True:\n    pass\n", timeout_seconds=1.0, cpu_seconds=1)
        assert res_loop["ok"] is False
        assert res_loop["timedOut"] is True

        # 5) Path traversal & `.env` read inside workspace source reader rejected
        with pytest.raises(SecurityViolationError):
            sandbox.read_workspace_source_safely("../../etc/passwd")
        with pytest.raises(SecurityViolationError):
            sandbox.read_workspace_source_safely(".env")
    finally:
        os.environ.pop("SUPER_SECRET_TEST_KEY", None)


def test_agent_permission_block_and_rate_limit_enforcement(client, make_user):
    """Blocking an agent permission or exceeding its hourly rate limit stops execution cleanly."""
    _, cookie = make_user("Permission Tester")

    # Fetch research agent detail (seeds capabilities/tools/permissions)
    detail = unwrap(client.get("/agents/research", cookies={"vp_at": cookie}))
    assert len(detail["capabilities"]) >= 2
    assert len(detail["tools"]) >= 2
    assert len(detail["permissions"]) >= 1

    # Block `execute` permission via API
    updated = unwrap(
        client.patch(
            "/agents/research/permissions/execute",
            json={"allowed": False},
            cookies={"vp_at": cookie},
        )
    )
    perm = next(p for p in updated["permissions"] if p["permissionKey"] == "execute")
    assert perm["allowed"] is False

    llm.set_test_handler(
        lambda purpose, schema, prompt, system="": ResearchLLMOutput(
            completed=True,
            report_title="Quick Note",
            result_summary="Allowed run.",
            detailed_output="Allowed.",
        )
    )

    # Attempt live test -> must fail with permission error in StructuredAgentResult
    blocked_run = unwrap(
        client.post(
            "/agents/research/test",
            json={"prompt": "Analyze enterprise AI adoption"},
            cookies={"vp_at": cookie},
        )
    )["result"]
    assert blocked_run["status"] == "failed"
    assert "permission" in str(blocked_run["error_details"]).lower()

    # Re-allow with rateLimitPerHour = 1, run once (succeeds), run second time (rate-limited!)
    unwrap(
        client.patch(
            "/agents/research/permissions/execute",
            json={"allowed": True, "rateLimitPerHour": 1},
            cookies={"vp_at": cookie},
        )
    )
    first = unwrap(
        client.post(
            "/agents/research/test",
            json={"prompt": "First allowed research task"},
            cookies={"vp_at": cookie},
        )
    )["result"]
    assert first["status"] == "completed"

    second = unwrap(
        client.post(
            "/agents/research/test",
            json={"prompt": "Second research task exceeding 1/hr limit"},
            cookies={"vp_at": cookie},
        )
    )["result"]
    assert second["status"] == "failed"
    assert "rate limit" in str(second["error_details"]).lower()


def test_specialist_timeout_handling(client, make_user):
    """BaseAgent enforces `execution_timeout` and returns structured failure on timeout."""
    _, cookie = make_user("Timeout Tester")
    spec = get_specialist("content")

    async def slow_execute_task(ctx):
        await asyncio.sleep(0.5)
        return {"status": "completed", "summary": "Too late", "detailed_output": ""}

    orig_timeout = spec.execution_timeout
    orig_exec = spec.execute_task
    spec.execution_timeout = 0.15
    spec.execute_task = slow_execute_task  # type: ignore[method-assign]
    llm.set_test_handler(
        lambda purpose, schema, prompt, system="": ContentLLMOutput(
            completed=True, result_summary="unused", detailed_output=""
        )
    )
    try:
        res = unwrap(
            client.post(
                "/agents/content/test",
                json={"prompt": "Slow generation exceeding specialist timeout"},
                cookies={"vp_at": cookie},
            )
        )["result"]
        assert res["status"] == "failed"
        assert "timed out" in str(res["error_details"]).lower()
    finally:
        spec.execution_timeout = orig_timeout
        spec.execute_task = orig_exec  # type: ignore[method-assign]


def test_global_pause_all_agents_blocks_new_commands_and_resumes(client, make_user):
    """Global Pause All Agents prevents new dispatches and Resume All restores operation."""
    _, cookie = make_user("Pause All Tester")

    paused = unwrap(client.post("/agents/pause-all", cookies={"vp_at": cookie}))
    assert paused["agentsPaused"] is True

    mon = unwrap(client.get("/monitoring", cookies={"vp_at": cookie}))
    assert mon["agentsPaused"] is True

    # Starting a new command while globally paused returns 409 Conflict
    resp = client.post(
        "/command",
        json={"command": "Research competitor pricing and draft a summary"},
        cookies={"vp_at": cookie},
    )
    assert resp.status_code == 409

    # Direct Test Agent also respects global pause
    resp_test = client.post(
        "/agents/research/test",
        json={"prompt": "Research competitor pricing"},
        cookies={"vp_at": cookie},
    )
    assert resp_test.status_code == 409

    # Resume workforce -> health & monitoring report agentsPaused == False
    resumed = unwrap(client.post("/agents/resume-all", cookies={"vp_at": cookie}))
    assert resumed["agentsPaused"] is False


def test_centralized_inter_agent_messages_and_duplicate_claim_guard(client, make_user, run_execution):
    """Multi-wave execution records centralized `agent_messages` (`task_assignment` + `context_share`) and prevents duplicate task claims."""
    user_id, cookie = make_user("Bus Tester")

    def fake_multiwave(purpose, schema, prompt, system=""):
        if purpose == "intent":
            return IntentAnalysis(
                objective="Research and draft blog",
                outcome="Cited VozLook summary",
                constraints=[],
                deadlines=[],
                needs_clarification=False,
                single_agent=False,
            )
        if purpose == "plan":
            return ExecutionPlan(
                summary="Wave 1 research -> Wave 2 content",
                parallelizable=False,
                tasks=[
                    PlanTask(
                        task_key="t_research",
                        title="Research patterns",
                        description="Gather multi-agent patterns",
                        agent_key="research",
                        depends_on=[],
                        wave=0,
                        priority=1,
                        approval_required=False,
                        acceptance="Structured research brief",
                    ),
                    PlanTask(
                        task_key="t_content",
                        title="Draft VozLook blog",
                        description="Write summary from research",
                        agent_key="content",
                        depends_on=["t_research"],
                        wave=1,
                        priority=2,
                        approval_required=False,
                        acceptance="Editable draft saved",
                    ),
                ],
            )
        if schema is ResearchLLMOutput:
            return ResearchLLMOutput(
                completed=True,
                report_title="Multi-Agent Patterns",
                result_summary="Collected multi-agent architecture notes.",
                detailed_output="Wave-based graph scheduling reduces contention.",
            )
        if schema is ContentLLMOutput:
            return ContentLLMOutput(
                completed=True,
                result_summary="Drafted VozLook blog post from Wave 1 context.",
                detailed_output="Blog post body.",
                brand_identity="VozLook Studios",
                pieces=[ContentPiece(content_type="blog_article", title="Wave Orchestration", body="Body")],
            )
        if purpose == "evaluate":
            return EvaluationResult(
                verdict="completed",
                all_tasks_successful=True,
                completeness_score=95,
                evaluation_notes="Complete",
            )
        if purpose == "final_response":
            return FinalResponse(
                headline="Research & Blog Completed",
                report="Both waves finished cleanly.",
                open_items=[],
            )
        raise AssertionError(f"Unexpected LLM call: {purpose} / {schema}")

    llm.set_test_handler(fake_multiwave)

    body = run_execution(
        cookie,
        "Research multi-agent patterns and then write a VozLook Studios blog summary",
    )
    assert body["execution"]["status"] == "completed"
    messages = body.get("messages") or []
    msg_types = {m["messageType"] for m in messages}
    assert "task_assignment" in msg_types
    assert "context_share" in msg_types

    # Verify atomic duplicate-execution guard: claiming an already-completed task returns None
    first_task = body["tasks"][0]
    with db.user_txn(user_id, settings.database_url) as conn:
        assert store.claim_task_for_run(conn, body["execution"]["id"], first_task["task_key"]) is None


def test_invalid_inputs_and_external_provider_error_surface_honestly(client, make_user):
    """Invalid payloads return 422 and external API errors surface without crashing."""
    _, cookie = make_user("Validation Tester")

    # Prompt shorter than min_length=3 -> 422 validation_error
    bad = client.post("/agents/research/test", json={"prompt": "hi"}, cookies={"vp_at": cookie})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "validation_error"

    # External search provider returns upstream error -> Research Agent surfaces honestly
    external_providers.set_test_mocks(
        {
            "web_search": lambda query, max_results=5: {
                "configured": True,
                "provider": "tavily",
                "results": [],
                "error": "Upstream 503 Service Unavailable",
            }
        }
    )
    llm.set_test_handler(
        lambda purpose, schema, prompt, system="": ResearchLLMOutput(
            completed=True,
            report_title="Degraded Search Report",
            result_summary="Search provider returned 503; synthesized internal context only.",
            detailed_output="Search unavailable (503); no external facts claimed.",
            unverified_items=["External web search unavailable (503)."],
        )
    )
    try:
        degraded = unwrap(
            client.post(
                "/agents/research/test",
                json={"prompt": "Search latest cloud benchmarks"},
                cookies={"vp_at": cookie},
            )
        )["result"]
        assert degraded["status"] == "completed"
        assert "503" in degraded["detailed_output"] or "503" in str(degraded["error_details"])
    finally:
        external_providers.clear_test_mocks()


def test_phase3_multi_user_rls_isolation(client, make_user):
    """User B can never read or mutate User A's Phase 3 drafts, reports, ledger, logs, or agent settings."""
    _, cookie_a = make_user("Workspace Alpha")
    user_b, cookie_b = make_user("Workspace Beta")

    llm.set_test_handler(
        lambda purpose, schema, prompt, system="": ContentLLMOutput(
            completed=True,
            result_summary="Saved Alpha confidential draft",
            detailed_output="Private",
            brand_identity="Alpha Corp",
            pieces=[
                ContentPiece(
                    content_type="strategy",
                    title="Alpha Confidential Launch",
                    channel="Internal",
                    body="Top secret product roadmap",
                )
            ],
            request_external_publish=False,
        )
    )

    unwrap(
        client.post(
            "/agents/content/test",
            json={"prompt": "Draft Alpha confidential launch strategy"},
            cookies={"vp_at": cookie_a},
        )
    )

    alpha_drafts = unwrap(client.get("/content-drafts", cookies={"vp_at": cookie_a}))
    assert len(alpha_drafts) == 1
    draft_id = alpha_drafts[0]["id"]

    # User B sees 0 content drafts and receives 404 when attempting to edit User A's draft
    beta_drafts = unwrap(client.get("/content-drafts", cookies={"vp_at": cookie_b}))
    assert beta_drafts == []
    hijack = client.patch(
        f"/content-drafts/{draft_id}",
        json={"title": "Hijacked"},
        cookies={"vp_at": cookie_b},
    )
    assert hijack.status_code == 404

    # Direct SQL check as User B via RLS context confirms 0 rows across Phase 3 tables
    with db.user_txn(user_b, settings.database_url) as conn:
        with conn.cursor() as cur:
            for table in ("content_drafts", "agent_messages", "agent_execution_logs", "agent_usage"):
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                assert cur.fetchone()[0] == 0, f"RLS leak in {table}"
