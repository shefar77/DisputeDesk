/**
 * Retrieval for grounding (PRD §14, Elastic).
 *
 * Elastic configured  -> BM25 multi_match over the policy index, reason-boosted.
 * Elastic absent/down -> Postgres full-text search over the same corpus.
 *
 * The fallback is not a stub: it runs the same corpus through `to_tsvector` with
 * `ts_rank`, and if even the FTS index is unavailable it degrades to a keyword
 * scan. Whichever backend answered is reported with every result, so the UI can
 * show "retrieved via Postgres FTS (Elastic unavailable)".
 *
 * Search is lexical. Semantic/hybrid retrieval over Elastic is a natural next step
 * but is not implemented, and nothing in the UI or README claims otherwise.
 */

import { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { POLICY_DOCS, type PolicyDoc } from './policies.js';

export interface Citation {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface RetrievalResult {
  citations: Citation[];
  backend: 'elastic' | 'postgres-fts' | 'keyword';
  degraded: boolean;
  detail: string | null;
}

let es: Client | null = null;
let esHealthy = false;
let esDetail = 'not configured';

export function elasticStatus(): { configured: boolean; healthy: boolean; detail: string } {
  return { configured: es !== null, healthy: esHealthy, detail: esDetail };
}

export async function initRetrieval(): Promise<void> {
  // The corpus always lives in Postgres too — that is what makes the fallback real.
  const db = getDb();
  for (const doc of POLICY_DOCS) {
    await db
      .insert(schema.policies)
      .values({ id: doc.id, reason: doc.reason, title: doc.title, url: doc.url, body: doc.body, tags: doc.tags })
      .onConflictDoUpdate({
        target: schema.policies.id,
        set: { reason: doc.reason, title: doc.title, url: doc.url, body: doc.body, tags: doc.tags },
      });
  }

  if (!env.elastic.url && !env.elastic.cloudId) {
    esDetail = 'ELASTIC_URL / ELASTIC_CLOUD_ID not set — using Postgres full-text search';
    return;
  }

  try {
    es = new Client({
      ...(env.elastic.cloudId ? { cloud: { id: env.elastic.cloudId } } : { node: env.elastic.url! }),
      ...(env.elastic.apiKey ? { auth: { apiKey: env.elastic.apiKey } } : {}),
      requestTimeout: 5_000,
    });
    await ensurePolicyIndex(es, POLICY_DOCS);
    esHealthy = true;
    esDetail = `index ${env.elastic.policiesIndex} (${POLICY_DOCS.length} docs)`;
    logger.info({ index: env.elastic.policiesIndex }, 'Elastic retrieval ready');
  } catch (err) {
    esHealthy = false;
    esDetail = `unreachable: ${err instanceof Error ? err.message : 'unknown error'} — using Postgres FTS`;
    logger.warn({ detail: esDetail }, 'Elastic unavailable, retrieval will use Postgres');
  }
}

async function ensurePolicyIndex(client: Client, docs: PolicyDoc[]): Promise<void> {
  const index = env.elastic.policiesIndex;
  const exists = await client.indices.exists({ index });
  if (!exists) {
    await client.indices.create({
      index,
      mappings: {
        properties: {
          reason: { type: 'keyword' },
          title: { type: 'text', analyzer: 'english' },
          body: { type: 'text', analyzer: 'english' },
          tags: { type: 'text', analyzer: 'english' },
          url: { type: 'keyword' },
        },
      },
    });
  }
  await client.bulk({
    refresh: true,
    operations: docs.flatMap((d) => [
      { index: { _index: index, _id: d.id } },
      { reason: d.reason, title: d.title, body: d.body, tags: d.tags.join(' '), url: d.url },
    ]),
  });
}

function snippet(body: string, max = 320): string {
  return body.length <= max ? body : `${body.slice(0, max - 1).trimEnd()}…`;
}

async function searchElastic(query: string, reason: string, k: number): Promise<Citation[]> {
  const res = await es!.search<{ title: string; body: string; url: string }>({
    index: env.elastic.policiesIndex,
    size: k,
    query: {
      bool: {
        must: [{ multi_match: { query, fields: ['title^2', 'body', 'tags^1.5'] } }],
        should: [{ term: { reason: { value: reason, boost: 2 } } }],
      },
    },
  });
  return res.hits.hits
    .filter((h) => h._source)
    .map((h) => ({
      id: String(h._id),
      title: h._source!.title,
      url: h._source!.url,
      snippet: snippet(h._source!.body),
      score: typeof h._score === 'number' ? Number(h._score.toFixed(3)) : undefined,
    }));
}

async function searchPostgres(query: string, reason: string, k: number): Promise<Citation[]> {
  const db = getDb();
  const terms = query.replace(/[^\w\s-]/g, ' ').trim();
  const rows = await db
    .select({
      id: schema.policies.id,
      title: schema.policies.title,
      url: schema.policies.url,
      body: schema.policies.body,
      rank: sql<number>`ts_rank(
        to_tsvector('english', ${schema.policies.title} || ' ' || ${schema.policies.body}),
        websearch_to_tsquery('english', ${terms.split(/\s+/).join(' OR ')})
      ) + case when ${schema.policies.reason} = ${reason} then 0.2 else 0 end`,
    })
    .from(schema.policies)
    .orderBy(sql`5 desc`)
    .limit(k);
  return rows
    .filter((r) => Number(r.rank) > 0)
    .map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      snippet: snippet(r.body),
      score: Number(Number(r.rank).toFixed(3)),
    }));
}

function searchKeyword(query: string, reason: string, k: number): Citation[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  return POLICY_DOCS.map((d) => {
    const hay = `${d.title} ${d.body} ${d.tags.join(' ')}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) + (d.reason === reason ? 0.5 : 0);
    return { d, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ d, score }) => ({ id: d.id, title: d.title, url: d.url, snippet: snippet(d.body), score }));
}

/** Retrieve policy passages for a dispute. Never throws: degrades instead. */
export async function retrievePolicies(query: string, reason: string, k = 4): Promise<RetrievalResult> {
  if (es && esHealthy) {
    try {
      const citations = await searchElastic(query, reason, k);
      return { citations, backend: 'elastic', degraded: false, detail: null };
    } catch (err) {
      esHealthy = false;
      esDetail = `query failed: ${err instanceof Error ? err.message : 'unknown'}`;
      logger.warn({ detail: esDetail }, 'Elastic query failed, falling back to Postgres');
    }
  }

  try {
    const citations = await searchPostgres(query, reason, k);
    if (citations.length > 0) {
      return {
        citations,
        backend: 'postgres-fts',
        degraded: es !== null,
        detail: es !== null ? 'Elastic unavailable — served by Postgres full-text search' : null,
      };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Postgres FTS failed, using keyword scan');
  }

  return {
    citations: searchKeyword(query, reason, k),
    backend: 'keyword',
    degraded: true,
    detail: 'Full-text search unavailable — served by keyword scan',
  };
}

/** ES|QL analytics (PRD FR-16, P1). Returns null when Elastic is not available. */
export async function esqlQuery(query: string): Promise<{ columns: string[]; values: unknown[][] } | null> {
  if (!es || !esHealthy) return null;
  try {
    const res = (await es.esql.query({ query })) as unknown as {
      columns: { name: string }[];
      values: unknown[][];
    };
    return { columns: res.columns.map((c) => c.name), values: res.values };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'ES|QL query failed');
    return null;
  }
}

/** Mirror a resolved dispute into Elastic for ES|QL analytics. No-op without Elastic. */
export async function indexDisputeOutcome(doc: Record<string, unknown> & { dispute_id: string }): Promise<void> {
  if (!es || !esHealthy) return;
  try {
    await es.index({ index: 'disputedesk-disputes', id: doc.dispute_id, document: doc, refresh: true });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to index dispute into Elastic');
  }
}
