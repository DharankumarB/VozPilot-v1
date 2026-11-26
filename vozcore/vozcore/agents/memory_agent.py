"""Agent 8 — Memory Agent (shared workspace knowledge, semantic retrieval & dedup).

Capabilities:
- Store useful approved knowledge (`store_memory` — skips sensitive secrets).
- Retrieve relevant project & workspace context (`retrieve_memories` — hybrid
  PostgreSQL keyword + vector cosine similarity, user-isolated via RLS).
- Search previous execution results (`search_execution_history`).
- Categorize knowledge (`project`, `research`, `brand`, `finance`, `engineering`, `workflow`, `general`).
- Detect & merge duplicate information (`detect_duplicates`).
- Share authorized context packets with downstream agents via VozCore (`share_memories`).
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import re
from typing import Any

from pydantic import BaseModel, Field

from .. import communication, db
from ..db import Utf8Json as JSON
from ..security import contains_sensitive_data
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)

EMBED_DIM = 128
VALID_CATEGORIES = {"project", "research", "brand", "finance", "engineering", "workflow", "general"}


def compute_text_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    """Deterministic L2-normalized feature-hashed word + 3-gram vector for cosine retrieval."""
    vec = [0.0] * dim
    tokens = re.findall(r"[a-z0-9]{2,}", (text or "").lower())
    if not tokens:
        return vec
    features = list(tokens)
    joined = " ".join(tokens[:200])
    for i in range(max(0, len(joined) - 2)):
        features.append(joined[i : i + 3])
    for feat in features:
        digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=4).digest()
        h = int.from_bytes(digest, "little")
        idx = h % dim
        sign = 1.0 if ((h >> 8) & 1) == 0 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [round(v / norm, 5) for v in vec]
    return vec


def cosine_similarity(a: list[float] | None, b: list[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class ProposedMemoryEntry(BaseModel):
    title: str
    content: str
    category: str = "project"
    project_name: str | None = None
    tags: list[str] = Field(default_factory=list)


class MemoryLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    entries_to_store: list[ProposedMemoryEntry] = Field(default_factory=list)
    share_with_agents: list[str] = Field(default_factory=list)
    shared_context_summary: str = ""
    missing_information: list[str] = Field(default_factory=list)


class MemoryAgent(BaseAgent):
    agent_id = "memory"
    name = "Memory Agent"
    description = (
        "Stores approved workspace knowledge, retrieves project context with semantic "
        "similarity, searches past execution results, deduplicates entries, and shares "
        "authorized context packets via VozCore."
    )
    icon = "brain"
    selection_hints = [
        "remember",
        "memory",
        "memories",
        "knowledge",
        "recall",
        "context",
        "previous execution",
        "past results",
        "deduplicate",
        "categorize",
    ]
    capabilities = [
        CapabilitySpec("knowledge_storage", "Store approved memories", "Categorize and store durable knowledge while rejecting sensitive secrets."),
        CapabilitySpec("semantic_retrieval", "Semantic & project retrieval", "Retrieve relevant memories by vector cosine + keyword match and project scope."),
        CapabilitySpec("execution_history_search", "Execution history search", "Search prior VozCore executions and agent outputs for reusable findings."),
        CapabilitySpec("duplicate_detection", "Duplicate detection & merge", "Detect overlapping memories via similarity scoring before inserting."),
        CapabilitySpec("authorized_context_sharing", "Authorized agent sharing", "Publish scoped memory packets to authorized agents through VozCore."),
    ]
    system_instructions = (
        "You are the Memory Agent in the VozPilot autonomous workforce. "
        "Curate high-signal, categorized knowledge for the workspace.\n"
        "- Never store passwords, API keys, OAuth tokens, secrets, or sensitive personal credentials.\n"
        "- Populate `entries_to_store` ONLY when durable, reusable information should be saved.\n"
        "- Categorize entries accurately (`project`, `research`, `brand`, `finance`, `engineering`, `workflow`, `general`).\n"
        "- Ground retrieved summaries strictly in `RETRIEVED WORKSPACE MEMORIES` and `PAST EXECUTION RESULTS`."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned memory management subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("memory.read", "workspace", "Search user-isolated memories and execution history.", default_allowed=True),
        PermissionSpec("memory.write", "workspace", "Create and deduplicate non-sensitive workspace memories.", default_allowed=True),
        PermissionSpec("memory.share", "workspace", "Share authorized memory context packets via VozCore.", default_allowed=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="retrieve_memories",
                name="Retrieve Relevant Memories",
                description="Hybrid semantic + keyword retrieval across user-isolated `memories`.",
                handler=self._tool_retrieve,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="search_execution_history",
                name="Search Execution Results",
                description="Search previous VozCore executions and specialist agent outputs.",
                handler=self._tool_search_executions,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="detect_duplicates",
                name="Detect Duplicate Memories",
                description="Check whether a proposed memory overlaps an existing entry (`similarity >= 0.80`).",
                handler=self._tool_detect_duplicates,
                category="domain",
            ),
            ToolSpec(
                tool_key="store_memory",
                name="Store Categorized Memory",
                description="Save or merge a non-sensitive categorized memory with vector embedding.",
                handler=self._tool_store_memory,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="share_memories",
                name="Share Context With Authorized Agents",
                description="Dispatch an authorized context packet via `agent_messages`.",
                handler=self._tool_share_memories,
                category="communication",
            ),
        ]

    async def _tool_retrieve(
        self,
        ctx: AgentExecutionContext,
        query: str,
        project_name: str | None = None,
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        ctx.check_permission("memory.read")
        q_vec = compute_text_embedding(query)
        terms = [t for t in re.findall(r"[a-z0-9]{3,}", (query or "").lower())][:6]

        def _fetch(conn):
            if project_name:
                rows = db.rows(
                    conn,
                    "SELECT id, category, project_name, title, content, tags, embedding_json, updated_at FROM memories WHERE project_name ILIKE %s ORDER BY updated_at DESC LIMIT 60",
                    (f"%{project_name}%",),
                )
            else:
                rows = db.rows(
                    conn,
                    "SELECT id, category, project_name, title, content, tags, embedding_json, updated_at FROM memories ORDER BY updated_at DESC LIMIT 80",
                )
            scored = []
            for r in rows:
                emb = r.get("embedding_json")
                if not isinstance(emb, list) or len(emb) != EMBED_DIM:
                    emb = compute_text_embedding(f"{r['title']} {r.get('content') or ''}")
                sim = cosine_similarity(q_vec, emb)
                hay = f"{r['title']} {r.get('content') or ''}".lower()
                kw_bonus = sum(0.12 for t in terms if t in hay)
                score = round(min(1.0, max(0.0, sim) + kw_bonus), 4)
                scored.append(
                    {
                        "id": str(r["id"]),
                        "title": r["title"],
                        "category": r["category"],
                        "projectName": r.get("project_name"),
                        "content": (r.get("content") or "")[:600],
                        "tags": r.get("tags") or [],
                        "score": score,
                    }
                )
            scored.sort(key=lambda item: item["score"], reverse=True)
            return scored[:limit]

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _fetch)

    async def _tool_search_executions(self, ctx: AgentExecutionContext, query: str, limit: int = 5) -> list[dict[str, Any]]:
        ctx.check_permission("memory.read")
        terms = [t for t in re.findall(r"[a-z0-9]{3,}", (query or "").lower())][:5]

        def _query(conn):
            if not terms:
                rows = db.rows(
                    conn,
                    """
                    SELECT id, command, status, final_response, created_at
                      FROM executions WHERE status = 'completed'
                     ORDER BY created_at DESC LIMIT %s
                    """,
                    (limit,),
                )
            else:
                cond = " OR ".join(["command ILIKE %s OR COALESCE(final_response, '') ILIKE %s"] * len(terms))
                params: list[Any] = []
                for t in terms:
                    params += [f"%{t}%", f"%{t}%"]
                params.append(limit)
                rows = db.rows(
                    conn,
                    f"""
                    SELECT id, command, status, final_response, created_at
                      FROM executions
                     WHERE status = 'completed' AND ({cond})
                     ORDER BY created_at DESC LIMIT %s
                    """,
                    params,
                )
            return [
                {
                    "executionId": str(r["id"]),
                    "command": r["command"][:200],
                    "excerpt": (r.get("final_response") or "")[:400],
                }
                for r in rows
            ]

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _query)

    async def _tool_detect_duplicates(self, ctx: AgentExecutionContext, title: str, content: str) -> dict[str, Any]:
        ctx.check_permission("memory.read")
        cand_vec = compute_text_embedding(f"{title} {content}")

        def _check(conn):
            rows = db.rows(
                conn,
                "SELECT id, title, content, embedding_json FROM memories ORDER BY updated_at DESC LIMIT 100",
            )
            best_match = None
            best_sim = 0.0
            for r in rows:
                if r["title"].strip().lower() == title.strip().lower():
                    return {"isDuplicate": True, "duplicateId": str(r["id"]), "similarity": 1.0, "matchedTitle": r["title"]}
                emb = r.get("embedding_json")
                if not isinstance(emb, list) or len(emb) != EMBED_DIM:
                    emb = compute_text_embedding(f"{r['title']} {r.get('content') or ''}")
                sim = cosine_similarity(cand_vec, emb)
                if sim > best_sim:
                    best_sim = sim
                    best_match = r
            if best_match and best_sim >= 0.82:
                return {
                    "isDuplicate": True,
                    "duplicateId": str(best_match["id"]),
                    "similarity": round(best_sim, 3),
                    "matchedTitle": best_match["title"],
                }
            return {"isDuplicate": False, "similarity": round(best_sim, 3)}

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _check)

    async def _tool_store_memory(self, ctx: AgentExecutionContext, entry: dict[str, Any]) -> dict[str, Any]:
        ctx.check_permission("memory.write")
        title = (entry.get("title") or "").strip()[:160]
        content = (entry.get("content") or "").strip()[:4000]
        if not title or not content:
            return {"stored": False, "reason": "empty_entry"}
        if contains_sensitive_data(title) or contains_sensitive_data(content):
            return {"stored": False, "skippedSensitive": True, "reason": "sensitive_content_rejected"}

        cat = (entry.get("category") or "project").strip().lower()
        if cat not in VALID_CATEGORIES:
            cat = "general"
        tags = [str(t)[:40] for t in (entry.get("tags") or [])][:10]
        project_name = (entry.get("project_name") or "").strip()[:120] or None
        emb = compute_text_embedding(f"{title} {content}")
        dup = await self._tool_detect_duplicates(ctx, title=title, content=content)
        exec_uuid = ctx._valid_exec_uuid()

        def _upsert(conn):
            if dup.get("isDuplicate") and dup.get("duplicateId"):
                db.execute(
                    conn,
                    """
                    UPDATE memories
                       SET content = %s, category = %s, tags = %s,
                           project_name = COALESCE(%s, project_name),
                           embedding_json = %s
                     WHERE id = %s
                    """,
                    (content, cat, JSON(tags), project_name, JSON(emb), dup["duplicateId"]),
                )
                return {
                    "stored": True,
                    "deduplicated": True,
                    "id": dup["duplicateId"],
                    "title": title,
                    "category": cat,
                }
            row = db.row(
                conn,
                """
                INSERT INTO memories
                  (user_id, category, project_name, source_execution_id, title, content, tags, embedding_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (ctx.user_id, cat, project_name, exec_uuid, title, content, JSON(tags), JSON(emb)),
            )
            return {
                "stored": True,
                "deduplicated": False,
                "id": str(row["id"]),  # type: ignore[index]
                "title": title,
                "category": cat,
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _upsert)

    async def _tool_share_memories(
        self,
        ctx: AgentExecutionContext,
        recipient_keys: list[str],
        context_packet: str,
    ) -> list[str]:
        ctx.check_permission("memory.share")
        exec_uuid = ctx._valid_exec_uuid()
        if not exec_uuid:
            return []
        valid_targets = [
            k for k in recipient_keys
            if k in {"research", "inbox", "project", "content", "finance", "schedule", "developer", "vozcore"}
        ]

        def _send(conn):
            msg_ids = []
            for target in valid_targets[:8]:
                mid = communication.record_agent_message(
                    conn,
                    user_id=ctx.user_id,
                    execution_id=exec_uuid,
                    task_id=ctx.agent_task_uuid,
                    sender_key="memory",
                    recipient_key=target,
                    message_type="context_share",
                    payload={"sharedBy": "memory", "context": context_packet[:2000]},
                    authorized=True,
                )
                msg_ids.append(mid)
            return msg_ids

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _send)

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        query = str(ctx.input.parameters.get("query") or f"{ctx.input.title} {ctx.input.description}").strip()
        project_filter = ctx.input.parameters.get("project_name")

        retrieved = await ctx.invoke_tool("retrieve_memories", query=query, project_name=project_filter, limit=8)
        past_execs = await ctx.invoke_tool("search_execution_history", query=query, limit=5)

        if retrieved:
            ctx.add_source(
                title="Workspace Memory Center",
                source_type="memory_store",
                verified=True,
                snippet=f"{len(retrieved)} matching memory entries retrieved",
            )
        if past_execs:
            ctx.add_source(
                title="Past VozCore Execution History",
                source_type="execution_history",
                verified=True,
                snippet=f"{len(past_execs)} completed execution(s) matched",
            )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + f"RETRIEVED WORKSPACE MEMORIES:\n{retrieved}\n\n"
            + f"PAST EXECUTION RESULTS:\n{past_execs}\n\n"
            "Synthesize, categorize, deduplicate, and optionally store/share non-sensitive knowledge."
        )

        parsed: MemoryLLMOutput = await ctx.call_llm_structured(schema=MemoryLLMOutput, prompt=prompt)

        stored_outcomes = []
        combined_input = f"{ctx.input.title} {ctx.input.description}"
        if parsed.entries_to_store and not contains_sensitive_data(combined_input):
            if ctx.tool_states.get("store_memory", {}).get("enabled", True):
                for item in parsed.entries_to_store[:5]:
                    res = await ctx.invoke_tool("store_memory", entry=item.model_dump())
                    stored_outcomes.append(res)

        shared_ids = []
        if parsed.share_with_agents and parsed.shared_context_summary.strip():
            shared_ids = await ctx.invoke_tool(
                "share_memories",
                recipient_keys=parsed.share_with_agents,
                context_packet=parsed.shared_context_summary,
            )

        ctx.add_artifact(
            "memory_operation",
            "Memory Retrieval, Deduplication & Storage Summary",
            {
                "retrievedCount": len(retrieved),
                "pastExecutionsMatched": len(past_execs),
                "storedEntries": stored_outcomes,
                "sharedMessageIds": shared_ids,
            },
        )

        return {
            "status": "completed" if parsed.completed else "failed",
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
