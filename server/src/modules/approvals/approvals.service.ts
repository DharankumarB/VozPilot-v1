import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';
import { decryptToken } from '../../lib/tokenCrypto';

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
  executionId: string | null;
  agentTaskId: string | null;
  actionType: string | null;
  actionPayload: Record<string, unknown>;
  executedAt: string | null;
  executionResult: Record<string, unknown> | null;
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
  execution_id: string | null;
  agent_task_id: string | null;
  action_type: string | null;
  action_payload: Record<string, unknown> | null;
  executed_at: Date | null;
  execution_result: Record<string, unknown> | null;
}

const APPROVAL_SELECT = `
  SELECT ap.id, ap.title, ap.description, ap.status, ap.resolution_note,
         ap.requested_at, ap.resolved_at, ap.task_id, ap.agent_id,
         ap.execution_id, ap.agent_task_id, ap.action_type, ap.action_payload,
         ap.executed_at, ap.execution_result,
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
    executionId: row.execution_id ?? null,
    agentTaskId: row.agent_task_id ?? null,
    actionType: row.action_type ?? null,
    actionPayload: row.action_payload ?? {},
    executedAt: iso(row.executed_at),
    executionResult: row.execution_result ?? null,
  };
}

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

async function executeApprovedExternalAction(
  client: PoolClient,
  userId: string,
  approval: ApprovalRow,
): Promise<Record<string, unknown> | null> {
  const actionType = approval.action_type;
  const payload = approval.action_payload ?? {};
  if (!actionType) return null;

  if (actionType === 'content.request_external_publication') {
    const draftId = typeof payload.draft_id === 'string' ? payload.draft_id : null;
    if (draftId) {
      await client.query(
        "UPDATE content_drafts SET status = 'approved' WHERE id = $1 AND user_id = $2",
        [draftId, userId],
      );
    }
    return { status: 'approved_for_publication', draftId };
  }

  if (actionType === 'inbox.send_approved_email') {
    const row = await client.query<{ status: string; encrypted_access_token: string | null }>(
      "SELECT status, encrypted_access_token FROM integrations WHERE user_id = $1 AND provider = 'gmail'",
      [userId],
    );
    const gmail = row.rows[0];
    if (!gmail || gmail.status !== 'connected' || !gmail.encrypted_access_token) {
      return { sent: false, reason: 'gmail_not_connected' };
    }
    const token = decryptToken(gmail.encrypted_access_token);
    if (!token) return { sent: false, reason: 'missing_token' };

    const to = String(payload.to ?? '');
    const subject = String(payload.subject ?? '');
    const body = String(payload.body ?? '');
    const rfc822 = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\r\n');
    const raw = Buffer.from(rfc822, 'utf8').toString('base64url');
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw,
        ...(typeof payload.thread_id === 'string' && payload.thread_id ? { threadId: payload.thread_id } : {}),
      }),
    });
    if (!resp.ok) {
      return { sent: false, statusCode: resp.status, reason: 'gmail_api_rejected' };
    }
    const sentData = (await resp.json()) as { id?: string };
    return { sent: true, messageId: sentData.id ?? null };
  }

  if (actionType === 'schedule.propose_calendar_change') {
    const row = await client.query<{ status: string; encrypted_access_token: string | null }>(
      "SELECT status, encrypted_access_token FROM integrations WHERE user_id = $1 AND provider = 'google_calendar'",
      [userId],
    );
    const cal = row.rows[0];
    if (!cal || cal.status !== 'connected' || !cal.encrypted_access_token) {
      return { executed: false, reason: 'google_calendar_not_connected' };
    }
    const token = decryptToken(cal.encrypted_access_token);
    if (!token) return { executed: false, reason: 'missing_token' };

    const action = String(payload.action ?? 'create');
    if (action === 'cancel' && typeof payload.event_id === 'string' && payload.event_id) {
      const del = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(payload.event_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      return { executed: del.ok, action: 'cancel', statusCode: del.status };
    }
    const eventBody = {
      summary: String(payload.title ?? 'VozPilot Event'),
      description: String(payload.description ?? ''),
      start: { dateTime: String(payload.start_iso ?? '') },
      end: { dateTime: String(payload.end_iso ?? '') },
    };
    const url =
      action === 'modify' && typeof payload.event_id === 'string' && payload.event_id
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(payload.event_id)}`
        : 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const method = action === 'modify' && payload.event_id ? 'PATCH' : 'POST';
    const resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    if (!resp.ok) {
      return { executed: false, action, statusCode: resp.status };
    }
    const ev = (await resp.json()) as { id?: string; htmlLink?: string };
    return { executed: true, action, eventId: ev.id ?? null, htmlLink: ev.htmlLink ?? null };
  }

  return { authorized: true, actionType };
}

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
    let execResult: Record<string, unknown> | null = null;
    if (decision && approval.action_type) {
      try {
        execResult = await executeApprovedExternalAction(client, userId, approval);
      } catch (err) {
        execResult = { error: err instanceof Error ? err.message : String(err) };
      }
    } else if (!decision && approval.action_type === 'content.request_external_publication') {
      const draftId = (approval.action_payload ?? {}).draft_id;
      if (typeof draftId === 'string') {
        await client.query(
          "UPDATE content_drafts SET status = 'draft' WHERE id = $1 AND user_id = $2",
          [draftId, userId],
        );
      }
    }

    await client.query(
      `UPDATE approvals
       SET status = $3,
           resolution_note = $4,
           resolved_at = now(),
           executed_at = CASE WHEN $5::jsonb IS NOT NULL THEN now() ELSE executed_at END,
           execution_result = COALESCE($5::jsonb, execution_result)
       WHERE id = $1 AND user_id = $2`,
      [
        approvalId,
        userId,
        decision ? 'approved' : 'rejected',
        input.note ?? null,
        execResult ? JSON.stringify(execResult) : null,
      ],
    );

    if (approval.agent_task_id) {
      await client.query(
        `UPDATE agent_tasks
         SET status = $3,
             finished_at = now(),
             error = CASE WHEN $3 = 'cancelled' THEN 'Rejected by user in Approval Center' ELSE error END
         WHERE id = $1 AND user_id = $2 AND status = 'waiting'`,
        [approval.agent_task_id, userId, decision ? 'completed' : 'cancelled'],
      );
    }

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
        detail: input.note ?? (approval.action_type ?? ''),
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
