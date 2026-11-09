/**
 * The approval gate (FR-9, FR-10, FR-14, PRD §16).
 *
 *   preview  -> build the exact outbound request, canonicalise it, hash it
 *   approve  -> merchant sends back that hash; we rebuild from current state,
 *               re-hash, and refuse unless the hashes match
 *   submit   -> only via an approval row whose hash equals the request being sent
 *
 * Why rebuild instead of storing the preview: if anything changed between the
 * merchant looking at the preview and clicking Approve — the draft was edited in
 * another tab, a new upload landed, PayPal withdrew the action — the hash no
 * longer matches and the merchant is asked to look again. What they approved is
 * exactly what is sent, or nothing is sent.
 *
 * Writes are never auto-retried (PRD §19). On a network failure we re-read the
 * dispute from PayPal to learn what actually happened.
 */

import { readFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  DISPUTE_ACTION_LABELS,
  HIGH_CONSEQUENCE_ACTIONS,
  SUBMITTABLE_EVIDENCE_TYPES,
  canonicalize,
  evidenceTypesToSubmit,
  prettyPayload,
  shortHash,
  type CompletenessResult,
  type DisputeAction,
  type EvidenceType,
  type OutboundFileRef,
  type OutboundRequest,
  type PayPalLink,
  type PreviewRequest,
  type PreviewResponse,
} from '@shared/index.js';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { getPayPal, PayPalError, type OutboundFile } from '../paypal/index.js';
import {
  buildAcceptClaim,
  buildMakeOffer,
  buildProvideEvidence,
  buildSendMessage,
  hashOutbound,
  safeDocumentName,
  sha256,
  validateOfferAmount,
} from '../paypal/payload.js';
import { indexDisputeOutcome } from '../retrieval/index.js';
import {
  allowedActionsFromLinks,
  getDisputeRow,
  latestDraftRow,
  latestPlan,
  linkFor,
  setGatherState,
  upsertDisputeFromRaw,
} from './disputes.js';
import { addTimeline, audit } from './records.js';

/** Merchant-facing action name for timeline entries. */
function actionLabel(action: string): string {
  return DISPUTE_ACTION_LABELS[action as DisputeAction]?.label ?? action;
}

/** "UNDER_REVIEW" -> "Under review". */
function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  const s = status.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
  ) {
    super(message);
  }
}

interface Built {
  request: OutboundRequest;
  files: OutboundFile[];
  evidenceTypes: EvidenceType[];
  warnings: string[];
}

/** Attachments: merchant uploads plus the KERNEL screenshot, as PayPal documents. */
async function collectFiles(disputeId: string, field: string): Promise<{ refs: OutboundFileRef[]; files: OutboundFile[] }> {
  const rows = await getDb().select().from(schema.evidenceItems).where(eq(schema.evidenceItems.disputeId, disputeId));
  const refs: OutboundFileRef[] = [];
  const files: OutboundFile[] = [];
  for (const row of rows) {
    if (!row.filePath || !row.mimeType) continue;
    let content: Buffer;
    try {
      content = readFileSync(row.filePath);
    } catch {
      continue; // a missing file must not silently ride along as a reference
    }
    const shortId = /E-\d+$/.exec(row.id)?.[0] ?? 'E';
    const ext = row.mimeType === 'application/pdf' ? 'pdf' : row.mimeType.split('/')[1] ?? 'bin';
    const filename = safeDocumentName(`x.${ext}`, `${shortId}-${row.kind.replace(/_/g, '-')}`);
    const hash = sha256(content);
    refs.push({ field, filename, mimeType: row.mimeType, bytes: content.byteLength, sha256: hash });
    files.push({ field, filename, mimeType: row.mimeType, content });
  }
  return { refs, files };
}

function requireLink(links: PayPalLink[], action: DisputeAction): string {
  const link = linkFor(links, action);
  if (!link) {
    throw new ApprovalError(
      `PayPal is not currently offering "${action}" for this dispute`,
      409,
      'action-not-available',
    );
  }
  return link.href;
}

export async function buildOutbound(disputeId: string, req: PreviewRequest): Promise<Built> {
  const row = await getDisputeRow(disputeId);
  if (!row) throw new ApprovalError('Dispute not found', 404, 'not-found');
  const links = (row.linksJson as PayPalLink[]) ?? [];
  const href = requireLink(links, req.action);
  const draft = await latestDraftRow(disputeId);
  const text = draft ? (draft.editedText ?? draft.text) : null;
  const warnings: string[] = [];

  if (draft?.generator === 'deterministic') {
    warnings.push('Drafted from the standard template because AI drafting is not configured. Review the wording before approving.');
  }

  switch (req.action) {
    case 'provide-evidence': {
      const planRec = await latestPlan(disputeId);
      if (!planRec) throw new ApprovalError('Gather evidence before submitting it', 409, 'no-plan');
      if (!text) throw new ApprovalError('There is no draft response to send', 409, 'no-draft');
      const plan = planRec.plan;

      const tracking =
        plan.facts.trackingNumber && plan.facts.carrierEnum
          ? { carrier_name: plan.facts.carrierEnum as never, tracking_number: plan.facts.trackingNumber }
          : null;

      const submittable = new Set<string>(SUBMITTABLE_EVIDENCE_TYPES);
      let types = evidenceTypesToSubmit(plan as unknown as CompletenessResult).filter((t) => submittable.has(t));
      if (!tracking) {
        types = types.filter((t) => t !== 'PROOF_OF_FULFILLMENT');
        warnings.push('No verified tracking number — PROOF_OF_FULFILLMENT is omitted.');
      }
      if (types.length === 0) types = ['OTHER'];

      const { refs, files } = await collectFiles(disputeId, 'evidence-file');
      if (plan.band === 'WEAK' || plan.band === 'PARTIAL') {
        warnings.push(`Evidence is ${plan.band.toLowerCase()} (${plan.completeness}/100). Submitting is allowed; it may not be enough.`);
      }
      if (plan.capped) warnings.push('Some evidence contradicts a delivery claim. A PayPal reviewer will see it.');

      return {
        request: buildProvideEvidence({
          baseUrl: env.paypal.baseUrl,
          disputeId,
          href,
          evidenceTypes: types,
          tracking,
          notes: text,
          files: refs,
        }),
        files,
        evidenceTypes: types,
        warnings,
      };
    }
    case 'send-message': {
      if (!text) throw new ApprovalError('There is no draft text to send as a message', 409, 'no-draft');
      warnings.push('Messages may be visible to the buyer.');
      return { request: buildSendMessage(href, text), files: [], evidenceTypes: [], warnings };
    }
    case 'make-offer': {
      if (!req.offer) throw new ApprovalError('An offer needs a type, amount and note', 400, 'invalid-offer');
      const check = validateOfferAmount(req.offer.amount, row.amountValue);
      if (!check.ok) throw new ApprovalError(check.reason, 422, 'offer-exceeds-dispute');
      warnings.push(`This offers ${row.amountCurrency} ${req.offer.amount} of the disputed ${row.amountCurrency} ${row.amountValue}. Real money moves if accepted.`);
      return {
        request: buildMakeOffer({
          href,
          note: req.offer.note,
          offerType: req.offer.offer_type,
          amount: req.offer.amount,
          currency: row.amountCurrency ?? 'USD',
        }),
        files: [],
        evidenceTypes: [],
        warnings,
      };
    }
    case 'accept-claim': {
      warnings.push(`Accepting refunds the buyer ${row.amountCurrency} ${row.amountValue} and closes the dispute against you.`);
      const note = text ?? 'Accepting the claim.';
      return { request: buildAcceptClaim(href, note.slice(0, 2000)), files: [], evidenceTypes: [], warnings };
    }
    default:
      throw new ApprovalError(`"${req.action}" is not supported by DisputeDesk`, 400, 'unsupported-action');
  }
}

export async function preview(disputeId: string, req: PreviewRequest): Promise<PreviewResponse> {
  const built = await buildOutbound(disputeId, req);
  const canonical = canonicalize(built.request);
  const payloadSha256 = hashOutbound(canonical);
  if (env.isDemo) built.warnings.unshift('Demo environment: approving records this request locally. It is not transmitted to PayPal.');
  await audit('approval.previewed', { action: req.action, payloadSha256 }, { disputeId, actor: env.operator });
  return {
    action: req.action,
    request: built.request,
    canonical,
    payloadSha256,
    pretty: prettyPayload(built.request),
    files: built.request.files,
    warnings: built.warnings,
    highConsequence: HIGH_CONSEQUENCE_ACTIONS.includes(req.action),
    evidenceTypes: built.evidenceTypes,
  };
}

export interface ApproveResult {
  approvalId: string;
  ok: boolean;
  simulated: boolean;
  httpStatus: number | null;
  debugId: string | null;
  error: string | null;
  disputeStatus: string | null;
}

/**
 * Approve and submit. Each check below is a reason the write can be refused; all
 * of them run before the approval row exists or before the network call.
 */
export async function approveAndSubmit(
  disputeId: string,
  req: PreviewRequest & { payload_sha256: string },
  approvedBy: string,
): Promise<ApproveResult> {
  const pp = getPayPal();

  // 1. PayPal must still offer this action. Re-read, don't trust our cache (FR-4).
  try {
    const fresh = await pp.getDispute(disputeId);
    await upsertDisputeFromRaw(fresh, { fixture: env.isDemo });
    if (!allowedActionsFromLinks(fresh.links).includes(req.action)) {
      throw new ApprovalError(`PayPal no longer offers "${req.action}" for this dispute`, 409, 'action-not-available');
    }
  } catch (err) {
    if (err instanceof ApprovalError) throw err;
    throw new ApprovalError(
      `Could not confirm the dispute's current state with PayPal: ${err instanceof Error ? err.message : 'unknown'}`,
      502,
      'paypal-unavailable',
    );
  }

  // 2. Rebuild and re-hash. A mismatch means "look again", never "send anyway".
  const built = await buildOutbound(disputeId, req);
  const canonical = canonicalize(built.request);
  const hash = hashOutbound(canonical);
  if (hash !== req.payload_sha256) {
    await audit('approval.hash_mismatch', { expected: req.payload_sha256, actual: hash }, { disputeId, actor: approvedBy });
    throw new ApprovalError(
      'What would be sent has changed since you previewed it. Review the new preview before approving.',
      409,
      'hash-mismatch',
    );
  }

  // 3. One live submission per payload. A FAILED attempt may be re-approved.
  const db = getDb();
  const prior = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.disputeId, disputeId), eq(schema.approvals.payloadSha256, hash)));
  if (prior.some((p) => p.resultStatus === 'SENT' || p.resultStatus === 'PENDING' || p.resultStatus === 'UNKNOWN')) {
    throw new ApprovalError('This exact submission was already approved', 409, 'duplicate-submission');
  }
  const idempotencyKey = sha256(`${disputeId}|${req.action}|${hash}|${prior.length}`);

  // 4. Record the approval BEFORE the call (PRD §12): if we crash mid-request, the
  //    row says PENDING and nobody can silently re-send it.
  const approvalId = nanoid();
  await db.insert(schema.approvals).values({
    id: approvalId,
    disputeId,
    action: req.action,
    payloadSha256: hash,
    canonical,
    approvedBy,
    idempotencyKey,
    resultStatus: 'PENDING',
  });
  await audit('approval.granted', { approvalId, action: req.action, payloadSha256: hash }, { disputeId, actor: approvedBy });
  await addTimeline(disputeId, 'approval', `Approved: ${actionLabel(req.action)}`, `Approved by ${approvedBy} · fingerprint ${shortHash(hash)}`);

  return submitApproved(approvalId, built);
}

/**
 * The only function that performs a PayPal write. It requires an unconsumed
 * approval row and re-checks that the row's hash equals the request in hand.
 */
export async function submitApproved(approvalId: string, built: Built): Promise<ApproveResult> {
  const db = getDb();
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  if (!approval) throw new ApprovalError('Approval not found', 404, 'not-found');
  if (approval.consumedAt) throw new ApprovalError('Approval already used', 409, 'approval-consumed');
  const hash = hashOutbound(canonicalize(built.request));
  if (hash !== approval.payloadSha256) {
    await db.update(schema.approvals).set({ resultStatus: 'BLOCKED', error: 'hash mismatch at submit' }).where(eq(schema.approvals.id, approvalId));
    throw new ApprovalError('Request does not match its approval', 409, 'hash-mismatch');
  }

  // Consume first: a concurrent second call sees consumedAt and stops.
  const consumed = await db
    .update(schema.approvals)
    .set({ consumedAt: new Date() })
    .where(and(eq(schema.approvals.id, approvalId), isNull(schema.approvals.consumedAt)))
    .returning();
  if (consumed.length === 0) throw new ApprovalError('Approval could not be consumed', 409, 'approval-consumed');

  const disputeId = approval.disputeId;
  const pp = getPayPal();
  let result;
  try {
    result = await pp.execute(built.request, built.files);
  } catch (err) {
    // Network failure: outcome unknown. Do not retry; find out from PayPal.
    const message = err instanceof Error ? err.message : 'network error';
    await db
      .update(schema.approvals)
      .set({ resultStatus: 'UNKNOWN', error: message, debugId: err instanceof PayPalError ? err.debugId : null })
      .where(eq(schema.approvals.id, approvalId));
    await addTimeline(disputeId, 'submission', 'Submission outcome unknown', `${message}. Re-reading the dispute from PayPal.`);
    const status = await refreshFromPayPal(disputeId);
    return { approvalId, ok: false, simulated: false, httpStatus: null, debugId: null, error: message, disputeStatus: status };
  }

  await db
    .update(schema.approvals)
    .set({
      resultStatus: result.ok ? 'SENT' : 'FAILED',
      httpStatus: result.httpStatus,
      debugId: result.debugId,
      error: result.error,
      responseJson: result.body,
    })
    .where(eq(schema.approvals.id, approvalId));

  await audit(
    result.ok ? 'paypal.write' : 'paypal.write_failed',
    {
      approvalId,
      action: approval.action,
      httpStatus: result.httpStatus,
      debugId: result.debugId,
      simulated: result.simulated,
      error: result.error,
    },
    { disputeId, actor: approval.approvedBy },
  );

  if (!result.ok) {
    await addTimeline(disputeId, 'submission', `PayPal declined: ${actionLabel(approval.action)} (HTTP ${result.httpStatus})`, `${result.error ?? ''}${result.debugId ? ` · debug_id ${result.debugId}` : ''}`);
    return {
      approvalId,
      ok: false,
      simulated: result.simulated,
      httpStatus: result.httpStatus,
      debugId: result.debugId,
      error: result.error,
      disputeStatus: null,
    };
  }

  await addTimeline(
    disputeId,
    'submission',
    result.simulated
      ? `${actionLabel(approval.action)} recorded (demo environment)`
      : `${actionLabel(approval.action)} submitted to PayPal`,
    result.simulated
      ? `Not transmitted to PayPal · reference ${result.debugId ?? 'n/a'}`
      : `HTTP ${result.httpStatus}${result.debugId ? ` · debug_id ${result.debugId}` : ''}`,
  );
  if (approval.action === 'provide-evidence') await setGatherState(disputeId, 'SUBMITTED');

  // Status comes from PayPal, not from our assumption about what the write did.
  const status = await refreshFromPayPal(disputeId);
  return {
    approvalId,
    ok: true,
    simulated: result.simulated,
    httpStatus: result.httpStatus,
    debugId: result.debugId,
    error: null,
    disputeStatus: status,
  };
}

export async function refreshFromPayPal(disputeId: string): Promise<string | null> {
  try {
    const d = await getPayPal().getDispute(disputeId);
    const before = await getDisputeRow(disputeId);
    await upsertDisputeFromRaw(d, { fixture: env.isDemo });
    if (before && before.status !== d.status) {
      await addTimeline(
        disputeId,
        'dispute',
        `Status changed to ${statusLabel(d.status)}`,
        `Previously ${statusLabel(before.status)} · confirmed with PayPal`,
      );
    }
    if (d.status === 'RESOLVED') {
      await indexDisputeOutcome({
        dispute_id: disputeId,
        reason: d.reason,
        outcome: d.dispute_outcome?.outcome_code ?? 'UNKNOWN',
        amount: Number(d.dispute_amount?.value ?? 0),
        currency: d.dispute_amount?.currency_code,
        resolved_at: new Date().toISOString(),
      });
    }
    return d.status ?? null;
  } catch (err) {
    logger.warn({ disputeId, err: err instanceof Error ? err.message : err }, 'Could not refresh dispute from PayPal');
    return null;
  }
}
