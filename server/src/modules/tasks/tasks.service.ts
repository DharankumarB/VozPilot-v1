import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';
import { createPendingApproval, dismissPendingApproval } from '../approvals/approvals.service';

export const taskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'waiting_approval',
  'completed',
  'failed',
]);
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export interface TaskDto {
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

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_icon: string | null;
  agent_key: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
         t.agent_id, t.completed_at, t.created_at, t.updated_at,
         a.name AS agent_name, a.icon AS agent_icon, a.key AS agent_key
  FROM tasks t
  LEFT JOIN agents a ON a.id = t.agent_id AND a.user_id = t.user_id
  WHERE t.user_id = $1
`;

function mapTask(row: TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date ?? null,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentIcon: row.agent_icon,
    agentKey: row.agent_key,
    completedAt: iso(row.completed_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface StatusCounts {
  all: number;
  pending: number;
  in_progress: number;
  waiting_approval: number;
  completed: number;
  failed: number;
}

export interface ListTasksQuery {
  q?: string;
  status?: TaskStatus | 'all';
  priority?: TaskPriority | 'all';
  agentId?: string | 'all';
  sort?: 'created_desc' | 'updated_desc' | 'due_asc' | 'priority_desc';
}

const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export async function listTasks(
  userId: string,
  query: ListTasksQuery,
): Promise<{ tasks: TaskDto[]; counts: StatusCounts }> {
  return withUser(userId, async (client) => {
    const conditions: string[] = [];
    const values: unknown[] = [userId];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      conditions.push(clause.replace('$?', `$${values.length}`));
    };

    if (query.q && query.q.trim()) {
      add(`(t.title ILIKE '%' || $? || '%' OR t.description ILIKE '%' || $? || '%')`, query.q.trim());
      // two placeholders for the same value
      values.pop();
      values.push(query.q.trim());
      conditions.pop();
      const idx = values.length;
      conditions.push(`(t.title ILIKE '%' || $${idx} || '%' OR t.description ILIKE '%' || $${idx} || '%')`);
    }
    if (query.status && query.status !== 'all') add('t.status = $?', query.status);
    if (query.priority && query.priority !== 'all') add('t.priority = $?', query.priority);
    if (query.agentId && query.agentId !== 'all') add('t.agent_id = $?', query.agentId);

    const where = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    const order =
      query.sort === 'due_asc'
        ? 'ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC'
        : query.sort === 'updated_desc'
          ? 'ORDER BY t.updated_at DESC'
          : query.sort === 'priority_desc'
            ? 'ORDER BY CASE t.priority WHEN \'critical\' THEN 4 WHEN \'high\' THEN 3 WHEN \'medium\' THEN 2 ELSE 1 END DESC, t.created_at DESC'
            : 'ORDER BY t.created_at DESC';

    const result = await client.query<TaskRow>(`${TASK_SELECT}${where} ${order}`, values as never[]);
    const tasks = result.rows.map(mapTask);

    const countResult = await client.query<{
      status: TaskStatus;
      count: string;
    }>('SELECT status, COUNT(*)::text AS count FROM tasks WHERE user_id = $1 GROUP BY status', [userId]);
    const counts: StatusCounts = {
      all: 0,
      pending: 0,
      in_progress: 0,
      waiting_approval: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of countResult.rows) {
      const value = Number(row.count);
      counts[row.status] = value;
      counts.all += value;
    }

    return { tasks, counts };
  });
}

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(4000).default(''),
  status: taskStatusSchema.default('pending'),
  priority: taskPrioritySchema.default('medium'),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must be YYYY-MM-DD')
    .nullable()
    .optional(),
  agentId: z.string().uuid('agentId must be a valid id').nullable().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Provide at least one field to update' },
);
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

async function assertAgentOwned(
  client: { query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }> },
  userId: string,
  agentId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  if (result.rows.length === 0) {
    throw new BadRequestError('The selected agent does not exist in this workspace.');
  }
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  waiting_approval: 'Waiting for Approval',
  completed: 'Completed',
  failed: 'Failed',
};

export async function createTask(userId: string, input: CreateTaskInput): Promise<TaskDto> {
  return withUser(userId, async (client) => {
    if (input.agentId) await assertAgentOwned(client, userId, input.agentId);

    const inserted = await client.query<TaskRow>(
      `WITH inserted AS (
         INSERT INTO tasks (user_id, agent_id, title, description, status, priority, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *
       )
       SELECT i.id, i.title, i.description, i.status, i.priority, i.due_date,
              i.agent_id, i.completed_at, i.created_at, i.updated_at,
              a.name AS agent_name, a.icon AS agent_icon, a.key AS agent_key
       FROM inserted i
       LEFT JOIN agents a ON a.id = i.agent_id AND a.user_id = i.user_id`,
      [
        userId,
        input.agentId ?? null,
        input.title,
        input.description,
        input.status,
        input.priority,
        input.dueDate ?? null,
      ],
    );
    const task = inserted.rows[0];
    if (!task) throw new BadRequestError('Task could not be created.');

    const detailParts = [`Priority: ${input.priority}`];
    if (input.agentId) detailParts.push('Assigned agent attached');
    if (input.dueDate) detailParts.push(`Due ${input.dueDate}`);
    if (input.status === 'waiting_approval') detailParts.push('Approval requested');

    await logActivity(client, {
      userId,
      type: 'task_created',
      category: 'task',
      title: `Task created: ${task.title}`,
      detail: detailParts.join(' · '),
      taskId: task.id,
      agentId: input.agentId ?? null,
    });

    if (input.status === 'waiting_approval') {
      await createPendingApproval(client, {
        userId,
        taskId: task.id,
        agentId: input.agentId ?? null,
        title: task.title,
        description: task.description,
      });
    }

    if (input.status === 'completed') {
      await client.query('UPDATE tasks SET completed_at = now() WHERE id = $1', [task.id]);
      task.completed_at = new Date();
    }

    return mapTask(task);
  });
}

export async function updateTask(
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<TaskRow>(`${TASK_SELECT} AND t.id = $2 FOR UPDATE OF t`, [
      userId,
      taskId,
    ]);
    const current = existing.rows[0];
    if (!current) throw new NotFoundError('Task not found.');

    if (input.agentId) await assertAgentOwned(client, userId, input.agentId);

    const changes: string[] = [];
    const sets: string[] = [];
    const values: unknown[] = [taskId, userId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.title !== undefined && input.title !== current.title) {
      changes.push(`Title updated`);
      push('title', input.title);
    }
    if (input.description !== undefined && input.description !== current.description) {
      changes.push('Description updated');
      push('description', input.description);
    }
    if (input.priority !== undefined && input.priority !== current.priority) {
      changes.push(`Priority: ${current.priority} → ${input.priority}`);
      push('priority', input.priority);
    }
    if (input.dueDate !== undefined && (input.dueDate ?? null) !== current.due_date) {
      changes.push(input.dueDate ? `Due date: ${input.dueDate}` : 'Due date cleared');
      push('due_date', input.dueDate ?? null);
    }
    if (input.agentId !== undefined && (input.agentId ?? null) !== current.agent_id) {
      if (input.agentId === null) {
        changes.push('Agent unassigned');
      } else {
        const agentRow = await client.query<{ name: string }>(
          'SELECT name FROM agents WHERE id = $1 AND user_id = $2',
          [input.agentId, userId],
        );
        changes.push(`Agent: ${agentRow.rows[0]?.name ?? 'updated'}`);
      }
      push('agent_id', input.agentId ?? null);
    }

    const statusChanged = input.status !== undefined && input.status !== current.status;
    if (statusChanged) {
      changes.push(`Status: ${STATUS_LABELS[current.status]} → ${STATUS_LABELS[input.status!]}`);
      push('status', input.status);

      if (input.status === 'completed') {
        push('completed_at', new Date().toISOString());
      } else if (current.status === 'completed') {
        push('completed_at', null);
      }
    }

    if (sets.length > 0) {
      await client.query(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
        values as never[],
      );
    }

    if (statusChanged) {
      const agentId = input.agentId !== undefined ? input.agentId : current.agent_id;
      if (input.status === 'waiting_approval') {
        await createPendingApproval(client, {
          userId,
          taskId,
          agentId: agentId ?? null,
          title: input.title ?? current.title,
          description: input.description ?? current.description,
        });
      } else if (current.status === 'waiting_approval') {
        await dismissPendingApproval(client, userId, taskId, 'Task status changed by user');
      }
    }

    if (changes.length > 0) {
      const type =
        statusChanged && input.status === 'completed'
          ? 'task_completed'
          : statusChanged && input.status === 'failed'
            ? 'task_failed'
            : 'task_updated';
      const title =
        type === 'task_completed'
          ? `Completed: ${input.title ?? current.title}`
          : type === 'task_failed'
            ? `Failed: ${input.title ?? current.title}`
            : `Task updated: ${input.title ?? current.title}`;
      await logActivity(client, {
        userId,
        type,
        category: 'task',
        title,
        detail: changes.join(' · '),
        taskId,
        agentId: input.agentId !== undefined ? input.agentId : current.agent_id,
      });
    }

    const updated = await client.query<TaskRow>(`${TASK_SELECT} AND t.id = $2`, [userId, taskId]);
    const row = updated.rows[0];
    if (!row) throw new NotFoundError('Task not found.');
    return mapTask(row);
  });
}

export async function deleteTask(userId: string, taskId: string): Promise<void> {
  await withUser(userId, async (client) => {
    const existing = await client.query<{ id: string; title: string }>(
      'SELECT id, title FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [taskId, userId],
    );
    const task = existing.rows[0];
    if (!task) throw new NotFoundError('Task not found.');

    await client.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [taskId, userId]);
    await logActivity(client, {
      userId,
      type: 'task_deleted',
      category: 'task',
      title: `Task deleted: ${task.title}`,
      detail: 'Removed from the workspace',
    });
  });
}

export { PRIORITY_RANK };
