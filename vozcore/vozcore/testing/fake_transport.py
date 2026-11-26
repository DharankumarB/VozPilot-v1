"""Test-only fake transport for VozCore.

Two consumers, both explicitly opt-in:

1. pytest sets an in-process handler via `llm.set_test_handler` — full control
   per scenario, no environment flags involved.
2. `VOZCORE_TEST_FAKE_LLM=1` (refused when NODE_ENV=production, reported by
   /health as `mode: test-fake`) installs the deterministic handler below for
   development demos. Output is clearly marked as test transport.

Production never sets either — real OpenAI or a clear configuration error.
"""

from __future__ import annotations

from typing import Any

from ..schemas import (
    AgentOutput,
    EvaluationResult,
    ExecutionPlan,
    FinalResponse,
    IntentAnalysis,
    PlanTask,
)


def fake_structured(purpose: str, schema: type, prompt: str) -> Any:
    if purpose == "intent":
        return IntentAnalysis(
            objective="Test-transport analysis of the command",
            outcome="Produce the requested analysis from provided context",
            constraints=[],
            deadlines=[],
            key_details=[],
            missing_information=[],
            needs_clarification=False,
            clarification_question=None,
            single_agent=False,
            suggested_agents=["research", "content", "project"],
            complexity="moderate",
        )
    if purpose == "plan":
        return ExecutionPlan(
            summary="[test transport] Two-step plan across specialist agents",
            parallelizable=True,
            tasks=[
                PlanTask(
                    task_key="t1",
                    title="Structure the request",
                    description="Break the command into concrete points to address.",
                    agent_key="research",
                    depends_on=[],
                    priority=2,
                    acceptance="A structured outline exists.",
                ),
                PlanTask(
                    task_key="t2",
                    title="Draft the deliverable",
                    description="Produce the requested output from the structured points.",
                    agent_key="content",
                    depends_on=["t1"],
                    priority=3,
                    acceptance="A complete draft exists.",
                ),
            ],
        )
    if purpose == "agent":
        return AgentOutput(
            completed=True,
            result_summary="[test transport] Subtask fulfilled with deterministic output.",
            detailed_output=(
                "This result was produced by the VozCore TEST transport "
                "(VOZCORE_TEST_FAKE_LLM=1). It verifies orchestration mechanics only "
                "and is not model-generated work."
            ),
            missing_information=[],
        )
    if purpose == "evaluate":
        return EvaluationResult(
            verdict="completed",
            all_tasks_successful=True,
            completeness_score=100,
            missing_information=[],
            failed_task_keys=[],
            retry_task_keys=[],
            needs_retry=False,
            evaluation_notes="[test transport] all tasks reported success.",
        )
    if purpose == "final_response":
        return FinalResponse(
            headline="[test transport] Execution finished",
            report=(
                "All subtasks finished under the test transport. Replace "
                "VOZCORE_TEST_FAKE_LLM with a real OPENAI_API_KEY for model-generated "
                "results."
            ),
            open_items=["Set OPENAI_API_KEY to run against the real model."],
        )
    raise ValueError(f"no fake transport for purpose {purpose!r}")
