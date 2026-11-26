"""Model token pricing & honest cost estimation.

Returns estimated USD cost only when pricing is configured for the model used.
For test transports (`test-handler`, `test-fake`) or unconfigured custom models,
returns None so no fake dollar numbers are ever invented.
"""

from __future__ import annotations

import json
from decimal import Decimal, ROUND_HALF_UP

from .config import settings

# Standard per-1M-token USD rates for common OpenAI models (overrideable via
# VOZCORE_MODEL_PRICING_JSON in .env).
DEFAULT_PRICING_PER_1M: dict[str, tuple[Decimal, Decimal]] = {
    "gpt-4o-mini": (Decimal("0.15"), Decimal("0.60")),
    "gpt-4o": (Decimal("2.50"), Decimal("10.00")),
    "gpt-4.1-nano": (Decimal("0.10"), Decimal("0.40")),
    "gpt-4.1-mini": (Decimal("0.40"), Decimal("1.60")),
    "gpt-4.1": (Decimal("2.00"), Decimal("8.00")),
    "o3-mini": (Decimal("1.10"), Decimal("4.40")),
    "o4-mini": (Decimal("1.10"), Decimal("4.40")),
}


def _load_pricing() -> dict[str, tuple[Decimal, Decimal]]:
    table = dict(DEFAULT_PRICING_PER_1M)
    raw = settings.model_pricing_json
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for model_key, entry in parsed.items():
                    if isinstance(entry, dict) and "inputPer1M" in entry and "outputPer1M" in entry:
                        table[model_key.lower()] = (
                            Decimal(str(entry["inputPer1M"])),
                            Decimal(str(entry["outputPer1M"])),
                        )
        except Exception:
            pass
    return table


def match_model_rates(model: str | None) -> tuple[Decimal, Decimal] | None:
    if not model:
        return None
    norm = model.strip().lower()
    if norm in {"test-handler", "test-fake", "unconfigured"}:
        return None
    table = _load_pricing()
    if norm in table:
        return table[norm]
    # Match dated snapshots such as `gpt-4o-mini-2024-07-18`
    for prefix in sorted(table.keys(), key=len, reverse=True):
        if norm.startswith(prefix + "-"):
            return table[prefix]
    return None


def estimate_cost_usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float | None:
    rates = match_model_rates(model)
    if rates is None:
        return None
    in_rate, out_rate = rates
    cost = (
        (Decimal(max(0, int(prompt_tokens))) * in_rate)
        + (Decimal(max(0, int(completion_tokens))) * out_rate)
    ) / Decimal("1000000")
    rounded = cost.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    return float(rounded)
