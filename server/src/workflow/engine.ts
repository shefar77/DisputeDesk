/**
 * A small durable step runner for the evidence workflow.
 *
 * PRD §14 plans this as a Render Workflow task with retried steps, and lists an
 * in-process job queue as the fallback. This is that fallback, built to the same
 * semantics: named steps, per-step retries with backoff, every attempt persisted.
 * Persisting each step is what drives the live "Gathering evidence…" panel — the
 * UI reads `workflow_step` rows, so what the merchant sees is what actually ran.
 *
 * Render Workflows itself is NOT integrated (its SDK could not be exercised in
 * this build); the README states that plainly.
 *
 * Chaos hook: `CHAOS_FAIL_STEP=carrier_capture:1` makes the first attempt of that
 * step throw, which demonstrates a visible retry (PRD §14 acceptance test).
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb, schema } from '../db/client.js';
import { logger } from '../log.js';

export interface StepDef {
  name: string;
  label: string;
}

export interface StepOutcome<T> {
  value: T;
  detail?: string | null;
  /** Set when the step's primary path failed and a documented fallback ran. */
  fallbackUsed?: string | null;
  /** 'skipped' when the step had nothing to do (e.g. no tracking number). */
  status?: 'succeeded' | 'skipped';
}

export interface StepOptions {
  retries?: number;
  /** Throwing this kind of error ends the step immediately, without retry. */
  fatal?: (err: unknown) => boolean;
}

function chaosAttemptsFor(step: string): number {
  const spec = process.env.CHAOS_FAIL_STEP;
  if (!spec) return 0;
  for (const part of spec.split(',')) {
    const [name, count] = part.split(':');
    if (name === step) return Number(count ?? 1) || 1;
  }
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WorkflowRun {
  private constructor(
    readonly id: string,
    readonly disputeId: string,
    private readonly stepIds: Map<string, string>,
  ) {}

  static async start(disputeId: string, name: string, steps: StepDef[]): Promise<WorkflowRun> {
    const db = getDb();
    const id = nanoid();
    await db.insert(schema.workflowRuns).values({ id, disputeId, name, status: 'running' });
    const stepIds = new Map<string, string>();
    for (const [i, s] of steps.entries()) {
      const stepId = nanoid();
      stepIds.set(s.name, stepId);
      await db.insert(schema.workflowSteps).values({
        id: stepId,
        runId: id,
        disputeId,
        name: s.name,
        label: s.label,
        ordinal: i,
        status: 'pending',
      });
    }
    return new WorkflowRun(id, disputeId, stepIds);
  }

  async step<T>(name: string, fn: () => Promise<StepOutcome<T>>, opts: StepOptions = {}): Promise<T> {
    const db = getDb();
    const stepId = this.stepIds.get(name);
    if (!stepId) throw new Error(`Unknown workflow step "${name}"`);

    const maxAttempts = 1 + (opts.retries ?? 2);
    let chaos = chaosAttemptsFor(name);
    const started = Date.now();
    await db
      .update(schema.workflowSteps)
      .set({ status: 'running', startedAt: new Date(started) })
      .where(eq(schema.workflowSteps.id, stepId));

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await db.update(schema.workflowSteps).set({ attempts: attempt }).where(eq(schema.workflowSteps.id, stepId));
      try {
        if (chaos > 0) {
          chaos--;
          throw new Error(`CHAOS_FAIL_STEP: injected failure on attempt ${attempt}`);
        }
        const outcome = await fn();
        await db
          .update(schema.workflowSteps)
          .set({
            status: outcome.status ?? 'succeeded',
            finishedAt: new Date(),
            durationMs: Date.now() - started,
            detail: outcome.detail ?? (attempt > 1 ? `Succeeded on attempt ${attempt}` : null),
            fallbackUsed: outcome.fallbackUsed ?? null,
          })
          .where(eq(schema.workflowSteps.id, stepId));
        return outcome.value;
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ disputeId: this.disputeId, step: name, attempt, message }, 'Workflow step attempt failed');
        await db
          .update(schema.workflowSteps)
          .set({ detail: `Attempt ${attempt} failed: ${message.slice(0, 300)}` })
          .where(eq(schema.workflowSteps.id, stepId));
        if (opts.fatal?.(err) || attempt === maxAttempts) break;
        await sleep(300 * 2 ** (attempt - 1));
      }
    }

    await db
      .update(schema.workflowSteps)
      .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - started })
      .where(eq(schema.workflowSteps.id, stepId));
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Mark steps that never ran (because an earlier step ended the run) as skipped. */
  async skipRemaining(reason: string): Promise<void> {
    const db = getDb();
    const rows = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.runId, this.id));
    for (const r of rows) {
      if (r.status === 'pending') {
        await db
          .update(schema.workflowSteps)
          .set({ status: 'skipped', detail: reason })
          .where(eq(schema.workflowSteps.id, r.id));
      }
    }
  }

  async finish(status: 'succeeded' | 'failed', error: string | null = null): Promise<void> {
    await getDb()
      .update(schema.workflowRuns)
      .set({ status, finishedAt: new Date(), error })
      .where(eq(schema.workflowRuns.id, this.id));
  }
}

/** One workflow per dispute at a time; a second request joins the first. */
const inflight = new Map<string, Promise<void>>();

export function runExclusive(disputeId: string, fn: () => Promise<void>): Promise<void> {
  const existing = inflight.get(disputeId);
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(disputeId));
  inflight.set(disputeId, p);
  return p;
}

export function isRunning(disputeId: string): boolean {
  return inflight.has(disputeId);
}
