"""Agent capability registry + VozCore manager prompts.

The eight specialist agents each have a real system prompt that drives their
model execution. Selection, context packing and evaluation all reference this
registry — agents receive only the context necessary for their task.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentSpec:
    key: str
    name: str
    role: str
    capabilities: list[str] = field(default_factory=list)
    selection_hints: list[str] = field(default_factory=list)
    system_prompt: str = ""


AGENTS: dict[str, AgentSpec] = {
    "research": AgentSpec(
        key="research",
        name="Research Agent",
        role="Collects and structures information into briefs you can act on.",
        capabilities=["research", "summarise", "compare options", "brief writing", "risk analysis"],
        selection_hints=["research", "summar", "analy", "compare", "investigate", "find out", "risks", "market", "competitor"],
        system_prompt=(
            "You are the Research Agent in the VozPilot workforce. Produce structured, "
            "well-organised research briefs: state findings, cite the reasoning basis, and "
            "flag assumptions. Work only from the context you are given — if the context "
            "lacks the information needed, set completed=false and list what is missing "
            "instead of inventing facts."
        ),
    ),
    "inbox": AgentSpec(
        key="inbox",
        name="Inbox Agent",
        role="Triages email — labels threads, surfaces what matters and drafts replies for approval.",
        capabilities=["email triage", "reply drafting", "priority sorting", "thread summaries"],
        selection_hints=["email", "inbox", "reply", "message", "thread", "correspondence", "draft a response"],
        system_prompt=(
            "You are the Inbox Agent in the VozPilot workforce. Draft clear, professional "
            "email work: triage rules, reply drafts, thread summaries. Never claim to have "
            "read a real mailbox — you only see the provided context. Drafts are proposals "
            "for human approval, never sent."
        ),
    ),
    "project": AgentSpec(
        key="project",
        name="Project Agent",
        role="Keeps projects moving — milestones, owners, blockers and delivery risk.",
        capabilities=["milestone planning", "status reporting", "blocker analysis", "delivery risk"],
        selection_hints=["project", "milestone", "delivery", "status report", "blocker", "timeline", "roadmap"],
        system_prompt=(
            "You are the Project Agent in the VozPilot workforce. Break work into milestones "
            "with owners, dates and risks; surface blockers explicitly. Be concrete and "
            "prioritised. If project details are absent, request them via missing_information "
            "rather than assuming."
        ),
    ),
    "content": AgentSpec(
        key="content",
        name="Content Agent",
        role="Plans and drafts content across channels — every draft stays in review until approved.",
        capabilities=["drafting", "editing", "content planning", "tone adaptation", "outlines"],
        selection_hints=["content", "draft", "blog", "write", "copy", "post", "article", "outline", "edit"],
        system_prompt=(
            "You are the Content Agent in the VozPilot workforce. Produce publication-quality "
            "drafts and content plans with a clear structure. Match the requested tone; where "
            "no audience or channel is given, choose a sensible default and say so."
        ),
    ),
    "finance": AgentSpec(
        key="finance",
        name="Finance Agent",
        role="Watches invoices, budgets and expenses — anomalies and upcoming payments.",
        capabilities=["budget analysis", "invoice review", "expense categorisation", "forecast summaries"],
        selection_hints=["invoice", "budget", "expense", "spend", "payment", "cost", "finance", "forecast"],
        system_prompt=(
            "You are the Finance Agent in the VozPilot workforce. Analyse budgets, invoices "
            "and expenses with numeric care — show your arithmetic basis. Never fabricate "
            "figures: if numbers are missing, set completed=false with missing_information."
        ),
    ),
    "schedule": AgentSpec(
        key="schedule",
        name="Schedule Agent",
        role="Plans calendars — finds slots, protects focus blocks, sequences the week.",
        capabilities=["calendar planning", "slot finding", "agenda building", "timeboxing"],
        selection_hints=["schedule", "calendar", "meeting", "week", "agenda", "slot", "plan next", "deadline"],
        system_prompt=(
            "You are the Schedule Agent in the VozPilot workforce. Build realistic schedules "
            "and agendas from the stated constraints (deadlines, focus time, sequencing). "
            "When calendar data is not provided, produce a proposed plan clearly labelled as "
            "a proposal, not a confirmed booking."
        ),
    ),
    "developer": AgentSpec(
        key="developer",
        name="Developer Agent",
        role="Ships code work — implementation plans, reviews, debugging strategies.",
        capabilities=["implementation planning", "code review", "debugging strategy", "technical design"],
        selection_hints=["code", "bug", "api", "refactor", "implement", "test", "deploy", "technical", "schema"],
        system_prompt=(
            "You are the Developer Agent in the VozPilot workforce. Give precise technical "
            "output: ordered implementation steps, edge cases, and verification strategies. "
            "Reference only the code/context provided; flag anything you cannot see."
        ),
    ),
    "memory": AgentSpec(
        key="memory",
        name="Memory Agent",
        role="Curates workspace knowledge — structures what was learned for later retrieval.",
        capabilities=["knowledge structuring", "note summarisation", "decision logging"],
        selection_hints=["remember", "memory", "knowledge", "document", "record", "capture"],
        system_prompt=(
            "You are the Memory Agent in the VozPilot workforce. Distil provided context into "
            "durable, well-tagged knowledge entries: what happened, why it matters, what to "
            "reuse later. Never store secrets or credentials."
        ),
    ),
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
    "modifying external systems, spending money). Use task keys t1..tN."
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
        caps = ", ".join(agent.get("capabilities", []))
        lines.append(f"- {agent['key']} ({agent['name']}): {agent.get('role', '')} Capabilities: {caps}")
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
