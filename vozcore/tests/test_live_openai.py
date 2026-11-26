"""Live OpenAI connectivity check — skipped unless OPENAI_API_KEY is set.

Run with:  OPENAI_API_KEY=sk-... pytest -m live tests/test_live_openai.py
This is the one test that exercises the real model path end-to-end.
"""

from __future__ import annotations

import os

import pytest

from vozcore import llm
from vozcore.config import settings
from vozcore.schemas import IntentAnalysis

pytestmark = pytest.mark.live


@pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY not set — live model verification requires credentials",
)
def test_real_openai_structured_call():
    """A genuine structured-output call against the configured model."""
    settings.openai_api_key = os.environ["OPENAI_API_KEY"]
    settings.fake_llm = False
    llm.set_test_handler(None)

    class _NoopUser:
        pass

    # use a dummy user id only for usage accounting; if the DB is unreachable
    # the call still proves connectivity (usage recording fails soft)
    import asyncio

    intent = asyncio.run(
        llm.structured(
            purpose="intent",
            system="You are VozCore, the central AI manager.",
            prompt=(
                "CATALOGUE OF AVAILABLE AGENTS:\n- research (Research Agent): briefs\n\n"
                "USER COMMAND:\nSummarise the biggest risks across my open projects\n\nAnalyse the command."
            ),
            schema=IntentAnalysis,
            user_id="00000000-0000-0000-0000-000000000000",
        )
    )
    assert isinstance(intent, IntentAnalysis)
    assert intent.objective
    assert intent.complexity in {"simple", "moderate", "complex"}
