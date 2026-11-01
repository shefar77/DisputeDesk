/**
 * `npm run seed` — load fixture disputes and run the evidence workflow on each.
 * `npm run seed -- --rows=500` — additionally insert synthetic queue rows for the
 * AG Grid scale check (PRD §14: "grid renders 500 fixture rows"). Synthetic rows
 * have ids PP-D-SYN-*, are marked fixture, and are never sent anywhere.
 */

import { boot, resetDemoData } from '../boot.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { pollDisputes } from '../services/sync.js';

const rowsArg = process.argv.find((a) => a.startsWith('--rows='));
const synthetic = rowsArg ? Math.max(0, Number(rowsArg.split('=')[1]) - 14) : 0;

await boot();
if (env.isDemo) await resetDemoData();

const t0 = Date.now();
const { found, newIds } = await pollDisputes({ gatherNew: true });
logger.info({ found, gathered: newIds.length, ms: Date.now() - t0 }, 'Fixture disputes loaded and gathered');

if (synthetic > 0) {
  const reasons = ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED'];
  const statuses = ['WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED'];
  const now = Date.now();
  const rows = Array.from({ length: synthetic }, (_, i) => {
    const id = `PP-D-SYN-${String(i + 1).padStart(5, '0')}`;
    return {
      id,
      reason: reasons[i % reasons.length]!,
      stage: 'INQUIRY',
      status: statuses[i % 7 === 0 ? 2 : i % 5 === 0 ? 1 : 0]!,
      amountValue: (10 + ((i * 37) % 490)).toFixed(2),
      amountCurrency: 'USD',
      dueAt: new Date(now + ((i * 13) % 240 - 12) * 3_600_000),
      linksJson: [],
      rawJson: { dispute_id: id, _synthetic: true },
      fixture: true,
    };
  });
  for (let i = 0; i < rows.length; i += 100) {
    await getDb().insert(schema.disputes).values(rows.slice(i, i + 100)).onConflictDoNothing();
  }
  logger.info({ synthetic }, 'Synthetic queue rows inserted');
}

await closeDb();
