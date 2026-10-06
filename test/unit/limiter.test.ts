import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLimiter } from '../../src/http/limiter.js';

afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createLimiter', () => {
  it('never runs more than `concurrency` tasks at once and keeps first-come order', async () => {
    const limiter = createLimiter({ rps: 0, concurrency: 2 });
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, k) =>
        limiter.run(async () => {
          started.push(k);
          active++;
          peak = Math.max(peak, active);
          await tick(5);
          active--;
          return k;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('paces to rps after an initial burst of one second of tokens (fake timers)', async () => {
    vi.useFakeTimers();
    const limiter = createLimiter({ rps: 4, concurrency: 10 });
    const times: number[] = [];
    const t0 = Date.now();
    const all = Promise.all(Array.from({ length: 8 }, () => limiter.run(async () => times.push(Date.now() - t0))));
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toHaveLength(4); // the bucket starts full: 4 tokens
    await vi.advanceTimersByTimeAsync(260);
    expect(times).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(800);
    await all;
    expect(times).toHaveLength(8);
    expect(times[7]).toBeGreaterThanOrEqual(990);
    expect(times[7]).toBeLessThanOrEqual(1010);
  });

  it('passes results and errors through and frees the slot after a failure', async () => {
    const limiter = createLimiter({ rps: 100, concurrency: 1 });
    await expect(limiter.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await limiter.run(async () => 42)).toBe(42);
  });

  it('treats a bad concurrency as 1', async () => {
    const limiter = createLimiter({ rps: Number.POSITIVE_INFINITY, concurrency: 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 3 }, () => limiter.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(2);
      active--;
    })));
    expect(peak).toBe(1);
  });
});
