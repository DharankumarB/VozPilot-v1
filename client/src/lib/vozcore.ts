/** VozCore engine client — Phase 2 + Phase 3 multi-agent orchestration types + calls. */

import { api } from './api';

export type ExecutionStatus = 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface VozCoreHealth {
  status: 'ok' | 'degraded';
  engine: string;
  phase: number;
  database: string;
  agentsPaused?: boolean;
  pricingConfigured?: boolean;
  searchConfigured?: boolean;
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
  enabled?: boolean;
  role: string;
  capabilities: string[];
  tools?: string[];
  operational: boolean;
  executionMode: 'llm';
  timeoutSeconds?: number;
  maxRetries?: number;
  lastActiveAt?: string | null;
  notes?: string | null;
}

export interface VozCoreAgentsPayload {
  coordinator: {
    key: string;
    name: string;
    role: string;
    status: string;
    enabled?: boolean;
    operational: boolean;
    executionMode: 'llm';
  };
  agents: VozCoreAgent[];
  agentsPaused?: boolean;
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
  id?: string;
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

export interface ResultArtifact {
  kind: string;
  title: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SourceReference {
  title: string;
  url?: string | null;
  provider?: string;
  snippet?: string | null;
  verified?: boolean;
}

export interface ExecutionResult {
  agentTaskId: string;
  taskKey: string;
  attempt: number;
  agent_key: string;
  status: 'completed' | 'failed' | 'waiting_approval' | 'cancelled';
  result_summary: string;
  summary?: string;
  detailed_output: string;
  artifacts?: ResultArtifact[];
  source_references?: SourceReference[];
  missing_information: string[];
  errors: string[];
  error_details?: Record<string, unknown> | string[] | null;
  model: string | null;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ExecutionEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentMessageDto {
  id: string;
  executionId: string | null;
  taskId: string | null;
  senderKey: string;
  recipientKey: string;
  messageType: string;
  subject: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionDetail {
  execution: Execution;
  steps: ExecutionStep[];
  tasks: ExecutionTask[];
  results: ExecutionResult[];
  messages?: AgentMessageDto[];
  events: ExecutionEvent[];
  lastEventId: number;
}

export interface AgentCapabilityDto {
  id: string;
  capabilityKey: string;
  label: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
}

export interface AgentToolDto {
  id: string;
  toolKey: string;
  label: string;
  description: string;
  provider: string | null;
  requiresApproval: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface AgentPermissionDto {
  id: string;
  permissionKey: string;
  scope: string;
  allowed: boolean;
  requiresApproval: boolean;
  rateLimitPerHour: number;
  maxTasksPerRun: number;
  updatedAt: string;
}

export interface AgentExecutionLogDto {
  id: string;
  executionId: string | null;
  agentTaskId: string | null;
  agentKey?: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  message: string;
  metadata: Record<string, unknown>;
  durationMs: number | null;
  createdAt: string;
}

export interface AgentDetailPayload {
  agent: {
    id: string;
    key: string;
    name: string;
    description: string;
    icon: string;
    status: 'active' | 'idle' | 'paused' | 'error';
    enabled: boolean;
    customInstructions: string | null;
    defaultInstructions: string;
    responsibilities: string[];
    config: Record<string, unknown>;
    timeoutSeconds: number;
    maxRetries: number;
    retryBackoffSeconds: number;
    currentTask: { id: string; title: string; executionId: string | null } | null;
    lastActiveAt: string | null;
    updatedAt: string;
  };
  agentsPaused: boolean;
  capabilities: AgentCapabilityDto[];
  tools: AgentToolDto[];
  permissions: AgentPermissionDto[];
  metrics: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    runningTasks: number;
    waitingTasks: number;
    retriedTasks: number;
    avgDurationMs: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usageCalls: number;
    pricingConfigured: boolean;
    estimatedCostUsd: number | null;
  };
  taskHistory: {
    id: string;
    executionId: string;
    taskKey: string;
    title: string;
    description: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    approvalRequired: boolean;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  }[];
  logs: AgentExecutionLogDto[];
  messages: AgentMessageDto[];
}

export interface MonitoringSummary {
  agentsPaused: boolean;
  llmConfigured: boolean;
  llmMode: string;
  model: string | null;
  pricingConfigured: boolean;
  agents: {
    id: string;
    key: string;
    name: string;
    icon: string;
    status: string;
    enabled: boolean;
    operational: boolean;
    currentTaskTitle: string | null;
    lastActiveAt: string | null;
    completedTasks: number;
    failedTasks: number;
    runningTasks: number;
  }[];
  executions: {
    total: number;
    running: number;
    waiting: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  tasks: {
    failed: number;
    retried: number;
    running: number;
  };
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgDurationMs: number | null;
    estimatedCostUsd: number | null;
  };
  recentLogs: AgentExecutionLogDto[];
}

export interface ContentDraftDto {
  id: string;
  title: string;
  contentType: string;
  brandName: string;
  channel: string | null;
  body: string;
  metadata: Record<string, unknown>;
  status: 'draft' | 'pending_approval' | 'approved' | 'published' | 'archived';
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectAgentTestResult {
  execution: Execution;
  result: {
    execution_id: string;
    task_id: string;
    agent_id: string;
    status: 'completed' | 'failed' | 'waiting_approval' | 'cancelled';
    summary: string;
    detailed_output: string;
    artifacts: ResultArtifact[];
    source_references: SourceReference[];
    error_details: Record<string, unknown> | string[] | null;
    start_time: string;
    completion_time: string;
    duration_ms?: number | null;
    model?: string | null;
    total_tokens?: number | null;
    estimated_cost_usd?: number | null;
  };
}

export const LIVE_STATUSES: ExecutionStatus[] = ['planning', 'running', 'waiting'];

export function isLiveStatus(status: ExecutionStatus): boolean {
  return status === 'planning' || status === 'running';
}

export const vozcore = {
  health: () => api.get<VozCoreHealth>('/api/vozcore/health'),
  monitoring: () => api.get<MonitoringSummary>('/api/vozcore/monitoring'),
  agents: () => api.get<VozCoreAgentsPayload>('/api/vozcore/agents'),
  pauseAll: () => api.post<{ agentsPaused: boolean }>('/api/vozcore/agents/pause-all', {}),
  resumeAll: () => api.post<{ agentsPaused: boolean }>('/api/vozcore/agents/resume-all', {}),
  agentDetail: (agentIdOrKey: string) => api.get<AgentDetailPayload>(`/api/vozcore/agents/${agentIdOrKey}`),
  updateAgentRuntime: (
    agentIdOrKey: string,
    payload: {
      enabled?: boolean;
      status?: 'active' | 'idle' | 'paused' | 'error';
      customInstructions?: string | null;
      timeoutSeconds?: number;
      maxRetries?: number;
    },
  ) => api.patch<AgentDetailPayload>(`/api/vozcore/agents/${agentIdOrKey}/runtime`, payload),
  toggleCapability: (agentIdOrKey: string, capKey: string, enabled: boolean) =>
    api.patch<AgentDetailPayload>(`/api/vozcore/agents/${agentIdOrKey}/capabilities/${capKey}`, { enabled }),
  updateTool: (agentIdOrKey: string, toolKey: string, payload: { enabled?: boolean; requiresApproval?: boolean }) =>
    api.patch<AgentDetailPayload>(`/api/vozcore/agents/${agentIdOrKey}/tools/${toolKey}`, payload),
  updatePermission: (
    agentIdOrKey: string,
    permKey: string,
    payload: {
      allowed?: boolean;
      requiresApproval?: boolean;
      rateLimitPerHour?: number;
      maxTasksPerRun?: number;
    },
  ) => api.patch<AgentDetailPayload>(`/api/vozcore/agents/${agentIdOrKey}/permissions/${permKey}`, payload),
  testAgent: (agentIdOrKey: string, payload: { prompt: string; parameters?: Record<string, unknown> }) =>
    api.post<DirectAgentTestResult>(`/api/vozcore/agents/${agentIdOrKey}/test`, payload),
  listContentDrafts: () => api.get<ContentDraftDto[]>('/api/vozcore/content-drafts'),
  updateContentDraft: (draftId: string, payload: { title?: string; body?: string; channel?: string | null; brandName?: string }) =>
    api.patch<ContentDraftDto>(`/api/vozcore/content-drafts/${draftId}`, payload),
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
  direct_agent_test_started: 'Direct agent test started',
  direct_agent_test_finished: 'Direct agent test finished',
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
  'direct_agent_test_started',
  'direct_agent_test_finished',
]);
