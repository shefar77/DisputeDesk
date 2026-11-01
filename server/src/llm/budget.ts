/**
 * LLM spend cap (PRD §13: "≤ $5/day demo cap, hard stop in code").
 *
 * The ledger lives in Postgres rather than in memory so the cap survives a
 * restart — a cap that resets whenever the process cycles is not a cap. Spend is
 * checked before each call and the caller falls back to the deterministic
 * generator when the budget is gone, so exhausting it degrades quality rather
 * than breaking the product.
 */

import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../log.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function spentTodayUsd(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${schema.llmUsage.costUsd}), 0)` })
    .from(schema.llmUsage)
    .where(sql`${schema.llmUsage.day} = ${today()}`);
  return Number(rows[0]?.total ?? 0);
}

export async function remainingBudgetUsd(): Promise<number> {
  const spent = await spentTodayUsd();
  return Math.max(0, env.llm.dailyCapUsd - spent);
}

export interface UsageRecord {
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  disputeId: string | null;
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  const db = getDb();
  await db.insert(schema.llmUsage).values({
    id: nanoid(),
    day: today(),
    task: record.task,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: record.costUsd.toFixed(6),
    disputeId: record.disputeId,
  });

  const spent = await spentTodayUsd();
  if (spent >= env.llm.dailyCapUsd) {
    logger.warn(
      { spent, cap: env.llm.dailyCapUsd },
      'LLM daily budget reached — further calls will use the deterministic generator',
    );
  }
}

export async function budgetStatus(): Promise<{ spentUsd: number; capUsd: number; remainingUsd: number }> {
  const spentUsd = await spentTodayUsd();
  return {
    spentUsd: Number(spentUsd.toFixed(6)),
    capUsd: env.llm.dailyCapUsd,
    remainingUsd: Number(Math.max(0, env.llm.dailyCapUsd - spentUsd).toFixed(6)),
  };
}
