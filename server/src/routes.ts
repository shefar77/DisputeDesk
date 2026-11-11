/** Internal REST API (PRD §17). */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DRAFT_MAX_LENGTH,
  FILE_LIMITS,
  approveRequestSchema,
  previewRequestSchema,
  saveDraftSchema,
  type HealthResponse,
} from '@shared/index.js';
import { problem } from './app.js';
import { getDb, getDriver, schema } from './db/client.js';
import { env } from './env.js';
import { getDeterministic, getLlm, initLlm, setLlm } from './llm/index.js';
import { budgetStatus } from './llm/budget.js';
import { getDemoGateway, getPayPal } from './paypal/index.js';
import { sha256 } from './paypal/payload.js';
import { elasticStatus, esqlQuery } from './retrieval/index.js';
import { kernelConfigured } from './capture/carrier.js';
import { approveAndSubmit, preview } from './services/approval.js';
import { getDisputeDetail, getDisputeRow, latestDraftRow, listDisputes } from './services/disputes.js';
import { addTimeline, audit, getEvidenceRow, listAudit, upsertEvidence } from './services/records.js';
import { handleWebhook, lastPollStatus, pollDisputes } from './services/sync.js';
import { gatherEvidence } from './workflow/gatherEvidence.js';
import { resetDemoData } from './boot.js';
import { isRunning } from './workflow/engine.js';

/** Magic-byte check: the declared type must match what the bytes actually are. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  const tiff = buf.subarray(0, 4).toString('hex');
  if (tiff === '49492a00' || tiff === '4d4d002a') return 'image/tiff';
  return null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- webhooks ----------------------------------------------------------------
  app.post('/webhooks/paypal', async (req, reply) => {
    const out = await handleWebhook(req.headers, req.rawBody ?? '');
    return reply.status(out.status).send(out.body);
  });

  // --- health ------------------------------------------------------------------
  app.get('/api/health', async (): Promise<HealthResponse & Record<string, unknown>> => {
    const pp = getPayPal().describe();
    const es = elasticStatus();
    const llm = getLlm();
    const budget = await budgetStatus();
    return {
      ok: true,
      mode: env.mode,
      version: env.version,
      demoReason: env.demoReason,
      dependencies: [
        { name: pp.name, status: 'ok', detail: pp.detail, fallback: null },
        {
          name: 'Database',
          status: 'ok',
          detail: getDriver() === 'pglite' ? 'Embedded PGlite (Postgres in WASM)' : 'PostgreSQL',
          fallback: null,
        },
        {
          name: 'Elastic retrieval',
          status: es.healthy ? 'ok' : es.configured ? 'degraded' : 'disabled',
          detail: es.detail,
          fallback: es.healthy ? null : 'Postgres full-text search',
        },
        {
          name: 'KERNEL carrier capture',
          status: getDemoGateway() ? 'disabled' : kernelConfigured() ? 'ok' : 'disabled',
          detail: getDemoGateway()
            ? 'Demo environment uses sample carrier pages'
            : kernelConfigured()
              ? 'Cloud browser enabled'
              : 'KERNEL_API_KEY not set',
          fallback: 'PayPal shipment data, or a merchant upload',
        },
        {
          name: 'LLM',
          status: llm.enabled ? 'ok' : 'disabled',
          detail: llm.enabled ? `${llm.name} ${llm.model}` : 'GEMINI_API_KEY not set',
          fallback: llm.enabled ? 'Rule-based generator on failure' : 'Rule-based generator',
        },
        {
          name: 'Webhooks',
          status: env.paypal.webhookId ? 'ok' : 'disabled',
          detail: env.paypal.webhookId
            ? 'Signature verification via PayPal'
            : 'PAYPAL_WEBHOOK_ID not set — relying on polling',
          fallback: `Polling every ${env.paypal.pollIntervalMinutes} min`,
        },
        { name: 'Zapier order records', status: 'disabled', detail: 'Planned · not included in this build', fallback: 'Sample data or merchant upload' },
      ],
      llm: { provider: llm.name, model: llm.model, spentUsd: budget.spentUsd, capUsd: budget.capUsd, enabled: llm.enabled },
      lastPoll: lastPollStatus(),
    };
  });

  // --- queue -------------------------------------------------------------------
  app.get('/api/disputes', async () => ({ items: await listDisputes(), mode: env.mode }));

  app.get<{ Params: { id: string } }>('/api/disputes/:id', async (req, reply) => {
    const detail = await getDisputeDetail(req.params.id);
    if (!detail) return problem(reply, 404, 'not-found', 'Dispute not found');
    return { ...detail, running: isRunning(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/disputes/:id/refresh', async (req, reply) => {
    const row = await getDisputeRow(req.params.id);
    if (!row) return problem(reply, 404, 'not-found', 'Dispute not found');
    await audit('dispute.refresh_requested', {}, { disputeId: req.params.id, actor: env.operator });
    void gatherEvidence(req.params.id, env.operator);
    return reply.status(202).send({ started: true });
  });

  app.post('/api/disputes/poll', async () => pollDisputes());

  // Render cron (render.yaml) -> reconcile with PayPal. Secret-gated; no session.
  app.post('/api/cron/poll', async (req, reply) => {
    const secret = env.cronSecret;
    const given = req.headers['x-cron-secret'];
    if (!secret || given !== secret) return problem(reply, 401, 'unauthenticated', 'Invalid cron secret');
    return pollDisputes();
  });

  // --- uploads -----------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/disputes/:id/evidence', async (req, reply) => {
    const id = req.params.id;
    if (!(await getDisputeRow(id))) return problem(reply, 404, 'not-found', 'Dispute not found');
    const file = await req.file();
    if (!file) return problem(reply, 400, 'no-file', 'No file uploaded');

    const ext = extname(file.filename).toLowerCase();
    if (!(FILE_LIMITS.allowedExtensions as readonly string[]).includes(ext)) {
      return problem(reply, 415, 'file-type', `File type ${ext || '(none)'} is not accepted`, `Allowed: ${FILE_LIMITS.allowedExtensions.join(', ')}`);
    }
    const buf = await file.toBuffer();
    if (file.file.truncated || buf.byteLength > FILE_LIMITS.maxBytesPerFile) {
      return problem(reply, 413, 'file-size', 'File is larger than 10 MB');
    }
    const sniffed = sniffMime(buf);
    if (!sniffed || !(FILE_LIMITS.allowedMimeTypes as readonly string[]).includes(sniffed)) {
      return problem(reply, 415, 'file-content', 'File contents do not match an accepted document type');
    }

    // Random name on disk (PRD §18); the original name is kept only as a label.
    mkdirSync(env.storage.uploadsDir, { recursive: true });
    const stored = join(env.storage.uploadsDir, `${randomBytes(12).toString('hex')}${ext}`);
    writeFileSync(stored, buf);
    const label = (file.fields.label as { value?: string } | undefined)?.value?.slice(0, 120) || 'Merchant upload';
    const item = await upsertEvidence({
      disputeId: id,
      kind: 'upload',
      source: 'upload',
      label: `${label} (${file.filename.replace(/[^\w.\- ]/g, '').slice(0, 60)})`,
      sourceRef: 'Uploaded by merchant',
      contentText: null,
      filePath: stored,
      mimeType: sniffed,
      bytes: buf.byteLength,
      fileSha256: sha256(buf),
    });
    await audit('evidence.uploaded', { evidenceId: item.id, bytes: buf.byteLength, mime: sniffed }, { disputeId: id, actor: env.operator });
    await addTimeline(id, 'note', `Uploaded ${item.id}`, item.label);
    // Re-score with the new document (J2: "score rises").
    void gatherEvidence(id, env.operator);
    return reply.status(201).send(item);
  });

  app.get<{ Params: { id: string; eid: string } }>('/api/disputes/:id/evidence/:eid/file', async (req, reply) => {
    const row = await getEvidenceRow(req.params.id, req.params.eid);
    if (!row?.filePath || !row.mimeType) return problem(reply, 404, 'not-found', 'No file for this evidence item');
    try {
      const buf = readFileSync(row.filePath);
      return reply
        .type(row.mimeType)
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .send(buf);
    } catch {
      return problem(reply, 404, 'not-found', 'File is no longer available');
    }
  });

  // --- draft -------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/disputes/:id/draft', async (req, reply) => {
    const parsed = saveDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-draft', `Draft must be 1–${DRAFT_MAX_LENGTH} characters`);
    }
    const draft = await latestDraftRow(req.params.id);
    if (!draft) return problem(reply, 404, 'no-draft', 'No draft to edit yet');
    await getDb().update(schema.drafts).set({ editedText: parsed.data.edited_text }).where(eq(schema.drafts.id, draft.id));
    await audit('draft.edited', { draftId: draft.id, length: parsed.data.edited_text.length }, { disputeId: req.params.id, actor: env.operator });
    return { ok: true };
  });

  // --- approval gate -----------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/disputes/:id/preview', async (req, reply) => {
    const parsed = previewRequestSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, 400, 'invalid-request', 'Invalid preview request');
    return preview(req.params.id, parsed.data);
  });

  app.post<{ Params: { id: string } }>('/api/disputes/:id/approve', async (req, reply) => {
    const parsed = approveRequestSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, 400, 'invalid-request', 'Approval must include the action and payload_sha256');
    const result = await approveAndSubmit(req.params.id, parsed.data, env.operator);
    return reply.status(result.ok ? 200 : 502).send(result);
  });

  // --- audit -------------------------------------------------------------------
  app.get<{ Querystring: { disputeId?: string; download?: string } }>('/api/audit', async (req, reply) => {
    const entries = await listAudit({ disputeId: req.query.disputeId, limit: 2000 });
    if (req.query.download) {
      reply.header('Content-Disposition', `attachment; filename="disputedesk-audit-${new Date().toISOString().slice(0, 10)}.json"`);
    }
    return { exportedAt: new Date().toISOString(), mode: env.mode, count: entries.length, entries };
  });

  // --- analytics (FR-16) -------------------------------------------------------
  app.get('/api/analytics', async () => {
    const db = getDb();
    const byStatus = await db
      .select({ status: schema.disputes.status, n: sql<number>`count(*)::int` })
      .from(schema.disputes)
      .groupBy(schema.disputes.status);
    const byBand = await db
      .select({ band: schema.plans.band, n: sql<number>`count(distinct ${schema.plans.disputeId})::int` })
      .from(schema.plans)
      .groupBy(schema.plans.band);
    const submissions = await db
      .select({ result: schema.approvals.resultStatus, n: sql<number>`count(*)::int` })
      .from(schema.approvals)
      .groupBy(schema.approvals.resultStatus);
    const ai = await db
      .select({
        calls: sql<number>`count(*)::int`,
        cost: sql<string>`coalesce(sum(${schema.llmUsage.costUsd}),0)`,
      })
      .from(schema.llmUsage);
    const esql = await esqlQuery('FROM disputedesk-disputes | STATS n = COUNT(*) BY outcome | SORT n DESC');
    return {
      byStatus,
      byBand,
      submissions,
      ai: { calls: ai[0]?.calls ?? 0, costUsd: Number(ai[0]?.cost ?? 0) },
      esql: esql ?? { unavailable: 'Elastic not configured — ES|QL analytics disabled' },
    };
  });

  // --- demo-only helpers --------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { outcome?: string } }>('/api/demo/disputes/:id/resolve', async (req, reply) => {
    const demo = getDemoGateway();
    if (!demo) return problem(reply, 404, 'not-found', 'Only available in demo mode');
    const outcome = req.body?.outcome === 'buyer' ? 'RESOLVED_BUYER_FAVOUR' : 'RESOLVED_SELLER_FAVOUR';
    demo.simulateResolution(req.params.id, outcome);
    const event = {
      id: `WH-DEMO-${randomBytes(6).toString('hex')}`,
      event_type: 'CUSTOMER.DISPUTE.RESOLVED',
      resource_type: 'dispute',
      summary: 'Demo simulation of a PayPal resolution webhook',
      create_time: new Date().toISOString(),
      resource: { dispute_id: req.params.id },
    };
    const out = await handleWebhook({}, JSON.stringify(event), { simulated: true });
    return reply.status(out.status).send({ ...out.body, simulated: true, outcome });
  });

  app.post('/api/demo/reset', async (_req, reply) => {
    const demo = getDemoGateway();
    if (!demo) return problem(reply, 404, 'not-found', 'Only available in demo mode');
    demo.reset();
    await resetDemoData();
    await audit('demo.reset', {}, { actor: env.operator });
    // Refill with the *rule-based* generator, exactly as boot does. Running the
    // model here instead meant one evidence workflow per fixture before this
    // request could answer: minutes of latency on a free tier, a request that
    // times out long before it finishes, a queue left half-gathered, and a
    // visitor able to spend the daily model budget with one button. The model
    // is what runs when a human asks for it on a single dispute — "Re-gather".
    setLlm(getDeterministic());
    try {
      await pollDisputes({ gatherNew: true });
    } finally {
      setLlm(null);
      initLlm();
    }
    return { ok: true };
  });

  app.get('/api/webhook-events', async () => {
    const rows = await getDb().select().from(schema.webhookEvents).orderBy(desc(schema.webhookEvents.receivedAt)).limit(100);
    return rows.map((r) => ({
      eventId: r.eventId,
      type: r.type,
      receivedAt: r.receivedAt.toISOString(),
      verified: r.verified,
      verificationStatus: r.verificationStatus,
      processedAt: r.processedAt?.toISOString() ?? null,
      disputeId: r.disputeId,
    }));
  });
}
