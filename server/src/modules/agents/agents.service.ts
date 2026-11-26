import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';
import { agentOrderBy } from '../../db/seedDefaults';

export const agentStatusSchema = z.enum(['active', 'idle', 'paused', 'error']);

export interface AgentDto {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  status: 'active' | 'idle' | 'paused' | 'error';
  enabled: boolean;
  systemInstructions: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  responsibilities: string[];
  config: Record<string, unknown>;
  currentTask: { id: string; title: string; executionId: string | null } | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts: { total: number; open: number; completed: number };
  agentTaskCounts: { total: number; running: number; completed: number; failed: number };
}

interface AgentRow {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  status: AgentDto['status'];
  enabled: boolean;
  system_instructions: string | null;
  timeout_seconds: number | null;
  max_retries: number | null;
  responsibilities: string[] | null;
  config: Record<string, unknown> | null;
  current_task_id: string | null;
  current_task_title: string | null;
  current_execution_id: string | null;
  last_active_at: Date | null;
  created_at: Date;
  updated_at: Date;
  task_total: string | number;
  task_open: string | number;
  task_completed: string | number;
  at_total: string | number;
  at_running: string | number;
  at_completed: string | number;
  at_failed: string | number;
}

const AGENT_SELECT = (filter = '', order = '') => `
  SELECT a.id, a.key, a.name, a.description, a.icon, a.status, a.enabled,
         a.system_instructions, a.timeout_seconds, a.max_retries,
         a.responsibilities, a.config, a.current_task_id,
         ct.title AS current_task_title, ct.execution_id AS current_execution_id,
         a.last_active_at, a.created_at, a.updated_at,
         COALESCE(tc.task_total, 0) AS task_total,
         COALESCE(tc.task_open, 0) AS task_open,
         COALESCE(tc.task_completed, 0) AS task_completed,
         COALESCE(atc.at_total, 0) AS at_total,
         COALESCE(atc.at_running, 0) AS at_running,
         COALESCE(atc.at_completed, 0) AS at_completed,
         COALESCE(atc.at_failed, 0) AS at_failed
  FROM agents a
  LEFT JOIN agent_tasks ct ON ct.id = a.current_task_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS task_total,
           COUNT(*) FILTER (WHERE t.status IN ('pending', 'in_progress', 'waiting_approval'))::int AS task_open,
           COUNT(*) FILTER (WHERE t.status = 'completed')::int AS task_completed
      FROM tasks t
     WHERE t.user_id = a.user_id AND t.agent_id = a.id
  ) tc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS at_total,
           COUNT(*) FILTER (WHERE at.status = 'running')::int AS at_running,
           COUNT(*) FILTER (WHERE at.status = 'completed')::int AS at_completed,
           COUNT(*) FILTER (WHERE at.status = 'failed')::int AS at_failed
      FROM agent_tasks at
     WHERE at.user_id = a.user_id AND at.agent_key = a.key
  ) atc ON true
  WHERE a.user_id = $1${filter}
  ${order}
`;

function mapAgent(row: AgentRow): AgentDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    status: row.status,
    enabled: row.enabled !== false,
    systemInstructions: row.system_instructions ?? null,
    timeoutSeconds: Number(row.timeout_seconds ?? 90),
    maxRetries: Number(row.max_retries ?? 2),
    responsibilities: row.responsibilities ?? [],
    config: row.config ?? {},
    currentTask:
      row.current_task_id && row.current_task_title
        ? {
            id: row.current_task_id,
            title: row.current_task_title,
            executionId: row.current_execution_id ?? null,
          }
        : null,
    lastActiveAt: iso(row.last_active_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    taskCounts: {
      total: Number(row.task_total ?? 0),
      open: Number(row.task_open ?? 0),
      completed: Number(row.task_completed ?? 0),
    },
    agentTaskCounts: {
      total: Number(row.at_total ?? 0),
      running: Number(row.at_running ?? 0),
      completed: Number(row.at_completed ?? 0),
      failed: Number(row.at_failed ?? 0),
    },
  };
}

export async function listAgents(userId: string): Promise<AgentDto[]> {
  return withUser(userId, async (client) => {
    const result = await client.query<AgentRow>(AGENT_SELECT('', agentOrderBy('a.key')), [userId]);
    return result.rows.map(mapAgent);
  });
}

export async function getAgent(userId: string, agentId: string): Promise<AgentDto> {
  return withUser(userId, async (client) => {
    const result = await client.query<AgentRow>(AGENT_SELECT(' AND a.id = $2'), [userId, agentId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Agent not found.');
    return mapAgent(row);
  });
}

export const updateAgentSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(600).optional(),
  status: agentStatusSchema.optional(),
  enabled: z.boolean().optional(),
  systemInstructions: z.string().max(4000).nullable().optional(),
  timeoutSeconds: z.number().int().min(5).max(600).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  icon: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/, 'Icon must be a lowercase key such as "telescope"')
    .optional(),
  responsibilities: z.array(z.string().trim().min(1).max(180)).max(12).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export async function updateAgent(
  userId: string,
  agentId: string,
  input: UpdateAgentInput,
): Promise<AgentDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<{ id: string; name: string; status: string; enabled: boolean }>(
      'SELECT id, name, status, enabled FROM agents WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [agentId, userId],
    );
    const agent = existing.rows[0];
    if (!agent) throw new NotFoundError('Agent not found.');

    const changes: string[] = [];
    if (input.name !== undefined && input.name !== agent.name) changes.push(`Name: ${agent.name} -> ${input.name}`);
    if (input.status !== undefined && input.status !== agent.status) {
      changes.push(`Status: ${agent.status} -> ${input.status}`);
    }
    if (input.enabled !== undefined && input.enabled !== agent.enabled) {
      changes.push(input.enabled ? 'Enabled' : 'Disabled');
    }
    if (input.description !== undefined) changes.push('Description updated');
    if (input.responsibilities !== undefined) changes.push('Responsibilities updated');
    if (input.systemInstructions !== undefined) changes.push('System instructions updated');
    if (input.timeoutSeconds !== undefined || input.maxRetries !== undefined) changes.push('Limits updated');
    if (input.icon !== undefined) changes.push('Icon updated');
    if (input.config !== undefined) changes.push('Configuration updated');

    const sets: string[] = [];
    const values: unknown[] = [agentId, userId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.name !== undefined) push('name', input.name);
    if (input.description !== undefined) push('description', input.description);
    if (input.status !== undefined) {
      push('status', input.status);
      if (input.status === 'active') push('last_active_at', new Date().toISOString());
    }
    if (input.enabled !== undefined) push('enabled', input.enabled);
    if (input.systemInstructions !== undefined) {
      push('system_instructions', input.systemInstructions ? input.systemInstructions.trim() : null);
    }
    if (input.timeoutSeconds !== undefined) push('timeout_seconds', input.timeoutSeconds);
    if (input.maxRetries !== undefined) push('max_retries', input.maxRetries);
    if (input.icon !== undefined) push('icon', input.icon);
    if (input.responsibilities !== undefined) push('responsibilities', JSON.stringify(input.responsibilities));
    if (input.config !== undefined) push('config', JSON.stringify(input.config));

    if (sets.length === 0) {
      return getAgent(userId, agentId);
    }

    await client.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
      values as never[],
    );

    if (changes.length > 0) {
      await logActivity(client, {
        userId,
        type: 'agent_updated',
        category: 'agent',
        title: `${input.name ?? agent.name} updated`,
        detail: changes.join(' · '),
        agentId,
      });
    }

    const updated = await client.query<AgentRow>(AGENT_SELECT(' AND a.id = $2'), [userId, agentId]);
    const row = updated.rows[0];
    if (!row) throw new NotFoundError('Agent not found.');
    return mapAgent(row);
  });
}
