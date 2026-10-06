import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { fixedClock } from '../../src/core/time.js';
import type { DataStore } from '../../src/core/types.js';
import { layout } from '../../src/store/layout.js';
import { acquireLock, isLockLive, pidAlive } from '../../src/store/lock.js';
import { openStore } from '../../src/store/store.js';
import { manualClock } from '../helpers/clock.js';
import { memoryStore } from '../helpers/memory-store.js';

const NOW = '2026-10-06T06:17:00Z';
const DEAD_PID = 2_147_483_646; // far above any real pid_max

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'searchtrace-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockBody = (o: { pid: number; host: string; runId: string; startedAt: string }): string => `${JSON.stringify(o)}\n`;

describe.each([
  ['disk', async (): Promise<DataStore> => openStore(dir, createSecretRegistry({ ci: false }))],
  ['memory', async (): Promise<DataStore> => memoryStore()],
] as const)('acquireLock (%s, test 67)', (_name, open) => {
  it('takes the lock, refuses a second live holder with the spec fix line, and releases', async () => {
    const store = await open();
    const clock = fixedClock(NOW);
    const release = await acquireLock(store, 'r20261006t061700z-0001', clock);
    const held = JSON.parse((await store.readFile(layout.lock)) ?? '{}');
    expect(held).toEqual({ pid: process.pid, host: hostname(), runId: 'r20261006t061700z-0001', startedAt: NOW });

    let caught: unknown;
    try {
      await acquireLock(store, 'r20261006t061700z-0002', clock);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StError);
    expect((caught as StError).code).toBe('lock_held');
    expect((caught as StError).fix).toBe(
      `Another searchtrace run is in progress (pid ${process.pid}). Wait for it, or delete state/lock if it crashed.`,
    );

    await release();
    await release(); // idempotent
    expect(await store.exists(layout.lock)).toBe(false);
    const again = await acquireLock(store, 'r20261006t061700z-0003', clock);
    await again();
  });

  it('reclaims a stale lock whose process is gone on this host', async () => {
    const store = await open();
    await store.writeFileAtomic(layout.lock, lockBody({ pid: DEAD_PID, host: hostname(), runId: 'rdead', startedAt: NOW }));
    const release = await acquireLock(store, 'r20261006t061700z-0004', fixedClock(NOW));
    expect(JSON.parse((await store.readFile(layout.lock)) ?? '{}').runId).toBe('r20261006t061700z-0004');
    await release();
  });

  it('treats a lock from another host as live for 3 hours, then stale', async () => {
    const store = await open();
    await store.writeFileAtomic(layout.lock, lockBody({ pid: 1, host: 'some-other-runner', runId: 'rother', startedAt: NOW }));
    const clock = manualClock(NOW);
    clock.advance(2 * 3_600_000);
    await expect(acquireLock(store, 'r20261006t061700z-0005', clock)).rejects.toMatchObject({ code: 'lock_held' });
    clock.advance(1.5 * 3_600_000);
    const release = await acquireLock(store, 'r20261006t061700z-0005', clock);
    await release();
  });

  it('reclaims an unreadable lock file', async () => {
    const store = await open();
    await store.writeFileAtomic(layout.lock, '');
    const release = await acquireLock(store, 'r20261006t061700z-0006', fixedClock(NOW));
    await release();
    expect(await store.exists(layout.lock)).toBe(false);
  });

  it('release never deletes a lock that now belongs to another run', async () => {
    const store = await open();
    const release = await acquireLock(store, 'r20261006t061700z-0007', fixedClock(NOW));
    await store.writeFileAtomic(layout.lock, lockBody({ pid: process.pid, host: hostname(), runId: 'rsomeoneelse', startedAt: NOW }));
    await release();
    expect(JSON.parse((await store.readFile(layout.lock)) ?? '{}').runId).toBe('rsomeoneelse');
  });

  it('releases on SIGINT and SIGTERM, and removes its handlers after release', async () => {
    const store = await open();
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), exit: process.listenerCount('exit') };
    const release = await acquireLock(store, 'r20261006t061700z-0008', fixedClock(NOW));
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    // Another listener stands in for the pipeline's own shutdown handler, so the lock's
    // handler does not re-raise the signal and end the test process.
    const keepAlive = (): void => undefined;
    process.on('SIGINT', keepAlive);
    try {
      process.emit('SIGINT');
    } finally {
      process.off('SIGINT', keepAlive);
    }
    expect(await store.exists(layout.lock)).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('exit')).toBe(before.exit);
    await release(); // still safe to call
  });
});

describe('liveness rules', () => {
  it('pidAlive', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(DEAD_PID)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it('isLockLive: age over 3 hours is stale anywhere; a dead pid is stale on this host', () => {
    const base = { pid: process.pid, host: 'h', runId: 'r', startedAt: NOW };
    expect(isLockLive(base, fixedClock(NOW), 'h')).toBe(true);
    expect(isLockLive(base, fixedClock('2026-10-06T09:17:01Z'), 'h')).toBe(false);
    expect(isLockLive({ ...base, pid: DEAD_PID }, fixedClock(NOW), 'h')).toBe(false);
    expect(isLockLive({ ...base, pid: DEAD_PID }, fixedClock(NOW), 'other')).toBe(true);
    expect(isLockLive({ ...base, startedAt: 'garbage' }, fixedClock(NOW), 'h')).toBe(false);
  });
});
