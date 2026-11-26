"""Registry of all eight instantiated VozPilot Phase 3 specialized agents."""

from __future__ import annotations

from .base import BaseAgent
from .content_agent import ContentAgent
from .developer_agent import DeveloperAgent
from .finance_agent import FinanceAgent
from .inbox_agent import InboxAgent
from .memory_agent import MemoryAgent
from .project_agent import ProjectAgent
from .research_agent import ResearchAgent
from .schedule_agent import ScheduleAgent

ORDERED_AGENTS: list[BaseAgent] = [
    ResearchAgent(),
    InboxAgent(),
    ProjectAgent(),
    ContentAgent(),
    FinanceAgent(),
    ScheduleAgent(),
    DeveloperAgent(),
    MemoryAgent(),
]

ALL_AGENTS: dict[str, BaseAgent] = {agent.agent_id: agent for agent in ORDERED_AGENTS}


def get_specialist(agent_key: str) -> BaseAgent | None:
    return ALL_AGENTS.get(agent_key)
