/**
 * JSON Schemas for the model's structured outputs.
 *
 * These go to the API as `output_config.format`, so the model is *constrained* to
 * valid JSON rather than asked politely for it. Each parsed result is then run
 * through the matching zod schema in `@shared/schemas` as defence in depth —
 * constrained decoding guarantees the shape, zod guarantees the semantics
 * (enum membership, string lengths, confidence in [0,1]).
 *
 * Structured outputs require every property listed in `required` and
 * `additionalProperties: false`, so optional fields are modelled as nullable.
 */

import {
  ADDRESS_MATCH_RESULTS,
  CARRIER_NAMES,
  DELIVERY_STATUSES,
  DISPUTE_ACTIONS,
  DRAFT_MAX_LENGTH,
} from '@shared/index.js';

const nullableString = (maxLength?: number) =>
  ({ type: ['string', 'null'], ...(maxLength ? { maxLength } : {}) }) as const;

/** T1 — evidence extraction. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    carrier: {
      type: ['string', 'null'],
      maxLength: 120,
      description: 'Carrier name exactly as it appears in the sources, or null if absent.',
    },
    carrier_enum: {
      type: ['string', 'null'],
      enum: [...CARRIER_NAMES, null],
      description:
        "PayPal carrier_name enum value. Use OTHER for a carrier not in the list. Null only if no carrier is named anywhere.",
    },
    tracking_number: {
      type: ['string', 'null'],
      maxLength: 64,
      description:
        'The tracking number copied character-for-character from a source. Never construct, correct or complete one.',
    },
    delivery_status: {
      type: 'string',
      enum: [...DELIVERY_STATUSES],
      description:
        'The carrier-reported state. UNKNOWN when no source states a delivery state. Do not infer DELIVERED from a ship date.',
    },
    delivered_at: nullableString(40),
    last_known_location: nullableString(200),
    signature_obtained: {
      type: ['boolean', 'null'],
      description:
        'true only if a source names a signatory or states the item was signed for. false if a source states no signature was required or taken. null if no source mentions a signature.',
    },
    address_match: {
      type: 'string',
      enum: [...ADDRESS_MATCH_RESULTS],
      description:
        'Compare the delivery destination in the carrier source against the order ship-to address. MATCH when street and postcode agree; PARTIAL when only city/postcode agree; MISMATCH when they conflict; UNKNOWN when either side is missing.',
    },
    ship_date: nullableString(40),
    sources: {
      type: 'array',
      maxItems: 20,
      description:
        'One entry per non-null field above, naming the evidence item it came from. Use only the evidence ids supplied in the prompt.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', maxLength: 40 },
          evidence_id: { type: 'string', maxLength: 64 },
        },
        required: ['field', 'evidence_id'],
      },
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'How well the sources support these facts. Below 0.5 the product will not draft a response.',
    },
    notes: nullableString(600),
  },
  required: [
    'carrier',
    'carrier_enum',
    'tracking_number',
    'delivery_status',
    'delivered_at',
    'last_known_location',
    'signature_obtained',
    'address_match',
    'ship_date',
    'sources',
    'confidence',
    'notes',
  ],
} as const;

/** T2 — plan narrative. The completeness number is NOT the model's to give. */
export const PLAN_NARRATIVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rationale: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      description:
        'Each entry is one factual claim you would put to PayPal, with the evidence ids that support it. A claim with no supporting evidence id must not appear.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string', minLength: 3, maxLength: 400 },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', maxLength: 64 },
          },
        },
        required: ['claim', 'evidence_ids'],
      },
    },
    risks: {
      type: 'array',
      maxItems: 6,
      description:
        'Weaknesses a PayPal reviewer would notice. Be candid; this is read by the merchant, not by the buyer.',
      items: { type: 'string', minLength: 3, maxLength: 300 },
    },
    recommended_action: {
      type: 'string',
      enum: [...DISPUTE_ACTIONS],
      description:
        'Choose only from the actions listed as currently available in the prompt. Recommend accept-claim only when the evidence genuinely does not support the merchant.',
    },
    recommended_action_why: { type: 'string', minLength: 3, maxLength: 300 },
    triage_note: {
      type: 'string',
      minLength: 3,
      maxLength: 160,
      description: 'One line for the queue explaining why this dispute needs attention.',
    },
  },
  required: ['rationale', 'risks', 'recommended_action', 'recommended_action_why', 'triage_note'],
} as const;

/** T3 — draft response. */
export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      minLength: 40,
      maxLength: DRAFT_MAX_LENGTH,
      description:
        'The message to PayPal. Plain prose, no salutation to the buyer, no markdown. State only facts present in the evidence. Do not promise, guarantee or predict an outcome.',
    },
    evidence_refs: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: 'Every evidence id the text relies on. Validated against the database.',
      items: { type: 'string', maxLength: 64 },
    },
    tone: { type: 'string', enum: ['factual', 'conciliatory', 'firm'] },
  },
  required: ['text', 'evidence_refs', 'tone'],
} as const;
