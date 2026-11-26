import { z } from 'zod';
import { withUser } from '../../db/pool';
import { logActivity } from '../../lib/activity';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { toPublicUser, type UserRow } from '../../lib/serialize';

export interface UserPreferences {
  appearance?: {
    accent?: 'violet' | 'gold' | 'teal' | 'rose';
    density?: 'comfortable' | 'compact';
  };
  notifications?: {
    approvals?: boolean;
    taskUpdates?: boolean;
    weeklyDigest?: boolean;
    email?: boolean;
    desktop?: boolean;
  };
  agentDefaults?: {
    defaultAgentId?: string | null;
    defaultPriority?: 'low' | 'medium' | 'high' | 'critical';
  };
}

export async function getSettings(userId: string): Promise<{
  profile: ReturnType<typeof toPublicUser>;
  preferences: UserPreferences;
}> {
  return withUser(userId, async (client) => {
    const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Account not found.');
    return { profile: toPublicUser(row), preferences: (row.preferences ?? {}) as UserPreferences };
  });
}

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
});
export type ProfileInput = z.infer<typeof profileSchema>;
export { profileSchema };

export async function updateProfile(userId: string, input: ProfileInput) {
  return withUser(userId, async (client) => {
    const existing = await client.query<UserRow>(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = existing.rows[0];
    if (!user) throw new NotFoundError('Account not found.');

    if (input.email !== user.email) {
      const conflict = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [
        input.email,
        userId,
      ]);
      if ((conflict.rowCount ?? 0) > 0) {
        throw new ConflictError('That email is already used by another account.');
      }
    }

    await client.query('UPDATE users SET name = $2, email = $3 WHERE id = $1', [
      userId,
      input.name,
      input.email,
    ]);

    const changes: string[] = [];
    if (input.name !== user.name) changes.push('Name changed');
    if (input.email !== user.email) changes.push('Email changed');
    if (changes.length > 0) {
      await logActivity(client, {
        userId,
        type: 'settings_profile_updated',
        category: 'settings',
        title: 'Profile updated',
        detail: changes.join(' · '),
      });
    }

    const updated = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return toPublicUser(updated.rows[0]);
  });
}

export const appearanceSchema = z.object({
  accent: z.enum(['violet', 'gold', 'teal', 'rose']).default('violet'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
});
export type AppearanceInput = z.infer<typeof appearanceSchema>;

export const notificationsSchema = z.object({
  approvals: z.boolean().default(true),
  taskUpdates: z.boolean().default(true),
  weeklyDigest: z.boolean().default(false),
  email: z.boolean().default(false),
  desktop: z.boolean().default(true),
});
export type NotificationsInput = z.infer<typeof notificationsSchema>;

export const agentDefaultsSchema = z.object({
  defaultAgentId: z.string().uuid().nullable().default(null),
  defaultPriority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});
export type AgentDefaultsInput = z.infer<typeof agentDefaultsSchema>;

async function mergePreferences(
  userId: string,
  section: 'appearance' | 'notifications' | 'agentDefaults',
  value: unknown,
  activityTitle: string,
  activityDetail: string,
): Promise<UserPreferences> {
  return withUser(userId, async (client) => {
    const result = await client.query<UserRow>(
      'SELECT preferences FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Account not found.');
    const preferences = { ...(row.preferences ?? {}) } as UserPreferences;
    (preferences as Record<string, unknown>)[section] = value;
    await client.query('UPDATE users SET preferences = $2 WHERE id = $1', [
      userId,
      JSON.stringify(preferences),
    ]);
    await logActivity(client, {
      userId,
      type: 'settings_updated',
      category: 'settings',
      title: activityTitle,
      detail: activityDetail,
    });
    return preferences;
  });
}

export async function updateAppearance(userId: string, input: AppearanceInput): Promise<UserPreferences> {
  return mergePreferences(userId, 'appearance', input, 'Appearance updated', `${input.accent} accent · ${input.density} density`);
}

export async function updateNotifications(
  userId: string,
  input: NotificationsInput,
): Promise<UserPreferences> {
  return mergePreferences(userId, 'notifications', input, 'Notification preferences updated', Object.entries(input).map(([key, on]) => `${key}: ${on ? 'on' : 'off'}`).join(' · '));
}

export async function updateAgentDefaults(
  userId: string,
  input: AgentDefaultsInput,
): Promise<UserPreferences> {
  if (input.defaultAgentId) {
    await withUser(userId, async (client) => {
      const agent = await client.query('SELECT 1 FROM agents WHERE id = $1 AND user_id = $2', [
        input.defaultAgentId,
        userId,
      ]);
      if ((agent.rowCount ?? 0) === 0) {
        throw new NotFoundError('The selected default agent does not exist.');
      }
    });
  }
  return mergePreferences(
    userId,
    'agentDefaults',
    input,
    'Agent defaults updated',
    `Priority: ${input.defaultPriority}${input.defaultAgentId ? ' · default agent set' : ' · no default agent'}`,
  );
}
