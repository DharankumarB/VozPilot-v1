import fs from 'fs';
import path from 'path';
import { adminPool } from './pool';

const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Forward-only SQL migration runner. Each file runs exactly once inside a
 * transaction and is recorded in `schema_migrations`.
 */
export async function runMigrations(): Promise<void> {
  await adminPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const appliedResult = await adminPool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
}
