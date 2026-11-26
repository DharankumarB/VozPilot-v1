import { z } from 'zod';
import { withUser } from '../../db/pool';
import { clampLimit } from '../../lib/serialize';

export interface ActivityLogDto {
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

interface ActivityRow {
  id: string;
  type: string;
  category: string;
  title: string;
  detail: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_icon: string | null;
  created_at: Date;
}

function mapActivity(row: ActivityRow): ActivityLogDto {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    title: row.title,
    detail: row.detail,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentIcon: row.agent_icon,
    createdAt: row.created_at.toISOString(),
  };
}

export const listActivitySchema = z.object({
  category: z
    .enum([
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
      'system',
    ])
    .default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListActivityQuery = z.infer<typeof listActivitySchema>;

export async function listActivity(
  userId: string,
  query: ListActivityQuery,
): Promise<{ items: ActivityLogDto[]; total: number }> {
  return withUser(userId, async (client) => {
    const conditions = ['al.user_id = $1'];
    const values: unknown[] = [userId];
    if (query.category !== 'all') {
      values.push(query.category);
      conditions.push(`al.category = $${values.length}`);
    }
    values.push(query.limit, query.offset);

    const result = await client.query<ActivityRow>(
      `SELECT al.id, al.type, al.category, al.title, al.detail, al.agent_id,
              al.created_at, a.name AS agent_name, a.icon AS agent_icon
       FROM activity_logs al
       LEFT JOIN agents a ON a.id = al.agent_id AND a.user_id = al.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY al.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values as never[],
    );

    const totalResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM activity_logs al WHERE ${conditions.join(' AND ')}`,
      values.slice(0, values.length - 2) as never[],
    );

    return {
      items: result.rows.map(mapActivity),
      total: Number(totalResult.rows[0]?.count ?? 0),
    };
  });
}

export interface NotificationItem {
  id: string;
  type: 'approval_pending' | 'task_overdue' | 'task_due_today';
  title: string;
  detail: string;
  link: string;
  createdAt: string;
}

/**
 * Real notifications derived from workspace state: pending approval
 * requests and open tasks that are due today or overdue.
 */
export async function getNotifications(userId: string): Promise<{
  unreadCount: number;
  items: NotificationItem[];
}> {
  return withUser(userId, async (client) => {
    const approvals = await client.query<{
      id: string;
      title: string;
      requested_at: Date;
      agent_name: string | null;
    }>(
      `SELECT ap.id, ap.title, ap.requested_at, a.name AS agent_name
       FROM approvals ap
       LEFT JOIN agents a ON a.id = ap.agent_id AND a.user_id = ap.user_id
       WHERE ap.user_id = $1 AND ap.status = 'pending'
       ORDER BY ap.requested_at ASC
       LIMIT 10`,
      [userId],
    );

    const dueTasks = await client.query<{
      id: string;
      title: string;
      due_date: string;
      updated_at: Date;
      overdue: boolean;
    }>(
      `SELECT id, title, due_date, updated_at, (due_date < CURRENT_DATE) AS overdue
       FROM tasks
       WHERE user_id = $1
         AND due_date IS NOT NULL
         AND due_date <= CURRENT_DATE
         AND status IN ('pending', 'in_progress', 'waiting_approval')
       ORDER BY due_date ASC
       LIMIT 10`,
      [userId],
    );

    const items: NotificationItem[] = [
      ...approvals.rows.map((row) => ({
        id: `approval-${row.id}`,
        type: 'approval_pending' as const,
        title: `Approval waiting: ${row.title}`,
        detail: row.agent_name ? `Requested by ${row.agent_name}` : 'Task requests your decision',
        link: '/approvals',
        createdAt: row.requested_at.toISOString(),
      })),
      ...dueTasks.rows.map((row) => ({
        id: `task-${row.id}`,
        type: (row.overdue ? 'task_overdue' : 'task_due_today') as 'task_overdue' | 'task_due_today',
        title: row.overdue ? `Overdue: ${row.title}` : `Due today: ${row.title}`,
        detail: `Due ${row.due_date}`,
        link: '/tasks',
        createdAt: row.updated_at.toISOString(),
      })),
    ];

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { unreadCount: items.length, items: items.slice(0, clampLimit(15)) };
  });
}
