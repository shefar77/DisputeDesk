import { buildApp } from './app.js';
import { boot, resetDemoData } from './boot.js';
import { closeDb } from './db/client.js';
import { env } from './env.js';
import { logger } from './log.js';
import { pollDisputes, startPolling, stopPolling } from './services/sync.js';

await boot();

if (env.isDemo && process.env.DEMO_RESET_ON_BOOT !== 'false') {
  await resetDemoData();
}

const app = await buildApp();
await app.listen({ port: env.port, host: env.host });
logger.info(
  { port: env.port, mode: env.mode, demoReason: env.demoReason },
  `DisputeDesk API listening on http://localhost:${env.port}`,
);

// Initial reconciliation runs after listen so the UI is reachable immediately;
// new disputes get the evidence workflow, exactly as a CREATED webhook would.
void pollDisputes();
startPolling();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  stopPolling();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
