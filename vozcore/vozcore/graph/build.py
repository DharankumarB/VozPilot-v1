"""LangGraph workflow assembly — twelve nodes, conditional routing.

Flow:
  receive_command → understand_intent ─(clarification)─→ generate_final_response
                        │
                  retrieve_memory → create_plan → select_agents → dispatch_tasks
                        → execute_agents → collect_results → evaluate_results
                              │(needs_retry & budget left)
                        retry_or_reassign → dispatch_tasks  (bounded loop)
                              │
                        generate_final_response → save_execution_memory → END
"""

from __future__ import annotations

from typing import Any

from langgraph.graph import END, START, StateGraph

from .nodes import (
    collect_results,
    create_plan,
    dispatch_tasks,
    evaluate_results,
    execute_agents,
    generate_final_response,
    receive_command,
    retrieve_memory,
    retry_or_reassign,
    save_execution_memory,
    select_agents,
    understand_intent,
)
from .state import ExecutionState

GRAPH_NODES = [
    "receive_command",
    "understand_intent",
    "retrieve_memory",
    "create_plan",
    "select_agents",
    "dispatch_tasks",
    "execute_agents",
    "collect_results",
    "evaluate_results",
    "retry_or_reassign",
    "generate_final_response",
    "save_execution_memory",
]


def _route_after_intent(state: ExecutionState) -> str:
    if state.get("clarification"):
        return "clarify"
    if state.get("cancelled"):
        return "final"
    return "memory"


def _route_after(state: ExecutionState, next_step: str) -> str:
    return "final" if state.get("cancelled") else next_step


def _route_after_evaluate(state: ExecutionState) -> str:
    if state.get("cancelled"):
        return "final"
    evaluation = state.get("evaluation") or {}
    if evaluation.get("needs_retry") and evaluation.get("retry_task_keys"):
        return "retry"
    return "final"


def build_graph():
    graph = StateGraph(ExecutionState)

    graph.add_node("receive_command", receive_command)
    graph.add_node("understand_intent", understand_intent)
    graph.add_node("retrieve_memory", retrieve_memory)
    graph.add_node("create_plan", create_plan)
    graph.add_node("select_agents", select_agents)
    graph.add_node("dispatch_tasks", dispatch_tasks)
    graph.add_node("execute_agents", execute_agents)
    graph.add_node("collect_results", collect_results)
    graph.add_node("evaluate_results", evaluate_results)
    graph.add_node("retry_or_reassign", retry_or_reassign)
    graph.add_node("generate_final_response", generate_final_response)
    graph.add_node("save_execution_memory", save_execution_memory)

    graph.add_edge(START, "receive_command")
    graph.add_edge("receive_command", "understand_intent")

    graph.add_conditional_edges(
        "understand_intent",
        _route_after_intent,
        {"clarify": "generate_final_response", "final": "generate_final_response", "memory": "retrieve_memory"},
    )
    graph.add_conditional_edges(
        "retrieve_memory",
        lambda s: _route_after(s, "create_plan"),
        {"final": "generate_final_response", "create_plan": "create_plan"},
    )
    graph.add_conditional_edges(
        "create_plan",
        lambda s: _route_after(s, "select_agents"),
        {"final": "generate_final_response", "select_agents": "select_agents"},
    )
    graph.add_conditional_edges(
        "select_agents",
        lambda s: _route_after(s, "dispatch_tasks"),
        {"final": "generate_final_response", "dispatch_tasks": "dispatch_tasks"},
    )
    graph.add_conditional_edges(
        "dispatch_tasks",
        lambda s: _route_after(s, "execute_agents"),
        {"final": "generate_final_response", "execute_agents": "execute_agents"},
    )
    graph.add_conditional_edges(
        "execute_agents",
        lambda s: _route_after(s, "collect_results"),
        {"final": "generate_final_response", "collect_results": "collect_results"},
    )
    graph.add_conditional_edges(
        "collect_results",
        lambda s: _route_after(s, "evaluate_results"),
        {"final": "generate_final_response", "evaluate_results": "evaluate_results"},
    )
    graph.add_conditional_edges(
        "evaluate_results",
        _route_after_evaluate,
        {"retry": "retry_or_reassign", "final": "generate_final_response"},
    )
    # bounded loop: retry returns to dispatch (never more than max rounds —
    # evaluate_results forces needs_retry=false once the budget is spent)
    graph.add_edge("retry_or_reassign", "dispatch_tasks")
    graph.add_edge("generate_final_response", "save_execution_memory")
    graph.add_edge("save_execution_memory", END)

    return graph.compile()


# Compiled once per process — stateless between invocations (all state is in
# the ExecutionState payload + PostgreSQL).
compiled_graph = build_graph()


def graph_node_names() -> list[str]:
    return list(GRAPH_NODES)


def describe_graph() -> dict[str, Any]:
    return {
        "nodes": GRAPH_NODES,
        "conditionalRouting": True,
        "parallelExecution": True,
        "boundedRetries": True,
        "checkpoints": "execution_steps + state_checkpoint",
    }
