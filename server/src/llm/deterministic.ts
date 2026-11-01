/**
 * Deterministic generator — regex extraction, rule-based plan, template draft.
 *
 * Two roles:
 *  1. Fallback. With no ANTHROPIC_API_KEY, with the daily budget spent, or when
 *     the model fails twice, the product still produces a scored plan and an
 *     editable draft. Every output is labelled `generator: 'deterministic'`.
 *  2. Baseline. PRD §13 asks for the AI to be measured against a "template +
 *     checklist" baseline. This *is* that baseline — real shipping code, not a
 *     strawman written for the comparison. If the model doesn't beat it on the
 *     eval, the README says so.
 *
 * It is also the deterministic cross-check named in PRD §13 task T1: the
 * workflow compares the model's tracking number against what these regexes find
 * in the same text, and flags disagreement.
 */

import type {
  AddressMatchResult,
  DeliveryStatus,
  DisputeAction,
  DraftOutput,
  EvidenceItemView,
  ExtractionOutput,
  PlanNarrative,
} from '@shared/index.js';
import { DRAFT_MAX_LENGTH } from '@shared/index.js';
import { looksLikeTrackingNumber, mapCarrierToEnum } from '../paypal/payload.js';
import type {
  DraftInput,
  ExtractionInput,
  LLMClient,
  LlmResult,
  PlanInput,
} from './client.js';

const CARRIER_PATTERNS: [RegExp, string][] = [
  [/\broyal\s*mail\b/i, 'Royal Mail'],
  [/\bparcelforce\b/i, 'Parcelforce'],
  [/\bfed\s*ex\b/i, 'FedEx'],
  [/\busps\b|\bunited states postal\b/i, 'USPS'],
  [/\bups\b/i, 'UPS'],
  [/\bdhl\b/i, 'DHL'],
  [/\bcanada\s*post\b/i, 'Canada Post'],
  [/\bevri\b|\bhermes\b/i, 'Evri'],
  [/\bdpd\b/i, 'DPD'],
];

/** Known tracking-number shapes, most specific first. */
const TRACKING_PATTERNS: RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/, // UPS
  /\b[A-Z]{2}\d{9}GB\b/, // Royal Mail / Parcelforce international
  /\b9[2-5]\d{20}\b/, // USPS 22-digit
  /\bJD\d{10,18}\b/, // DHL
  /\b[A-Z]\d{2}[A-Z]{2}\d{10}\b/, // Evri
  /\b\d{12}\b/, // FedEx 12-digit
];

/** UK and US postcode shapes, sufficient for the address comparison. */
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{5}(?:-\d{4})?)\b/gi;

function normPostcode(pc: string): string {
  return pc.toUpperCase().replace(/\s+/g, '');
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

export function detectCarrier(text: string): string | null {
  for (const [re, name] of CARRIER_PATTERNS) if (re.test(text)) return name;
  return null;
}

export function detectTrackingNumber(text: string): string | null {
  const candidate = firstMatch(text.toUpperCase(), TRACKING_PATTERNS);
  return candidate && looksLikeTrackingNumber(candidate) ? candidate : null;
}

/**
 * Ordered most-specific first. "Returned to sender — unable to deliver" contains
 * "deliver", so the negative states must be tested before DELIVERED, and
 * "Scheduled delivery: pending" must not read as delivered.
 */
export function detectDeliveryStatus(text: string): DeliveryStatus {
  const t = text.toLowerCase();
  if (!t.trim()) return 'UNKNOWN';
  if (/return(?:ed)?\s+to\s+sender|being returned/.test(t)) return 'RETURNED_TO_SENDER';
  if (/\bexception\b|\bdamaged\b|\blost in transit\b/.test(t)) return 'EXCEPTION';
  if (/label created|pre-shipment|not yet in system|shipping label has been prepared/.test(t)) {
    return 'LABEL_CREATED';
  }
  if (/\bdelivered\b/.test(t)) return 'DELIVERED';
  if (/out for delivery/.test(t)) return 'OUT_FOR_DELIVERY';
  if (/in transit|departed|arrived at|in the network|on its way/.test(t)) return 'IN_TRANSIT';
  return 'UNKNOWN';
}

export function detectSignature(text: string): boolean | null {
  const t = text.toLowerCase();
  if (/no signature (?:was )?required|signature:\s*not required|signature not required/.test(t)) return false;
  if (/signed\s+(?:for\s+)?by\s*:?\s*\S+|signature:\s*[a-z]/.test(t)) return true;
  if (/left (?:at|in a safe place)|safe place|left at front door/.test(t)) return false;
  return null;
}

export function detectDeliveredAt(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => /\bdelivered\b/i.test(l) && /\d/.test(l));
  if (!line) return null;
  const m =
    /(\d{1,2}[/\-. ]\d{1,2}[/\-. ]\d{2,4}(?:\s+at\s+[\d:.]+\s*[AP]\.?M\.?)?|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:[, ]+(?:at\s+)?[\d:]+(?:\s*[ap]m)?)?)/i.exec(
      line,
    );
  return m ? m[1]!.trim() : null;
}

/**
 * Postcode agreement is the anchor: the same postcode is MATCH, a different one
 * is MISMATCH. City-only agreement is PARTIAL. Anything less is UNKNOWN.
 */
export function compareAddress(carrierText: string, orderAddress: string | null): AddressMatchResult {
  if (!orderAddress || !carrierText.trim()) return 'UNKNOWN';
  const destLines = carrierText
    .split(/\r?\n/)
    .filter((l) => /deliver(?:ed|y)\s+(?:to|location)|delivered to|left at|destination/i.test(l));
  if (destLines.length === 0) return 'UNKNOWN';
  const dest = destLines.join(' ');

  const orderPc = [...orderAddress.matchAll(POSTCODE_RE)].map((m) => normPostcode(m[1]!));
  const destPc = [...dest.matchAll(POSTCODE_RE)].map((m) => normPostcode(m[1]!));

  if (orderPc.length > 0 && destPc.length > 0) {
    return destPc.some((pc) => orderPc.includes(pc)) ? 'MATCH' : 'MISMATCH';
  }

  // No postcode on the carrier side: fall back to the city.
  const orderTokens = orderAddress.toUpperCase().split(/[\s,]+/).filter((w) => w.length >= 4);
  const destUpper = dest.toUpperCase();
  if (orderTokens.some((w) => destUpper.includes(w))) return 'PARTIAL';
  return 'UNKNOWN';
}

function ok<T>(value: T, started: number): LlmResult<T> {
  return {
    ok: true,
    value,
    generator: 'deterministic',
    model: 'rules-v1',
    error: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: Date.now() - started,
  };
}

function bestSource(items: readonly EvidenceItemView[], kinds: string[]): EvidenceItemView | undefined {
  for (const kind of kinds) {
    const found = items.find((i) => i.kind === kind && i.contentText);
    if (found) return found;
  }
  return undefined;
}

export function deterministicExtract(input: ExtractionInput): ExtractionOutput {
  const carrierItem = bestSource(input.items, ['carrier_capture']);
  const trackingItem = bestSource(input.items, ['paypal_shipment_tracking', 'order_record', 'paypal_transaction']);
  const carrierText = carrierItem?.contentText ?? '';
  const allText = input.items.map((i) => i.contentText ?? '').join('\n');

  const sources: { field: string; evidence_id: string }[] = [];

  // Tracking: carrier page first (independent), then PayPal/order data.
  let tracking = carrierText ? detectTrackingNumber(carrierText) : null;
  if (tracking && carrierItem) sources.push({ field: 'tracking_number', evidence_id: carrierItem.id });
  if (!tracking) {
    for (const item of input.items) {
      const found = item.contentText ? detectTrackingNumber(item.contentText) : null;
      if (found) {
        tracking = found;
        sources.push({ field: 'tracking_number', evidence_id: item.id });
        break;
      }
    }
  }

  let carrier = carrierText ? detectCarrier(carrierText) : null;
  let carrierSource = carrierItem;
  if (!carrier) {
    carrier = detectCarrier(allText);
    carrierSource = input.items.find((i) => i.contentText && detectCarrier(i.contentText));
  }
  if (carrier && carrierSource) sources.push({ field: 'carrier', evidence_id: carrierSource.id });

  // Delivery facts come only from the carrier capture: a merchant's own record
  // saying "shipped" is not a carrier scan.
  const deliveryStatus = detectDeliveryStatus(carrierText);
  const signature = carrierText ? detectSignature(carrierText) : null;
  const deliveredAt = deliveryStatus === 'DELIVERED' ? detectDeliveredAt(carrierText) : null;
  const addressMatch = compareAddress(carrierText, input.orderAddress);
  if (carrierItem) {
    if (deliveryStatus !== 'UNKNOWN') sources.push({ field: 'delivery_status', evidence_id: carrierItem.id });
    if (signature !== null) sources.push({ field: 'signature_obtained', evidence_id: carrierItem.id });
    if (addressMatch !== 'UNKNOWN') sources.push({ field: 'address_match', evidence_id: carrierItem.id });
  }

  const confidence = carrierItem ? 0.7 : tracking ? 0.5 : 0.3;

  return {
    carrier,
    carrier_enum: mapCarrierToEnum(carrier),
    tracking_number: tracking,
    delivery_status: deliveryStatus,
    delivered_at: deliveredAt,
    last_known_location: null,
    signature_obtained: signature,
    address_match: addressMatch,
    ship_date: null,
    sources,
    confidence,
    notes: trackingItem ? null : 'No PayPal or order record carried a tracking number.',
  };
}

/** Which evidence kinds can support each rubric requirement, best first. */
const SUPPORTING_KINDS: Record<string, string[]> = {
  tracking_number: ['paypal_shipment_tracking', 'carrier_capture', 'order_record'],
  carrier_identified: ['paypal_shipment_tracking', 'carrier_capture', 'order_record'],
  delivery_confirmed: ['carrier_capture'],
  address_match: ['carrier_capture', 'order_record'],
  independent_corroboration: ['carrier_capture', 'paypal_shipment_tracking'],
  signature_or_receipt: ['carrier_capture', 'upload'],
};

/** Cite the items that can actually back a requirement, not just the first ones. */
export function supportingIds(requirementId: string, items: readonly EvidenceItemView[]): string[] {
  const kinds = SUPPORTING_KINDS[requirementId] ?? [];
  const ids: string[] = [];
  for (const kind of kinds) {
    for (const item of items) if (item.kind === kind && !ids.includes(item.id)) ids.push(item.id);
    if (ids.length >= 2) break;
  }
  return ids.slice(0, 2);
}

export function deterministicPlan(input: PlanInput): PlanNarrative {
  const met = input.requirements.filter((r) => r.satisfied !== 'no');
  const missing = input.requirements.filter((r) => r.satisfied === 'no');
  const firstIds = input.items.slice(0, 1).map((i) => i.id);

  const rationale = met.slice(0, 6).map((r) => {
    const ids = supportingIds(r.id, input.items);
    return {
      claim: `${r.label}: ${r.detail}`,
      evidence_ids: ids.length > 0 ? ids : firstIds.length > 0 ? firstIds : ['none'],
    };
  });
  if (rationale.length === 0) {
    rationale.push({
      claim: 'No requirement is currently met by the collected evidence.',
      evidence_ids: firstIds.length > 0 ? firstIds : ['none'],
    });
  }

  const has = (a: DisputeAction) => input.availableActions.includes(a);
  let recommended: DisputeAction;
  let why: string;
  if (input.contradicted && has('make-offer')) {
    recommended = 'make-offer';
    why = 'The carrier record contradicts delivery to the buyer. An offer is likely cheaper than contesting facts a reviewer will see.';
  } else if (input.completeness >= 70 && has('provide-evidence')) {
    recommended = 'provide-evidence';
    why = `Completeness ${input.completeness}/100 — the evidence supports a response.`;
  } else if (input.completeness >= 40 && has('provide-evidence')) {
    recommended = 'provide-evidence';
    why = 'Evidence is partial. Submit what you have, and add the missing items if you can.';
  } else if (has('make-offer')) {
    recommended = 'make-offer';
    why = 'Evidence is weak; a partial offer may cost less than losing the full amount.';
  } else if (has('send-message')) {
    recommended = 'send-message';
    why = 'No evidence action is available; a message keeps the case moving.';
  } else {
    recommended = input.availableActions[0] ?? 'send-message';
    why = 'Only one action is available.';
  }

  return {
    rationale,
    risks: missing.slice(0, 6).map((r) => `${r.label}: ${r.detail}`),
    recommended_action: recommended,
    recommended_action_why: why,
    triage_note: `${input.band} evidence, due in ${input.dueIn}`.slice(0, 160),
  };
}

export function deterministicDraft(input: DraftInput): DraftOutput {
  const supported = input.requirements.filter((r) => r.satisfied !== 'no');
  const missing = input.requirements.filter((r) => r.satisfied === 'no');
  const refs = [...new Set(input.rationale.flatMap((r) => r.evidence_ids))].filter(
    (id) => id !== 'none' && input.items.some((i) => i.id === id),
  );
  const fallbackRefs = input.items.slice(0, 2).map((i) => i.id);

  const lines: string[] = [];
  lines.push(
    `We are responding to this ${input.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' ? 'item-not-received' : 'dispute'} claim for ${input.currency} ${input.amount}.`,
  );
  if (supported.length > 0) {
    lines.push(`Our records show the following: ${supported.map((r) => r.detail).join('; ')}.`);
  } else {
    lines.push('We have not yet been able to establish shipment details for this order.');
  }
  if (missing.length > 0) {
    lines.push(`We do not currently hold: ${missing.map((r) => r.label.toLowerCase()).join('; ')}.`);
  }
  lines.push('Supporting records are attached for your review.');

  let text = lines.join(' ');
  if (text.length > DRAFT_MAX_LENGTH) text = `${text.slice(0, DRAFT_MAX_LENGTH - 1)}…`;

  return {
    text,
    evidence_refs: refs.length > 0 ? refs : fallbackRefs.length > 0 ? fallbackRefs : ['none'],
    tone: 'factual',
  };
}

export class DeterministicLLM implements LLMClient {
  readonly name = 'deterministic';
  readonly model = 'rules-v1';
  readonly enabled = false;

  async extract(input: ExtractionInput) {
    return ok(deterministicExtract(input), Date.now());
  }
  async plan(input: PlanInput) {
    return ok(deterministicPlan(input), Date.now());
  }
  async draft(input: DraftInput) {
    return ok(deterministicDraft(input), Date.now());
  }
}
