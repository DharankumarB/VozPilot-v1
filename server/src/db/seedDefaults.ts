import type { PoolClient } from 'pg';

/**
 * Default records created when a workspace (user) is registered.
 * These are *profiles and configuration only* — no fabricated tasks,
 * activity entries or execution history are ever seeded.
 */

export interface DefaultAgentSeed {
  key: string;
  name: string;
  description: string;
  icon: string;
  status: 'active' | 'idle' | 'paused' | 'error';
  responsibilities: string[];
}

export const DEFAULT_AGENTS: DefaultAgentSeed[] = [
  {
    key: 'vozcore',
    name: 'VozCore',
    description:
      'Central AI manager for the VozPilot workforce. Plans commands, delegates subtasks across the eight specialist agents, enforces safety gates, and consolidates results.',
    icon: 'sparkles',
    status: 'active',
    responsibilities: [
      'Route incoming commands to the right specialist agents',
      'Coordinate parallel & sequential delegated work',
      'Evaluate outputs and consolidate into a single report',
    ],
  },
  {
    key: 'research',
    name: 'Research Agent',
    description:
      'Searches configured web providers and internal sources, compares evidence, separates facts from assumptions, flags conflicts, and stores cited reports.',
    icon: 'telescope',
    status: 'idle',
    responsibilities: [
      'Search configured providers & gather verified sources',
      'Compare sources, surface conflicts & separate assumptions',
      'Store structured research reports with preserved URLs',
    ],
  },
  {
    key: 'inbox',
    name: 'Inbox Agent',
    description:
      'Connects to Gmail via OAuth 2.0 — reads and searches authorized threads, flags urgent messages, drafts replies/follow-ups, and holds sends for approval.',
    icon: 'inbox',
    status: 'idle',
    responsibilities: [
      'Read, search and categorize authorized Gmail messages',
      'Surface urgent threads and summarize conversations',
      'Draft replies & follow-ups; require approval before sending',
    ],
  },
  {
    key: 'project',
    name: 'Project Agent',
    description:
      'Creates projects and subtasks in the Task Manager, assigns agents, tracks milestones, detects delayed tasks, and generates progress reports.',
    icon: 'folder-kanban',
    status: 'idle',
    responsibilities: [
      'Create projects, milestones and assigned subtasks',
      'Detect delayed/overdue tasks and coordinate workflows',
      'Generate database-backed project progress reports',
    ],
  },
  {
    key: 'content',
    name: 'Content Agent',
    description:
      'Creates brand-aligned social posts, captions, marketing strategies, content calendars, articles, product copy, ads, and design briefs as editable drafts.',
    icon: 'pen-tool',
    status: 'idle',
    responsibilities: [
      'Craft copy aligned to VozLook Studios or custom brands',
      'Build content calendars, blogs, ads & design briefs',
      'Store editable drafts; require approval before publishing',
    ],
  },
  {
    key: 'finance',
    name: 'Finance Agent',
    description:
      'Records authorized income/expenses, categorizes transactions, calculates budgets and project costs, detects anomalies, and prepares budget recommendations.',
    icon: 'wallet',
    status: 'idle',
    responsibilities: [
      'Record and categorize authorized income & expenses',
      'Compare budgets, project costs & flag spending anomalies',
      'Prepare budget recommendations without executing payments',
    ],
  },
  {
    key: 'schedule',
    name: 'Schedule Agent',
    description:
      'Connects to Google Calendar via OAuth 2.0 — reads events, finds open slots in your timezone, detects conflicts, creates reminders, and confirms calendar changes.',
    icon: 'calendar-clock',
    status: 'idle',
    responsibilities: [
      'Read calendar events & find open slots in user timezone',
      'Detect meeting conflicts, track deadlines & set reminders',
      'Require confirmation before creating or modifying events',
    ],
  },
  {
    key: 'developer',
    name: 'Developer Agent',
    description:
      'Generates and reviews code, debugs errors, writes unit tests and docs, executes snippets in a resource-limited sandbox, and analyzes authorized GitHub repos.',
    icon: 'code-xml',
    status: 'idle',
    responsibilities: [
      'Generate code, debug errors, review quality & write docs',
      'Run unit tests inside a CPU/memory/env-isolated sandbox',
      'Inspect authorized GitHub repos; gate pushes behind approval',
    ],
  },
  {
    key: 'memory',
    name: 'Memory Agent',
    description:
      'Curates workspace knowledge — stores categorized memories, retrieves project context with semantic search, deduplicates entries, and shares context via VozCore.',
    icon: 'brain',
    status: 'idle',
    responsibilities: [
      'Store, categorize and deduplicate non-sensitive memories',
      'Retrieve project context and search past execution results',
      'Share authorized context packets across agents via VozCore',
    ],
  },
];

export function agentOrderBy(expression: string): string {
  const cases = DEFAULT_AGENTS.map((agent, index) => `WHEN '${agent.key}' THEN ${index}`).join(' ');
  return `ORDER BY CASE ${expression} ${cases} ELSE ${DEFAULT_AGENTS.length} END ASC`;
}

export const DEFAULT_INTEGRATION_PROVIDERS = [
  'gmail',
  'google_calendar',
  'github',
  'google_drive',
  'notion',
] as const;

/** Seed agent profiles for a newly registered workspace. */
export async function seedDefaultAgents(client: PoolClient, userId: string): Promise<void> {
  for (const agent of DEFAULT_AGENTS) {
    await client.query(
      `INSERT INTO agents (user_id, key, name, description, icon, status, enabled, responsibilities)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb)`,
      [
        userId,
        agent.key,
        agent.name,
        agent.description,
        agent.icon,
        agent.status,
        JSON.stringify(agent.responsibilities),
      ],
    );
  }
}

/** Seed honest "not connected" integration rows for a new workspace. */
export async function seedDefaultIntegrations(client: PoolClient, userId: string): Promise<void> {
  for (const provider of DEFAULT_INTEGRATION_PROVIDERS) {
    await client.query(
      `INSERT INTO integrations (user_id, provider, status)
       VALUES ($1, $2, 'not_connected')
       ON CONFLICT (user_id, provider) DO NOTHING`,
      [userId, provider],
    );
  }
}
