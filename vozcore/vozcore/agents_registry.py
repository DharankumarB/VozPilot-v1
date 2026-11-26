"""Agent capability registry + VozCore manager prompts.

Backed directly by the eight modular Phase 3 specialist agents in
`vozcore.agents.registry`, so planning, selection, context packing and
evaluation always reflect each agent's real capabilities, tools and prompts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .agents.registry import ALL_AGENTS


@dataclass(frozen=True)
class AgentSpec:
    key: str
    name: str
    role: str
    capabilities: list[str] = field(default_factory=list)
    selection_hints: list[str] = field(default_factory=list)
    system_prompt: str = ""


AGENTS: dict[str, AgentSpec] = {
    key: AgentSpec(
        key=agent.agent_id,
        name=agent.name,
        role=agent.description,
        capabilities=[c.name for c in agent.capabilities],
        selection_hints=list(agent.selection_hints),
        system_prompt=agent.system_instructions,
    )
    for key, agent in ALL_AGENTS.items()
}

COORDINATOR_KEY = "vozcore"
COORDINATOR_NAME = "VozCore"

# ---------------------------------------------------------------------
# Manager prompts (VozCore's own reasoning)
# ---------------------------------------------------------------------

INTENT_SYSTEM = (
    "You are VozCore, the central AI manager of the VozPilot workforce. "
    "Analyse the user's command with precision. Extract the objective, outcome, "
    "constraints and deadlines. Decide whether one or multiple specialist agents "
    "are needed, and whether a clarification question is genuinely necessary — "
    "ask one only when essential information is missing and proceeding would "
    "likely produce the wrong result. Suggest agent keys ONLY from the catalogue "
    "you are given."
)

PLAN_SYSTEM = (
    "You are VozCore, the central AI manager of the VozPilot workforce. "
    "Turn the command + intent into a bounded execution plan of at most {max_tasks} "
    "subtasks. Assign each subtask to exactly one agent key from the catalogue "
    "(never vozcore — VozCore coordinates, it does not perform specialised work). "
    "Make subtasks self-contained: the assigned agent will see ONLY your "
    "description, the intent constraints and short dependency summaries. "
    "Declare depends_on for genuine ordering; leave independent tasks without "
    "dependencies so they run in parallel. Set approval_required=true for any "
    "subtask that would take a sensitive external action (sending email, "
    "modifying external calendars or repositories, publishing externally). Use task keys t1..tN."
)

EVALUATE_SYSTEM = (
    "You are VozCore's result evaluator. Compare the requested outcome against "
    "the agent results. Be strict: a task that produced nothing, or whose output "
    "ignores the acceptance criteria, is not successful. Set needs_retry=true "
    "only when a retry could realistically succeed (e.g. transient or fixable "
    "gaps) — never to loop indefinitely. List missing information honestly."
)

FINALIZE_SYSTEM = (
    "You are VozCore, the central AI manager of the VozPilot workforce. "
    "Write the consolidated final report for the user from the evaluation and "
    "agent results. Merge duplicates across agents, keep each unique finding "
    "once, state clearly which subtasks completed / failed / await approval, "
    "and list open items. Plain text with short sections — no marketing tone, "
    "no invented work."
)


def agent_catalogue(agents: list[dict]) -> str:
    """Render the user's available agents for a manager prompt."""
    lines = []
    for agent in agents:
        spec = AGENTS.get(agent["key"])
        caps = ", ".join(agent.get("capabilities") or (spec.capabilities if spec else []))
        role = agent.get("role") or (spec.role if spec else agent.get("description", ""))
        lines.append(f"- {agent['key']} ({agent['name']}): {role} Capabilities: {caps}")
    return "\n".join(lines)


def specialist_prompt(spec: AgentSpec, task: dict, context_block: str) -> str:
    """Minimal necessary context for one agent subtask."""
    parts = [
        spec.system_prompt,
        "",
        f"TASK {task['task_key']}: {task['title']}",
        task.get("description", ""),
    ]
    if task.get("acceptance"):
        parts += ["", f"Acceptance criteria: {task['acceptance']}"]
    if context_block:
        parts += ["", "CONTEXT (only what is relevant to this task):", context_block]
    parts += [
        "",
        "Return the structured result. Set completed=true ONLY if you genuinely "
        "fulfilled the task with the information available.",
    ]
    return "\n".join(parts)
