"""Shared execution state flowing through the LangGraph workflow."""

from __future__ import annotations

from typing import Any, Optional, TypedDict


class ExecutionState(TypedDict, total=False):
    # identity / inputs
    user_id: str
    execution_id: str
    command: str
    conversation_id: Optional[str]
    source_message_id: Optional[str]
    attached_tasks: list[dict[str, Any]]

    # pipeline artefacts
    intent: dict[str, Any]
    memory: list[dict[str, Any]]
    plan: dict[str, Any]
    selected_agents: list[dict[str, Any]]
    tasks: list[dict[str, Any]]
    results: list[dict[str, Any]]
    evaluation: dict[str, Any]
    final_response: dict[str, Any]
    clarification: Optional[str]

    # control flow
    cancelled: bool
    attempt_round: int
    retry_keys: list[str]
    step_seq: int
    error: Optional[str]
