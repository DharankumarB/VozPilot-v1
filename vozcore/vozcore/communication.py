"""Centralized, traceable agent communication & seeding helpers via VozCore.

All task assignments, shared context packets, tool invocations, approval
requests, retries, cancellations and result reports flow through this module
and are recorded in `agent_messages` and `agent_execution_logs` under RLS.
"""

from __future__ import annotations

from typing import Any

from . import db
from .db import Utf8Json as JSON


def record_agent_message(
    conn,
    *,
    user_id: str,
    execution_id: str,
    task_id: str | None,
    sender_key: str,
    recipient_key: str,
    message_type: str,
    payload: dict[str, Any],
    authorized: bool = True,
) -> str:
    row = db.row(
        conn,
        """
        INSERT INTO agent_messages
          (user_id, execution_id, task_id, sender_key, recipient_key, message_type, payload, authorized)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            user_id,
            execution_id,
            task_id,
            sender_key,
            recipient_key,
            message_type,
            JSON(payload or {}),
            bool(authorized),
        ),
    )
    return str(row["id"])  # type: ignore[index]


def record_execution_log(
    conn,
    *,
    user_id: str,
    execution_id: str | None,
    agent_task_id: str | None,
    agent_id: str | None,
    agent_key: str,
    level: str,
    event: str,
    message: str,
    metadata: dict[str, Any] | None = None,
    status: str | None = None,
    duration_ms: int | None = None,
    retry_attempt: int = 0,
) -> None:
    db.execute(
        conn,
        """
        INSERT INTO agent_execution_logs
          (user_id, execution_id, agent_task_id, agent_id, agent_key, level,
           event, message, metadata, status, duration_ms, retry_attempt)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            user_id,
            execution_id,
            agent_task_id,
            agent_id,
            agent_key,
            level,
            event,
            (message or "")[:1000],
            JSON(metadata or {}),
            status,
            duration_ms,
            int(retry_attempt),
        ),
    )


def record_agent_usage(
    conn,
    *,
    user_id: str,
    execution_id: str | None,
    agent_task_id: str | None,
    agent_id: str | None,
    agent_key: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    duration_ms: int,
    estimated_cost_usd: float | None,
) -> None:
    db.execute(
        conn,
        """
        INSERT INTO agent_usage
          (user_id, execution_id, agent_task_id, agent_id, agent_key, model,
           prompt_tokens, completion_tokens, total_tokens, duration_ms, estimated_cost_usd)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            user_id,
            execution_id,
            agent_task_id,
            agent_id,
            agent_key,
            model,
            int(prompt_tokens),
            int(completion_tokens),
            int(prompt_tokens) + int(completion_tokens),
            int(duration_ms),
            estimated_cost_usd,
        ),
    )


def ensure_agent_metadata_seeded(conn, user_id: str, agents_map: dict[str, Any]) -> None:
    """Idempotently seed capabilities, tools & permissions rows for all 8 agents."""
    rows = db.rows(conn, "SELECT id, key FROM agents WHERE user_id = %s", (user_id,))
    for row in rows:
        agent_key = row["key"]
        agent_obj = agents_map.get(agent_key)
        if not agent_obj:
            continue
        agent_uuid = str(row["id"])

        for cap in agent_obj.capabilities:
            db.execute(
                conn,
                """
                INSERT INTO agent_capabilities
                  (user_id, agent_id, agent_key, capability_key, name, description, enabled)
                VALUES (%s, %s, %s, %s, %s, %s, true)
                ON CONFLICT (agent_id, capability_key) DO NOTHING
                """,
                (user_id, agent_uuid, agent_key, cap.capability_key, cap.name, cap.description),
            )

        for tool in agent_obj.available_tools:
            db.execute(
                conn,
                """
                INSERT INTO agent_tools
                  (user_id, agent_id, agent_key, tool_key, name, description, category,
                   requires_approval, required_integration, enabled)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, true)
                ON CONFLICT (agent_id, tool_key) DO NOTHING
                """,
                (
                    user_id,
                    agent_uuid,
                    agent_key,
                    tool.tool_key,
                    tool.name,
                    tool.description,
                    tool.category,
                    tool.requires_approval,
                    tool.required_integration,
                ),
            )

        for perm in agent_obj.permission_requirements:
            db.execute(
                conn,
                """
                INSERT INTO agent_permissions
                  (user_id, agent_id, agent_key, permission_key, scope, description,
                   allowed, requires_approval, rate_limit_per_hour, max_tasks_per_run)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (agent_id, permission_key) DO NOTHING
                """,
                (
                    user_id,
                    agent_uuid,
                    agent_key,
                    perm.permission_key,
                    perm.scope,
                    perm.description,
                    perm.default_allowed,
                    perm.requires_approval,
                    perm.rate_limit_per_hour,
                    perm.max_tasks_per_run,
                ),
            )
