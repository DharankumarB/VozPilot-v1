import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'dismissed';

export interface ApprovalDto {
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

interface ApprovalRow {
  id: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  resolution_note: string | null;
  requested_at: Date;
  resolved_at: Date | null;
  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_icon: string | null;
}

const APPROVAL_SELECT = `
  SELECT ap.id, ap.title, ap.description, ap.status, ap.resolution_note,
         ap.requested_at, ap.resolved_at, ap.task_id, ap.agent_id,
         t.title AS task_title, t.status AS task_status,
         a.name AS agent_name, a.icon AS agent_icon
  FROM approvals ap
  LEFT JOIN tasks t ON t.id = ap.task_id AND t.user_id = ap.user_id
  LEFT JOIN agents a ON a.id = ap.agent_id AND a.user_id = ap.user_id
  WHERE ap.user_id = $1
`;

function mapApproval(row: ApprovalRow): ApprovalDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    resolutionNote: row.resolution_note,
    requestedAt: row.requested_at.toISOString(),
    resolvedAt: iso(row.resolved_at),
    taskId: row.task_id,
    taskTitle: row.task_title,
    taskStatus: row.task_status,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentIcon: row.agent_icon,
  };
}

/**
 * Create a pending approval request for a task.
 * Called by the task service whenever a task enters "Waiting for Approval".
 * Runs on the caller's transaction so both records commit atomically.
 */
export async function createPendingApproval(
  client: PoolClient,
  input: {
    userId: string;
    taskId: string;
    agentId: string | null;
    title: string;
    description: string;
  },
): Promise<string | null> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM approvals
     WHERE user_id = $1 AND task_id = $2 AND status = 'pending'
     LIMIT 1`,
    [input.userId, input.taskId],
  );
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0].id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO approvals (user_id, task_id, agent_id, title, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.userId,
      input.taskId,
      input.agentId,
      input.title,
      input.description.length > 1000 ? `${input.description.slice(0, 1000)}…` : input.description,
    ],
  );
  const approvalId = inserted.rows[0].id;

  await logActivity(client, {
    userId: input.userId,
    type: 'approval_requested',
    category: 'approval',
    title: `Approval requested: ${input.title}`,
    detail: 'Task moved to Waiting for Approval',
    taskId: input.taskId,
    agentId: input.agentId,
  });

  return approvalId;
}

/** Dismiss a pending approval when its task leaves the waiting state. */
export async function dismissPendingApproval(
  client: PoolClient,
  userId: string,
  taskId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE approvals
     SET status = 'dismissed', resolution_note = $3, resolved_at = now()
     WHERE user_id = $1 AND task_id = $2 AND status = 'pending'`,
    [userId, taskId, reason],
  );
}

export async function listApprovals(
  userId: string,
  status: 'pending' | 'resolved' | 'all',
): Promise<ApprovalDto[]> {
  return withUser(userId, async (client) => {
    const filter =
      status === 'pending'
        ? " AND ap.status = 'pending'"
        : status === 'resolved'
          ? " AND ap.status IN ('approved', 'rejected', 'dismissed')"
          : '';
    const order =
      status === 'pending'
        ? 'ORDER BY ap.requested_at ASC'
        : 'ORDER BY COALESCE(ap.resolved_at, ap.requested_at) DESC';
    const result = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT}${filter} ${order}`,
      [userId],
    );
    return result.rows.map(mapApproval);
  });
}

export const resolveApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});

export type ResolveApprovalInput = z.infer<typeof resolveApprovalSchema>;

/**
 * Approve or reject a pending request.
 *  - approve → linked task moves to "In Progress" (work is authorized)
 *  - reject  → linked task returns to "Pending" (returned to queue)
 * The approval history records who decided, when and why.
 */
export async function resolveApproval(
  userId: string,
  approvalId: string,
  input: ResolveApprovalInput,
): Promise<ApprovalDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT} AND ap.id = $2 FOR UPDATE OF ap`,
      [userId, approvalId],
    );
    const approval = existing.rows[0];
    if (!approval) throw new NotFoundError('Approval request not found.');
    if (approval.status !== 'pending') {
      throw new ConflictError('This request has already been resolved.');
    }

    const decision = input.decision === 'approve';
    await client.query(
      `UPDATE approvals
       SET status = $3, resolution_note = $4, resolved_at = now()
       WHERE id = $1 AND user_id = $2`,
      [approvalId, userId, decision ? 'approved' : 'rejected', input.note ?? null],
    );

    if (approval.task_id) {
      const newStatus = decision ? 'in_progress' : 'pending';
      await client.query(
        `UPDATE tasks
         SET status = $3,
             completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END
         WHERE id = $1 AND user_id = $2`,
        [approval.task_id, userId, newStatus],
      );

      await logActivity(client, {
        userId,
        type: decision ? 'approval_approved' : 'approval_rejected',
        category: 'approval',
        title: decision ? `Approved: ${approval.title}` : `Rejected: ${approval.title}`,
        detail:
          (input.note ? `${input.note} · ` : '') +
          (approval.task_title
            ? `Task moved to ${decision ? 'In Progress' : 'Pending'}`
            : 'No linked task'),
        taskId: approval.task_id,
        agentId: approval.agent_id,
      });
    } else {
      await logActivity(client, {
        userId,
        type: decision ? 'approval_approved' : 'approval_rejected',
        category: 'approval',
        title: decision ? `Approved: ${approval.title}` : `Rejected: ${approval.title}`,
        detail: input.note ?? '',
        agentId: approval.agent_id,
      });
    }

    const updated = await client.query<ApprovalRow>(`${APPROVAL_SELECT} AND ap.id = $2`, [
      userId,
      approvalId,
    ]);
    const row = updated.rows[0];
    if (!row) throw new BadRequestError('Approval could not be loaded after the update.');
    return mapApproval(row);
  });
}

export async function countPendingApprovals(userId: string): Promise<number> {
  return withUser(userId, async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM approvals WHERE user_id = $1 AND status = 'pending'",
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}
