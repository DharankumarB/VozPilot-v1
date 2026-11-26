import { z } from 'zod';
import { withUser } from '../../db/pool';

export interface SearchResults {
  tasks: { id: string; title: string; status: string; dueDate: string | null }[];
  agents: { id: string; name: string; description: string; status: string; icon: string }[];
  memories: { id: string; title: string; category: string }[];
}

export const searchSchema = z.object({
  q: z.string().trim().min(1, 'Search needs at least one character').max(200),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export async function globalSearch(userId: string, query: string, limit: number): Promise<SearchResults> {
  return withUser(userId, async (client) => {
    const pattern = `%${query}%`;

    const tasks = await client.query<{ id: string; title: string; status: string; due_date: string | null }>(
        `SELECT id, title, status, due_date FROM tasks
         WHERE user_id = $1 AND (title ILIKE $2 OR description ILIKE $2)
         ORDER BY updated_at DESC LIMIT $3`,
        [userId, pattern, limit],
      );
const agents = await client.query<{ id: string; name: string; description: string; status: string; icon: string }>(
        `SELECT id, name, description, status, icon FROM agents
         WHERE user_id = $1 AND (name ILIKE $2 OR description ILIKE $2)
         ORDER BY (key = 'vozcore') DESC, name ASC LIMIT $3`,
        [userId, pattern, limit],
      );
const memories = await client.query<{ id: string; title: string; category: string }>(
        `SELECT id, title, category FROM memories
         WHERE user_id = $1 AND (title ILIKE $2 OR content ILIKE $2)
         ORDER BY updated_at DESC LIMIT $3`,
        [userId, pattern, limit],
      );

    return {
      tasks: tasks.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        dueDate: row.due_date ?? null,
      })),
      agents: agents.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        icon: row.icon,
      })),
      memories: memories.rows.map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
      })),
    };
  });
}
