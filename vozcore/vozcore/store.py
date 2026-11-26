"""Persistence layer for VozCore (Phase 2 & Phase 3).

Every function runs inside a short-lived user transaction (RLS enforced)
unless explicitly marked admin. Model calls never hold DB transactions open.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from . import communication, db
from .agents.registry import ALL_AGENTS
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


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def map_execution(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: _iso(v) for k, v in row.items()}
    out["id"] = str(row["id"])
    out["conversationId"] = str(row["conversation_id"]) if row.get("conversation_id") else None
    out["sourceMessageId"] = str(row["source_message_id"]) if row.get("source_message_id") else None
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
# Workspace global pause control
# --------------------------------------------------------------------------


def is_workspace_paused(conn, user_id: str) -> bool:
    row = db.row(conn, "SELECT agents_paused FROM users WHERE id = %s", (user_id,))
    return bool(row and row.get("agents_paused"))


def set_workspace_paused(conn, user_id: str, paused: bool) -> dict[str, Any]:
    db.execute(conn, "UPDATE users SET agents_paused = %s WHERE id = %s", (bool(paused), user_id))
    if paused:
        # Also mark any non-terminal running executions as cancel_requested if desired?
        # Keep non-destructive: pause halts new dispatches & waves cleanly.
        db.execute(
            conn,
            """
            INSERT INTO activity_logs (user_id, type, category, title, detail)
            VALUES (%s, 'agents_paused_all', 'agent', 'Paused all agents', 'Global workspace pause enabled')
            """,
            (user_id,),
        )
    else:
        db.execute(
            conn,
            """
            INSERT INTO activity_logs (user_id, type, category, title, detail)
            VALUES (%s, 'agents_resumed_all', 'agent', 'Resumed all agents', 'Global workspace pause lifted')
            """,
            (user_id,),
        )
    return {"agentsPaused": bool(paused)}


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
        SELECT id, user_id, key, name, icon, status, enabled, description,
               responsibilities, system_instructions, current_task_id,
               timeout_seconds, max_retries, last_active_at, created_at, updated_at
        FROM agents ORDER BY CASE key WHEN 'vozcore' THEN 0 ELSE 1 END, key
        """,
    )
    if rows:
        communication.ensure_agent_metadata_seeded(conn, str(rows[0]["user_id"]), ALL_AGENTS)
    for r in rows:
        r["id"] = str(r["id"])
        r["user_id"] = str(r["user_id"])
        r["current_task_id"] = str(r["current_task_id"]) if r.get("current_task_id") else None
    return rows


def upsert_task(conn, user_id: str, execution_id: str, task: dict[str, Any]) -> str:
    existing = db.row(
        conn,
        "SELECT id, status, attempts FROM agent_tasks WHERE execution_id = %s AND task_key = %s",
        (execution_id, task["task_key"]),
    )
    if existing:
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
        return str(existing["id"])

    idem = f"{execution_id}:{task['task_key']}"
    row = db.row(
        conn,
        """
        INSERT INTO agent_tasks
          (execution_id, user_id, task_key, idempotency_key, agent_key, agent_id,
           title, description, context, input_payload, depends_on, wave, priority,
           approval_required, status, max_attempts, timeout_seconds)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (execution_id, task_key) DO UPDATE SET updated_at = now()
        RETURNING id
        """,
        (
            execution_id,
            user_id,
            task["task_key"],
            idem,
            task["agent_key"],
            task.get("agent_id"),
            task["title"],
            task.get("description", ""),
            JSON(task.get("context", {})),
            JSON(task.get("parameters", {})),
            JSON(task.get("depends_on", [])),
            int(task.get("wave", 0)),
            int(task.get("priority", 5)),
            bool(task.get("approval_required", False)),
            "waiting" if task.get("approval_required") else "pending",
            int(task.get("max_attempts", 2)),
            int(task.get("timeout_seconds", 90)),
        ),
    )
    return str(row["id"])  # type: ignore[index]


def claim_task_for_run(conn, execution_id: str, task_key: str) -> dict[str, Any] | None:
    """Atomically claim a pending task for execution (duplicate-execution guard)."""
    row = db.row(
        conn,
        """
        UPDATE agent_tasks
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               attempts = attempts + 1
         WHERE execution_id = %s AND task_key = %s AND status = 'pending'
         RETURNING id, attempts, agent_key, agent_id
        """,
        (execution_id, task_key),
    )
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "attempts": int(row["attempts"]),
        "agent_key": row["agent_key"],
        "agent_id": str(row["agent_id"]) if row.get("agent_id") else None,
    }


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
    elif status == "completed":
        extras += ", error = NULL"
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
        SELECT id, task_key, agent_key, agent_id, title, description, depends_on, wave,
               priority, approval_required, status, attempts, max_attempts, error,
               input_payload, started_at, finished_at, created_at
        FROM agent_tasks WHERE execution_id = %s
        ORDER BY wave, priority, created_at
        """,
        (execution_id,),
    )
    for r in rows:
        r["id"] = str(r["id"]) if r.get("id") else None
        r["agent_id"] = str(r["agent_id"]) if r.get("agent_id") else None
        for field in ("started_at", "finished_at", "created_at"):
            r[field] = _iso(r.get(field))
    return rows


def load_results(conn, execution_id: str) -> list[dict[str, Any]]:
    rows = db.rows(
        conn,
        """
        SELECT DISTINCT ON (r.agent_task_id)
               r.agent_task_id, t.task_key, r.attempt, r.agent_key, r.status,
               r.result_summary, r.detailed_output, r.missing_information, r.errors,
               r.artifacts, r.source_references, r.error_details,
               r.model, r.prompt_tokens, r.completion_tokens,
               r.duration_ms, r.estimated_cost_usd, r.started_at, r.finished_at
          FROM agent_results r
          JOIN agent_tasks t ON t.id = r.agent_task_id
         WHERE r.execution_id = %s
         ORDER BY r.agent_task_id, r.attempt DESC
        """,
        (execution_id,),
    )
    out = []
    for r in rows:
        agent_task_id = str(r["agent_task_id"])
        started_iso = _iso(r["started_at"])
        finished_iso = _iso(r["finished_at"])
        out.append(
            {
                # Phase 2 camelCase/snake_case fields preserved for CommandCenter / tests
                "agentTaskId": agent_task_id,
                "taskKey": r["task_key"],
                "attempt": r["attempt"],
                "agent_key": r["agent_key"],
                "status": r["status"],
                "result_summary": r["result_summary"],
                "detailed_output": r["detailed_output"],
                "missing_information": r.get("missing_information") or [],
                "errors": r.get("errors") or [],
                "model": r.get("model"),
                "promptTokens": int(r.get("prompt_tokens") or 0),
                "completionTokens": int(r.get("completion_tokens") or 0),
                "durationMs": r.get("duration_ms"),
                "estimatedCostUsd": _float_or_none(r.get("estimated_cost_usd")),
                "startedAt": started_iso,
                "finishedAt": finished_iso,
                # Phase 3 Section 10 structured output fields
                "execution_id": execution_id,
                "task_id": agent_task_id,
                "agent_id": r["agent_key"],
                "summary": r["result_summary"],
                "artifacts": r.get("artifacts") or [],
                "source_references": r.get("source_references") or [],
                "error_details": r.get("error_details"),
                "start_time": started_iso,
                "completion_time": finished_iso,
            }
        )
    return out


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
# Agent Hub, Detail, Telemetry & Monitoring queries (Sections 12 & 13)
# --------------------------------------------------------------------------


def get_agent_detail_payload(conn, user_id: str, agent_identifier: str) -> dict[str, Any] | None:
    """Load comprehensive Phase 3 detail for one agent (by key or UUID)."""
    communication.ensure_agent_metadata_seeded(conn, user_id, ALL_AGENTS)
    is_uuid = False
    try:
        uuid.UUID(agent_identifier)
        is_uuid = True
    except (ValueError, TypeError):
        is_uuid = False

    where = "a.id = %s" if is_uuid else "a.key = %s"
    agent_row = db.row(
        conn,
        f"""
        SELECT a.id, a.key, a.name, a.description, a.icon, a.status, a.enabled,
               a.responsibilities, a.system_instructions, a.current_task_id,
               a.timeout_seconds, a.max_retries, a.last_active_at, a.created_at, a.updated_at,
               ct.title AS current_task_title, ct.execution_id AS current_execution_id
          FROM agents a
          LEFT JOIN agent_tasks ct ON ct.id = a.current_task_id
         WHERE a.user_id = %s AND {where}
        """,
        (user_id, agent_identifier),
    )
    if not agent_row:
        return None

    agent_uuid = str(agent_row["id"])
    agent_key = agent_row["key"]
    specialist = ALL_AGENTS.get(agent_key)
    paused_all = is_workspace_paused(conn, user_id)

    caps = db.rows(
        conn,
        """
        SELECT id, capability_key, name, description, enabled
          FROM agent_capabilities WHERE agent_id = %s ORDER BY created_at ASC
        """,
        (agent_uuid,),
    )
    tools = db.rows(
        conn,
        """
        SELECT t.id, t.tool_key, t.name, t.description, t.category,
               t.requires_approval, t.required_integration, t.enabled, t.config,
               i.status AS integration_status, i.account_email AS integration_email
          FROM agent_tools t
          LEFT JOIN integrations i
            ON i.user_id = t.user_id AND i.provider = t.required_integration
         WHERE t.agent_id = %s
         ORDER BY t.created_at ASC
        """,
        (agent_uuid,),
    )
    perms = db.rows(
        conn,
        """
        SELECT id, permission_key, scope, description, allowed,
               requires_approval, rate_limit_per_hour, max_tasks_per_run
          FROM agent_permissions WHERE agent_id = %s ORDER BY created_at ASC
        """,
        (agent_uuid,),
    )

    task_history = db.rows(
        conn,
        """
        SELECT at.id, at.execution_id, at.task_key, at.title, at.description,
               at.status, at.attempts, at.max_attempts, at.error,
               at.started_at, at.finished_at, at.created_at,
               ar.result_summary, ar.artifacts, ar.source_references,
               ar.error_details, ar.duration_ms, ar.estimated_cost_usd,
               ar.prompt_tokens, ar.completion_tokens, ar.model
          FROM agent_tasks at
          LEFT JOIN LATERAL (
            SELECT * FROM agent_results r
             WHERE r.agent_task_id = at.id
             ORDER BY r.attempt DESC LIMIT 1
          ) ar ON true
         WHERE at.agent_key = %s
         ORDER BY at.created_at DESC LIMIT 30
        """,
        (agent_key,),
    )

    logs = db.rows(
        conn,
        """
        SELECT id, execution_id, agent_task_id, level, event, message,
               metadata, status, duration_ms, retry_attempt, created_at
          FROM agent_execution_logs
         WHERE agent_key = %s
         ORDER BY created_at DESC LIMIT 40
        """,
        (agent_key,),
    )

    msg_rows = db.rows(
        conn,
        """
        SELECT id, execution_id, task_id, sender_key, recipient_key,
               message_type, payload, created_at
          FROM agent_messages
         WHERE sender_key = %s OR recipient_key = %s
         ORDER BY created_at DESC LIMIT 30
        """,
        (agent_key, agent_key),
    )

    stats = db.row(
        conn,
        """
        SELECT
          COUNT(*)::int AS total_tasks,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_tasks,
          COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting_tasks,
          COUNT(*) FILTER (WHERE status = 'running')::int AS running_tasks,
          COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)::int AS total_retries
        FROM agent_tasks
        WHERE agent_key = %s
        """,
        (agent_key,),
    ) or {}

    usage = db.row(
        conn,
        """
        SELECT
          COUNT(*)::int AS usage_calls,
          COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
          AVG(NULLIF(duration_ms, 0)) AS avg_duration_ms,
          SUM(estimated_cost_usd) AS total_cost_usd
        FROM agent_usage
        WHERE agent_key = %s
        """,
        (agent_key,),
    ) or {}

    from .config import settings as _settings

    total_tasks = int(stats.get("total_tasks") or 0)
    completed_tasks = int(stats.get("completed_tasks") or 0)
    operational = bool(agent_row["enabled"]) and agent_row["status"] not in {"paused", "error"} and not paused_all
    formatted_logs = [
        {
            "id": str(lg["id"]),
            "executionId": str(lg["execution_id"]) if lg.get("execution_id") else None,
            "agentTaskId": str(lg["agent_task_id"]) if lg.get("agent_task_id") else None,
            "level": lg["level"],
            "event": lg["event"],
            "action": lg["event"],
            "message": lg["message"],
            "metadata": lg.get("metadata") or {},
            "status": lg.get("status"),
            "durationMs": lg.get("duration_ms"),
            "retryAttempt": int(lg.get("retry_attempt") or 0),
            "createdAt": _iso(lg["created_at"]),
        }
        for lg in logs
    ]
    formatted_msgs = [
        {
            "id": str(m["id"]),
            "executionId": str(m["execution_id"]) if m.get("execution_id") else None,
            "taskId": str(m["task_id"]) if m.get("task_id") else None,
            "senderKey": m["sender_key"],
            "recipientKey": m["recipient_key"],
            "messageType": m["message_type"],
            "subject": (m.get("payload") or {}).get("title")
            or (m.get("payload") or {}).get("summary")
            or m["message_type"],
            "payload": m.get("payload") or {},
            "createdAt": _iso(m["created_at"]),
        }
        for m in msg_rows
    ]

    return {
        "agentsPaused": paused_all,
        "agent": {
            "id": agent_uuid,
            "key": agent_key,
            "name": agent_row["name"],
            "description": agent_row["description"],
            "icon": agent_row["icon"],
            "status": agent_row["status"],
            "enabled": bool(agent_row["enabled"]),
            "operational": operational,
            "agentsPausedAll": paused_all,
            "responsibilities": agent_row.get("responsibilities") or [],
            "defaultInstructions": specialist.system_instructions if specialist else "",
            "customInstructions": agent_row.get("system_instructions") or "",
            "timeoutSeconds": int(agent_row.get("timeout_seconds") or 90),
            "maxRetries": int(agent_row.get("max_retries") or 2),
            "retryBackoffSeconds": float(specialist.retry_policy.backoff_seconds) if specialist else 0.5,
            "currentTask": (
                {
                    "id": str(agent_row["current_task_id"]),
                    "title": agent_row["current_task_title"],
                    "executionId": str(agent_row["current_execution_id"]) if agent_row.get("current_execution_id") else None,
                }
                if agent_row.get("current_task_id") and agent_row.get("current_task_title")
                else None
            ),
            "lastActiveAt": _iso(agent_row.get("last_active_at")),
            "updatedAt": _iso(agent_row.get("updated_at")),
        },
        "capabilities": [
            {
                "id": str(c["id"]),
                "key": c["capability_key"],
                "capabilityKey": c["capability_key"],
                "name": c["name"],
                "label": c["name"],
                "description": c["description"],
                "enabled": bool(c["enabled"]),
            }
            for c in caps
        ],
        "tools": [
            {
                "id": str(t["id"]),
                "key": t["tool_key"],
                "toolKey": t["tool_key"],
                "name": t["name"],
                "label": t["name"],
                "description": t["description"],
                "category": t["category"],
                "requiresApproval": bool(t["requires_approval"]),
                "requiredIntegration": t.get("required_integration"),
                "provider": t.get("required_integration"),
                "integrationConnected": t.get("integration_status") == "connected" if t.get("required_integration") else None,
                "integrationEmail": t.get("integration_email"),
                "enabled": bool(t["enabled"]),
                "config": t.get("config") or {},
            }
            for t in tools
        ],
        "permissions": [
            {
                "id": str(p["id"]),
                "key": p["permission_key"],
                "permissionKey": p["permission_key"],
                "scope": p["scope"],
                "description": p["description"],
                "allowed": bool(p["allowed"]),
                "requiresApproval": bool(p["requires_approval"]),
                "rateLimitPerHour": int(p["rate_limit_per_hour"]),
                "maxTasksPerRun": int(p["max_tasks_per_run"]),
            }
            for p in perms
        ],
        "metrics": {
            "totalTasks": total_tasks,
            "completedTasks": completed_tasks,
            "failedTasks": int(stats.get("failed_tasks") or 0),
            "waitingTasks": int(stats.get("waiting_tasks") or 0),
            "runningTasks": int(stats.get("running_tasks") or 0),
            "totalRetries": int(stats.get("total_retries") or 0),
            "retriedTasks": int(stats.get("total_retries") or 0),
            "successRate": round(100.0 * completed_tasks / total_tasks, 1) if total_tasks > 0 else None,
            "avgDurationMs": int(round(float(usage["avg_duration_ms"]))) if usage.get("avg_duration_ms") is not None else None,
            "promptTokens": int(usage.get("prompt_tokens") or 0),
            "completionTokens": int(usage.get("completion_tokens") or 0),
            "totalTokens": int(usage.get("total_tokens") or 0),
            "usageCalls": int(usage.get("usage_calls") or 0),
            "pricingConfigured": bool(_settings.pricing_configured),
            "estimatedCostUsd": _float_or_none(usage.get("total_cost_usd")),
        },
        "taskHistory": [
            {
                "id": str(th["id"]),
                "executionId": str(th["execution_id"]),
                "taskKey": th["task_key"],
                "title": th["title"],
                "description": th.get("description") or "",
                "status": th["status"],
                "attempts": int(th["attempts"]),
                "maxAttempts": int(th["max_attempts"]),
                "approvalRequired": th["status"] == "waiting",
                "error": th.get("error"),
                "summary": th.get("result_summary") or "",
                "artifacts": th.get("artifacts") or [],
                "sources": th.get("source_references") or [],
                "errorDetails": th.get("error_details"),
                "durationMs": th.get("duration_ms"),
                "estimatedCostUsd": _float_or_none(th.get("estimated_cost_usd")),
                "tokens": int((th.get("prompt_tokens") or 0) + (th.get("completion_tokens") or 0)),
                "model": th.get("model"),
                "startedAt": _iso(th.get("started_at")),
                "finishedAt": _iso(th.get("finished_at")),
                "createdAt": _iso(th.get("created_at")),
            }
            for th in task_history
        ],
        "activityTimeline": formatted_logs,
        "logs": formatted_logs,
        "messages": formatted_msgs,
    }


def get_monitoring_summary(conn, user_id: str, llm_configured: bool, llm_mode: str, llm_model: str | None) -> dict[str, Any]:
    """Workspace-wide Phase 3 agent monitoring & health summary."""
    paused_all = is_workspace_paused(conn, user_id)
    live_execs = db.rows(
        conn,
        """
        SELECT id, command, status, started_at, created_at
          FROM executions
         WHERE status IN ('planning', 'running', 'waiting')
         ORDER BY created_at DESC LIMIT 10
        """,
    )
    totals = db.row(
        conn,
        """
        SELECT
          COUNT(*)::int AS total_agent_tasks,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_tasks,
          COUNT(*) FILTER (WHERE status = 'running')::int AS running_tasks,
          COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)::int AS total_retries
        FROM agent_tasks
        """,
    ) or {}

    usage = db.row(
        conn,
        """
        SELECT
          COUNT(*)::int AS usage_calls,
          COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
          COALESCE(SUM(duration_ms), 0)::bigint AS total_duration_ms,
          AVG(NULLIF(duration_ms, 0)) AS avg_duration_ms,
          SUM(estimated_cost_usd) AS total_cost_usd
        FROM agent_usage
        """,
    ) or {}

    exec_counts = db.row(
        conn,
        """
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'running')::int AS running,
          COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
        FROM executions
        """,
    ) or {}

    # Also include manager model_usage tokens + calls so total workspace token tracking is complete
    mgr_usage = db.row(
        conn,
        """
        SELECT COUNT(*)::int AS calls,
               COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
               COALESCE(SUM(total_tokens), 0)::int AS total_tokens
          FROM model_usage
        """,
    ) or {}
    mgr_tokens = int(mgr_usage.get("total_tokens") or 0)

    from .config import settings as _settings

    agent_rows = load_agents(conn)
    per_agent_counts = {
        r["agent_key"]: r
        for r in db.rows(
            conn,
            """
            SELECT agent_key,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                   COUNT(*) FILTER (WHERE status = 'running')::int AS running
              FROM agent_tasks GROUP BY agent_key
            """,
        )
    }
    integrations = {
        r["provider"]: r["status"] == "connected"
        for r in db.rows(conn, "SELECT provider, status FROM integrations")
    }
    health_checks = []
    agents_summary = []
    for a in agent_rows:
        if a["key"] == "vozcore":
            continue
        spec = ALL_AGENTS.get(a["key"])
        req_integrations = sorted({t.required_integration for t in (spec.available_tools if spec else []) if t.required_integration})
        missing_int = [p for p in req_integrations if not integrations.get(p)]
        enabled = bool(a.get("enabled", True))
        healthy = enabled and a["status"] != "error" and not paused_all
        operational = enabled and a["status"] not in {"paused", "error"} and not paused_all
        ac = per_agent_counts.get(a["key"], {})
        health_checks.append(
            {
                "agentKey": a["key"],
                "name": a["name"],
                "enabled": enabled,
                "status": a["status"],
                "healthy": healthy,
                "llmReady": llm_configured or llm_mode == "test-fake",
                "optionalIntegrationsMissing": missing_int,
                "lastActiveAt": _iso(a.get("last_active_at")),
            }
        )
        agents_summary.append(
            {
                "id": str(a["id"]),
                "key": a["key"],
                "name": a["name"],
                "icon": a["icon"],
                "status": a["status"],
                "enabled": enabled,
                "operational": operational,
                "currentTaskTitle": None,
                "lastActiveAt": _iso(a.get("last_active_at")),
                "completedTasks": int(ac.get("completed") or 0),
                "failedTasks": int(ac.get("failed") or 0),
                "runningTasks": int(ac.get("running") or 0),
            }
        )

    recent_errors = db.rows(
        conn,
        """
        SELECT id, agent_key, event, message, created_at
          FROM agent_execution_logs
         WHERE level IN ('error', 'security')
         ORDER BY created_at DESC LIMIT 15
        """,
    )
    recent_logs = db.rows(
        conn,
        """
        SELECT id, agent_key, level, event, message, status, duration_ms, retry_attempt, created_at
          FROM agent_execution_logs
         ORDER BY created_at DESC LIMIT 25
        """,
    )

    total_agent_tokens = int(usage.get("total_tokens") or 0)
    combined_tokens = total_agent_tokens + mgr_tokens
    avg_dur = int(round(float(usage["avg_duration_ms"]))) if usage.get("avg_duration_ms") is not None else None
    est_cost = _float_or_none(usage.get("total_cost_usd"))

    return {
        "agentsPaused": paused_all,
        "llmConfigured": llm_configured,
        "llmMode": llm_mode,
        "model": llm_model,
        "pricingConfigured": bool(_settings.pricing_configured),
        "llm": {"configured": llm_configured, "mode": llm_mode, "model": llm_model},
        "agents": agents_summary,
        "executions": {
            "total": int(exec_counts.get("total") or 0),
            "running": int(exec_counts.get("running") or 0),
            "waiting": int(exec_counts.get("waiting") or 0),
            "completed": int(exec_counts.get("completed") or 0),
            "failed": int(exec_counts.get("failed") or 0),
            "cancelled": int(exec_counts.get("cancelled") or 0),
        },
        "tasks": {
            "failed": int(totals.get("failed_tasks") or 0),
            "retried": int(totals.get("total_retries") or 0),
            "running": int(totals.get("running_tasks") or 0),
        },
        "usage": {
            "calls": int(usage.get("usage_calls") or 0) + int(mgr_usage.get("calls") or 0),
            "promptTokens": int(usage.get("prompt_tokens") or 0) + int(mgr_usage.get("prompt_tokens") or 0),
            "completionTokens": int(usage.get("completion_tokens") or 0) + int(mgr_usage.get("completion_tokens") or 0),
            "totalTokens": combined_tokens,
            "avgDurationMs": avg_dur,
            "estimatedCostUsd": est_cost,
        },
        "liveExecutions": [
            {
                "id": str(e["id"]),
                "command": e["command"][:200],
                "status": e["status"],
                "startedAt": _iso(e.get("started_at")),
                "createdAt": _iso(e["created_at"]),
            }
            for e in live_execs
        ],
        "totals": {
            "totalAgentTasks": int(totals.get("total_agent_tasks") or 0),
            "completedTasks": int(totals.get("completed_tasks") or 0),
            "failedTasks": int(totals.get("failed_tasks") or 0),
            "runningTasks": int(totals.get("running_tasks") or 0),
            "totalRetries": int(totals.get("total_retries") or 0),
            "agentTokens": total_agent_tokens,
            "workspaceTotalTokens": combined_tokens,
            "totalDurationMs": int(usage.get("total_duration_ms") or 0),
            "avgDurationMs": avg_dur,
            "estimatedCostUsd": est_cost,
        },
        "agentHealth": health_checks,
        "recentErrors": [
            {
                "id": str(er["id"]),
                "agentKey": er["agent_key"],
                "event": er["event"],
                "message": er["message"],
                "createdAt": _iso(er["created_at"]),
            }
            for er in recent_errors
        ],
        "recentLogs": [
            {
                "id": str(lg["id"]),
                "agentKey": lg["agent_key"],
                "level": lg["level"],
                "event": lg["event"],
                "action": lg["event"],
                "message": lg["message"],
                "metadata": {},
                "status": lg.get("status"),
                "durationMs": lg.get("duration_ms"),
                "retryAttempt": int(lg.get("retry_attempt") or 0),
                "createdAt": _iso(lg["created_at"]),
            }
            for lg in recent_logs
        ],
    }


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
    from .agents.memory_agent import compute_text_embedding

    emb = compute_text_embedding(f"{title} {content}")
    db.execute(
        conn,
        """
        INSERT INTO memories (user_id, category, source_execution_id, title, content, tags, embedding_json)
        VALUES (%s, 'project', %s, %s, %s, %s, %s)
        """,
        (user_id, execution_id, title[:160], content[:4000], JSON(tags), JSON(emb)),
    )


def insert_approval(
    conn,
    user_id: str,
    execution_id: str,
    agent_id: str | None,
    title: str,
    description: str,
    agent_task_id: str | None = None,
    action_type: str = "vozcore.subtask",
    action_payload: dict[str, Any] | None = None,
) -> None:
    db.execute(
        conn,
        """
        INSERT INTO approvals
          (user_id, task_id, agent_id, execution_id, agent_task_id, title, description, status, action_type, action_payload)
        VALUES (%s, NULL, %s, %s, %s, %s, %s, 'pending', %s, %s)
        """,
        (
            user_id,
            agent_id,
            execution_id,
            agent_task_id,
            title[:200],
            description[:2000],
            action_type,
            JSON(action_payload or {}),
        ),
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
