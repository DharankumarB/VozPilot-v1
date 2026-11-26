import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { NotFoundError } from '../../lib/errors';
import { iso } from '../../lib/serialize';

export interface MemoryDto {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[] | null;
  created_at: Date;
  updated_at: Date;
}

function mapMemory(row: MemoryRow): MemoryDto {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: row.tags ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const memoryBodySchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  category: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9 _-]+$/, 'Category may contain letters, numbers, spaces, dashes and underscores')
    .default('general'),
  content: z.string().trim().max(20000).default(''),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .default([]),
});

export const createMemorySchema = memoryBodySchema;
export const updateMemorySchema = memoryBodySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Provide at least one field to update' },
);
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

export async function listMemories(
  userId: string,
  query: { q?: string; category?: string },
): Promise<{ memories: MemoryDto[]; categories: string[] }> {
  return withUser(userId, async (client) => {
    const conditions = ['user_id = $1'];
    const values: unknown[] = [userId];
    if (query.q?.trim()) {
      values.push(query.q.trim());
      const idx = values.length;
      conditions.push(
        `(title ILIKE '%' || $${idx} || '%' OR content ILIKE '%' || $${idx} || '%' OR tags::text ILIKE '%' || $${idx} || '%')`,
      );
    }
    if (query.category && query.category !== 'all') {
      values.push(query.category);
      conditions.push(`category = $${values.length}`);
    }

    const result = await client.query<MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      values as never[],
    );
    const categories = await client.query<{ category: string }>(
      'SELECT DISTINCT category FROM memories WHERE user_id = $1 ORDER BY category',
      [userId],
    );
    return {
      memories: result.rows.map(mapMemory),
      categories: categories.rows.map((row) => row.category),
    };
  });
}

export async function createMemory(userId: string, input: CreateMemoryInput): Promise<MemoryDto> {
  return withUser(userId, async (client) => {
    const inserted = await client.query<MemoryRow>(
      `INSERT INTO memories (user_id, category, title, content, tags)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [userId, input.category.toLowerCase(), input.title, input.content, JSON.stringify(input.tags)],
    );
    const memory = inserted.rows[0];
    await logActivity(client, {
      userId,
      type: 'memory_created',
      category: 'memory',
      title: `Memory stored: ${memory.title}`,
      detail: `Category: ${memory.category}`,
    });
    return mapMemory(memory);
  });
}

export async function updateMemory(
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): Promise<MemoryDto> {
  return withUser(userId, async (client) => {
    const existing = await client.query<MemoryRow>(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [memoryId, userId],
    );
    const memory = existing.rows[0];
    if (!memory) throw new NotFoundError('Memory not found.');

    const sets: string[] = [];
    const values: unknown[] = [memoryId, userId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.title !== undefined) push('title', input.title);
    if (input.category !== undefined) push('category', input.category.toLowerCase());
    if (input.content !== undefined) push('content', input.content);
    if (input.tags !== undefined) push('tags', JSON.stringify(input.tags));

    if (sets.length > 0) {
      await client.query(
        `UPDATE memories SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
        values as never[],
      );
      await logActivity(client, {
        userId,
        type: 'memory_updated',
        category: 'memory',
        title: `Memory updated: ${input.title ?? memory.title}`,
        detail: 'Details changed',
      });
    }

    const updated = await client.query<MemoryRow>('SELECT * FROM memories WHERE id = $1 AND user_id = $2', [
      memoryId,
      userId,
    ]);
    const row = updated.rows[0];
    if (!row) throw new NotFoundError('Memory not found.');
    return mapMemory(row);
  });
}

export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  await withUser(userId, async (client) => {
    const existing = await client.query<{ title: string }>(
      'SELECT title FROM memories WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [memoryId, userId],
    );
    const memory = existing.rows[0];
    if (!memory) throw new NotFoundError('Memory not found.');
    await client.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [memoryId, userId]);
    await logActivity(client, {
      userId,
      type: 'memory_deleted',
      category: 'memory',
      title: `Memory deleted: ${memory.title}`,
      detail: 'Removed from long-term memory',
    });
  });
}
