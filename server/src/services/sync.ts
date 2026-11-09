/**
 * Getting disputes in: signed webhooks (FR-1) with polling as the safety net (FR-2).
 *
 * Both paths end in the same place: re-read the dispute from PayPal and upsert it.
 * A webhook body is treated as a *notification that something changed*, never as
 * the source of the new state — the dispute is always fetched fresh.
 */

import { eq } from 'drizzle-orm';
import { webhookEnvelopeSchema, WEBHOOK_EVENT_TYPES } from '@shared/index.js';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { getPayPal } from '../paypal/index.js';
import { gatherEvidence } from '../workflow/gatherEvidence.js';
import { refreshFromPayPal } from './approval.js';
import { getDisputeRow, upsertDisputeFromRaw } from './disputes.js';
import { addTimeline, audit } from './records.js';

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function handleWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  opts: { simulated?: boolean } = {},
): Promise<WebhookOutcome> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { type: 'invalid-body', title: 'Body is not JSON' } };
  }
  const env_ = webhookEnvelopeSchema.safeParse(parsedJson);
  if (!env_.success) return { status: 400, body: { type: 'invalid-envelope', title: 'Not a PayPal webhook envelope' } };
  const event = env_.data;

  // Verify against PayPal before doing anything with the content.
  const verification = opts.simulated
    ? { verified: false, status: 'DEMO_SIMULATED_NOT_VERIFIED' }
    : await getPayPal().verifyWebhookSignature(headers, rawBody);

  if (!verification.verified && env.paypal.requireWebhookSignature && !opts.simulated) {
    await audit('webhook.rejected', { eventId: event.id, type: event.event_type, reason: verification.status });
    logger.warn({ eventId: event.id, reason: verification.status }, 'Rejected unverifiable webhook');
    return { status: 400, body: { type: 'signature-invalid', title: 'Webhook signature could not be verified', detail: verification.status } };
  }

  // Idempotency on PayPal's event id.
  const db = getDb();
  const inserted = await db
    .insert(schema.webhookEvents)
    .values({
      eventId: event.id,
      type: event.event_type,
      verified: verification.verified,
      verificationStatus: verification.status,
      rawJson: parsedJson as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    await db.update(schema.webhookEvents).set({ processedAt: new Date() }).where(eq(schema.webhookEvents.eventId, event.id));
    return { status: 200, body: { received: true, ignored: event.event_type } };
  }

  const disputeId = String((event.resource as { dispute_id?: unknown } | undefined)?.dispute_id ?? '');
  if (!disputeId) return { status: 400, body: { type: 'no-dispute-id', title: 'Event has no resource.dispute_id' } };

  const existed = Boolean(await getDisputeRow(disputeId));
  await db.update(schema.webhookEvents).set({ disputeId }).where(eq(schema.webhookEvents.eventId, event.id));

  try {
    if (!existed) {
      const d = await getPayPal().getDispute(disputeId);
      await upsertDisputeFromRaw(d, { fixture: env.isDemo });
    } else {
      await refreshFromPayPal(disputeId);
    }
    const label = verification.verified ? 'verified' : opts.simulated ? 'demo simulation, unverified' : 'unverified (demo mode)';
    const what = event.event_type.split('.').pop()?.toLowerCase() ?? 'updated';
    await addTimeline(
      disputeId,
      'webhook',
      `PayPal notification: dispute ${what}`,
      `${event.event_type} · signature ${label} · dispute re-read from PayPal`,
    );
    await audit('webhook.processed', { eventId: event.id, type: event.event_type, verified: verification.verified }, { disputeId });
    await db.update(schema.webhookEvents).set({ processedAt: new Date() }).where(eq(schema.webhookEvents.eventId, event.id));

    if (event.event_type === 'CUSTOMER.DISPUTE.CREATED' || !existed) {
      void gatherEvidence(disputeId, 'webhook');
    }
    return { status: 200, body: { received: true, disputeId, verified: verification.verified } };
  } catch (err) {
    logger.error({ eventId: event.id, err: err instanceof Error ? err.message : err }, 'Webhook processing failed');
    // 500 makes PayPal retry delivery; the event row stays unprocessed for reconciliation.
    return { status: 500, body: { type: 'processing-failed', title: 'Could not process event' } };
  }
}

let lastPoll: { at: string; found: number; newCount: number; error: string | null } | null = null;
export function lastPollStatus() {
  return lastPoll;
}

/** FR-2: reconcile with PayPal. New disputes get the evidence workflow started. */
export async function pollDisputes(opts: { gatherNew?: boolean } = {}): Promise<{ found: number; newIds: string[] }> {
  try {
    const list = await getPayPal().listDisputes({ maxPages: 5 });
    const newIds: string[] = [];
    for (const summary of list) {
      const existed = await getDisputeRow(summary.dispute_id);
      // The list endpoint returns summaries; detail carries links and the deadline.
      const full = env.isDemo ? summary : await getPayPal().getDispute(summary.dispute_id);
      await upsertDisputeFromRaw(full, { fixture: env.isDemo });
      if (!existed) newIds.push(summary.dispute_id);
    }
    lastPoll = { at: new Date().toISOString(), found: list.length, newCount: newIds.length, error: null };
    if (newIds.length) await audit('poll.new_disputes', { count: newIds.length, ids: newIds });
    if (opts.gatherNew !== false) {
      for (const id of newIds) await gatherEvidence(id, 'poll');
    }
    return { found: list.length, newIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastPoll = { at: new Date().toISOString(), found: 0, newCount: 0, error: message };
    logger.error({ message }, 'Dispute poll failed');
    return { found: 0, newIds: [] };
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPolling(): void {
  if (!env.paypal.pollEnabled || timer) return;
  const ms = Math.max(1, env.paypal.pollIntervalMinutes) * 60_000;
  timer = setInterval(() => void pollDisputes(), ms);
  timer.unref();
  logger.info({ everyMinutes: env.paypal.pollIntervalMinutes }, 'Dispute polling scheduled');
}

export function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
