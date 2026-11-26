import { Pool, types, type PoolClient } from 'pg';
import { env } from '../config/env';

// PostgreSQL `date` (oid 1082) is returned as a plain 'YYYY-MM-DD' string so
// JSON payloads round-trip cleanly into <input type="date"> controls.
const typeParser = {
  getTypeParser: (oid: number, format?: string) =>
    oid === 1082 ? (value: string) => value : types.getTypeParser(oid, format as never),
};

function poolConfig(admin: boolean): ConstructorParameters<typeof Pool>[0] {
  const base = {
    max: admin ? 3 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    types: typeParser,
  };

  if (env.DATABASE_URL) {
    return { ...base, connectionString: env.DATABASE_URL };
  }

  return {
    ...base,
    host: '127.0.0.1',
    port: env.EMBEDDED_PG_PORT,
    database: env.APP_DB_NAME,
    user: admin ? 'postgres' : env.APP_DB_USER,
    password: admin ? env.EMBEDDED_PG_PASSWORD : env.APP_DB_PASSWORD,
  };
}

/**
 * Administrative pool — migrations, provisioning and pre-authentication
 * lookups (login/register) where no user identity exists yet.
 */
export const adminPool = new Pool(poolConfig(true));

/**
 * Application pool — used for every authenticated query.
 * When embedded PostgreSQL is in use this connects as the non-owner
 * `APP_DB_USER` role, so row-level security policies are enforced.
 */
export const appPool = new Pool(poolConfig(false));

/**
 * Run `fn` inside a transaction on the application pool with the current
 * user id exposed to PostgreSQL (`app.user_id`). RLS policies read this
 * setting and fail closed when it is missing.
 */
export async function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Run `fn` inside a transaction on the administrative pool. */
export async function withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([adminPool.end(), appPool.end()]);
}
