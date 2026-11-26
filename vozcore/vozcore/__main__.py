"""`python -m vozcore` — run the VozCore engine with uvicorn."""

from __future__ import annotations

import logging

import uvicorn

from .config import settings


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    print(
        f"\n  VozCore engine — Phase 2 orchestration\n"
        f"  LLM mode: {settings.llm_mode}"
        f"{' (' + settings.openai_model + ')' if settings.llm_configured else ''}\n"
        f"  Listening on http://127.0.0.1:{settings.port}\n"
    )
    uvicorn.run(
        "vozcore.api:app",
        host="127.0.0.1",
        port=settings.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
