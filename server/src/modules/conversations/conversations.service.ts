import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { clampLimit } from '../../lib/serialize';

export interface MessageAttachmentDto {
  taskId: string;
  title: string;
  status: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments: MessageAttachmentDto[];
  createdAt: string;
  executionId?: string | null;
}

export interface ConversationDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count?: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments: MessageAttachmentDto[] | null;
  execution_id?: string | null;
  created_at: Date;
}

function mapConversation(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: Number(row.message_count ?? 0),
  };
}

function mapMessage(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    attachments: row.attachments ?? [],
    createdAt: row.created_at.toISOString(),
    executionId: row.execution_id ?? null,
  };
}

export async function listConversations(userId: string): Promise<ConversationDto[]> {
  return withUser(userId, async (client) => {
    const result = await client.query<ConversationRow>(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              COUNT(m.id)::text AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
      [userId],
    );
    return result.rows.map(mapConversation);
  });
}

export async function createConversation(userId: string, title?: string): Promise<ConversationDto> {
  return withUser(userId, async (client) => {
    const inserted = await client.query<ConversationRow>(
      'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *',
      [userId, (title ?? '').trim() || 'New conversation'],
    );
    return mapConversation({ ...inserted.rows[0], message_count: '0' });
  });
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<{ conversation: ConversationDto; messages: MessageDto[] }> {
  return withUser(userId, async (client) => {
    const found = await client.query<ConversationRow>(
      `SELECT c.*, COUNT(m.id)::text AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.id = $1 AND c.user_id = $2
       GROUP BY c.id`,
      [conversationId, userId],
    );
    const conversation = found.rows[0];
    if (!conversation) throw new NotFoundError('Conversation not found.');

    const messages = await client.query<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
      [conversationId, userId],
    );

    return {
      conversation: mapConversation(conversation),
      messages: messages.rows.map(mapMessage),
    };
  });
}

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message cannot be empty').max(8000),
  attachmentTaskIds: z.array(z.string().uuid()).max(10).default([]),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Store a message the user sent to VozCore.
 *
 * Phase 1 boundary: only the *user* message is persisted. No assistant reply
 * is generated — VozCore orchestration connects in Phase 2, and this module
 * must never fabricate agent output.
 */
export async function sendMessage(
  userId: string,
  conversationId: string,
  input: SendMessageInput,
): Promise<{ conversation: ConversationDto; message: MessageDto }> {
  return withUser(userId, async (client) => {
    const found = await client.query<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [conversationId, userId],
    );
    const conversation = found.rows[0];
    if (!conversation) throw new NotFoundError('Conversation not found.');

    // Resolve attachments — must be real tasks in this workspace.
    let attachments: MessageAttachmentDto[] = [];
    if (input.attachmentTaskIds.length > 0) {
      const tasks = await client.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM tasks
         WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, input.attachmentTaskIds],
      );
      if (tasks.rows.length !== input.attachmentTaskIds.length) {
        throw new BadRequestError('One or more attached tasks no longer exist.');
      }
      attachments = tasks.rows.map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
      }));
    }

    const inserted = await client.query<MessageRow>(
      `INSERT INTO messages (conversation_id, user_id, role, content, attachments)
       VALUES ($1, $2, 'user', $3, $4::jsonb) RETURNING *`,
      [conversationId, userId, input.content, JSON.stringify(attachments)],
    );

    // Auto-title a fresh conversation from the first message.
    if (conversation.title === 'New conversation') {
      const autoTitle = input.content.length > 64 ? `${input.content.slice(0, 64).trimEnd()}…` : input.content;
      await client.query('UPDATE conversations SET title = $2 WHERE id = $1', [conversationId, autoTitle]);
      conversation.title = autoTitle;
    }
    await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);

    await logActivity(client, {
      userId,
      type: 'message_sent',
      category: 'conversation',
      title: `Command sent in "${conversation.title}"`,
      detail: attachments.length
        ? `${attachments.length} task${attachments.length === 1 ? '' : 's'} attached`
        : 'Awaiting Phase 2 orchestration',
    });

    const message = mapMessage(inserted.rows[0]);
    const updated: ConversationDto = {
      ...mapConversation(conversation),
      messageCount: Number(conversation.message_count ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    return { conversation: updated, message };
  });
}

export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await withUser(userId, async (client) => {
    const existing = await client.query<{ title: string }>(
      'SELECT title FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [conversationId, userId],
    );
    const conversation = existing.rows[0];
    if (!conversation) throw new NotFoundError('Conversation not found.');

    await client.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [
      conversationId,
      userId,
    ]);
    await logActivity(client, {
      userId,
      type: 'conversation_deleted',
      category: 'conversation',
      title: `Conversation deleted: ${conversation.title}`,
      detail: 'Thread removed',
    });
  });
}

/** Tasks available to attach to a message (open work only). */
export async function listAttachableTasks(userId: string): Promise<
  { id: string; title: string; status: string }[]
> {
  return withUser(userId, async (client) => {
    const result = await client.query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM tasks
       WHERE user_id = $1 AND status NOT IN ('completed', 'failed')
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, clampLimit(50)],
    );
    return result.rows;
  });
}
