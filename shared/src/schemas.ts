/**
 * Zod schemas for every LLM output and every internal API payload.
 *
 * Rule from PRD §13: the model returns JSON and nothing else, and no model output
 * reaches a PayPal write path without passing one of these schemas first. A parse
 * failure is a product state ("needs manual review"), not an exception to swallow.
 */

import { z } from 'zod';
import {
  CARRIER_NAMES,
  DISPUTE_ACTIONS,
  DISPUTE_REASONS,
  DISPUTE_STAGES,
  DISPUTE_STATUSES,
  DRAFT_MAX_LENGTH,
  EVIDENCE_TYPES,
  OFFER_TYPES,
  SUBMITTABLE_EVIDENCE_TYPES,
} from './paypal-constants.js';
import { ADDRESS_MATCH_RESULTS, COMPLETENESS_BANDS, DELIVERY_STATUSES } from './rubric.js';

export const disputeReasonSchema = z.enum(DISPUTE_REASONS);
export const disputeStatusSchema = z.enum(DISPUTE_STATUSES);
export const disputeStageSchema = z.enum(DISPUTE_STAGES);
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export const submittableEvidenceTypeSchema = z.enum(SUBMITTABLE_EVIDENCE_TYPES);
export const carrierNameSchema = z.enum(CARRIER_NAMES);
export const disputeActionSchema = z.enum(DISPUTE_ACTIONS);
export const offerTypeSchema = z.enum(OFFER_TYPES);

/** Internal evidence taxonomy — distinct from PayPal's `evidence_type`. */
export const EVIDENCE_KINDS = [
  'paypal_dispute',
  'paypal_transaction',
  'paypal_shipment_tracking',
  'carrier_capture',
  'order_record',
  'upload',
  'buyer_message',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EVIDENCE_SOURCES = ['paypal', 'kernel', 'zapier', 'upload', 'fixture'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export const evidenceSourceSchema = z.enum(EVIDENCE_SOURCES);

// ---------------------------------------------------------------------------
// T1 — evidence extraction (LLM output)
// ---------------------------------------------------------------------------

/**
 * Which evidence item a single extracted field came from.
 *
 * Deliberately a flat array rather than a map: structured-output JSON Schema
 * needs every property declared with `additionalProperties: false`, which an
 * open-ended object cannot satisfy. The workflow folds this into a record.
 */
export const factSourceSchema = z.object({
  field: z.string().min(1).max(40),
  evidence_id: z.string().min(1).max(64),
});

/**
 * Extracted facts. Every `evidence_id` is checked against the evidence items
 * actually stored for the dispute: a model that invents an id fails validation
 * and the extraction is rejected rather than quietly trusted.
 */
export const extractionSchema = z.object({
  carrier: z.string().max(120).nullable(),
  carrier_enum: carrierNameSchema.nullable(),
  tracking_number: z.string().max(64).nullable(),
  delivery_status: z.enum(DELIVERY_STATUSES),
  delivered_at: z.string().max(40).nullable(),
  last_known_location: z.string().max(200).nullable(),
  signature_obtained: z.boolean().nullable(),
  address_match: z.enum(ADDRESS_MATCH_RESULTS),
  ship_date: z.string().max(40).nullable(),
  sources: z.array(factSourceSchema).max(20),
  confidence: z.number().min(0).max(1),
  /** Short note on anything ambiguous. Never rendered as a claim. */
  notes: z.string().max(600).nullable(),
});
export type ExtractionOutput = z.infer<typeof extractionSchema>;

// ---------------------------------------------------------------------------
// T2 — evidence plan (LLM narrative over a deterministic score)
// ---------------------------------------------------------------------------

export const rationaleItemSchema = z.object({
  claim: z.string().min(3).max(400),
  evidence_ids: z.array(z.string().min(1)).min(1),
});

/**
 * The model supplies rationale, risks and next actions. It does NOT supply
 * `completeness` — that is computed by `scoreCompleteness` and merged in by the
 * server, so the number on screen is always the rubric's number.
 */
export const planNarrativeSchema = z.object({
  rationale: z.array(rationaleItemSchema).min(1).max(8),
  risks: z.array(z.string().min(3).max(300)).max(6),
  recommended_action: disputeActionSchema,
  recommended_action_why: z.string().min(3).max(300),
  /** One line for the queue's "why this is next" column (task T4). */
  triage_note: z.string().min(3).max(160),
});
export type PlanNarrative = z.infer<typeof planNarrativeSchema>;

export const requirementResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  why: z.string(),
  weight: z.number(),
  evidenceType: evidenceTypeSchema,
  critical: z.boolean(),
  satisfied: z.enum(['yes', 'partial', 'no']),
  detail: z.string(),
  earned: z.number(),
  contradicts: z.boolean(),
});

/** The stored plan: deterministic score + validated model narrative. */
export const evidencePlanSchema = z.object({
  reason: disputeReasonSchema,
  completeness: z.number().min(0).max(100),
  rawCompleteness: z.number().min(0).max(100),
  capped: z.boolean(),
  band: z.enum(COMPLETENESS_BANDS),
  requirements: z.array(requirementResultSchema),
  facts: z.object({
    carrier: z.string().nullable(),
    carrierEnum: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    deliveryStatus: z.enum(DELIVERY_STATUSES),
    deliveredAt: z.string().nullable(),
    lastKnownLocation: z.string().nullable(),
    signatureObtained: z.boolean().nullable(),
    addressMatch: z.enum(ADDRESS_MATCH_RESULTS),
    shipDate: z.string().nullable(),
    sources: z.record(z.string(), z.string()),
    confidence: z.number(),
  }),
  narrative: planNarrativeSchema,
  /** Retrieved policy passages that grounded the plan, with their citation URLs. */
  citations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      score: z.number().optional(),
    }),
  ),
  generator: z.enum(['llm', 'deterministic']),
  model: z.string(),
});
export type EvidencePlan = z.infer<typeof evidencePlanSchema>;

// ---------------------------------------------------------------------------
// T3 — draft response (LLM output)
// ---------------------------------------------------------------------------

export const draftOutputSchema = z.object({
  text: z.string().min(40).max(DRAFT_MAX_LENGTH),
  evidence_refs: z.array(z.string().min(1)).min(1).max(20),
  tone: z.enum(['factual', 'conciliatory', 'firm']),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

// ---------------------------------------------------------------------------
// Internal API payloads
// ---------------------------------------------------------------------------

export const previewRequestSchema = z.object({
  action: disputeActionSchema,
  /** Present for make-offer. */
  offer: z
    .object({
      offer_type: offerTypeSchema,
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      note: z.string().min(1).max(2000),
    })
    .optional(),
});
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export const approveRequestSchema = previewRequestSchema.extend({
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export const saveDraftSchema = z.object({
  edited_text: z.string().min(1).max(DRAFT_MAX_LENGTH),
});

export const webhookEnvelopeSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().optional(),
  summary: z.string().optional(),
  create_time: z.string().optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;
