/** Shared startup for the server, the seed script, the eval and the tests. */

import { initDb, getDb, schema } from './db/client.js';
import { migrate } from './db/migrate.js';
import { env } from './env.js';
import { logger } from './log.js';
import { initLlm } from './llm/index.js';
import { initPayPal } from './paypal/index.js';
import { initRetrieval } from './retrieval/index.js';

export async function boot(): Promise<void> {
  await initDb();
  await migrate();
  initPayPal();
  initLlm();
  await initRetrieval();
}

/**
 * Demo state is ephemeral by design: the demo gateway keeps PayPal-side state in
 * memory, so on restart the database is reset to match it. Fixture deadlines are
 * relative to process start, which keeps the "due in 20h" hero case live.
 * LLM spend and the audit log are kept — the spend cap must survive restarts.
 */
export async function resetDemoData(): Promise<void> {
  if (!env.isDemo) throw new Error('resetDemoData is demo-only');
  await getDb().delete(schema.disputes);
  await getDb().delete(schema.webhookEvents);
  logger.info('Demo data reset');
}
