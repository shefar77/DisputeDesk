/**
 * The PayPal gateway interface.
 *
 * Two implementations: `LivePayPal` (real sandbox HTTP) and `DemoPayPal` (fixtures,
 * no network). The rest of the server is written against this interface only, so
 * demo mode is not a special case sprinkled through the codebase — it is one object
 * swap at boot, and every code path the judges exercise in demo mode is the same
 * code path that runs against the real sandbox.
 */

import type { OutboundRequest } from '@shared/index.js';
import type {
  RawDispute,
  ShipmentTracking,
  WebhookVerification,
  WriteResult,
} from './types.js';

export interface ListDisputesOptions {
  /** PayPal `dispute_state` filter, e.g. REQUIRED_ACTION. */
  disputeState?: string;
  updateTimeAfter?: string;
  pageSize?: number;
  /** Safety valve so a misconfigured account cannot page forever. */
  maxPages?: number;
}

export interface PayPalGateway {
  readonly mode: 'demo' | 'sandbox';
  /** Human-readable description for /api/health. */
  describe(): { name: string; detail: string };

  listDisputes(options?: ListDisputesOptions): Promise<RawDispute[]>;
  getDispute(disputeId: string): Promise<RawDispute>;

  /**
   * Execute a write. The URL comes from the dispute's own HATEOAS links — the
   * gateway never builds an action URL, so an action PayPal has not offered
   * cannot be called (FR-4).
   */
  execute(request: OutboundRequest, files: OutboundFile[]): Promise<WriteResult>;

  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<WebhookVerification>;

  /** Tracking attached to a transaction, if any (PayPal "list tracking information"). */
  getShipmentTracking(transactionId: string): Promise<ShipmentTracking | null>;
}

export interface OutboundFile {
  field: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly debugId: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}
