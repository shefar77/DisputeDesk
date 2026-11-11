/**
 * Evidence rubric + completeness scoring.
 *
 * Design decision (PRD §13, task T2): the completeness score is **not** a model
 * opinion. The LLM's only job is to extract *facts* from unstructured sources
 * (a carrier page, an order record). Those facts are then scored by the
 * deterministic rubric below. That split is what makes the score reproducible,
 * testable against a hand-labelled rubric (PRD §7), and auditable in the UI.
 *
 * P0 covers MERCHANDISE_OR_SERVICE_NOT_RECEIVED ("Item not received") only.
 * Any other reason returns `null` from `getRubric` and the UI routes the dispute
 * to manual handling rather than guessing.
 */

import type { DisputeReason, EvidenceType } from './paypal-constants.js';

/** Normalised delivery state, extracted from whatever source was available. */
export const DELIVERY_STATUSES = [
  'DELIVERED',
  'OUT_FOR_DELIVERY',
  'IN_TRANSIT',
  'LABEL_CREATED',
  'RETURNED_TO_SENDER',
  'EXCEPTION',
  'UNKNOWN',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ADDRESS_MATCH_RESULTS = ['MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN'] as const;
export type AddressMatchResult = (typeof ADDRESS_MATCH_RESULTS)[number];

/**
 * The facts the rubric scores. Every field carries the evidence item id it came
 * from so the UI (and the draft validator) can trace any claim back to a source.
 */
export interface EvidenceFacts {
  carrier: string | null;
  carrierEnum: string | null;
  trackingNumber: string | null;
  deliveryStatus: DeliveryStatus;
  deliveredAt: string | null;
  lastKnownLocation: string | null;
  signatureObtained: boolean | null;
  addressMatch: AddressMatchResult;
  shipDate: string | null;
  /** Which evidence item supports each fact: field name -> evidence item id. */
  sources: Record<string, string>;
  /** 0..1, how confident extraction was. Low confidence suppresses drafting (PRD §13). */
  confidence: number;
}

export function emptyFacts(): EvidenceFacts {
  return {
    carrier: null,
    carrierEnum: null,
    trackingNumber: null,
    deliveryStatus: 'UNKNOWN',
    deliveredAt: null,
    lastKnownLocation: null,
    signatureObtained: null,
    addressMatch: 'UNKNOWN',
    shipDate: null,
    sources: {},
    confidence: 0,
  };
}

export type Satisfaction = 'yes' | 'partial' | 'no';

export interface RequirementEvaluation {
  satisfied: Satisfaction;
  detail: string;
  /**
   * Set when the evidence does not merely fail to help but actively undermines
   * the merchant — delivery to a different postcode, a return-to-sender scan, a
   * damage exception. A case containing a contradiction cannot score above
   * PARTIAL however many other boxes are ticked, because a PayPal reviewer will
   * see the contradiction too.
   */
  contradicts?: boolean;
}

export interface RubricRequirement {
  id: string;
  label: string;
  /** Why PayPal cares about this, in merchant language. */
  why: string;
  weight: number;
  /** Which PayPal evidence_type this requirement contributes to, if submitted. */
  evidenceType: EvidenceType;
  /** True when this requirement must be met for the response to be worth sending. */
  critical: boolean;
  evaluate: (facts: EvidenceFacts, ctx: RubricContext) => RequirementEvaluation;
}

export interface RubricContext {
  /** Internal evidence kinds collected for this dispute. */
  presentKinds: readonly string[];
}

export interface Rubric {
  reason: DisputeReason;
  requirements: readonly RubricRequirement[];
}

const PARTIAL_CREDIT = 0.4;

/** PayPal carrier_name enum value -> the carrier's own name, for display. */
const CARRIER_DISPLAY: Record<string, string> = {
  UPS: 'UPS',
  USPS: 'USPS',
  DHL: 'DHL',
  TNT: 'TNT',
  FEDEX: 'FedEx',
  ROYAL_MAIL: 'Royal Mail',
  PARCELFORCE: 'Parcelforce',
  CA_CANADA_POST: 'Canada Post',
  CN_CHINA_POST: 'China Post',
  HK_HONGKONG_POST: 'Hongkong Post',
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Render a delivery timestamp for the rubric line.
 *
 * Extractors legitimately return either a machine timestamp
 * ("2026-10-23T11:41:00") or the carrier's own wording ("23 October 2026 at
 * 11:41am"), and which one you get depends on the model. An ISO-shaped value is
 * reformatted by reading its parts as text; anything else is shown exactly as
 * the source wrote it. The value itself is never rewritten — the raw string
 * stays in the extracted-facts table.
 *
 * Deliberately NOT parsed into a Date. A carrier states a local wall-clock time,
 * and bare ISO strings with no offset are treated as *local* by Date.parse, so
 * round-tripping through a Date and formatting in another zone silently moves
 * the delivery time (11:41 became 06:11 when rendered as UTC from IST). Shifting
 * a delivery time is falsifying evidence, so the digits are kept as given.
 */
export function deliveredAtDisplay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value.trim());
  if (!m) return value;

  const [, year, month, day, hour, minute] = m;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return value;

  const date = `${Number(day)} ${monthName} ${year}`;
  return hour && minute ? `${date} at ${hour}:${minute}` : date;
}

export function carrierDisplayName(value: string): string {
  return CARRIER_DISPLAY[value] ?? value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const INR_RUBRIC: Rubric = {
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  requirements: [
    {
      id: 'tracking_number',
      label: 'Tracking number on record',
      why: 'PayPal expects proof of fulfilment to carry a tracking number.',
      weight: 25,
      evidenceType: 'PROOF_OF_FULFILLMENT',
      critical: true,
      evaluate: (f) =>
        f.trackingNumber
          ? { satisfied: 'yes', detail: `Tracking number ${f.trackingNumber}` }
          : { satisfied: 'no', detail: 'No tracking number found in PayPal or order data' },
    },
    {
      id: 'carrier_identified',
      label: 'Carrier identified',
      why: 'The tracking number is only verifiable if PayPal knows which carrier to check.',
      weight: 10,
      evidenceType: 'PROOF_OF_FULFILLMENT',
      critical: true,
      evaluate: (f) => {
        if (f.carrierEnum && f.carrierEnum !== 'OTHER') {
          return { satisfied: 'yes', detail: `Carrier: ${carrierDisplayName(f.carrierEnum)}` };
        }
        if (f.carrier) {
          return { satisfied: 'partial', detail: `Carrier "${f.carrier}" is not in PayPal's carrier list (submitted as OTHER)` };
        }
        return { satisfied: 'no', detail: 'Carrier unknown' };
      },
    },
    {
      id: 'delivery_confirmed',
      label: 'Delivery confirmed by carrier',
      why: 'A delivered scan is the single strongest rebuttal to "item not received".',
      weight: 25,
      evidenceType: 'ONLINE_TRACKING_INFORMATION',
      critical: true,
      evaluate: (f) => {
        switch (f.deliveryStatus) {
          case 'DELIVERED':
            return {
              satisfied: 'yes',
              detail: f.deliveredAt ? `Delivered ${deliveredAtDisplay(f.deliveredAt)}` : 'Carrier reports delivered',
            };
          case 'OUT_FOR_DELIVERY':
          case 'IN_TRANSIT':
            return { satisfied: 'partial', detail: `Carrier reports ${f.deliveryStatus} — not yet delivered` };
          case 'RETURNED_TO_SENDER':
          case 'EXCEPTION':
            return {
              satisfied: 'no',
              detail: `Carrier reports ${f.deliveryStatus} — this contradicts a delivery claim`,
              contradicts: true,
            };
          default:
            return { satisfied: 'no', detail: 'No delivery confirmation available' };
        }
      },
    },
    {
      id: 'address_match',
      label: 'Delivered to the buyer address on the order',
      why: 'Delivery to a different address does not rebut the claim.',
      weight: 15,
      evidenceType: 'DELIVERY_ADDRESS',
      critical: false,
      evaluate: (f) => {
        switch (f.addressMatch) {
          case 'MATCH':
            return { satisfied: 'yes', detail: 'Delivery destination matches the order address' };
          case 'PARTIAL':
            return { satisfied: 'partial', detail: 'Destination partially matches (city/postcode only)' };
          case 'MISMATCH':
            return {
              satisfied: 'no',
              detail: 'Carrier destination conflicts with the order address',
              contradicts: true,
            };
          default:
            return { satisfied: 'no', detail: 'Could not compare delivery and order addresses' };
        }
      },
    },
    {
      id: 'independent_corroboration',
      label: 'Independent carrier corroboration captured',
      why: 'A capture of the carrier page corroborates PayPal data from outside our own records.',
      weight: 15,
      evidenceType: 'ONLINE_TRACKING_INFORMATION',
      critical: false,
      evaluate: (f, ctx) => {
        // A capture only corroborates if it says something. A page that loaded
        // but shows no scan is weaker than one that confirms movement.
        if (ctx.presentKinds.includes('carrier_capture')) {
          if (f.deliveryStatus === 'UNKNOWN' || f.deliveryStatus === 'LABEL_CREATED') {
            return { satisfied: 'partial', detail: 'Carrier page captured but shows no carrier scan' };
          }
          return { satisfied: 'yes', detail: 'Carrier tracking page captured and corroborates status' };
        }
        if (ctx.presentKinds.includes('paypal_shipment_tracking')) {
          return { satisfied: 'partial', detail: 'PayPal shipment data only — no independent capture' };
        }
        return { satisfied: 'no', detail: 'No carrier-side corroboration' };
      },
    },
    {
      id: 'signature_or_receipt',
      label: 'Signature or delivery receipt',
      why: 'A signature removes the "it was never handed over" argument.',
      weight: 10,
      evidenceType: 'PROOF_OF_DELIVERY_SIGNATURE',
      critical: false,
      evaluate: (f, ctx) => {
        if (f.signatureObtained === true) return { satisfied: 'yes', detail: 'Signature on delivery recorded' };
        if (ctx.presentKinds.includes('upload')) {
          return { satisfied: 'partial', detail: 'Merchant-uploaded delivery document present' };
        }
        return { satisfied: 'no', detail: 'No signature or delivery receipt' };
      },
    },
  ],
};

const RUBRICS: Partial<Record<DisputeReason, Rubric>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: INR_RUBRIC,
};

/** Returns null for reasons DisputeDesk does not support in P0. */
export function getRubric(reason: DisputeReason): Rubric | null {
  return RUBRICS[reason] ?? null;
}

export function isSupportedReason(reason: DisputeReason): boolean {
  return getRubric(reason) !== null;
}

export const COMPLETENESS_BANDS = ['WEAK', 'PARTIAL', 'STRONG', 'COMPLETE'] as const;
export type CompletenessBand = (typeof COMPLETENESS_BANDS)[number];

/** A case with a contradiction is capped at the top of PARTIAL. */
export const CONTRADICTION_CAP = 69;

/** COMPLETE means nothing is missing, so it needs (almost) every point. */
export function bandFor(score: number): CompletenessBand {
  if (score >= 95) return 'COMPLETE';
  if (score >= 70) return 'STRONG';
  if (score >= 40) return 'PARTIAL';
  return 'WEAK';
}

export function bandIndex(band: CompletenessBand): number {
  return COMPLETENESS_BANDS.indexOf(band);
}

export interface RequirementResult {
  id: string;
  label: string;
  why: string;
  weight: number;
  evidenceType: EvidenceType;
  critical: boolean;
  satisfied: Satisfaction;
  detail: string;
  earned: number;
  contradicts: boolean;
}

export interface CompletenessResult {
  score: number;
  band: CompletenessBand;
  requirements: RequirementResult[];
  present: RequirementResult[];
  missing: RequirementResult[];
  /** Critical requirements that are unmet — these gate "worth submitting". */
  blockers: RequirementResult[];
  /** Uncapped score, kept so the UI can explain a cap rather than hide it. */
  rawScore: number;
  /** Requirements whose evidence actively contradicts the merchant. */
  contradictions: RequirementResult[];
  capped: boolean;
}

/**
 * Pure function: facts + collected evidence kinds -> score. No I/O, no model.
 * This is the function the AI eval (PRD §21) measures band agreement against.
 */
export function scoreCompleteness(
  reason: DisputeReason,
  facts: EvidenceFacts,
  ctx: RubricContext,
): CompletenessResult | null {
  const rubric = getRubric(reason);
  if (!rubric) return null;

  const requirements: RequirementResult[] = rubric.requirements.map((req) => {
    const { satisfied, detail, contradicts } = req.evaluate(facts, ctx);
    const factor = satisfied === 'yes' ? 1 : satisfied === 'partial' ? PARTIAL_CREDIT : 0;
    return {
      id: req.id,
      label: req.label,
      why: req.why,
      weight: req.weight,
      evidenceType: req.evidenceType,
      critical: req.critical,
      satisfied,
      detail,
      earned: Math.round(req.weight * factor * 100) / 100,
      contradicts: contradicts === true,
    };
  });

  const totalWeight = requirements.reduce((sum, r) => sum + r.weight, 0);
  const earned = requirements.reduce((sum, r) => sum + r.earned, 0);
  const rawScore = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);
  const contradictions = requirements.filter((r) => r.contradicts);
  const capped = contradictions.length > 0 && rawScore > CONTRADICTION_CAP;
  const score = capped ? CONTRADICTION_CAP : rawScore;

  return {
    score,
    rawScore,
    contradictions,
    capped,
    band: bandFor(score),
    requirements,
    present: requirements.filter((r) => r.satisfied !== 'no'),
    missing: requirements.filter((r) => r.satisfied === 'no'),
    blockers: requirements.filter((r) => r.critical && r.satisfied === 'no'),
  };
}

/** The PayPal evidence_types worth submitting, given what is actually satisfied. */
export function evidenceTypesToSubmit(result: CompletenessResult): EvidenceType[] {
  const types = new Set<EvidenceType>();
  for (const req of result.requirements) {
    if (req.satisfied !== 'no') types.add(req.evidenceType);
  }
  // PROOF_OF_FULFILLMENT is the anchor type for INR and carries the tracking_info.
  if (types.size === 0) types.add('OTHER');
  return [...types];
}
