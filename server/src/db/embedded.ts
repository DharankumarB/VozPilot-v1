import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { env } from '../config/env';

/**
 * Database bootstrap.
 *
 * Preference order:
 *   1. `DATABASE_URL` — external/managed PostgreSQL (e.g. a cloud instance).
 *   2. Embedded PostgreSQL — real PostgreSQL server binaries published on npm,
 *      initialised into a local data directory. No Docker or system packages
 *      required.
 */

interface EmbeddedInstance {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const repoRoot = path.resolve(__dirname, '../../..');

let embedded: EmbeddedInstance | null = null;
let usingEmbedded = false;

function resolveDataDir(): string {
  const raw = env.EMBEDDED_PG_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

async function createDatabaseIfMissing(): Promise<void> {
  const client = new Client({
    host: '127.0.0.1',
    port: env.EMBEDDED_PG_PORT,
    user: 'postgres',
    password: env.EMBEDDED_PG_PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.APP_DB_NAME]);
    if ((existing.rowCount ?? 0) === 0) {
      // Database names are validated as identifiers in env.ts.
      await client.query(`CREATE DATABASE "${env.APP_DB_NAME}"`);
      console.log(`[db] Created database "${env.APP_DB_NAME}"`);
    }
  } finally {
    await client.end();
  }
}

async function waitForExternalDatabase(attempts = 6): Promise<void> {
  const client = new Client({ connectionString: env.DATABASE_URL });
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log('[db] Connected to external DATABASE_URL');
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
  throw new Error(`Could not reach DATABASE_URL: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function ensureDatabase(): Promise<void> {
  if (env.DATABASE_URL) {
    await waitForExternalDatabase();
    return;
  }

  usingEmbedded = true;
  const dataDir = resolveDataDir();
  const initialised = fs.existsSync(path.join(dataDir, 'PG_VERSION'));

  // Loaded lazily/typed loosely: the package ships as ESM only.
  const module = require('embedded-postgres') as {
    default: new (options: Record<string, unknown>) => EmbeddedInstance;
  };
  embedded = new module.default({
    databaseDir: dataDir,
    user: 'postgres',
    password: env.EMBEDDED_PG_PASSWORD,
    port: env.EMBEDDED_PG_PORT,
    persistent: true,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  });

  if (!initialised) {
    console.log(`[db] Initialising embedded PostgreSQL cluster in ${dataDir}`);
    await embedded.initialise();
  }
  await embedded.start();
  await createDatabaseIfMissing();
  console.log(`[db] Embedded PostgreSQL ready on 127.0.0.1:${env.EMBEDDED_PG_PORT}`);
}

/**
 * Create the restricted application role (when running embedded PostgreSQL)
 * and grant it access to every schema table. The application never connects
 * as the table owner, which is what makes row-level security meaningful.
 */
export async function provisionAppRole(): Promise<void> {
  if (env.DATABASE_URL) {
    // Managed databases provision their own users; access policies are still
    // defined by the migration, and every query filters by user id.
    return;
  }

  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const client = new Client({
    host: '127.0.0.1',
    port: env.EMBEDDED_PG_PORT,
    user: 'postgres',
    password: env.EMBEDDED_PG_PASSWORD,
    database: env.APP_DB_NAME,
  });
  await client.connect();
  try {
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [env.APP_DB_USER]);
    if ((role.rowCount ?? 0) === 0) {
      await client.query(`CREATE ROLE "${env.APP_DB_USER}" LOGIN PASSWORD ${literal(env.APP_DB_PASSWORD)}`);
      console.log(`[db] Created application role "${env.APP_DB_USER}"`);
    } else {
      await client.query(`ALTER ROLE "${env.APP_DB_USER}" PASSWORD ${literal(env.APP_DB_PASSWORD)}`);
    }
    await client.query(`GRANT CONNECT ON DATABASE "${env.APP_DB_NAME}" TO "${env.APP_DB_USER}"`);
    await client.query('GRANT USAGE ON SCHEMA public TO $1'.replace('$1', `"${env.APP_DB_USER}"`));
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${env.APP_DB_USER}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${env.APP_DB_USER}"`,
    );
  } finally {
    await client.end();
  }
}

export async function stopDatabase(): Promise<void> {
  if (embedded && usingEmbedded) {
    try {
      await embedded.stop();
      console.log('[db] Embedded PostgreSQL stopped');
    } catch (error) {
      console.warn('[db] Failed to stop embedded PostgreSQL:', error);
    }
  }
}
