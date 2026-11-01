/**
 * Outbound PayPal request construction.
 *
 * This is the only place that builds a body for a PayPal write. Everything here
 * is pure: given a dispute, a plan, a draft and the files on hand, produce an
 * `OutboundRequest`. The submit path hashes exactly what this returns, the UI
 * shows exactly what this returns, and nothing else may invent a payload.
 *
 * Verification status of each body shape:
 *  - provide-evidence `{ evidences: [...] }`, evidence object fields, the
 *    `evidence_info`-only-for-three-types rule, `tracking_info` and its
 *    `carrier_name` enum, and `document.name`'s pattern: [V] schema.json.
 *  - make-offer `{ note, offer_amount, offer_type }`: [V] schema.json (make_offer).
 *  - send-message `{ message }` and accept-claim `{ note, accept_claim_type }`:
 *    [U-doc]. PayPal's published OpenAPI models only the *file* part of these
 *    multipart bodies and omits the JSON part, so these two shapes come from the
 *    REST reference prose rather than the machine-readable spec. They are built
 *    conservatively (minimal fields) and are gated behind the approval preview,
 *    so a wrong shape surfaces as a visible 400 rather than a silent mis-send.
 */

import { createHash } from 'node:crypto';
import {
  DRAFT_MAX_LENGTH,
  EVIDENCE_NOTES_MAX_LENGTH,
  EVIDENCE_TYPES_REQUIRING_EVIDENCE_INFO,
  MESSAGE_MAX_LENGTH,
  type CarrierName,
  type DisputeAction,
  type EvidenceType,
  type OutboundFileRef,
  type OutboundRequest,
} from '@shared/index.js';

export const ACCEPT_CLAIM_TYPES = [
  'REFUND',
  'REFUND_WITH_RETURN',
  'PARTIAL_REFUND',
  'REFUND_WITH_RETURN_SHIPMENT_LABEL',
] as const;
export type AcceptClaimType = (typeof ACCEPT_CLAIM_TYPES)[number];

/** `document.name` pattern from schema.json: ^[A-Za-z0-9-_,\s]+[.]{1}[A-Za-z]+$ [V] */
const DOCUMENT_NAME_RE = /^[A-Za-z0-9\-_,\s]+[.]{1}[A-Za-z]+$/;

/**
 * PayPal rejects document names that do not match its pattern (no dots in the
 * stem, alphabetic extension). We also never echo a merchant's original filename
 * outbound — PRD §18 requires random names on upload, and this keeps that promise
 * all the way to PayPal.
 */
export function safeDocumentName(originalName: string, fallbackStem: string): string {
  const dot = originalName.lastIndexOf('.');
  const rawExt = dot > 0 ? originalName.slice(dot + 1) : '';
  const ext = /^[A-Za-z]+$/.test(rawExt) ? rawExt.toLowerCase() : 'pdf';
  const stem = fallbackStem.replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 40) || 'evidence';
  const name = `${stem}.${ext}`;
  if (!DOCUMENT_NAME_RE.test(name)) throw new Error(`Unsafe document name: ${name}`);
  return name;
}

export function isValidDocumentName(name: string): boolean {
  return DOCUMENT_NAME_RE.test(name);
}

export interface TrackingInfo {
  carrier_name: CarrierName;
  tracking_number: string;
}

export interface EvidenceEntry {
  evidence_type: EvidenceType;
  evidence_info?: { tracking_info?: TrackingInfo[]; refund_ids?: string[] };
  documents?: { name: string }[];
  notes?: string;
}

export interface BuildEvidenceArgs {
  baseUrl: string;
  disputeId: string;
  /** Resolved from the dispute's HATEOAS links, never constructed by us. */
  href: string;
  evidenceTypes: EvidenceType[];
  tracking: TrackingInfo | null;
  notes: string;
  files: OutboundFileRef[];
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the provide-evidence request.
 *
 * `evidence_info` is attached only to PROOF_OF_FULFILLMENT / PROOF_OF_REFUND /
 * PROOF_OF_RETURN, per the schema's own description. Attaching it elsewhere is
 * the mistake PRD risk #2 was about, so it is structurally impossible here.
 */
export function buildProvideEvidence(args: BuildEvidenceArgs): OutboundRequest {
  if (args.evidenceTypes.length === 0) {
    throw new Error('provide-evidence requires at least one evidence_type');
  }

  const notes = clamp(args.notes, EVIDENCE_NOTES_MAX_LENGTH);
  const requiresInfo = new Set<string>(EVIDENCE_TYPES_REQUIRING_EVIDENCE_INFO);

  const evidences: EvidenceEntry[] = args.evidenceTypes.map((type, idx) => {
    const entry: EvidenceEntry = { evidence_type: type };

    if (requiresInfo.has(type)) {
      if (!args.tracking) {
        throw new Error(
          `${type} requires evidence_info.tracking_info, but no tracking number was established`,
        );
      }
      entry.evidence_info = { tracking_info: [args.tracking] };
    } else {
      // documents + notes are the documented carrier for every other type.
      if (args.files.length > 0) {
        entry.documents = args.files.map((f) => ({ name: f.filename }));
      }
    }

    // The narrative belongs on exactly one entry; repeating it 6x is noise to a reviewer.
    if (idx === 0) entry.notes = notes;

    return entry;
  });

  const hasFiles = args.files.length > 0;
  return {
    method: 'POST',
    url: args.href,
    // multipart/related with an `input` JSON part is PayPal's documented form for
    // evidence-with-documents; JSON-only when there is nothing to attach.
    contentType: hasFiles ? 'multipart/related' : 'application/json',
    body: { evidences },
    files: args.files,
  };
}

export function buildSendMessage(href: string, message: string): OutboundRequest {
  return {
    method: 'POST',
    url: href,
    contentType: 'application/json',
    body: { message: clamp(message, MESSAGE_MAX_LENGTH) },
    files: [],
  };
}

export interface MakeOfferArgs {
  href: string;
  note: string;
  offerType: 'REFUND' | 'REFUND_WITH_RETURN' | 'REFUND_WITH_REPLACEMENT' | 'REPLACEMENT_WITHOUT_REFUND';
  amount: string;
  currency: string;
}

export function buildMakeOffer(args: MakeOfferArgs): OutboundRequest {
  const body: Record<string, unknown> = {
    note: clamp(args.note, MESSAGE_MAX_LENGTH),
    offer_type: args.offerType,
  };
  // REPLACEMENT_WITHOUT_REFUND moves no money, so offer_amount would be meaningless.
  if (args.offerType !== 'REPLACEMENT_WITHOUT_REFUND') {
    body.offer_amount = { currency_code: args.currency, value: args.amount };
  }
  return { method: 'POST', url: args.href, contentType: 'application/json', body, files: [] };
}

export function buildAcceptClaim(
  href: string,
  note: string,
  acceptClaimType: AcceptClaimType = 'REFUND',
): OutboundRequest {
  return {
    method: 'POST',
    url: href,
    contentType: 'application/json',
    body: { note: clamp(note, MESSAGE_MAX_LENGTH), accept_claim_type: acceptClaimType },
    files: [],
  };
}

/** SHA-256 of a buffer, used for evidence-item content hashes and file refs. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The canonical-form hash that the approval row binds to (FR-9). */
export function hashOutbound(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Amount validation for make-offer (FR-14): an offer above the disputed amount is
 * refused server-side. Compared in integer minor units to avoid float drift.
 */
export function validateOfferAmount(
  offer: string,
  disputed: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!/^\d+(\.\d{1,2})?$/.test(offer)) {
    return { ok: false, reason: `Offer amount "${offer}" is not a valid 2-decimal amount` };
  }
  const minor = (v: string): number => Math.round(Number(v) * 100);
  const o = minor(offer);
  if (o <= 0) return { ok: false, reason: 'Offer amount must be greater than zero' };
  if (disputed === null) return { ok: true };
  const d = minor(disputed);
  if (o > d) {
    return { ok: false, reason: `Offer ${offer} exceeds the disputed amount ${disputed}` };
  }
  return { ok: true };
}

/** Maps a free-text carrier name onto PayPal's `carrier_name` enum. */
export function mapCarrierToEnum(raw: string | null): CarrierName | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[^A-Z]/g, '');
  const table: [RegExp, CarrierName][] = [
    [/^UPS|UNITEDPARCEL/, 'UPS'],
    [/USPS|UNITEDSTATESPOSTAL|POSTALSERVICE/, 'USPS'],
    [/FEDEX|FEDERALEXPRESS/, 'FEDEX'],
    [/DHL/, 'DHL'],
    [/ROYALMAIL/, 'ROYAL_MAIL'],
    [/PARCELFORCE/, 'PARCELFORCE'],
    [/^TNT/, 'TNT'],
    [/CANADAPOST|POSTESCANADA/, 'CA_CANADA_POST'],
    [/CHINAPOST/, 'CN_CHINA_POST'],
    [/HONGKONGPOST/, 'HK_HONGKONG_POST'],
    [/AIRBORNE/, 'AIRBORNE_EXPRESS'],
  ];
  for (const [re, value] of table) if (re.test(s)) return value;
  return 'OTHER';
}

/** Tracking-number shape check — the deterministic cross-check behind task T1. */
export function looksLikeTrackingNumber(value: string | null): boolean {
  if (!value) return false;
  const v = value.replace(/\s/g, '').toUpperCase();
  if (v.length < 8 || v.length > 40) return false;
  if (!/^[A-Z0-9]+$/.test(v)) return false;
  // Must contain at least one digit; pure-alpha strings are prose, not tracking ids.
  return /\d/.test(v);
}

export const DRAFT_LIMIT = DRAFT_MAX_LENGTH;

/** Which internal action maps to which HATEOAS rel. Identity today, explicit on purpose. */
export function relForAction(action: DisputeAction): string {
  return action;
}
