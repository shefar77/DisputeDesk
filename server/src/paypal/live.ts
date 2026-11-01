/**
 * Live PayPal sandbox client.
 *
 * Rules enforced here:
 *  - credentials never leave this module and never appear in a log line;
 *  - reads retry with backoff on 429/5xx, writes never auto-retry (PRD §19) —
 *    provide-evidence is not idempotent, so a blind retry risks a double submit;
 *  - `debug_id` is captured from every error so a failure is reportable to PayPal
 *    without us logging tokens.
 */

import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../log.js';
import type { ListDisputesOptions, OutboundFile, PayPalGateway } from './gateway.js';
import { PayPalError } from './gateway.js';
import type {
  RawDispute,
  RawDisputeList,
  ShipmentTracking,
  WebhookVerification,
  WriteResult,
} from './types.js';
import type { OutboundRequest } from '@shared/index.js';

interface TokenCache {
  token: string;
  expiresAt: number;
}

const READ_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class LivePayPal implements PayPalGateway {
  readonly mode = 'sandbox' as const;
  private token: TokenCache | null = null;
  private inflightToken: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly baseUrl: string,
  ) {}

  describe() {
    return { name: 'PayPal Disputes API', detail: `${this.baseUrl} (sandbox)` };
  }

  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.token;
    // Collapse concurrent refreshes — the evidence workflow fans out several calls.
    if (this.inflightToken) return this.inflightToken;

    this.inflightToken = (async () => {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const text = await res.text();
      if (!res.ok) {
        // Deliberately does not include the response body: it can echo the client id.
        throw new PayPalError(
          `PayPal OAuth failed with ${res.status}`,
          res.status,
          res.headers.get('paypal-debug-id'),
          null,
        );
      }
      const json = JSON.parse(text) as { access_token: string; expires_in: number };
      this.token = {
        token: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      };
      return json.access_token;
    })().finally(() => {
      this.inflightToken = null;
    });

    return this.inflightToken;
  }

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    url: string,
    init: { body?: string | Uint8Array; contentType?: string; retry: boolean },
  ): Promise<{ status: number; debugId: string | null; json: unknown; text: string }> {
    const absolute = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const attempts = init.retry ? 4 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let token = await this.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'PayPal-Request-Id': randomUUID(),
      };
      if (init.contentType) headers['Content-Type'] = init.contentType;

      let res: Response;
      try {
        res = await fetch(absolute, { method, headers, body: init.body });
      } catch (err) {
        lastError = err;
        if (attempt === attempts) break;
        await sleep(backoffMs(attempt));
        continue;
      }

      const debugId = res.headers.get('paypal-debug-id');
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      // A 401 on a cached token: refresh once, then surface it (PRD §19).
      if (res.status === 401 && attempt === 1) {
        this.token = null;
        token = await this.accessToken();
        continue;
      }

      if (init.retry && READ_RETRY_STATUSES.has(res.status) && attempt < attempts) {
        logger.warn(
          { status: res.status, debugId, attempt, url: redactUrl(absolute) },
          'PayPal read failed, backing off',
        );
        await sleep(backoffMs(attempt));
        continue;
      }

      return { status: res.status, debugId, json, text };
    }

    throw new PayPalError(
      `PayPal request failed: ${lastError instanceof Error ? lastError.message : 'network error'}`,
      0,
      null,
      null,
    );
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.request('GET', url, { retry: true });
    if (res.status < 200 || res.status >= 300) {
      throw new PayPalError(
        `PayPal GET ${redactUrl(url)} returned ${res.status}`,
        res.status,
        res.debugId,
        res.json,
      );
    }
    return res.json as T;
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async listDisputes(options: ListDisputesOptions = {}): Promise<RawDispute[]> {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 10;
    const params = new URLSearchParams({ page_size: String(pageSize) });
    if (options.disputeState) params.set('dispute_state', options.disputeState);
    if (options.updateTimeAfter) params.set('update_time_after', options.updateTimeAfter);

    let url = `/v1/customer/disputes?${params.toString()}`;
    const all: RawDispute[] = [];

    for (let page = 0; page < maxPages; page++) {
      const body = await this.get<RawDisputeList>(url);
      all.push(...(body.items ?? []));
      const next = body.links?.find((l) => l.rel === 'next')?.href;
      if (!next) break;
      url = next;
    }
    return all;
  }

  async getDispute(disputeId: string): Promise<RawDispute> {
    return this.get<RawDispute>(`/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
  }

  async getShipmentTracking(transactionId: string): Promise<ShipmentTracking | null> {
    // Shipment Tracking is a separate product; its availability for a given sandbox
    // app was flagged [U] in the PRD, so a 4xx here is "not available", not an error.
    try {
      const res = await this.get<{ trackers?: ShipmentTracking[] }>(
        `/v1/shipping/trackers?transaction_id=${encodeURIComponent(transactionId)}`,
      );
      return res.trackers?.[0] ?? null;
    } catch (err) {
      if (err instanceof PayPalError && err.httpStatus >= 400 && err.httpStatus < 500) {
        logger.info(
          { status: err.httpStatus },
          'Shipment Tracking unavailable for this transaction; continuing without it',
        );
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  async execute(request: OutboundRequest, files: OutboundFile[]): Promise<WriteResult> {
    let body: string | Uint8Array;
    let contentType: string;

    if (files.length > 0) {
      const built = buildMultipartRelated(request.body, files);
      body = built.body;
      contentType = built.contentType;
    } else {
      body = JSON.stringify(request.body);
      contentType = 'application/json';
    }

    // retry:false is the whole point — these calls are not idempotent.
    const res = await this.request(request.method, request.url, { body, contentType, retry: false });
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      debugId: res.debugId,
      body: (res.json as Record<string, unknown> | null) ?? null,
      error: ok ? null : extractPayPalError(res.json, res.text, res.status),
      simulated: false,
    };
  }

  // -------------------------------------------------------------------------
  // webhooks
  // -------------------------------------------------------------------------

  /**
   * FR-1: verification happens through PayPal's own endpoint, against the raw
   * request bytes. We pass `webhook_event` as a parsed object because PayPal's
   * verify endpoint expects JSON, but the string we parse is the untouched body.
   */
  async verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<WebhookVerification> {
    if (!env.paypal.webhookId) {
      return { verified: false, status: 'NO_WEBHOOK_ID_CONFIGURED' };
    }
    const header = (name: string): string => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    };

    const required = {
      auth_algo: header('paypal-auth-algo'),
      cert_url: header('paypal-cert-url'),
      transmission_id: header('paypal-transmission-id'),
      transmission_sig: header('paypal-transmission-sig'),
      transmission_time: header('paypal-transmission-time'),
    };
    for (const [key, value] of Object.entries(required)) {
      if (!value) return { verified: false, status: `MISSING_HEADER_${key.toUpperCase()}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { verified: false, status: 'BODY_NOT_JSON' };
    }

    const res = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      body: JSON.stringify({ ...required, webhook_id: env.paypal.webhookId, webhook_event: parsed }),
      contentType: 'application/json',
      retry: true,
    });

    if (res.status < 200 || res.status >= 300) {
      return { verified: false, status: `VERIFY_HTTP_${res.status}` };
    }
    const status = (res.json as { verification_status?: string } | null)?.verification_status ?? 'UNKNOWN';
    return { verified: status === 'SUCCESS', status };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1s, with jitter so parallel workflow steps don't resonate.
  return Math.round(250 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips query strings from a URL before it reaches a log line. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

export function extractPayPalError(json: unknown, text: string, status: number): string {
  if (json && typeof json === 'object') {
    const o = json as {
      name?: string;
      message?: string;
      details?: { issue?: string; description?: string }[];
    };
    const parts: string[] = [];
    if (o.name) parts.push(o.name);
    if (o.message) parts.push(o.message);
    for (const d of o.details ?? []) {
      parts.push([d.issue, d.description].filter(Boolean).join(': '));
    }
    if (parts.length > 0) return parts.join(' — ');
  }
  return text.slice(0, 400) || `HTTP ${status}`;
}

/**
 * `multipart/related` with a JSON `input` part followed by one part per file.
 * This is PayPal's documented form for evidence-with-documents; `fetch`'s FormData
 * would produce `multipart/form-data` with a different part layout, so the body is
 * assembled by hand.
 */
export function buildMultipartRelated(
  json: unknown,
  files: OutboundFile[],
): { body: Buffer; contentType: string } {
  const boundary = `----disputedesk${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  const push = (s: string): void => void chunks.push(Buffer.from(s, 'utf8'));

  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="input"\r\n');
  push('Content-Type: application/json\r\n\r\n');
  push(`${JSON.stringify(json)}\r\n`);

  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`,
    );
    push(`Content-Type: ${file.mimeType}\r\n\r\n`);
    chunks.push(file.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  return { body: Buffer.concat(chunks), contentType: `multipart/related; boundary=${boundary}` };
}
