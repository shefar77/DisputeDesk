/**
 * Schema creation.
 *
 * Hand-written idempotent DDL rather than a migration tool: there is exactly one
 * schema version, it must apply identically to PGlite and Postgres, and it has to
 * run automatically on boot so a fresh clone needs no extra command. Re-running is
 * always safe.
 */

import { execute } from './client.js';

const DDL = `
CREATE TABLE IF NOT EXISTS dispute (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  stage TEXT,
  status TEXT NOT NULL,
  amount_value NUMERIC(18,2),
  amount_currency TEXT,
  due_at TIMESTAMPTZ,
  links_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_json JSONB NOT NULL,
  gather_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  fixture BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_due_at_idx ON dispute (due_at);
CREATE INDEX IF NOT EXISTS dispute_status_idx ON dispute (status);

CREATE TABLE IF NOT EXISTS evidence_item (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  source_ref TEXT,
  content_text TEXT,
  file_path TEXT,
  mime_type TEXT,
  bytes INTEGER,
  sha256 TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence REAL,
  fixture BOOLEAN NOT NULL DEFAULT FALSE,
  meta_json JSONB
);
CREATE INDEX IF NOT EXISTS evidence_dispute_idx ON evidence_item (dispute_id);

CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  json JSONB NOT NULL,
  completeness INTEGER NOT NULL,
  band TEXT NOT NULL,
  model TEXT NOT NULL,
  generator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_dispute_idx ON plan (dispute_id);

CREATE TABLE IF NOT EXISTS draft (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  plan_id TEXT,
  text TEXT NOT NULL,
  edited_text TEXT,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  tone TEXT NOT NULL DEFAULT 'factual',
  model TEXT NOT NULL,
  generator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_dispute_idx ON draft (dispute_id);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  canonical TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL,
  result_status TEXT NOT NULL DEFAULT 'PENDING',
  http_status INTEGER,
  debug_id TEXT,
  error TEXT,
  response_json JSONB,
  consumed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_idempotency_key_uq ON approval (idempotency_key);
CREATE INDEX IF NOT EXISTS approval_dispute_idx ON approval (dispute_id);

CREATE TABLE IF NOT EXISTS webhook_event (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT,
  processed_at TIMESTAMPTZ,
  dispute_id TEXT,
  raw_json JSONB
);

CREATE TABLE IF NOT EXISTS workflow_run (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS workflow_run_dispute_idx ON workflow_run (dispute_id);

CREATE TABLE IF NOT EXISTS workflow_step (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  dispute_id TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  detail TEXT,
  fallback_used TEXT
);
CREATE INDEX IF NOT EXISTS workflow_step_run_idx ON workflow_step (run_id);
CREATE INDEX IF NOT EXISTS workflow_step_dispute_idx ON workflow_step (dispute_id);

CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES dispute(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS timeline_dispute_idx ON timeline (dispute_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  dispute_id TEXT,
  detail_json JSONB
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit_log (ts);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  day TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  dispute_id TEXT
);

CREATE TABLE IF NOT EXISTS policy (
  id TEXT PRIMARY KEY,
  reason TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb
);
`;

/**
 * Full-text index for the Postgres-FTS retrieval fallback (PRD §14: "kill Elastic
 * -> fallback path works"). Created separately because PGlite builds without the
 * default text-search configuration in some releases; a failure here degrades
 * retrieval to ILIKE scanning rather than taking the app down.
 */
const FTS_DDL = `
CREATE INDEX IF NOT EXISTS policy_fts_idx
  ON policy USING GIN (to_tsvector('english', title || ' ' || body));
`;

export async function migrate(): Promise<{ fts: boolean }> {
  for (const statement of DDL.split(';')) {
    const s = statement.trim();
    if (s) await execute(s);
  }
  let fts = false;
  try {
    await execute(FTS_DDL.trim().replace(/;$/, ''));
    fts = true;
  } catch {
    fts = false;
  }
  return { fts };
}
