import type { PoolClient } from 'pg';

export type ActivityCategory =
  | 'task'
  | 'agent'
  | 'workflow'
  | 'memory'
  | 'approval'
  | 'integration'
  | 'conversation'
  | 'auth'
  | 'settings'
  | 'system';

export interface ActivityInput {
  userId: string;
  type: string;
  category: ActivityCategory;
  title: string;
  detail?: string;
  agentId?: string | null;
  taskId?: string | null;
}

/**
 * Append a real system event to the activity log.
 * Call this only for events that actually happened — the Activity Center
 * must never show fabricated history.
 */
export async function logActivity(client: PoolClient, input: ActivityInput): Promise<void> {
  await client.query(
    `INSERT INTO activity_logs (user_id, agent_id, task_id, type, category, title, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.userId,
      input.agentId ?? null,
      input.taskId ?? null,
      input.type,
      input.category,
      input.title,
      input.detail ?? '',
    ],
  );
}
