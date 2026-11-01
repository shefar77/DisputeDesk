/**
 * Dispute state.
 *
 * Rule (PRD §12): dispute status is ALWAYS sourced from PayPal, never inferred
 * from our own writes. After we submit evidence we re-read the dispute; we do not
 * set status ourselves. `gather_state` is ours — it tracks the evidence workflow,
 * not the dispute.
 */

import { desc, eq } from 'drizzle-orm';
import {
  DISPUTE_ACTIONS,
  DISPUTE_REASON_LABELS,
  compareTriage,
  formatDueIn,
  isSupportedReason,
  urgencyFor,
  type DisputeAction,
  type DisputeDetail,
  type DisputeListItem,
  type DisputeReason,
  type DisputeStage,
  type DisputeStatus,
  type DraftView,
  type EvidencePlan,
  type GatherState,
  type PayPalLink,
  type SubmissionView,
  type WorkflowStepView,
} from '@shared/index.js';
import { getDb, schema } from '../db/client.js';
import type { RawDispute } from '../paypal/types.js';
import { listEvidence, listTimeline } from './records.js';

/** FR-4: allowed actions come only from PayPal's HATEOAS links. */
export function allowedActionsFromLinks(links: readonly PayPalLink[] | null | undefined): DisputeAction[] {
  const rels = new Set((links ?? []).map((l) => l.rel));
  return DISPUTE_ACTIONS.filter((a) => rels.has(a));
}

export function linkFor(links: readonly PayPalLink[] | null | undefined, action: DisputeAction): PayPalLink | null {
  return (links ?? []).find((l) => l.rel === action) ?? null;
}

export async function upsertDisputeFromRaw(raw: RawDispute, opts: { fixture?: boolean } = {}): Promise<void> {
  const db = getDb();
  const values = {
    id: raw.dispute_id,
    reason: raw.reason ?? 'OTHER',
    stage: raw.dispute_life_cycle_stage ?? null,
    status: raw.status ?? 'OTHER',
    amountValue: raw.dispute_amount?.value ?? null,
    amountCurrency: raw.dispute_amount?.currency_code ?? null,
    dueAt: raw.seller_response_due_date ? new Date(raw.seller_response_due_date) : null,
    linksJson: (raw.links ?? []) as unknown[],
    rawJson: raw as Record<string, unknown>,
    fixture: opts.fixture ?? false,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.disputes)
    .values({ ...values, createdAt: raw.create_time ? new Date(raw.create_time) : new Date() })
    .onConflictDoUpdate({
      target: schema.disputes.id,
      set: {
        reason: values.reason,
        stage: values.stage,
        status: values.status,
        amountValue: values.amountValue,
        amountCurrency: values.amountCurrency,
        dueAt: values.dueAt,
        linksJson: values.linksJson,
        rawJson: values.rawJson,
        updatedAt: values.updatedAt,
      },
    });
}

export async function setGatherState(disputeId: string, state: GatherState): Promise<void> {
  await getDb()
    .update(schema.disputes)
    .set({ gatherState: state, updatedAt: new Date() })
    .where(eq(schema.disputes.id, disputeId));
}

export async function getDisputeRow(disputeId: string) {
  const [row] = await getDb().select().from(schema.disputes).where(eq(schema.disputes.id, disputeId));
  return row ?? null;
}

export async function latestPlan(disputeId: string): Promise<{ id: string; plan: EvidencePlan } | null> {
  const [row] = await getDb()
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.disputeId, disputeId))
    .orderBy(desc(schema.plans.version))
    .limit(1);
  return row ? { id: row.id, plan: row.json as unknown as EvidencePlan } : null;
}

export async function latestDraftRow(disputeId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.disputeId, disputeId))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(1);
  return row ?? null;
}

function draftView(row: typeof schema.drafts.$inferSelect | null): DraftView | null {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    editedText: row.editedText,
    evidenceRefs: row.evidenceRefs,
    tone: row.tone,
    generator: row.generator as DraftView['generator'],
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

type DisputeRow = typeof schema.disputes.$inferSelect;

function toListItem(row: DisputeRow, plan: EvidencePlan | null, now: Date): DisputeListItem {
  const dueAt = row.dueAt ? row.dueAt.toISOString() : null;
  const reason = row.reason as DisputeReason;
  const links = row.linksJson as PayPalLink[];
  return {
    id: row.id,
    reason,
    reasonLabel: DISPUTE_REASON_LABELS[reason] ?? reason,
    stage: (row.stage as DisputeStage | null) ?? null,
    status: row.status as DisputeStatus,
    amountValue: row.amountValue ?? '0.00',
    amountCurrency: row.amountCurrency ?? 'USD',
    dueAt,
    urgency: urgencyFor(dueAt, now),
    dueIn: formatDueIn(dueAt, now),
    completeness: plan?.completeness ?? null,
    band: plan?.band ?? null,
    gatherState: row.gatherState as GatherState,
    allowedActions: allowedActionsFromLinks(links),
    recommendedAction: plan?.narrative.recommended_action ?? null,
    triageNote: plan?.narrative.triage_note ?? null,
    supported: isSupportedReason(reason),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The queue. Sorted deterministically by deadline (FR-3), never by the model. */
export async function listDisputes(now: Date = new Date()): Promise<(DisputeListItem & { fixture: boolean })[]> {
  const db = getDb();
  const rows = await db.select().from(schema.disputes);
  const plans = await db.select().from(schema.plans).orderBy(desc(schema.plans.version));
  const latest = new Map<string, EvidencePlan>();
  for (const p of plans) if (!latest.has(p.disputeId)) latest.set(p.disputeId, p.json as unknown as EvidencePlan);

  return rows
    .map((r) => ({ ...toListItem(r, latest.get(r.id) ?? null, now), fixture: r.fixture }))
    .sort((a, b) => {
      // Resolved disputes sink to the bottom regardless of their old deadline.
      const ra = a.status === 'RESOLVED' ? 1 : 0;
      const rb = b.status === 'RESOLVED' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return compareTriage(a, b, now);
    });
}

export async function listSteps(disputeId: string): Promise<WorkflowStepView[]> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.disputeId, disputeId))
    .orderBy(desc(schema.workflowRuns.startedAt))
    .limit(1);
  if (!run) return [];
  const steps = await db
    .select()
    .from(schema.workflowSteps)
    .where(eq(schema.workflowSteps.runId, run.id))
    .orderBy(schema.workflowSteps.ordinal);
  return steps.map((s) => ({
    name: s.name,
    label: s.label,
    status: s.status as WorkflowStepView['status'],
    attempts: s.attempts,
    startedAt: s.startedAt?.toISOString() ?? null,
    finishedAt: s.finishedAt?.toISOString() ?? null,
    durationMs: s.durationMs,
    detail: s.detail,
    fallbackUsed: s.fallbackUsed,
  }));
}

export async function listSubmissions(disputeId: string): Promise<SubmissionView[]> {
  const rows = await getDb()
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.disputeId, disputeId))
    .orderBy(desc(schema.approvals.approvedAt));
  return rows.map((r) => ({
    id: r.id,
    action: r.action as DisputeAction,
    approvedAt: r.approvedAt.toISOString(),
    approvedBy: r.approvedBy,
    payloadSha256: r.payloadSha256,
    resultStatus: r.resultStatus,
    httpStatus: r.httpStatus,
    debugId: r.debugId,
    error: r.error,
  }));
}

/** Plain-language explanations for what the merchant can and cannot do (J3, J4). */
function guidanceFor(item: DisputeListItem, plan: EvidencePlan | null): string[] {
  const g: string[] = [];
  if (!item.supported) {
    g.push(
      `DisputeDesk handles "Item not received" disputes in this version. This one is "${item.reasonLabel}" — ` +
        'review it in PayPal\'s Resolution Center or respond manually. No AI plan was generated, so nothing is guessed.',
    );
  }
  if (!item.allowedActions.includes('provide-evidence') && item.status !== 'RESOLVED') {
    const available = item.allowedActions;
    g.push(
      available.length > 0
        ? `PayPal is not accepting evidence for this dispute right now. Available: ${available.join(', ')}.`
        : 'PayPal currently offers no actions on this dispute. It will refresh automatically when that changes.',
    );
  }
  if (item.urgency.level === 'CRITICAL' && plan && plan.band !== 'COMPLETE' && plan.band !== 'STRONG') {
    g.push('Less than 24 hours left and evidence is incomplete. Submitting what you have may be better than missing the deadline — incomplete evidence may reduce your chances.');
  }
  if (item.urgency.level === 'OVERDUE' && item.status !== 'RESOLVED') {
    g.push('The response deadline has passed. PayPal may already have decided this dispute.');
  }
  if (plan?.capped) {
    g.push(
      `Score capped at ${plan.completeness} (would be ${plan.rawCompleteness}) because some evidence contradicts a delivery claim. A reviewer will see this too.`,
    );
  }
  return g;
}

export async function getDisputeDetail(disputeId: string, now: Date = new Date()): Promise<(DisputeDetail & { fixture: boolean }) | null> {
  const row = await getDisputeRow(disputeId);
  if (!row) return null;
  const planRec = await latestPlan(disputeId);
  const plan = planRec?.plan ?? null;
  const item = toListItem(row, plan, now);
  const raw = row.rawJson as unknown as RawDispute;

  const [evidence, steps, timeline, submissions, draftRow] = await Promise.all([
    listEvidence(disputeId),
    listSteps(disputeId),
    listTimeline(disputeId),
    listSubmissions(disputeId),
    latestDraftRow(disputeId),
  ]);

  // Strip our own fixture annotations from the raw view so "Raw API" shows PayPal's shape.
  const { _fixture_tracking: _t, _fixture_ship_to: _s, ...rawClean } = raw as RawDispute & {
    _fixture_tracking?: unknown;
    _fixture_ship_to?: unknown;
  };

  return {
    ...item,
    fixture: row.fixture,
    buyerMessages: (raw.messages ?? []).map((m) => ({
      posted: m.time_posted ?? '',
      by: m.posted_by ?? 'UNKNOWN',
      content: m.content ?? '',
    })),
    sellerResponseDueDate: raw.seller_response_due_date ?? null,
    links: (row.linksJson as PayPalLink[]) ?? [],
    plan,
    draft: draftView(draftRow),
    evidence,
    steps,
    timeline,
    raw: rawClean,
    submissions,
    guidance: guidanceFor(item, plan),
  };
}
