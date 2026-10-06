// CTR curve: bins, GLM prior, empirical-Bayes m, PAVA, interpolation, calibration, redraw (spec 5.3; tests 12 to 17). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import type { Segment } from '../../src/core/types.js';
import {
  BIN_EDGES, SEGMENTS, binIndex, curveBasis, fitCurve, fitPrior, fitPriorStrength, irlsBinomial, type DatedCurveCell,
} from '../../src/analyze/ctr-curve.js';
import { binomialOne, gammaDraw, testRng } from '../helpers/index.js';

const FIT: [string, string] = ['2026-03-08', '2026-09-05'];
const HOLDOUT = '2026-08-09';
const truth = (p: number): number => 0.3 * p ** -1.2;

/**
 * Day cells for positions 1..10 (100 days each). Position-1 cells sit at exactly 1, as they do in
 * Search Console; deeper ones jitter by up to 0.3 around the integer.
 */
function powerCells(seed: string, impressionsPerPosition: number, seg: Segment = 'desktop|nonbrand', f = truth): DatedCurveCell[] {
  const rng = testRng(seed);
  const cells: DatedCurveCell[] = [];
  const i = Math.round(impressionsPerPosition / 100);
  for (let pos = 1; pos <= 10; pos++) {
    for (let k = 0; k < 100; k++) {
      const p = pos === 1 ? 1 : pos + (rng() - 0.5) * 0.6;
      cells.push({ p, i, c: binomialOne(rng, i, f(p)), seg, date: addDays(FIT[0], k) });
    }
  }
  return cells;
}

describe('bins', () => {
  it('assigns positions to the 15 bins of 5.3', () => {
    expect(BIN_EDGES.length).toBe(15);
    expect(binIndex(1)).toBe(0);
    expect(binIndex(1.49)).toBe(0);
    expect(binIndex(1.5)).toBe(1);
    expect(binIndex(10.49)).toBe(9);
    expect(binIndex(10.5)).toBe(10);
    expect(binIndex(15.5)).toBe(11);
    expect(binIndex(20.5)).toBe(12);
    expect(binIndex(30.5)).toBe(13);
    expect(binIndex(50.5)).toBe(14);
    expect(binIndex(100)).toBe(14);
    expect(binIndex(0.2)).toBe(0);
  });
});

describe('fitCurve', () => {
  it('12. PAVA: random inputs give non-increasing bin fits, and f is non-increasing in p', () => {
    for (let t = 0; t < 20; t++) {
      const rng = testRng(`curve:pava:${t}`);
      const cells: DatedCurveCell[] = [];
      for (let n = 0; n < 300; n++) {
        const p = 1 + rng() * 40;
        const i = 1 + Math.floor(rng() * 60);
        cells.push({ p, i, c: Math.floor(rng() * i * 0.5), seg: SEGMENTS[Math.floor(rng() * 4)] });
      }
      const curve = fitCurve(cells, { fitWindow: FIT, holdoutFrom: HOLDOUT });
      for (const seg of SEGMENTS) {
        const fits = curve.bins.filter((b) => b.seg === seg).map((b) => b.fit);
        for (let k = 1; k < fits.length; k++) expect(fits[k]).toBeLessThanOrEqual(fits[k - 1] + 1e-15);
        let prev = Infinity;
        for (let p = 1; p <= 100; p += 0.37) {
          const v = curve.f(p, seg);
          expect(v).toBeLessThanOrEqual(prev + 1e-15);
          expect(v).toBeGreaterThanOrEqual(1e-5);
          prev = v;
        }
      }
    }
  });

  it('13. shrinkage: a bin with no impressions returns the prior; 1e6 impressions return the raw rate', () => {
    const cells: DatedCurveCell[] = [];
    for (let k = 0; k < 10; k++) {
      const p = k + 1;
      cells.push({ p, i: 1e6, c: Math.round(1e6 * truth(p)), seg: 'desktop|nonbrand' });
    }
    const curve = fitCurve(cells, { fitWindow: FIT, holdoutFrom: HOLDOUT });
    for (const b of curve.bins) {
      if (b.seg === 'mobile|brand') expect(b.fit).toBeCloseTo(b.prior, 12);
      if (b.seg === 'desktop|nonbrand' && b.impressions === 1e6) expect(Math.abs(b.fit - b.clicks / b.impressions)).toBeLessThan(1e-3);
    }
  });

  // 50k impressions at each position. With 50k in total (5k per position) the raw noise at
  // position 10 alone is about 10% and the logit-linear prior misses a pure power law near
  // position 1, so recovery is only within about 20% there (see docs/METHODOLOGY.md).
  it('14. recovery: f*(p) = 0.3 p^-1.2 from 50k impressions per position is within 10% for p <= 10', () => {
    const curve = fitCurve(powerCells('curve:recovery', 50_000), { fitWindow: FIT, holdoutFrom: HOLDOUT });
    for (let p = 1; p <= 10; p++) {
      const ratio = curve.f(p, 'desktop|nonbrand') / truth(p);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('15. marginal likelihood: data drawn with m = 500 gives m-hat in [200, 1250]', () => {
    const rng = testRng('curve:m');
    const theta = [-0.9, 0.2, 1.1, 0.1, 1.1];
    const cells: DatedCurveCell[] = [];
    SEGMENTS.forEach((seg, g) => {
      const desktop = g === 0 || g === 1 ? 1 : 0;
      const brand = g === 0 || g === 2 ? 1 : 0;
      for (const [lo, hi] of BIN_EDGES) {
        const centre = (lo + hi) / 2;
        const eta = theta[0] + theta[1] * desktop + theta[2] * brand + theta[3] * desktop * brand - theta[4] * Math.log(centre);
        const pi = 1 / (1 + Math.exp(-eta));
        const a = gammaDraw(rng, 500 * pi, 1);
        const b = gammaDraw(rng, 500 * (1 - pi), 1);
        const rate = a / (a + b);
        const n = 20_000;
        cells.push({ p: centre, i: n, c: binomialOne(rng, n, rate), seg });
      }
    });
    const curve = fitCurve(cells, { fitWindow: FIT, holdoutFrom: HOLDOUT });
    expect(curve.m).toBeGreaterThanOrEqual(200);
    expect(curve.m).toBeLessThanOrEqual(1250);
  });

  it('16. the GLM converges on sparse, near-separable data with beta >= 0', () => {
    const x = new Float64Array(60);
    const n = new Float64Array(60);
    const centres = new Float64Array(60);
    BIN_EDGES.forEach(([lo, hi], k) => {
      for (let g = 0; g < 4; g++) centres[g * 15 + k] = (lo + hi) / 2;
    });
    // Every impression at position 1 clicked, nothing clicked anywhere else.
    n[15] = 3;
    x[15] = 3;
    n[16] = 2;
    n[20] = 1;
    const { pi, theta } = fitPrior(x, n, centres);
    expect(theta.every(Number.isFinite)).toBe(true);
    expect(theta[4]).toBeGreaterThanOrEqual(0);
    for (const v of pi) expect(v).toBeGreaterThan(0);
    const m = fitPriorStrength(x, n, pi);
    expect(m).toBeGreaterThanOrEqual(20);
    expect(m).toBeLessThanOrEqual(20000);
    // Negative slope in the data refits with beta = 0.
    const up = irlsBinomial(
      [1, 2, 3, 4, 5].map((k) => ({ f: [1, 0, 0, 0, -Math.log(k)], y: 10 * k, n: 100 })),
      [1e-6, 1 / 9, 1 / 9, 1 / 9, 1 / 9],
      [0, 0, 0, 0, 0],
    );
    expect(up.converged).toBe(true);
    expect(up.iterations).toBeLessThanOrEqual(25);
    const x2 = new Float64Array(60);
    const n2 = new Float64Array(60);
    for (let k = 0; k < 10; k++) {
      n2[15 + k] = 1000;
      x2[15 + k] = 10 + 10 * k;
    }
    expect(fitPrior(x2, n2, centres).theta[4]).toBe(0);
  });

  it('17. redraw is deterministic for a fixed rng, and its mean over 500 draws is within 2% of the fit', () => {
    const curve = fitCurve(powerCells('curve:redraw', 5_000), { fitWindow: FIT, holdoutFrom: HOLDOUT });
    const a = curve.redraw(testRng('redraw'));
    const b = curve.redraw(testRng('redraw'));
    expect(a.bins.map((x) => x.fit)).toEqual(b.bins.map((x) => x.fit));
    const rng = testRng('redraw:mean');
    const pts = [1, 2, 3, 5, 8, 10];
    const sums = pts.map(() => 0);
    for (let r = 0; r < 500; r++) {
      const c = curve.redraw(rng);
      pts.forEach((p, k) => (sums[k] += c.f(p, 'desktop|nonbrand')));
    }
    pts.forEach((p, k) => {
      const mean = sums[k] / 500;
      expect(Math.abs(mean / curve.f(p, 'desktop|nonbrand') - 1)).toBeLessThan(0.02);
    });
    // The fast basis reads the same numbers as f.
    const basis = curveBasis(curve)!;
    const fit = basis.fitVector(a)!;
    const [i0, i1, w0, w1] = basis.weights(4.3, 'desktop|nonbrand');
    expect(w0 * fit[i0] + w1 * fit[i1]).toBeCloseTo(a.f(4.3, 'desktop|nonbrand'), 15);
  });

  it('marks a segment unstable when the holdout click rate drifts outside [0.8, 1.25] of the curve', () => {
    const train = powerCells('curve:cal:train', 4_000);
    const rng = testRng('curve:cal:holdout');
    const hold: DatedCurveCell[] = [];
    for (let k = 0; k < 28; k++) {
      for (let pos = 1; pos <= 5; pos++) hold.push({ p: pos, i: 200, c: binomialOne(rng, 200, Math.min(0.9, 1.6 * truth(pos))), seg: 'desktop|nonbrand', date: addDays(HOLDOUT, k) });
    }
    const unstable = fitCurve([...train, ...hold], { fitWindow: FIT, holdoutFrom: HOLDOUT });
    expect(unstable.unstable).toEqual(['desktop|nonbrand']);
    const steady: DatedCurveCell[] = hold.map((c) => ({ ...c, c: binomialOne(rng, c.i, truth(c.p)) }));
    expect(fitCurve([...train, ...steady], { fitWindow: FIT, holdoutFrom: HOLDOUT }).unstable).toEqual([]);
  });

  it('fMix averages segments by weight and ignores cells outside the fit window', () => {
    const cells = powerCells('curve:mix', 2_000);
    const curve = fitCurve([...cells, { p: 1, i: 1e6, c: 0, seg: 'desktop|nonbrand', date: '2026-09-20' }], { fitWindow: FIT, holdoutFrom: HOLDOUT });
    const clean = fitCurve(cells, { fitWindow: FIT, holdoutFrom: HOLDOUT });
    expect(curve.f(1, 'desktop|nonbrand')).toBeCloseTo(clean.f(1, 'desktop|nonbrand'), 12);
    const d = curve.f(3, 'desktop|nonbrand');
    const m = curve.f(3, 'mobile|nonbrand');
    expect(curve.fMix(3, { 'desktop|nonbrand': 3, 'mobile|nonbrand': 1 })).toBeCloseTo((3 * d + m) / 4, 12);
    expect(curve.fMix(3, {})).toBeCloseTo((d + m) / 2, 12);
  });
});
