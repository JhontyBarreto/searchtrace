// GLM prior (IRLS), empirical-Bayes m, PAVA, interpolation, calibration, redraw (5.3). Owner: WP-E.
//
// The curve answers "what click rate would a search get at this position", per segment
// (device x brand class). Steps, per spec 5.3:
//   1. Bin day-level named cells by position: 1..10 one bin each, then 10.5-15.5, 15.5-20.5,
//      20.5-30.5, 30.5-50.5, 50.5-100. Per (segment, bin): clicks x, impressions n and the
//      impression-weighted centre.
//   2. Prior: binomial GLM, logit pi = a + g*desktop + h*brand + k*desktop*brand - b*ln(centre),
//      fitted by penalised IRLS (at most 25 iterations, tolerance 1e-8). If b < 0 it is refitted
//      with b = 0. A weak Gaussian prior (sd 3 on the logit scale) on the non-intercept terms keeps
//      sparse or separable data finite; it is negligible once a segment has real volume.
//   3. Prior strength m: the best of 40 log-spaced values in [20, 20000] by beta-binomial marginal likelihood.
//   4. Posterior mean (x + m pi) / (n + m), then 5. PAVA, non-increasing over bins within a segment.
//   6. f(p, g): linear in ln p between bin centres, flat beyond the end centres, floor 1e-5.
//   8. Calibration: refit on the fit window minus the holdout; a segment whose holdout clicks over
//      expected clicks (expected >= 30) falls outside [0.8, 1.25] is marked unstable.
//   9. redraw(rng): x* ~ Poisson(x) per bin with pi and m fixed, then steps 4 to 6 again.
import type { CtrCurve, CurveBin, CurveCell, IsoDate, Rng, Segment } from '../core/types.js';
import { logBetaBinomial, pava, poissonDraw } from './stats.js';

export const SEGMENTS: readonly Segment[] = ['desktop|brand', 'desktop|nonbrand', 'mobile|brand', 'mobile|nonbrand'];
export const BIN_EDGES: readonly (readonly [number, number])[] = [
  [1, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 4.5], [4.5, 5.5], [5.5, 6.5], [6.5, 7.5], [7.5, 8.5], [8.5, 9.5], [9.5, 10.5],
  [10.5, 15.5], [15.5, 20.5], [20.5, 30.5], [30.5, 50.5], [50.5, 100],
];
const NB = BIN_EDGES.length;
const NS = SEGMENTS.length;
const SIZE = NB * NS;
/** Every value of f is at least this. */
export const F_FLOOR = 1e-5;
const M_GRID = Array.from({ length: 40 }, (_, j) => 20 * 1000 ** (j / 39));
const GLM_MAX_ITER = 25;
const GLM_TOL = 1e-8;
/** Ridge on non-intercept GLM terms: a N(0, 3^2) prior on the logit scale. */
const GLM_RIDGE = 1 / 9;
const GLM_RIDGE_INTERCEPT = 1e-6;
const CALIBRATION_MIN_EXPECTED = 30;
const CALIBRATION_RANGE: [number, number] = [0.8, 1.25];
/** Used only when there is no data at all: pi(1) about 0.3, falling with position. */
const FALLBACK_THETA = [-0.85, 0, 0, 0, 1.2];

/** A day-level named cell; `date` lets the holdout calibration split it (cells without one only train). */
/** CurveCell carries an optional date (core/types.ts); kept as an alias for readability. */
export type DatedCurveCell = CurveCell;

export function segmentOf(device: 'desktop' | 'mobile', brand: boolean): Segment {
  return `${device}|${brand ? 'brand' : 'nonbrand'}`;
}

export function segIndex(seg: Segment): number {
  const i = SEGMENTS.indexOf(seg);
  if (i < 0) throw new RangeError(`Unknown segment ${String(seg)}`);
  return i;
}

const clampP = (p: number): number => (p > 100 ? 100 : p >= 1 ? p : 1);

/** Bin index 0..14 for a position (clamped to [1, 100]). */
export function binIndex(p: number): number {
  const q = clampP(p);
  if (q < 1.5) return 0;
  if (q < 10.5) return Math.floor(q + 0.5) - 1;
  if (q < 15.5) return 10;
  if (q < 20.5) return 11;
  if (q < 30.5) return 12;
  if (q < 50.5) return 13;
  return 14;
}

interface Agg { x: Float64Array; n: Float64Array; sp: Float64Array }

function aggregate(cells: DatedCurveCell[], keep: (c: DatedCurveCell) => boolean): Agg {
  const x = new Float64Array(SIZE);
  const n = new Float64Array(SIZE);
  const sp = new Float64Array(SIZE);
  for (const c of cells) {
    if (!keep(c)) continue;
    const idx = segIndex(c.seg) * NB + binIndex(c.p);
    x[idx] += c.c;
    n[idx] += c.i;
    sp[idx] += c.p * c.i;
  }
  for (let j = 0; j < SIZE; j++) if (x[j] > n[j]) x[j] = n[j];
  return { x, n, sp };
}

function centresOf(agg: Agg): Float64Array {
  const out = new Float64Array(SIZE);
  for (let j = 0; j < SIZE; j++) {
    const [lo, hi] = BIN_EDGES[j % NB];
    out[j] = agg.n[j] > 0 ? Math.min(hi, Math.max(lo, agg.sp[j] / agg.n[j])) : (lo + hi) / 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 2: the GLM prior
// ---------------------------------------------------------------------------

function log1pExp(eta: number): number {
  return eta > 0 ? eta + Math.log1p(Math.exp(-eta)) : Math.log1p(Math.exp(eta));
}

const sigmoid = (eta: number): number => (eta >= 0 ? 1 / (1 + Math.exp(-eta)) : Math.exp(eta) / (1 + Math.exp(eta)));

/** Solves A x = b for a small dense system by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (!(Math.abs(M[piv][col]) > 1e-300)) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * out[c];
    out[r] = s / M[r][r];
  }
  return out.every(Number.isFinite) ? out : null;
}

interface GlmRow { f: number[]; y: number; n: number }

/** Penalised binomial IRLS (Newton with step halving). Returns the coefficients and the iterations used. */
export function irlsBinomial(rows: GlmRow[], ridge: number[], start: number[]): { theta: number[]; iterations: number; converged: boolean } {
  const d = start.length;
  let theta = [...start];
  const penLik = (t: number[]): number => {
    let s = 0;
    for (const r of rows) {
      let eta = 0;
      for (let j = 0; j < d; j++) eta += r.f[j] * t[j];
      s += r.y * eta - r.n * log1pExp(eta);
    }
    for (let j = 0; j < d; j++) s -= 0.5 * ridge[j] * t[j] * t[j];
    return s;
  };
  let current = penLik(theta);
  for (let it = 1; it <= GLM_MAX_ITER; it++) {
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    const g = new Array<number>(d).fill(0);
    for (const r of rows) {
      let eta = 0;
      for (let j = 0; j < d; j++) eta += r.f[j] * theta[j];
      const pi = sigmoid(eta);
      const w = r.n * pi * (1 - pi);
      const resid = r.y - r.n * pi;
      for (let j = 0; j < d; j++) {
        g[j] += r.f[j] * resid;
        for (let k = 0; k <= j; k++) H[j][k] += w * r.f[j] * r.f[k];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) H[k][j] = H[j][k];
      H[j][j] += ridge[j];
      g[j] -= ridge[j] * theta[j];
    }
    const delta = solve(H, g);
    if (!delta) return { theta, iterations: it, converged: false };
    let step = 1;
    let next = theta.map((v, j) => v + delta[j]);
    let lik = penLik(next);
    for (let h = 0; h < 30 && !(lik >= current - 1e-12); h++) {
      step /= 2;
      next = theta.map((v, j) => v + step * delta[j]);
      lik = penLik(next);
    }
    const moved = Math.max(...delta.map((v) => Math.abs(v * step)));
    if (lik >= current - 1e-12) {
      theta = next;
      current = lik;
    }
    if (moved < GLM_TOL) return { theta, iterations: it, converged: true };
  }
  return { theta, iterations: GLM_MAX_ITER, converged: false };
}

function features(j: number, centre: number, withBeta: boolean): number[] {
  const g = Math.floor(j / NB);
  const desktop = g === 0 || g === 1 ? 1 : 0;
  const brand = g === 0 || g === 2 ? 1 : 0;
  const f = [1, desktop, brand, desktop * brand];
  if (withBeta) f.push(-Math.log(centre));
  return f;
}

/** The GLM prior pi per (segment, bin), with beta >= 0. */
export function fitPrior(x: Float64Array, n: Float64Array, centres: Float64Array): { pi: Float64Array; theta: number[] } {
  let totX = 0;
  let totN = 0;
  for (let j = 0; j < SIZE; j++) {
    totX += x[j];
    totN += n[j];
  }
  let theta: number[];
  if (!(totN > 0)) {
    theta = [...FALLBACK_THETA];
  } else {
    const rate = Math.min(1 - 1e-6, Math.max(1e-6, totX / totN));
    const a0 = Math.log(rate / (1 - rate));
    const rows = (withBeta: boolean): GlmRow[] => {
      const out: GlmRow[] = [];
      for (let j = 0; j < SIZE; j++) if (n[j] > 0) out.push({ f: features(j, centres[j], withBeta), y: x[j], n: n[j] });
      return out;
    };
    const ridge5 = [GLM_RIDGE_INTERCEPT, GLM_RIDGE, GLM_RIDGE, GLM_RIDGE, GLM_RIDGE];
    const full = irlsBinomial(rows(true), ridge5, [a0, 0, 0, 0, 0]);
    if (full.theta[4] >= 0) theta = full.theta;
    else theta = [...irlsBinomial(rows(false), ridge5.slice(0, 4), [a0, 0, 0, 0]).theta, 0];
  }
  const pi = new Float64Array(SIZE);
  for (let j = 0; j < SIZE; j++) {
    const f = features(j, centres[j], true);
    let eta = 0;
    for (let k = 0; k < 5; k++) eta += f[k] * theta[k];
    pi[j] = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(eta)));
  }
  return { pi, theta };
}

/** Step 3: the m on the grid with the highest beta-binomial marginal likelihood (first one on ties). */
export function fitPriorStrength(x: Float64Array, n: Float64Array, pi: Float64Array): number {
  let best = M_GRID[0];
  let bestLik = -Infinity;
  for (const m of M_GRID) {
    let lik = 0;
    for (let j = 0; j < SIZE; j++) if (n[j] > 0) lik += logBetaBinomial(x[j], n[j], m * pi[j], m * (1 - pi[j]));
    if (lik > bestLik) {
      bestLik = lik;
      best = m;
    }
  }
  return best;
}

/** Steps 4 and 5: shrink each bin to the prior, then make each segment non-increasing in position. */
function posteriorFit(x: Float64Array, n: Float64Array, pi: Float64Array, m: number): Float64Array {
  const fit = new Float64Array(SIZE);
  for (let g = 0; g < NS; g++) {
    const y: number[] = [];
    const w: number[] = [];
    for (let k = 0; k < NB; k++) {
      const j = g * NB + k;
      y.push((x[j] + m * pi[j]) / (n[j] + m));
      w.push(n[j] + m);
    }
    const iso = pava(y, w, 'decreasing');
    for (let k = 0; k < NB; k++) fit[g * NB + k] = Math.max(F_FLOOR, iso[k]);
  }
  return fit;
}

// ---------------------------------------------------------------------------
// Curve objects and the interpolation basis
// ---------------------------------------------------------------------------

interface CurveState {
  x: Float64Array;
  n: Float64Array;
  centres: Float64Array;
  lnc: Float64Array;
  prior: Float64Array;
  m: number;
  fit: Float64Array;
  unstable: Segment[];
  fitWindow: [IsoDate, IsoDate];
}

const STATES = new WeakMap<CtrCurve, CurveState>();

/** Interpolation weights of p within a segment: f = w0 * fit[i0] + w1 * fit[i1]. */
function weightsIn(lnc: Float64Array, g: number, p: number): [number, number, number, number] {
  const lp = Math.log(clampP(p));
  const base = g * NB;
  if (lp <= lnc[base]) return [base, base, 1, 0];
  if (lp >= lnc[base + NB - 1]) return [base + NB - 1, base + NB - 1, 1, 0];
  let k = 0;
  while (k < NB - 2 && lp > lnc[base + k + 1]) k++;
  const a = lnc[base + k];
  const b = lnc[base + k + 1];
  const t = b > a ? (lp - a) / (b - a) : 0;
  return [base + k, base + k + 1, 1 - t, t];
}

function makeCurve(s: CurveState): CtrCurve {
  const f = (p: number, seg: Segment): number => {
    const [i0, i1, w0, w1] = weightsIn(s.lnc, segIndex(seg), p);
    return Math.max(F_FLOOR, w0 * s.fit[i0] + w1 * s.fit[i1]);
  };
  const fMix = (p: number, weights: Partial<Record<Segment, number>>): number => {
    let num = 0;
    let den = 0;
    for (const seg of SEGMENTS) {
      const w = weights[seg] ?? 0;
      if (w > 0) {
        num += w * f(p, seg);
        den += w;
      }
    }
    if (den > 0) return num / den;
    return (f(p, 'desktop|nonbrand') + f(p, 'mobile|nonbrand')) / 2;
  };
  const bins: CurveBin[] = [];
  for (let j = 0; j < SIZE; j++) {
    const [lo, hi] = BIN_EDGES[j % NB];
    bins.push({
      seg: SEGMENTS[Math.floor(j / NB)], lo, hi, center: s.centres[j], clicks: s.x[j], impressions: s.n[j], prior: s.prior[j], fit: s.fit[j],
    });
  }
  const curve: CtrCurve = {
    f,
    fMix,
    unstable: [...s.unstable],
    m: s.m,
    bins,
    fitWindow: [s.fitWindow[0], s.fitWindow[1]],
    redraw(rng: Rng): CtrCurve {
      const x = new Float64Array(SIZE);
      for (let j = 0; j < SIZE; j++) x[j] = s.x[j] > 0 ? Math.min(s.n[j], poissonDraw(rng, s.x[j])) : 0;
      return makeCurve({ ...s, x, fit: posteriorFit(x, s.n, s.prior, s.m) });
    },
  };
  STATES.set(curve, s);
  return curve;
}

/**
 * Fast evaluation for the waterfall bootstrap. Every curve from fitCurve (and its redraws) is a
 * linear function of its bin fits, so f(p, g) = w0 * fit[i0] + w1 * fit[i1] with weights fixed by p.
 * Returns null for curves not built here (tests may pass hand-made curves).
 */
export interface CurveBasis {
  readonly size: number;
  weights(p: number, seg: Segment): [number, number, number, number];
  /** The floored bin fits of this curve or of one of its redraws (same centres); null otherwise. */
  fitVector(curve: CtrCurve): Float64Array | null;
}

export function curveBasis(curve: CtrCurve): CurveBasis | null {
  const s = STATES.get(curve);
  if (!s) return null;
  return {
    size: SIZE,
    weights: (p, seg) => weightsIn(s.lnc, segIndex(seg), p),
    fitVector: (c) => {
      const o = STATES.get(c);
      return o && o.lnc === s.lnc ? o.fit : null;
    },
  };
}

function fitSteps(cells: DatedCurveCell[], keep: (c: DatedCurveCell) => boolean, fitWindow: [IsoDate, IsoDate]): CurveState {
  const agg = aggregate(cells, keep);
  const centres = centresOf(agg);
  const { pi } = fitPrior(agg.x, agg.n, centres);
  const m = fitPriorStrength(agg.x, agg.n, pi);
  return {
    x: agg.x,
    n: agg.n,
    centres,
    lnc: centres.map((c) => Math.log(c)),
    prior: pi,
    m,
    fit: posteriorFit(agg.x, agg.n, pi, m),
    unstable: [],
    fitWindow,
  };
}

const usable = (c: DatedCurveCell): boolean =>
  c.i > 0 && c.c >= 0 && Number.isFinite(c.p) && c.p >= 1 && c.p <= 100 && SEGMENTS.includes(c.seg);

/**
 * Fits the curve (5.3). Cells may carry a `date` (see DatedCurveCell): dated cells outside the fit
 * window are ignored, and dated cells on or after holdoutFrom form the calibration holdout.
 */
export function fitCurve(cellsIn: CurveCell[], o: { fitWindow: [IsoDate, IsoDate]; holdoutFrom: IsoDate }): CtrCurve {
  const cells: DatedCurveCell[] = cellsIn;
  const [from, to] = o.fitWindow;
  const inFit = (c: DatedCurveCell): boolean => usable(c) && (c.date === undefined || (c.date >= from && c.date <= to));
  const isHoldout = (c: DatedCurveCell): boolean => c.date !== undefined && c.date >= o.holdoutFrom;
  const state = fitSteps(cells, inFit, [from, to]);

  // Step 8: calibrate a curve fitted without the holdout against the holdout.
  const unstable: Segment[] = [];
  if (cells.some((c) => inFit(c) && isHoldout(c))) {
    const cal = makeCurve(fitSteps(cells, (c) => inFit(c) && !isHoldout(c), [from, to]));
    const obs = new Float64Array(NS);
    const exp = new Float64Array(NS);
    for (const c of cells) {
      if (!inFit(c) || !isHoldout(c)) continue;
      const g = segIndex(c.seg);
      obs[g] += c.c;
      exp[g] += c.i * cal.f(c.p, c.seg);
    }
    for (let g = 0; g < NS; g++) {
      if (exp[g] < CALIBRATION_MIN_EXPECTED) continue;
      const ratio = obs[g] / exp[g];
      if (ratio < CALIBRATION_RANGE[0] || ratio > CALIBRATION_RANGE[1]) unstable.push(SEGMENTS[g]);
    }
  }
  return makeCurve({ ...state, unstable });
}
