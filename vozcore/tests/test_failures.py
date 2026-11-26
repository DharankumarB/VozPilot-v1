"""Failure modes: missing credentials, model errors, agent retries,
retry exhaustion, and user cancellation."""

from __future__ import annotations

from conftest import unwrap

import asyncio
import time

from vozcore import llm
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
    return IntentAnalysis(objective="o", outcome="done", complexity="moderate")


def _final():
    return FinalResponse(
        headline="Run finished",
        report="The run finished and all consolidated findings are included in this report body.",
        open_items=[],
    )


def test_missing_credentials_returns_clear_config_error(client, make_user):
    _, cookie = make_user()
    original_key = settings.openai_api_key
    original_fake = settings.fake_llm
    settings.openai_api_key = None
    settings.fake_llm = False
    try:
        response = client.post("/command", json={"command": "Summarise my week"}, cookies={"vp_at": cookie})
        assert response.status_code == 503
        error = response.json()["error"]
        assert error["code"] == "vozcore_not_configured"
        assert "OPENAI_API_KEY" in error["message"]
        assert "simulated" in error["message"] or "never" in error["message"]

        plan = client.post("/plan", json={"command": "Summarise my week"}, cookies={"vp_at": cookie})
        assert plan.status_code == 503
        assert plan.json()["error"]["code"] == "vozcore_not_configured"

        # nothing was persisted
        executions = unwrap(client.get("/executions", cookies={"vp_at": cookie}))
        assert executions == []
    finally:
        settings.openai_api_key = original_key
        settings.fake_llm = original_fake


def test_model_api_failure_fails_execution_honestly(client, make_user, run_execution):
    user_id, cookie = make_user()

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            raise RuntimeError("simulated upstream outage")
        raise AssertionError("should not reach here")

    llm.set_test_handler(handler)
    detail = run_execution(cookie, "Anything at all")
    execution = detail["execution"]

    assert execution["status"] == "failed"
    assert "simulated upstream outage" in (execution["error"] or "")
    # no fabricated assistant reply
    from vozcore import db
    from vozcore.config import settings as cfg

    with db.user_txn(user_id, cfg.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM messages WHERE execution_id = %s", (execution["id"],))
            (count,) = cur.fetchone()
    assert count == 0, "a failed run must not post a fake assistant message"

    failed_steps = [s for s in detail["steps"] if s["status"] == "failed"]
    assert failed_steps and failed_steps[0]["stepKey"] == "understand_intent"


def test_agent_failure_then_retry_succeeds(client, make_user, run_execution):
    user_id, cookie = make_user()
    calls = {"agent": 0, "evaluate": 0}

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return ExecutionPlan(
                summary="one flaky task",
                tasks=[PlanTask(task_key="t1", title="Flaky", description="x", agent_key="research")],
            )
        if purpose == "agent":
            calls["agent"] += 1
            if calls["agent"] == 1:
                raise RuntimeError("transient agent failure")
            return AgentOutput(
                completed=True,
                result_summary="Recovered on retry.",
                detailed_output="Second attempt produced the full output.",
            )
        if purpose == "evaluate":
            calls["evaluate"] += 1
            if calls["evaluate"] == 1:
                return EvaluationResult(
                    verdict="partial",
                    all_tasks_successful=False,
                    completeness_score=40,
                    failed_task_keys=["t1"],
                    retry_task_keys=["t1"],
                    needs_retry=True,
                )
            return EvaluationResult(
                verdict="completed",
                all_tasks_successful=True,
                completeness_score=100,
                needs_retry=False,
            )
        if purpose == "final_response":
            return _final()
        raise AssertionError(purpose)

    llm.set_test_handler(handler)
    detail = run_execution(cookie, "Retry the flaky research task")

    assert detail["execution"]["status"] == "completed"
    task = detail["tasks"][0]
    assert task["status"] == "completed"
    assert task["attempts"] == 2

    with db_helper(user_id) as (conn, cur):
        cur.execute(
            "SELECT attempt, status FROM agent_results WHERE execution_id = %s ORDER BY attempt",
            (detail["execution"]["id"],),
        )
        attempts = cur.fetchall()
    assert [a[1] for a in attempts] == ["failed", "completed"]
    assert [a[0] for a in attempts] == [1, 2]

    event_types = [e["type"] for e in detail["events"]]
    assert "retry_scheduled" in event_types


def test_agent_failure_exhausts_retries_and_fails(client, make_user, run_execution):
    user_id, cookie = make_user()
    calls = {"agent": 0}

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return ExecutionPlan(
                summary="doomed task",
                tasks=[PlanTask(task_key="t1", title="Doomed", description="x", agent_key="finance")],
            )
        if purpose == "agent":
            calls["agent"] += 1
            raise RuntimeError("permanent agent failure")
        if purpose == "evaluate":
            return EvaluationResult(
                verdict="failed",
                all_tasks_successful=False,
                completeness_score=0,
                failed_task_keys=["t1"],
                retry_task_keys=["t1"],
                needs_retry=True,
            )
        if purpose == "final_response":
            return FinalResponse(
                headline="Run failed",
                report="The subtask could not be completed after retries; details of the failure are included.",
                open_items=["Fix the underlying issue and re-run."],
            )
        raise AssertionError(purpose)

    llm.set_test_handler(handler)
    detail = run_execution(cookie, "Try the doomed finance task")

    assert detail["execution"]["status"] == "failed"
    assert detail["tasks"][0]["status"] == "failed"
    assert detail["tasks"][0]["attempts"] == 2  # bounded retries, not infinite
    assert calls["agent"] == 2, "exactly max_attempts model calls"
    # never marked completed
    assert detail["execution"]["finalResponse"] is None or "failed" in detail["execution"]["finalResponse"].lower()


def test_execution_cancellation(client, make_user):
    user_id, cookie = make_user()
    gate = asyncio.Event()
    started = {"intent": False}

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            started["intent"] = True
            return _intent()
        raise AssertionError(purpose)

    async def async_handler(purpose, schema, prompt):
        if purpose == "intent":
            started["intent"] = True
            await gate.wait()
            return _intent()
        if purpose == "plan":
            return ExecutionPlan(
                summary="p",
                tasks=[PlanTask(task_key="t1", title="t", description="x", agent_key="research")],
            )
        if purpose == "agent":
            return AgentOutput(completed=True, result_summary="ok", detailed_output="ok")
        if purpose == "evaluate":
            return EvaluationResult(verdict="completed", all_tasks_successful=True, completeness_score=100)
        if purpose == "final_response":
            return _final()
        raise AssertionError(purpose)

    llm.set_test_handler(async_handler)

    response = client.post("/command", json={"command": "Cancel me mid flight"}, cookies={"vp_at": cookie})
    assert response.status_code == 200
    execution_id = unwrap(response)["execution"]["id"]

    # wait until the intent step is in flight
    deadline = time.time() + 10
    while time.time() < deadline:
        detail = unwrap(client.get(f"/executions/{execution_id}", cookies={"vp_at": cookie}))
        if any(s["stepKey"] == "understand_intent" and s["status"] == "running" for s in detail["steps"]):
            break
        time.sleep(0.05)
    else:
        raise AssertionError("intent step never started")

    cancel = client.post(f"/executions/{execution_id}/cancel", json={}, cookies={"vp_at": cookie})
    assert cancel.status_code == 200
    assert unwrap(cancel)["execution"]["cancelRequested"] is True

    # release the blocked model call — the graph observes the cancel at the next boundary
    gate.set()

    deadline = time.time() + 20
    while time.time() < deadline:
        detail = unwrap(client.get(f"/executions/{execution_id}", cookies={"vp_at": cookie}))
        if detail["execution"]["status"] in {"cancelled", "completed", "failed", "waiting"}:
            break
        time.sleep(0.1)
    else:
        raise AssertionError("execution never reached a terminal state")

    assert detail["execution"]["status"] == "cancelled"
    event_types = [e["type"] for e in detail["events"]]
    assert "cancellation_requested" in event_types
    # cancelled tasks are never reported completed
    assert all(t["status"] != "completed" for t in detail["tasks"] if t["status"] == "cancelled")

    # cancelling a terminal execution is idempotent
    again = client.post(f"/executions/{execution_id}/cancel", json={}, cookies={"vp_at": cookie})
    assert again.status_code == 200
    assert unwrap(again)["execution"]["status"] == "cancelled"


def test_unauthorized_cannot_cancel_any_execution(client, make_user, run_execution):
    _, cookie_a = make_user("Owner")
    _, cookie_b = make_user("Stranger")

    def handler(purpose, schema, prompt):
        if purpose == "intent":
            return _intent()
        if purpose == "plan":
            return ExecutionPlan(
                summary="s",
                tasks=[PlanTask(task_key="t1", title="t", description="x", agent_key="research")],
            )
        if purpose == "agent":
            return AgentOutput(completed=True, result_summary="ok", detailed_output="ok")
        if purpose == "evaluate":
            return EvaluationResult(verdict="completed", all_tasks_successful=True, completeness_score=100)
        if purpose == "final_response":
            return _final()
        raise AssertionError(purpose)

    llm.set_test_handler(handler)
    detail = run_execution(cookie_a, "Private work item")
    execution_id = detail["execution"]["id"]

    assert client.post(f"/executions/{execution_id}/cancel", cookies={"vp_at": cookie_b}).status_code == 404
    assert client.get(f"/executions/{execution_id}", cookies={"vp_at": cookie_b}).status_code == 404


class db_helper:
    """Small context manager returning (conn, cursor) on the test database."""

    def __init__(self, user_id: str):
        from vozcore import db as _db
        from vozcore.config import settings as _settings

        self._db = _db
        self._settings = _settings
        self._user_id = user_id
        self._conn = None

    def __enter__(self):
        self._conn = self._db.user_txn(self._user_id, self._settings.database_url)
        conn = self._conn.__enter__()
        cursor = conn.cursor()
        return conn, cursor

    def __exit__(self, *args):
        try:
            self._conn.__exit__(*args)
        except Exception:
            pass
        return False
