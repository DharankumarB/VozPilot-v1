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
  responsibilities: string[];
  config: Record<string, unknown>;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts: { total: number; open: number; completed: number };
}

interface AgentRow {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  status: AgentDto['status'];
  responsibilities: string[] | null;
  config: Record<string, unknown> | null;
  last_active_at: Date | null;
  created_at: Date;
  updated_at: Date;
  task_total: string | number;
  task_open: string | number;
  task_completed: string | number;
}

const AGENT_SELECT = (filter = '', order = '') => `
  SELECT a.id, a.key, a.name, a.description, a.icon, a.status, a.responsibilities, a.config,
         a.last_active_at, a.created_at, a.updated_at,
         COUNT(t.id) FILTER (WHERE t.id IS NOT NULL) AS task_total,
         COUNT(t.id) FILTER (WHERE t.status IN ('pending', 'in_progress', 'waiting_approval')) AS task_open,
         COUNT(t.id) FILTER (WHERE t.status = 'completed') AS task_completed
  FROM agents a
  LEFT JOIN tasks t ON t.agent_id = a.id
  WHERE a.user_id = $1${filter}
  GROUP BY a.id
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
    responsibilities: row.responsibilities ?? [],
    config: row.config ?? {},
    lastActiveAt: iso(row.last_active_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    taskCounts: {
      total: Number(row.task_total ?? 0),
      open: Number(row.task_open ?? 0),
      completed: Number(row.task_completed ?? 0),
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
    const existing = await client.query<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM agents WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [agentId, userId],
    );
    const agent = existing.rows[0];
    if (!agent) throw new NotFoundError('Agent not found.');

    const changes: string[] = [];
    if (input.name !== undefined && input.name !== agent.name) changes.push(`Name: ${agent.name} → ${input.name}`);
    if (input.status !== undefined && input.status !== agent.status) {
      changes.push(`Status: ${agent.status} → ${input.status}`);
    }
    if (input.description !== undefined) changes.push('Description updated');
    if (input.responsibilities !== undefined) changes.push('Responsibilities updated');
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
