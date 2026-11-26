"""Memory Center integration: retrieval into prompts, honest saves,
sensitive-content skip, user isolation."""

from __future__ import annotations

from vozcore import db, llm
from vozcore.config import settings
from vozcore.schemas import (
    AgentOutput,
    EvaluationResult,
    ExecutionPlan,
    FinalResponse,
    IntentAnalysis,
    PlanTask,
)


def _base_handler(captured_prompts: dict[str, str]):
    def handler(purpose, schema, prompt, system=None):
        # the agent's context travels in the system message; planners use prompt
        captured_prompts[purpose] = f"{prompt}\n{system or ''}"
        if purpose == "intent":
            return IntentAnalysis(objective="o", outcome="done", complexity="moderate")
        if purpose == "plan":
            return ExecutionPlan(
                summary="plan",
                tasks=[PlanTask(task_key="t1", title="Work", description="x", agent_key="memory")],
            )
        if purpose == "agent":
            return AgentOutput(
                completed=True,
                result_summary="Knowledge distilled.",
                detailed_output="A durable knowledge entry summarising the Apollo launch decisions.",
            )
        if purpose == "evaluate":
            return EvaluationResult(verdict="completed", all_tasks_successful=True, completeness_score=100)
        if purpose == "final_response":
            return FinalResponse(
                headline="Apollo work complete",
                report=(
                    "The Apollo launch plan has been reviewed and distilled into durable notes: "
                    "milestones, owners and risks are all captured for later retrieval."
                ),
                open_items=[],
            )
        raise AssertionError(purpose)

    return handler


def _seed_memory(user_id: str, title: str, content: str):
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO memories (user_id, category, title, content, tags) VALUES (%s, 'project', %s, %s, %s)",
                (user_id, title, content, '["seed"]'),
            )


def test_relevant_memory_flows_into_planning(client, make_user, run_execution):
    user_id, cookie = make_user()
    _seed_memory(user_id, "Apollo launch plan", "Launch is targeted for March; owner is Priya; risk: supplier delay.")
    captured: dict[str, str] = {}
    llm.set_test_handler(_base_handler(captured))

    detail = run_execution(cookie, "Prepare the Apollo launch review")

    assert detail["execution"]["status"] == "completed"
    assert "Apollo launch plan" in captured.get("plan", ""), "retrieved memory must reach the planner"
    # agent context also carries the memory excerpt
    assert "Priya" in captured.get("agent", "") or "Apollo" in captured.get("agent", "")


def test_successful_execution_saves_durable_memory(client, make_user, run_execution):
    user_id, cookie = make_user()
    llm.set_test_handler(_base_handler({}))

    detail = run_execution(cookie, "Distil the Apollo launch review into notes")
    assert detail["execution"]["status"] == "completed"

    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title, content, tags FROM memories WHERE user_id = %s AND title LIKE 'VozCore:%%'",
                (user_id,),
            )
            rows = cur.fetchall()
    assert len(rows) == 1
    assert "Apollo" in rows[0][1]
    assert "vozcore" in rows[0][2]

    event_types = [e["type"] for e in detail["events"]]
    assert "memory_saved" in event_types


def test_sensitive_content_is_not_auto_saved(client, make_user, run_execution):
    user_id, cookie = make_user()
    captured: dict[str, str] = {}
    llm.set_test_handler(_base_handler(captured))

    detail = run_execution(cookie, "Remember my password hunter2 for the deploy box")
    assert detail["execution"]["status"] == "completed"

    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM memories WHERE user_id = %s AND title LIKE 'VozCore:%%'",
                (user_id,),
            )
            (count,) = cur.fetchone()
    assert count == 0, "sensitive-looking content must not be saved to memory"

    skips = [e for e in detail["events"] if e["type"] == "memory_skipped"]
    assert skips and skips[0]["payload"]["reason"] == "possible_sensitive_content"


def test_memories_stay_user_isolated(client, make_user, run_execution):
    user_a, cookie_a = make_user("Alice")
    user_b, cookie_b = make_user("Bob")
    _seed_memory(user_a, "Alice secret plan", "Confidential alice-only context for retrieval.")
    captured: dict[str, str] = {}
    llm.set_test_handler(_base_handler(captured))

    # Bob runs the same command — Alice's memory must not appear in his prompt
    detail = run_execution(cookie_b, "Prepare the Apollo launch review")
    assert detail["execution"]["status"] == "completed"
    assert "Alice secret plan" not in captured.get("plan", "")
    assert "alice-only" not in captured.get("plan", "")

    # Bob's model_usage is his own
    with db.user_txn(user_b, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM model_usage WHERE user_id = %s", (user_b,))
            (b_count,) = cur.fetchone()
            cur.execute("SELECT count(*) FROM model_usage WHERE user_id = %s", (user_a,))
            (a_count,) = cur.fetchone()
    assert b_count > 0
    assert a_count == 0, "Bob's run must not bill usage to Alice"
