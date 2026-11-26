import { env } from './config/env';
import { ensureDatabase, provisionAppRole, stopDatabase } from './db/embedded';
import { runMigrations } from './db/migrate';
import { closePools } from './db/pool';
import { createApp } from './app';

async function main(): Promise<void> {
  console.log(`\n  VozPilot API — Phase 1 foundation`);
  console.log(`  VozLook Studios · environment: ${env.NODE_ENV}\n`);

  await ensureDatabase();
  await runMigrations();
  await provisionAppRole();

  const app = createApp();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`  ✔ API + client listening on http://0.0.0.0:${env.PORT}`);
    console.log(`  ✔ Health check: http://127.0.0.1:${env.PORT}/api/health\n`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] Received ${signal}, shutting down…`);
    server.close();
    try {
      await closePools();
      await stopDatabase();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('\n✖ VozPilot failed to start:\n', error, '\n');
  process.exit(1);
});
