/** Raw PayPal Customer Disputes v1 response shapes (the subset we read). */

import type { DisputeReason, DisputeStage, DisputeStatus, PayPalLink } from '@shared/index.js';

export interface RawMoney {
  currency_code: string;
  value: string;
}

export interface RawMessage {
  posted_by?: 'BUYER' | 'SELLER' | 'ARBITER';
  time_posted?: string;
  content?: string;
  documents?: { name?: string; url?: string }[];
}

export interface RawTrackingInfo {
  carrier_name?: string;
  tracking_number?: string;
  carrier_name_other?: string;
}

export interface RawEvidence {
  evidence_type?: string;
  evidence_info?: { tracking_info?: RawTrackingInfo[]; refund_ids?: string[] };
  documents?: { name?: string; url?: string }[];
  notes?: string;
  source?: string;
  date?: string;
  item_id?: string;
}

export interface RawTransactionInfo {
  buyer_transaction_id?: string;
  seller_transaction_id?: string;
  create_time?: string;
  transaction_status?: string;
  gross_amount?: RawMoney;
  invoice_number?: string;
  custom?: string;
  buyer?: { name?: string; email?: string };
  seller?: { email?: string; merchant_id?: string; name?: string };
  items?: {
    item_id?: string;
    item_name?: string;
    item_description?: string;
    item_quantity?: string;
    item_amount?: RawMoney;
  }[];
}

export interface RawDispute {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: DisputeReason;
  status?: DisputeStatus;
  dispute_state?: string;
  dispute_amount?: RawMoney;
  dispute_life_cycle_stage?: DisputeStage;
  dispute_channel?: string;
  /** The response deadline that drives the whole product. */
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  messages?: RawMessage[];
  extensions?: Record<string, unknown>;
  disputed_transactions?: RawTransactionInfo[];
  evidences?: RawEvidence[];
  offer?: Record<string, unknown>;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: RawMoney };
  links?: PayPalLink[];
  [key: string]: unknown;
}

export interface RawDisputeList {
  items?: RawDispute[];
  links?: PayPalLink[];
}

export interface WriteResult {
  ok: boolean;
  httpStatus: number;
  debugId: string | null;
  body: Record<string, unknown> | null;
  error: string | null;
  /** True in demo mode: the request was recorded but never left the process. */
  simulated: boolean;
}

export interface WebhookVerification {
  verified: boolean;
  /** PayPal's `verification_status`: SUCCESS | FAILURE, or our own reason. */
  status: string;
}

export interface ShipmentTracking {
  carrier?: string;
  tracking_number?: string;
  status?: string;
  last_updated_time?: string;
  shipment_date?: string;
  [key: string]: unknown;
}
