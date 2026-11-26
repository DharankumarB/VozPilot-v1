"""Structured-output contracts for every VozCore model call.

All OpenAI calls in the engine use these Pydantic schemas (structured
outputs), so downstream orchestration never parses free text.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class IntentAnalysis(BaseModel):
    """A — Intent Understanding Engine."""

    objective: str = Field(description="The single primary outcome the user wants")
    outcome: str = Field(description="What 'done' looks like, in one sentence")
    constraints: list[str] = Field(default_factory=list, description="Hard constraints the user stated")
    deadlines: list[str] = Field(default_factory=list, description="Mentions of dates/timing/deadlines")
    key_details: list[str] = Field(default_factory=list, description="Relevant details present in the command")
    missing_information: list[str] = Field(
        default_factory=list,
        description="Information that is absent but not strictly blocking",
    )
    needs_clarification: bool = Field(
        default=False,
        description="True only when proceeding without more information would likely produce the wrong result",
    )
    clarification_question: str | None = Field(
        default=None, description="A single, specific question to ask when needs_clarification is true"
    )
    single_agent: bool = Field(default=True, description="True when one specialist can handle this alone")
    suggested_agents: list[str] = Field(
        default_factory=list, description="Candidate agent keys from the provided catalogue"
    )
    complexity: Literal["simple", "moderate", "complex"] = "moderate"


class PlanTask(BaseModel):
    """One subtask inside an execution plan."""

    task_key: str = Field(description="Stable key, t1, t2, … unique within the plan")
    title: str
    description: str = Field(description="Self-contained instructions for the assigned agent")
    agent_key: str = Field(description="Agent key from the provided catalogue")
    depends_on: list[str] = Field(default_factory=list, description="task_keys that must finish first")
    priority: int = Field(default=5, ge=1, le=9, description="1 = highest")
    approval_required: bool = Field(
        default=False,
        description="True for subtasks that would take a sensitive external action",
    )
    acceptance: str = Field(default="", description="How completeness of this subtask is judged")


class ExecutionPlan(BaseModel):
    """B — Intelligent Task Planner."""

    summary: str = Field(description="One-sentence plan overview for the user")
    tasks: list[PlanTask]
    parallelizable: bool = Field(
        default=False, description="True when at least two tasks have no dependencies"
    )


class AgentOutput(BaseModel):
    """Structured result returned by every specialist agent."""

    completed: bool = Field(description="True only if the subtask was genuinely fulfilled")
    result_summary: str = Field(description="2-3 sentence summary for the manager")
    detailed_output: str = Field(description="Full work product for this subtask")
    missing_information: list[str] = Field(
        default_factory=list, description="Inputs that were required but unavailable"
    )


class EvaluationResult(BaseModel):
    """E — Result Evaluator."""

    verdict: Literal["completed", "partial", "failed"]
    all_tasks_successful: bool
    completeness_score: int = Field(ge=0, le=100)
    missing_information: list[str] = Field(default_factory=list)
    failed_task_keys: list[str] = Field(default_factory=list)
    retry_task_keys: list[str] = Field(
        default_factory=list, description="Failed tasks worth one more attempt"
    )
    needs_retry: bool = False
    evaluation_notes: str = ""


class FinalResponse(BaseModel):
    """F — Final Response Generator."""

    headline: str = Field(description="Short status line for the reply")
    report: str = Field(
        description="Consolidated final report: deduplicated agent outputs, clear status, next steps"
    )
    open_items: list[str] = Field(default_factory=list, description="Unresolved items the user must know about")
