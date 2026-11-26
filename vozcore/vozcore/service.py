"""Execution lifecycle: start, run (LangGraph), finalize, cancel, recover."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from . import db, store
from .config import settings
from .errors import ConfigUnavailableError, NotFoundError, VozCoreError
from .graph.build import compiled_graph
from .graph.state import ExecutionState

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
        # Configuration state the user must resolve — `waiting` + clear error,
        # never a fabricated result.
        await asyncio.to_thread(_finalize_failure, user_id, execution_id, exc.message, "not_configured")
    except VozCoreError as exc:
        await asyncio.to_thread(_finalize_failure, user_id, execution_id, exc.message)
    except Exception as exc:  # unexpected — recorded honestly, never faked
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

            store.update_execution(conn, execution_id, status=status, finished_at=_now())
            store.add_event(
                conn, execution_id, user_id, "execution_finished", {"status": status, "tasks": len(tasks)}
            )
            first_line = (execution.get("final_response") or "").split("\n", 1)[0][:120]
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
        return {
            "execution": execution,
            "steps": store.load_steps(conn, execution_id),
            "tasks": store.load_tasks(conn, execution_id),
            "results": store.load_results(conn, execution_id),
            "events": new_events,
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
            # Nothing is running (clarification / approval wait) — finalize now.
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
