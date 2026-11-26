"""OpenAI integration for VozCore.

- Keys are read only from server-side environment secrets.
- Structured outputs (Pydantic response_format) for every call.
- Bounded retries with backoff on rate limits / transient errors.
- Token usage persisted to `model_usage` for every call.
- Missing credentials raise a clear configuration error — the engine never
  falls back to canned or simulated responses in any mode that can run in
  production. The test transport is opt-in per process, refused when
  NODE_ENV=production, and reported by /health.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, TypeVar

from pydantic import BaseModel

from .config import settings
from .errors import ConfigUnavailableError, LLMCallError

logger = logging.getLogger("vozcore.llm")

T = TypeVar("T", bound=BaseModel)

# Test-only injection point. Production code paths never set this.
TestHandler = Callable[[str, type[BaseModel], str], BaseModel]
_test_handler: TestHandler | None = None


def set_test_handler(handler: TestHandler | None) -> None:
    global _test_handler
    _test_handler = handler


def has_test_handler() -> bool:
    return _test_handler is not None


class LLMClient:
    """Async OpenAI client bound to the engine settings."""

    def __init__(self) -> None:
        self._client: Any = None

    @property
    def configured(self) -> bool:
        return settings.llm_configured

    @staticmethod
    def has_test_handler() -> bool:
        return _test_handler is not None

    def _get_client(self) -> Any:
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url or None,
                timeout=settings.task_timeout_seconds,
                max_retries=0,  # retries are handled explicitly below
            )
        return self._client

    async def structured(
        self,
        *,
        purpose: str,
        system: str,
        prompt: str,
        schema: type[T],
        user_id: str,
        execution_id: str | None = None,
        temperature: float = 0.2,
    ) -> T:
        """One structured model call with usage accounting."""

        # 1) In-process test handler (pytest) — highest priority, explicit.
        if _test_handler is not None:
            import inspect

            try:
                params = inspect.signature(_test_handler).parameters
                result = (
                    _test_handler(purpose, schema, prompt, system)
                    if len(params) >= 4
                    else _test_handler(purpose, schema, prompt)
                )
            except (TypeError, ValueError):
                result = _test_handler(purpose, schema, prompt)
            if inspect.isawaitable(result):
                result = await result
            if not isinstance(result, schema):
                raise LLMCallError(f"Test handler returned wrong type for {purpose}")
            await self._record_usage(purpose, "test-handler", 0, 0, user_id, execution_id)
            return result

        # 2) Opt-in dev fake transport (never in production — enforced at startup).
        if settings.fake_llm:
            from .testing.fake_transport import fake_structured

            result = fake_structured(purpose, schema, prompt)
            await self._record_usage(purpose, "test-fake", 0, 0, user_id, execution_id)
            return result  # type: ignore[return-value]

        # 3) Real model — or a clear configuration error.
        if not settings.llm_configured:
            raise ConfigUnavailableError(
                "VozCore needs an OpenAI API key to reason. Set OPENAI_API_KEY in the "
                "server .env (see .env.example) and restart the engine — no simulated "
                "responses are ever returned."
            )

        import openai

        client = self._get_client()
        last_error: Exception | None = None
        attempts = settings.llm_max_retries + 1

        for attempt in range(attempts):
            try:
                completion = await client.chat.completions.parse(
                    model=settings.openai_model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    response_format=schema,
                    temperature=temperature,
                )
                parsed = completion.choices[0].message.parsed
                if parsed is None:
                    raise LLMCallError(
                        f"The model returned no structured output for '{purpose}'.",
                        details={"finish_reason": completion.choices[0].finish_reason},
                    )
                usage = completion.usage
                await self._record_usage(
                    purpose,
                    completion.model or settings.openai_model,
                    getattr(usage, "prompt_tokens", 0) or 0,
                    getattr(usage, "completion_tokens", 0) or 0,
                    user_id,
                    execution_id,
                )
                return parsed  # type: ignore[return-value]

            except openai.RateLimitError as exc:
                last_error = exc
                if attempt < attempts - 1:
                    await asyncio.sleep(min(2**attempt, 8))
                    continue
            except openai.APIConnectionError as exc:
                last_error = exc
                if attempt < min(2, attempts - 1):
                    await asyncio.sleep(1)
                    continue
            except openai.AuthenticationError as exc:
                raise LLMCallError(
                    "OpenAI rejected the configured API key. Check OPENAI_API_KEY in "
                    "the server .env and restart the engine.",
                    details={"type": "auth"},
                ) from exc
            except openai.BadRequestError as exc:
                raise LLMCallError(
                    f"OpenAI rejected the request for '{purpose}': {exc}",
                    details={"type": "bad_request"},
                ) from exc
            except openai.APIStatusError as exc:
                last_error = exc
                if exc.status_code >= 500 and attempt < attempts - 1:
                    await asyncio.sleep(min(2**attempt, 8))
                    continue

        if isinstance(last_error, openai.APIConnectionError):
            raise LLMCallError(
                "Could not reach api.openai.com — check network/firewall access from "
                "the VozCore host.",
                details={"type": "connection"},
            ) from last_error
        raise LLMCallError(
            f"OpenAI request failed for '{purpose}': {last_error}",
            details={"type": "api_error"},
        ) from last_error

    async def _record_usage(
        self,
        purpose: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        user_id: str,
        execution_id: str | None,
    ) -> None:
        from . import db

        def _insert(conn):
            db.execute(
                conn,
                """
                INSERT INTO model_usage
                  (user_id, execution_id, purpose, model, prompt_tokens, completion_tokens, total_tokens)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    execution_id,
                    purpose,
                    model,
                    int(prompt_tokens),
                    int(completion_tokens),
                    int(prompt_tokens) + int(completion_tokens),
                ),
            )

        try:
            await asyncio.to_thread(db.run_in_user_txn, user_id, _insert)
        except Exception:  # usage accounting must never break an execution
            logger.exception("failed to record model usage")


llm = LLMClient()
