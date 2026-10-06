// Shared numerics (spec 2.4, 5.4, 5.6, 5.13 tests 12, 21, 22, 23). Reference values come from SciPy 1.18
// (scipy.special.gammaln, scipy.stats.betabinom, kstwobign, chi2, norm) or are worked out by hand in the comments.
import { describe, expect, it } from 'vitest';

import {
  benjaminiHochberg,
  bootstrapP,
  chiSquareTail,
  dowFactors,
  kolmogorovTail,
  lgamma,
  logBetaBinomial,
  mad,
  normalCdf,
  normalQuantile,
  overdispersion,
  pava,
  percentileCi,
  periodCompare,
  poissonDraw,
  quantile,
  seasonalSeries,
  theilSen,
} from '../../src/analyze/stats.js';
import type { PeriodCompareInput, Rng } from '../../src/core/types.js';

// A local seeded PRNG so these tests do not depend on core/rng.ts. Same algorithm as mulberry32.
function testRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalDraw(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia and Tsang gamma draw for shape >= 1. */
function gammaDraw(rng: Rng, shape: number, scale: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normalDraw(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Negative binomial with mean m and variance phi * m, as a gamma-Poisson mixture. */
function negBinDraw(rng: Rng, m: number, phi: number): number {
  return poissonDraw(rng, gammaDraw(rng, m / (phi - 1), phi - 1));
}

function meanVar(x: number[]): { mean: number; variance: number } {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const variance = x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - 1);
  return { mean, variance };
}

function isNonIncreasing(x: number[]): boolean {
  return x.every((v, i) => i === 0 || v <= x[i - 1] + 1e-12);
}

function isNonDecreasing(x: number[]): boolean {
  return x.every((v, i) => i === 0 || v >= x[i - 1] - 1e-12);
}

const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i], 0);

describe('lgamma', () => {
  it('matches reference values (Lanczos)', () => {
    const cases: [number, number][] = [
      [0.5, 0.5723649429247],
      [3.5, 1.2009736023470743],
      [10, 12.801827480081469],
      [100, 359.1342053695754],
      [1e-3, 6.907178885383853],
      [0.1, 2.252712651734206],
      [171.5, 709.1431630309283],
      [1e6, 12815504.569147611],
      [-0.5, 1.2655121234846454],
      [-2.5, -0.05624371649767401],
    ];
    for (const [x, want] of cases) expect(Math.abs(lgamma(x) - want)).toBeLessThan(1e-13 * Math.max(1, Math.abs(want)));
    expect(lgamma(1)).toBe(0);
    expect(lgamma(2)).toBe(0);
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 14);
  });

  it('is Infinity at the poles and follows the recurrence lgamma(x + 1) = lgamma(x) + ln x', () => {
    expect(lgamma(0)).toBe(Infinity);
    expect(lgamma(-3)).toBe(Infinity);
    expect(lgamma(Number.NaN)).toBeNaN();
    const rng = testRng(1);
    for (let i = 0; i < 200; i++) {
      const x = 0.01 + rng() * 300;
      expect(lgamma(x + 1) - lgamma(x)).toBeCloseTo(Math.log(x), 10);
    }
  });
});

describe('logBetaBinomial', () => {
  it('matches reference values', () => {
    // C(5,2) B(4,6) / B(2,3) = 10 * (1/504) / (1/12) = 120/504.
    expect(logBetaBinomial(2, 5, 2, 3)).toBeCloseTo(Math.log(120 / 504), 13);
    expect(logBetaBinomial(2, 5, 2, 3)).toBeCloseTo(-1.435084525289323, 13);
    expect(logBetaBinomial(37, 100, 5.5, 12.25)).toBeCloseTo(-3.6153924641904585, 11);
    expect(logBetaBinomial(1234, 1e6, 20, 19980)).toBeCloseTo(-7.0171701308481715, 7);
  });

  it('is uniform for a = b = 1 and sums to 1 over the support', () => {
    for (let x = 0; x <= 10; x++) expect(logBetaBinomial(x, 10, 1, 1)).toBeCloseTo(-Math.log(11), 13);
    let total = 0;
    for (let x = 0; x <= 40; x++) total += Math.exp(logBetaBinomial(x, 40, 3.7, 0.9));
    expect(total).toBeCloseTo(1, 12);
  });

  it('tends to the binomial as the prior strength grows', () => {
    // binom.logpmf(7, 50, 0.13) = -1.8502906197577307
    const m = 1e9;
    expect(logBetaBinomial(7, 50, m * 0.13, m * 0.87)).toBeCloseTo(-1.8502906197577307, 5);
  });

  it('handles the edges of the support', () => {
    expect(logBetaBinomial(-1, 10, 2, 2)).toBe(-Infinity);
    expect(logBetaBinomial(11, 10, 2, 2)).toBe(-Infinity);
    expect(logBetaBinomial(0, 10, 0, 2)).toBe(0);
    expect(logBetaBinomial(3, 10, 0, 2)).toBe(-Infinity);
    expect(logBetaBinomial(10, 10, 2, 0)).toBe(0);
  });
});

describe('pava (test 12, the PAVA part)', () => {
  it('pools the spec example into a non-increasing fit and keeps the weighted sum', () => {
    const y = [0.3, 0.15, 0.18, 0.08, 0.1, 0.05];
    const w = [1, 1, 1, 1, 1, 1];
    const fit = pava(y, w, 'decreasing');
    const want = [0.3, 0.165, 0.165, 0.09, 0.09, 0.05];
    fit.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    expect(dot(w, fit)).toBeCloseTo(dot(w, y), 12);
  });

  it('uses the weights', () => {
    // Increasing: 3 (w 1) and 2 (w 2) pool to (3 + 4) / 3.
    const fit = pava([1, 3, 2], [1, 1, 2], 'increasing');
    expect(fit[0]).toBe(1);
    expect(fit[1]).toBeCloseTo(7 / 3, 12);
    expect(fit[2]).toBeCloseTo(7 / 3, 12);
    // Decreasing: 0.1 (w 3) and 0.2 (w 1) pool to 0.5 / 4.
    const dec = pava([0.4, 0.1, 0.2], [1, 3, 1], 'decreasing');
    expect(dec[0]).toBe(0.4);
    expect(dec[1]).toBeCloseTo(0.125, 12);
    expect(dec[2]).toBeCloseTo(0.125, 12);
  });

  it('matches the max-min formula on random inputs, in both directions', () => {
    // For the non-decreasing fit, fit_i = max_{j <= i} min_{k >= i} weighted mean of y[j..k].
    const maxMin = (y: number[], w: number[]): number[] =>
      y.map((_, i) => {
        let best = -Infinity;
        for (let j = 0; j <= i; j++) {
          let worst = Infinity;
          for (let k = i; k < y.length; k++) {
            let sw = 0;
            let swy = 0;
            for (let t = j; t <= k; t++) {
              sw += w[t];
              swy += w[t] * y[t];
            }
            worst = Math.min(worst, swy / sw);
          }
          best = Math.max(best, worst);
        }
        return best;
      });
    const rng = testRng(12);
    for (let rep = 0; rep < 200; rep++) {
      const n = 1 + Math.floor(rng() * 12);
      const y = Array.from({ length: n }, () => rng());
      const w = Array.from({ length: n }, () => 0.1 + rng() * 5);
      const inc = pava(y, w, 'increasing');
      const ref = maxMin(y, w);
      inc.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 10));
      expect(isNonDecreasing(inc)).toBe(true);
      const dec = pava(y, w, 'decreasing');
      const refDec = maxMin(y.map((v) => -v), w).map((v) => -v);
      dec.forEach((v, i) => expect(v).toBeCloseTo(refDec[i], 10));
      expect(isNonIncreasing(dec)).toBe(true);
      expect(dot(w, dec)).toBeCloseTo(dot(w, y), 10);
      expect(dot(w, inc)).toBeCloseTo(dot(w, y), 10);
    }
  });

  it('leaves monotone input alone, is idempotent, and handles empty and bad input', () => {
    expect(pava([5, 4, 4, 1], [1, 2, 3, 4], 'decreasing')).toEqual([5, 4, 4, 1]);
    const once = pava([0.2, 0.5, 0.1, 0.3], [1, 1, 1, 1], 'decreasing');
    expect(pava(once, [1, 1, 1, 1], 'decreasing')).toEqual(once);
    expect(pava([], [], 'increasing')).toEqual([]);
    expect(() => pava([1, 2], [1], 'increasing')).toThrow(RangeError);
    expect(() => pava([1, 2], [1, -1], 'increasing')).toThrow(RangeError);
    // A zero-weight point does not pull the pooled value.
    const z = pava([1, 5, 3], [1, 0, 1], 'increasing');
    expect(z).toEqual([1, 3, 3]);
  });
});

describe('quantile and percentileCi', () => {
  it('interpolates linearly between order statistics (type 7)', () => {
    const x = [1, 2, 3, 4];
    expect(quantile(x, 0)).toBe(1);
    expect(quantile(x, 1)).toBe(4);
    expect(quantile(x, 0.5)).toBe(2.5);
    expect(quantile(x, 0.25)).toBeCloseTo(1.75, 14);
    expect(quantile([7], 0.3)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
    expect(quantile([1, Infinity, Infinity], 0.9)).toBe(Infinity);
    expect(() => quantile(x, 1.5)).toThrow(RangeError);
    expect(() => quantile(x, Number.NaN)).toThrow(RangeError);
  });

  it('gives the 2.5% and 97.5% quantiles by default and ignores NaN', () => {
    const samples = Array.from({ length: 1001 }, (_, i) => 1000 - i); // unsorted on purpose
    const [lo, hi] = percentileCi(samples);
    expect(lo).toBeCloseTo(25, 9);
    expect(hi).toBeCloseTo(975, 9);
    const [lo90, hi90] = percentileCi([...samples, Number.NaN], 0.9);
    expect(lo90).toBeCloseTo(50, 9);
    expect(hi90).toBeCloseTo(950, 9);
    expect(percentileCi([])).toEqual([NaN, NaN]);
    expect(() => percentileCi(samples, 1)).toThrow(RangeError);
  });
});

describe('bootstrapP', () => {
  it('uses the (1 + count) / (B + 1) rule, two-sided', () => {
    expect(bootstrapP(Array.from({ length: 999 }, (_, i) => i + 1))).toBeCloseTo(0.002, 15);
    expect(bootstrapP(Array.from({ length: 999 }, (_, i) => -(i + 1)))).toBeCloseTo(0.002, 15);
    // le = 1, ge = 3, B = 4: 2 * min(2/5, 4/5) = 0.8
    expect(bootstrapP([-1, 1, 2, 3])).toBeCloseTo(0.8, 15);
    expect(bootstrapP([-1, 1])).toBe(1);
    expect(bootstrapP([])).toBe(1);
    // Zeros count on both sides; NaN is ignored.
    expect(bootstrapP([0, 0, 0, Number.NaN])).toBe(1);
  });
});

describe('benjaminiHochberg (test 22)', () => {
  it('returns q-values in input order and rejects 4 of 5 at q = 0.10', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005, 0.2]);
    const want = [0.025, 0.05, 0.05, 0.025, 0.2];
    q.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    expect(q.filter((v) => v <= 0.1)).toHaveLength(4);
  });

  it('is monotone in p, capped at 1, and passes NaN through', () => {
    const p = [0.9, 0.5, 0.95, 0.001, Number.NaN, 0.3];
    const q = benjaminiHochberg(p);
    expect(q[4]).toBeNaN();
    for (const v of q) if (!Number.isNaN(v)) expect(v).toBeLessThanOrEqual(1);
    const idx = [0, 1, 2, 3, 5].sort((a, b) => p[a] - p[b]);
    for (let r = 1; r < idx.length; r++) expect(q[idx[r]]).toBeGreaterThanOrEqual(q[idx[r - 1]]);
    // m = 5 valid values: smallest p 0.001 * 5 / 1 = 0.005.
    expect(q[3]).toBeCloseTo(0.005, 14);
    expect(benjaminiHochberg([])).toEqual([]);
    expect(benjaminiHochberg([0.04])).toEqual([0.04]);
  });
});

describe('kolmogorovTail (test 23)', () => {
  it('is 0.050 at 1.358', () => {
    expect(Math.abs(kolmogorovTail(1.358) - 0.05)).toBeLessThan(0.001);
  });

  it('matches reference values on both sides of the series switch', () => {
    const cases: [number, number][] = [
      [0.3, 0.9999906941986655],
      [0.5, 0.9639452436648751],
      [0.8, 0.5441424115741981],
      [1.0, 0.26999967167735456],
      [1.18, 0.1234538094297657],
      [1.358, 0.05002679733444698],
      [1.5, 0.022217962616525127],
      [2.0, 0.0006709252557796953],
      [3.0, 3.045995948942526e-8],
    ];
    for (const [k, want] of cases) expect(Math.abs(kolmogorovTail(k) - want)).toBeLessThan(1e-13);
    // The two series agree where they meet.
    expect(Math.abs(kolmogorovTail(1.18 - 1e-12) - kolmogorovTail(1.18))).toBeLessThan(1e-11);
  });

  it('is 1 at or below 0 and decreasing', () => {
    expect(kolmogorovTail(0)).toBe(1);
    expect(kolmogorovTail(-2)).toBe(1);
    let prev = 1;
    for (let k = 0.05; k < 4; k += 0.05) {
      const v = kolmogorovTail(k);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('chiSquareTail (Wilson-Hilferty)', () => {
  it('is close to the exact tail, tighter as df grows', () => {
    // Exact values from scipy.stats.chi2.sf; tolerances follow the approximation's known accuracy.
    expect(Math.abs(chiSquareTail(18.307038053275146, 10) - 0.05)).toBeLessThan(0.002);
    expect(Math.abs(chiSquareTail(5, 3) - 0.1717971442967335)).toBeLessThan(0.006);
    expect(Math.abs(chiSquareTail(30, 20) - 0.06985366069940986)).toBeLessThan(0.002);
    expect(Math.abs(chiSquareTail(100, 80) - 0.064570368921133)).toBeLessThan(0.001);
    expect(Math.abs(chiSquareTail(2, 5) - 0.8491450360846096)).toBeLessThan(0.003);
    expect(Math.abs(chiSquareTail(3.841458820694124, 1) - 0.05)).toBeLessThan(0.008);
  });

  it('handles the edges', () => {
    expect(chiSquareTail(0, 4)).toBe(1);
    expect(chiSquareTail(-1, 4)).toBe(1);
    expect(chiSquareTail(5, 0)).toBe(1);
    expect(chiSquareTail(Infinity, 4)).toBe(0);
    expect(chiSquareTail(Number.NaN, 4)).toBeNaN();
    expect(chiSquareTail(10, 4)).toBeLessThan(chiSquareTail(5, 4));
  });
});

describe('normalCdf and normalQuantile', () => {
  it('normalCdf matches reference values to better than 1e-9 (in fact about 1e-15)', () => {
    const cases: [number, number][] = [
      [-8, 6.22096057427174e-16],
      [-5, 2.8665157187919333e-7],
      [-3, 0.0013498980316300933],
      [-1.96, 0.024997895148220435],
      [-1, 0.15865525393145707],
      [0, 0.5],
      [0.5, 0.6914624612740131],
      [1, 0.8413447460685429],
      [2.5, 0.9937903346742238],
      [6, 0.9999999990134123],
    ];
    for (const [z, want] of cases) expect(Math.abs(normalCdf(z) - want)).toBeLessThan(1e-15);
  });

  it('keeps relative precision in the lower tail and is symmetric', () => {
    expect(Math.abs(normalCdf(-10) / 7.61985302416047e-24 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(normalCdf(-30) / 4.906713927147908e-198 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(normalCdf(-8) / 6.22096057427174e-16 - 1)).toBeLessThan(1e-12);
    for (let z = -6; z <= 6; z += 0.37) expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 15);
    expect(normalCdf(-Infinity)).toBe(0);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(Number.NaN)).toBeNaN();
  });

  it('normalQuantile matches reference values and inverts normalCdf', () => {
    const cases: [number, number][] = [
      [1e-10, -6.361340902404056],
      [1e-5, -4.264890793922825],
      [0.01, -2.3263478740408408],
      [0.02425, -1.972961051311885],
      [0.025, -1.9599639845400545],
      [0.3, -0.5244005127080409],
      [0.5, 0],
      [0.8, 0.8416212335729143],
      [0.975, 1.959963984540054],
      [0.99999, 4.264890793923841],
    ];
    for (const [p, want] of cases) expect(Math.abs(normalQuantile(p) - want)).toBeLessThan(1e-9);
    for (const p of [1e-300, 1e-200, 1e-50, 1e-12, 0.001, 0.1, 0.42, 0.5, 0.77, 0.999, 1 - 1e-9]) {
      const x = normalQuantile(p);
      expect(Number.isFinite(x)).toBe(true);
      if (p >= 1e-290) expect(Math.abs(normalCdf(x) / p - 1)).toBeLessThan(1e-9);
    }
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalQuantile(-0.1)).toBeNaN();
    expect(normalQuantile(1.1)).toBeNaN();
  });
});

describe('poissonDraw', () => {
  it('is deterministic for a fixed rng and returns whole numbers >= 0', () => {
    const a = Array.from({ length: 50 }, ((r) => () => poissonDraw(r, 7.5))(testRng(5)));
    const b = Array.from({ length: 50 }, ((r) => () => poissonDraw(r, 7.5))(testRng(5)));
    expect(a).toEqual(b);
    for (const v of a) expect(Number.isInteger(v) && v >= 0).toBe(true);
    expect(poissonDraw(testRng(1), 0)).toBe(0);
  });

  it('rejects a negative, NaN or infinite mean', () => {
    expect(() => poissonDraw(testRng(1), -1)).toThrow(RangeError);
    expect(() => poissonDraw(testRng(1), Number.NaN)).toThrow(RangeError);
    expect(() => poissonDraw(testRng(1), Infinity)).toThrow(RangeError);
  });

  it('has the right mean and variance for small and large lambda', () => {
    const n = 20000;
    for (const [lambda, seed] of [[0.3, 1], [2, 2], [9.99, 3], [10, 4], [25, 5], [150, 6], [1e4, 7], [2.5e6, 8]]) {
      const rng = testRng(seed);
      const x = Array.from({ length: n }, () => poissonDraw(rng, lambda));
      const { mean, variance } = meanVar(x);
      expect(Math.abs(mean - lambda)).toBeLessThan(4 * Math.sqrt(lambda / n));
      expect(Math.abs(variance / lambda - 1)).toBeLessThan(0.06);
    }
  });

  it('fits the exact Poisson pmf (chi-square goodness of fit) on both sides of the method switch', () => {
    const gof = (lambda: number, seed: number, lo: number, hi: number): number => {
      const n = 40000;
      const rng = testRng(seed);
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const k = Math.min(Math.max(poissonDraw(rng, lambda), lo), hi);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const pmf = (k: number): number => Math.exp(-lambda + k * Math.log(lambda) - lgamma(k + 1));
      let below = 0;
      for (let k = 0; k <= lo; k++) below += pmf(k);
      let inner = below;
      let stat = 0;
      const bins: number[] = [];
      for (let k = lo + 1; k < hi; k++) {
        inner += pmf(k);
        bins.push(k);
      }
      const expected = (k: number): number => (k === lo ? below : k === hi ? 1 - inner : pmf(k)) * n;
      for (const k of [lo, ...bins, hi]) stat += ((counts.get(k) ?? 0) - expected(k)) ** 2 / expected(k);
      return chiSquareTail(stat, bins.length + 1);
    };
    expect(gof(4, 11, 0, 12)).toBeGreaterThan(0.001);
    expect(gof(9.5, 12, 1, 22)).toBeGreaterThan(0.001);
    expect(gof(12, 13, 2, 26)).toBeGreaterThan(0.001);
    expect(gof(40, 14, 22, 60)).toBeGreaterThan(0.001);
  });
});

describe('mad and theilSen', () => {
  it('mad is the raw median absolute deviation', () => {
    // median 3; deviations 2, 1, 0, 1, 97; median 1.
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    // median 2.5; deviations 1.5, 0.5, 0.5, 1.5; median 1.
    expect(mad([4, 1, 3, 2])).toBe(1);
    expect(mad([5, 5, 5])).toBe(0);
    expect(mad([1, Number.NaN, 3])).toBe(1);
    expect(mad([])).toBeNaN();
  });

  it('theilSen recovers a line and ignores an outlier', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const line = theilSen(x, x.map((v) => 2 * v + 1));
    expect(line.slope).toBeCloseTo(2, 14);
    expect(line.intercept).toBeCloseTo(1, 14);
    // Pairwise slopes: six 1s, then 24.75, 32.67, 48.5, 96. Median 1; residuals 0, 0, 0, 0, 95, so intercept 0.
    const robust = theilSen([1, 2, 3, 4, 5], [1, 2, 3, 4, 100]);
    expect(robust.slope).toBe(1);
    expect(robust.intercept).toBe(0);
    expect(theilSen([3, 3, 3], [1, 2, 3]).slope).toBeNaN();
    expect(theilSen([1], [1]).slope).toBeNaN();
    expect(() => theilSen([1, 2], [1])).toThrow(RangeError);
  });
});

describe('dowFactors and seasonalSeries', () => {
  const f = [1.2, 1.15, 1.1, 1.05, 0.95, 0.75, 0.8]; // Monday first, mean 1

  it('recovers an exact weekday pattern, Monday first, aligned to the start date', () => {
    // 2026-10-07 is a Wednesday, so day 0 takes f[2].
    const start = '2026-10-07';
    const s = seasonalSeries(start, 70, f);
    expect(s[0]).toBe(f[2]);
    expect(s[5]).toBe(f[0]); // 2026-10-12 is a Monday
    const got = dowFactors(start, s.map((v) => 300 * v));
    got.forEach((v, i) => expect(v).toBeCloseTo(f[i], 12));
    expect(got.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 14);
  });

  it('puts a Sunday-only spike on the Sunday factor', () => {
    const start = '2026-10-05'; // a Monday
    const values = Array.from({ length: 56 }, (_, t) => (t % 7 === 6 ? 200 : 100));
    const got = dowFactors(start, values);
    expect(got[6]).toBeGreaterThan(got[0] * 1.5);
    for (let w = 0; w < 6; w++) expect(got[w]).toBeCloseTo(got[0], 12);
  });

  it('is close to the truth on noisy Poisson data', () => {
    const rng = testRng(21);
    const start = '2026-04-01';
    const means = seasonalSeries(start, 182, f).map((v) => 400 * v);
    const got = dowFactors(start, means.map((m) => poissonDraw(rng, m)));
    got.forEach((v, i) => expect(Math.abs(v / f[i] - 1)).toBeLessThan(0.04));
  });

  it('falls back to ones on a short or flat series, and never returns a zero factor', () => {
    expect(dowFactors('2026-10-05', [5, 5, 5, 5, 5, 5, 5, 5, 5])).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(dowFactors('2026-10-05', Array(60).fill(10))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // No traffic on Saturdays and Sundays at all.
    const weekdaysOnly = Array.from({ length: 84 }, (_, t) => (t % 7 >= 5 ? 0 : 10));
    const got = dowFactors('2026-10-05', weekdaysOnly);
    for (const v of got) expect(v).toBeGreaterThan(0);
    expect(got.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 14);
  });

  it('seasonalSeries validates its inputs', () => {
    expect(seasonalSeries('2026-10-05', 0, f)).toEqual([]);
    expect(() => seasonalSeries('2026-10-05', 3, [1, 1])).toThrow(RangeError);
    expect(() => seasonalSeries('2026-10-05', -1, f)).toThrow(RangeError);
    expect(() => seasonalSeries('5 Oct 2026', 3, f)).toThrow(RangeError);
  });
});

describe('overdispersion', () => {
  const f = [1.2, 1.15, 1.1, 1.05, 0.95, 0.75, 0.8];
  const start = '2026-04-06';
  const s = seasonalSeries(start, 182, f);

  it('is about 1 for Poisson data with a weekday pattern', () => {
    const rng = testRng(31);
    const phi = overdispersion(s.map((v) => poissonDraw(rng, 50 * v)), s);
    expect(phi).toBeGreaterThanOrEqual(1);
    expect(phi).toBeLessThan(1.3);
  });

  it('recovers phi = 3 for negative binomial data', () => {
    const rng = testRng(32);
    const phi = overdispersion(s.map((v) => negBinDraw(rng, 50 * v, 3)), s);
    expect(phi).toBeGreaterThan(2);
    expect(phi).toBeLessThan(4.5);
  });

  it('is never below 1 and handles degenerate input', () => {
    expect(overdispersion(Array(30).fill(20), Array(30).fill(1))).toBe(1);
    expect(overdispersion([], [])).toBe(1);
    expect(overdispersion([0, 0, 0], [1, 1, 1])).toBe(1);
    expect(() => overdispersion([1, 2], [1])).toThrow(RangeError);
  });
});

describe('periodCompare (test 21)', () => {
  // 20 weeks of constant daily values, s = 1. Week j's level is 100 * exp(r_1 + ... + r_j) for j <= 17;
  // week 18 (pre) repeats week 17 and week 19 (post) is exp(0.22) above it. The historical pairs are then
  // weeks (j-1, j) for j = 1..17, with log ratios exactly r_j. The r_j sum to 0, so week 17 sits at 100.
  const r = [0.1, -0.2, 0.3, -0.1, 0.05, -0.3, 0.2, -0.05, 0.15, -0.15, 0.25, -0.25, 0.12, -0.12, 0.4, -0.4, 0];
  const levels = [100];
  for (const v of r) levels.push(levels[levels.length - 1] * Math.exp(v));
  levels.push(levels[17], levels[17] * Math.exp(0.22));
  const values = levels.flatMap((l) => Array(7).fill(l) as number[]);
  const start = '2026-01-05'; // a Monday; day t is start + t
  const day = (t: number): string => {
    const d = new Date(Date.UTC(2026, 0, 5 + t));
    return d.toISOString().slice(0, 10);
  };
  const base: PeriodCompareInput = {
    values,
    start,
    pre: [day(126), day(132)],
    post: [day(133), day(139)],
    s: Array(140).fill(1),
    phi: 1,
    exclude: [],
    floor: 30,
    delta: 0.1,
    fdrQ: 0.1,
  };

  it('uses the empirical SE when it is larger, with freq from a hand count', () => {
    const e = periodCompare(base);
    expect(e.pre).toBeCloseTo(700, 9);
    expect(e.post).toBeCloseTo(700 * Math.exp(0.22), 9);
    expect(e.tau).toBeCloseTo(Math.exp(0.22) - 1, 12);
    // Sorted |r - median(r)| has median 0.15, so SE_emp = 1.4826 * 0.15 = 0.22239.
    // The quasi-Poisson SE is sqrt(1/700 + 1/872.5), about 0.051, so the empirical one wins.
    expect(e.seSource).toBe('empirical');
    expect(e.se).toBeCloseTo(0.22239, 10);
    // |r| >= 0.22 for 0.3, -0.3, 0.25, -0.25, 0.4, -0.4: 6 of 17.
    expect(e.freq).toBeCloseTo(6 / 17, 14);
    expect(e.ci95[0]).toBeCloseTo(-0.19417154974175077, 9);
    expect(e.ci95[1]).toBeCloseTo(0.9268458665287005, 9);
    expect(e.p).toBeCloseTo(0.32253931750071996, 9);
    expect(e.floorsMet).toBe(true);
    // A +25% move with a CI from -19% to +93% is too uncertain to call. Power comes from that CI:
    // SE = 0.22239, mde = 1 - exp(-2.8 SE), weeks = 1 * (2.8 SE / ln 1.1)^2 - 1 with T = 7/7 = 1 week.
    expect(e.real).toBe('underpowered');
    expect(e.reason).toBe('wide_ci');
    expect(e.power?.notMeasurable).toBe(false);
    expect(e.power?.mde).toBeCloseTo(0.4635017613741511, 9);
    expect(e.power?.weeksNeeded).toBeCloseTo(41.684283394690986, 6);
  });

  it('drops pairs that touch an excluded window', () => {
    // Excluding week 2 (days 14..20) removes pairs (1, 2) and (2, 3): r = -0.2 and 0.3. 5 of the 15 left have |r| >= 0.22.
    const e = periodCompare({ ...base, exclude: [[day(14), day(20)]] });
    expect(e.freq).toBeCloseTo(5 / 15, 14);
  });

  it('uses the quasi-Poisson SE when history is calm', () => {
    const flat = Array(140).fill(100) as number[];
    for (let t = 133; t < 140; t++) flat[t] = 80;
    const e = periodCompare({ ...base, values: flat });
    expect(e.seSource).toBe('quasi_poisson');
    expect(e.se).toBeCloseTo(Math.sqrt(1 / 700 + 1 / 560), 14);
    expect(e.freq).toBe(0);
    expect(e.tau).toBeCloseTo(-0.2, 14);
    const same = periodCompare({ ...base, values: Array(140).fill(100) as number[] });
    expect(same.tau).toBe(0);
    expect(same.freq).toBe(1);
    expect(same.p).toBe(1);
  });

  it('leaves freq null with fewer than 8 historical pairs', () => {
    // 112 days, 28-day windows at the end: only the pair ending on day 55 fits before the windows.
    const e = periodCompare({
      ...base,
      values: Array(112).fill(50) as number[],
      s: Array(112).fill(1),
      pre: [day(56), day(83)],
      post: [day(84), day(111)],
    });
    expect(e.freq).toBeNull();
    expect(e.seSource).toBe('quasi_poisson');
    expect(e.se).toBeCloseTo(Math.sqrt(2 / 1400), 14);
  });

  it('applies the floor and the phi scaling', () => {
    const thin = Array(140).fill(2) as number[];
    const e = periodCompare({ ...base, values: thin });
    expect(e.pre).toBe(14);
    expect(e.floorsMet).toBe(false);
    expect(e.real).toBe('underpowered');
    expect(e.reason).toBe('floors');
    expect(e.power).not.toBeNull();
    const flat = Array(140).fill(100) as number[];
    const e4 = periodCompare({ ...base, values: flat, phi: 4 });
    expect(e4.se).toBeCloseTo(2 * Math.sqrt(2 / 700), 14);
  });

  it('adjusts for weekday factors, so a pure weekday pattern gives tau = 0 on any window length', () => {
    const f = [1.3, 1.2, 1.1, 1, 0.9, 0.7, 0.8];
    const s = seasonalSeries(start, 140, f);
    const e = periodCompare({ ...base, values: s.map((v) => 90 * v), s, pre: [day(120), day(129)], post: [day(130), day(139)] });
    expect(e.tau).toBeCloseTo(0, 12);
    expect(e.real).toBe('noise');
  });

  it('calls a large, clean drop a signal', () => {
    const rng = testRng(41);
    const values2 = Array.from({ length: 182 }, (_, t) => poissonDraw(rng, t >= 154 ? 120 : 200));
    const e = periodCompare({
      ...base,
      values: values2,
      s: Array(182).fill(1),
      pre: [day(126), day(153)],
      post: [day(154), day(181)],
    });
    expect(e.tau).toBeLessThan(-0.35);
    expect(e.ci95[1]).toBeLessThan(0);
    expect(e.real).toBe('signal');
    expect(e.reason).toBe('signal');
    expect(e.power).toBeNull();
  });

  it('handles zero totals without NaN', () => {
    const zeros = Array(140).fill(0) as number[];
    const both = periodCompare({ ...base, values: zeros, floor: 0 });
    expect(both.tau).toBe(0);
    expect(both.se).toBe(Infinity);
    expect(both.ci95).toEqual([-1, Infinity]);
    expect(both.p).toBe(1);
    const gone = zeros.map((_, t) => (t < 133 ? 10 : 0));
    const g = periodCompare({ ...base, values: gone });
    expect(g.tau).toBe(-1);
    expect(g.p).toBe(1);
    expect(g.real).toBe('underpowered');
    const fresh = zeros.map((_, t) => (t >= 133 ? 10 : 0));
    const fr = periodCompare({ ...base, values: fresh, floor: 0 });
    expect(fr.tau).toBe(Infinity);
    expect(fr.p).toBe(1);
    expect(Number.isNaN(fr.ci95[0])).toBe(false);
  });

  it('rejects windows of different lengths or outside the series', () => {
    expect(() => periodCompare({ ...base, pre: [day(125), day(132)] })).toThrow(RangeError);
    expect(() => periodCompare({ ...base, post: [day(134), day(140)] })).toThrow(RangeError);
    expect(() => periodCompare({ ...base, s: [1, 1] })).toThrow(RangeError);
    expect(() => periodCompare({ ...base, phi: 0 })).toThrow(RangeError);
  });
});
