"""Environment configuration for the VozCore engine.

Secrets are read exclusively from the server-side environment / repository
`.env` file — never exposed to the client. The engine refuses to start with
an incomplete security configuration rather than falling back to anything
fake.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(REPO_ROOT / ".env")


def _build_database_url(raw: dict[str, str]) -> str:
    """Prefer DATABASE_URL; otherwise assemble the embedded/app DSN."""
    explicit = (raw.get("DATABASE_URL") or "").strip()
    if explicit:
        return explicit
    user = raw.get("APP_DB_USER", "vozpilot")
    password = raw.get("APP_DB_PASSWORD", "")
    name = raw.get("APP_DB_NAME", "vozpilot")
    port = raw.get("EMBEDDED_PG_PORT", "54329")
    if not password:
        raise RuntimeError(
            "No database configuration found — set DATABASE_URL or APP_DB_* in .env"
        )
    return f"postgresql://{user}:{password}@127.0.0.1:{port}/{name}"


def _build_superuser_url(raw: dict[str, str]) -> str | None:
    """Superuser DSN for the embedded cluster (janitor / test fixtures)."""
    if (raw.get("DATABASE_URL") or "").strip():
        return None  # managed database — never assume superuser credentials
    password = raw.get("EMBEDDED_PG_PASSWORD", "")
    if not password:
        return None
    port = raw.get("EMBEDDED_PG_PORT", "54329")
    name = raw.get("APP_DB_NAME", "vozpilot")
    return f"postgresql://postgres:{password}@127.0.0.1:{port}/{name}"


@dataclass
class Settings:
    node_env: str = "development"
    jwt_secret: str = ""
    database_url: str = ""
    superuser_database_url: str | None = None

    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None

    port: int = 8001

    # Execution limits — bounded retries and timeouts prevent runaway loops.
    max_task_attempts: int = 2
    task_timeout_seconds: float = 90.0
    execution_timeout_seconds: float = 420.0
    max_tasks_per_execution: int = 8
    llm_max_retries: int = 3

    # Test-only transport. Refused in production, loudly reported in /health.
    fake_llm: bool = False

    @property
    def llm_configured(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def llm_mode(self) -> str:
        if self.fake_llm:
            return "test-fake"
        return "openai" if self.llm_configured else "unconfigured"


def load_settings() -> Settings:
    raw = dict(os.environ)
    node_env = raw.get("NODE_ENV", "development")

    jwt_secret = (raw.get("JWT_SECRET") or "").strip()
    if len(jwt_secret) < 16:
        raise RuntimeError(
            "JWT_SECRET is missing or too short — VozCore refuses to start without "
            "the shared session secret (generate one in .env, see .env.example)."
        )

    fake = (raw.get("VOZCORE_TEST_FAKE_LLM") or "").strip() in {"1", "true", "yes"}
    if fake and node_env == "production":
        raise RuntimeError(
            "VOZCORE_TEST_FAKE_LLM is set but NODE_ENV=production — the test LLM "
            "transport is never allowed in production."
        )

    def _int(name: str, default: int) -> int:
        try:
            return int(raw.get(name, default))
        except ValueError:
            return default

    def _float(name: str, default: float) -> float:
        try:
            return float(raw.get(name, default))
        except ValueError:
            return default

    return Settings(
        node_env=node_env,
        jwt_secret=jwt_secret,
        database_url=_build_database_url(raw),
        superuser_database_url=_build_superuser_url(raw),
        openai_api_key=(raw.get("OPENAI_API_KEY") or "").strip() or None,
        openai_model=(raw.get("OPENAI_MODEL") or "gpt-4o-mini").strip(),
        openai_base_url=(raw.get("OPENAI_BASE_URL") or "").strip() or None,
        port=_int("VOZCORE_PORT", 8001),
        max_task_attempts=max(1, _int("VOZCORE_MAX_TASK_ATTEMPTS", 2)),
        task_timeout_seconds=_float("VOZCORE_TASK_TIMEOUT", 90.0),
        execution_timeout_seconds=_float("VOZCORE_EXECUTION_TIMEOUT", 420.0),
        max_tasks_per_execution=max(1, _int("VOZCORE_MAX_TASKS", 8)),
        llm_max_retries=max(0, _int("VOZCORE_LLM_RETRIES", 3)),
        fake_llm=fake,
    )


settings = load_settings()
