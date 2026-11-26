"""Agent 3 — Project Agent (integrated with PostgreSQL `projects`, `tasks`, `workflows`).

Capabilities:
- Create projects (`create_project`).
- Create subtasks with agent assignment, priority, and deadlines (`create_subtasks`).
- Track project milestones (`update_milestones`).
- Identify delayed/overdue tasks (`inspect_delayed_tasks`).
- Coordinate dependent workflows (`inspect_workflows`).
- Generate database-backed project progress reports (`generate_progress_report`).
"""

from __future__ import annotations

import asyncio
import re
from datetime import date
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

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
VALID_PRIORITIES = {"low", "medium", "high", "critical"}


class ProposedSubtask(BaseModel):
    title: str
    description: str = ""
    assigned_agent_key: str | None = None
    priority: str = "medium"
    due_date: str | None = None  # YYYY-MM-DD


class ProposedMilestone(BaseModel):
    title: str
    due_date: str | None = None
    status: str = "pending"  # pending | in_progress | completed | delayed
    owner: str = ""


class ProjectLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    create_new_project: bool = False
    project_name: str = ""
    project_description: str = ""
    project_priority: str = "medium"
    project_due_date: str | None = None
    milestones: list[ProposedMilestone] = Field(default_factory=list)
    subtasks_to_create: list[ProposedSubtask] = Field(default_factory=list)
    delayed_task_findings: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)


def _clean_date(raw: str | None) -> str | None:
    if raw and DATE_RE.match(raw.strip()):
        try:
            date.fromisoformat(raw.strip())
            return raw.strip()
        except ValueError:
            return None
    return None


def _clean_priority(raw: str | None) -> str:
    val = (raw or "medium").strip().lower()
    return val if val in VALID_PRIORITIES else "medium"


class ProjectAgent(BaseAgent):
    agent_id = "project"
    name = "Project Agent"
    description = (
        "Creates projects and subtasks in the workspace Task Manager, assigns agents, "
        "tracks milestones, surfaces delayed work, and generates progress reports."
    )
    icon = "folder-kanban"
    selection_hints = [
        "project",
        "milestone",
        "subtask",
        "delivery",
        "status report",
        "progress report",
        "blocker",
        "delayed",
        "overdue",
        "timeline",
        "roadmap",
        "workflow",
    ]
    capabilities = [
        CapabilitySpec("project_creation", "Create projects", "Create structured projects with priorities, deadlines and milestones."),
        CapabilitySpec("subtask_management", "Create & assign subtasks", "Create Task Manager subtasks assigned to specialist agents with deadlines."),
        CapabilitySpec("milestone_tracking", "Milestone tracking", "Track milestone states across active workstreams."),
        CapabilitySpec("delay_detection", "Delayed task detection", "Identify overdue and stalled tasks from live workspace records."),
        CapabilitySpec("progress_reporting", "Progress & workflow coordination", "Generate real completion reports and coordinate dependent workflows."),
    ]
    system_instructions = (
        "You are the Project Agent in the VozPilot autonomous workforce. "
        "Coordinate projects, milestones, subtasks, agent assignments, and progress reports "
        "grounded in the live workspace state.\n"
        "- Only set `create_new_project=true` or populate `subtasks_to_create` when the task "
        "actually asks to create/plan a project or break work into tracked tasks.\n"
        "- When reporting status or delayed tasks, use the exact counts and task titles from "
        "`WORKSPACE PROJECT & TASK SNAPSHOT` — never invent completed tasks or fake percentages.\n"
        "- Use ISO dates (`YYYY-MM-DD`) for deadlines."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned project management subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("projects.read", "workspace", "Read workspace projects, tasks and workflows.", default_allowed=True),
        PermissionSpec("projects.write", "workspace", "Create projects, milestones and assigned subtasks.", default_allowed=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="inspect_delayed_tasks",
                name="Inspect Workspace & Delayed Tasks",
                description="Query projects, task counts, overdue tasks and dependent workflows.",
                handler=self._tool_inspect_workspace,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="create_project",
                name="Create Project",
                description="Insert a project record with milestones and deadline into PostgreSQL.",
                handler=self._tool_create_project,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="create_subtasks",
                name="Create Assigned Subtasks",
                description="Create subtasks in the Task Manager linked to a project and specialist agents.",
                handler=self._tool_create_subtasks,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="generate_progress_report",
                name="Generate Progress Metrics",
                description="Compute real completion rates, overdue items and workload distribution.",
                handler=self._tool_progress_report,
                category="workspace_read",
            ),
        ]

    async def _tool_inspect_workspace(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        ctx.check_permission("projects.read")

        def _query(conn):
            projects = db.rows(
                conn,
                "SELECT id, name, status, priority, due_date, milestones FROM projects ORDER BY created_at DESC LIMIT 15",
            )
            delayed = db.rows(
                conn,
                """
                SELECT t.id, t.title, t.status, t.priority, t.due_date, a.name AS agent_name
                  FROM tasks t
                  LEFT JOIN agents a ON a.id = t.agent_id
                 WHERE t.status NOT IN ('completed')
                   AND t.due_date IS NOT NULL
                   AND t.due_date < CURRENT_DATE
                 ORDER BY t.due_date ASC LIMIT 25
                """,
            )
            open_tasks = db.rows(
                conn,
                """
                SELECT t.id, t.title, t.status, t.priority, t.due_date, a.key AS agent_key
                  FROM tasks t
                  LEFT JOIN agents a ON a.id = t.agent_id
                 WHERE t.status IN ('pending', 'in_progress', 'waiting_approval')
                 ORDER BY t.created_at DESC LIMIT 20
                """,
            )
            workflows = db.rows(
                conn,
                "SELECT id, name, status FROM workflows ORDER BY created_at DESC LIMIT 10",
            )
            return {
                "projects": [
                    {
                        "id": str(p["id"]),
                        "name": p["name"],
                        "status": p["status"],
                        "priority": p["priority"],
                        "dueDate": str(p["due_date"]) if p.get("due_date") else None,
                        "milestones": p.get("milestones") or [],
                    }
                    for p in projects
                ],
                "delayedTasks": [
                    {
                        "id": str(d["id"]),
                        "title": d["title"],
                        "status": d["status"],
                        "priority": d["priority"],
                        "dueDate": str(d["due_date"]),
                        "agentName": d.get("agent_name"),
                    }
                    for d in delayed
                ],
                "openTasks": [
                    {
                        "id": str(t["id"]),
                        "title": t["title"],
                        "status": t["status"],
                        "priority": t["priority"],
                        "dueDate": str(t["due_date"]) if t.get("due_date") else None,
                        "agentKey": t.get("agent_key"),
                    }
                    for t in open_tasks
                ],
                "workflows": [{"id": str(w["id"]), "name": w["name"], "status": w["status"]} for w in workflows],
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _query)

    async def _tool_create_project(
        self,
        ctx: AgentExecutionContext,
        name: str,
        description: str = "",
        priority: str = "medium",
        due_date: str | None = None,
        milestones: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        ctx.check_permission("projects.write")
        clean_due = _clean_date(due_date)
        clean_prio = _clean_priority(priority)

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO projects (user_id, name, description, status, priority, due_date, milestones)
                VALUES (%s, %s, %s, 'active', %s, %s, %s)
                RETURNING id, name, status, priority, due_date, milestones
                """,
                (
                    ctx.user_id,
                    name.strip()[:200],
                    description.strip()[:2000],
                    clean_prio,
                    clean_due,
                    JSON(milestones or []),
                ),
            )
            db.execute(
                conn,
                """
                INSERT INTO activity_logs (user_id, agent_id, type, category, title, detail)
                VALUES (%s, %s, 'project_created', 'task', %s, %s)
                """,
                (ctx.user_id, ctx.agent_row_id, f"Project created: {name.strip()[:160]}", f"Priority: {clean_prio}"),
            )
            return {
                "id": str(row["id"]),  # type: ignore[index]
                "name": row["name"],  # type: ignore[index]
                "status": row["status"],  # type: ignore[index]
                "priority": row["priority"],  # type: ignore[index]
                "dueDate": str(row["due_date"]) if row and row.get("due_date") else None,
                "milestones": (row or {}).get("milestones") or [],
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_create_subtasks(
        self,
        ctx: AgentExecutionContext,
        project_id: str | None,
        subtasks: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        ctx.check_permission("projects.write")

        def _insert(conn):
            agents_by_key = {
                r["key"]: str(r["id"])
                for r in db.rows(conn, "SELECT id, key FROM agents WHERE user_id = %s", (ctx.user_id,))
            }
            created = []
            for item in subtasks[:12]:
                title = (item.get("title") or "").strip()[:200]
                if not title:
                    continue
                agent_key = (item.get("assigned_agent_key") or "").strip().lower()
                agent_uuid = agents_by_key.get(agent_key) if agent_key and agent_key != "vozcore" else None
                prio = _clean_priority(item.get("priority"))
                due = _clean_date(item.get("due_date"))
                row = db.row(
                    conn,
                    """
                    INSERT INTO tasks (user_id, project_id, agent_id, title, description, status, priority, due_date)
                    VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s)
                    RETURNING id, title, priority, due_date
                    """,
                    (
                        ctx.user_id,
                        project_id,
                        agent_uuid,
                        title,
                        (item.get("description") or "")[:2000],
                        prio,
                        due,
                    ),
                )
                created.append(
                    {
                        "id": str(row["id"]),  # type: ignore[index]
                        "title": row["title"],  # type: ignore[index]
                        "assignedAgentKey": agent_key if agent_uuid else None,
                        "priority": row["priority"],  # type: ignore[index]
                        "dueDate": str(row["due_date"]) if row and row.get("due_date") else None,
                    }
                )
            return created

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_progress_report(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        ctx.check_permission("projects.read")

        def _stats(conn):
            counts = db.rows(
                conn,
                "SELECT status, COUNT(*)::int AS cnt FROM tasks WHERE user_id = %s GROUP BY status",
                (ctx.user_id,),
            )
            by_status = {r["status"]: int(r["cnt"]) for r in counts}
            total = sum(by_status.values())
            completed = by_status.get("completed", 0)
            overdue = int(
                db.scalar(
                    conn,
                    "SELECT COUNT(*) FROM tasks WHERE user_id = %s AND status <> 'completed' AND due_date < CURRENT_DATE",
                    (ctx.user_id,),
                )
                or 0
            )
            return {
                "totalTasks": total,
                "completedTasks": completed,
                "completionPercent": round(100.0 * completed / total, 1) if total > 0 else 0.0,
                "byStatus": by_status,
                "overdueTasks": overdue,
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _stats)

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        snapshot = await ctx.invoke_tool("inspect_delayed_tasks")
        metrics = await ctx.invoke_tool("generate_progress_report")

        ctx.add_source(
            title="Workspace Projects & Task Manager",
            source_type="database",
            verified=True,
            snippet=f"{len(snapshot['projects'])} projects, {metrics['totalTasks']} tasks ({metrics['overdueTasks']} overdue)",
        )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + f"WORKSPACE PROJECT & TASK SNAPSHOT:\n"
            + f"- Metrics: {metrics}\n"
            + f"- Delayed / Overdue Tasks: {snapshot['delayedTasks']}\n"
            + f"- Existing Projects: {snapshot['projects']}\n"
            + f"- Open Tasks: {snapshot['openTasks'][:10]}\n"
            + f"- Dependent Workflows: {snapshot['workflows']}\n\n"
            "Produce the structured project output."
        )

        parsed: ProjectLLMOutput = await ctx.call_llm_structured(schema=ProjectLLMOutput, prompt=prompt)

        project_record: dict[str, Any] | None = None
        if parsed.create_new_project and parsed.project_name.strip():
            if ctx.tool_states.get("create_project", {}).get("enabled", True):
                project_record = await ctx.invoke_tool(
                    "create_project",
                    name=parsed.project_name,
                    description=parsed.project_description,
                    priority=parsed.project_priority,
                    due_date=parsed.project_due_date,
                    milestones=[m.model_dump() for m in parsed.milestones],
                )
                ctx.add_artifact("project", f"Project: {project_record['name']}", project_record, record_id=project_record["id"])

        if parsed.subtasks_to_create and ctx.tool_states.get("create_subtasks", {}).get("enabled", True):
            created_subtasks = await ctx.invoke_tool(
                "create_subtasks",
                project_id=project_record["id"] if project_record else ctx.input.parameters.get("project_id"),
                subtasks=[s.model_dump() for s in parsed.subtasks_to_create],
            )
            if created_subtasks:
                ctx.add_artifact("subtasks", f"Created {len(created_subtasks)} subtask(s)", {"tasks": created_subtasks})

        # Refresh progress report after any mutations
        final_metrics = await ctx.invoke_tool("generate_progress_report")
        ctx.add_artifact(
            "project_progress_report",
            "Workspace project progress & delayed task report",
            {
                "metrics": final_metrics,
                "delayedTasks": snapshot["delayedTasks"],
                "workflows": snapshot["workflows"],
            },
        )

        return {
            "status": "completed" if parsed.completed else "failed",
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
