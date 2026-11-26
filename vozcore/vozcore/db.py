"""PostgreSQL access for VozCore.

Same rules as the Node API: application queries run as the restricted
`vozpilot` role inside a transaction with `app.user_id` set, which is what
makes Row Level Security enforce per-user isolation. Long-running model calls
never hold a transaction open — every DB helper opens a short-lived one.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from typing import Any, Iterator

import json

import psycopg2
import psycopg2.extras
import psycopg2.extensions

from .config import settings


class Utf8Json(psycopg2.extras.Json):
    """JSON parameter adapter that keeps non-ASCII characters raw.

    The embedded cluster boots SQL_ASCII — `json.dumps` default `ensure_ascii`
    escapes (\u2014) crash the server's jsonb parser, while raw UTF-8 bytes
    round-trip fine (the Node driver does the same).
    """

    def dumps(self, obj) -> str:  # noqa: D102 - psycopg2 contract
        return json.dumps(obj, default=str, ensure_ascii=False)


def connect(database_url: str | None = None) -> psycopg2.extensions.connection:
    conn = psycopg2.connect(database_url or settings.database_url)
    conn.autocommit = False
    # The embedded cluster initialises as SQL_ASCII (C locale) while the Node
    # API writes UTF-8 bytes — force UTF8 decoding/encoding on our side so
    # em-dashes and other non-ASCII text round-trip correctly.
    try:
        conn.set_client_encoding("UTF8")
    except psycopg2.Error:
        pass
    return conn


@contextmanager
def user_txn(user_id: str, database_url: str | None = None) -> Iterator[psycopg2.extensions.connection]:
    """Transaction scoped to one user — RLS sees only their rows."""
    # Validate before the value ever reaches SQL text anywhere.
    uuid.UUID(user_id)
    conn = connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def admin_conn(database_url: str | None = None) -> Iterator[psycopg2.extensions.connection]:
    """Superuser connection (embedded cluster only) — migrations/janitor/tests."""
    url = database_url or settings.superuser_database_url
    if not url:
        raise RuntimeError("No superuser database URL available")
    conn = connect(url)
    try:
        conn.autocommit = True
        yield conn
    finally:
        conn.close()


def rows(conn: psycopg2.extensions.connection, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def row(conn: psycopg2.extensions.connection, sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    result = rows(conn, sql, params)
    return result[0] if result else None


def execute(conn: psycopg2.extensions.connection, sql: str, params: tuple | list = ()) -> None:
    with conn.cursor() as cur:
        cur.execute(sql, params)


def scalar(conn: psycopg2.extensions.connection, sql: str, params: tuple | list = ()) -> Any:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        fetched = cur.fetchone()
        return fetched[0] if fetched else None


def json_param(value: Any) -> str:
    """Serialize nested structures for jsonb parameters (raw UTF-8)."""
    return json.dumps(value, default=str, ensure_ascii=False)


def run_in_user_txn(user_id: str, fn):
    """Run a synchronous DB function inside a user transaction (for to_thread)."""
    with user_txn(user_id) as conn:
        return fn(conn)
