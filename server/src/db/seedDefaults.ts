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
      'Central AI manager for the VozPilot workforce. Delegates incoming commands to specialist agents, coordinates their work and reports results once orchestration goes live in Phase 2.',
    icon: 'sparkles',
    status: 'active',
    responsibilities: [
      'Route incoming commands to the right specialist agent',
      'Coordinate delegated work and track its progress',
      'Aggregate results into a single status report',
    ],
  },
  {
    key: 'research',
    name: 'Research Agent',
    description:
      'Collects and structures information from the web and internal sources into briefs you can act on.',
    icon: 'telescope',
    status: 'idle',
    responsibilities: [
      'Gather source material for briefs',
      'Summarise findings with references',
      'Keep structured research notes in memory',
    ],
  },
  {
    key: 'inbox',
    name: 'Inbox Agent',
    description:
      'Triages email in Gmail — labels threads, surfaces what matters and drafts replies for your approval.',
    icon: 'inbox',
    status: 'idle',
    responsibilities: [
      'Classify and label incoming messages',
      'Draft replies for human approval',
      'Surface urgent threads early',
    ],
  },
  {
    key: 'project',
    name: 'Project Agent',
    description:
      'Keeps projects moving — tracks milestones, owners, blockers and delivery risk across workstreams.',
    icon: 'folder-kanban',
    status: 'idle',
    responsibilities: [
      'Track milestones and delivery dates',
      'Flag blockers and stale work',
      'Prepare weekly project status summaries',
    ],
  },
  {
    key: 'content',
    name: 'Content Agent',
    description:
      'Plans and drafts content across channels. Every draft stays in review until you approve it.',
    icon: 'pen-tool',
    status: 'idle',
    responsibilities: [
      'Turn briefs into structured drafts',
      'Maintain a content calendar',
      'Adapt copy per channel and format',
    ],
  },
  {
    key: 'finance',
    name: 'Finance Agent',
    description:
      'Watches invoices, budgets and expenses — catching anomalies and upcoming payments before they surprise you.',
    icon: 'wallet',
    status: 'idle',
    responsibilities: [
      'Track invoices and due dates',
      'Compare spending against budget',
      'Flag unusual or duplicated charges',
    ],
  },
  {
    key: 'schedule',
    name: 'Schedule Agent',
    description:
      'Manages calendars and meetings — finds open slots, books time and prepares agendas.',
    icon: 'calendar-clock',
    status: 'idle',
    responsibilities: [
      'Find and propose meeting slots',
      'Prepare agendas and pre-reads',
      'Protect focus blocks on the calendar',
    ],
  },
  {
    key: 'developer',
    name: 'Developer Agent',
    description:
      'Assists engineering work — issue triage, review preparation and routine repository changes.',
    icon: 'code-xml',
    status: 'idle',
    responsibilities: [
      'Triage and label incoming issues',
      'Prepare change descriptions and checklists',
      'Track review and CI follow-ups',
    ],
  },
  {
    key: 'memory',
    name: 'Memory Agent',
    description:
      'Organises long-term knowledge in the Memory Center so every agent can recall project context.',
    icon: 'brain',
    status: 'idle',
    responsibilities: [
      'Structure and categorise stored knowledge',
      'Deduplicate overlapping memories',
      'Surface relevant context on request',
    ],
  },
];

/**
 * Stable display order for agents (VozCore first, then the curated order).
 * Rows seeded in a single transaction share `created_at`, so ordering must
 * come from the key itself.
 */
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
      `INSERT INTO agents (user_id, key, name, description, icon, status, responsibilities)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
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
