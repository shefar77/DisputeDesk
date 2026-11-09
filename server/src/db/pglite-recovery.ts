/**
 * Crash recovery for the embedded PGlite database.
 *
 * The problem, established by experiment rather than assumption:
 * if the process is killed while PGlite is writing, the data directory is left
 * in a state PGlite cannot reopen. It does not fail cleanly — it either aborts
 * inside the WASM runtime or, more often, **hangs forever with no error**. The
 * `postmaster.pid` file that Postgres leaves behind is NOT the cause: a database
 * reopens fine with a stale one present, and PGlite writes a synthetic pid
 * (`-42`) into it anyway, so that file says nothing about liveness.
 *
 * Because a hung open holds OS file handles — and Windows will not let us delete
 * or rename a directory whose files are open — recovery has to happen *before*
 * the open, never after. So we track liveness ourselves:
 *
 *   - A lock file beside the data directory records the real host pid of the
 *     process using it. It is removed on graceful shutdown.
 *   - On boot, a lock whose pid is still alive means another instance owns this
 *     directory: we refuse to start rather than open it twice.
 *   - A lock whose pid is dead means the previous run was killed. The directory
 *     is then presumed unusable and rebuilt before anything opens it.
 *   - No lock means the last run shut down cleanly; open normally.
 *
 * Rebuilding is only ever done for a demo-mode database, whose contents are
 * disposable sample data regenerated on every boot. With real data (a PGlite
 * directory outside demo mode) we refuse and explain, and with an external
 * Postgres (`DATABASE_URL`) none of this code runs at all.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../log.js';

/** PGlite treats a `memory://` path as an in-RAM database with no files. */
export function isMemoryDir(dir: string): boolean {
  return dir.startsWith('memory://');
}

export function lockPathFor(dataDir: string): string {
  return `${dataDir}.lock`;
}

export interface LockRecord {
  pid: number;
  startedAt: string;
  dataDir: string;
}

/**
 * Is a host process with this pid running?
 * `kill(pid, 0)` sends no signal; it only asks the OS. EPERM means the process
 * exists but belongs to another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? ''), dataDir: String(parsed.dataDir ?? '') };
  } catch {
    // Unreadable or truncated lock: treat as a crashed run, not as a live owner.
    return null;
  }
}

export class DatabaseInUseError extends Error {
  constructor(
    readonly pid: number,
    dataDir: string,
  ) {
    super(
      `Another DisputeDesk instance (pid ${pid}) is already using the database at ${dataDir}. ` +
        'Stop it first, or start this one with a different PGLITE_DIR / PORT. ' +
        'If that process is gone, delete the lock file beside the directory and retry.',
    );
    this.name = 'DatabaseInUseError';
  }
}

export class DatabaseUnusableError extends Error {
  constructor(dataDir: string, reason: string) {
    super(
      `The database at ${dataDir} could not be opened (${reason}). It was most likely left behind by a ` +
        'process that was killed mid-write. Automatic recovery only runs in demo mode, where the data is ' +
        `disposable. Back up and remove ${dataDir}, then restart.`,
    );
    this.name = 'DatabaseUnusableError';
  }
}

export interface LockHandle {
  /** True when the previous run did not shut down cleanly. */
  previousRunCrashed: boolean;
  release(): void;
}

/**
 * Take ownership of the data directory.
 *
 * Creating the lock with the `wx` flag is atomic: if two processes start at the
 * same instant, exactly one succeeds. The loser inspects the winner's pid and
 * either backs off (owner alive) or atomically claims the stale lock by renaming
 * it — again, only one process can win a rename of the same file.
 */
export function acquireInstanceLock(dataDir: string): LockHandle {
  if (isMemoryDir(dataDir)) {
    return { previousRunCrashed: false, release: () => {} };
  }

  const lockPath = lockPathFor(dataDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), dataDir };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
      // We created the lock, so nothing else holds it and the last run was clean.
      return { previousRunCrashed: false, release: () => releaseLock(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const existing = readLock(lockPath);
    if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      throw new DatabaseInUseError(existing.pid, dataDir);
    }

    // Stale lock. Claim it atomically so a racing instance cannot also claim it.
    const claim = `${lockPath}.claim-${process.pid}`;
    try {
      renameSync(lockPath, claim);
      rmSync(claim, { force: true });
      writeFileSync(lockPath, JSON.stringify(record));
      logger.warn(
        { dataDir, previousPid: existing?.pid ?? null },
        'Previous run did not shut down cleanly — the database will be rebuilt before opening',
      );
      return { previousRunCrashed: true, release: () => releaseLock(lockPath) };
    } catch {
      // Another instance claimed it first; loop and re-evaluate.
    }
  }

  throw new Error(`Could not acquire the database lock at ${lockPath} after several attempts.`);
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone, or the directory was removed; nothing to release.
  }
}

/**
 * Delete an unusable data directory so a fresh one can be created.
 *
 * Only ever called before the directory is opened, so no file handles are held
 * and the removal cannot race an active connection. Renaming first means a
 * partially-deleted directory is never left in place of a real one.
 */
export function rebuildDataDir(dataDir: string): void {
  if (isMemoryDir(dataDir) || !existsSync(dataDir)) return;
  const quarantine = `${dataDir}.unusable-${Date.now()}`;
  try {
    renameSync(dataDir, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // Rename can fail across devices or on a locked path; fall back to deleting
    // in place, and surface the real reason if that fails too.
    rmSync(dataDir, { recursive: true, force: true });
  }
  logger.warn({ dataDir }, 'Rebuilt the demo database after an unclean shutdown (sample data is regenerated on boot)');
}

/**
 * Bound an open that may never settle. A hung PGlite open produces no error at
 * all, so without this the process would sit there silently forever.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const OPEN_TIMEOUT_MS = 15_000;
