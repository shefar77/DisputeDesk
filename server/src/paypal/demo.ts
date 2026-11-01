/**
 * Demo gateway — fixtures, no network, no credentials.
 *
 * This exists because of hackathon rule R9: a judge must be able to exercise the
 * product for free with no setup. It is also the honest answer to PRD risk #1
 * (sandbox dispute availability): if a real sandbox dispute cannot be obtained,
 * the demo still shows the whole loop, clearly labelled as fixture data.
 *
 * Two promises this class keeps:
 *  1. No HTTP request ever leaves it. `execute` records the request and returns a
 *     `simulated: true` result, so the UI and audit log can say "recorded, not
 *     sent" rather than implying a PayPal write happened.
 *  2. State transitions mirror the real API. After provide-evidence the dispute
 *     moves to UNDER_REVIEW and loses its `provide-evidence` link, exactly as
 *     PayPal would do — so the post-submit UI is exercised, not faked.
 */

import type { OutboundRequest, PayPalLink } from '@shared/index.js';
import { logger } from '../log.js';
import type { ListDisputesOptions, OutboundFile, PayPalGateway } from './gateway.js';
import { buildScenarios, heldOutScenarios, type Scenario } from '../fixtures/scenarios.js';
import type {
  RawDispute,
  ShipmentTracking,
  WebhookVerification,
  WriteResult,
} from './types.js';

interface Overlay {
  status?: string;
  stage?: string;
  removeRels?: string[];
  outcome?: { outcome_code?: string };
  extraMessages?: { posted_by: 'SELLER'; time_posted: string; content: string }[];
}

export class DemoPayPal implements PayPalGateway {
  readonly mode = 'demo' as const;
  /** Scenario set is built once so deadlines stay stable for the session. */
  private readonly scenarios: Scenario[];
  private readonly overlays = new Map<string, Overlay>();
  /** Everything `execute` was asked to send, for the audit trail and tests. */
  readonly recorded: { at: string; request: OutboundRequest; files: string[] }[] = [];

  constructor(now: Date = new Date()) {
    // The held-out eval set is never shown in the demo queue.
    this.scenarios = buildScenarios(now).concat(
      process.env.DEMO_INCLUDE_HELDOUT === 'true' ? heldOutScenarios(now) : [],
    );
  }

  describe() {
    return {
      name: 'PayPal Disputes API',
      detail: `demo mode — ${this.scenarios.length} fixture disputes, no outbound calls`,
    };
  }

  /** Scenario lookup, used by the demo carrier capture and order-record steps. */
  scenarioFor(disputeId: string): Scenario | null {
    return this.scenarios.find((s) => s.dispute.dispute_id === disputeId) ?? null;
  }

  allScenarios(): readonly Scenario[] {
    return this.scenarios;
  }

  private withOverlay(raw: RawDispute): RawDispute {
    const overlay = this.overlays.get(raw.dispute_id);
    if (!overlay) return raw;

    const links = (raw.links ?? []).filter(
      (l: PayPalLink) => !(overlay.removeRels ?? []).includes(l.rel),
    );
    return {
      ...raw,
      ...(overlay.status ? { status: overlay.status as RawDispute['status'] } : {}),
      ...(overlay.stage ? { dispute_life_cycle_stage: overlay.stage as RawDispute['dispute_life_cycle_stage'] } : {}),
      ...(overlay.outcome ? { dispute_outcome: overlay.outcome } : {}),
      messages: [...(raw.messages ?? []), ...(overlay.extraMessages ?? [])],
      links,
      update_time: new Date().toISOString(),
    };
  }

  async listDisputes(_options: ListDisputesOptions = {}): Promise<RawDispute[]> {
    return this.scenarios.map((s) => this.withOverlay(s.dispute));
  }

  async getDispute(disputeId: string): Promise<RawDispute> {
    const scenario = this.scenarioFor(disputeId);
    if (!scenario) {
      const err = new Error(`Demo gateway has no fixture for dispute ${disputeId}`);
      (err as Error & { httpStatus?: number }).httpStatus = 404;
      throw err;
    }
    return this.withOverlay(scenario.dispute);
  }

  async getShipmentTracking(transactionId: string): Promise<ShipmentTracking | null> {
    const scenario = this.scenarios.find((s) =>
      (s.dispute.disputed_transactions ?? []).some((t) => t.seller_transaction_id === transactionId),
    );
    const tracking = (scenario?.dispute as { _fixture_tracking?: { carrier: string; number: string } } | undefined)
      ?._fixture_tracking;
    if (!tracking) return null;
    return {
      carrier: tracking.carrier,
      tracking_number: tracking.number,
      status: 'SHIPPED',
      shipment_date: scenario?.orderRecord?.ship_date ?? undefined,
    };
  }

  /**
   * Records the request and applies the state transition PayPal would apply.
   * Returns `simulated: true` so no caller can report this as a real submission.
   */
  async execute(request: OutboundRequest, files: OutboundFile[]): Promise<WriteResult> {
    this.recorded.push({
      at: new Date().toISOString(),
      request,
      files: files.map((f) => f.filename),
    });

    const disputeId = disputeIdFromUrl(request.url);
    const rel = relFromUrl(request.url);
    logger.info({ disputeId, rel, simulated: true }, 'Demo gateway recorded a write (not sent)');

    if (disputeId) {
      const current = this.overlays.get(disputeId) ?? {};
      switch (rel) {
        case 'provide-evidence':
          this.overlays.set(disputeId, {
            ...current,
            status: 'UNDER_REVIEW',
            removeRels: ['provide-evidence', 'make-offer', 'accept-claim'],
          });
          break;
        case 'accept-claim':
          this.overlays.set(disputeId, {
            ...current,
            status: 'RESOLVED',
            outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' },
            removeRels: ['provide-evidence', 'make-offer', 'accept-claim', 'send-message'],
          });
          break;
        case 'make-offer':
          this.overlays.set(disputeId, {
            ...current,
            status: 'WAITING_FOR_BUYER_RESPONSE',
            removeRels: ['make-offer', 'accept-claim'],
          });
          break;
        case 'send-message': {
          const message = (request.body as { message?: string } | null)?.message ?? '';
          this.overlays.set(disputeId, {
            ...current,
            extraMessages: [
              ...(current.extraMessages ?? []),
              { posted_by: 'SELLER', time_posted: new Date().toISOString(), content: message },
            ],
          });
          break;
        }
        default:
          break;
      }
    }

    return {
      ok: true,
      httpStatus: 200,
      debugId: `demo-${Date.now().toString(36)}`,
      body: {
        _demo: true,
        _note: 'Recorded by DisputeDesk demo mode. No request was sent to PayPal.',
      },
      error: null,
      simulated: true,
    };
  }

  /** Forget every simulated PayPal-side change (demo reset). */
  reset(): void {
    this.overlays.clear();
    this.recorded.length = 0;
  }

  /**
   * Demo-only: stands in for PayPal adjudicating the case, so the
   * webhook -> re-read -> timeline path can be exercised. Every caller labels the
   * resulting timeline entry as a demo simulation.
   */
  simulateResolution(disputeId: string, outcome: 'RESOLVED_SELLER_FAVOUR' | 'RESOLVED_BUYER_FAVOUR'): void {
    const current = this.overlays.get(disputeId) ?? {};
    this.overlays.set(disputeId, {
      ...current,
      status: 'RESOLVED',
      outcome: { outcome_code: outcome },
      removeRels: ['provide-evidence', 'make-offer', 'accept-claim', 'send-message', 'escalate'],
    });
  }

  /**
   * Demo mode has no webhook id and no PayPal to ask, so verification cannot
   * succeed. It returns a distinct status rather than `true`: the webhook route
   * decides what to do with an unverifiable event, and in demo mode it accepts
   * it while recording that it was unverified. Nothing here ever claims a
   * signature was checked.
   */
  async verifyWebhookSignature(
    _headers: Record<string, string | string[] | undefined>,
    _rawBody: string,
  ): Promise<WebhookVerification> {
    return { verified: false, status: 'DEMO_MODE_NOT_VERIFIED' };
  }
}

export function disputeIdFromUrl(url: string): string | null {
  const m = /\/v1\/customer\/disputes\/([^/?]+)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export function relFromUrl(url: string): string | null {
  const m = /\/v1\/customer\/disputes\/[^/?]+\/([^/?]+)/.exec(url);
  return m?.[1] ?? null;
}
