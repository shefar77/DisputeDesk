/** Audit log (FR-12), timeline, and evidence-item persistence. */

import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { EvidenceItemView, EvidenceKind, EvidenceSource, TimelineEntry } from '@shared/index.js';
import { getDb, schema } from '../db/client.js';
import { redact } from '../log.js';
import { sha256 } from '../paypal/payload.js';

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export async function audit(
  event: string,
  detail: Record<string, unknown> = {},
  opts: { actor?: string; disputeId?: string | null } = {},
): Promise<void> {
  await getDb()
    .insert(schema.auditLog)
    .values({
      id: nanoid(),
      actor: opts.actor ?? 'system',
      event,
      disputeId: opts.disputeId ?? null,
      // Redacted at write time, so the export endpoint can never leak a secret.
      detailJson: redact(detail) as Record<string, unknown>,
    });
}

export async function listAudit(opts: { disputeId?: string; limit?: number } = {}) {
  const db = getDb();
  const q = db.select().from(schema.auditLog);
  const rows = opts.disputeId
    ? await q.where(eq(schema.auditLog.disputeId, opts.disputeId)).orderBy(desc(schema.auditLog.ts)).limit(opts.limit ?? 500)
    : await q.orderBy(desc(schema.auditLog.ts)).limit(opts.limit ?? 500);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts.toISOString(),
    actor: r.actor,
    event: r.event,
    disputeId: r.disputeId,
    detail: r.detailJson,
  }));
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

export async function addTimeline(
  disputeId: string,
  kind: TimelineEntry['kind'],
  title: string,
  detail: string | null = null,
): Promise<void> {
  await getDb().insert(schema.timeline).values({ id: nanoid(), disputeId, kind, title, detail });
}

export async function listTimeline(disputeId: string): Promise<TimelineEntry[]> {
  const rows = await getDb()
    .select()
    .from(schema.timeline)
    .where(eq(schema.timeline.disputeId, disputeId))
    .orderBy(desc(schema.timeline.at));
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind as TimelineEntry['kind'],
    title: r.title,
    detail: r.detail,
  }));
}

// ---------------------------------------------------------------------------
// evidence items
// ---------------------------------------------------------------------------

export interface NewEvidence {
  disputeId: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  label: string;
  sourceRef?: string | null;
  contentText?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  bytes?: number | null;
  fileSha256?: string | null;
  confidence?: number | null;
  fixture?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Evidence ids are short and human-readable ("E-1", "E-2"…) because they appear
 * in drafts and in the approval preview, where a merchant has to match them by
 * eye. They are unique per dispute; the primary key is the composite string.
 *
 * Re-gathering replaces items of the same kind+source instead of piling up
 * duplicates, but keeps the id stable when the content hash is unchanged so a
 * saved draft's citations stay valid.
 */
export async function upsertEvidence(item: NewEvidence): Promise<EvidenceItemView> {
  const db = getDb();
  const content = item.contentText ?? '';
  const hash = item.fileSha256 ?? sha256(`${item.kind}\n${item.sourceRef ?? ''}\n${content}`);

  const existing = await db
    .select()
    .from(schema.evidenceItems)
    .where(
      and(
        eq(schema.evidenceItems.disputeId, item.disputeId),
        eq(schema.evidenceItems.kind, item.kind),
        eq(schema.evidenceItems.source, item.source),
      ),
    );

  // Uploads are additive — a merchant may attach several documents.
  const replaceable = item.kind === 'upload' ? undefined : existing[0];

  if (replaceable) {
    if (replaceable.sha256 !== hash) {
      await db
        .update(schema.evidenceItems)
        .set({
          label: item.label,
          sourceRef: item.sourceRef ?? null,
          contentText: item.contentText ?? null,
          filePath: item.filePath ?? null,
          mimeType: item.mimeType ?? null,
          bytes: item.bytes ?? null,
          sha256: hash,
          capturedAt: new Date(),
          confidence: item.confidence ?? null,
          fixture: item.fixture ?? false,
          metaJson: item.meta ?? null,
        })
        .where(eq(schema.evidenceItems.id, replaceable.id));
    }
    const [row] = await db.select().from(schema.evidenceItems).where(eq(schema.evidenceItems.id, replaceable.id));
    return toView(row!);
  }

  const all = await db
    .select({ id: schema.evidenceItems.id })
    .from(schema.evidenceItems)
    .where(eq(schema.evidenceItems.disputeId, item.disputeId));
  const nextN =
    all.reduce((max, r) => {
      const n = Number(/E-(\d+)$/.exec(r.id)?.[1] ?? 0);
      return Math.max(max, n);
    }, 0) + 1;
  const id = `${item.disputeId}:E-${nextN}`;

  await db.insert(schema.evidenceItems).values({
    id,
    disputeId: item.disputeId,
    kind: item.kind,
    source: item.source,
    label: item.label,
    sourceRef: item.sourceRef ?? null,
    contentText: item.contentText ?? null,
    filePath: item.filePath ?? null,
    mimeType: item.mimeType ?? null,
    bytes: item.bytes ?? null,
    sha256: hash,
    confidence: item.confidence ?? null,
    fixture: item.fixture ?? false,
    metaJson: item.meta ?? null,
  });
  const [row] = await db.select().from(schema.evidenceItems).where(eq(schema.evidenceItems.id, id));
  return toView(row!);
}

export async function listEvidence(disputeId: string): Promise<EvidenceItemView[]> {
  const rows = await getDb()
    .select()
    .from(schema.evidenceItems)
    .where(eq(schema.evidenceItems.disputeId, disputeId))
    .orderBy(schema.evidenceItems.capturedAt);
  return rows.map(toView).sort((a, b) => shortIdNum(a.id) - shortIdNum(b.id));
}

function shortIdNum(id: string): number {
  return Number(/E-(\d+)$/.exec(id)?.[1] ?? 0);
}

/** "PP-D-FIX-00001:E-2" -> "E-2". The display form used in drafts and the UI. */
export function shortEvidenceId(id: string): string {
  const m = /(E-\d+)$/.exec(id);
  return m ? m[1]! : id;
}

function toView(r: typeof schema.evidenceItems.$inferSelect): EvidenceItemView {
  return {
    id: shortEvidenceId(r.id),
    kind: r.kind as EvidenceKind,
    source: r.source as EvidenceSource,
    label: r.label,
    sourceRef: r.sourceRef,
    contentText: r.contentText,
    filePath: r.filePath ? 'stored' : null,
    mimeType: r.mimeType,
    bytes: r.bytes,
    sha256: r.sha256,
    capturedAt: r.capturedAt.toISOString(),
    confidence: r.confidence,
    fixture: r.fixture,
  };
}

/** Internal accessor that returns the real file path, for submission and download. */
export async function getEvidenceRow(disputeId: string, shortId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.evidenceItems)
    .where(eq(schema.evidenceItems.id, `${disputeId}:${shortId}`));
  return row ?? null;
}
