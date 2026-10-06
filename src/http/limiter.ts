// Token bucket (requests per second) plus a semaphore (concurrency). Owner: WP-A.
//
// run(fn) waits for a free slot (at most `concurrency` calls in flight, first come first
// served), then for a token (the bucket holds up to max(1, rps) tokens and refills at rps per
// second), then calls fn. rps <= 0 or Infinity means no rate limit.
import type { Limiter } from '../core/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLimiter(o: { rps: number; concurrency: number }): Limiter {
  const concurrency = Number.isFinite(o.concurrency) && o.concurrency >= 1 ? Math.floor(o.concurrency) : 1;
  const rps = Number.isFinite(o.rps) && o.rps > 0 ? o.rps : Number.POSITIVE_INFINITY;
  const capacity = Number.isFinite(rps) ? Math.max(1, rps) : Number.POSITIVE_INFINITY;

  let tokens = capacity;
  let last = Date.now();
  let active = 0;
  const waiting: (() => void)[] = [];
  let tokenChain: Promise<void> = Promise.resolve();

  const refill = (): void => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * rps);
    last = now;
  };

  const acquireSlot = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active++;
        resolve();
      } else {
        waiting.push(() => {
          active++;
          resolve();
        });
      }
    });

  const releaseSlot = (): void => {
    active--;
    waiting.shift()?.();
  };

  // Tokens are handed out strictly in order through a promise chain.
  const takeToken = (): Promise<void> => {
    if (!Number.isFinite(rps)) return Promise.resolve();
    const turn = tokenChain.then(async () => {
      refill();
      while (tokens < 1) {
        await sleep(Math.max(1, Math.ceil(((1 - tokens) / rps) * 1000)));
        refill();
      }
      tokens -= 1;
    });
    tokenChain = turn.catch(() => undefined);
    return turn;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquireSlot();
      try {
        await takeToken();
        return await fn();
      } finally {
        releaseSlot();
      }
    },
  };
}
