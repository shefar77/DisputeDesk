/**
 * gatherEvidence(disputeId) — the evidence workflow (PRD §15 sequence diagram).
 *
 *   fetch dispute -> PayPal transaction -> PayPal tracking -> order record
 *   -> carrier capture (KERNEL) -> extract facts (T1) -> retrieve policy
 *   -> score + plan (T2) -> draft (T3)
 *
 * Integrity rules enforced here rather than trusted to the model:
 *  - every evidence id the model cites must exist for this dispute (FR-8);
 *  - a tracking number the model reports must appear verbatim in some source
 *    text, or it is discarded (the T1 deterministic cross-check);
 *  - the completeness score comes from the rubric, never from the model;
 *  - the recommended action must be one PayPal currently offers, and the model
 *    may only recommend conceding (accept-claim) when the evidence is WEAK;
 *  - extraction confidence below 0.5 stops drafting: the UI flags the case
 *    instead of putting weak claims in the merchant's mouth (PRD §13).
 */

import { nanoid } from 'nanoid';
import { desc, eq } from 'drizzle-orm';
import {
  DISPUTE_REASON_LABELS,
  DRAFT_MAX_LENGTH,
  emptyFacts,
  evidencePlanSchema,
  formatDueIn,
  getRubric,
  scoreCompleteness,
  type DisputeAction,
  type DisputeReason,
  type DraftOutput,
  type EvidenceFacts,
  type EvidenceItemView,
  type EvidencePlan,
  type ExtractionOutput,
  type PlanNarrative,
} from '@shared/index.js';
import { getDb, schema } from '../db/client.js';
import { logger } from '../log.js';
import { getDemoGateway, getPayPal } from '../paypal/index.js';
import type { RawDispute } from '../paypal/types.js';
import { mapCarrierToEnum } from '../paypal/payload.js';
import { captureCarrierPage, trackingUrlFor } from '../capture/carrier.js';
import { retrievePolicies } from '../retrieval/index.js';
import { getLlm, withFallback, type LlmResult } from '../llm/index.js';
import { deterministicExtract } from '../llm/deterministic.js';
import type { RequirementSummary } from '../llm/client.js';
import { allowedActionsFromLinks, setGatherState, upsertDisputeFromRaw } from '../services/disputes.js';
import { addTimeline, audit, listEvidence, upsertEvidence } from '../services/records.js';
import { WorkflowRun, runExclusive, type StepDef } from './engine.js';

const STEPS: StepDef[] = [
  { name: 'fetch_dispute', label: 'Read dispute from PayPal' },
  { name: 'paypal_transaction', label: 'Read the disputed transaction' },
  { name: 'paypal_tracking', label: 'Read tracking attached in PayPal' },
  { name: 'order_record', label: 'Find the order record' },
  { name: 'carrier_capture', label: 'Capture the carrier tracking page' },
  { name: 'extract', label: 'Extract shipping facts' },
  { name: 'retrieve', label: 'Retrieve PayPal policy notes' },
  { name: 'plan', label: 'Score evidence and plan' },
  { name: 'draft', label: 'Draft the response' },
];

export const MIN_DRAFT_CONFIDENCE = 0.5;

export function gatherEvidence(disputeId: string, actor = 'system'): Promise<void> {
  return runExclusive(disputeId, () => run(disputeId, actor));
}

interface ShipTo {
  name?: string;
  line1?: string;
  city?: string;
  postal_code?: string;
  country_code?: string;
}

function formatAddress(a: ShipTo | null | undefined): string | null {
  if (!a) return null;
  const parts = [a.name, a.line1, a.city, a.postal_code, a.country_code].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function run(disputeId: string, actor: string): Promise<void> {
  const started = Date.now();
  await setGatherState(disputeId, 'GATHERING');
  const wf = await WorkflowRun.start(disputeId, 'gatherEvidence', STEPS);
  await audit('workflow.started', { workflow: 'gatherEvidence', runId: wf.id }, { actor, disputeId });

  try {
    const pp = getPayPal();
    const demo = getDemoGateway();
    const fixture = demo !== null;

    // 1 -------------------------------------------------------------------------
    const raw = await wf.step('fetch_dispute', async () => {
      const d = await pp.getDispute(disputeId);
      await upsertDisputeFromRaw(d, { fixture });
      await audit('paypal.read', { call: 'GET /v1/customer/disputes/{id}', status: d.status }, { disputeId });

      const buyer = (d.messages ?? []).filter((m) => m.posted_by === 'BUYER');
      if (buyer.length > 0) {
        await upsertEvidence({
          disputeId,
          kind: 'buyer_message',
          source: fixture ? 'fixture' : 'paypal',
          label: `Buyer message${buyer.length > 1 ? 's' : ''} (${buyer.length})`,
          sourceRef: 'GET /v1/customer/disputes/{id} — messages',
          contentText: buyer.map((m) => `[${m.time_posted ?? ''}] ${m.content ?? ''}`).join('\n'),
          fixture,
        });
      }
      return {
        value: d,
        detail: `${DISPUTE_REASON_LABELS[(d.reason ?? 'OTHER') as DisputeReason]}, ${d.status}, ${allowedActionsFromLinks(d.links).length} actions available`,
      };
    });

    const reason = (raw.reason ?? 'OTHER') as DisputeReason;
    const txn = raw.disputed_transactions?.[0];
    const txnId = txn?.seller_transaction_id ?? null;

    // 2 -------------------------------------------------------------------------
    await wf.step('paypal_transaction', async () => {
      if (!txn) return { value: null, status: 'skipped', detail: 'Dispute carries no transaction details' };
      const items = (txn.items ?? [])
        .map((i) => `${i.item_quantity ?? '1'} x ${i.item_name ?? 'item'} @ ${i.item_amount?.value ?? '?'} ${i.item_amount?.currency_code ?? ''}`)
        .join('\n');
      await upsertEvidence({
        disputeId,
        kind: 'paypal_transaction',
        source: fixture ? 'fixture' : 'paypal',
        label: `PayPal transaction ${txnId ?? ''}`.trim(),
        sourceRef: 'GET /v1/customer/disputes/{id} — disputed_transactions',
        contentText: [
          `Transaction: ${txnId ?? 'unknown'}`,
          `Created: ${txn.create_time ?? 'unknown'}`,
          `Status: ${txn.transaction_status ?? 'unknown'}`,
          `Amount: ${txn.gross_amount?.value ?? '?'} ${txn.gross_amount?.currency_code ?? ''}`,
          `Invoice: ${txn.invoice_number ?? '—'}`,
          `Items:\n${items || '—'}`,
        ].join('\n'),
        fixture,
      });
      return { value: txn, detail: `Transaction ${txnId ?? 'unknown'}` };
    });

    // 3 -------------------------------------------------------------------------
    const ppTracking = await wf.step('paypal_tracking', async () => {
      if (!txnId) return { value: null, status: 'skipped', detail: 'No transaction id to look up' };
      const t = await pp.getShipmentTracking(txnId);
      await audit('paypal.read', { call: 'GET /v1/shipping/trackers', found: Boolean(t) }, { disputeId });
      if (!t?.tracking_number) {
        return { value: null, status: 'skipped', detail: 'No tracking attached to this transaction in PayPal' };
      }
      await upsertEvidence({
        disputeId,
        kind: 'paypal_shipment_tracking',
        source: fixture ? 'fixture' : 'paypal',
        label: `PayPal shipment tracking (${t.carrier ?? 'carrier unknown'})`,
        sourceRef: 'GET /v1/shipping/trackers?transaction_id=…',
        contentText: [
          `Carrier: ${t.carrier ?? 'unknown'}`,
          `Tracking number: ${t.tracking_number}`,
          `Status: ${t.status ?? 'unknown'}`,
          `Shipment date: ${t.shipment_date ?? 'unknown'}`,
        ].join('\n'),
        fixture,
      });
      return { value: t, detail: `${t.carrier ?? 'Carrier'} ${t.tracking_number}` };
    });

    // 4 -------------------------------------------------------------------------
    // P0 sources: demo fixture, or a merchant upload. Zapier (PRD FR-15) is P1 and
    // not implemented; this step is where it would plug in.
    const order = await wf.step('order_record', async () => {
      const scenario = demo?.scenarioFor(disputeId);
      const rec = scenario?.orderRecord;
      if (!rec) {
        return {
          value: null,
          status: 'skipped',
          detail: fixture ? 'No order record for this fixture' : 'No order record connected — upload one to improve the address check',
        };
      }
      await upsertEvidence({
        disputeId,
        kind: 'order_record',
        source: 'fixture',
        label: `Order ${rec.order_id} (fixture standing in for "${rec.source}")`,
        sourceRef: rec.source,
        contentText: [
          `Order: ${rec.order_id}`,
          `Placed: ${rec.placed_at}`,
          `Shipped: ${rec.ship_date ?? 'not recorded'}`,
          `Carrier: ${rec.carrier ?? 'not recorded'}`,
          `Tracking: ${rec.tracking_number ?? 'not recorded'}`,
          `Ship to: ${formatAddress(rec.ship_to)}`,
          `Items: ${rec.items.map((i) => `${i.qty} x ${i.name}`).join(', ')}`,
        ].join('\n'),
        fixture: true,
      });
      return { value: rec, detail: `Order ${rec.order_id}` };
    });

    const shipTo =
      (order?.ship_to as ShipTo | undefined) ?? ((raw as RawDispute & { _fixture_ship_to?: ShipTo })._fixture_ship_to ?? null);
    const orderAddress = formatAddress(shipTo);

    // 5 -------------------------------------------------------------------------
    await wf.step(
      'carrier_capture',
      async () => {
        const trackingNo = ppTracking?.tracking_number ?? order?.tracking_number ?? null;
        const carrierEnum = mapCarrierToEnum(ppTracking?.carrier ?? order?.carrier ?? null);
        const url = trackingUrlFor(carrierEnum, trackingNo);
        if (!trackingNo && !fixture) {
          return { value: null, status: 'skipped', detail: 'No tracking number to look up', fallbackUsed: null };
        }

        const cap = await captureCarrierPage(disputeId, url);
        await audit(
          'capture.carrier',
          { provider: cap.provider, ok: cap.ok, host: cap.url ? new URL(cap.url).hostname : null, reason: cap.reason },
          { disputeId },
        );

        if (!cap.ok) {
          const fallback = ppTracking ? 'Using PayPal shipment data' : 'Upload proof of delivery to raise the score';
          await addTimeline(disputeId, 'workflow', 'Carrier capture failed', `${cap.reason}. ${fallback}.`);
          return {
            value: null,
            status: cap.reason?.startsWith('No carrier') || cap.reason?.startsWith('No tracking') ? 'skipped' : 'succeeded',
            detail: cap.reason,
            fallbackUsed: fallback,
          };
        }

        await upsertEvidence({
          disputeId,
          kind: 'carrier_capture',
          source: cap.provider === 'kernel' ? 'kernel' : 'fixture',
          label: `Carrier tracking page${cap.provider === 'fixture' ? ' (fixture)' : ''}`,
          sourceRef: cap.url,
          contentText: cap.text,
          filePath: cap.screenshotPath,
          mimeType: cap.screenshotPath ? 'image/jpeg' : null,
          bytes: cap.screenshotBytes,
          fixture: cap.provider === 'fixture',
          meta: { liveViewUrl: cap.liveViewUrl, httpStatus: cap.httpStatus, durationMs: cap.durationMs },
        });
        return {
          value: cap,
          detail: `${cap.provider === 'kernel' ? 'KERNEL' : 'Fixture'} capture of ${cap.url ? new URL(cap.url).hostname : 'carrier page'}`,
        };
      },
      { retries: 1 },
    );

    const rubric = getRubric(reason);
    if (!rubric) {
      await wf.skipRemaining(`"${DISPUTE_REASON_LABELS[reason]}" is not supported in this version`);
      await wf.finish('succeeded');
      await setGatherState(disputeId, 'NEEDS_MANUAL_REVIEW');
      await addTimeline(
        disputeId,
        'workflow',
        'Evidence gathered — manual handling required',
        `DisputeDesk does not score "${DISPUTE_REASON_LABELS[reason]}" disputes yet. Collected records are available for your own response.`,
      );
      return;
    }

    const items = await listEvidence(disputeId);
    const validIds = new Set(items.map((i) => i.id));

    // 6 -------------------------------------------------------------------------
    const extraction = await wf.step('extract', async () => {
      const res = await withFallback<ExtractionOutput>(
        'extract',
        async (llm) => validateExtraction(await llm.extract({ disputeId, reason, items, orderAddress }), items),
        async (det) => det.extract({ disputeId, reason, items, orderAddress }),
      );
      await logAi(disputeId, 'extract', res);
      return {
        value: res,
        detail: `${res.generator === 'llm' ? res.model : 'rules'} · confidence ${res.value?.confidence.toFixed(2) ?? '—'}`,
        fallbackUsed: res.fallbackReason ? `Rule-based extraction (${res.fallbackReason})` : null,
      };
    });

    const facts = toFacts(extraction.value);
    const presentKinds = items.map((i) => i.kind);
    const score = scoreCompleteness(reason, facts, { presentKinds })!;

    // 7 -------------------------------------------------------------------------
    const retrieval = await wf.step('retrieve', async () => {
      const query = [
        DISPUTE_REASON_LABELS[reason],
        ...score.missing.map((r) => r.label),
        facts.deliveryStatus !== 'UNKNOWN' ? facts.deliveryStatus.replace(/_/g, ' ').toLowerCase() : '',
        'tracking delivery evidence deadline',
      ].join(' ');
      const r = await retrievePolicies(query, reason, 4);
      return {
        value: r,
        detail: `${r.citations.length} passages via ${r.backend}`,
        fallbackUsed: r.degraded ? r.detail : null,
      };
    });

    const allowed = allowedActionsFromLinks(raw.links);
    const reqSummary: RequirementSummary[] = score.requirements.map((r) => ({
      id: r.id,
      label: r.label,
      satisfied: r.satisfied,
      detail: r.detail,
      critical: r.critical,
    }));
    const amount = raw.dispute_amount?.value ?? '0.00';
    const currency = raw.dispute_amount?.currency_code ?? 'USD';
    const buyerMessages = (raw.messages ?? [])
      .filter((m) => m.posted_by === 'BUYER')
      .map((m) => ({ posted: m.time_posted ?? '', by: m.posted_by ?? 'BUYER', content: m.content ?? '' }));

    // 8 -------------------------------------------------------------------------
    const plan = await wf.step('plan', async () => {
      const input = {
        disputeId,
        reason,
        amount,
        currency,
        dueIn: formatDueIn(raw.seller_response_due_date ?? null),
        completeness: score.score,
        band: score.band,
        contradicted: score.contradictions.length > 0,
        requirements: reqSummary,
        availableActions: allowed,
        items,
        citations: retrieval.citations,
        buyerMessages,
      };
      const res = await withFallback<PlanNarrative>(
        'plan',
        async (llm) => validatePlan(await llm.plan(input), validIds),
        async (det) => det.plan(input),
      );
      await logAi(disputeId, 'plan', res);

      const narrative = enforceRecommendation(res.value!, allowed, score.band, input, disputeId);

      const stored: EvidencePlan = evidencePlanSchema.parse({
        reason,
        completeness: score.score,
        rawCompleteness: score.rawScore,
        capped: score.capped,
        band: score.band,
        requirements: score.requirements,
        facts,
        narrative,
        citations: retrieval.citations,
        generator: res.generator,
        model: res.model,
      });

      const db = getDb();
      const [prev] = await db
        .select({ version: schema.plans.version })
        .from(schema.plans)
        .where(eq(schema.plans.disputeId, disputeId))
        .orderBy(desc(schema.plans.version))
        .limit(1);
      const planId = nanoid();
      await db.insert(schema.plans).values({
        id: planId,
        disputeId,
        version: (prev?.version ?? 0) + 1,
        json: stored as unknown as Record<string, unknown>,
        completeness: score.score,
        band: score.band,
        model: res.model,
        generator: res.generator,
      });

      return {
        value: { planId, stored },
        detail: `${score.score}/100 ${score.band}${score.capped ? ' (capped)' : ''} · recommends ${narrative.recommended_action}`,
        fallbackUsed: res.fallbackReason ? `Rule-based plan (${res.fallbackReason})` : null,
      };
    });

    // 9 -------------------------------------------------------------------------
    const confidence = facts.confidence;
    if (confidence < MIN_DRAFT_CONFIDENCE) {
      await wf.step('draft', async () => ({
        value: null,
        status: 'skipped',
        detail: `Extraction confidence ${confidence.toFixed(2)} is below ${MIN_DRAFT_CONFIDENCE} — not drafting claims the evidence may not support`,
      }));
      await setGatherState(disputeId, 'NEEDS_MANUAL_REVIEW');
    } else {
      await wf.step('draft', async () => {
        const input = {
          disputeId,
          reason,
          amount,
          currency,
          requirements: reqSummary,
          rationale: plan.stored.narrative.rationale,
          items,
          buyerMessages,
          maxChars: DRAFT_MAX_LENGTH,
        };
        const res = await withFallback<DraftOutput>(
          'draft',
          async (llm) => validateDraft(await llm.draft(input), validIds),
          async (det) => det.draft(input),
        );
        await logAi(disputeId, 'draft', res);

        await getDb()
          .insert(schema.drafts)
          .values({
            id: nanoid(),
            disputeId,
            planId: plan.planId,
            text: res.value!.text,
            evidenceRefs: res.value!.evidence_refs.filter((id) => validIds.has(id)),
            tone: res.value!.tone,
            model: res.model,
            generator: res.generator,
          });
        return {
          value: res.value,
          detail: `${res.value!.text.length} chars · cites ${res.value!.evidence_refs.join(', ')}`,
          fallbackUsed: res.fallbackReason ? `Template draft (${res.fallbackReason})` : null,
        };
      });
      await setGatherState(disputeId, 'READY_FOR_REVIEW');
    }

    await wf.finish('succeeded');
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    await addTimeline(
      disputeId,
      'workflow',
      `Evidence gathered in ${secs}s`,
      `Completeness ${score.score}/100 (${score.band}). ${items.length} evidence items.`,
    );
    await audit('workflow.finished', { runId: wf.id, durationMs: Date.now() - started, completeness: score.score }, { disputeId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ disputeId, message }, 'Evidence workflow failed');
    await wf.skipRemaining('Skipped after an earlier step failed');
    await wf.finish('failed', message);
    await setGatherState(disputeId, 'FAILED');
    await addTimeline(disputeId, 'workflow', 'Evidence gathering failed', message);
    await audit('workflow.failed', { runId: wf.id, error: message }, { disputeId });
  }
}

// ---------------------------------------------------------------------------
// validators — these turn model mistakes into retries instead of bad data
// ---------------------------------------------------------------------------

function allText(items: readonly EvidenceItemView[]): string {
  return items.map((i) => i.contentText ?? '').join('\n').toUpperCase().replace(/\s+/g, '');
}

/** FR-8 for extraction, plus the verbatim-tracking-number cross-check (T1). */
export function validateExtraction(
  res: LlmResult<ExtractionOutput>,
  items: readonly EvidenceItemView[],
): LlmResult<ExtractionOutput> {
  if (!res.ok || !res.value) return res;
  const ids = new Set(items.map((i) => i.id));
  const bad = res.value.sources.filter((s) => !ids.has(s.evidence_id));
  if (bad.length > 0) {
    return { ...res, ok: false, error: `Cited unknown evidence id(s): ${bad.map((b) => b.evidence_id).join(', ')}` };
  }
  const tn = res.value.tracking_number;
  if (tn && !allText(items).includes(tn.toUpperCase().replace(/\s+/g, ''))) {
    // Not a retry: keep the extraction but drop the field the model cannot back up.
    const det = deterministicExtract({ disputeId: '', reason: '', items, orderAddress: null });
    return {
      ...res,
      value: {
        ...res.value,
        tracking_number: det.tracking_number,
        notes: `${res.value.notes ?? ''} Model tracking number "${tn}" did not appear in any source and was replaced by the rule-based value.`.trim(),
      },
    };
  }
  return res;
}

export function validatePlan(res: LlmResult<PlanNarrative>, validIds: Set<string>): LlmResult<PlanNarrative> {
  if (!res.ok || !res.value) return res;
  const cited = res.value.rationale.flatMap((r) => r.evidence_ids);
  const bad = cited.filter((id) => !validIds.has(id));
  if (bad.length > 0) return { ...res, ok: false, error: `Plan cited unknown evidence id(s): ${bad.join(', ')}` };
  return res;
}

export function validateDraft(res: LlmResult<DraftOutput>, validIds: Set<string>): LlmResult<DraftOutput> {
  if (!res.ok || !res.value) return res;
  const bad = res.value.evidence_refs.filter((id) => !validIds.has(id));
  if (bad.length > 0) return { ...res, ok: false, error: `Draft cited unknown evidence id(s): ${bad.join(', ')}` };
  // Ids mentioned inline in the text must be cited too, and must exist.
  const inline = [...res.value.text.matchAll(/\bE-\d+\b/g)].map((m) => m[0]);
  const badInline = inline.filter((id) => !validIds.has(id));
  if (badInline.length > 0) return { ...res, ok: false, error: `Draft text mentions unknown evidence id(s): ${badInline.join(', ')}` };
  return res;
}

/**
 * The model recommends; this function decides whether to accept the
 * recommendation. A recommendation of an action PayPal is not offering is
 * replaced. A recommendation to concede on evidence that is not WEAK is replaced
 * too — that is the behaviour a prompt injection would try to produce.
 */
function enforceRecommendation(
  narrative: PlanNarrative,
  allowed: readonly DisputeAction[],
  band: string,
  input: Parameters<ReturnType<typeof getLlm>['plan']>[0],
  disputeId: string,
): PlanNarrative {
  let reason: string | null = null;
  if (!allowed.includes(narrative.recommended_action)) {
    reason = `"${narrative.recommended_action}" is not currently offered by PayPal`;
  } else if (narrative.recommended_action === 'accept-claim' && band !== 'WEAK') {
    reason = `conceding is not recommended when evidence is ${band}`;
  }
  if (!reason) return narrative;

  logger.warn({ disputeId, reason }, 'Overriding model recommendation');
  void audit('ai.recommendation_overridden', { reason, from: narrative.recommended_action }, { disputeId });
  const det = (() => {
    // Reuse the rule-based recommendation for consistency with the fallback path.
    const { recommended_action, recommended_action_why } = deterministicPlanRec(input);
    return { recommended_action, recommended_action_why };
  })();
  return {
    ...narrative,
    recommended_action: det.recommended_action,
    recommended_action_why: `${det.recommended_action_why} (Model suggestion replaced: ${reason}.)`,
  };
}

function deterministicPlanRec(input: Parameters<ReturnType<typeof getLlm>['plan']>[0]) {
  const has = (a: DisputeAction) => input.availableActions.includes(a);
  if (input.contradicted && has('make-offer')) {
    return { recommended_action: 'make-offer' as DisputeAction, recommended_action_why: 'Carrier evidence contradicts delivery.' };
  }
  if (input.completeness >= 40 && has('provide-evidence')) {
    return { recommended_action: 'provide-evidence' as DisputeAction, recommended_action_why: 'The evidence supports a response.' };
  }
  if (has('make-offer')) return { recommended_action: 'make-offer' as DisputeAction, recommended_action_why: 'Evidence is weak.' };
  return {
    recommended_action: (input.availableActions[0] ?? 'send-message') as DisputeAction,
    recommended_action_why: 'Only limited actions are available.',
  };
}

export function toFacts(x: ExtractionOutput | null): EvidenceFacts {
  if (!x) return emptyFacts();
  const sources: Record<string, string> = {};
  for (const s of x.sources) sources[s.field] = s.evidence_id;
  return {
    carrier: x.carrier,
    carrierEnum: x.carrier_enum ?? mapCarrierToEnum(x.carrier),
    trackingNumber: x.tracking_number,
    deliveryStatus: x.delivery_status,
    deliveredAt: x.delivered_at,
    lastKnownLocation: x.last_known_location,
    signatureObtained: x.signature_obtained,
    addressMatch: x.address_match,
    shipDate: x.ship_date,
    sources,
    confidence: x.confidence,
  };
}

async function logAi(
  disputeId: string,
  task: string,
  res: LlmResult<unknown> & { attempts: number; fallbackReason: string | null },
): Promise<void> {
  await audit(
    `ai.${task}`,
    {
      generator: res.generator,
      model: res.model,
      attempts: res.attempts,
      ok: res.ok,
      fallbackReason: res.fallbackReason,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUsd: Number(res.costUsd.toFixed(6)),
      durationMs: res.durationMs,
    },
    { disputeId },
  );
}
