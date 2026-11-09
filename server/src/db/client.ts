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
import { logger } from '../log.js';
import {
  DatabaseUnusableError,
  OPEN_TIMEOUT_MS,
  acquireInstanceLock,
  isMemoryDir,
  rebuildDataDir,
  withTimeout,
  type LockHandle,
} from './pglite-recovery.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

let db: Db | null = null;
let driver: 'postgres' | 'pglite' = 'pglite';
let closeFn: () => Promise<void> = async () => {};
/** Held for the lifetime of a PGlite connection; released on close. */
let lock: LockHandle | null = null;

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
    const dir = env.db.pgliteDir;
    const { PGlite } = await import('@electric-sql/pglite');

    // Claim the directory before opening it. This both refuses to run two
    // instances against one database and tells us whether the last run crashed.
    lock = acquireInstanceLock(dir);

    // A directory left by a killed process cannot be reopened — PGlite hangs or
    // aborts — and once it is open we can no longer delete it on Windows. So the
    // rebuild happens here, before anything touches the files.
    if (lock.previousRunCrashed) {
      if (!env.isDemo) {
        lock.release();
        throw new DatabaseUnusableError(dir, 'the previous run was interrupted');
      }
      rebuildDataDir(dir);
    }

    // 'memory://' keeps the database in RAM (tests, eval); anything else is a directory.
    if (!isMemoryDir(dir)) mkdirSync(dir, { recursive: true });

    const pg = new PGlite(dir);
    try {
      await withTimeout(pg.waitReady, OPEN_TIMEOUT_MS, `Opening the database at ${dir}`);
    } catch (err) {
      // The open never settled or threw. We cannot clean up underneath a hung
      // instance, so report precisely instead of leaving the process hanging.
      lock.release();
      lock = null;
      logger.error({ dir, err: err instanceof Error ? err.message : err }, 'Database open failed');
      throw new DatabaseUnusableError(dir, err instanceof Error ? err.message : 'unknown error');
    }

    db = drizzlePglite(pg, { schema });
    driver = 'pglite';
    closeFn = async () => {
      await pg.close();
    };

    // Safety net for exits that bypass closeDb (uncaught error, plain exit).
    // Must be synchronous: 'exit' handlers cannot await. A signal that kills the
    // process outright still leaves the lock, which is exactly what we want —
    // that is the crash the next boot needs to know about.
    process.once('exit', () => {
      lock?.release();
      lock = null;
    });
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

/**
 * Close cleanly and drop the lock. Releasing it last, and only after the
 * database is actually shut, is what tells the next boot the data is intact.
 */
export async function closeDb(): Promise<void> {
  try {
    await closeFn();
  } finally {
    db = null;
    closeFn = async () => {};
    lock?.release();
    lock = null;
  }
}

/** Raw SQL escape hatch, used by migrate.ts and the FTS fallback. */
export async function execute(sql: string): Promise<void> {
  const d = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
  const { sql: raw } = await import('drizzle-orm');
  await d.execute(raw.raw(sql));
}

export { schema };
