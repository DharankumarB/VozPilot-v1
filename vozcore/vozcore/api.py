"""VozCore HTTP API — mounted behind the Node proxy at /api/vozcore.

Phase 2 + Phase 3 endpoints:
  GET   /health
  GET   /monitoring
  GET   /agents
  POST  /agents/pause-all
  POST  /agents/resume-all
  GET   /agents/{agent_id}
  PATCH /agents/{agent_id}/runtime
  PATCH /agents/{agent_id}/capabilities/{cap_key}
  PATCH /agents/{agent_id}/tools/{tool_key}
  PATCH /agents/{agent_id}/permissions/{perm_key}
  POST  /agents/{agent_id}/test
  GET   /content-drafts
  PATCH /content-drafts/{draft_id}
  POST  /plan
  POST  /command
  GET   /executions
  GET   /executions/{id}
  POST  /executions/{id}/cancel
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db, service, store
from .agents.registry import ALL_AGENTS
from .agents_registry import (
    AGENTS,
    COORDINATOR_KEY,
    COORDINATOR_NAME,
    INTENT_SYSTEM,
    PLAN_SYSTEM,
    agent_catalogue,
)
from .auth import current_user_id
from .config import settings
from .errors import CommandValidationError, ConfigUnavailableError, NotFoundError, VozCoreError
from .external_providers import clear_test_mocks
from .graph.build import describe_graph
from .llm import llm, set_test_handler
from .planning import VALID_AGENT_STATUSES, validate_and_normalize_plan
from .schemas import ExecutionPlan, IntentAnalysis

logger = logging.getLogger("vozcore.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    recovered = service.recover_interrupted()
    if recovered:
        logger.warning("marked %d interrupted execution(s) as failed on boot", recovered)
    if settings.fake_llm:
        logger.warning(
            "VOZCORE_TEST_FAKE_LLM is active — TEST TRANSPORT ONLY "
            "(refused in production, reported by /health)"
        )
    yield
    set_test_handler(None)
    clear_test_mocks()


app = FastAPI(
    title="VozCore Engine",
    version="3.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


# ---------------------------------------------------------------------------
# Error envelope — identical shape to the Node API
# ---------------------------------------------------------------------------


@app.exception_handler(VozCoreError)
async def vozcore_error_handler(_: Request, exc: VozCoreError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "validation_error",
                "message": "Validation failed for the request payload.",
                "details": exc.errors(),
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled vozcore error")
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "VozCore hit an unexpected error. Check the engine logs.",
                "details": None,
            }
        },
    )


async def require_engine_configured() -> None:
    """Block plan/command/test when no credentials exist — never fake work."""
    if not settings.llm_configured and not settings.fake_llm and not llm.has_test_handler():
        raise ConfigUnavailableError(
            "VozCore needs an OpenAI API key to reason. Set OPENAI_API_KEY in the "
            "server .env (see .env.example) and restart the engine — no simulated "
            "responses are ever returned."
        )


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class CommandRequest(BaseModel):
    command: str = Field(min_length=3, max_length=4000)
    conversationId: str | None = None
    sourceMessageId: str | None = None


class PlanRequest(BaseModel):
    command: str = Field(min_length=3, max_length=4000)


class AgentRuntimeUpdate(BaseModel):
    enabled: bool | None = None
    status: Literal["active", "idle", "paused", "error"] | None = None
    customInstructions: str | None = Field(default=None, max_length=4000)
    timeoutSeconds: int | None = Field(default=None, ge=5, le=600)
    maxRetries: int | None = Field(default=None, ge=0, le=5)


class CapabilityToggle(BaseModel):
    enabled: bool


class ToolUpdate(BaseModel):
    enabled: bool | None = None
    requiresApproval: bool | None = None


class PermissionUpdate(BaseModel):
    allowed: bool | None = None
    requiresApproval: bool | None = None
    rateLimitPerHour: int | None = Field(default=None, ge=1, le=10000)
    maxTasksPerRun: int | None = Field(default=None, ge=1, le=50)


class TestAgentRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=3000)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ContentDraftUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    body: str | None = Field(default=None, max_length=40000)
    channel: str | None = Field(default=None, max_length=80)
    brandIdentity: str | None = Field(default=None, max_length=120)
    brandName: str | None = Field(default=None, max_length=120)


# ---------------------------------------------------------------------------
# GET /health & GET /monitoring
# ---------------------------------------------------------------------------


@app.get("/health")
async def health(user: str = Depends(current_user_id)) -> dict[str, Any]:
    db_ok = False
    paused_all = False
    try:
        def _ping(conn):
            return db.scalar(conn, "SELECT 1") == 1, store.is_workspace_paused(conn, user)

        db_ok, paused_all = await asyncio.to_thread(db.run_in_user_txn, user, _ping)
    except Exception:
        logger.exception("health db check failed")

    return {
        "data": {
            "status": "ok" if db_ok else "degraded",
            "engine": "vozcore",
            "phase": 3,
            "database": "ok" if db_ok else "error",
            "agentsPaused": paused_all,
            "registeredAgents": len(ALL_AGENTS),
            "searchConfigured": settings.search_configured,
            "llm": {
                "configured": settings.llm_configured,
                "mode": settings.llm_mode,
                "model": settings.openai_model if settings.llm_configured else None,
            },
            "graph": describe_graph(),
            "limits": {
                "maxTasks": settings.max_tasks_per_execution,
                "maxAttempts": settings.max_task_attempts,
                "taskTimeoutSeconds": settings.task_timeout_seconds,
                "executionTimeoutSeconds": settings.execution_timeout_seconds,
                "sandboxTimeoutSeconds": settings.sandbox_timeout_seconds,
                "sandboxMemoryMb": settings.sandbox_memory_mb,
            },
            "message": (
                None
                if settings.llm_configured or settings.fake_llm
                else "OpenAI API key not configured — set OPENAI_API_KEY in .env to enable orchestration."
            ),
        },
    }


@app.get("/monitoring")
async def monitoring(user: str = Depends(current_user_id)) -> dict[str, Any]:
    data = await asyncio.to_thread(
        db.run_in_user_txn,
        user,
        lambda conn: store.get_monitoring_summary(
            conn,
            user,
            llm_configured=settings.llm_configured,
            llm_mode=settings.llm_mode,
            llm_model=settings.openai_model if settings.llm_configured else None,
        ),
    )
    return {"data": data}


# ---------------------------------------------------------------------------
# GET /agents + Pause All / Resume All + Agent Detail / Controls / Test
# ---------------------------------------------------------------------------


@app.get("/agents")
async def agents(user: str = Depends(current_user_id)) -> dict[str, Any]:
    def _load(conn):
        rows = store.load_agents(conn)
        paused_all = store.is_workspace_paused(conn, user)
        counts_rows = db.rows(
            conn,
            """
            SELECT agent_key,
                   COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                   COUNT(*) FILTER (WHERE status = 'running')::int AS running
              FROM agent_tasks
             GROUP BY agent_key
            """,
        )
        counts_map = {r["agent_key"]: r for r in counts_rows}
        current_titles = {
            str(r["id"]): r["title"]
            for r in db.rows(
                conn,
                "SELECT id, title FROM agent_tasks WHERE status = 'running'",
            )
        }
        return rows, paused_all, counts_map, current_titles

    rows, paused_all, counts_map, current_titles = await asyncio.to_thread(db.run_in_user_txn, user, _load)
    catalogue = []
    for row in rows:
        if row["key"] == COORDINATOR_KEY:
            continue
        spec = AGENTS.get(row["key"])
        agent_obj = ALL_AGENTS.get(row["key"])
        enabled = bool(row.get("enabled", True))
        selectable = enabled and row["status"] in VALID_AGENT_STATUSES and not paused_all
        stats = counts_map.get(row["key"], {})
        cur_task = current_titles.get(row.get("current_task_id") or "")
        catalogue.append(
            {
                "key": row["key"],
                "agentId": row["id"],
                "name": row["name"],
                "icon": row["icon"],
                "status": row["status"],
                "enabled": enabled,
                "role": spec.role if spec else (row.get("description") or ""),
                "capabilities": spec.capabilities if spec else [],
                "tools": [t.name for t in (agent_obj.available_tools if agent_obj else [])],
                "operational": selectable,
                "executionMode": "llm",
                "currentTask": cur_task,
                "completedTasks": int(stats.get("completed") or 0),
                "failedTasks": int(stats.get("failed") or 0),
                "totalTasks": int(stats.get("total") or 0),
                "lastActiveAt": row["last_active_at"].isoformat() if row.get("last_active_at") else None,
                "notes": (
                    "Workspace pause is active."
                    if paused_all
                    else (
                        "Agent is disabled."
                        if not enabled
                        else (
                            None
                            if row["status"] in VALID_AGENT_STATUSES
                            else f"Agent is {row['status']} — resume it in Agent Hub to receive work."
                        )
                    )
                ),
            }
        )
    coordinator = next((r for r in rows if r["key"] == COORDINATOR_KEY), None)
    return {
        "data": {
            "agentsPaused": paused_all,
            "coordinator": {
                "key": COORDINATOR_KEY,
                "agentId": coordinator["id"] if coordinator else None,
                "name": COORDINATOR_NAME,
                "role": "Central AI manager — plans, delegates, evaluates and consolidates.",
                "status": coordinator["status"] if coordinator else "active",
                "operational": not paused_all,
                "executionMode": "llm",
            },
            "agents": catalogue,
            "llmMode": settings.llm_mode,
        },
    }


@app.post("/agents/pause-all")
async def pause_all_agents(user: str = Depends(current_user_id)) -> dict[str, Any]:
    res = await asyncio.to_thread(db.run_in_user_txn, user, lambda c: store.set_workspace_paused(c, user, True))
    return {"data": res}


@app.post("/agents/resume-all")
async def resume_all_agents(user: str = Depends(current_user_id)) -> dict[str, Any]:
    res = await asyncio.to_thread(db.run_in_user_txn, user, lambda c: store.set_workspace_paused(c, user, False))
    return {"data": res}


@app.get("/agents/{agent_id}")
async def agent_detail(agent_id: str, user: str = Depends(current_user_id)) -> dict[str, Any]:
    detail = await asyncio.to_thread(
        db.run_in_user_txn, user, lambda conn: store.get_agent_detail_payload(conn, user, agent_id)
    )
    if not detail:
        raise NotFoundError("Agent not found.")
    return {"data": detail}


@app.patch("/agents/{agent_id}/runtime")
async def update_agent_runtime(
    agent_id: str,
    payload: AgentRuntimeUpdate,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    def _update(conn):
        detail = store.get_agent_detail_payload(conn, user, agent_id)
        if not detail:
            raise NotFoundError("Agent not found.")
        agent_uuid = detail["agent"]["id"]
        sets, params = [], []
        if payload.enabled is not None:
            sets.append("enabled = %s")
            params.append(bool(payload.enabled))
        if payload.status is not None:
            sets.append("status = %s")
            params.append(payload.status)
        if payload.customInstructions is not None:
            sets.append("system_instructions = %s")
            params.append(payload.customInstructions.strip() or None)
        if payload.timeoutSeconds is not None:
            sets.append("timeout_seconds = %s")
            params.append(int(payload.timeoutSeconds))
        if payload.maxRetries is not None:
            sets.append("max_retries = %s")
            params.append(int(payload.maxRetries))
        if sets:
            params.append(agent_uuid)
            db.execute(conn, f"UPDATE agents SET {', '.join(sets)} WHERE id = %s", params)
            db.execute(
                conn,
                """
                INSERT INTO activity_logs (user_id, agent_id, type, category, title, detail)
                VALUES (%s, %s, 'agent_runtime_updated', 'agent', %s, %s)
                """,
                (user, agent_uuid, f"{detail['agent']['name']} runtime updated", ", ".join(s.split(" =")[0] for s in sets)),
            )
        return store.get_agent_detail_payload(conn, user, agent_uuid)

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _update)}


@app.patch("/agents/{agent_id}/capabilities/{cap_key}")
async def update_agent_capability(
    agent_id: str,
    cap_key: str,
    payload: CapabilityToggle,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    def _update(conn):
        detail = store.get_agent_detail_payload(conn, user, agent_id)
        if not detail:
            raise NotFoundError("Agent not found.")
        agent_uuid = detail["agent"]["id"]
        row = db.row(
            conn,
            """
            UPDATE agent_capabilities SET enabled = %s
             WHERE agent_id = %s AND capability_key = %s
             RETURNING id
            """,
            (bool(payload.enabled), agent_uuid, cap_key),
        )
        if not row:
            raise NotFoundError("Capability not found.")
        return store.get_agent_detail_payload(conn, user, agent_uuid)

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _update)}


@app.patch("/agents/{agent_id}/tools/{tool_key}")
async def update_agent_tool(
    agent_id: str,
    tool_key: str,
    payload: ToolUpdate,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    def _update(conn):
        detail = store.get_agent_detail_payload(conn, user, agent_id)
        if not detail:
            raise NotFoundError("Agent not found.")
        agent_uuid = detail["agent"]["id"]
        sets, params = [], []
        if payload.enabled is not None:
            sets.append("enabled = %s")
            params.append(bool(payload.enabled))
        if payload.requiresApproval is not None:
            sets.append("requires_approval = %s")
            params.append(bool(payload.requiresApproval))
        if sets:
            params += [agent_uuid, tool_key]
            row = db.row(
                conn,
                f"UPDATE agent_tools SET {', '.join(sets)} WHERE agent_id = %s AND tool_key = %s RETURNING id",
                params,
            )
            if not row:
                raise NotFoundError("Tool not found.")
        return store.get_agent_detail_payload(conn, user, agent_uuid)

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _update)}


@app.patch("/agents/{agent_id}/permissions/{perm_key}")
async def update_agent_permission(
    agent_id: str,
    perm_key: str,
    payload: PermissionUpdate,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    def _update(conn):
        detail = store.get_agent_detail_payload(conn, user, agent_id)
        if not detail:
            raise NotFoundError("Agent not found.")
        agent_uuid = detail["agent"]["id"]
        sets, params = [], []
        if payload.allowed is not None:
            sets.append("allowed = %s")
            params.append(bool(payload.allowed))
        if payload.requiresApproval is not None:
            sets.append("requires_approval = %s")
            params.append(bool(payload.requiresApproval))
        if payload.rateLimitPerHour is not None:
            sets.append("rate_limit_per_hour = %s")
            params.append(int(payload.rateLimitPerHour))
        if payload.maxTasksPerRun is not None:
            sets.append("max_tasks_per_run = %s")
            params.append(int(payload.maxTasksPerRun))
        if sets:
            params += [agent_uuid, perm_key]
            row = db.row(
                conn,
                f"UPDATE agent_permissions SET {', '.join(sets)} WHERE agent_id = %s AND permission_key = %s RETURNING id",
                params,
            )
            if not row:
                raise NotFoundError("Permission not found.")
        return store.get_agent_detail_payload(conn, user, agent_uuid)

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _update)}


async def _assert_not_paused(user: str) -> None:
    paused = await asyncio.to_thread(
        db.run_in_user_txn, user, lambda conn: store.is_workspace_paused(conn, user)
    )
    if paused:
        from .errors import ConflictError

        raise ConflictError(
            "All agents are currently paused by workspace control. Resume agents in Agent Hub to continue."
        )


@app.post("/agents/{agent_id}/test")
async def test_agent_endpoint(
    agent_id: str,
    request: TestAgentRequest,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    await _assert_not_paused(user)
    await require_engine_configured()
    data = await service.run_agent_direct_test(
        user,
        agent_id,
        request.prompt,
        parameters=request.parameters,
    )
    return {"data": data}


# ---------------------------------------------------------------------------
# Content Drafts (editable before publication)
# ---------------------------------------------------------------------------


@app.get("/content-drafts")
async def list_content_drafts(user: str = Depends(current_user_id)) -> dict[str, Any]:
    def _list(conn):
        rows = db.rows(
            conn,
            """
            SELECT id, execution_id, content_type, brand_identity, channel,
                   title, body, status, approval_id, created_at, updated_at
              FROM content_drafts ORDER BY updated_at DESC LIMIT 50
            """,
        )
        return [
            {
                "id": str(r["id"]),
                "executionId": str(r["execution_id"]) if r.get("execution_id") else None,
                "contentType": r["content_type"],
                "brandIdentity": r["brand_identity"],
                "brandName": r["brand_identity"],
                "channel": r["channel"],
                "title": r["title"],
                "body": r["body"],
                "metadata": {},
                "status": r["status"],
                "approvalId": str(r["approval_id"]) if r.get("approval_id") else None,
                "createdAt": r["created_at"].isoformat(),
                "updatedAt": r["updated_at"].isoformat(),
            }
            for r in rows
        ]

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _list)}


@app.patch("/content-drafts/{draft_id}")
async def edit_content_draft(
    draft_id: str,
    payload: ContentDraftUpdate,
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    store.validate_uuid(draft_id, "draft")

    def _edit(conn):
        existing = db.row(conn, "SELECT id, status FROM content_drafts WHERE id = %s", (draft_id,))
        if not existing:
            raise NotFoundError("Content draft not found.")
        sets, params = [], []
        if payload.title is not None:
            sets.append("title = %s")
            params.append(payload.title.strip())
        if payload.body is not None:
            sets.append("body = %s")
            params.append(payload.body)
        if payload.channel is not None:
            sets.append("channel = %s")
            params.append(payload.channel.strip())
        brand = payload.brandIdentity if payload.brandIdentity is not None else payload.brandName
        if brand is not None:
            sets.append("brand_identity = %s")
            params.append(brand.strip())
        if sets:
            params.append(draft_id)
            db.execute(conn, f"UPDATE content_drafts SET {', '.join(sets)} WHERE id = %s", params)
        r = db.row(
            conn,
            """
            SELECT id, content_type, brand_identity, channel, title, body, status, approval_id, created_at, updated_at
              FROM content_drafts WHERE id = %s
            """,
            (draft_id,),
        )
        return {
            "id": str(r["id"]),  # type: ignore[index]
            "contentType": r["content_type"],  # type: ignore[index]
            "brandIdentity": r["brand_identity"],  # type: ignore[index]
            "brandName": r["brand_identity"],  # type: ignore[index]
            "channel": r["channel"],  # type: ignore[index]
            "title": r["title"],  # type: ignore[index]
            "body": r["body"],  # type: ignore[index]
            "metadata": {},
            "status": r["status"],  # type: ignore[index]
            "approvalId": str(r["approval_id"]) if r.get("approval_id") else None,  # type: ignore[index]
            "createdAt": r["created_at"].isoformat(),  # type: ignore[index]
            "updatedAt": r["updated_at"].isoformat(),  # type: ignore[index]
        }

    return {"data": await asyncio.to_thread(db.run_in_user_txn, user, _edit)}


# ---------------------------------------------------------------------------
# POST /plan — plan preview without dispatching
# ---------------------------------------------------------------------------


@app.post("/plan")
async def preview_plan(request: PlanRequest, user: str = Depends(current_user_id)) -> dict[str, Any]:
    await require_engine_configured()
    command = request.command.strip()

    def _load(conn):
        return store.load_agents(conn)

    rows = await asyncio.to_thread(db.run_in_user_txn, user, _load)
    selectable = [
        a
        for a in rows
        if a["key"] != COORDINATOR_KEY and bool(a.get("enabled", True)) and a["status"] in VALID_AGENT_STATUSES
    ]
    if not selectable:
        raise CommandValidationError("No specialist agents are available (all disabled, paused, or in error).")

    intent: IntentAnalysis = await llm.structured(
        purpose="intent",
        system=INTENT_SYSTEM,
        prompt=(
            f"CATALOGUE OF AVAILABLE AGENTS:\n{agent_catalogue(selectable)}\n\n"
            f"USER COMMAND:\n{command}\n\nAnalyse the command."
        ),
        schema=IntentAnalysis,
        user_id=user,
    )
    if intent.needs_clarification:
        return {
            "data": {
                "intent": intent.model_dump(),
                "plan": None,
                "selectedAgents": [],
                "clarification": intent.clarification_question,
            }
        }

    plan_model = await llm.structured(
        purpose="plan",
        system=PLAN_SYSTEM.format(max_tasks=settings.max_tasks_per_execution),
        prompt=(
            f"COMMAND:\n{command}\n\n"
            f"OBJECTIVE: {intent.objective}\nOUTCOME: {intent.outcome}\n"
            f"CONSTRAINTS: {', '.join(intent.constraints) or 'none'}\n"
            f"DEADLINES: {', '.join(intent.deadlines) or 'none'}\n\n"
            f"AGENT CATALOGUE:\n{agent_catalogue(selectable)}\n\n"
            f"Create the plan (max {settings.max_tasks_per_execution} tasks)."
        ),
        schema=ExecutionPlan,
        user_id=user,
    )

    available = [a["key"] for a in selectable]
    fallback = "research" if "research" in available else available[0]
    try:
        plan, warnings = validate_and_normalize_plan(plan_model.model_dump(), available, fallback)
    except ValueError as exc:
        raise CommandValidationError(f"Planner produced an unusable plan: {exc}")

    selected_keys = sorted({t["agent_key"] for t in plan["tasks"]})
    return {
        "data": {
            "intent": intent.model_dump(),
            "plan": plan,
            "warnings": warnings,
            "selectedAgents": [
                {
                    "key": key,
                    "name": next((a["name"] for a in selectable if a["key"] == key), key),
                    "operational": True,
                }
                for key in selected_keys
            ],
            "clarification": None,
        }
    }


# ---------------------------------------------------------------------------
# POST /command & Executions
# ---------------------------------------------------------------------------


@app.post("/command")
async def run_command(request: CommandRequest, user: str = Depends(current_user_id)) -> dict[str, Any]:
    await _assert_not_paused(user)
    await require_engine_configured()
    execution = await service.start_execution(
        user,
        request.command,
        conversation_id=request.conversationId,
        source_message_id=request.sourceMessageId,
    )
    return {"data": {"execution": execution}}


@app.get("/executions")
async def executions(
    conversationId: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    items = await service.list_executions(user, conversationId, limit)
    return {"data": items}


@app.get("/executions/{execution_id}")
async def execution_detail(
    execution_id: str,
    sinceEventId: int = Query(default=0, ge=0),
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    return {"data": await service.get_execution_detail(user, execution_id, sinceEventId)}


@app.post("/executions/{execution_id}/cancel")
async def cancel(execution_id: str, user: str = Depends(current_user_id)) -> dict[str, Any]:
    execution = await service.cancel_execution(user, execution_id)
    return {"data": {"execution": execution}}
