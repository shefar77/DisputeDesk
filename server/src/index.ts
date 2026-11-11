import { buildApp } from './app.js';
import { boot, resetDemoData } from './boot.js';
import { closeDb } from './db/client.js';
import { env } from './env.js';
import { getDeterministic, initLlm, setLlm } from './llm/index.js';
import { logger } from './log.js';
import { pollDisputes, startPolling, stopPolling } from './services/sync.js';

await boot();

if (env.isDemo && process.env.DEMO_RESET_ON_BOOT !== 'false') {
  await resetDemoData();
}

/**
 * Fill the queue before the port opens, using the *rule-based* generator.
 *
 * This used to run after `listen` with the configured model, which meant a cold
 * start fired one evidence workflow per fixture — tens of model calls, each
 * retrying across the fallback chain under free-tier rate limits. On a
 * single-CPU 512 MiB instance that both starved the event loop (so the host's
 * port probe timed out) and climbed past the memory ceiling until the process
 * was killed. It only ever worked on a developer machine with cores to spare.
 *
 * The rule-based generator needs no network and no model memory, so the same
 * work finishes in milliseconds and the port opens onto an idle, fully
 * populated queue. The model is still what runs when a human asks for it —
 * "Re-gather" on a dispute — one dispute at a time.
 */
if (env.gatherOnBoot) {
  setLlm(getDeterministic());
  await pollDisputes({ gatherNew: true });
  setLlm(null);
  initLlm();
} else {
  await pollDisputes({ gatherNew: false });
}

const app = await buildApp();
await app.listen({ port: env.port, host: env.host });
logger.info(
  { port: env.port, mode: env.mode, demoReason: env.demoReason },
  `DisputeDesk API listening on http://localhost:${env.port}`,
);

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
