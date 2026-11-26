"""Pure plan-validation helpers (no I/O) — unit-testable in isolation."""

from __future__ import annotations

from typing import Any

from .config import settings

VALID_AGENT_STATUSES = {"active", "idle"}  # paused/error agents are never selected


def validate_and_normalize_plan(
    plan: dict[str, Any],
    available_keys: list[str],
    fallback_key: str,
    max_tasks: int | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Enforce structural invariants on a model-produced plan.

    Returns (normalized_plan, warnings). Never trusts the model for:
    unique keys, dependency integrity, wave ordering, agent availability,
    or task count limits.
    """
    max_tasks = max_tasks or settings.max_tasks_per_execution
    warnings: list[str] = []
    raw_tasks = plan.get("tasks") or []
    if not raw_tasks:
        raise ValueError("Plan contains no tasks")

    available = set(available_keys)
    seen: set[str] = set()
    tasks: list[dict[str, Any]] = []

    for index, raw in enumerate(raw_tasks[:max_tasks], start=1):
        key = str(raw.get("task_key") or f"t{index}")
        if key in seen:
            key = f"t{index}"
            if key in seen:
                warnings.append(f"duplicate task key renamed to {key}")
        seen.add(key)

        agent_key = str(raw.get("agent_key") or "")
        if agent_key not in available:
            remapped = fallback_key if fallback_key in available else (next(iter(available), "research"))
            warnings.append(f"agent '{agent_key}' unavailable → '{remapped}'")
            agent_key = remapped

        depends_on = [d for d in (raw.get("depends_on") or []) if d in seen or d in {t["task_key"] for t in tasks}]
        # forward references are invalid — only keep backward references
        depends_on = [d for d in depends_on if d != key]

        tasks.append(
            {
                "task_key": key,
                "title": str(raw.get("title") or "Subtask")[:300],
                "description": str(raw.get("description") or "")[:4000],
                "agent_key": agent_key,
                "depends_on": depends_on,
                "priority": min(9, max(1, int(raw.get("priority") or 5))),
                "approval_required": bool(raw.get("approval_required", False)),
                "acceptance": str(raw.get("acceptance") or "")[:1000],
            }
        )

    if len(raw_tasks) > max_tasks:
        warnings.append(f"plan truncated to {max_tasks} tasks")

    tasks = compute_waves(tasks, warnings)
    normalized = {
        "summary": str(plan.get("summary") or "")[:500],
        "tasks": tasks,
        "parallelizable": any(t["wave"] == 0 for t in tasks) and len(tasks) > 1,
    }
    return normalized, warnings


def compute_waves(tasks: list[dict[str, Any]], warnings: list[str] | None = None) -> list[dict[str, Any]]:
    """Topological wave assignment — independent tasks share a wave (parallel)."""
    warnings = warnings if warnings is not None else []
    by_key = {t["task_key"]: t for t in tasks}
    remaining = {t["task_key"]: set(t.get("depends_on", [])) & set(by_key) for t in tasks}
    placed: set[str] = set()
    wave = 0
    assignment: dict[str, int] = {}

    while remaining:
        ready = sorted(k for k, deps in remaining.items() if deps <= placed)
        if not ready:
            # dependency cycle from the model — break it deterministically
            broken = sorted(remaining)
            warnings.append(f"dependency cycle broken at {', '.join(broken)}")
            for k in broken:
                assignment[k] = wave
                placed.add(k)
            break
        for k in ready:
            assignment[k] = wave
            placed.add(k)
            del remaining[k]
        wave += 1

    for t in tasks:
        t["wave"] = assignment.get(t["task_key"], 0)
        # strip dependencies that were never placed as predecessors
        t["depends_on"] = [d for d in t.get("depends_on", []) if d in by_key and assignment.get(d, 99) < t["wave"]]
    return tasks


def build_execution_waves(tasks: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group tasks by wave for the executor."""
    waves: dict[int, list[dict[str, Any]]] = {}
    for task in tasks:
        waves.setdefault(int(task.get("wave", 0)), []).append(task)
    return [waves[k] for k in sorted(waves)]
