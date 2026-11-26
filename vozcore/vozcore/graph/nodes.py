"""The twelve VozCore LangGraph nodes.

Each node persists its step row + events, keeps the shared execution state
coherent, and checks for user cancellation. Parallel agent execution happens
inside `execute_agents` via asyncio.gather over dependency-free tasks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Awaitable, Callable

from .. import db, store
from ..agents_registry import (
    AGENTS,
    COORDINATOR_KEY,
    EVALUATE_SYSTEM,
    FINALIZE_SYSTEM,
    INTENT_SYSTEM,
    PLAN_SYSTEM,
    agent_catalogue,
    specialist_prompt,
)
from ..config import settings
from ..errors import ConfigUnavailableError, VozCoreError
from ..llm import llm
from ..planning import VALID_AGENT_STATUSES, build_execution_waves, validate_and_normalize_plan
from ..schemas import AgentOutput, EvaluationResult, ExecutionPlan, FinalResponse, IntentAnalysis
from .state import ExecutionState

logger = logging.getLogger("vozcore.nodes")

# Nodes that must still run after a cancellation request (for honest reporting).
KEEP_WHEN_CANCELLED = {"receive_command", "generate_final_response", "save_execution_memory"}


def step(name: str):
    """Decorator: persists the graph step, checks cancellation, checkpoints state."""

    def wrap(fn: Callable[[ExecutionState], Awaitable[ExecutionState]]):
        async def node(state: ExecutionState) -> ExecutionState:
            user_id = state["user_id"]
            execution_id = state["execution_id"]
            seq = int(state.get("step_seq", 0)) + 1
            state["step_seq"] = seq

            cancelled = bool(state.get("cancelled"))
            if not cancelled and name not in KEEP_WHEN_CANCELLED:
                cancelled = await asyncio.to_thread(_poll_cancel, user_id, execution_id)
                state["cancelled"] = cancelled

            if cancelled and name not in KEEP_WHEN_CANCELLED:
                await asyncio.to_thread(
                    _record_step, user_id, execution_id, name, seq, "skipped", {"skipped": "cancelled"}, None, True
                )
                await asyncio.to_thread(
                    _event, user_id, execution_id, "step_skipped", {"step": name, "reason": "cancelled"}
                )
                return state

            await asyncio.to_thread(_record_step, user_id, execution_id, name, seq, "running", None, None, False)
            await asyncio.to_thread(_event, user_id, execution_id, "step_started", {"step": name})
            try:
                result = await fn(state)
                output = _step_output(result, name)
                await asyncio.to_thread(
                    _record_step, user_id, execution_id, name, seq, "completed", output, None, True
                )
                await asyncio.to_thread(_checkpoint, user_id, execution_id, result, name)
                return result
            except Exception as exc:
                message = exc.message if isinstance(exc, VozCoreError) else str(exc)
                await asyncio.to_thread(
                    _record_step, user_id, execution_id, name, seq, "failed", None, message[:1000], True
                )
                await asyncio.to_thread(
                    _event, user_id, execution_id, "step_failed", {"step": name, "error": message[:500]}
                )
                raise

        return node

    return wrap


def _poll_cancel(user_id: str, execution_id: str) -> bool:
    with db.user_txn(user_id) as conn:
        row = db.row(conn, "SELECT cancel_requested FROM executions WHERE id = %s", (execution_id,))
        return bool(row and row["cancel_requested"])


def _record_step(user_id, execution_id, name, seq, status, output, error, finish):
    with db.user_txn(user_id) as conn:
        store.upsert_step(conn, user_id, execution_id, name, seq, status, output, error, finish)


def _event(user_id, execution_id, event_type, payload):
    with db.user_txn(user_id) as conn:
        store.add_event(conn, execution_id, user_id, event_type, payload)


def _checkpoint(user_id, execution_id, state, step_name):
    snapshot = {
        "step": step_name,
        "intent": state.get("intent"),
        "plan_summary": (state.get("plan") or {}).get("summary"),
        "task_statuses": [
            {"key": t.get("task_key"), "status": t.get("status"), "agent": t.get("agent_key")}
            for t in state.get("tasks", [])
        ],
        "evaluation": state.get("evaluation"),
        "cancelled": bool(state.get("cancelled")),
    }
    with db.user_txn(user_id) as conn:
        store.update_execution(conn, execution_id, state_checkpoint=snapshot)


def _step_output(state: ExecutionState, name: str) -> dict[str, Any]:
    if name == "understand_intent":
        return {
            "objective": (state.get("intent") or {}).get("objective"),
            "needsClarification": bool(state.get("clarification")),
        }
    if name == "create_plan":
        plan = state.get("plan") or {}
        return {"summary": plan.get("summary"), "tasks": len(plan.get("tasks", []))}
    if name == "select_agents":
        return {"agents": [a["key"] for a in state.get("selected_agents", [])]}
    if name == "dispatch_tasks":
        return {"dispatched": len(state.get("tasks", []))}
    if name == "execute_agents":
        statuses: dict[str, int] = {}
        for t in state.get("tasks", []):
            key = t.get("status", "?")
            statuses[key] = statuses.get(key, 0) + 1
        return statuses
    if name == "evaluate_results":
        ev = state.get("evaluation") or {}
        return {"verdict": ev.get("verdict"), "needsRetry": ev.get("needs_retry")}
    if name == "generate_final_response":
        return {"headline": (state.get("final_response") or {}).get("headline")}
    if name == "save_execution_memory":
        return {"saved": bool(state.get("memory_saved"))}
    return {}


# ---------------------------------------------------------------------------
#1 — receive_command
# ---------------------------------------------------------------------------


@step("receive_command")
async def receive_command(state: ExecutionState) -> ExecutionState:
    command = (state.get("command") or "").strip()
    if len(command) < 3:
        raise VozCoreError("Command is too short to act on.")
    state["command"] = command
    state.setdefault("attempt_round", 0)
    state.setdefault("step_seq", 0)

    user_id, execution_id = state["user_id"], state["execution_id"]

    def _load(conn):
        db.execute(
            conn,
            "UPDATE executions SET started_at = COALESCE(started_at, now()) WHERE id = %s",
            (execution_id,),
        )
        attached = store.load_attached_tasks(conn, state.get("source_message_id"))
        store.add_event(
            conn,
            execution_id,
            user_id,
            "command_received",
            {"command": command[:500], "attachedTasks": [t["title"] for t in attached]},
        )
        return attached

    state["attached_tasks"] = await asyncio.to_thread(db.run_in_user_txn, user_id, _load)
    return state


# ---------------------------------------------------------------------------
#2 — understand_intent
# ---------------------------------------------------------------------------


@step("understand_intent")
async def understand_intent(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]

    agents = await asyncio.to_thread(db.run_in_user_txn, user_id, store.load_agents)
    selectable = [a for a in agents if a["key"] != COORDINATOR_KEY and a["status"] in VALID_AGENT_STATUSES]

    prompt = (
        f"CATALOGUE OF AVAILABLE AGENTS:\n{agent_catalogue(selectable)}\n\n"
        f"USER COMMAND:\n{state['command']}\n\n"
        + (
            "ATTACHED TASK CONTEXT (titles the user linked):\n"
            + "\n".join(f"- {t['title']}" for t in state.get("attached_tasks", []))
            + "\n\n"
            if state.get("attached_tasks")
            else ""
        )
        + "Analyse the command."
    )
    intent: IntentAnalysis = await llm.structured(
        purpose="intent",
        system=INTENT_SYSTEM,
        prompt=prompt,
        schema=IntentAnalysis,
        user_id=user_id,
        execution_id=execution_id,
    )
    state["intent"] = intent.model_dump()
    state["clarification"] = intent.clarification_question if intent.needs_clarification else None

    def _after(conn):
        store.update_execution(
            conn,
            execution_id,
            intent=intent.model_dump(),
            clarification=state.get("clarification"),
        )
        store.add_event(
            conn,
            execution_id,
            user_id,
            "intent_understood",
            {
                "objective": intent.objective[:300],
                "complexity": intent.complexity,
                "needsClarification": intent.needs_clarification,
                "suggestedAgents": intent.suggested_agents,
            },
        )

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)
    return state


# ---------------------------------------------------------------------------
#3 — retrieve_memory
# ---------------------------------------------------------------------------


@step("retrieve_memory")
async def retrieve_memory(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]

    def _search(conn):
        memories = store.search_memories(conn, state["command"], limit=5)
        store.add_event(
            conn,
            execution_id,
            user_id,
            "memory_retrieved",
            {"count": len(memories), "titles": [m["title"][:80] for m in memories]},
        )
        return memories

    memories = await asyncio.to_thread(db.run_in_user_txn, user_id, _search)
    # Only compact excerpts travel with the state — full entries stay in the DB.
    state["memory"] = [
        {
            "title": m["title"][:120],
            "category": m.get("category", "general"),
            "excerpt": (m.get("content") or "")[:400],
        }
        for m in memories
    ]
    return state


# ---------------------------------------------------------------------------
#4 — create_plan
# ---------------------------------------------------------------------------


@step("create_plan")
async def create_plan(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]

    agents = await asyncio.to_thread(db.run_in_user_txn, user_id, store.load_agents)
    selectable = [a for a in agents if a["key"] != COORDINATOR_KEY and a["status"] in VALID_AGENT_STATUSES]
    if not selectable:
        raise VozCoreError(
            "No specialist agents are available — every agent is paused or in an error state. "
            "Enable at least one agent in the Agent Hub."
        )

    memory_block = "\n".join(f"- [{m['category']}] {m['title']}: {m['excerpt']}" for m in state.get("memory", []))
    intent = state.get("intent", {})
    prompt = (
        f"COMMAND:\n{state['command']}\n\n"
        f"OBJECTIVE: {intent.get('objective', '')}\n"
        f"OUTCOME: {intent.get('outcome', '')}\n"
        f"CONSTRAINTS: {', '.join(intent.get('constraints', [])) or 'none'}\n"
        f"DEADLINES: {', '.join(intent.get('deadlines', [])) or 'none'}\n"
        f"MISSING (non-blocking): {', '.join(intent.get('missing_information', [])) or 'none'}\n\n"
        f"RELEVANT MEMORY:\n{memory_block or '(none)'}\n\n"
        f"AGENT CATALOGUE:\n{agent_catalogue(selectable)}\n\n"
        f"Create the plan (max {settings.max_tasks_per_execution} tasks, keys t1..tN)."
    )
    plan_model: ExecutionPlan = await llm.structured(
        purpose="plan",
        system=PLAN_SYSTEM.format(max_tasks=settings.max_tasks_per_execution),
        prompt=prompt,
        schema=ExecutionPlan,
        user_id=user_id,
        execution_id=execution_id,
    )

    available_keys = [a["key"] for a in selectable]
    fallback = "research" if "research" in available_keys else available_keys[0]
    try:
        plan, warnings = validate_and_normalize_plan(plan_model.model_dump(), available_keys, fallback)
    except ValueError as exc:
        raise VozCoreError(f"Planner produced an unusable plan: {exc}") from exc

    state["plan"] = plan

    def _after(conn):
        store.update_execution(conn, execution_id, plan=plan)
        store.add_event(
            conn,
            execution_id,
            user_id,
            "plan_created",
            {
                "summary": plan["summary"],
                "taskCount": len(plan["tasks"]),
                "waves": sorted({t["wave"] for t in plan["tasks"]}),
                "warnings": warnings,
                "parallelizable": plan["parallelizable"],
            },
        )

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)
    return state


# ---------------------------------------------------------------------------
#5 — select_agents
# ---------------------------------------------------------------------------


@step("select_agents")
async def select_agents(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    plan = state.get("plan") or {}

    agents = await asyncio.to_thread(db.run_in_user_txn, user_id, store.load_agents)
    by_key = {a["key"]: a for a in agents}
    selectable_keys = [k for k, a in by_key.items() if k != COORDINATOR_KEY and a["status"] in VALID_AGENT_STATUSES]

    selected: dict[str, dict[str, Any]] = {}
    remapped: list[dict[str, str]] = []
    fallback = "research" if "research" in selectable_keys else (selectable_keys[0] if selectable_keys else None)
    if not fallback:
        raise VozCoreError("No specialist agents are available for selection.")

    for task in plan.get("tasks", []):
        key = task["agent_key"]
        agent = by_key.get(key)
        if not agent or agent["status"] not in VALID_AGENT_STATUSES:
            new_key = fallback
            remapped.append({"from": key, "to": new_key, "task": task["task_key"]})
            task["agent_key"] = new_key
            key = new_key
            agent = by_key[key]
        spec = AGENTS.get(key)
        selected[key] = {
            "key": key,
            "agentId": agent["id"],
            "name": agent["name"],
            "status": agent["status"],
            "role": spec.role if spec else (agent.get("description") or ""),
            "capabilities": spec.capabilities if spec else [],
            "operational": True,
            "executionMode": "llm",
        }
        task["agent_id"] = agent["id"]

    state["selected_agents"] = list(selected.values())

    def _after(conn):
        if remapped:
            store.update_execution(conn, execution_id, plan=plan)
            store.add_event(conn, execution_id, user_id, "agents_remapped", {"remaps": remapped})
        store.add_event(
            conn,
            execution_id,
            user_id,
            "agents_selected",
            {"agents": [a["key"] for a in state["selected_agents"]]},
        )
        store.touch_agent_last_active(conn, user_id, [a["key"] for a in state["selected_agents"]])

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)
    return state


# ---------------------------------------------------------------------------
#6 — dispatch_tasks
# ---------------------------------------------------------------------------


@step("dispatch_tasks")
async def dispatch_tasks(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    plan = state.get("plan") or {}
    retry_keys = set(state.get("retry_keys") or [])
    state["retry_keys"] = []

    tasks = []
    for raw in plan.get("tasks", []):
        task = dict(raw)
        if retry_keys and task["task_key"] in retry_keys:
            task["_reset"] = True
        tasks.append(task)

    def _dispatch(conn):
        approvals = []
        for task in tasks:
            store.upsert_task(conn, user_id, execution_id, task)
            if task.get("approval_required") and not (retry_keys and task["task_key"] in retry_keys):
                agent = next((a for a in state.get("selected_agents", []) if a["key"] == task["agent_key"]), None)
                store.insert_approval(
                    conn,
                    user_id,
                    execution_id,
                    (agent or {}).get("agentId"),
                    f"VozCore approval: {task['title']}",
                    (
                        f"Execution {execution_id[:8]} wants to run a sensitive subtask:\n"
                        f"{task['description'][:800]}\n\n"
                        "It is held at an approval checkpoint and will not run until approved."
                    ),
                )
                approvals.append(task["task_key"])
        db.execute(
            conn,
            "UPDATE executions SET status = CASE WHEN status = 'planning' THEN 'running' ELSE status END "
            "WHERE id = %s AND status IN ('planning', 'running', 'waiting')",
            (execution_id,),
        )
        store.add_event(
            conn,
            execution_id,
            user_id,
            "tasks_dispatched",
            {
                "count": len(tasks),
                "retry": sorted(retry_keys) if retry_keys else [],
                "approvalCheckpoints": approvals,
                "byAgent": {
                    key: sum(1 for t in tasks if t["agent_key"] == key)
                    for key in sorted({t["agent_key"] for t in tasks})
                },
            },
        )
        if approvals:
            store.add_event(conn, execution_id, user_id, "approval_checkpoints_created", {"tasks": approvals})
        return store.load_tasks(conn, execution_id)

    state["tasks"] = await asyncio.to_thread(db.run_in_user_txn, user_id, _dispatch)
    return state


# ---------------------------------------------------------------------------
#7 — execute_agents (parallel fan-out, bounded retries, per-task timeouts)
# ---------------------------------------------------------------------------


@step("execute_agents")
async def execute_agents(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]

    def _fresh(conn):
        return store.load_tasks(conn, execution_id), store.load_results(conn, execution_id)

    tasks, prior_results = await asyncio.to_thread(db.run_in_user_txn, user_id, _fresh)
    if not tasks:
        tasks = state.get("tasks") or []
    state["tasks"] = tasks

    # Seed dependency summaries from prior attempts (retry rounds).
    dep_summaries: dict[str, str] = {}
    for r in prior_results:
        if r.get("status") == "completed" and r.get("result_summary"):
            dep_summaries[r.get("taskKey") or ""] = r["result_summary"]

    status_by_key: dict[str, str] = {t["task_key"]: t["status"] for t in tasks}
    cancelled = bool(state.get("cancelled"))

    # ---- DB helpers bound to this execution + user ----
    def mark_running(conn, key: str):
        store.set_task_status(conn, execution_id, key, "running")
        store.add_event(conn, execution_id, user_id, "task_started", {"task": key})

    def mark_cancelled(conn, key: str):
        store.set_task_status(conn, execution_id, key, "cancelled", error="cancelled by user")
        store.add_event(conn, execution_id, user_id, "task_cancelled", {"task": key})

    def mark_blocked(conn, key: str, reason: str):
        store.set_task_status(conn, execution_id, key, "waiting", error=reason)
        store.add_event(conn, execution_id, user_id, "task_waiting", {"task": key, "reason": reason})

    def mark_failed(conn, key: str, reason: str):
        store.set_task_status(conn, execution_id, key, "failed", error=reason)
        store.add_event(
            conn, execution_id, user_id, "task_failed", {"task": key, "errors": [reason], "attempt": None}
        )

    def finish_task(conn, key: str, payload: dict[str, Any]):
        status = payload.get("status", "failed")
        error_text = "; ".join(payload.get("errors") or []) or None
        store.set_task_status(
            conn,
            execution_id,
            key,
            status,
            error=error_text if status != "completed" else None,
        )
        task_row = db.row(
            conn, "SELECT id, attempts, agent_key FROM agent_tasks WHERE execution_id = %s AND task_key = %s",
            (execution_id, key),
        )
        if task_row:
            db.execute(
                conn,
                """
                INSERT INTO agent_results
                  (execution_id, user_id, agent_task_id, attempt, agent_key, status,
                   result_summary, detailed_output, missing_information, errors, model)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    execution_id,
                    user_id,
                    task_row["id"],
                    int(task_row["attempts"] or 1),
                    payload.get("agent_key") or task_row["agent_key"],
                    status,
                    (payload.get("result_summary") or "")[:4000],
                    (payload.get("detailed_output") or "")[:40000],
                    json.dumps(payload.get("missing_information") or [], ensure_ascii=False),
                    json.dumps(payload.get("errors") or [], ensure_ascii=False),
                    payload.get("model"),
                ),
            )
        store.add_event(
            conn,
            execution_id,
            user_id,
            "task_completed" if status == "completed" else "task_failed",
            {
                "task": key,
                "agent": payload.get("agent_key") or (task_row or {}).get("agent_key"),
                "summary": (payload.get("result_summary") or "")[:300],
                "errors": payload.get("errors") or [],
                "attempt": int((task_row or {}).get("attempts") or 1),
            },
        )

    async def run_task(task: dict[str, Any]) -> None:
        key = task["task_key"]

        if int(task.get("attempts", 0)) >= int(task.get("max_attempts", settings.max_task_attempts)):
            status_by_key[key] = "failed"
            return

        if await asyncio.to_thread(_poll_cancel, user_id, execution_id):
            await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: mark_cancelled(c, key))
            status_by_key[key] = "cancelled"
            task["status"] = "cancelled"
            return

        await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: mark_running(c, key))
        status_by_key[key] = "running"
        task["status"] = "running"

        spec = AGENTS.get(task["agent_key"])
        context_block = _agent_context(state, task, dep_summaries)
        if spec:
            system_prompt = specialist_prompt(spec, task, context_block)
        else:
            system_prompt = (
                f"You are the {task['agent_key']} specialist in the VozPilot workforce.\n"
                f"{task.get('description', '')}\n\nCONTEXT:\n{context_block}\n"
                "Return the structured result honestly; set completed=false if inputs are missing."
            )

        try:
            output: AgentOutput = await asyncio.wait_for(
                llm.structured(
                    purpose="agent",
                    system=system_prompt,
                    prompt=f"Execute assigned subtask {key} now.",
                    schema=AgentOutput,
                    user_id=user_id,
                    execution_id=execution_id,
                ),
                timeout=settings.task_timeout_seconds,
            )
            payload = output.model_dump()
            payload["status"] = "completed" if output.completed else "failed"
            payload["agent_key"] = task["agent_key"]
            payload["model"] = settings.openai_model if settings.llm_configured else settings.llm_mode
            if not output.completed:
                payload["errors"] = list(output.missing_information) or ["agent reported incomplete work"]

            await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: finish_task(c, key, payload))
            status_by_key[key] = payload["status"]
            task["status"] = payload["status"]
            if output.result_summary:
                dep_summaries[key] = output.result_summary

        except asyncio.TimeoutError:
            message = f"Agent timed out after {int(settings.task_timeout_seconds)}s"
            await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: finish_task(c, key, _error_payload(message, task["agent_key"])))
            status_by_key[key] = "failed"
            task["status"] = "failed"
            task["error"] = message
        except ConfigUnavailableError:
            raise  # missing credentials abort the whole execution — never fake results
        except VozCoreError as exc:
            await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: finish_task(c, key, _error_payload(exc.message, task["agent_key"])))
            status_by_key[key] = "failed"
            task["status"] = "failed"
            task["error"] = exc.message
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # unexpected agent failure — recorded, never hidden
            logger.exception("agent task %s failed", key)
            message = f"{type(exc).__name__}: {exc}"[:500]
            await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: finish_task(c, key, _error_payload(message, task["agent_key"])))
            status_by_key[key] = "failed"
            task["status"] = "failed"
            task["error"] = message

    waves = build_execution_waves(tasks)

    for wave in waves:
        if await asyncio.to_thread(_poll_cancel, user_id, execution_id):
            state["cancelled"] = True
            cancelled = True

        if cancelled:
            for task in wave:
                if status_by_key.get(task["task_key"]) == "pending" and not task.get("approval_required"):
                    await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: mark_cancelled(c, task["task_key"]))
                    status_by_key[task["task_key"]] = "cancelled"
                    task["status"] = "cancelled"
            break

        runnable: list[dict[str, Any]] = []
        for task in wave:
            key = task["task_key"]
            if task.get("approval_required"):
                continue
            current = status_by_key.get(key, "pending")
            if current not in {"pending"}:
                continue
            if int(task.get("attempts", 0)) >= int(task.get("max_attempts", settings.max_task_attempts)):
                if status_by_key.get(key) != "failed":
                    await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: mark_failed(c, key, "retry budget exhausted"))
                    status_by_key[key] = "failed"
                    task["status"] = "failed"
                continue

            deps = task.get("depends_on") or []
            failed_deps = [d for d in deps if status_by_key.get(d) in {"failed", "cancelled"}]
            waiting_deps = [d for d in deps if status_by_key.get(d) == "waiting"]
            if failed_deps:
                await asyncio.to_thread(
                    db.run_in_user_txn, user_id,
                    lambda c: mark_failed(c, key, f"upstream task(s) failed: {', '.join(failed_deps)}"),
                )
                status_by_key[key] = "failed"
                task["status"] = "failed"
                task["error"] = f"upstream task(s) failed: {', '.join(failed_deps)}"
                continue
            if waiting_deps:
                await asyncio.to_thread(
                    db.run_in_user_txn, user_id,
                    lambda c: mark_blocked(c, key, f"awaiting upstream approval: {', '.join(waiting_deps)}"),
                )
                status_by_key[key] = "waiting"
                task["status"] = "waiting"
                continue
            runnable.append(task)

        if runnable:
            # independent tasks in the same wave execute concurrently
            await asyncio.gather(*(run_task(t) for t in runnable))

    # refresh from DB so state reflects persisted truth (never optimistic)
    state["tasks"] = await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: store.load_tasks(c, execution_id))
    state["cancelled"] = cancelled or bool(state.get("cancelled"))
    return state


def _error_payload(message: str, agent_key: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "agent_key": agent_key,
        "result_summary": "",
        "detailed_output": "",
        "missing_information": [],
        "errors": [message],
        "model": None,
    }


def _agent_context(state: ExecutionState, task: dict[str, Any], dep_summaries: dict[str, str]) -> str:
    """Only the context necessary for this subtask — nothing else travels."""
    lines: list[str] = []
    intent = state.get("intent") or {}
    if intent.get("outcome"):
        lines.append(f"User outcome wanted: {intent['outcome']}")
    constraints = intent.get("constraints") or []
    if constraints:
        lines.append("Constraints: " + "; ".join(constraints[:6]))
    deadlines = intent.get("deadlines") or []
    if deadlines:
        lines.append("Deadlines: " + "; ".join(deadlines[:4]))
    attached = state.get("attached_tasks") or []
    if attached:
        lines.append("User-linked tasks: " + ", ".join(t["title"] for t in attached[:5]))
    deps = task.get("depends_on") or []
    if deps:
        lines.append("Results of upstream subtasks:")
        for dep in deps:
            summary = dep_summaries.get(dep) or "(upstream completed — no summary stored)"
            lines.append(f"- {dep}: {summary[:400]}")
    memory = state.get("memory") or []
    if memory:
        lines.append("Relevant workspace memory:")
        for m in memory[:3]:
            lines.append(f"- {m['title']}: {m['excerpt'][:250]}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
#8 — collect_results
# ---------------------------------------------------------------------------


@step("collect_results")
async def collect_results(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]

    def _load(conn):
        tasks = store.load_tasks(conn, execution_id)
        results = store.load_results(conn, execution_id)
        store.add_event(
            conn,
            execution_id,
            user_id,
            "results_collected",
            {
                "completed": sum(1 for t in tasks if t["status"] == "completed"),
                "failed": sum(1 for t in tasks if t["status"] == "failed"),
                "waiting": sum(1 for t in tasks if t["status"] == "waiting"),
                "cancelled": sum(1 for t in tasks if t["status"] == "cancelled"),
            },
        )
        return tasks, results

    tasks, results = await asyncio.to_thread(db.run_in_user_txn, user_id, _load)
    state["tasks"] = tasks
    state["results"] = results
    return state


# ---------------------------------------------------------------------------
#9 — evaluate_results
# ---------------------------------------------------------------------------


@step("evaluate_results")
async def evaluate_results(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    tasks = state.get("tasks") or []

    if state.get("cancelled"):
        state["evaluation"] = {
            "verdict": "partial",
            "all_tasks_successful": False,
            "completeness_score": _deterministic_score(tasks),
            "missing_information": [],
            "failed_task_keys": [t["task_key"] for t in tasks if t["status"] == "failed"],
            "retry_task_keys": [],
            "needs_retry": False,
            "evaluation_notes": "Execution cancelled by the user before completion.",
        }
        return state

    failed_keys = [t["task_key"] for t in tasks if t["status"] in {"failed", "cancelled"}]
    result_lines = [
        f"- {r.get('taskKey') or r.get('agent_key')} via {r.get('agent_key')} [attempt {r.get('attempt')}]: "
        f"{r.get('status')} — {(r.get('result_summary') or '')[:400]}"
        + (f" | missing: {', '.join(r.get('missing_information') or [])}" if r.get("missing_information") else "")
        for r in state.get("results", [])
    ]
    task_lines = [
        f"- {t['task_key']} ({t['agent_key']}): {t['status']}"
        + (f" — {t.get('error')}" if t.get("error") else "")
        + (" [approval checkpoint — intentionally not run]" if t.get("approval_required") else "")
        for t in tasks
    ]

    prompt = (
        f"COMMAND:\n{state['command']}\n\n"
        f"OUTCOME: {(state.get('intent') or {}).get('outcome', '')}\n\n"
        f"PLAN: {(state.get('plan') or {}).get('summary', '')}\n\n"
        f"TASK STATUSES:\n" + "\n".join(task_lines) + "\n\n"
        f"AGENT RESULTS:\n" + ("\n".join(result_lines) or "(none)") + "\n\n"
        "Evaluate strictly. Tasks at approval checkpoints are NOT failures. "
        f"This is attempt round {int(state.get('attempt_round', 0)) + 1} of {settings.max_task_attempts}."
    )
    evaluation: EvaluationResult = await llm.structured(
        purpose="evaluate",
        system=EVALUATE_SYSTEM,
        prompt=prompt,
        schema=EvaluationResult,
        user_id=user_id,
        execution_id=execution_id,
    )
    ev = evaluation.model_dump()

    # ---- Hard safety rails the model cannot override ----
    ev["failed_task_keys"] = sorted(set(failed_keys))
    can_retry = int(state.get("attempt_round", 0)) + 1 < settings.max_task_attempts
    if not can_retry or not ev.get("needs_retry"):
        ev["needs_retry"] = False
        ev["retry_task_keys"] = []
    else:
        ev["retry_task_keys"] = [k for k in (ev.get("retry_task_keys") or []) if k in failed_keys]
        if not ev["retry_task_keys"]:
            ev["needs_retry"] = False

    unsettled = [t for t in tasks if t["status"] in {"failed", "cancelled", "pending", "running"}]
    ev["all_tasks_successful"] = bool(tasks) and not unsettled
    if ev["all_tasks_successful"]:
        ev["verdict"] = "completed"
        ev["needs_retry"] = False
        ev["retry_task_keys"] = []
    elif failed_keys and ev.get("verdict") == "completed":
        ev["verdict"] = "partial"

    state["evaluation"] = ev

    def _after(conn):
        store.add_event(
            conn,
            execution_id,
            user_id,
            "evaluation_complete",
            {
                "verdict": ev["verdict"],
                "needsRetry": ev["needs_retry"],
                "score": ev["completeness_score"],
                "failed": ev["failed_task_keys"],
            },
        )

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)
    return state


def _deterministic_score(tasks: list[dict[str, Any]]) -> int:
    if not tasks:
        return 0
    done = sum(1 for t in tasks if t["status"] in {"completed", "waiting"})
    return int(100 * done / len(tasks))


# ---------------------------------------------------------------------------
#10 — retry_or_reassign
# ---------------------------------------------------------------------------


@step("retry_or_reassign")
async def retry_or_reassign(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    evaluation = state.get("evaluation") or {}
    retry_keys = list(evaluation.get("retry_task_keys") or [])
    round_no = int(state.get("attempt_round", 0)) + 1
    state["attempt_round"] = round_no
    state["retry_keys"] = retry_keys

    tasks = state.get("tasks") or []
    reassignments: list[dict[str, str]] = []

    # On the final allowed round, reassign failing tasks to a different agent.
    if round_no >= settings.max_task_attempts:
        agents = await asyncio.to_thread(db.run_in_user_txn, user_id, store.load_agents)
        selectable = {
            a["key"]: a
            for a in agents
            if a["key"] != COORDINATOR_KEY and a["status"] in VALID_AGENT_STATUSES
        }
        for key in retry_keys:
            task = next((t for t in tasks if t["task_key"] == key), None)
            if not task:
                continue
            current = task["agent_key"]
            alternates = [k for k in selectable if k != current and AGENTS.get(k)]
            if alternates:
                text = f"{task['title']} {task['description']}".lower()
                best = max(
                    alternates,
                    key=lambda k: sum(1 for h in AGENTS[k].selection_hints if h in text),
                )
                if best != current:
                    reassignments.append({"task": key, "from": current, "to": best})
                    task["agent_key"] = best
                    task["agent_id"] = selectable[best]["id"]

    def _after(conn):
        store.add_event(
            conn,
            execution_id,
            user_id,
            "retry_scheduled",
            {"round": round_no, "tasks": retry_keys, "reassignments": reassignments},
        )

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)

    plan = state.get("plan") or {}
    for task in plan.get("tasks", []):
        match = next((r for r in reassignments if r["task"] == task["task_key"]), None)
        if match:
            task["agent_key"] = match["to"]
    state["plan"] = plan
    if reassignments:
        for r in reassignments:
            for a in state.get("selected_agents", []):
                if a["key"] == r["to"]:
                    a["operational"] = True
    return state


# ---------------------------------------------------------------------------
#11 — generate_final_response
# ---------------------------------------------------------------------------


@step("generate_final_response")
async def generate_final_response(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    conversation_id = state.get("conversation_id")

    if not state.get("tasks"):
        # clarify/cancel paths may run before dispatch — load whatever exists
        state["tasks"] = await asyncio.to_thread(
            db.run_in_user_txn, user_id, lambda c: store.load_tasks(c, execution_id)
        )
    tasks = state.get("tasks") or []

    if state.get("clarification"):
        final = FinalResponse(
            headline="Need a bit more detail",
            report=state["clarification"],
            open_items=[state["clarification"]],
        )
        path = "clarification"
    elif state.get("cancelled"):
        completed = [t for t in tasks if t["status"] == "completed"]
        lines = [
            f"Execution cancelled by you. {len(completed)} of {len(tasks)} subtasks had finished before the stop."
        ]
        lines += [f"• {t['title']} — {t['status']}" for t in tasks]
        final = FinalResponse(
            headline="Execution cancelled",
            report="\n".join(lines),
            open_items=["Send the command again to start a fresh run."],
        )
        path = "cancelled"
    else:
        evaluation = state.get("evaluation") or {}
        result_block = "\n".join(
            f"- task {r.get('taskKey') or '?'} via {r.get('agent_key')} ({r.get('status')}): "
            f"{(r.get('result_summary') or '')[:500]}"
            + (f"\n  detailed: {(r.get('detailed_output') or '')[:1500]}" if r.get("detailed_output") else "")
            for r in state.get("results", [])
        )
        task_block = "\n".join(
            f"- {t['task_key']} {t['title']} [{t['status']}] agent={t['agent_key']}"
            + (" (awaiting approval)" if t.get("approval_required") and t["status"] == "waiting" else "")
            for t in tasks
        )
        prompt = (
            f"COMMAND:\n{state['command']}\n\n"
            f"PLAN: {(state.get('plan') or {}).get('summary', '')}\n\n"
            f"EVALUATION: verdict={evaluation.get('verdict')}, "
            f"score={evaluation.get('completeness_score')}, "
            f"notes={evaluation.get('evaluation_notes')}\n\n"
            f"TASKS:\n{task_block or '(none)'}\n\n"
            f"AGENT RESULTS (merge and deduplicate):\n{result_block or '(none)'}\n\n"
            "Write the consolidated final report."
        )
        final = await llm.structured(
            purpose="final_response",
            system=FINALIZE_SYSTEM,
            prompt=prompt,
            schema=FinalResponse,
            user_id=user_id,
            execution_id=execution_id,
        )
        path = "report"

    content = f"{final.headline}\n\n{final.report}"
    state["final_response"] = {**final.model_dump(), "path": path}

    def _after(conn):
        store.update_execution(conn, execution_id, final_response=content, clarification=state.get("clarification"))
        if conversation_id:
            store.insert_assistant_message(conn, user_id, conversation_id, execution_id, content[:20000])
        store.add_event(
            conn,
            execution_id,
            user_id,
            "response_generated",
            {"headline": final.headline[:200], "path": path, "openItems": final.open_items[:5]},
        )

    await asyncio.to_thread(db.run_in_user_txn, user_id, _after)
    return state


# ---------------------------------------------------------------------------
#12 — save_execution_memory
# ---------------------------------------------------------------------------

SENSITIVE_PATTERN = re.compile(
    r"\b(password|passwd|api[_\s-]?key|secret|credential|private[_\s-]?key|access[_\s-]?token)\b",
    re.IGNORECASE,
)


@step("save_execution_memory")
async def save_execution_memory(state: ExecutionState) -> ExecutionState:
    user_id, execution_id = state["user_id"], state["execution_id"]
    state["memory_saved"] = False

    def _skip(conn, reason: str):
        store.add_event(conn, execution_id, user_id, "memory_skipped", {"reason": reason})

    evaluation = state.get("evaluation") or {}
    if state.get("cancelled"):
        await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: _skip(c, "cancelled"))
        return state
    if state.get("clarification"):
        await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: _skip(c, "clarification_pending"))
        return state
    if evaluation.get("verdict") != "completed":
        await asyncio.to_thread(
            db.run_in_user_txn, user_id, lambda c: _skip(c, f"verdict_{evaluation.get('verdict', 'unknown')}")
        )
        return state

    final = state.get("final_response") or {}
    report = final.get("report") or ""
    headline = final.get("headline") or "VozCore execution"
    if len(report.strip()) < 40:
        await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: _skip(c, "report_too_short"))
        return state
    if SENSITIVE_PATTERN.search(report) or SENSITIVE_PATTERN.search(state.get("command", "")):
        await asyncio.to_thread(db.run_in_user_txn, user_id, lambda c: _skip(c, "possible_sensitive_content"))
        return state

    def _save(conn):
        store.insert_memory(
            conn,
            user_id,
            f"VozCore: {headline}"[:160],
            report[:4000],
            ["vozcore", f"execution:{execution_id[:8]}"],
            execution_id,
        )
        store.add_event(conn, execution_id, user_id, "memory_saved", {"title": headline[:120]})
        return True

    state["memory_saved"] = await asyncio.to_thread(db.run_in_user_txn, user_id, _save)
    return state
