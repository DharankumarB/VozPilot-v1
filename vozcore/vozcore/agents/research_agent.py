"""Agent 1 — Research Agent.

Capabilities:
- Search the web via configured search provider (`web_search`).
- Fetch public URLs safely with SSRF protection (`fetch_url`).
- Recall prior verified workspace research (`search_saved_research`).
- Extract key findings, compare multiple sources, surface conflicts, separate
  facts from assumptions, flag unverified claims, preserve real URLs/citations,
  and persist structured reports to `research_reports`.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from pydantic import BaseModel, Field

from .. import db, external_providers
from ..db import Utf8Json as JSON
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)

URL_RE = re.compile(r"https?://[^\s)>\]\"']+")


class ResearchCitation(BaseModel):
    title: str = ""
    url: str = ""
    key_point: str = ""


class ResearchLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    report_title: str = "Research Brief"
    key_findings: list[str] = Field(default_factory=list)
    verified_facts: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    conflicting_information: list[str] = Field(default_factory=list)
    unverified_items: list[str] = Field(default_factory=list)
    cited_sources: list[ResearchCitation] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)


class ResearchAgent(BaseAgent):
    agent_id = "research"
    name = "Research Agent"
    description = (
        "Searches configured web providers and internal sources, compares evidence, "
        "separates facts from assumptions, flags conflicts, and stores cited reports."
    )
    icon = "telescope"
    selection_hints = [
        "research",
        "summar",
        "analy",
        "compare",
        "investigate",
        "find out",
        "risks",
        "market",
        "competitor",
        "sources",
        "cite",
        "report",
    ]
    capabilities = [
        CapabilitySpec("web_search", "Web search", "Query configured search provider for live external sources."),
        CapabilitySpec("source_comparison", "Multi-source comparison", "Compare multiple sources and surface conflicting claims."),
        CapabilitySpec("fact_separation", "Facts vs. assumptions", "Separate verified facts from working assumptions and unverified items."),
        CapabilitySpec("citation_preservation", "Citation preservation", "Preserve exact source URLs and strip any unverified URLs."),
        CapabilitySpec("structured_reports", "Structured research reports", "Persist structured Markdown & JSON research reports in PostgreSQL."),
    ]
    system_instructions = (
        "You are the Research Agent in the VozPilot autonomous workforce. "
        "Synthesize research strictly from retrieved search snippets, fetched pages, "
        "workspace memory, and user-provided context.\n"
        "- NEVER invent URLs, authors, statistics, or citations.\n"
        "- Cite ONLY URLs that appear verbatim in the retrieved sources block.\n"
        "- Clearly separate `verified_facts` (backed by retrieved sources/context) from "
        "`assumptions` and `unverified_items`.\n"
        "- Explicitly record contradictions across sources in `conflicting_information`.\n"
        "- When no search provider is configured and external facts are requested, state "
        "clearly what could not be verified externally."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned research subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("web.read", "external_read", "Query configured web search provider and public URLs.", default_allowed=True),
        PermissionSpec("research.write", "workspace", "Persist structured research reports to the workspace.", default_allowed=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="web_search",
                name="Web Search",
                description="Search the web via the configured provider (Tavily, Serper, Brave or custom).",
                handler=self._tool_web_search,
                category="external_read",
            ),
            ToolSpec(
                tool_key="fetch_url",
                name="Fetch Public URL",
                description="Retrieve and sanitize text from a public http/https URL (SSRF-protected).",
                handler=self._tool_fetch_url,
                category="external_read",
            ),
            ToolSpec(
                tool_key="search_saved_research",
                name="Search Workspace Research",
                description="Search previously stored research reports and workspace memories.",
                handler=self._tool_search_saved,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="store_research_report",
                name="Store Research Report",
                description="Save a structured research report with citations into PostgreSQL.",
                handler=self._tool_store_report,
                category="workspace_write",
            ),
        ]

    async def _tool_web_search(self, ctx: AgentExecutionContext, query: str, max_results: int = 5) -> dict[str, Any]:
        ctx.check_permission("web.read")
        return await external_providers.web_search(query=query, max_results=max_results)

    async def _tool_fetch_url(self, ctx: AgentExecutionContext, url: str) -> dict[str, Any]:
        ctx.check_permission("web.read")
        return await external_providers.fetch_public_webpage(url)

    async def _tool_search_saved(self, ctx: AgentExecutionContext, query: str) -> list[dict[str, Any]]:
        terms = [w for w in re.split(r"\W+", (query or "").lower()) if len(w) > 3][:6]

        def _read(conn):
            if not terms:
                return db.rows(
                    conn,
                    "SELECT id, title, summary, sources, created_at FROM research_reports ORDER BY created_at DESC LIMIT 4",
                )
            cond = " OR ".join(["title ILIKE %s OR summary ILIKE %s"] * len(terms))
            params: list[Any] = []
            for t in terms:
                params += [f"%{t}%", f"%{t}%"]
            return db.rows(
                conn,
                f"SELECT id, title, summary, sources, created_at FROM research_reports WHERE {cond} ORDER BY created_at DESC LIMIT 5",
                params,
            )

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _read)

    async def _tool_store_report(self, ctx: AgentExecutionContext, report: dict[str, Any]) -> str:
        ctx.check_permission("research.write")
        exec_uuid = ctx._valid_exec_uuid()

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO research_reports
                  (user_id, execution_id, agent_task_id, query, title, summary,
                   key_findings, facts, assumptions, sources, conflicts,
                   unverified_items, report_markdown)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    ctx.user_id,
                    exec_uuid,
                    ctx.agent_task_uuid,
                    (report.get("query") or "")[:500],
                    (report.get("title") or "Research Brief")[:240],
                    (report.get("summary") or "")[:4000],
                    JSON(report.get("key_findings") or []),
                    JSON(report.get("facts") or []),
                    JSON(report.get("assumptions") or []),
                    JSON(report.get("sources") or []),
                    JSON(report.get("conflicts") or []),
                    JSON(report.get("unverified_items") or []),
                    (report.get("report_markdown") or "")[:40000],
                ),
            )
            return str(row["id"])  # type: ignore[index]

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        query = str(ctx.input.parameters.get("query") or f"{ctx.input.title} {ctx.input.description}").strip()[:300]
        allowed_urls: set[str] = set()

        # Collect any explicit URLs supplied by the user/task
        explicit_urls = URL_RE.findall(f"{ctx.input.description}\n{ctx.input.context_summary}")
        for u in explicit_urls[:3]:
            allowed_urls.add(u.rstrip(".,;)"))

        # 1. Search saved internal research first
        prior_reports = await ctx.invoke_tool("search_saved_research", query=query)
        for rep in prior_reports:
            for src in rep.get("sources") or []:
                if isinstance(src, dict) and src.get("url"):
                    allowed_urls.add(src["url"])

        # 2. Live web search (if permitted & enabled)
        search_data: dict[str, Any] = {"configured": False, "results": []}
        if ctx.tool_states.get("web_search", {}).get("enabled", True):
            try:
                search_data = await ctx.invoke_tool("web_search", query=query, max_results=6)
            except Exception as exc:
                search_data = {"configured": False, "results": [], "error": str(exc)}

        for item in search_data.get("results") or []:
            if item.get("url"):
                allowed_urls.add(item["url"])
                ctx.add_source(
                    title=item.get("title") or item["url"],
                    url=item["url"],
                    source_type="web_search",
                    verified=True,
                    snippet=item.get("snippet") or "",
                )

        # 3. Optionally fetch up to 2 explicit public URLs
        fetched_blocks: list[str] = []
        if explicit_urls and ctx.tool_states.get("fetch_url", {}).get("enabled", True):
            for u in explicit_urls[:2]:
                clean_u = u.rstrip(".,;)")
                try:
                    page = await ctx.invoke_tool("fetch_url", url=clean_u)
                    if page.get("ok") and page.get("fencedContent"):
                        fetched_blocks.append(page["fencedContent"])
                        ctx.add_source(title=page.get("title") or clean_u, url=clean_u, source_type="web_page", verified=True)
                except Exception:
                    pass

        # Assemble evidence prompt
        evidence_lines: list[str] = []
        if search_data.get("results"):
            evidence_lines.append(f"LIVE WEB SEARCH RESULTS (provider={search_data.get('provider')}):")
            for idx, r in enumerate(search_data["results"], start=1):
                evidence_lines.append(f"[{idx}] {r['title']} — URL: {r['url']}\n{r['fencedSnippet']}")
        else:
            note = search_data.get("error") or search_data.get("message") or "No live web search results available."
            evidence_lines.append(f"WEB SEARCH STATUS: {note}")

        if fetched_blocks:
            evidence_lines.append("\nFETCHED PUBLIC PAGES:\n" + "\n\n".join(fetched_blocks))

        if prior_reports:
            evidence_lines.append(
                "\nPRIOR WORKSPACE RESEARCH REPORTS:\n"
                + "\n".join(f"- {r['title']}: {(r.get('summary') or '')[:300]}" for r in prior_reports[:3])
            )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + "\n".join(evidence_lines)
            + "\n\nProduce the structured research report. Cite ONLY URLs from the retrieved evidence."
        )

        parsed: ResearchLLMOutput = await ctx.call_llm_structured(schema=ResearchLLMOutput, prompt=prompt)

        # Enforce zero-invented-sources invariant
        verified_citations: list[dict[str, Any]] = []
        unverified = list(parsed.unverified_items)
        for cit in parsed.cited_sources:
            url = (cit.url or "").strip()
            if url and url in allowed_urls:
                verified_citations.append(cit.model_dump())
                ctx.add_source(title=cit.title or url, url=url, source_type="citation", verified=True, snippet=cit.key_point)
            elif url:
                unverified.append(f"Unverified source URL dropped (not in retrieved evidence): {url}")

        if not search_data.get("configured") and not search_data.get("results") and not unverified:
            if not ctx.input.context_summary and not prior_reports:
                unverified.append("External web verification unavailable (no search provider configured on server).")

        # Format structured Markdown report if detailed_output doesn't already include sections
        md_sections = [f"# {parsed.report_title or ctx.input.title}", "", parsed.detailed_output.strip()]
        if parsed.key_findings:
            md_sections += ["", "## Key Findings"] + [f"- {f}" for f in parsed.key_findings]
        if parsed.verified_facts:
            md_sections += ["", "## Verified Facts"] + [f"- {f}" for f in parsed.verified_facts]
        if parsed.assumptions:
            md_sections += ["", "## Assumptions"] + [f"- {a}" for a in parsed.assumptions]
        if parsed.conflicting_information:
            md_sections += ["", "## Conflicting Information Across Sources"] + [f"- {c}" for c in parsed.conflicting_information]
        if unverified:
            md_sections += ["", "## Unverified Items"] + [f"- {u}" for u in unverified]
        if verified_citations:
            md_sections += ["", "## Verified Sources & Citations"] + [
                f"- [{c['title'] or c['url']}]({c['url']})" + (f" — {c['key_point']}" if c.get("key_point") else "")
                for c in verified_citations
            ]
        full_markdown = "\n".join(s for s in md_sections if s is not None).strip()

        report_id: str | None = None
        if parsed.completed and ctx.tool_states.get("store_research_report", {}).get("enabled", True):
            report_id = await ctx.invoke_tool(
                "store_research_report",
                report={
                    "query": query,
                    "title": parsed.report_title or ctx.input.title,
                    "summary": parsed.result_summary,
                    "key_findings": parsed.key_findings,
                    "facts": parsed.verified_facts,
                    "assumptions": parsed.assumptions,
                    "sources": verified_citations or ctx.source_references,
                    "conflicts": parsed.conflicting_information,
                    "unverified_items": unverified,
                    "report_markdown": full_markdown,
                },
            )
            ctx.add_artifact(
                "research_report",
                parsed.report_title or ctx.input.title,
                {
                    "reportId": report_id,
                    "keyFindings": parsed.key_findings,
                    "facts": parsed.verified_facts,
                    "assumptions": parsed.assumptions,
                    "conflicts": parsed.conflicting_information,
                    "unverifiedItems": unverified,
                    "sourcesCount": len(verified_citations or ctx.source_references),
                },
                record_id=report_id,
            )

        return {
            "status": "completed" if parsed.completed else "failed",
            "summary": parsed.result_summary,
            "detailed_output": full_markdown or parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
