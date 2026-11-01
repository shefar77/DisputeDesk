/**
 * Postgres schema (PRD §16).
 *
 * The same DDL runs on embedded PGlite (no credentials, no Docker) and on Render
 * Postgres, because PGlite *is* Postgres compiled to WASM — same dialect, same
 * types, same constraints. That is what lets a judge run the whole thing with
 * `npm install && npm run dev` while production still uses managed Postgres.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const disputes = pgTable(
  'dispute',
  {
    /** PayPal `dispute_id` — the natural primary key. */
    id: text('id').primaryKey(),
    reason: text('reason').notNull(),
    stage: text('stage'),
    status: text('status').notNull(),
    amountValue: numeric('amount_value', { precision: 18, scale: 2 }),
    amountCurrency: text('amount_currency'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    linksJson: jsonb('links_json').$type<unknown[]>().notNull().default([]),
    rawJson: jsonb('raw_json').$type<Record<string, unknown>>().notNull(),
    gatherState: text('gather_state').notNull().default('NOT_STARTED'),
    /** True for seeded fixture disputes, so the UI can never pass one off as real. */
    fixture: boolean('fixture').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dispute_due_at_idx').on(t.dueAt), index('dispute_status_idx').on(t.status)],
);

export const evidenceItems = pgTable(
  'evidence_item',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    label: text('label').notNull(),
    sourceRef: text('source_ref'),
    contentText: text('content_text'),
    filePath: text('file_path'),
    mimeType: text('mime_type'),
    bytes: integer('bytes'),
    /** Content hash — makes every item tamper-evident and de-duplicable. */
    sha256: text('sha256').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    confidence: real('confidence'),
    fixture: boolean('fixture').notNull().default(false),
    metaJson: jsonb('meta_json').$type<Record<string, unknown>>(),
  },
  (t) => [index('evidence_dispute_idx').on(t.disputeId)],
);

export const plans = pgTable(
  'plan',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    json: jsonb('json').$type<Record<string, unknown>>().notNull(),
    completeness: integer('completeness').notNull(),
    band: text('band').notNull(),
    model: text('model').notNull(),
    generator: text('generator').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plan_dispute_idx').on(t.disputeId)],
);

export const drafts = pgTable(
  'draft',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    planId: text('plan_id'),
    text: text('text').notNull(),
    editedText: text('edited_text'),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    tone: text('tone').notNull().default('factual'),
    model: text('model').notNull(),
    generator: text('generator').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('draft_dispute_idx').on(t.disputeId)],
);

/**
 * The approval gate (FR-9).
 *
 * `payloadSha256` is the hash of the canonical outbound request. The submit
 * service re-hashes the request it is about to send and refuses unless an
 * unconsumed approval row matches exactly. `idempotencyKey` is UNIQUE, so a
 * double-submit of the same approval cannot produce two PayPal writes.
 */
export const approvals = pgTable(
  'approval',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    /** The canonical string, stored so a submission is reproducible after the fact. */
    canonical: text('canonical').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** PENDING -> SENT | FAILED | BLOCKED. Set before the call, updated after. */
    resultStatus: text('result_status').notNull().default('PENDING'),
    httpStatus: integer('http_status'),
    debugId: text('debug_id'),
    error: text('error'),
    responseJson: jsonb('response_json').$type<Record<string, unknown>>(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('approval_idempotency_key_uq').on(t.idempotencyKey),
    index('approval_dispute_idx').on(t.disputeId),
  ],
);

/** Webhook idempotency (FR-1): PayPal may deliver the same event id more than once. */
export const webhookEvents = pgTable('webhook_event', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  verified: boolean('verified').notNull().default(false),
  verificationStatus: text('verification_status'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  disputeId: text('dispute_id'),
  rawJson: jsonb('raw_json').$type<Record<string, unknown>>(),
});

export const workflowRuns = pgTable(
  'workflow_run',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('workflow_run_dispute_idx').on(t.disputeId)],
);

/** One row per step attempt — this is what the live "gathering evidence" panel reads. */
export const workflowSteps = pgTable(
  'workflow_step',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    disputeId: text('dispute_id').notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    detail: text('detail'),
    fallbackUsed: text('fallback_used'),
  },
  (t) => [index('workflow_step_run_idx').on(t.runId), index('workflow_step_dispute_idx').on(t.disputeId)],
);

export const timeline = pgTable(
  'timeline',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
  },
  (t) => [index('timeline_dispute_idx').on(t.disputeId)],
);

/** FR-12: every read, write and AI call. Secrets are redacted before insert. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    disputeId: text('dispute_id'),
    detailJson: jsonb('detail_json').$type<Record<string, unknown>>(),
  },
  (t) => [index('audit_ts_idx').on(t.ts)],
);

/** LLM spend ledger — backs the hard daily cap (PRD §13). */
export const llmUsage = pgTable('llm_usage', {
  id: text('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  day: text('day').notNull(),
  task: text('task').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  disputeId: text('dispute_id'),
});

/**
 * Policy corpus for grounding (PRD §14, Elastic). Mirrored in Postgres so the
 * Postgres-FTS fallback is a real fallback and not a stub.
 */
export const policies = pgTable('policy', {
  id: text('id').primaryKey(),
  reason: text('reason'),
  title: text('title').notNull(),
  url: text('url').notNull(),
  body: text('body').notNull(),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
});
