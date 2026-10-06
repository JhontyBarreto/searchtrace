// Seeded randomness: mulberry32 and rngFor(seed, key). Owner: WP-A.
// Every random draw in analysis, graph, report and demo code comes from here (D24).
import { hash32 } from './ids.js';
import type { Rng } from './types.js';

/** mulberry32: a small, fast 32-bit PRNG. Returns uniform numbers in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** mulberry32(hash32(seed + '|' + key)) */
export function rngFor(seed: string, key: string): Rng {
  return mulberry32(hash32(`${seed}|${key}`));
}
