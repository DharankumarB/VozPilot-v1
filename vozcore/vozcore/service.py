"""Execution lifecycle: start, run (LangGraph), direct agent test, finalize, cancel, recover."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from . import communication, db, store
from .agents.registry import get_specialist
from .config import settings
from .db import Utf8Json as JSON
from .errors import CommandValidationError, ConfigUnavailableError, NotFoundError, VozCoreError
from .graph.build import compiled_graph
from .graph.state import ExecutionState
from .security import PermissionDeniedError

logger = logging.getLogger("vozcore.service")

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def start_execution(
    user_id: str,
    command: str,
    conversation_id: str | None = None,
    source_message_id: str | None = None,
) -> dict[str, Any]:
    """Persist a new execution and kick off the graph in the background."""
    command = command.strip()
    if len(command) < 3:
        raise VozCoreError("Command is too short to act on.")
    if len(command) > 4000:
        raise VozCoreError("Command is too long (4000 character limit).")

    def _create(conn):
        if store.is_workspace_paused(conn, user_id):
            raise PermissionDeniedError(
                "All agents are currently paused. Resume agents in Agent Hub before dispatching commands."
            )
        if conversation_id:
            conversation = db.row(conn, "SELECT id FROM conversations WHERE id = %s", (conversation_id,))
            if not conversation:
                raise NotFoundError("Conversation not found.")
        if source_message_id:
            message = db.row(
                conn, "SELECT id, conversation_id FROM messages WHERE id = %s", (source_message_id,)
            )
            if not message or (conversation_id and str(message["conversation_id"]) != conversation_id):
                raise NotFoundError("Message not found.")
        execution = store.create_execution_row(conn, user_id, command, conversation_id, source_message_id)
        store.add_event(
            conn,
            execution["id"],
            user_id,
            "execution_created",
            {"command": command[:500], "conversationId": conversation_id},
        )
        return execution

    execution = await asyncio.to_thread(db.run_in_user_txn, user_id, _create)
    asyncio.create_task(run_execution(user_id, execution["id"]))
    return execution


async def run_agent_direct_test(
    user_id: str,
    agent_identifier: str,
    prompt: str,
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a genuine single-task test against one specialized agent via VozCore."""
    clean_prompt = (prompt or "").strip()
    if len(clean_prompt) < 2:
        raise CommandValidationError("Test instruction must be at least 2 characters.")

    def _prepare(conn):
        if store.is_workspace_paused(conn, user_id):
            raise PermissionDeniedError(
                "All agents are currently paused. Resume agents before running a test."
            )
        detail = store.get_agent_detail_payload(conn, user_id, agent_identifier)
        if not detail:
            raise NotFoundError("Agent not found.")
        agent_meta = detail["agent"]
        if agent_meta["key"] == "vozcore":
            raise CommandValidationError("Use the AI Command Center to test VozCore multi-agent orchestration.")
        if not agent_meta["enabled"]:
            raise PermissionDeniedError(f"{agent_meta['name']} is disabled. Enable it first.")
        if agent_meta["status"] == "paused":
            raise PermissionDeniedError(f"{agent_meta['name']} is paused. Resume it first.")

        execution = store.create_execution_row(
            conn,
            user_id,
            f"[Agent Test · {agent_meta['name']}] {clean_prompt}",
            None,
            None,
        )
        exec_id = execution["id"]
        store.update_execution(
            conn,
            exec_id,
            status="running",
            started_at=_now(),
            plan={
                "summary": f"Direct specialist test for {agent_meta['name']}",
                "parallelizable": False,
                "tasks": [
                    {
                        "task_key": "t1",
                        "title": clean_prompt[:160],
                        "description": clean_prompt,
                        "agent_key": agent_meta["key"],
                        "depends_on": [],
                        "wave": 0,
                        "priority": 1,
                        "approval_required": False,
                        "acceptance": "Complete the requested test instruction.",
                    }
                ],
            },
        )
        task_uuid = store.upsert_task(
            conn,
            user_id,
            exec_id,
            {
                "task_key": "t1",
                "agent_key": agent_meta["key"],
                "agent_id": agent_meta["id"],
                "title": clean_prompt[:160],
                "description": clean_prompt,
                "parameters": parameters or {},
                "wave": 0,
                "priority": 1,
                "max_attempts": 1,
                "timeout_seconds": agent_meta["timeoutSeconds"],
            },
        )
        claimed = store.claim_task_for_run(conn, exec_id, "t1")
        communication.record_agent_message(
            conn,
            user_id=user_id,
            execution_id=exec_id,
            task_id=task_uuid,
            sender_key="vozcore",
            recipient_key=agent_meta["key"],
            message_type="task_assignment",
            payload={"mode": "agent_hub_test", "title": clean_prompt[:160]},
            authorized=True,
        )
        return agent_meta, exec_id, (claimed["id"] if claimed else task_uuid)

    agent_meta, exec_id, task_uuid = await asyncio.to_thread(db.run_in_user_txn, user_id, _prepare)
    specialist = get_specialist(agent_meta["key"])
    if specialist is None:
        raise NotFoundError(f"Specialist '{agent_meta['key']}' is not registered.")

    result = await specialist.run(
        {
            "execution_id": exec_id,
            "task_id": task_uuid,
            "task_key": "t1",
            "user_id": user_id,
            "title": clean_prompt[:160],
            "description": clean_prompt,
            "parameters": parameters or {},
        },
        agent_task_uuid=task_uuid,
        attempt=1,
    )

    def _finish(conn):
        task_status = "waiting" if result.status == "waiting_approval" else result.status
        err_text = (result.error_details or {}).get("message") if result.error_details else None
        store.set_task_status(conn, exec_id, "t1", task_status, error=err_text if task_status == "failed" else None)
        db.execute(
            conn,
            """
            INSERT INTO agent_results
              (execution_id, user_id, agent_task_id, attempt, agent_key, status,
               result_summary, detailed_output, missing_information, errors,
               artifacts, source_references, error_details, model,
               prompt_tokens, completion_tokens, duration_ms, estimated_cost_usd,
               started_at, finished_at)
            VALUES (%s, %s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                exec_id,
                user_id,
                task_uuid,
                result.agent_id,
                result.status,
                result.summary[:4000],
                result.detailed_output[:40000],
                JSON(result.missing_information),
                JSON([err_text] if err_text else []),
                JSON(result.artifacts),
                JSON(result.source_references),
                JSON(result.error_details) if result.error_details else None,
                result.model,
                result.prompt_tokens,
                result.completion_tokens,
                result.duration_ms,
                result.estimated_cost_usd,
                result.start_time,
                result.completion_time,
            ),
        )
        exec_status = "waiting" if task_status == "waiting" else ("completed" if task_status == "completed" else "failed")
        store.update_execution(
            conn,
            exec_id,
            status=exec_status,
            final_response=f"{result.summary}\n\n{result.detailed_output}".strip() if exec_status != "failed" else None,
            error=err_text if exec_status == "failed" else None,
            finished_at=_now() if exec_status in TERMINAL_STATUSES else None,
        )
        return store.get_execution_row(conn, exec_id)

    execution_row = await asyncio.to_thread(db.run_in_user_txn, user_id, _finish)
    return {"execution": execution_row, "result": result.model_dump()}


async def run_execution(user_id: str, execution_id: str) -> None:
    """Drive the LangGraph workflow to a terminal state, persisting everything."""

    def _load(conn):
        return store.get_execution_row(conn, execution_id)

    try:
        execution = await asyncio.to_thread(db.run_in_user_txn, user_id, _load)
    except Exception:
        logger.exception("cannot load execution %s", execution_id)
        return
    if not execution or execution["status"] in TERMINAL_STATUSES:
        return

    state: ExecutionState = {
        "user_id": user_id,
        "execution_id": execution_id,
        "command": execution["command"],
        "conversation_id": execution.get("conversationId"),
        "source_message_id": execution.get("sourceMessageId"),
        "attached_tasks": [],
        "step_seq": 0,
        "attempt_round": 0,
        "cancelled": False,
    }

    try:
        await asyncio.wait_for(
            compiled_graph.ainvoke(state),
            timeout=settings.execution_timeout_seconds,
        )
        await asyncio.to_thread(_finalize_success, user_id, execution_id)
    except asyncio.TimeoutError:
        await asyncio.to_thread(
            _finalize_failure,
            user_id,
            execution_id,
            f"Execution exceeded the {int(settings.execution_timeout_seconds)}s time budget.",
        )
    except ConfigUnavailableError as exc:
        await asyncio.to_thread(_finalize_failure, user_id, execution_id, exc.message, "not_configured")
    except VozCoreError as exc:
        await asyncio.to_thread(_finalize_failure, user_id, execution_id, exc.message)
    except Exception as exc:
        logger.exception("execution %s crashed", execution_id)
        await asyncio.to_thread(
            _finalize_failure,
            user_id,
            execution_id,
            f"VozCore hit an unexpected error: {type(exc).__name__}: {exc}"[:800],
        )


def _finalize_success(user_id: str, execution_id: str) -> None:
    """Compute the terminal status from persisted task truth."""

    def _work():
        with db.user_txn(user_id) as conn:
            execution = store.get_execution_row(conn, execution_id)
            if not execution or execution["status"] in TERMINAL_STATUSES:
                return
            tasks = store.load_tasks(conn, execution_id)

            if execution.get("cancelRequested"):
                status = "cancelled"
            elif execution.get("clarification") and not tasks:
                status = "waiting"
            elif not tasks:
                status = "completed" if execution.get("finalResponse") else "failed"
            elif any(t["status"] in {"failed", "cancelled"} for t in tasks):
                status = "failed"
            elif any(t["status"] == "waiting" for t in tasks):
                status = "waiting"
            else:
                status = "completed"

            store.update_execution(
                conn,
                execution_id,
                status=status,
                finished_at=_now() if status in TERMINAL_STATUSES else None,
            )
            store.add_event(
                conn, execution_id, user_id, "execution_finished", {"status": status, "tasks": len(tasks)}
            )
            first_line = (execution.get("finalResponse") or "").split("\n", 1)[0][:120]
            store.insert_activity(
                conn,
                user_id,
                "vozcore_execution",
                f"VozCore {status}: {first_line}" if first_line else f"VozCore execution {status}",
                f"Command: {execution['command'][:200]}",
            )

    _work()


def _finalize_failure(user_id: str, execution_id: str, message: str, code: str = "failed") -> None:
    def _work():
        with db.user_txn(user_id) as conn:
            execution = store.get_execution_row(conn, execution_id)
            if not execution or execution["status"] in TERMINAL_STATUSES:
                return
            status = "waiting" if code == "not_configured" else "failed"
            store.update_execution(
                conn, execution_id, status=status, error=message[:1000], finished_at=_now()
            )
            store.add_event(
                conn, execution_id, user_id, "execution_failed", {"error": message[:500], "code": code}
            )
            store.insert_activity(
                conn,
                user_id,
                "vozcore_execution_error",
                "VozCore could not run a command",
                message[:300],
            )

    _work()


# ---------------------------------------------------------------------------
# Public helpers used by the API
# ---------------------------------------------------------------------------


async def get_execution_detail(user_id: str, execution_id: str, since_event_id: int = 0) -> dict[str, Any]:
    store.validate_uuid(execution_id, "execution")

    def _load(conn):
        execution = store.get_execution_row(conn, execution_id)
        if not execution:
            return None
        all_events = store.load_events(conn, execution_id, 0)
        new_events = [e for e in all_events if e["id"] > since_event_id]
        messages = db.rows(
            conn,
            """
            SELECT id, task_id, sender_key, recipient_key, message_type, payload, authorized, created_at
              FROM agent_messages
             WHERE execution_id = %s
             ORDER BY created_at ASC
            """,
            (execution_id,),
        )
        return {
            "execution": execution,
            "steps": store.load_steps(conn, execution_id),
            "tasks": store.load_tasks(conn, execution_id),
            "results": store.load_results(conn, execution_id),
            "events": new_events,
            "messages": [
                {
                    "id": str(m["id"]),
                    "taskId": str(m["task_id"]) if m.get("task_id") else None,
                    "senderKey": m["sender_key"],
                    "recipientKey": m["recipient_key"],
                    "messageType": m["message_type"],
                    "payload": m.get("payload") or {},
                    "authorized": bool(m["authorized"]),
                    "createdAt": m["created_at"].isoformat() if m.get("created_at") else None,
                }
                for m in messages
            ],
            "lastEventId": all_events[-1]["id"] if all_events else 0,
        }

    detail = await asyncio.to_thread(db.run_in_user_txn, user_id, _load)
    if not detail:
        raise NotFoundError("Execution not found.")
    return detail


async def list_executions(user_id: str, conversation_id: str | None, limit: int) -> list[dict[str, Any]]:
    def _load(conn):
        return store.list_executions(conn, conversation_id, limit)

    return await asyncio.to_thread(db.run_in_user_txn, user_id, _load)


async def cancel_execution(user_id: str, execution_id: str) -> dict[str, Any]:
    """Idempotent cancel: flag a live run; finalize a parked one immediately."""
    store.validate_uuid(execution_id, "execution")

    def _cancel(conn):
        execution = store.get_execution_row(conn, execution_id)
        if not execution:
            raise NotFoundError("Execution not found.")
        if execution["status"] in TERMINAL_STATUSES:
            return execution

        if execution["status"] == "waiting":
            store.update_execution(conn, execution_id, status="cancelled", cancel_requested=True, finished_at=_now())
            store.add_event(conn, execution_id, user_id, "execution_finished", {"status": "cancelled"})
            return store.get_execution_row(conn, execution_id)

        updated = store.request_cancel_row(conn, execution_id)
        if updated:
            store.add_event(conn, execution_id, user_id, "cancellation_requested", {})
            return updated
        return store.get_execution_row(conn, execution_id)

    return await asyncio.to_thread(db.run_in_user_txn, user_id, _cancel)


def recover_interrupted() -> int:
    """On engine boot: fail executions orphaned by a restart (inspection truth)."""
    if not settings.superuser_database_url:
        return 0
    try:
        with db.admin_conn() as conn:
            stale = db.rows(
                conn,
                """
                SELECT id, user_id FROM executions
                 WHERE status IN ('planning', 'running')
                   AND updated_at < now() - interval '2 minutes'
                """,
            )
            for row in stale:
                db.execute(
                    conn,
                    """
                    UPDATE executions
                       SET status = 'failed',
                           error = 'The VozCore engine restarted while this execution was running.',
                           finished_at = now()
                     WHERE id = %s
                    """,
                    (row["id"],),
                )
                db.execute(
                    conn,
                    """
                    INSERT INTO execution_events (execution_id, user_id, type, payload)
                    VALUES (%s, %s, 'execution_failed',
                            '{"error": "engine_restarted", "code": "interrupted"}'::jsonb)
                    """,
                    (row["id"], row["user_id"]),
                )
            if stale:
                logger.warning("recovered %d interrupted execution(s)", len(stale))
            return len(stale)
    except Exception:
        logger.exception("interrupted-execution recovery failed")
        return 0
