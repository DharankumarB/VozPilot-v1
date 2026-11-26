import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { adminPool, withUser, withAdmin } from '../../db/pool';
import { seedDefaultAgents, seedDefaultIntegrations } from '../../db/seedDefaults';
import { logActivity } from '../../lib/activity';
import { ConflictError, UnauthorizedError } from '../../lib/errors';
import { toPublicUser, type PublicUser, type UserRow } from '../../lib/serialize';

const BCRYPT_ROUNDS = 12;

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function register(input: RegisterInput): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  return withAdmin(async (client: PoolClient) => {
    const existing = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [input.email]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new ConflictError('An account with this email already exists.');
    }

    const inserted = await client.query<UserRow>(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [input.name.trim(), input.email.trim().toLowerCase(), passwordHash],
    );
    const user = inserted.rows[0];

    // Real, non-fabricated defaults: agent profiles + honest integration rows.
    await seedDefaultAgents(client, user.id);
    await seedDefaultIntegrations(client, user.id);
    await logActivity(client, {
      userId: user.id,
      type: 'auth_register',
      category: 'auth',
      title: 'Workspace created',
      detail: `Registered ${user.email}`,
    });

    return toPublicUser(user);
  });
}

export async function login(input: LoginInput): Promise<PublicUser> {
  const result = await withAdmin(async (client: PoolClient) => {
    const found = await client.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [
      input.email.trim(),
    ]);
    const user = found.rows[0];

    const valid = user ? await bcrypt.compare(input.password, user.password_hash) : false;
    if (!user || !valid) {
      throw new UnauthorizedError('Incorrect email or password.', 'invalid_credentials');
    }

    await logActivity(client, {
      userId: user.id,
      type: 'auth_login',
      category: 'auth',
      title: 'Signed in',
      detail: user.email,
    });

    return toPublicUser(user);
  });
  return result;
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  return withUser(userId, async (client) => {
    const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    return row ? toPublicUser(row) : null;
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await withUser(userId, async (client) => {
    const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = result.rows[0];
    if (!user) {
      throw new UnauthorizedError('Account not found.', 'invalid_session');
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      throw new UnauthorizedError('Your current password is incorrect.', 'invalid_credentials');
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    await logActivity(client, {
      userId,
      type: 'settings_password_changed',
      category: 'settings',
      title: 'Password changed',
      detail: 'Account password was updated',
    });
  });
}

/** Fetch a user by id without tenant scoping — used only by refresh flow. */
export async function getUserForRefresh(userId: string): Promise<PublicUser | null> {
  const result = await adminPool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  return row ? toPublicUser(row) : null;
}
