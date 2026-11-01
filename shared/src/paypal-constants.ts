/**
 * PayPal Customer Disputes v1 — constants copied VERBATIM from the primary source.
 *
 * Source: https://developer.paypal.com/api/customer-disputes/v1/schema.json
 * Retrieved + extracted: 2026-11-01. See docs/spike-G0.md for the extraction method.
 *
 * PRD §12 / risk register #2 flagged the evidence enum + evidence_info shape as [U]
 * ("copy from schema.json at Day 1"). This file is that copy — do not hand-edit values.
 */

/** `dispute_reason` enum. [V] schema.json components.schemas.dispute_reason */
export const DISPUTE_REASONS = [
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'UNAUTHORISED',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** Merchant-facing labels. Ours, for UI only — not from PayPal. */
export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
  UNAUTHORISED: 'Unauthorised transaction',
  CREDIT_NOT_PROCESSED: 'Refund not processed',
  DUPLICATE_TRANSACTION: 'Duplicate transaction',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Cancelled recurring billing',
  PROBLEM_WITH_REMITTANCE: 'Problem with remittance',
  OTHER: 'Other',
};

/** `status` enum. [V] */
export const DISPUTE_STATUSES = [
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'OTHER',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** `dispute_lifecycle_stage` enum. [V] */
export const DISPUTE_STAGES = ['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

/**
 * `evidence_type` enum — the complete list. [V]
 * We only *submit* a small allow-listed subset (see SUBMITTABLE_EVIDENCE_TYPES);
 * the full list is kept so we can recognise anything PayPal requests from us.
 */
export const EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'PROOF_OF_DELIVERY_SIGNATURE',
  'PROOF_OF_RECEIPT_COPY', 'RETURN_POLICY', 'BILLING_AGREEMENT',
  'PROOF_OF_RESHIPMENT', 'ITEM_DESCRIPTION', 'POLICE_REPORT', 'AFFIDAVIT',
  'PAID_WITH_OTHER_METHOD', 'COPY_OF_CONTRACT', 'TERMINAL_ATM_RECEIPT',
  'PRICE_DIFFERENCE_REASON', 'SOURCE_CONVERSION_RATE', 'BANK_STATEMENT',
  'CREDIT_DUE_REASON', 'REQUEST_CREDIT_RECEIPT', 'PROOF_OF_RETURN', 'CREATE',
  'CHANGE_REASON', 'PROOF_OF_REFUND_OUTSIDE_PAYPAL', 'RECEIPT_OF_MERCHANDISE',
  'CUSTOMS_DOCUMENT', 'CUSTOMS_FEE_RECEIPT', 'INFORMATION_ON_RESOLUTION',
  'ADDITIONAL_INFORMATION_OF_ITEM', 'DETAILS_OF_PURCHASE',
  'PROOF_OF_SIGNIFICANT_DIFFERENCE', 'PROOF_OF_SOFTWARE_OR_SERVICE_NOT_AS_DESCRIBED',
  'PROOF_OF_CONFISCATION', 'PROOF_OF_DAMAGE', 'COPY_OF_LAW_ENFORCEMENT_AGENCY_REPORT',
  'ADDITIONAL_PROOF_OF_SHIPMENT', 'PROOF_OF_DENIAL_BY_CARRIER',
  'THIRDPARTY_PROOF_FOR_DAMAGE_OR_SIGNIFICANT_DIFFERENCE', 'VALID_SUPPORTING_DOCUMENT',
  'LEGIBLE_SUPPORTING_DOCUMENT', 'RETURN_TRACKING_INFORMATION', 'DELIVERY_RECEIPT',
  'PROOF_OF_INSTORE_RECEIPT', 'ADDITIONAL_TRACKING_INFORMATION',
  'PROOF_OF_SHIPMENT_POSTAGE', 'ONLINE_TRACKING_INFORMATION', 'PROOF_OF_INSTORE_REFUND',
  'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED', 'RETURN_ADDRESS_FOR_SHIPPING',
  'COPY_OF_THE_EPARCEL_MANIFEST', 'COPY_OF_SHIPPING_MANIFEST', 'APPEAL_AFFIDAVIT',
  'RECEIPT_OF_REPLACEMENT', 'COPY_OF_DRIVERS_LICENSE', 'ACCOUNT_CHANGE_INFORMATION',
  'DELIVERY_ADDRESS', 'CONFIRMATION_OF_RESOLUTION', 'MERCHANT_RESPONSE',
  'PERMISSION_DESCRIPTION', 'STATUS_OF_MERCHANDISE', 'LOST_CARD_DETAILS',
  'LAST_VALID_TRANSACTION_DETAILS', 'ADDITIONAL_PROOF_OF_RETURN', 'DECLARATION',
  'PROOF_OF_MISSING_ITEMS', 'PROOF_OF_EMPTY_PACKAGE_OR_DIFFERENT_ITEM',
  'PROOF_OF_ITEM_NOT_RECEIVED', 'ORDER_DETAILS', 'LISTING_URL', 'SHIPPING_INSURANCE',
  'BUYER_RESPONSE', 'PHOTOS_OF_SHIPPED_ITEM', 'OTHER', 'CANCELLATION_DETAILS',
  'MERCHANT_CONTACT_DETAILS', 'ITEM_DETAILS', 'CORRECT_RECIPIENT_INFORMATION',
  'EXPLANATION_OF_FUNDS_NOT_DELIVERED', 'CONFIRMATION_OF_RECALL',
  'COMMUNICATION_WITH_THE_SENDER', 'PAYMENT_REASON', 'PROOF_OF_EXPECTED_DELIVERY_DATE',
  'DELIVERY_DELAY_COMMUNICATION', 'ADDITIONAL_SCAM_DETAILS', 'REASON_FOR_LATE_OPENING',
  'COMMUNICATION_WITH_THE_RECIPIENT', 'EFFORTS_TO_VERIFY_RECIPIENT',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * schema.json, components.schemas.evidence, description (verbatim):
 *   "evidence_info is expected for PROOF_OF_FULFILLMENT,PROOF_OF_REFUND and
 *    PROOF_OF_RETURN evidence types. documents and notes can be given for rest
 *    of the evidence types."
 * This drives both payload construction and server-side validation. [V]
 */
export const EVIDENCE_TYPES_REQUIRING_EVIDENCE_INFO = [
  'PROOF_OF_FULFILLMENT',
  'PROOF_OF_REFUND',
  'PROOF_OF_RETURN',
] as const satisfies readonly EvidenceType[];

/** The subset DisputeDesk may submit in P0 (Item Not Received). */
export const SUBMITTABLE_EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT',
  'ONLINE_TRACKING_INFORMATION',
  'PROOF_OF_DELIVERY_SIGNATURE',
  'PROOF_OF_SHIPMENT_POSTAGE',
  'DELIVERY_RECEIPT',
  'DELIVERY_ADDRESS',
  'ORDER_DETAILS',
  'OTHER',
] as const satisfies readonly EvidenceType[];

/**
 * `tracking_info.carrier_name` enum — the globally-relevant subset we map onto.
 * The full enum is ~200 region-specific values; `OTHER` is the documented catch-all. [V]
 */
export const CARRIER_NAMES = [
  'UPS', 'USPS', 'FEDEX', 'DHL', 'ROYAL_MAIL', 'PARCELFORCE', 'TNT',
  'CA_CANADA_POST', 'CN_CHINA_POST', 'HK_HONGKONG_POST', 'AIRBORNE_EXPRESS',
  'AIRSURE', 'SWIFTAIR', 'OTHER',
] as const;
export type CarrierName = (typeof CARRIER_NAMES)[number];

/** `offer_type` enum. [V] */
export const OFFER_TYPES = [
  'REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND',
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/**
 * HATEOAS rel values we act on. Actions are ONLY offered when the rel is present in
 * the dispute's `links` array (FR-4). schema.json, provide-evidence description:
 * "In case the link is not present in the response, you can't provide evidence."
 */
export const DISPUTE_ACTIONS = [
  'provide-evidence', 'send-message', 'make-offer', 'accept-claim', 'escalate',
  'appeal', 'acknowledge-return-item', 'provide-supporting-info',
] as const;
export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

/** Merchant-facing description of what each action actually does. Ours. */
export const DISPUTE_ACTION_LABELS: Record<DisputeAction, { label: string; consequence: string }> = {
  'provide-evidence': { label: 'Provide evidence', consequence: 'Sends your evidence and notes to PayPal for review.' },
  'send-message': { label: 'Send message', consequence: 'Posts a message visible to the buyer (inquiry stage) or to PayPal.' },
  'make-offer': { label: 'Make offer', consequence: 'Offers the buyer a refund or replacement to resolve the dispute.' },
  'accept-claim': { label: 'Accept claim', consequence: 'Refunds the buyer and closes the dispute against you.' },
  'escalate': { label: 'Escalate to claim', consequence: 'Asks PayPal to investigate and decide the dispute.' },
  'appeal': { label: 'Appeal', consequence: 'Appeals a decision that went against you.' },
  'acknowledge-return-item': { label: 'Acknowledge return', consequence: 'Confirms whether you received the returned item.' },
  'provide-supporting-info': { label: 'Provide supporting info', consequence: 'Adds supporting information without changing the dispute stage.' },
};

/** Actions that move money or concede the case — these require a second confirmation. */
export const HIGH_CONSEQUENCE_ACTIONS: readonly DisputeAction[] = ['accept-claim', 'make-offer'];

/**
 * Document constraints.
 * Source: https://developer.paypal.com/growth/disputes/reference/supported-file-types-sizes
 * Marked [U-doc]: taken from PayPal's published limits page rather than schema.json,
 * so they are enforced conservatively on both client and server and shown in the UI.
 */
export const FILE_LIMITS = {
  maxBytesPerFile: 10 * 1024 * 1024,
  maxFilesPerSubmission: 10,
  allowedMimeTypes: [
    'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/tiff',
  ] as const,
  allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff'] as const,
} as const;

/** `notes` maxLength on the evidence object. [V] */
export const EVIDENCE_NOTES_MAX_LENGTH = 2000;
/** `note` maxLength on make_offer. [V] */
export const MESSAGE_MAX_LENGTH = 2000;
/** Our own cap on generated draft text (PRD §13, task T3: "≤ 1,500 chars"). */
export const DRAFT_MAX_LENGTH = 1500;

export const PAYPAL_BASE_URLS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

export const WEBHOOK_EVENT_TYPES = [
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
