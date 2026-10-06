// state/lock with stale detection and signal-safe release. Owner: WP-A.
//
// The lock is created with open(..., 'wx') and holds { pid, host, runId, startedAt }. It is
// stale when its process is gone (same host) or when it is older than 3 hours. A stale lock
// is reclaimed; a live one raises StError('lock_held'). The release function is idempotent,
// removes the lock only while it still names this run, and also runs on SIGINT, SIGTERM and
// process exit.
import { hostname } from 'node:os';
import { StError } from '../core/errors.js';
import { toInstant } from '../core/time.js';
import type { Clock, DataStore, Instant } from '../core/types.js';
import { layout } from './layout.js';
import { parseJsonSafe } from './ndjson.js';
import { isLocalDataStore } from './store.js';

const STALE_AFTER_MS = 3 * 3_600_000;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface LockInfo {
  pid: number;
  host: string;
  runId: string;
  startedAt: Instant;
}

function parseLock(text: string | null): LockInfo | null {
  if (text === null) return null;
  try {
    const v = parseJsonSafe(text) as Partial<LockInfo> | null;
    if (!v || typeof v !== 'object') return null;
    if (typeof v.pid !== 'number' || typeof v.host !== 'string' || typeof v.runId !== 'string' || typeof v.startedAt !== 'string') {
      return null;
    }
    return { pid: v.pid, host: v.host, runId: v.runId, startedAt: v.startedAt };
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** Whether an existing lock still counts as held at clock.now(). */
export function isLockLive(info: LockInfo, clock: Clock, host: string = hostname()): boolean {
  const started = Date.parse(info.startedAt);
  if (Number.isNaN(started)) return false;
  if (clock.now().getTime() - started > STALE_AFTER_MS) return false;
  return info.host === host ? pidAlive(info.pid) : true;
}

function lockHeld(info: LockInfo | null): StError {
  const pid = info ? String(info.pid) : 'unknown';
  return new StError(
    'lock_held',
    `The data folder is locked by another searchtrace run${info ? ` (${info.runId} on ${info.host})` : ''}.`,
    `Another searchtrace run is in progress (pid ${pid}). Wait for it, or delete state/lock if it crashed.`,
  );
}

async function tryCreate(store: DataStore, body: string): Promise<boolean> {
  if (isLocalDataStore(store)) return store.createExclusive(layout.lock, body);
  // A store without exclusive create (a foreign DataStore): best effort.
  if (await store.exists(layout.lock)) return false;
  await store.writeFileAtomic(layout.lock, body);
  return true;
}

/** Returns the release function. Throws StError('lock_held') when a live lock exists. */
export async function acquireLock(store: DataStore, runId: string, clock: Clock): Promise<() => Promise<void>> {
  const host = hostname();
  const info: LockInfo = { pid: process.pid, host, runId, startedAt: toInstant(clock.now()) };
  const body = `${JSON.stringify(info)}\n`;

  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    if (await tryCreate(store, body)) {
      acquired = true;
      break;
    }
    const existingText = await store.readFile(layout.lock);
    const existing = parseLock(existingText);
    if (existing && isLockLive(existing, clock, host)) throw lockHeld(existing);
    // Stale or unreadable: reclaim it, unless it changed under us (another run just took it).
    if ((await store.readFile(layout.lock)) === existingText) await store.removeFile(layout.lock);
  }
  if (!acquired) throw lockHeld(parseLock(await store.readFile(layout.lock)));

  let released = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  const detach = (): void => {
    for (const [sig, fn] of handlers) process.off(sig, fn);
    handlers.clear();
    process.off('exit', onExit);
  };

  const ownsLock = (text: string | null): boolean => parseLock(text)?.runId === runId;

  const releaseSync = (): void => {
    if (released) return;
    released = true;
    detach();
    if (!isLocalDataStore(store)) return;
    try {
      if (ownsLock(store.readFileSync(layout.lock))) store.removeFileSync(layout.lock);
    } catch {
      // exiting anyway; a leftover lock is reclaimed as stale next time
    }
  };

  function onExit(): void {
    releaseSync();
  }

  for (const sig of SIGNALS) {
    const fn = (): void => {
      releaseSync();
      // With no other listener, re-raise so the default action (exit) still happens.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    handlers.set(sig, fn);
    process.on(sig, fn);
  }
  process.on('exit', onExit);

  return async (): Promise<void> => {
    if (released) return;
    released = true;
    detach();
    if (ownsLock(await store.readFile(layout.lock))) await store.removeFile(layout.lock);
  };
}
