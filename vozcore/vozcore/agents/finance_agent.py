"""Agent 5 — Finance Agent (authorized ledger, budgets & anomaly detection).

Capabilities:
- Record explicitly authorized income and expenses (`record_authorized_transaction`).
- Categorize financial transactions & compute exact `Decimal` summaries (`read_authorized_ledger`).
- Calculate budgets & analyze project costs (`upsert_budget`, `read_authorized_ledger`).
- Detect unusual spending patterns (`detect_spending_anomalies`).
- Prepare budget recommendations.

Strict safety rules:
- Uses real connected/authorized workspace ledger data ONLY — never invents
  transactions, figures, or account balances.
- NEVER executes payments, transfers, purchases, or investments (hard-blocked).
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from statistics import mean
from typing import Any

from pydantic import BaseModel, Field

from .. import db
from ..db import Utf8Json as JSON
from ..security import PermissionDeniedError
from .base import (
    AgentExecutionContext,
    BaseAgent,
    CapabilitySpec,
    PermissionSpec,
    RetryPolicy,
    ToolSpec,
)

FORBIDDEN_EXECUTION_RE = re.compile(
    r"\b(wire\s+money|send\s+payment|execute\s+(a\s+)?(payment|transfer|trade|purchase|investment)|buy\s+(stock|crypto|shares))\b",
    re.I,
)


class AuthorizedTransactionEntry(BaseModel):
    entry_type: str = "expense"  # income | expense
    amount: float = 0.0
    currency: str = "USD"
    category: str = "general"
    counterparty: str = ""
    description: str = ""
    occurred_on: str | None = None  # YYYY-MM-DD


class BudgetProposal(BaseModel):
    name: str
    category: str = "general"
    period: str = "monthly"
    limit_amount: float = 0.0
    currency: str = "USD"


class FinanceLLMOutput(BaseModel):
    completed: bool = True
    result_summary: str = ""
    detailed_output: str = ""
    record_transactions: list[AuthorizedTransactionEntry] = Field(default_factory=list)
    budgets_to_save: list[BudgetProposal] = Field(default_factory=list)
    budget_recommendations: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)


def _dec(val: Any) -> Decimal:
    try:
        d = Decimal(str(val))
        return d if d >= 0 else Decimal("0.00")
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0.00")


class FinanceAgent(BaseAgent):
    agent_id = "finance"
    name = "Finance Agent"
    description = (
        "Records authorized income/expenses, categorizes transactions, calculates "
        "budgets and project costs, flags spending anomalies, and prepares budget recommendations."
    )
    icon = "wallet"
    selection_hints = [
        "invoice",
        "budget",
        "expense",
        "income",
        "spend",
        "spending",
        "cost",
        "finance",
        "financial",
        "ledger",
        "transaction",
        "anomaly",
    ]
    capabilities = [
        CapabilitySpec("transaction_recording", "Record authorized income & expenses", "Persist explicitly authorized income and expense entries."),
        CapabilitySpec("transaction_categorization", "Categorize & summarize", "Group transactions by category, counterparty and period with exact Decimal math."),
        CapabilitySpec("budget_and_project_costs", "Budget & project cost analysis", "Compare spending against budgets and aggregate costs per project."),
        CapabilitySpec("anomaly_detection", "Spending anomaly detection", "Flag duplicate charges, category spikes, and budget overruns."),
        CapabilitySpec("budget_recommendations", "Budget recommendations", "Prepare concrete cost-control and allocation recommendations."),
    ]
    system_instructions = (
        "You are the Finance Agent in the VozPilot autonomous workforce. "
        "Analyze authorized financial data with exact numeric discipline.\n"
        "- NEVER invent transactions, balances, revenues, or expenses.\n"
        "- Base all summaries strictly on `AUTHORIZED WORKSPACE LEDGER` and explicit figures "
        "supplied by the user in the task.\n"
        "- Populate `record_transactions` ONLY when the user explicitly provides transaction "
        "amounts to record.\n"
        "- NEVER claim to execute payments, purchases, bank transfers, or investments — you are "
        "strictly prohibited from moving money or placing orders."
    )
    permission_requirements = [
        PermissionSpec("execute", "workspace", "Execute assigned financial analysis subtasks.", default_allowed=True, rate_limit_per_hour=60),
        PermissionSpec("finance.read", "workspace", "Read authorized workspace transactions and budgets.", default_allowed=True),
        PermissionSpec("finance.write", "workspace", "Record user-authorized ledger entries and budget limits.", default_allowed=True),
    ]
    timeout_seconds = 90.0
    retry_policy = RetryPolicy(max_attempts=2, backoff_seconds=0.5)

    def build_tools(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                tool_key="read_authorized_ledger",
                name="Read Authorized Ledger & Budgets",
                description="Query workspace `financial_transactions` and `financial_budgets` with exact Decimal totals.",
                handler=self._tool_read_ledger,
                category="workspace_read",
            ),
            ToolSpec(
                tool_key="record_authorized_transaction",
                name="Record Authorized Transaction",
                description="Insert an explicitly authorized income or expense record.",
                handler=self._tool_record_tx,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="upsert_budget",
                name="Save Budget Limit",
                description="Create or update a category/project budget in `financial_budgets`.",
                handler=self._tool_upsert_budget,
                category="workspace_write",
            ),
            ToolSpec(
                tool_key="detect_spending_anomalies",
                name="Detect Spending Anomalies",
                description="Run deterministic duplicate-charge, outlier and budget-overrun checks.",
                handler=self._tool_detect_anomalies,
                category="domain",
            ),
        ]

    async def _tool_read_ledger(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        ctx.check_permission("finance.read")

        def _query(conn):
            txs = db.rows(
                conn,
                """
                SELECT ft.id, ft.entry_type, ft.amount, ft.currency, ft.category,
                       ft.counterparty, ft.description, ft.occurred_on, ft.project_id,
                       p.name AS project_name
                  FROM financial_transactions ft
                  LEFT JOIN projects p ON p.id = ft.project_id
                 ORDER BY ft.occurred_on DESC, ft.created_at DESC
                 LIMIT 200
                """,
            )
            budgets = db.rows(
                conn,
                """
                SELECT b.id, b.name, b.category, b.period, b.limit_amount, b.currency,
                       b.project_id, p.name AS project_name
                  FROM financial_budgets b
                  LEFT JOIN projects p ON p.id = b.project_id
                 ORDER BY b.created_at DESC
                """,
            )
            return txs, budgets

        txs, budgets = await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _query)

        total_income = Decimal("0.00")
        total_expense = Decimal("0.00")
        by_category: dict[str, Decimal] = defaultdict(lambda: Decimal("0.00"))
        by_project: dict[str, Decimal] = defaultdict(lambda: Decimal("0.00"))

        serialized_txs = []
        for t in txs:
            amt = _dec(t["amount"])
            if t["entry_type"] == "income":
                total_income += amt
            else:
                total_expense += amt
                by_category[t["category"]] += amt
                if t.get("project_name"):
                    by_project[t["project_name"]] += amt
            serialized_txs.append(
                {
                    "id": str(t["id"]),
                    "entryType": t["entry_type"],
                    "amount": float(amt),
                    "currency": t["currency"],
                    "category": t["category"],
                    "counterparty": t.get("counterparty") or "",
                    "description": t.get("description") or "",
                    "occurredOn": str(t["occurred_on"]),
                    "projectName": t.get("project_name"),
                }
            )

        budget_status = []
        for b in budgets:
            lim = _dec(b["limit_amount"])
            spent = by_category.get(b["category"], Decimal("0.00"))
            budget_status.append(
                {
                    "id": str(b["id"]),
                    "name": b["name"],
                    "category": b["category"],
                    "period": b["period"],
                    "limitAmount": float(lim),
                    "spentAmount": float(spent),
                    "remainingAmount": float(lim - spent),
                    "utilizationPercent": round(float(spent / lim * 100), 1) if lim > 0 else 0.0,
                    "overBudget": spent > lim,
                    "currency": b["currency"],
                }
            )

        return {
            "transactionCount": len(serialized_txs),
            "totalIncome": float(total_income),
            "totalExpense": float(total_expense),
            "netPosition": float(total_income - total_expense),
            "expenseByCategory": {k: float(v) for k, v in by_category.items()},
            "expenseByProject": {k: float(v) for k, v in by_project.items()},
            "transactions": serialized_txs,
            "budgets": budget_status,
        }

    async def _tool_record_tx(self, ctx: AgentExecutionContext, entry: dict[str, Any]) -> dict[str, Any]:
        ctx.check_permission("finance.write")
        etype = (entry.get("entry_type") or "expense").strip().lower()
        if etype not in {"income", "expense"}:
            etype = "expense"
        amt = _dec(entry.get("amount"))
        occ = entry.get("occurred_on")
        try:
            occ_date = date.fromisoformat(str(occ)) if occ else date.today()
        except ValueError:
            occ_date = date.today()

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO financial_transactions
                  (user_id, project_id, entry_type, amount, currency, category,
                   counterparty, description, occurred_on, source, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'authorized_agent', %s)
                RETURNING id, entry_type, amount, currency, category, counterparty, description, occurred_on
                """,
                (
                    ctx.user_id,
                    entry.get("project_id"),
                    etype,
                    amt,
                    (entry.get("currency") or "USD")[:8].upper(),
                    (entry.get("category") or "general")[:60].lower(),
                    (entry.get("counterparty") or "")[:160],
                    (entry.get("description") or "")[:500],
                    occ_date,
                    JSON({"executionId": ctx.execution_id}),
                ),
            )
            return {
                "id": str(row["id"]),  # type: ignore[index]
                "entryType": row["entry_type"],  # type: ignore[index]
                "amount": float(_dec(row["amount"])),  # type: ignore[index]
                "currency": row["currency"],  # type: ignore[index]
                "category": row["category"],  # type: ignore[index]
                "counterparty": row["counterparty"],  # type: ignore[index]
                "occurredOn": str(row["occurred_on"]),  # type: ignore[index]
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_upsert_budget(self, ctx: AgentExecutionContext, budget: dict[str, Any]) -> dict[str, Any]:
        ctx.check_permission("finance.write")
        lim = _dec(budget.get("limit_amount"))
        period = (budget.get("period") or "monthly").strip().lower()
        if period not in {"weekly", "monthly", "quarterly", "annual", "project"}:
            period = "monthly"

        def _insert(conn):
            row = db.row(
                conn,
                """
                INSERT INTO financial_budgets (user_id, name, category, period, limit_amount, currency)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id, name, category, period, limit_amount, currency
                """,
                (
                    ctx.user_id,
                    (budget.get("name") or "Budget")[:160],
                    (budget.get("category") or "general")[:60].lower(),
                    period,
                    lim,
                    (budget.get("currency") or "USD")[:8].upper(),
                ),
            )
            return {
                "id": str(row["id"]),  # type: ignore[index]
                "name": row["name"],  # type: ignore[index]
                "category": row["category"],  # type: ignore[index]
                "period": row["period"],  # type: ignore[index]
                "limitAmount": float(_dec(row["limit_amount"])),  # type: ignore[index]
                "currency": row["currency"],  # type: ignore[index]
            }

        return await asyncio.to_thread(db.run_in_user_txn, ctx.user_id, _insert)

    async def _tool_detect_anomalies(self, ctx: AgentExecutionContext, ledger: dict[str, Any]) -> list[dict[str, Any]]:
        anomalies: list[dict[str, Any]] = []
        expenses = [t for t in ledger.get("transactions", []) if t["entryType"] == "expense"]

        # 1. Duplicate charge detection (same amount + counterparty + date)
        seen: dict[tuple[Any, ...], dict[str, Any]] = {}
        for tx in expenses:
            sig = (tx["amount"], tx["counterparty"].lower(), tx["occurredOn"])
            if tx["amount"] > 0 and sig in seen:
                anomalies.append(
                    {
                        "kind": "duplicate_charge",
                        "severity": "high",
                        "detail": f"Potential duplicate expense of {tx['amount']} {tx['currency']} at '{tx['counterparty'] or tx['category']}' on {tx['occurredOn']}.",
                    }
                )
            seen[sig] = tx

        # 2. Category outlier detection (> 2.5x category average when >= 3 items)
        cat_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for tx in expenses:
            cat_groups[tx["category"]].append(tx)
        for cat, items in cat_groups.items():
            if len(items) >= 3:
                avg = mean(i["amount"] for i in items)
                if avg > 0:
                    for i in items:
                        if i["amount"] >= avg * 2.5:
                            anomalies.append(
                                {
                                    "kind": "category_spike",
                                    "severity": "medium",
                                    "detail": f"Expense of {i['amount']:.2f} in '{cat}' is {i['amount']/avg:.1f}x the category average ({avg:.2f}).",
                                }
                            )

        # 3. Budget overruns
        for b in ledger.get("budgets", []):
            if b.get("overBudget"):
                anomalies.append(
                    {
                        "kind": "budget_overrun",
                        "severity": "high",
                        "detail": f"Budget '{b['name']}' ({b['category']}) exceeded: spent {b['spentAmount']:.2f} vs limit {b['limitAmount']:.2f} {b['currency']}.",
                    }
                )
        return anomalies

    async def execute_task(self, ctx: AgentExecutionContext) -> dict[str, Any]:
        combined_text = f"{ctx.input.title}\n{ctx.input.description}"
        if FORBIDDEN_EXECUTION_RE.search(combined_text):
            raise PermissionDeniedError(
                "Finance Agent is strictly prohibited from executing payments, transfers, purchases, or investments."
            )

        # Pre-record any structured transactions explicitly passed in `parameters.transactions`
        explicit_txs = ctx.input.parameters.get("transactions")
        recorded_items: list[dict[str, Any]] = []
        if isinstance(explicit_txs, list):
            for entry in explicit_txs[:20]:
                if isinstance(entry, dict) and entry.get("amount") is not None:
                    rec = await ctx.invoke_tool("record_authorized_transaction", entry=entry)
                    recorded_items.append(rec)

        ledger = await ctx.invoke_tool("read_authorized_ledger")
        anomalies = await ctx.invoke_tool("detect_spending_anomalies", ledger=ledger)

        ctx.add_source(
            title="Workspace Authorized Financial Ledger",
            source_type="database",
            verified=True,
            snippet=f"{ledger['transactionCount']} authorized transactions, {len(ledger['budgets'])} budgets",
        )

        prompt = (
            f"TASK {ctx.input.task_key}: {ctx.input.title}\n"
            f"{ctx.input.description}\n\n"
            + (f"Acceptance criteria: {ctx.input.acceptance}\n\n" if ctx.input.acceptance else "")
            + (f"CONTEXT:\n{ctx.input.context_summary}\n\n" if ctx.input.context_summary else "")
            + f"AUTHORIZED WORKSPACE LEDGER:\n{ledger}\n\n"
            + f"DETECTED SPENDING ANOMALIES:\n{anomalies}\n\n"
            "Analyze strictly from authorized figures. Never invent transactions or balances."
        )

        parsed: FinanceLLMOutput = await ctx.call_llm_structured(schema=FinanceLLMOutput, prompt=prompt)

        # Persist any user-authorized transactions extracted from the prompt ONLY when numbers appear in user text
        has_digits = bool(re.search(r"\d", combined_text))
        if has_digits and parsed.record_transactions and not explicit_txs:
            if ctx.tool_states.get("record_authorized_transaction", {}).get("enabled", True):
                for tx in parsed.record_transactions[:10]:
                    if tx.amount > 0:
                        rec = await ctx.invoke_tool("record_authorized_transaction", entry=tx.model_dump())
                        recorded_items.append(rec)

        saved_budgets: list[dict[str, Any]] = []
        if has_digits and parsed.budgets_to_save and ctx.tool_states.get("upsert_budget", {}).get("enabled", True):
            for b in parsed.budgets_to_save[:5]:
                if b.limit_amount > 0:
                    sb = await ctx.invoke_tool("upsert_budget", budget=b.model_dump())
                    saved_budgets.append(sb)

        if recorded_items or saved_budgets:
            ledger = await ctx.invoke_tool("read_authorized_ledger")
            anomalies = await ctx.invoke_tool("detect_spending_anomalies", ledger=ledger)

        ctx.add_artifact(
            "financial_summary",
            "Authorized Financial Summary & Anomaly Check",
            {
                "transactionCount": ledger["transactionCount"],
                "totalIncome": ledger["totalIncome"],
                "totalExpense": ledger["totalExpense"],
                "netPosition": ledger["netPosition"],
                "expenseByCategory": ledger["expenseByCategory"],
                "expenseByProject": ledger["expenseByProject"],
                "budgets": ledger["budgets"],
                "anomalies": anomalies,
                "newlyRecordedTransactions": recorded_items,
                "recommendations": parsed.budget_recommendations,
            },
        )

        return {
            "status": "completed" if parsed.completed else "failed",
            "summary": parsed.result_summary,
            "detailed_output": parsed.detailed_output,
            "missing_information": parsed.missing_information,
        }
