"""VozCore test fixtures.

- A dedicated `vozpilot_test` database is created once per session and the
  real migrations (001 + 002) are applied to it — tests exercise the actual
  schema, RLS policies and grants as the restricted application role.
- The FastAPI app runs against that database via TestClient.
- A test LLM handler is injected in-process (never an environment flag), so
  production code paths remain untouched.
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

import psycopg2
import pytest
from fastapi.testclient import TestClient

# Make the vozcore package importable when running `pytest` from vozcore/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vozcore import db, llm, store  # noqa: E402
from vozcore.api import app  # noqa: E402
from vozcore.auth import sign_access_token  # noqa: E402
from vozcore.config import settings  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MIGRATIONS = sorted((REPO_ROOT / "server" / "src" / "db" / "migrations").glob("*.sql"))

TEST_DB_NAME = "vozpilot_test"

AGENT_SEED = [
    ("vozcore", "VozCore", "active", "Central AI manager"),
    ("research", "Research Agent", "idle", "Collects and structures information"),
    ("inbox", "Inbox Agent", "idle", "Triages email"),
    ("project", "Project Agent", "idle", "Keeps projects moving"),
    ("content", "Content Agent", "idle", "Plans and drafts content"),
    ("finance", "Finance Agent", "idle", "Watches invoices and budgets"),
    ("schedule", "Schedule Agent", "idle", "Plans calendars"),
    ("developer", "Developer Agent", "idle", "Ships code work"),
    ("memory", "Memory Agent", "idle", "Curates workspace knowledge"),
]


def unwrap(response):
    """Return the payload of a success envelope ({data}) or the body as-is.

    VozCore success responses follow the app-wide {data}/{error} contract;
    error bodies keep their top-level "error" key and pass through untouched.
    """
    body = response.json()
    if isinstance(body, dict) and "data" in body and "error" not in body:
        return body["data"]
    return body


@pytest.fixture(scope="session")
def test_database_url() -> str:
    """Create vozcopec_test from the real migrations, granted to the app role."""
    superuser_url = settings.superuser_database_url
    assert superuser_url, "tests require the embedded PostgreSQL superuser DSN"

    # Terminate leftover connections, recreate the database
    admin = psycopg2.connect(superuser_url)
    admin.autocommit = True
    admin.set_client_encoding("UTF8")
    with admin.cursor() as cur:
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            (TEST_DB_NAME,),
        )
        cur.execute(f'DROP DATABASE IF EXISTS "{TEST_DB_NAME}"')
        cur.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
        # ensure the restricted role exists (mirrors provisionAppRole)
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (os.environ.get("APP_DB_USER", "vozpilot"),))
        if cur.fetchone() is None:
            cur.execute(
                f'CREATE ROLE "{os.environ.get("APP_DB_USER", "vozpilot")}" LOGIN '
                f"PASSWORD '{os.environ.get('APP_DB_PASSWORD', 'vozpilot-dev-password')}'"
            )
    admin.close()

    # Apply migrations as superuser (schema ownership), then grant like Node does
    base = superuser_url.rsplit("/", 1)[0]
    conn = psycopg2.connect(f"{base}/{TEST_DB_NAME}")
    conn.autocommit = True
    conn.set_client_encoding("UTF8")  # cluster boots SQL_ASCII; migrations contain UTF-8 text
    with conn.cursor() as cur:
        for migration in MIGRATIONS:
            cur.execute(migration.read_text())
        role = os.environ.get("APP_DB_USER", "vozpilot")
        cur.execute(f'GRANT CONNECT ON DATABASE "{TEST_DB_NAME}" TO "{role}"')
        cur.execute(f'GRANT USAGE ON SCHEMA public TO "{role}"')
        cur.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "{role}"')
        cur.execute(
            f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "{role}"'
        )
        cur.execute(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{role}"'
        )
        cur.execute(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "{role}"'
        )
    conn.close()

    app_user = os.environ.get("APP_DB_USER", "vozpilot")
    app_password = os.environ.get("APP_DB_PASSWORD", "vozpilot-dev-password")
    return f"postgresql://{app_user}:{app_password}@127.0.0.1:{os.environ.get('EMBEDDED_PG_PORT', '54329')}/{TEST_DB_NAME}"


@pytest.fixture(autouse=True)
def _point_engine_at_test_db(test_database_url):
    original = settings.database_url
    settings.database_url = test_database_url
    # tests never use the production fake transport unless a scenario opts in
    settings.fake_llm = False
    yield
    settings.database_url = original
    llm.set_test_handler(None)


@pytest.fixture(scope="session")
def client(test_database_url):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def make_user():
    """Create an isolated user with the nine seeded agents; returns (user_id, cookie)."""
    created: list[tuple[str, str]] = []

    def _make(name: str = "Test User") -> tuple[str, str]:
        user_id = str(uuid.uuid4())
        email = f"{name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:8]}@vozpilot.test"
        # insert via the app role so RLS/grants match production
        with db.user_txn(user_id, settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (id, email, name, password_hash, role) VALUES (%s, %s, %s, %s, 'owner')",
                    (user_id, email, name, "x"),
                )
                for key, agent_name, status, description in AGENT_SEED:
                    cur.execute(
                        """
                        INSERT INTO agents (user_id, key, name, status, description, responsibilities)
                        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                        """,
                        (user_id, key, agent_name, status, description, '["seeded"]'),
                    )
        cookie = sign_access_token(user_id)
        created.append((user_id, cookie))
        return user_id, cookie

    yield _make


@pytest.fixture
def make_conversation():
    """Create a conversation row for a user (the Node API normally does this)."""

    def _make(user_id: str, title: str = "Test thread") -> str:
        import uuid as _uuid

        conversation_id = str(_uuid.uuid4())
        with db.user_txn(user_id, settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO conversations (id, user_id, title) VALUES (%s, %s, %s)",
                    (conversation_id, user_id, title),
                )
        return conversation_id

    return _make


@pytest.fixture
def run_execution(client):
    """POST /command and poll until the execution reaches a terminal state."""

    def _run(cookie: str, command: str, conversation_id: str | None = None, timeout: float = 30.0) -> dict:
        response = client.post(
            "/command",
            json={"command": command, "conversationId": conversation_id},
            cookies={"vp_at": cookie},
        )
        assert response.status_code in (201, 200), response.text
        execution_id = unwrap(response)["execution"]["id"]
        deadline = time.time() + timeout
        while time.time() < deadline:
            detail = client.get(
                f"/executions/{execution_id}",
                params={"sinceEventId": 0},
                cookies={"vp_at": cookie},
            )
            assert detail.status_code == 200, detail.text
            body = unwrap(detail)
            if body["execution"]["status"] in {"completed", "failed", "cancelled", "waiting"}:
                # allow the finalizer to persist
                if body["execution"].get("finishedAt") or body["execution"]["status"] == "waiting":
                    return body
            time.sleep(0.1)
        raise AssertionError(f"execution {execution_id} did not finish in time")

    return _run
