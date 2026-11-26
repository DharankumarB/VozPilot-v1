"""Agent 6 — Schedule Agent (Google Calendar OAuth 2.0 + timezone-aware scheduling).

Capabilities:
- Read authorized Google Calendar events via OAuth 2.0 (`read_calendar_events`).
- Find available time slots & detect meeting conflicts (`analyze_conflicts_and_slots`).
- Suggest daily schedules & track workspace deadlines.
- Create workspace reminders (`create_reminder`).
- Require confirmation/approval before creating, modifying, or cancelling
  external Google Calendar events (`propose_calendar_change`).
- Respect user time zones (`zoneinfo.ZoneInfo`).
"""

from __future__ import annotations

import asyncio
import re
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from .. import db, external_providers
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)


class ProposedEventAction(BaseModel):
    action: str = "create"  # create | modify | cancel
    event_id: str | None = None
    title: str = ""
    start_iso: str = ""
    end_iso: str = ""
    description: str = ""


class ProposedReminder(BaseModel):
    title: str
    due_date: str | None = None  # YYYY-MM-DD
    notes: str = ""


class ScheduleLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    suggested_blocks: list[str] = Field(default_factory=list)
    reminders_to_create: list[ProposedReminder] = Field(default_factory=list)
    external_calendar_actions: list[ProposedEventAction] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)


def _safe_tz(tz_name: str | None) -> tuple[ZoneInfo, str]:
    candidate = (tz_name or "UTC").strip()
    try:
        return ZoneInfo(candidate), candidate
    except (ZoneInfoNotFoundError, KeyError, ValueError):
        return ZoneInfo("UTC"), "UTC"


def _parse_iso_dt(raw: str | None, default_tz: ZoneInfo) -> datetime | None:
    if not raw:
        return None
    val = raw.strip()
    if val.endswith("Z"):
        val = val[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(val)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=default_tz)
        return dt.astimezone(default_tz)
    except ValueError:
        return None


class ScheduleAgent(BaseAgent):
    agent_id = "schedule"
    name = "Schedule Agent"
    description = (
        "Connects to Google Calendar via OAuth 2.0, detects conflicts, finds open "
        "slots in the user's timezone, tracks deadlines, creates reminders, and gates "
        "external calendar changes behind confirmation."
    )
    icon = "calendar-clock"
    selection_hints = [
        "schedule",
        "calendar",
        "meeting",
        "slot",
        "availability",
        "available time",
        "conflict",
        "reminder",
        "agenda",
        "week",
        "daily schedule",
        "timezone",
    ]
    capabilities = [
        CapabilitySpec("calendar_read", "Read Google Calendar", "Read authorized Google Calendar events via OAuth 2.0."),
        CapabilitySpec("slot_and_conflict_engine", "Slot finder & conflict detection", "Compute open focus blocks and overlapping meetings in user's timezone."),
        CapabilitySpec("daily_schedule_suggestions", "Daily schedule planning", "Propose realistic time-boxed daily agendas."),
        CapabilitySpec("reminders_and_deadlines", "Reminders & deadline tracking", "Track upcoming deadlines and create workspace reminders."),
        CapabilitySpec("confirmed_calendar_mutations", "Confirmed calendar changes", "Require explicit human approval before creating, modifying, or cancelling external events."),
    ]
    system_instructions = (
        "You are the Schedule Agent in the VozPilot autonomous workforce. "
        "Plan schedules, surface meeting conflicts, find open time slots, track deadlines, "
        "and propose calendar events in the user's configured time zone.\n"
        "- Respect `USER_TIMEZONE` for all times and slot recommendations.\n"
        "- Never claim an external Google Calendar event has already been created, modified, "
        "or cancelled — external mutations require explicit confirmation in the Approval Center.\n"
        "- When Google Calendar OAuth is not connected, clearly label schedules as proposals "
        "built from workspace deadlines and stated constraints."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned scheduling subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("calendar.read", "oauth:google_calendar", "Read authorized Google Calendar events.", default_allowed=True),
        PermissionSpec("reminders.write", "workspace", "Create reminder items and track deadlines in workspace.", default_allowed=True),
        PermissionSpec("calendar.write", "oauth:google_calendar", "Create, modify, or cancel external Google Calendar events (requires confirmation).", default_allowed=True, requires_approval=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="read_calendar_events",
                name="Read Calendar & Deadlines",
                description="Fetch authorized Google Calendar events and upcoming workspace task deadlines.",
                handler=self._tool_read_calendar,
                category="oauth_read",
                required_integration="google_calendar",
            ),
            ToolSpec(
                tool_key="analyze_conflicts_and_slots",
                name="Detect Conflicts & Available Slots",
                description="Compute overlapping calendar events and open 60-minute slots in the user's timezone.",
                handler=self._tool_analyze_slots,
                category="domain",
            ),
            ToolSpec(
                tool_key="create_reminder",
                name="Create Reminder",
                description="Create a reminder task with due date in the workspace.",
                handler=self._tool_create_reminder,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="propose_calendar_change",
                name="Modify Google Calendar (Confirmation Gate)",
                description="Propose creating, modifying, or cancelling a Google Calendar event (requires confirmation).",
                handler=self._tool_propose_calendar_change,
                category="oauth_write",
                requires_approval=True,
                required_integration="google_calendar",
            ),
        ]

    async def _tool_read_calendar(self, ctx: AgentExecutionContext, days_ahead: int = 7) -> dict[str, Any]:
        ctx.check_permission("calendar.read")
        tz, tz_name = _safe_tz(ctx.input.timezone)
        now_local = datetime.now(tz)
        end_local = now_local + timedelta(days=max(1, min(days_ahead, 30)))

        cal = await external_providers.calendar_list_events(
            ctx.user_id,
            time_min_iso=now_local.astimezone(timezone.utc).isoformat(),
            time_max_iso=end_local.astimezone(timezone.utc).isoformat(),
            timezone_name=tz_name,
        )

        def _deadlines(conn):
            rows = db.rows(
                conn,
                """
                SELECT id, title, status, priority, due_date
                  FROM tasks
                 WHERE status <> 'completed' AND due_date IS NOT NULL
                 ORDER BY due_date ASC LIMIT 20
                """,
            )
            return [
                {
                    "id": str(r["id"]),
                    "title": r["title"],
                    "status": r["status"],
                    "priority": r["priority"],
                    "dueDate": str(r["due_date"]),
                }
                for r in rows
            ]

        deadlines = await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _deadlines)
        return {
            "timezone": tz_name,
            "calendarConnected": bool(cal.get("connected")),
            "accountEmail": cal.get("accountEmail"),
            "events": cal.get("events") or [],
            "deadlines": deadlines,
            "message": cal.get("message"),
            "error": cal.get("error"),
        }

    async def _tool_analyze_slots(self, ctx: AgentExecutionContext, events: list[dict[str, Any]]) -> dict[str, Any]:
        tz, tz_name = _safe_tz(ctx.input.timezone)
        intervals: list[tuple[datetime, datetime, str]] = []
        for ev in events:
            s = _parse_iso_dt(ev.get("start"), tz)
            e = _parse_iso_dt(ev.get("end"), tz)
            if s and e and e > s:
                intervals.append((s, e, ev.get("summary") or "Event"))
        intervals.sort(key=lambda x: x[0])

        conflicts: list[dict[str, Any]] = []
        for i in range(len(intervals)):
            for j in range(i + 1, len(intervals)):
                if intervals[j][0] < intervals[i][1]:
                    conflicts.append(
                        {
                            "eventA": intervals[i][2],
                            "eventB": intervals[j][2],
                            "overlapStart": intervals[j][0].isoformat(),
                            "overlapEnd": min(intervals[i][1], intervals[j][1]).isoformat(),
                        }
                    )
                else:
                    break

        # Compute up to 6 available 60-min slots over the next 3 business days (09:00–17:00 local)
        now_local = datetime.now(tz)
        available_slots: list[dict[str, str]] = []
        for day_offset in range(0, 5):
            if len(available_slots) >= 6:
                break
            day_date = (now_local + timedelta(days=day_offset)).date()
            if day_date.weekday() >= 5:
                continue
            day_start = datetime.combine(day_date, dtime(9, 0), tzinfo=tz)
            day_end = datetime.combine(day_date, dtime(17, 0), tzinfo=tz)
            cursor = max(day_start, now_local.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
            for s, e, _ in intervals:
                if e <= cursor or s >= day_end:
                    continue
                if s - cursor >= timedelta(minutes=60):
                    available_slots.append({"start": cursor.isoformat(), "end": s.isoformat(), "timezone": tz_name})
                    if len(available_slots) >= 6:
                        break
                cursor = max(cursor, e)
            if len(available_slots) < 6 and day_end - cursor >= timedelta(minutes=60):
                available_slots.append({"start": cursor.isoformat(), "end": day_end.isoformat(), "timezone": tz_name})

        return {"timezone": tz_name, "conflicts": conflicts, "availableSlots": available_slots}

    async def _tool_create_reminder(
        self,
        ctx: AgentExecutionContext,
        title: str,
        due_date: str | None = None,
        notes: str = "",
    ) -> dict[str, Any]:
        ctx.check_permission("reminders.write")
        valid_due = None
        if due_date and re.match(r"^\d{4}-\d{2}-\d{2}$", due_date.strip()):
            try:
                date.fromisoformat(due_date.strip())
                valid_due = due_date.strip()
            except ValueError:
                valid_due = None

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO tasks (user_id, agent_id, title, description, status, priority, due_date)
                VALUES (%s, %s, %s, %s, 'pending', 'medium', %s)
                RETURNING id, title, due_date
                """,
                (ctx.user_id, ctx.agent_row_id, f"Reminder: {title.strip()}"[:200], notes[:1500], valid_due),
            )
            return {
                "id": str(row["id"]),  # type: ignore[index]
                "title": row["title"],  # type: ignore[index]
                "dueDate": str(row["due_date"]) if row and row.get("due_date") else None,
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_propose_calendar_change(
        self,
        ctx: AgentExecutionContext,
        action: str,
        title: str,
        start_iso: str,
        end_iso: str,
        description: str = "",
        event_id: str | None = None,
    ) -> dict[str, Any]:
        ctx.check_permission("calendar.write")
        return {"executed": False, "action": action, "title": title}

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        cal_data = await ctx.invoke_tool("read_calendar_events", days_ahead=7)
        slot_analysis = await ctx.invoke_tool("analyze_conflicts_and_slots", events=cal_data["events"])

        if cal_data["calendarConnected"]:
            ctx.add_source(
                title=f"Google Calendar ({cal_data.get('accountEmail') or 'connected'})",
                source_type="google_calendar",
                verified=True,
                snippet=f"{len(cal_data['events'])} events inspected in {cal_data['timezone']}",
            )
        ctx.add_source(
            title="Workspace Task Deadlines",
            source_type="database",
            verified=True,
            snippet=f"{len(cal_data['deadlines'])} upcoming task deadlines",
        )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + f"USER_TIMEZONE: {cal_data['timezone']}\n"
            + f"GOOGLE_CALENDAR_CONNECTED: {cal_data['calendarConnected']}\n"
            + (f"CALENDAR_NOTE: {cal_data.get('message') or cal_data.get('error')}\n" if (cal_data.get("message") or cal_data.get("error")) else "")
            + f"AUTHORIZED_EVENTS: {cal_data['events']}\n"
            + f"DETECTED_CONFLICTS: {slot_analysis['conflicts']}\n"
            + f"AVAILABLE_SLOTS: {slot_analysis['availableSlots']}\n"
            + f"WORKSPACE_DEADLINES: {cal_data['deadlines']}\n\n"
            "Produce the schedule output respecting USER_TIMEZONE."
        )

        parsed: ScheduleLLMOutput = await ctx.call_llm_structured(schema=ScheduleLLMOutput, prompt=prompt)

        created_reminders = []
        if parsed.reminders_to_create and ctx.tool_states.get("create_reminder", {}).get("enabled", True):
            for r in parsed.reminders_to_create[:5]:
                rem = await ctx.invoke_tool("create_reminder", title=r.title, due_date=r.due_date, notes=r.notes)
                created_reminders.append(rem)

        await_approval = False
        text_lower = f"{ctx.input.title} {ctx.input.description}".lower()
        wants_mutation = bool(
            ctx.input.parameters.get("mutate_calendar")
            or re.search(r"\b(book|create|add|modify|reschedule|cancel)\s+(a\s+|the\s+)?(calendar\s+event|meeting|invite)\b", text_lower)
        )
        if (wants_mutation or parsed.external_calendar_actions) and parsed.external_calendar_actions:
            for act in parsed.external_calendar_actions[:3]:
                gate = await ctx.invoke_tool(
                    "propose_calendar_change",
                    action=act.action,
                    title=act.title,
                    start_iso=act.start_iso,
                    end_iso=act.end_iso,
                    description=act.description,
                    event_id=act.event_id,
                )
                if isinstance(gate, dict) and gate.get("approvalRequired"):
                    await_approval = True
                    ctx.add_artifact("approval_gate", f"Calendar {act.action} held for confirmation", gate)

        ctx.add_artifact(
            "schedule_analysis",
            f"Schedule & Conflict Analysis ({cal_data['timezone']})",
            {
                "timezone": cal_data["timezone"],
                "calendarConnected": cal_data["calendarConnected"],
                "conflicts": slot_analysis["conflicts"],
                "availableSlots": slot_analysis["availableSlots"],
                "deadlines": cal_data["deadlines"],
                "suggestedBlocks": parsed.suggested_blocks,
                "remindersCreated": created_reminders,
            },
        )

        return {
            "status": "completed" if parsed.completed else "failed",
            "await_approval": await_approval,
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
