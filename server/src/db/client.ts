/**
 * Database connection.
 *
 * `DATABASE_URL` present -> node-postgres against managed Postgres (Render, docker).
 * Absent                 -> embedded PGlite, file-backed under .data/pglite.
 *
 * Both are the Postgres dialect, so `schema.ts`, the DDL in `migrate.ts` and every
 * query are shared verbatim. The only branch in the whole app is this factory.
 */

import { mkdirSync } from 'node:fs';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { env } from '../env.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

let db: Db | null = null;
let driver: 'postgres' | 'pglite' = 'pglite';
let closeFn: () => Promise<void> = async () => {};

export async function initDb(): Promise<Db> {
  if (db) return db;

  if (env.db.url) {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: env.db.url,
      // Render's managed Postgres terminates TLS with its own CA.
      ssl: /\blocalhost\b|\b127\.0\.0\.1\b/.test(env.db.url)
        ? undefined
        : { rejectUnauthorized: false },
      max: 8,
    });
    // Fail fast with a clear message rather than on the first query.
    await pool.query('select 1');
    db = drizzlePg(pool, { schema });
    driver = 'postgres';
    closeFn = () => pool.end();
  } else {
    // 'memory://' keeps the database in RAM (tests, eval); anything else is a directory.
    if (!env.db.pgliteDir.startsWith('memory://')) mkdirSync(env.db.pgliteDir, { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite(env.db.pgliteDir);
    await pg.waitReady;
    db = drizzlePglite(pg, { schema });
    driver = 'pglite';
    closeFn = () => pg.close();
  }

  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not initialised — call initDb() during boot.');
  return db;
}

export function getDriver(): 'postgres' | 'pglite' {
  return driver;
}

export async function closeDb(): Promise<void> {
  await closeFn();
  db = null;
}

/** Raw SQL escape hatch, used by migrate.ts and the FTS fallback. */
export async function execute(sql: string): Promise<void> {
  const d = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
  const { sql: raw } = await import('drizzle-orm');
  await d.execute(raw.raw(sql));
}

export { schema };
