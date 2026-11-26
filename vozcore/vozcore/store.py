"""Persistence layer for the VozCore execution lifecycle.

Every function runs inside a short-lived user transaction (RLS enforced)
unless explicitly marked admin. Model calls never hold DB transactions open.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from . import db
from .db import Utf8Json as JSON


# --------------------------------------------------------------------------
# executions
# --------------------------------------------------------------------------

EXECUTION_COLUMNS = """
  id, conversation_id, source_message_id, command, status, intent, plan,
  clarification, final_response, error, cancel_requested, state_checkpoint,
  started_at, finished_at, created_at, updated_at
"""


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def map_execution(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: _iso(v) for k, v in row.items()}
    out["id"] = str(row["id"])
    out["conversationId"] = str(row["conversation_id"]) if row.get("conversation_id") else None
    out["sourceMessageId"] = str(row["source_message_id"]) if row.get("source_message_id") else None
    # camelCase for the API envelope
    return {
        "id": out["id"],
        "conversationId": out["conversationId"],
        "sourceMessageId": out["sourceMessageId"],
        "command": row["command"],
        "status": row["status"],
        "intent": row.get("intent"),
        "plan": row.get("plan"),
        "clarification": row.get("clarification"),
        "finalResponse": row.get("final_response"),
        "error": row.get("error"),
        "cancelRequested": bool(row.get("cancel_requested")),
        "startedAt": out.get("started_at"),
        "finishedAt": out.get("finished_at"),
        "createdAt": out.get("created_at"),
        "updatedAt": out.get("updated_at"),
    }


def create_execution_row(
    conn,
    user_id: str,
    command: str,
    conversation_id: str | None,
    source_message_id: str | None,
) -> dict[str, Any]:
    row = db.row(
        conn,
        f"""
        INSERT INTO executions (user_id, conversation_id, source_message_id, command, status)
        VALUES (%s, %s, %s, %s, 'planning')
        RETURNING {EXECUTION_COLUMNS}
        """,
        (user_id, conversation_id, source_message_id, command),
    )
    return map_execution(row)  # type: ignore[arg-type]


def get_execution_row(conn, execution_id: str) -> dict[str, Any] | None:
    row = db.row(conn, f"SELECT {EXECUTION_COLUMNS} FROM executions WHERE id = %s", (execution_id,))
    return map_execution(row) if row else None


def update_execution(conn, execution_id: str, **fields: Any) -> None:
    if not fields:
        return
    mapping = {
        "status": "status",
        "intent": "intent",
        "plan": "plan",
        "clarification": "clarification",
        "final_response": "final_response",
        "error": "error",
        "cancel_requested": "cancel_requested",
        "state_checkpoint": "state_checkpoint",
        "started_at": "started_at",
        "finished_at": "finished_at",
    }
    sets, params = [], []
    for key, value in fields.items():
        column = mapping.get(key, key)
        if key in {"intent", "plan", "state_checkpoint"} and value is not None:
            sets.append(f"{column} = %s")
            params.append(JSON(value))
        else:
            sets.append(f"{column} = %s")
            params.append(value)
    params.append(execution_id)
    db.execute(conn, f"UPDATE executions SET {', '.join(sets)} WHERE id = %s", params)


def request_cancel_row(conn, execution_id: str) -> dict[str, Any] | None:
    row = db.row(
        conn,
        f"""
        UPDATE executions SET cancel_requested = true
        WHERE id = %s AND status IN ('planning', 'running', 'waiting')
        RETURNING {EXECUTION_COLUMNS}
        """,
        (execution_id,),
    )
    return map_execution(row) if row else None


# --------------------------------------------------------------------------
# steps + events
# --------------------------------------------------------------------------


def upsert_step(
    conn,
    user_id: str,
    execution_id: str,
    step_key: str,
    seq: int,
    status: str,
    output: Any = None,
    error: str | None = None,
    finish: bool = False,
) -> None:
    existing = db.row(
        conn,
        "SELECT id FROM execution_steps WHERE execution_id = %s AND step_key = %s AND seq = %s",
        (execution_id, step_key, seq),
    )
    if existing:
        db.execute(
            conn,
            """
            UPDATE execution_steps
               SET status = %s, output = COALESCE(%s, output), error = %s,
                   finished_at = CASE WHEN %s THEN now() ELSE finished_at END
             WHERE id = %s
            """,
            (status, JSON(output) if output is not None else None, error, finish, existing["id"]),
        )
    else:
        db.execute(
            conn,
            """
            INSERT INTO execution_steps
              (execution_id, user_id, step_key, seq, status, output, error, finished_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() ELSE NULL END)
            """,
            (
                execution_id,
                user_id,
                step_key,
                seq,
                status,
                JSON(output) if output is not None else None,
                error,
                finish,
            ),
        )


def add_event(conn, execution_id: str, user_id: str, event_type: str, payload: Any = None) -> int:
    row = db.row(
        conn,
        """
        INSERT INTO execution_events (execution_id, user_id, type, payload)
        VALUES (%s, %s, %s, %s) RETURNING id
        """,
        (execution_id, user_id, event_type, JSON(payload or {})),
    )
    return int(row["id"])  # type: ignore[index]


# --------------------------------------------------------------------------
# agents + tasks + results
# --------------------------------------------------------------------------


def load_agents(conn) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT id, key, name, status, description, responsibilities, last_active_at
        FROM agents ORDER BY CASE key WHEN 'vozcore' THEN 0 ELSE 1 END, key
        """,
    )
    for r in rows:
        r["id"] = str(r["id"])
    return rows


def upsert_task(conn, user_id: str, execution_id: str, task: dict[str, Any]) -> None:
    existing = db.row(
        conn,
        "SELECT id, status, attempts FROM agent_tasks WHERE execution_id = %s AND task_key = %s",
        (execution_id, task["task_key"]),
    )
    if existing:
        # Retry path: reset a failed/cancelled task back to pending, keep history.
        if task.get("_reset") and existing["status"] in {"failed", "cancelled"}:
            db.execute(
                conn,
                """
                UPDATE agent_tasks
                   SET status = 'pending', error = NULL, agent_key = %s, agent_id = %s,
                       finished_at = NULL, started_at = NULL
                 WHERE id = %s
                """,
                (task["agent_key"], task.get("agent_id"), existing["id"]),
            )
        return
    db.execute(
        conn,
        """
        INSERT INTO agent_tasks
          (execution_id, user_id, task_key, agent_key, agent_id, title, description,
           context, depends_on, wave, priority, approval_required, status, max_attempts)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            execution_id,
            user_id,
            task["task_key"],
            task["agent_key"],
            task.get("agent_id"),
            task["title"],
            task.get("description", ""),
            JSON(task.get("context", {})),
            JSON(task.get("depends_on", [])),
            int(task.get("wave", 0)),
            int(task.get("priority", 5)),
            bool(task.get("approval_required", False)),
            "waiting" if task.get("approval_required") else "pending",
            int(task.get("max_attempts", 2)),
        ),
    )


def set_task_status(
    conn,
    execution_id: str,
    task_key: str,
    status: str,
    error: str | None = None,
    agent_key: str | None = None,
    agent_id: str | None = None,
) -> None:
    extras = ""
    params: list[Any] = [status]
    if status == "running":
        extras += ", started_at = COALESCE(started_at, now()), attempts = attempts + 1"
    if status in {"completed", "failed", "cancelled"}:
        extras += ", finished_at = now()"
    if error is not None:
        extras += ", error = %s"
        params.append(error)
    if agent_key is not None:
        extras += ", agent_key = %s"
        params.append(agent_key)
    if agent_id is not None:
        extras += ", agent_id = %s"
        params.append(agent_id)
    params += [execution_id, task_key]
    db.execute(
        conn,
        f"UPDATE agent_tasks SET status = %s{extras} WHERE execution_id = %s AND task_key = %s",
        params,
    )


def load_tasks(conn, execution_id: str) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT task_key, agent_key, agent_id, title, description, depends_on, wave,
               priority, approval_required, status, attempts, max_attempts, error,
               started_at, finished_at, created_at
        FROM agent_tasks WHERE execution_id = %s
        ORDER BY wave, priority, created_at
        """,
        (execution_id,),
    )
    for r in rows:
        r["id"] = str(r["id"]) if "id" in r else None
        r["agent_id"] = str(r["agent_id"]) if r.get("agent_id") else None
        for field in ("started_at", "finished_at", "created_at"):
            r[field] = _iso(r.get(field))
    return rows


def insert_result(conn, user_id: str, execution_id: str, task: dict[str, Any], output: Any, attempt: int) -> None:
    db.execute(
        conn,
        """
        INSERT INTO agent_results
          (execution_id, user_id, agent_task_id, attempt, agent_key, status,
           result_summary, detailed_output, missing_information, errors, model)
        SELECT %s, %s, id, %s, %s, %s, %s, %s, %s, %s, %s
          FROM agent_tasks WHERE execution_id = %s AND task_key = %s
        """,
        (
            execution_id,
            user_id,
            attempt,
            task["agent_key"],
            output.get("status", "completed"),
            output.get("result_summary", ""),
            output.get("detailed_output", ""),
            JSON(output.get("missing_information", [])),
            JSON(output.get("errors", [])),
            output.get("model"),
            execution_id,
            task["task_key"],
        ),
    )


def load_results(conn, execution_id: str) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT DISTINCT ON (r.agent_task_id)
               r.agent_task_id, t.task_key, r.attempt, r.agent_key, r.status,
               r.result_summary, r.detailed_output, r.missing_information, r.errors,
               r.model, r.started_at, r.finished_at
          FROM agent_results r
          JOIN agent_tasks t ON t.id = r.agent_task_id
         WHERE r.execution_id = %s
         ORDER BY r.agent_task_id, r.attempt DESC
        """,
        (execution_id,),
    )
    for r in rows:
        r["agentTaskId"] = str(r.pop("agent_task_id"))
        r["taskKey"] = r.pop("task_key")
        r["startedAt"] = _iso(r.pop("started_at"))
        r["finishedAt"] = _iso(r.pop("finished_at"))
    return rows


# --------------------------------------------------------------------------
# events / steps reads (API)
# --------------------------------------------------------------------------


def load_events(conn, execution_id: str, since_id: int = 0) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT id, type, payload, created_at FROM execution_events
         WHERE execution_id = %s AND id > %s ORDER BY id
        """,
        (execution_id, since_id),
    )
    return [
        {"id": r["id"], "type": r["type"], "payload": r["payload"], "createdAt": _iso(r["created_at"])}
        for r in rows
    ]


def load_steps(conn, execution_id: str) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT step_key, seq, status, output, error, started_at, finished_at
          FROM execution_steps WHERE execution_id = %s ORDER BY seq
        """,
        (execution_id,),
    )
    return [
        {
            "stepKey": r["step_key"],
            "seq": r["seq"],
            "status": r["status"],
            "output": r["output"],
            "error": r["error"],
            "startedAt": _iso(r["started_at"]),
            "finishedAt": _iso(r["finished_at"]),
        }
        for r in rows
    ]


def list_executions(conn, conversation_id: str | None, limit: int) -> list[dict[str, Any]]:
    if conversation_id:
        rows = db.rows(
            conn,
            f"""
            SELECT {EXECUTION_COLUMNS} FROM executions
             WHERE conversation_id = %s ORDER BY created_at DESC LIMIT %s
            """,
            (conversation_id, limit),
        )
    else:
        rows = db.rows(
            conn,
            f"SELECT {EXECUTION_COLUMNS} FROM executions ORDER BY created_at DESC LIMIT %s",
            (limit,),
        )
    return [map_execution(r) for r in rows]


# --------------------------------------------------------------------------
# messages / memories / approvals / activity
# --------------------------------------------------------------------------


def insert_assistant_message(conn, user_id: str, conversation_id: str, execution_id: str, content: str) -> None:
    db.execute(
        conn,
        """
        INSERT INTO messages (conversation_id, user_id, role, content, execution_id)
        VALUES (%s, %s, 'assistant', %s, %s)
        """,
        (conversation_id, user_id, content, execution_id),
    )
    db.execute(
        conn,
        "UPDATE conversations SET updated_at = now() WHERE id = %s AND user_id = %s",
        (conversation_id, user_id),
    )


def search_memories(conn, command: str, limit: int = 5) -> list[dict[str, Any]]:
    terms = [t for t in "".join(ch.lower() if ch.isalnum() else " " for ch in command).split() if len(t) > 3]
    terms = terms[:8]
    if not terms:
        rows = db.rows(
            conn,
            "SELECT title, content, category FROM memories ORDER BY updated_at DESC LIMIT %s",
            (limit,),
        )
        return rows
    conditions = " OR ".join(["title ILIKE %s OR content ILIKE %s"] * len(terms))
    params: list[Any] = []
    for term in terms:
        params += [f"%{term}%", f"%{term}%"]
    params.append(limit)
    return db.rows(
        conn,
        f"""
        SELECT title, content, category FROM memories
         WHERE {conditions}
         ORDER BY updated_at DESC LIMIT %s
        """,
        params,
    )


def insert_memory(conn, user_id: str, title: str, content: str, tags: list[str], execution_id: str) -> None:
    db.execute(
        conn,
        """
        INSERT INTO memories (user_id, category, title, content, tags)
        VALUES (%s, 'project', %s, %s, %s)
        """,
        (user_id, title[:160], content[:4000], JSON(tags)),
    )


def insert_approval(conn, user_id: str, execution_id: str, agent_id: str | None, title: str, description: str) -> None:
    db.execute(
        conn,
        """
        INSERT INTO approvals (user_id, task_id, agent_id, title, description, status)
        VALUES (%s, NULL, %s, %s, %s, 'pending')
        """,
        (user_id, agent_id, title[:200], description[:2000]),
    )


def insert_activity(conn, user_id: str, event_type: str, title: str, detail: str) -> None:
    db.execute(
        conn,
        """
        INSERT INTO activity_logs (user_id, type, category, title, detail)
        VALUES (%s, %s, 'conversation', %s, %s)
        """,
        (user_id, event_type, title[:200], detail[:500]),
    )


def load_attached_tasks(conn, message_id: str | None) -> list[dict[str, Any]]:
    if not message_id:
        return []
    row = db.row(conn, "SELECT attachments FROM messages WHERE id = %s", (message_id,))
    attachments = (row or {}).get("attachments") or []
    return [
        {"taskId": a.get("taskId"), "title": a.get("title", ""), "status": a.get("status", "")}
        for a in attachments
        if isinstance(a, dict)
    ]


def touch_agent_last_active(conn, user_id: str, agent_keys: list[str]) -> None:
    if not agent_keys:
        return
    db.execute(
        conn,
        "UPDATE agents SET last_active_at = now() WHERE user_id = %s AND key = ANY(%s)",
        (user_id, agent_keys),
    )


def validate_uuid(value: str, label: str = "id") -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        from .errors import NotFoundError

        raise NotFoundError(f"Unknown {label}.")
