"""Happy-path orchestration: single agent, multi-agent parallelism,
sequential dependencies, approval checkpoints, plan preview, isolation."""

from __future__ import annotations

from conftest import unwrap

import asyncio
import time

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


def _intent():
    return IntentAnalysis(
        objective="Analyse and deliver",
        outcome="A complete deliverable",
        constraints=["stay concise"],
        deadlines=[],
        needs_clarification=False,
        single_agent=False,
        suggested_agents=["research"],
        complexity="moderate",
    )


def _plan(tasks: list[PlanTask], summary="test plan"):
    return ExecutionPlan(summary=summary, tasks=tasks, parallelizable=len(tasks) > 1)


def _agent_ok(prompt: str = ""):
    return AgentOutput(
        completed=True,
        result_summary="Subtask fulfilled.",
        detailed_output="Detailed work product produced by the test transport.",
        missing_information=[],
    )


def _evaluate_ok(prompt: str = ""):
    return EvaluationResult(
        verdict="completed",
        all_tasks_successful=True,
        completeness_score=100,
        needs_retry=False,
    )


def _final(prompt: str = ""):
    return FinalResponse(
        headline="All subtasks finished",
        report="Consolidated report: every subtask completed successfully with unique findings merged once.",
        open_items=[],
    )


def _install(handler):
    llm.set_test_handler(handler)
    return handler


def _default(purpose, schema, prompt):
    if purpose == "intent":
        return _intent()
    if purpose == "plan":
        return _plan(
            [
                PlanTask(
                    task_key="t1",
                    title="Single research brief",
                    description="Produce the brief.",
                    agent_key="research",
                )
            ]
        )
    if purpose == "agent":
        return _agent_ok()
    if purpose == "evaluate":
        return _evaluate_ok()
    if purpose == "final_response":
        return _final()
    raise AssertionError(f"unexpected purpose {purpose}")


def test_single_agent_execution_full_lifecycle(client, make_user, make_conversation, run_execution):
    user_id, cookie = make_user()
    conversation_id = make_conversation(user_id)
    _install(_default)

    detail = run_execution(
        cookie, "Summarise the research landscape for my project", conversation_id=conversation_id
    )
    execution = detail["execution"]
    assert execution["status"] == "completed", execution
    assert execution["finalResponse"]
    assert execution["finishedAt"]

    step_keys = [s["stepKey"] for s in detail["steps"]]
    for expected in [
        "receive_command",
        "understand_intent",
        "retrieve_memory",
        "create_plan",
        "select_agents",
        "dispatch_tasks",
        "execute_agents",
        "collect_results",
        "evaluate_results",
        "generate_final_response",
        "save_execution_memory",
    ]:
        assert expected in step_keys, f"missing step {expected}: {step_keys}"
    assert all(s["status"] in {"completed", "skipped"} for s in detail["steps"])

    assert len(detail["tasks"]) == 1
    assert detail["tasks"][0]["status"] == "completed"
    assert detail["tasks"][0]["agent_key"] == "research"
    assert detail["results"][0]["status"] == "completed"
    assert detail["results"][0]["result_summary"]

    event_types = [e["type"] for e in detail["events"]]
    assert "plan_created" in event_types
    assert "tasks_dispatched" in event_types
    assert "task_completed" in event_types
    assert "response_generated" in event_types
    assert "execution_finished" in event_types

    # assistant message persisted with the execution link
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT role, content, execution_id FROM messages WHERE execution_id = %s",
                (execution["id"],),
            )
            rows = cur.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "assistant"
    assert "All subtasks finished" in rows[0][1]

    # model usage recorded
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*), count(DISTINCT purpose) FROM model_usage")
            total, purposes = cur.fetchone()
    assert total >= 4  # intent + plan + agent + evaluate + final
    assert purposes >= 4


def test_multi_agent_parallel_execution(client, make_user, run_execution):
    user_id, cookie = make_user()

    state = {"active": 0, "max_active": 0, "lock": asyncio.Lock()}

    async def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return _plan(
                [
                    PlanTask(task_key="t1", title="Research", description="r", agent_key="research"),
                    PlanTask(task_key="t2", title="Draft", description="d", agent_key="content"),
                    PlanTask(task_key="t3", title="Plan", description="p", agent_key="project"),
                ],
                summary="three parallel tasks",
            )
        if purpose == "agent":
            async with state["lock"]:
                state["active"] += 1
                state["max_active"] = max(state["max_active"], state["active"])
            await asyncio.sleep(0.15)
            async with state["lock"]:
                state["active"] -= 1
            return _agent_ok()
        if purpose == "evaluate":
            return _evaluate_ok()
        if purpose == "final_response":
            return _final()
        raise AssertionError(purpose)

    _install(handler)
    detail = run_execution(cookie, "Run research, drafting and planning together")

    assert detail["execution"]["status"] == "completed"
    assert len(detail["tasks"]) == 3
    # all three tasks are in wave 0 → independent → executed concurrently
    assert all(t["wave"] == 0 for t in detail["tasks"])
    assert state["max_active"] >= 2, f"expected parallel execution, max_active={state['max_active']}"
    assert all(t["status"] == "completed" for t in detail["tasks"])
    agents = {t["agent_key"] for t in detail["tasks"]}
    assert agents == {"research", "content", "project"}


def test_sequential_dependency_order(client, make_user, run_execution):
    user_id, cookie = make_user()
    order_events: list[str] = []

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return _plan(
                [
                    PlanTask(task_key="t1", title="First", description="x", agent_key="research"),
                    PlanTask(
                        task_key="t2",
                        title="Second",
                        description="x",
                        agent_key="content",
                        depends_on=["t1"],
                    ),
                    PlanTask(
                        task_key="t3",
                        title="Third",
                        description="x",
                        agent_key="project",
                        depends_on=["t2"],
                    ),
                ],
                summary="chain of three",
            )
        if purpose == "agent":
            return _agent_ok()
        if purpose == "evaluate":
            return _evaluate_ok()
        if purpose == "final_response":
            return _final()
        raise AssertionError(purpose)

    _install(handler)
    detail = run_execution(cookie, "Chain three dependent tasks")

    assert detail["execution"]["status"] == "completed"
    waves = {t["task_key"]: t["wave"] for t in detail["tasks"]}
    assert waves == {"t1": 0, "t2": 1, "t3": 2}

    # event order proves t1 finished before t2 started, t2 before t3
    events = detail["events"]

    def event_id(event_type: str, task: str) -> int:
        for e in events:
            if e["type"] == event_type and e["payload"].get("task") == task:
                return e["id"]
        raise AssertionError(f"missing {event_type} for {task}")

    assert event_id("task_completed", "t1") < event_id("task_started", "t2")
    assert event_id("task_completed", "t2") < event_id("task_started", "t3")


def test_approval_checkpoint_holds_sensitive_task(client, make_user, run_execution):
    user_id, cookie = make_user()

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return _plan(
                [
                    PlanTask(task_key="t1", title="Prepare reply", description="draft", agent_key="inbox"),
                    PlanTask(
                        task_key="t2",
                        title="Send the email",
                        description="external send",
                        agent_key="inbox",
                        approval_required=True,
                    ),
                ]
            )
        if purpose == "agent":
            return _agent_ok()
        if purpose == "evaluate":
            return _evaluate_ok()
        if purpose == "final_response":
            return FinalResponse(
                headline="Draft ready — one action awaits approval",
                report="The reply draft is complete. Sending the email is held at an approval checkpoint and was not executed.",
                open_items=["Approve the send in the Approval Center."],
            )
        raise AssertionError(purpose)

    _install(handler)
    detail = run_execution(cookie, "Draft and send a client email")

    by_key = {t["task_key"]: t for t in detail["tasks"]}
    assert by_key["t1"]["status"] == "completed"
    assert by_key["t2"]["status"] == "waiting", "sensitive task must not run without approval"
    assert by_key["t2"]["approval_required"] is True
    assert detail["execution"]["status"] == "waiting", detail["execution"]

    # a real approval row was created for the human gate
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title, status FROM approvals WHERE user_id = %s AND task_id IS NULL",
                (user_id,),
            )
            approvals = cur.fetchall()
    assert len(approvals) == 1
    assert approvals[0][1] == "pending"
    assert "Send the email" in approvals[0][0]

    # never mark the held task completed
    assert all(t["status"] != "completed" for t in detail["tasks"] if t["approval_required"])


def test_clarification_short_circuits(client, make_user, make_conversation, run_execution):
    user_id, cookie = make_user()
    conversation_id = make_conversation(user_id)

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return IntentAnalysis(
                objective="unclear",
                outcome="unclear",
                needs_clarification=True,
                clarification_question="Which client should the reply be addressed to?",
                complexity="simple",
            )
        raise AssertionError(f"no further model calls expected, got {purpose}")

    _install(handler)
    detail = run_execution(cookie, "Send the reply", conversation_id=conversation_id)

    assert detail["execution"]["status"] == "waiting", detail["execution"]
    assert detail["execution"]["clarification"] == "Which client should the reply be addressed to?"
    assert detail["tasks"] == []
    step_keys = [s["stepKey"] for s in detail["steps"]]
    assert "create_plan" not in step_keys, "clarification must skip planning"
    assert "generate_final_response" in step_keys

    # the question is persisted as an assistant message
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT content FROM messages WHERE execution_id = %s AND role = 'assistant'",
                (detail["execution"]["id"],),
            )
            row = cur.fetchone()
    assert row and "Which client" in row[0]


def test_plan_preview_does_not_create_execution(client, make_user):
    _, cookie = make_user()
    _install(_default)

    before = unwrap(client.get("/executions", cookies={"vp_at": cookie}))
    response = client.post("/plan", json={"command": "Summarise risks"}, cookies={"vp_at": cookie})
    assert response.status_code == 200
    payload = unwrap(response)
    assert payload["plan"]["tasks"][0]["agent_key"] == "research"
    assert payload["selectedAgents"][0]["key"] == "research"
    assert payload["clarification"] is None

    after = unwrap(client.get("/executions", cookies={"vp_at": cookie}))
    assert len(after) == len(before), "plan preview must not persist an execution"


def test_user_data_isolation(client, make_user, run_execution):
    user_a, cookie_a = make_user("Alice")
    user_b, cookie_b = make_user("Bob")
    _install(_default)

    detail = run_execution(cookie_a, "Alice private command work")
    execution_id = detail["execution"]["id"]

    # Bob cannot see Alice's execution
    assert client.get(f"/executions/{execution_id}", cookies={"vp_at": cookie_b}).status_code == 404
    bob_list = unwrap(client.get("/executions", cookies={"vp_at": cookie_b}))
    assert all(e["id"] != execution_id for e in bob_list)
    assert client.post(
        f"/executions/{execution_id}/cancel", json={}, cookies={"vp_at": cookie_b}
    ).status_code == 404

    # Alice still sees it
    assert client.get(f"/executions/{execution_id}", cookies={"vp_at": cookie_a}).status_code == 200
    alice_list = unwrap(client.get("/executions", cookies={"vp_at": cookie_a}))
    assert any(e["id"] == execution_id for e in alice_list)
