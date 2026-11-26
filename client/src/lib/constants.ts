import type { ComponentType } from 'react';
import {
  Activity,
  Brain,
  Bot,
  CalendarDays,
  CircleDot,
  Database,
  FileText,
  Fingerprint,
  FolderKanban,
  Gauge,
  GitBranch,
  HardDrive,
  Inbox,
  Layers,
  ListTodo,
  Mail,
  MessageSquare,
  NotebookPen,
  Palette,
  PenTool,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Telescope,
  Terminal,
  Wallet,
  Workflow,
  type LucideProps,
} from 'lucide-react';
import type {
  AgentStatus,
  ApprovalStatus,
  IntegrationProvider,
  TaskPriority,
  TaskStatus,
  WorkflowStatus,
} from './types';

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

export const NAV_ITEMS: { to: string; label: string; icon: ComponentType<LucideProps>; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: Layers, end: true },
  { to: '/command-center', label: 'AI Command Center', icon: Terminal },
  { to: '/agents', label: 'Agent Hub', icon: Bot },
  { to: '/tasks', label: 'Task Manager', icon: ListTodo },
  { to: '/workflows', label: 'Workflow Manager', icon: Workflow },
  { to: '/memories', label: 'Memory Center', icon: Brain },
  { to: '/activity', label: 'Activity Center', icon: Activity },
  { to: '/approvals', label: 'Approval Center', icon: ShieldCheck },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/analytics', label: 'Analytics', icon: Gauge },
  { to: '/settings', label: 'Settings', icon: Palette },
];

/* -------------------------------------------------------------------------- */
/* Status vocabularies                                                         */
/* -------------------------------------------------------------------------- */

export interface Meta<T extends string> {
  label: string;
  /** Tailwind text color class */
  text: string;
  /** Tailwind bg class (subtle) */
  bg: string;
  /** Dot color class */
  dot: string;
}

export const TASK_STATUS_META: Record<TaskStatus, Meta<TaskStatus>> = {
  pending: { label: 'Pending', text: 'text-mist-300', bg: 'bg-white/6', dot: 'bg-mist-400' },
  in_progress: { label: 'In Progress', text: 'text-azure-400', bg: 'bg-azure-500/12', dot: 'bg-azure-500' },
  waiting_approval: { label: 'Waiting for Approval', text: 'text-gild-400', bg: 'bg-gild-500/12', dot: 'bg-gild-500' },
  completed: { label: 'Completed', text: 'text-verdant-400', bg: 'bg-verdant-500/12', dot: 'bg-verdant-500' },
  failed: { label: 'Failed', text: 'text-rosh-400', bg: 'bg-rosh-500/12', dot: 'bg-rosh-500' },
};

export const TASK_STATUS_ORDER: TaskStatus[] = [
  'pending',
  'in_progress',
  'waiting_approval',
  'completed',
  'failed',
];

export const AGENT_STATUS_META: Record<AgentStatus, Meta<AgentStatus>> = {
  active: { label: 'Active', text: 'text-verdant-400', bg: 'bg-verdant-500/12', dot: 'bg-verdant-500' },
  idle: { label: 'Idle', text: 'text-mist-300', bg: 'bg-white/6', dot: 'bg-mist-400' },
  paused: { label: 'Paused', text: 'text-lume-400', bg: 'bg-lume-500/12', dot: 'bg-lume-500' },
  error: { label: 'Error', text: 'text-rosh-400', bg: 'bg-rosh-500/12', dot: 'bg-rosh-500' },
};

export const PRIORITY_META: Record<TaskPriority, Meta<TaskPriority> & { rank: number }> = {
  low: { label: 'Low', text: 'text-mist-300', bg: 'bg-white/6', dot: 'bg-mist-400', rank: 1 },
  medium: { label: 'Medium', text: 'text-azure-400', bg: 'bg-azure-500/12', dot: 'bg-azure-500', rank: 2 },
  high: { label: 'High', text: 'text-lume-400', bg: 'bg-lume-500/12', dot: 'bg-lume-500', rank: 3 },
  critical: { label: 'Critical', text: 'text-rosh-400', bg: 'bg-rosh-500/12', dot: 'bg-rosh-500', rank: 4 },
};

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, Meta<WorkflowStatus>> = {
  draft: { label: 'Draft', text: 'text-mist-300', bg: 'bg-white/6', dot: 'bg-mist-400' },
  active: { label: 'Active', text: 'text-verdant-400', bg: 'bg-verdant-500/12', dot: 'bg-verdant-500' },
  paused: { label: 'Paused', text: 'text-lume-400', bg: 'bg-lume-500/12', dot: 'bg-lume-500' },
};

export const APPROVAL_STATUS_META: Record<ApprovalStatus, Meta<ApprovalStatus>> = {
  pending: { label: 'Pending', text: 'text-gild-400', bg: 'bg-gild-500/12', dot: 'bg-gild-500' },
  approved: { label: 'Approved', text: 'text-verdant-400', bg: 'bg-verdant-500/12', dot: 'bg-verdant-500' },
  rejected: { label: 'Rejected', text: 'text-rosh-400', bg: 'bg-rosh-500/12', dot: 'bg-rosh-500' },
  dismissed: { label: 'Dismissed', text: 'text-mist-400', bg: 'bg-white/6', dot: 'bg-mist-500' },
};

/* -------------------------------------------------------------------------- */
/* Agent icons                                                                 */
/* -------------------------------------------------------------------------- */

export const AGENT_ICONS: Record<string, ComponentType<LucideProps>> = {
  sparkles: Sparkles,
  telescope: Telescope,
  inbox: Inbox,
  'folder-kanban': FolderKanban,
  'pen-tool': PenTool,
  wallet: Wallet,
  'calendar-clock': CalendarDays,
  'code-xml': Terminal,
  brain: Brain,
  bot: Bot,
};

export function agentIcon(key: string | null | undefined): ComponentType<LucideProps> {
  return AGENT_ICONS[key ?? ''] ?? Bot;
}

/* -------------------------------------------------------------------------- */
/* Activity categories                                                         */
/* -------------------------------------------------------------------------- */

export const ACTIVITY_CATEGORY_META: Record<string, { label: string; icon: ComponentType<LucideProps> }> = {
  task: { label: 'Tasks', icon: ListTodo },
  agent: { label: 'Agents', icon: Bot },
  workflow: { label: 'Workflows', icon: Workflow },
  memory: { label: 'Memory', icon: Brain },
  approval: { label: 'Approvals', icon: ShieldCheck },
  integration: { label: 'Integrations', icon: Plug },
  conversation: { label: 'Conversations', icon: MessageSquare },
  auth: { label: 'Authentication', icon: Fingerprint },
  settings: { label: 'Settings', icon: SlidersHorizontal },
  system: { label: 'System', icon: Database },
};

export const ACTIVITY_FILTERS = [
  'all',
  'task',
  'agent',
  'workflow',
  'memory',
  'approval',
  'integration',
  'conversation',
  'auth',
  'settings',
] as const;

/* -------------------------------------------------------------------------- */
/* Integrations                                                                */
/* -------------------------------------------------------------------------- */

export const PROVIDER_META: Record<
  IntegrationProvider,
  { name: string; icon: ComponentType<LucideProps>; blurb: string; vendor: string }
> = {
  gmail: { name: 'Gmail', icon: Mail, vendor: 'Google', blurb: 'Triage threads, draft replies and surface urgent mail.' },
  google_calendar: { name: 'Google Calendar', icon: CalendarDays, vendor: 'Google', blurb: 'Find open slots, book meetings and protect focus blocks.' },
  github: { name: 'GitHub', icon: GitBranch, vendor: 'GitHub', blurb: 'Track issues, reviews and repository activity for Developer Agent.' },
  google_drive: { name: 'Google Drive', icon: HardDrive, vendor: 'Google', blurb: 'Locate, read and organise files across shared drives.' },
  notion: { name: 'Notion', icon: NotebookPen, vendor: 'Notion', blurb: 'Sync pages and databases with project memory.' },
};

/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */

export const ACCENT_OPTIONS: { id: 'violet' | 'gold' | 'teal' | 'rose'; label: string; swatch: string }[] = [
  { id: 'violet', label: 'Violet', swatch: '#7c5cff' },
  { id: 'gold', label: 'Gold', swatch: '#d9a94e' },
  { id: 'teal', label: 'Teal', swatch: '#2dd4bf' },
  { id: 'rose', label: 'Rose', swatch: '#fb7185' },
];
