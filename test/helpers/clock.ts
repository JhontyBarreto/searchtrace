// Clocks for tests. Owner: WP-A.
// fixedClock is the core one (frozen). manualClock can be set or advanced, for code that
// compares times across steps (stale locks, quotas across a PT day boundary, the 20 h skip).
import { fixedClock } from '../../src/core/time.js';
import type { Clock, Instant } from '../../src/core/types.js';

export { fixedClock };

export interface ManualClock extends Clock {
  set(iso: Instant): void;
  advance(ms: number): void;
}

export function manualClock(iso: Instant): ManualClock {
  let ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`manualClock: not an instant: ${iso}`);
  return {
    now: () => new Date(ms),
    set(next: Instant) {
      const v = Date.parse(next);
      if (Number.isNaN(v)) throw new Error(`manualClock: not an instant: ${next}`);
      ms = v;
    },
    advance(delta: number) {
      ms += delta;
    },
  };
}
