// Seeded synthetic generators: Poisson and negative binomial series, weekday patterns, unit cells. Owner: WP-A.
// Self-contained (no dependency on analyze/stats.ts) so analyzer tests never test a sampler with itself.
import { addDays, weekday } from '../../src/core/time.js';
import { rngFor } from '../../src/core/rng.js';
import type { Cell, Device, IsoDate, Rng } from '../../src/core/types.js';

/** rngFor('test', key): deterministic per key. */
export function testRng(key: string): Rng {
  return rngFor('test', key);
}

/** Standard normal by Box-Muller (one draw per call, the pair's second value is discarded). */
export function normalDraw(rng: Rng): number {
  let u = 0;
  while (u <= 1e-300) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, scale) by Marsaglia and Tsang, with the shape < 1 boost. */
export function gammaDraw(rng: Rng, shape: number, scale: number): number {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) {
    let u = 0;
    while (u <= 1e-300) u = rng();
    return gammaDraw(rng, shape + 1, scale) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalDraw(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** One Poisson draw: Knuth's product method for small means, a rounded normal for large ones. */
export function poissonOne(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = rng();
    while (p > limit) {
      k++;
      p *= rng();
    }
    return k;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(rng)));
}

/** One binomial draw: Bernoulli sum for small n, a clamped rounded normal for large n. */
export function binomialOne(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n < 1000) {
    let k = 0;
    for (let j = 0; j < n; j++) if (rng() < p) k++;
    return k;
  }
  const draw = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normalDraw(rng));
  return Math.min(n, Math.max(0, draw));
}

export function poissonSeries(rng: Rng, means: number[]): number[] {
  return means.map((m) => poissonOne(rng, m));
}

/** Negative binomial with mean m and variance phi * m (phi >= 1; phi = 1 is Poisson). Gamma-Poisson mixture. */
export function negBinSeries(rng: Rng, means: number[], phi: number): number[] {
  if (!(phi > 1)) return poissonSeries(rng, means);
  return means.map((m) => {
    if (!(m > 0)) return 0;
    const shape = m / (phi - 1);
    return poissonOne(rng, gammaDraw(rng, shape, phi - 1));
  });
}

/** A mild weekday pattern (Monday first, mean 1): weekdays a little busier than weekends. */
export const DEFAULT_DOW = [1.1, 1.12, 1.1, 1.05, 0.98, 0.78, 0.87];

/** base x weekday factor (7 factors, Monday first, default a mild weekday pattern) for n days from start. */
export function dowMeans(start: IsoDate, n: number, base: number, factors?: number[]): number[] {
  const f = factors ?? DEFAULT_DOW;
  const w0 = weekday(start);
  return Array.from({ length: n }, (_, k) => base * f[(w0 + k) % 7]);
}

/** Copy of means with every value from index `at` onwards multiplied by `ratio` (a step change). */
export function withStep(means: number[], at: number, ratio: number): number[] {
  return means.map((m, k) => (k >= at ? m * ratio : m));
}

export interface SynthUnitSpec {
  page: string;
  query: string;
  device: Device;
  impressionsPerDay: number;
  /** Mean position; daily positions jitter around it. */
  position: number;
  /** True click rate at that position. */
  ctr: number;
}

/**
 * Daily named cells for each unit over [start, start + days), Poisson impressions and binomial
 * clicks. Draws run day by day, unit by unit, so changing the unit list changes later draws; call
 * once per unit with its own testRng(key) when units must stay stable on their own. Days with
 * zero impressions produce no cell, as Search Console does. Positions jitter by about 5%
 * (log-normal) and never go below 1.
 */
export function synthCells(rng: Rng, start: IsoDate, days: number, units: SynthUnitSpec[]): Cell[] {
  const out: Cell[] = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(start, k);
    for (const u of units) {
      const i = poissonOne(rng, u.impressionsPerDay);
      const pos = Math.max(1, u.position * Math.exp(0.05 * normalDraw(rng)));
      if (i === 0) continue;
      const c = binomialOne(rng, i, u.ctr);
      out.push({ date, q: u.query, p: u.page, dv: u.device, c, i, ps: pos * i });
    }
  }
  return out;
}
