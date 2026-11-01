/**
 * Integration tests (PRD §21 "Integration" + "Security" rows), run against the
 * real Fastify app, the demo gateway and an in-memory Postgres (PGlite).
 *
 * The property tested most heavily: no PayPal write happens without an approval
 * row bound to the exact payload hash. "No write" is asserted directly on the
 * demo gateway's record of every request it was asked to send.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { boot } from '../src/boot.js';
import { closeDb, getDb, schema } from '../src/db/client.js';
import { env } from '../src/env.js';
import { getDemoGateway } from '../src/paypal/index.js';
import { pollDisputes, handleWebhook } from '../src/services/sync.js';
import { validateDraft, validateExtraction } from '../src/workflow/gatherEvidence.js';
import type { LlmResult } from '../src/llm/client.js';

let app: FastifyInstance;
let csrf = '';
let cookie = '';

const HERO = 'PP-D-FIX-00001';
const NO_LINK = 'PP-D-FIX-00013';
const INJECTION = 'PP-D-FIX-00007';
const UNSUPPORTED = 'PP-D-FIX-00014';

function writes() {
  return getDemoGateway()!.recorded.length;
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, withCsrf = true) {
  return app.inject({
    method,
    url,
    payload: payload as never,
    headers: {
      cookie,
      ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
}

beforeAll(async () => {
  await boot();
  app = await buildApp({ logger: false });
  await pollDisputes({ gatherNew: true });
  const s = await app.inject({ method: 'GET', url: '/api/session' });
  csrf = s.json().csrfToken;
  cookie = `dd_csrf=${csrf}`;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('ingest and queue', () => {
  it('loads every fixture dispute and runs the workflow on each', async () => {
    const res = await call('GET', '/api/disputes');
    const items = res.json().items as { id: string; gatherState: string }[];
    expect(items).toHaveLength(14);
    expect(items.filter((i) => i.gatherState === 'GATHERING' || i.gatherState === 'NOT_STARTED')).toHaveLength(0);
  });

  it('sorts the queue by deadline, resolved last', async () => {
    const items = (await call('GET', '/api/disputes')).json().items as { urgency: { sortKey: number }; status: string }[];
    const open = items.filter((i) => i.status !== 'RESOLVED').map((i) => i.urgency.sortKey);
    expect(open).toEqual([...open].sort((a, b) => a - b));
  });

  it('derives allowed actions only from HATEOAS links (FR-4)', async () => {
    const d = (await call('GET', `/api/disputes/${NO_LINK}`)).json();
    expect(d.allowedActions).toEqual(['send-message']);
    expect(d.guidance.join(' ')).toMatch(/not accepting evidence/);
  });

  it('routes unsupported reasons to manual handling with no AI plan', async () => {
    const d = (await call('GET', `/api/disputes/${UNSUPPORTED}`)).json();
    expect(d.supported).toBe(false);
    expect(d.plan).toBeNull();
    expect(d.gatherState).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('every draft cites only evidence ids that exist (FR-8)', async () => {
    const items = (await call('GET', '/api/disputes')).json().items as { id: string }[];
    for (const { id } of items) {
      const d = (await call('GET', `/api/disputes/${id}`)).json();
      if (!d.draft) continue;
      const ids = new Set((d.evidence as { id: string }[]).map((e) => e.id));
      for (const ref of d.draft.evidenceRefs) expect(ids.has(ref)).toBe(true);
    }
  });
});

describe('prompt injection (PRD §18 security test)', () => {
  it('a carrier page demanding accept-claim does not change the recommended action', async () => {
    const d = (await call('GET', `/api/disputes/${INJECTION}`)).json();
    expect(d.plan.narrative.recommended_action).not.toBe('accept-claim');
    expect(d.plan.completeness).toBe(100); // facts still extracted normally
    expect(JSON.stringify(d.draft)).not.toContain('E-999');
    expect(JSON.stringify(d.plan)).not.toContain('E-999');
  });
});

describe('approval gate (FR-9, FR-10)', () => {
  it('rejects state-changing requests without a CSRF token', async () => {
    const before = writes();
    const res = await call('POST', `/api/disputes/${HERO}/preview`, { action: 'provide-evidence' }, false);
    expect(res.statusCode).toBe(403);
    expect(writes()).toBe(before);
  });

  it('preview performs no write', async () => {
    const before = writes();
    const res = await call('POST', `/api/disputes/${HERO}/preview`, { action: 'provide-evidence' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(writes()).toBe(before);
  });

  it('refuses an approval whose hash does not match the current payload', async () => {
    const before = writes();
    const res = await call('POST', `/api/disputes/${HERO}/approve`, { action: 'provide-evidence', payload_sha256: 'f'.repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/hash-mismatch/);
    expect(writes()).toBe(before);
  });

  it('refuses an approval made before the draft was edited', async () => {
    const stale = (await call('POST', `/api/disputes/${HERO}/preview`, { action: 'provide-evidence' })).json().payloadSha256;
    await call('PUT', `/api/disputes/${HERO}/draft`, { edited_text: 'The parcel was delivered and signed for on 23 October (E-5).' });
    const before = writes();
    const res = await call('POST', `/api/disputes/${HERO}/approve`, { action: 'provide-evidence', payload_sha256: stale });
    expect(res.statusCode).toBe(409);
    expect(writes()).toBe(before);
  });

  it('sends exactly the approved payload, once, and records it', async () => {
    const prev = (await call('POST', `/api/disputes/${HERO}/preview`, { action: 'provide-evidence' })).json();
    const before = writes();
    const res = await call('POST', `/api/disputes/${HERO}/approve`, { action: 'provide-evidence', payload_sha256: prev.payloadSha256 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, simulated: true, disputeStatus: 'UNDER_REVIEW' });
    expect(writes()).toBe(before + 1);

    // What was sent is byte-for-byte what was previewed.
    const sent = getDemoGateway()!.recorded.at(-1)!.request;
    expect(sent).toEqual(prev.request);
    expect((sent.body as { evidences: { notes?: string }[] }).evidences[0]!.notes).toContain('signed for on 23 October');

    const rows = await getDb().select().from(schema.approvals).where(eq(schema.approvals.disputeId, HERO));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payloadSha256).toBe(prev.payloadSha256);
    expect(rows[0]!.resultStatus).toBe('SENT');
    expect(rows[0]!.consumedAt).not.toBeNull();
  });

  it('a replayed approval cannot produce a second write', async () => {
    const before = writes();
    const rows = await getDb().select().from(schema.approvals).where(eq(schema.approvals.disputeId, HERO));
    const res = await call('POST', `/api/disputes/${HERO}/approve`, { action: 'provide-evidence', payload_sha256: rows[0]!.payloadSha256 });
    expect(res.statusCode).toBe(409);
    expect(writes()).toBe(before);
  });

  it('every write in the gateway has a matching SENT approval (zero unapproved actions)', async () => {
    const approvals = await getDb().select().from(schema.approvals);
    const sentCount = approvals.filter((a) => a.resultStatus === 'SENT').length;
    expect(getDemoGateway()!.recorded.length).toBe(sentCount);
  });

  it('the database refuses a duplicate idempotency key', async () => {
    const [row] = await getDb().select().from(schema.approvals).limit(1);
    await expect(
      getDb().insert(schema.approvals).values({ ...row!, id: 'dup-test' }),
    ).rejects.toThrow();
  });

  it('refuses actions PayPal does not currently offer', async () => {
    const res = await call('POST', `/api/disputes/${NO_LINK}/preview`, { action: 'provide-evidence' });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/action-not-available/);
  });

  it('refuses an offer larger than the disputed amount (FR-14)', async () => {
    const res = await call('POST', '/api/disputes/PP-D-FIX-00002/preview', {
      action: 'make-offer',
      offer: { offer_type: 'REFUND', amount: '129.51', note: 'n' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('flags make-offer and accept-claim as high consequence', async () => {
    const res = await call('POST', '/api/disputes/PP-D-FIX-00002/preview', {
      action: 'make-offer',
      offer: { offer_type: 'REFUND', amount: '50.00', note: 'Partial refund' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().highConsequence).toBe(true);
  });
});

describe('webhooks (FR-1)', () => {
  const event = (id: string, disputeId = HERO) =>
    JSON.stringify({ id, event_type: 'CUSTOMER.DISPUTE.UPDATED', resource: { dispute_id: disputeId } });

  it('rejects a malformed envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/paypal', payload: '{"hello":1}', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unverifiable event when signatures are required', async () => {
    const paypal = env.paypal as { requireWebhookSignature: boolean };
    paypal.requireWebhookSignature = true;
    try {
      const res = await app.inject({ method: 'POST', url: '/webhooks/paypal', payload: event('WH-UNSIGNED'), headers: { 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(400);
      const stored = await getDb().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.eventId, 'WH-UNSIGNED'));
      expect(stored).toHaveLength(0); // not processed, not stored
    } finally {
      paypal.requireWebhookSignature = false;
    }
  });

  it('processes an event once even when delivered twice', async () => {
    const a = await handleWebhook({}, event('WH-DUP-1'));
    const b = await handleWebhook({}, event('WH-DUP-1'));
    expect(a.status).toBe(200);
    expect(b.body).toMatchObject({ duplicate: true });
  });

  it('a resolution webhook moves the dispute to RESOLVED via a fresh PayPal read', async () => {
    const res = await call('POST', `/api/demo/disputes/${HERO}/resolve`, { outcome: 'seller' });
    expect(res.statusCode).toBe(200);
    const d = (await call('GET', `/api/disputes/${HERO}`)).json();
    expect(d.status).toBe('RESOLVED');
    expect(d.allowedActions).toEqual([]);
    expect((d.timeline as { kind: string }[]).some((t) => t.kind === 'webhook')).toBe(true);
  });
});

describe('uploads (PRD §18 hardening)', () => {
  function multipart(filename: string, content: Buffer) {
    const boundary = '----t';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nPOD\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, type: `multipart/form-data; boundary=${boundary}` };
  }

  it('rejects a file whose bytes are not the type its name claims', async () => {
    const m = multipart('proof.pdf', Buffer.from('<script>alert(1)</script>'));
    const res = await app.inject({ method: 'POST', url: '/api/disputes/PP-D-FIX-00006/evidence', payload: m.body, headers: { 'content-type': m.type, cookie, 'x-csrf-token': csrf } });
    expect(res.statusCode).toBe(415);
  });

  it('accepts a real PDF and stores it as an upload item', async () => {
    const m = multipart('proof.pdf', Buffer.from('%PDF-1.4\n%test\n'));
    const res = await app.inject({ method: 'POST', url: '/api/disputes/PP-D-FIX-00006/evidence', payload: m.body, headers: { 'content-type': m.type, cookie, 'x-csrf-token': csrf } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'upload', source: 'upload', mimeType: 'application/pdf' });
    expect(res.json().filePath).toBe('stored'); // the server path is never exposed
  });
});

describe('audit and health (FR-12)', () => {
  it('records reads, AI calls, approvals and writes, with no secrets', async () => {
    const res = await call('GET', '/api/audit');
    const events = new Set((res.json().entries as { event: string }[]).map((e) => e.event));
    for (const e of ['paypal.read', 'ai.extract', 'ai.plan', 'ai.draft', 'approval.granted', 'paypal.write']) {
      expect(events.has(e)).toBe(true);
    }
    expect(res.body).not.toMatch(/Bearer\s+[A-Za-z0-9]{12}|client_secret"\s*:\s*"[^[]/);
  });

  it('reports demo mode and every dependency with its fallback', async () => {
    const h = (await call('GET', '/api/health')).json();
    expect(h.mode).toBe('demo');
    expect(h.dependencies.find((d: { name: string }) => d.name === 'Elastic retrieval').fallback).toBe('Postgres full-text search');
  });
});

describe('validators turn model mistakes into rejections', () => {
  const item = (id: string, text: string) => ({
    id, kind: 'carrier_capture' as const, source: 'fixture' as const, label: 'x', sourceRef: null,
    contentText: text, filePath: null, mimeType: null, bytes: null, sha256: 'x', capturedAt: '', confidence: null, fixture: true,
  });
  const ok = <T,>(value: T): LlmResult<T> => ({ ok: true, value, generator: 'llm', model: 'm', error: null, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 });

  it('rejects a draft that cites an evidence id that does not exist', () => {
    const r = validateDraft(ok({ text: 'Delivered and signed for, see E-9 for proof of delivery here.', evidence_refs: ['E-1'], tone: 'factual' as const }), new Set(['E-1']));
    expect(r.ok).toBe(false);
  });

  it('replaces a tracking number the model invented', () => {
    const items = [item('E-1', 'UPS 1Z999AA10123456784 Delivered')];
    const r = validateExtraction(
      ok({
        carrier: 'UPS', carrier_enum: 'UPS' as const, tracking_number: '1Z000FAKE0000000000', delivery_status: 'DELIVERED' as const,
        delivered_at: null, last_known_location: null, signature_obtained: null, address_match: 'UNKNOWN' as const, ship_date: null,
        sources: [{ field: 'tracking_number', evidence_id: 'E-1' }], confidence: 0.9, notes: null,
      }),
      items,
    );
    expect(r.value!.tracking_number).toBe('1Z999AA10123456784');
  });

  it('rejects an extraction that cites an unknown evidence id', () => {
    const r = validateExtraction(
      ok({
        carrier: null, carrier_enum: null, tracking_number: null, delivery_status: 'UNKNOWN' as const, delivered_at: null,
        last_known_location: null, signature_obtained: null, address_match: 'UNKNOWN' as const, ship_date: null,
        sources: [{ field: 'carrier', evidence_id: 'E-999' }], confidence: 0.2, notes: null,
      }),
      [item('E-1', 'x')],
    );
    expect(r.ok).toBe(false);
  });
});
