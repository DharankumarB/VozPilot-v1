"""VozCore HTTP API — mounted behind the Node proxy at /api/vozcore.

Endpoints:
  GET  /health
  GET  /agents
  POST /plan
  POST /command
  GET  /executions
  GET  /executions/{id}
  POST /executions/{id}/cancel
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db, service, store
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
from .errors import CommandValidationError, ConfigUnavailableError, VozCoreError
from .graph.build import describe_graph
from .llm import llm, set_test_handler
from .planning import VALID_AGENT_STATUSES, validate_and_normalize_plan
from .schemas import ExecutionPlan, IntentAnalysis
from .errors import EngineAuthError

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


app = FastAPI(
    title="VozCore Engine",
    version="2.0.0",
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
    """Block plan/command when no credentials exist — a clear message, never fake work."""
    if not settings.llm_configured and not settings.fake_llm and not llm.has_test_handler():
        raise ConfigUnavailableError(
            "VozCore needs an OpenAI API key to reason. Set OPENAI_API_KEY in the "
            "server .env (see .env.example) and restart the engine — no simulated "
            "responses are ever returned."
        )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CommandRequest(BaseModel):
    command: str = Field(min_length=3, max_length=4000)
    conversationId: str | None = None
    sourceMessageId: str | None = None


class PlanRequest(BaseModel):
    command: str = Field(min_length=3, max_length=4000)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


@app.get("/health")
async def health(user: str = Depends(current_user_id)) -> dict[str, Any]:
    db_ok = False
    try:
        def _ping(conn):
            return db.scalar(conn, "SELECT 1") == 1

        db_ok = bool(await asyncio.to_thread(db.run_in_user_txn, user, _ping))
    except Exception:
        logger.exception("health db check failed")

    return {
        "data": {
        "status": "ok" if db_ok else "degraded",
        "engine": "vozcore",
        "phase": 2,
        "database": "ok" if db_ok else "error",
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
        },
        "message": (
            None
            if settings.llm_configured or settings.fake_llm
            else "OpenAI API key not configured — set OPENAI_API_KEY in .env to enable orchestration."
        ),
        },
    }


# ---------------------------------------------------------------------------
# GET /agents — honest capability catalogue
# ---------------------------------------------------------------------------


@app.get("/agents")
async def agents(user: str = Depends(current_user_id)) -> dict[str, Any]:
    def _load(conn):
        return store.load_agents(conn)

    rows = await asyncio.to_thread(db.run_in_user_txn, user, _load)
    catalogue = []
    for row in rows:
        if row["key"] == COORDINATOR_KEY:
            continue
        spec = AGENTS.get(row["key"])
        selectable = row["status"] in VALID_AGENT_STATUSES
        catalogue.append(
            {
                "key": row["key"],
                "agentId": row["id"],
                "name": row["name"],
                "status": row["status"],
                "role": spec.role if spec else (row.get("description") or ""),
                "capabilities": spec.capabilities if spec else [],
                # Operational = this agent can genuinely execute LLM subtasks now.
                "operational": selectable,
                "executionMode": "llm",
                "notes": (
                    None
                    if selectable
                    else f"Agent is {row['status']} — enable it in the Agent Hub to receive work."
                ),
            }
        )
    coordinator = next((r for r in rows if r["key"] == COORDINATOR_KEY), None)
    return {
        "data": {
        "coordinator": {
            "key": COORDINATOR_KEY,
            "name": COORDINATOR_NAME,
            "role": "Central AI manager — plans, delegates, evaluates and consolidates.",
            "status": coordinator["status"] if coordinator else "active",
            "operational": True,
            "executionMode": "llm",
        },
        "agents": catalogue,
        "llmMode": settings.llm_mode,
        },
    }


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
    selectable = [a for a in rows if a["key"] != COORDINATOR_KEY and a["status"] in VALID_AGENT_STATUSES]
    if not selectable:
        raise CommandValidationError("No specialist agents are available (all paused or in error).")

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
# POST /command — start a full execution
# ---------------------------------------------------------------------------


@app.post("/command")
async def run_command(request: CommandRequest, user: str = Depends(current_user_id)) -> dict[str, Any]:
    await require_engine_configured()
    execution = await service.start_execution(
        user,
        request.command,
        conversation_id=request.conversationId,
        source_message_id=request.sourceMessageId,
    )
    return {"data": {"execution": execution}}


# ---------------------------------------------------------------------------
# GET /executions
# ---------------------------------------------------------------------------


@app.get("/executions")
async def executions(
    conversationId: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    items = await service.list_executions(user, conversationId, limit)
    return {"data": items}


# ---------------------------------------------------------------------------
# GET /executions/{id}
# ---------------------------------------------------------------------------


@app.get("/executions/{execution_id}")
async def execution_detail(
    execution_id: str,
    sinceEventId: int = Query(default=0, ge=0),
    user: str = Depends(current_user_id),
) -> dict[str, Any]:
    return {"data": await service.get_execution_detail(user, execution_id, sinceEventId)}


# ---------------------------------------------------------------------------
# POST /executions/{id}/cancel
# ---------------------------------------------------------------------------


@app.post("/executions/{execution_id}/cancel")
async def cancel(execution_id: str, user: str = Depends(current_user_id)) -> dict[str, Any]:
    execution = await service.cancel_execution(user, execution_id)
    return {"data": {"execution": execution}}
