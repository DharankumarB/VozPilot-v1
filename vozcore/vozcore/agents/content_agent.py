"""Agent 4 — Content Agent (brand-aware content studio + editable drafts).

Capabilities:
- Social media content, captions, marketing strategies, content calendars,
  blogs/articles, product descriptions, advertising copy, design briefs.
- Supports distinct brand identities, with first-class VozLook Studios guidelines.
- Stores generated content in `content_drafts` (`status='draft'`) for editing
  before publication.
- Never publishes externally without explicit human approval.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from pydantic import BaseModel, Field

from .. import db
from ..db import Utf8Json as JSON
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)

BRAND_PROFILES: dict[str, dict[str, Any]] = {
    "vozlook studios": {
        "name": "VozLook Studios",
        "voice": "Authoritative, craft-obsessed, clear, modern creative-technology studio.",
        "pillars": [
            "Precision over hype — concrete outcomes, zero buzzword filler",
            "Human-directed creative intelligence",
            "High-contrast visual clarity and editorial polish",
        ],
        "avoid": ["exaggerated AI claims", "generic clichés", "unverified metrics"],
    }
}

VALID_CONTENT_TYPES = {
    "social_post",
    "caption",
    "marketing_strategy",
    "content_calendar",
    "blog_article",
    "product_description",
    "ad_copy",
    "design_brief",
    "general",
}


class ContentCalendarEntry(BaseModel):
    day_or_date: str
    channel: str
    format: str
    topic: str
    hook: str = ""


class ContentPiece(BaseModel):
    content_type: str = "blog_article"
    title: str = "Draft"
    channel: str = "general"
    body: str = ""
    call_to_action: str = ""


class ContentLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    brand_identity: str = "VozLook Studios"
    pieces: list[ContentPiece] = Field(default_factory=list)
    calendar_entries: list[ContentCalendarEntry] = Field(default_factory=list)
    request_external_publish: bool = False
    missing_information: list[str] = Field(default_factory=list)


class ContentAgent(BaseAgent):
    agent_id = "content"
    name = "Content Agent"
    description = (
        "Creates brand-aligned social posts, captions, marketing strategies, content "
        "calendars, articles, product copy, ads, and design briefs — saved as editable drafts."
    )
    icon = "pen-tool"
    selection_hints = [
        "content",
        "draft",
        "blog",
        "write",
        "copy",
        "post",
        "caption",
        "article",
        "calendar",
        "marketing",
        "ad ",
        "advertising",
        "design brief",
        "product description",
        "vozlook",
    ]
    capabilities = [
        CapabilitySpec("social_and_captions", "Social media & captions", "Generate channel-tailored social posts and captions."),
        CapabilitySpec("marketing_and_calendars", "Marketing strategies & calendars", "Build campaign strategies and multi-channel content calendars."),
        CapabilitySpec("longform_and_product", "Blogs, articles & product copy", "Write editorial blogs, articles, and product descriptions."),
        CapabilitySpec("ads_and_design_briefs", "Ad copy & design briefs", "Produce conversion-focused ad copy and structured design briefs."),
        CapabilitySpec("brand_voice_and_drafts", "Brand voice & editable drafts", "Apply VozLook Studios or custom brand identities and store editable drafts."),
    ]
    system_instructions = (
        "You are the Content Agent in the VozPilot autonomous workforce, built by VozLook Studios. "
        "Craft publication-grade content across social media, captions, marketing strategies, "
        "content calendars, blogs/articles, product descriptions, ad copy, and design briefs.\n"
        "- Apply the active brand identity guidelines strictly (defaulting to VozLook Studios "
        "when no other brand is specified).\n"
        "- Populate `pieces` with every deliverable created so each piece is saved as an editable draft.\n"
        "- Never claim content has been published externally; external publishing always requires human approval."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned content creation subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("content.write", "workspace", "Save editable content drafts in the workspace.", default_allowed=True),
        PermissionSpec("content.publish", "external_write", "Publish content externally (always requires human approval).", default_allowed=True, requires_approval=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="load_brand_identity",
                name="Load Brand Identity",
                description="Load VozLook Studios or custom brand voice guidelines from workspace memory.",
                handler=self._tool_load_brand,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="save_content_draft",
                name="Save Editable Content Draft",
                description="Persist generated content in `content_drafts` for editing prior to publication.",
                handler=self._tool_save_draft,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="request_external_publication",
                name="Publish Externally (Approval Gate)",
                description="Request human approval to publish a content draft externally.",
                handler=self._tool_publish,
                category="external_write",
                requires_approval=True,
            ),
        ]

    async def _tool_load_brand(self, ctx: AgentExecutionContext, brand_name: str = "VozLook Studios") -> dict[str, Any]:
        norm = (brand_name or "VozLook Studios").strip().lower()
        base = BRAND_PROFILES.get(norm)

        def _from_memory(conn):
            return db.rows(
                conn,
                """
                SELECT title, content FROM memories
                 WHERE (category = 'brand' OR title ILIKE %s)
                 ORDER BY updated_at DESC LIMIT 3
                """,
                (f"%{brand_name[:60]}%",),
            )

        custom_notes = await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _from_memory)
        if base:
            return {**base, "workspaceNotes": [n["content"][:400] for n in custom_notes]}
        return {
            "name": brand_name.strip() or "VozLook Studios",
            "voice": "Clear, credible, audience-matched brand voice.",
            "pillars": ["Clarity", "Authenticity", "Actionable value"],
            "workspaceNotes": [n["content"][:400] for n in custom_notes],
        }

    async def _tool_save_draft(self, ctx: AgentExecutionContext, draft: dict[str, Any]) -> dict[str, Any]:
        ctx.check_permission("content.write")
        ctype = (draft.get("content_type") or "general").strip().lower()
        if ctype not in VALID_CONTENT_TYPES:
            ctype = "general"
        exec_uuid = ctx._valid_exec_uuid()

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO content_drafts
                  (user_id, execution_id, agent_task_id, content_type, brand_identity,
                   channel, title, body, metadata, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft')
                RETURNING id, content_type, brand_identity, channel, title, status, created_at
                """,
                (
                    ctx.user_id,
                    exec_uuid,
                    ctx.agent_task_uuid,
                    ctype,
                    (draft.get("brand_identity") or "VozLook Studios")[:120],
                    (draft.get("channel") or "general")[:80],
                    (draft.get("title") or "Untitled Draft")[:240],
                    (draft.get("body") or "")[:40000],
                    JSON(draft.get("metadata") or {}),
                ),
            )
            return {
                "id": str(row["id"]),  # type: ignore[index]
                "contentType": row["content_type"],  # type: ignore[index]
                "brandIdentity": row["brand_identity"],  # type: ignore[index]
                "channel": row["channel"],  # type: ignore[index]
                "title": row["title"],  # type: ignore[index]
                "status": row["status"],  # type: ignore[index]
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_publish(self, ctx: AgentExecutionContext, draft_id: str, channel: str) -> dict[str, Any]:
        ctx.check_permission("content.publish")
        return {"published": False, "draftId": draft_id, "channel": channel}

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        requested_brand = str(ctx.input.parameters.get("brand") or "VozLook Studios").strip()
        brand = await ctx.invoke_tool("load_brand_identity", brand_name=requested_brand)
        ctx.add_source(title=f"Brand Guidelines: {brand['name']}", source_type="brand_profile", verified=True)

        text_lower = f"{ctx.input.title} {ctx.input.description}".lower()
        wants_publish = bool(
            ctx.input.parameters.get("publish")
            or re.search(r"\bpublish\s+(immediately|externally|now|live|to\s+\w+)\b", text_lower)
        )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + f"ACTIVE BRAND IDENTITY:\n{brand}\n\n"
            "Generate the requested content piece(s) and/or content calendar."
        )

        parsed: ContentLLMOutput = await ctx.call_llm_structured(schema=ContentLLMOutput, prompt=prompt, temperature=0.35)

        saved_drafts: list[dict[str, Any]] = []
        pieces_to_save = list(parsed.pieces)
        if not pieces_to_save and parsed.completed and parsed.detailed_output.strip():
            pieces_to_save = [
                ContentPiece(
                    content_type=str(ctx.input.parameters.get("content_type") or "blog_article"),
                    title=ctx.input.title,
                    channel=str(ctx.input.parameters.get("channel") or "general"),
                    body=parsed.detailed_output,
                )
            ]

        if ctx.tool_states.get("save_content_draft", {}).get("enabled", True):
            for piece in pieces_to_save[:6]:
                saved = await ctx.invoke_tool(
                    "save_content_draft",
                    draft={
                        "content_type": piece.content_type,
                        "brand_identity": parsed.brand_identity or brand["name"],
                        "channel": piece.channel,
                        "title": piece.title or ctx.input.title,
                        "body": piece.body or parsed.detailed_output,
                        "metadata": {
                            "callToAction": piece.call_to_action,
                            "calendarEntries": [c.model_dump() for c in parsed.calendar_entries],
                        },
                    },
                )
                saved_drafts.append(saved)
                ctx.add_artifact("content_draft", f"Draft: {saved['title']}", saved, record_id=saved["id"])

        if parsed.calendar_entries:
            ctx.add_artifact(
                "content_calendar",
                f"Content Calendar ({len(parsed.calendar_entries)} entries)",
                {"entries": [c.model_dump() for c in parsed.calendar_entries]},
            )

        await_approval = False
        if (wants_publish or parsed.request_external_publish) and saved_drafts:
            first = saved_drafts[0]
            gate = await ctx.invoke_tool(
                "request_external_publication",
                draft_id=first["id"],
                channel=first["channel"],
            )
            if isinstance(gate, dict) and gate.get("approvalRequired"):
                await_approval = True

                def _mark_review(conn):
                    db.execute(
                        conn,
                        "UPDATE content_drafts SET status = 'in_review', approval_id = %s WHERE id = %s",
                        (gate.get("approvalId"), first["id"]),
                    )

                await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _mark_review)
                ctx.add_artifact("approval_gate", "External publication held for approval", gate)

        return {
            "status": "completed" if parsed.completed else "failed",
            "await_approval": await_approval,
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
