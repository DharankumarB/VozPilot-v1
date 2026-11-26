"""Health, authentication, validation and agent catalogue."""

from __future__ import annotations

from conftest import unwrap


def test_health_reports_honest_llm_state(client, make_user):
    _, cookie = make_user()
    response = client.get("/health", cookies={"vp_at": cookie})
    assert response.status_code == 200
    data = unwrap(response)
    assert data["status"] == "ok"
    assert data["engine"] == "vozcore"
    assert data["llm"]["mode"] in {"openai", "unconfigured", "test-fake"}
    assert data["graph"]["nodes"].__len__() == 12
    assert data["graph"]["conditionalRouting"] is True
    if not data["llm"]["configured"]:
        assert data["message"] and "OPENAI_API_KEY" in data["message"]


def test_requires_authentication(client):
    assert client.get("/health").status_code == 401
    assert client.get("/agents").status_code == 401
    assert client.get("/executions").status_code == 401
    assert client.post("/command", json={"command": "hello there"}).status_code == 401
    assert client.post("/plan", json={"command": "hello there"}).status_code == 401


def test_invalid_command_rejected_with_envelope(client, make_user):
    _, cookie = make_user()
    response = client.post("/command", json={"command": "hi"}, cookies={"vp_at": cookie})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"]


def test_agents_catalogue_is_honest(client, make_user):
    _, cookie = make_user()
    data = unwrap(client.get("/agents", cookies={"vp_at": cookie}))
    assert data["coordinator"]["key"] == "vozcore"
    keys = {a["key"] for a in data["agents"]}
    assert keys == {
        "research",
        "inbox",
        "project",
        "content",
        "finance",
        "schedule",
        "developer",
        "memory",
    }
    for agent in data["agents"]:
        assert agent["executionMode"] == "llm"
        assert agent["operational"] is True  # idle agents can accept work
        assert agent["capabilities"], "each agent exposes real capabilities"

    # a paused agent must not report operational
    from vozcore import db
    from vozcore.config import settings

    user_id = None  # pause one agent for this user and re-check
    # find the user by creating a fresh one
    user_id, cookie = make_user("Pause User")
    with db.user_txn(user_id, settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE agents SET status = 'paused' WHERE user_id = %s AND key = 'inbox'", (user_id,))
    data = unwrap(client.get("/agents", cookies={"vp_at": cookie}))
    inbox = next(a for a in data["agents"] if a["key"] == "inbox")
    assert inbox["operational"] is False
    assert "paused" in inbox["notes"]


def test_unknown_execution_returns_404(client, make_user):
    _, cookie = make_user()
    response = client.get("/executions/11111111-2222-3333-4444-555555555555", cookies={"vp_at": cookie})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
