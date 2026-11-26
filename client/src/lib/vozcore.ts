/** VozCore engine client — Phase 2 orchestration types + calls. */

import { api } from './api';

export type ExecutionStatus = 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface VozCoreHealth {
  status: 'ok' | 'degraded';
  engine: string;
  phase: number;
  database: string;
  llm: { configured: boolean; mode: 'openai' | 'unconfigured' | 'test-fake'; model: string | null };
  graph: { nodes: string[]; conditionalRouting: boolean; parallelExecution: boolean; boundedRetries: boolean; checkpoints: string };
  limits: { maxTasks: number; maxAttempts: number; taskTimeoutSeconds: number; executionTimeoutSeconds: number };
  message: string | null;
}

export interface VozCoreAgent {
  key: string;
  agentId?: string;
  name: string;
  status: string;
  role: string;
  capabilities: string[];
  operational: boolean;
  executionMode: 'llm';
  notes?: string | null;
}

export interface VozCoreAgentsPayload {
  coordinator: { key: string; name: string; role: string; status: string; operational: boolean; executionMode: 'llm' };
  agents: VozCoreAgent[];
  llmMode: string;
}

export interface PlanTask {
  task_key: string;
  title: string;
  description: string;
  agent_key: string;
  depends_on: string[];
  wave: number;
  priority: number;
  approval_required: boolean;
  acceptance: string;
}

export interface ExecutionPlanPayload {
  summary: string;
  tasks: PlanTask[];
  parallelizable: boolean;
}

export interface Execution {
  id: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  command: string;
  status: ExecutionStatus;
  intent: Record<string, unknown> | null;
  plan: ExecutionPlanPayload | null;
  clarification: string | null;
  finalResponse: string | null;
  error: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStep {
  stepKey: string;
  seq: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ExecutionTask {
  task_key: string;
  agent_key: string;
  agent_id: string | null;
  title: string;
  description: string;
  depends_on: string[];
  wave: number;
  priority: number;
  approval_required: boolean;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface ExecutionResult {
  agentTaskId: string;
  taskKey: string;
  attempt: number;
  agent_key: string;
  status: 'completed' | 'failed';
  result_summary: string;
  detailed_output: string;
  missing_information: string[];
  errors: string[];
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ExecutionEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionDetail {
  execution: Execution;
  steps: ExecutionStep[];
  tasks: ExecutionTask[];
  results: ExecutionResult[];
  events: ExecutionEvent[];
  lastEventId: number;
}

export const LIVE_STATUSES: ExecutionStatus[] = ['planning', 'running', 'waiting'];

export function isLiveStatus(status: ExecutionStatus): boolean {
  return status === 'planning' || status === 'running';
}

export const vozcore = {
  health: () => api.get<VozCoreHealth>('/api/vozcore/health'),
  agents: () => api.get<VozCoreAgentsPayload>('/api/vozcore/agents'),
  plan: (command: string) =>
    api.post<{ intent: Record<string, unknown>; plan: ExecutionPlanPayload | null; selectedAgents: VozCoreAgent[]; clarification: string | null }>(
      '/api/vozcore/plan',
      { command },
    ),
  start: (payload: { command: string; conversationId?: string | null; sourceMessageId?: string | null }) =>
    api.post<{ execution: Execution }>('/api/vozcore/command', payload),
  list: (conversationId?: string) =>
    api.get<Execution[]>(`/api/vozcore/executions${conversationId ? `?conversationId=${conversationId}` : ''}`),
  detail: (executionId: string, sinceEventId = 0) =>
    api.get<ExecutionDetail>(`/api/vozcore/executions/${executionId}?sinceEventId=${sinceEventId}`),
  cancel: (executionId: string) =>
    api.post<{ execution: Execution }>(`/api/vozcore/executions/${executionId}/cancel`, {}),
};

/** Human labels for graph steps (the twelve LangGraph nodes). */
export const STEP_LABELS: Record<string, string> = {
  receive_command: 'Receive command',
  understand_intent: 'Understand intent',
  retrieve_memory: 'Retrieve memory',
  create_plan: 'Create plan',
  select_agents: 'Select agents',
  dispatch_tasks: 'Dispatch tasks',
  execute_agents: 'Execute agents',
  collect_results: 'Collect results',
  evaluate_results: 'Evaluate results',
  retry_or_reassign: 'Retry / reassign',
  generate_final_response: 'Generate response',
  save_execution_memory: 'Save memory',
};

/** Human labels for execution timeline events. */
export const EVENT_LABELS: Record<string, string> = {
  execution_created: 'Execution created',
  command_received: 'Command received',
  intent_understood: 'Intent understood',
  memory_retrieved: 'Memory retrieved',
  plan_created: 'Plan created',
  agents_selected: 'Agents selected',
  agents_remapped: 'Agents remapped',
  tasks_dispatched: 'Tasks dispatched',
  approval_checkpoints_created: 'Approval checkpoints created',
  task_started: 'Task started',
  task_completed: 'Task completed',
  task_failed: 'Task failed',
  task_waiting: 'Task waiting',
  task_cancelled: 'Task cancelled',
  retry_scheduled: 'Retry scheduled',
  results_collected: 'Results collected',
  evaluation_complete: 'Evaluation complete',
  response_generated: 'Response generated',
  memory_saved: 'Memory saved',
  memory_skipped: 'Memory skipped',
  cancellation_requested: 'Cancellation requested',
  execution_finished: 'Execution finished',
  execution_failed: 'Execution failed',
  step_started: 'Step started',
  step_skipped: 'Step skipped',
  step_failed: 'Step failed',
};

/** Timeline shows domain events only — step noise lives in the progress strip. */
export const TIMELINE_EVENTS = new Set([
  'command_received',
  'intent_understood',
  'memory_retrieved',
  'plan_created',
  'agents_selected',
  'agents_remapped',
  'tasks_dispatched',
  'approval_checkpoints_created',
  'task_started',
  'task_completed',
  'task_failed',
  'task_waiting',
  'task_cancelled',
  'retry_scheduled',
  'results_collected',
  'evaluation_complete',
  'response_generated',
  'memory_saved',
  'memory_skipped',
  'cancellation_requested',
  'execution_finished',
  'execution_failed',
]);
