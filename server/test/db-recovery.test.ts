/**
 * Crash-recovery tests for the embedded database.
 *
 * The safety properties that matter here:
 *  - a live instance's database is never rebuilt out from under it;
 *  - a crashed run is detected and its directory rebuilt before it is opened;
 *  - a clean shutdown leaves nothing to recover, so data survives a restart.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DatabaseInUseError,
  acquireInstanceLock,
  isMemoryDir,
  isProcessAlive,
  lockPathFor,
  readLock,
  rebuildDataDir,
  withTimeout,
} from '../src/db/pglite-recovery.js';

const made: string[] = [];

function tempDataDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'dd-recovery-'));
  made.push(base);
  return join(base, 'pglite');
}

/** A pid that is certainly not running. */
function deadPid(): number {
  return 0x7ffffffe;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('process liveness', () => {
  it('recognises this process as alive and a bogus pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  it('treats malformed pids as dead rather than alive', () => {
    for (const pid of [0, -1, -42, Number.NaN, 1.5]) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });
});

describe('instance lock', () => {
  it('records our pid and reports a clean previous run', () => {
    const dir = tempDataDir();
    const lock = acquireInstanceLock(dir);
    expect(lock.previousRunCrashed).toBe(false);
    expect(readLock(lockPathFor(dir))?.pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPathFor(dir))).toBe(false);
  });

  it('refuses to open a database another live instance holds', () => {
    const dir = tempDataDir();
    mkdirSync(dir, { recursive: true });
    // A lock naming a *live* pid — here, this very test process.
    writeFileSync(lockPathFor(dir), JSON.stringify({ pid: process.pid + 0, startedAt: '', dataDir: dir }));
    // Simulate a different live owner by claiming the pid is someone else's.
    writeFileSync(lockPathFor(dir), JSON.stringify({ pid: process.ppid, startedAt: '', dataDir: dir }));
    expect(() => acquireInstanceLock(dir)).toThrow(DatabaseInUseError);
  });

  it('does not delete the data directory when the owner is alive', () => {
    const dir = tempDataDir();
    mkdirSync(dir, { recursive: true });
    const canary = join(dir, 'PG_VERSION');
    writeFileSync(canary, '16');
    writeFileSync(lockPathFor(dir), JSON.stringify({ pid: process.ppid, startedAt: '', dataDir: dir }));
    expect(() => acquireInstanceLock(dir)).toThrow(DatabaseInUseError);
    expect(existsSync(canary)).toBe(true);
  });

  it('reclaims a lock left by a dead process and flags the crash', () => {
    const dir = tempDataDir();
    writeFileSync(lockPathFor(dir), JSON.stringify({ pid: deadPid(), startedAt: '', dataDir: dir }));
    const lock = acquireInstanceLock(dir);
    expect(lock.previousRunCrashed).toBe(true);
    expect(readLock(lockPathFor(dir))?.pid).toBe(process.pid);
    lock.release();
  });

  it('treats a corrupt lock file as a crash, not as a live owner', () => {
    const dir = tempDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPathFor(dir), '{ this is not json');
    const lock = acquireInstanceLock(dir);
    expect(lock.previousRunCrashed).toBe(true);
    lock.release();
  });

  it('is a no-op for in-memory databases', () => {
    const lock = acquireInstanceLock('memory://x');
    expect(lock.previousRunCrashed).toBe(false);
    expect(isMemoryDir('memory://x')).toBe(true);
    lock.release();
  });
});

describe('rebuilding an unusable directory', () => {
  it('removes the directory and leaves no quarantine behind', () => {
    const dir = tempDataDir();
    mkdirSync(join(dir, 'base'), { recursive: true });
    writeFileSync(join(dir, 'PG_VERSION'), '16');
    rebuildDataDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps the lock file, which lives beside the directory', () => {
    const dir = tempDataDir();
    mkdirSync(dir, { recursive: true });
    const lock = acquireInstanceLock(dir);
    rebuildDataDir(dir);
    expect(existsSync(lockPathFor(dir))).toBe(true);
    expect(readLock(lockPathFor(dir))?.pid).toBe(process.pid);
    lock.release();
  });

  it('does nothing for a directory that is not there, or for memory', () => {
    expect(() => rebuildDataDir(join(tempDataDir(), 'missing'))).not.toThrow();
    expect(() => rebuildDataDir('memory://x')).not.toThrow();
  });
});

describe('bounded open', () => {
  it('passes a value through when the work settles', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'work')).resolves.toBe('ok');
  });

  it('turns a hang into an error instead of waiting forever', async () => {
    await expect(withTimeout(new Promise(() => {}), 40, 'Opening the database')).rejects.toThrow(/did not complete within/);
  });

  it('propagates a real failure unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'work')).rejects.toThrow('boom');
  });
});

describe('lock file contents', () => {
  it('is JSON carrying the pid, an ISO timestamp and the directory', () => {
    const dir = tempDataDir();
    const lock = acquireInstanceLock(dir);
    const raw = JSON.parse(readFileSync(lockPathFor(dir), 'utf8')) as Record<string, unknown>;
    expect(raw.pid).toBe(process.pid);
    expect(String(raw.startedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(raw.dataDir).toBe(dir);
    lock.release();
  });
});
