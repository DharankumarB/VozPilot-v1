/** API DTOs mirrored from the VozPilot server. */

export type AgentStatus = 'active' | 'idle' | 'paused' | 'error';
export type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type WorkflowStatus = 'draft' | 'active' | 'paused';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'dismissed';

export interface UserPreferences {
  appearance?: {
    accent?: 'violet' | 'gold' | 'teal' | 'rose';
    density?: 'comfortable' | 'compact';
  };
  notifications?: {
    approvals?: boolean;
    taskUpdates?: boolean;
    weeklyDigest?: boolean;
    email?: boolean;
    desktop?: boolean;
  };
  agentDefaults?: {
    defaultAgentId?: string | null;
    defaultPriority?: TaskPriority;
  };
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  preferences: UserPreferences;
  createdAt: string;
}

export interface Agent {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  status: AgentStatus;
  responsibilities: string[];
  config: Record<string, unknown>;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts: { total: number; open: number; completed: number };
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  agentId: string | null;
  agentName: string | null;
  agentIcon: string | null;
  agentKey: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusCounts {
  all: number;
  pending: number;
  in_progress: number;
  waiting_approval: number;
  completed: number;
  failed: number;
}

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  position: number;
  config: Record<string, unknown>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  executions: [];
}

export interface Memory {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface MessageAttachment {
  taskId: string;
  title: string;
  status: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments: MessageAttachment[];
  createdAt: string;
  /** Set on assistant replies produced by a real VozCore execution. */
  executionId?: string | null;
}

export interface Approval {
  id: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  resolutionNote: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  agentId: string | null;
  agentName: string | null;
  agentIcon: string | null;
}

export type IntegrationProvider = 'gmail' | 'google_calendar' | 'github' | 'google_drive' | 'notion';

export interface Integration {
  provider: IntegrationProvider;
  status: 'not_connected' | 'connected' | 'error';
  accountEmail: string | null;
  scopes: string[];
  lastError: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  type: string;
  category: string;
  title: string;
  detail: string;
  agentId: string | null;
  agentName: string | null;
  agentIcon: string | null;
  createdAt: string;
}

export interface OverviewStats {
  totalAgents: number;
  activeAgents: number;
  tasksCompleted: number;
  tasksPending: number;
  tasksInProgress: number;
  tasksWaitingApproval: number;
  tasksFailed: number;
  tasksTotal: number;
  pendingApprovals: number;
  automationSuccessRate: number | null;
}

export interface OverviewPayload {
  stats: OverviewStats;
  completionSeries: { date: string; count: number }[];
  agentPerformance: {
    agentId: string;
    name: string;
    icon: string;
    status: string;
    completed: number;
    open: number;
    total: number;
  }[];
  agents: { id: string; name: string; icon: string; status: AgentStatus; lastActiveAt: string | null }[];
  recentActivity: {
    id: string;
    type: string;
    category: string;
    title: string;
    detail: string;
    createdAt: string;
  }[];
  recentTasks: {
    id: string;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    agentName: string | null;
    updatedAt: string;
  }[];
  upcoming: {
    id: string;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string;
    agentName: string | null;
  }[];
}

export interface AnalyticsPayload {
  range: number;
  completionTrend: { date: string; count: number }[];
  statusDistribution: { status: string; count: number }[];
  priorityDistribution: { priority: string; count: number }[];
  agentActivity: {
    agentId: string;
    name: string;
    icon: string;
    assigned: number;
    completed: number;
    events: number;
  }[];
  workflowStats: { total: number; active: number; draft: number; paused: number };
  totals: {
    tasks: number;
    completionRate: number | null;
    memories: number;
    conversations: number;
    approvalsResolved: number;
    activityEvents: number;
    avgTasksPerDay: number | null;
  };
}

export interface SearchResults {
  tasks: { id: string; title: string; status: TaskStatus; dueDate: string | null }[];
  agents: { id: string; name: string; description: string; status: AgentStatus; icon: string }[];
  memories: { id: string; title: string; category: string }[];
}

export interface NotificationPayload {
  unreadCount: number;
  items: {
    id: string;
    type: 'approval_pending' | 'task_overdue' | 'task_due_today';
    title: string;
    detail: string;
    link: string;
    createdAt: string;
  }[];
}

export interface SettingsPayload {
  profile: User;
  preferences: UserPreferences;
}
