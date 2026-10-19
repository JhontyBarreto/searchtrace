// Shared numerics: lgamma, beta-binomial, PAVA, quantiles, bootstrap p, BH, Kolmogorov tail, chi-square tail,
// Poisson draw, MAD, Theil-Sen, normal cdf and quantile, DOW factors, overdispersion, periodCompare (5.4). Owner: WP-A.
//
// Every function is pure. Randomness only enters through an injected Rng; there is no clock.
// Conventions for awkward inputs, so callers can rely on them:
//   - Empty samples give NaN (quantile, mad) or [NaN, NaN] (percentileCi). NaN samples are ignored.
//   - Programming errors (mismatched lengths, a negative Poisson mean, windows outside the series) throw RangeError.
import type { IsoDate, PeriodCompareInput, PeriodEffect, Rng } from '../core/types.js';
import { decideVerdict } from './verdicts.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 for a calendar date. IsoDate is a plain calendar day, so UTC arithmetic is exact. */
function dayNumber(d: IsoDate): number {
  const m = ISO_DATE.exec(d);
  if (!m) throw new RangeError(`Expected a YYYY-MM-DD date, got "${d}"`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** Monday = 0 ... Sunday = 6. Day 0 (1970-01-01) was a Thursday. */
function weekdayOfDayNumber(n: number): number {
  return (((n + 3) % 7) + 7) % 7;
}

/** Ascending numeric copy without NaN values. */
function sortedCopy(x: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of x) if (!Number.isNaN(v)) out.push(v);
  return out.sort((a, b) => a - b);
}

function median(x: readonly number[]): number {
  return quantile(sortedCopy(x), 0.5);
}

function sumRange(x: readonly number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i <= to; i++) s += x[i];
  return s;
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

// ---------------------------------------------------------------------------
// Gamma and beta-binomial
// ---------------------------------------------------------------------------

// Lanczos approximation, g = 7, n = 9 (relative error around 1e-15 for x >= 0.5).
const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
const HALF_LOG_2PI = 0.91893853320467274178;

/** ln|Gamma(x)|. Infinity at 0 and the negative integers. */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x <= 0 && Number.isInteger(x)) return Infinity;
  if (x === 1 || x === 2) return 0;
  if (x < 0.5) {
    // Reflection: Gamma(x) * Gamma(1 - x) = pi / sin(pi x).
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return HALF_LOG_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function lbeta(a: number, b: number): number {
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}

/**
 * log P(X = x) for X ~ BetaBinomial(n, a, b). Works for non-integer x and n (the gamma-function form).
 * Outside 0..n the probability is 0, so the result is -Infinity. With a or b at 0 the
 * distribution is a point mass at 0 (a = 0) or at n (b = 0).
 */
export function logBetaBinomial(x: number, n: number, a: number, b: number): number {
  if (Number.isNaN(x) || Number.isNaN(n) || Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (x < 0 || x > n) return -Infinity;
  if (!(a > 0) || !(b > 0)) {
    if (a <= 0 && b <= 0) return NaN;
    if (a <= 0) return x === 0 ? 0 : -Infinity;
    return x === n ? 0 : -Infinity;
  }
  const lchoose = lgamma(n + 1) - lgamma(x + 1) - lgamma(n - x + 1);
  return lchoose + lbeta(x + a, n - x + b) - lbeta(a, b);
}

// ---------------------------------------------------------------------------
// Isotonic regression
// ---------------------------------------------------------------------------

/**
 * Weighted pool-adjacent-violators: the least-squares fit to y (weights w) that is
 * non-decreasing ('increasing') or non-increasing ('decreasing'). Preserves sum(w * y).
 * Weights must be finite and >= 0; a block whose weights are all 0 takes its plain mean.
 */
export function pava(y: number[], w: number[], direction: 'decreasing' | 'increasing'): number[] {
  const n = y.length;
  if (w.length !== n) throw new RangeError(`pava: y has ${n} values but w has ${w.length}`);
  const sign = direction === 'increasing' ? 1 : -1; // fit non-decreasing on sign * y
  const bw: number[] = [];
  const bwy: number[] = [];
  const bsum: number[] = [];
  const bcount: number[] = [];
  const mean = (k: number): number => (bw[k] > 0 ? bwy[k] / bw[k] : bsum[k] / bcount[k]);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    if (!(wi >= 0) || !Number.isFinite(wi)) throw new RangeError(`pava: weight ${i} must be finite and >= 0, got ${wi}`);
    const v = sign * y[i];
    bw.push(wi);
    bwy.push(wi * v);
    bsum.push(v);
    bcount.push(1);
    while (bw.length > 1 && mean(bw.length - 2) > mean(bw.length - 1)) {
      const last = bw.length - 1;
      bw[last - 1] += bw[last];
      bwy[last - 1] += bwy[last];
      bsum[last - 1] += bsum[last];
      bcount[last - 1] += bcount[last];
      bw.pop();
      bwy.pop();
      bsum.pop();
      bcount.pop();
    }
  }
  const out: number[] = [];
  for (let k = 0; k < bw.length; k++) {
    const m = sign * mean(k);
    for (let j = 0; j < bcount[k]; j++) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quantiles and bootstrap summaries
// ---------------------------------------------------------------------------

/**
 * Quantile of an ascending array with linear interpolation between order statistics
 * (Hyndman and Fan type 7, the R and NumPy default). Empty input gives NaN.
 */
export function quantile(sortedAsc: number[], q: number): number {
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile: q must be in [0, 1], got ${q}`);
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const a = sortedAsc[lo];
  const b = sortedAsc[hi];
  const frac = h - lo;
  if (frac === 0 || a === b) return a;
  return a + frac * (b - a);
}

/** Equal-tailed percentile interval, default 95% (the 2.5% and 97.5% quantiles). NaN samples are ignored. */
export function percentileCi(samples: number[], level = 0.95): [number, number] {
  if (!(level > 0 && level < 1)) throw new RangeError(`percentileCi: level must be in (0, 1), got ${level}`);
  const s = sortedCopy(samples);
  const tail = (1 - level) / 2;
  return [quantile(s, tail), quantile(s, 1 - tail)];
}

/**
 * Two-sided bootstrap p-value for "the statistic is 0", from replicates T*:
 * min(1, 2 * min((1 + #{T* <= 0}) / (B + 1), (1 + #{T* >= 0}) / (B + 1))). NaN replicates are ignored.
 */
export function bootstrapP(samples: number[]): number {
  let le = 0;
  let ge = 0;
  let b = 0;
  for (const t of samples) {
    if (Number.isNaN(t)) continue;
    b++;
    if (t <= 0) le++;
    if (t >= 0) ge++;
  }
  return Math.min(1, 2 * Math.min((1 + le) / (b + 1), (1 + ge) / (b + 1)));
}

/**
 * Benjamini-Hochberg adjusted p-values (q-values), returned in input order.
 * Reject at level Q where q <= Q. NaN entries stay NaN and do not count towards m.
 */
export function benjaminiHochberg(p: number[]): number[] {
  const order: number[] = [];
  for (let i = 0; i < p.length; i++) if (!Number.isNaN(p[i])) order.push(i);
  order.sort((a, b) => p[a] - p[b] || a - b);
  const m = order.length;
  const q = new Array<number>(p.length).fill(NaN);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const i = order[r];
    running = Math.min(running, (p[i] * m) / (r + 1));
    q[i] = running;
  }
  return q;
}

// ---------------------------------------------------------------------------
// Distribution tails
// ---------------------------------------------------------------------------

/** P(sup|B| > k) for a Brownian bridge B: the Kolmogorov distribution's upper tail. */
export function kolmogorovTail(k: number): number {
  if (Number.isNaN(k)) return NaN;
  if (k <= 0) return 1;
  if (k < 1.18) {
    // Small k: P(K <= k) = sqrt(2 pi) / k * sum_j exp(-(2j - 1)^2 pi^2 / (8 k^2)), which converges fast here.
    const f = (-Math.PI * Math.PI) / (8 * k * k);
    let s = 0;
    for (let j = 1; j <= 100; j++) {
      const t = Math.exp(f * (2 * j - 1) * (2 * j - 1));
      s += t;
      if (t <= 1e-17 * s || t === 0) break;
    }
    return Math.min(1, Math.max(0, 1 - (Math.sqrt(2 * Math.PI) / k) * s));
  }
  // Large k: 2 * sum_j (-1)^(j-1) exp(-2 j^2 k^2), summed until the term is negligible.
  let s = 0;
  for (let j = 1; j <= 100; j++) {
    const t = Math.exp(-2 * j * j * k * k);
    s += j % 2 === 1 ? t : -t;
    if (t < 1e-17) break;
  }
  return Math.min(1, Math.max(0, 2 * s));
}

/**
 * P(chi-square with df degrees of freedom > x), by the Wilson-Hilferty cube-root normal approximation.
 * x <= 0 gives 1. With no degrees of freedom there is nothing to test, so the result is 1.
 */
export function chiSquareTail(x: number, df: number): number {
  if (Number.isNaN(x) || Number.isNaN(df)) return NaN;
  if (x <= 0 || !(df > 0)) return 1;
  if (x === Infinity) return 0;
  const h = 2 / (9 * df);
  const z = (Math.cbrt(x / df) - (1 - h)) / Math.sqrt(h);
  return normalCdf(-z);
}

/**
 * Standard normal cdf by Hart's double-precision rational approximation (as given by West, 2005).
 * Absolute error is below 1e-14, and the lower tail keeps its relative precision.
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let c: number;
  if (x > 37) {
    c = 0;
  } else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let num = 3.52624965998911e-2 * x + 0.700383064443688;
      num = num * x + 6.37396220353165;
      num = num * x + 33.912866078383;
      num = num * x + 112.079291497871;
      num = num * x + 221.213596169931;
      num = num * x + 220.206867912376;
      let den = 8.83883476483184e-2 * x + 1.75566716318264;
      den = den * x + 16.064177579207;
      den = den * x + 86.7807322029461;
      den = den * x + 296.564248779674;
      den = den * x + 637.333633378831;
      den = den * x + 793.826512519948;
      den = den * x + 440.413735824752;
      c = (e * num) / den;
    } else {
      // Laplace continued fraction Q(x) = phi(x) / (x + 1/(x + 2/(x + 3/(x + ...)))). West truncates it
      // at depth 4; depth 20 keeps the far tail to about 1e-13 relative error, which normalQuantile relies on.
      let d = x;
      for (let k = 20; k >= 1; k--) d = x + k / d;
      c = e / d / SQRT_2PI;
    }
  }
  return z > 0 ? 1 - c : c;
}

// Acklam's rational approximation for the normal quantile, refined by one Halley step on normalCdf.
const ACK_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACK_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACK_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACK_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const ACK_LOW = 0.02425;

/** Inverse of normalCdf. 0 gives -Infinity, 1 gives Infinity, anything outside [0, 1] gives NaN. */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  // Work in the lower half, where normalCdf keeps relative precision. 1 - p is exact for p >= 0.5.
  if (p > 0.5) return -normalQuantile(1 - p);
  let x: number;
  if (p < ACK_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACK_C[0] * q + ACK_C[1]) * q + ACK_C[2]) * q + ACK_C[3]) * q + ACK_C[4]) * q + ACK_C[5]) /
      ((((ACK_D[0] * q + ACK_D[1]) * q + ACK_D[2]) * q + ACK_D[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((ACK_A[0] * r + ACK_A[1]) * r + ACK_A[2]) * r + ACK_A[3]) * r + ACK_A[4]) * r + ACK_A[5]) * q) /
      (((((ACK_B[0] * r + ACK_B[1]) * r + ACK_B[2]) * r + ACK_B[3]) * r + ACK_B[4]) * r + 1);
  }
  // One Halley step. Skipped below about 6e-300, where normalCdf underflows to 0 and would mislead the step.
  const cdf = normalCdf(x);
  if (cdf > 0) {
    const u = (cdf - p) * SQRT_2PI * Math.exp((x * x) / 2);
    if (Number.isFinite(u)) x -= u / (1 + (x * u) / 2);
  }
  return x;
}

// ---------------------------------------------------------------------------
// Poisson draws
// ---------------------------------------------------------------------------

/**
 * One draw from Poisson(lambda) using the injected rng. Exact for every lambda:
 * inversion by sequential search below 10, Hormann's PTRS transformed rejection from 10 up.
 */
export function poissonDraw(rng: Rng, lambda: number): number {
  if (!(lambda >= 0) || !Number.isFinite(lambda)) {
    throw new RangeError(`poissonDraw: lambda must be finite and >= 0, got ${lambda}`);
  }
  if (lambda === 0) return 0;
  if (lambda < 10) {
    const u = rng();
    let k = 0;
    let pk = Math.exp(-lambda);
    let cdf = pk;
    // The cap only matters if rounding stops cdf short of u; P(X > 200) is far below 1e-100 here.
    while (u >= cdf && k < 200) {
      k++;
      pk *= lambda / k;
      cdf += pk;
    }
    return k;
  }
  return poissonPtrs(rng, lambda);
}

/** W. Hormann (1993), "The transformed rejection method for generating Poisson random variables". */
function poissonPtrs(rng: Rng, lambda: number): number {
  const slam = Math.sqrt(lambda);
  const loglam = Math.log(lambda);
  const b = 0.931 + 2.53 * slam;
  const a = -0.059 + 0.02483 * b;
  const invalpha = 1.1239 + 1.1328 / (b - 3.4);
  const vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const u = rng() - 0.5;
    const v = rng();
    const us = 0.5 - Math.abs(u);
    const k = Math.floor(((2 * a) / us + b) * u + lambda + 0.43);
    if (us >= 0.07 && v <= vr) return k;
    if (k < 0 || (us < 0.013 && v > us)) continue;
    if (Math.log(v) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -lambda + k * loglam - lgamma(k + 1)) {
      return k;
    }
  }
}

// ---------------------------------------------------------------------------
// Robust summaries
// ---------------------------------------------------------------------------

/** Raw median absolute deviation, median(|x - median(x)|), unscaled. Empty input gives NaN. */
export function mad(x: number[]): number {
  const m = median(x);
  if (Number.isNaN(m)) return NaN;
  const dev: number[] = [];
  for (const v of x) if (!Number.isNaN(v)) dev.push(Math.abs(v - m));
  return median(dev);
}

/**
 * Theil-Sen line: slope = median of pairwise slopes over pairs with distinct x,
 * intercept = median(y - slope * x). With no such pair both are NaN.
 */
export function theilSen(x: number[], y: number[]): { slope: number; intercept: number } {
  if (x.length !== y.length) throw new RangeError(`theilSen: x has ${x.length} values but y has ${y.length}`);
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = x[j] - x[i];
      if (dx !== 0) slopes.push((y[j] - y[i]) / dx);
    }
  }
  if (slopes.length === 0) return { slope: NaN, intercept: NaN };
  const slope = median(slopes);
  const intercept = median(y.map((yi, i) => yi - slope * x[i]));
  return { slope, intercept };
}

// ---------------------------------------------------------------------------
// Day-of-week factors and overdispersion (5.6)
// ---------------------------------------------------------------------------

/** Lower bound on a raw weekday factor, so a weekday with almost no traffic never divides by zero downstream. */
const MIN_DOW_FACTOR = 0.01;

/**
 * Seven day-of-week factors, Monday first, normalised to mean 1.
 * ratio_t = y_t / (centred 7-day mean), interior days only; f_w = median ratio on weekday w.
 * If any weekday has no usable ratio (too little history), the result is all ones.
 */
export function dowFactors(start: IsoDate, values: number[]): number[] {
  const w0 = weekdayOfDayNumber(dayNumber(start));
  const ratios: number[][] = [[], [], [], [], [], [], []];
  for (let t = 3; t <= values.length - 4; t++) {
    const ma = sumRange(values, t - 3, t + 3) / 7;
    if (!(ma > 0)) continue;
    const r = values[t] / ma;
    if (Number.isFinite(r)) ratios[(w0 + t) % 7].push(r);
  }
  if (ratios.some((r) => r.length === 0)) return [1, 1, 1, 1, 1, 1, 1];
  const raw = ratios.map((r) => Math.max(median(r), MIN_DOW_FACTOR));
  const mean = raw.reduce((a, b) => a + b, 0) / 7;
  return raw.map((f) => f / mean);
}

/** s_t = f[weekday(start + t)] for t = 0 .. n-1, with f Monday first. */
export function seasonalSeries(start: IsoDate, n: number, f: number[]): number[] {
  if (f.length !== 7) throw new RangeError(`seasonalSeries: expected 7 factors, got ${f.length}`);
  if (!(n >= 0) || !Number.isInteger(n)) throw new RangeError(`seasonalSeries: n must be a whole number >= 0, got ${n}`);
  const w0 = weekdayOfDayNumber(dayNumber(start));
  const out = new Array<number>(n);
  for (let t = 0; t < n; t++) out[t] = f[(w0 + t) % 7];
  return out;
}

/**
 * Quasi-Poisson dispersion phi-hat >= 1 (5.6):
 * m_t = s_t * mean over u in [t-7, t+7] of y_u / s_u; r_t = (y_t - m_t) / sqrt(m_t), skipping m_t = 0;
 * phi = max(1, (1.4826 * MAD(r))^2). Too little data gives 1.
 */
export function overdispersion(values: number[], s: number[]): number {
  const n = values.length;
  if (s.length !== n) throw new RangeError(`overdispersion: ${n} values but ${s.length} seasonal factors`);
  const adj = values.map((y, t) => (s[t] > 0 ? y / s[t] : NaN));
  const r: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!(s[t] > 0) || !Number.isFinite(values[t])) continue;
    let sum = 0;
    let count = 0;
    for (let u = Math.max(0, t - 7); u <= Math.min(n - 1, t + 7); u++) {
      if (Number.isFinite(adj[u])) {
        sum += adj[u];
        count++;
      }
    }
    if (count === 0) continue;
    const m = (s[t] * sum) / count;
    if (!(m > 0)) continue;
    r.push((values[t] - m) / Math.sqrt(m));
  }
  if (r.length === 0) return 1;
  const k = 1.4826 * mad(r);
  return Number.isFinite(k) ? Math.max(1, k * k) : 1;
}

// ---------------------------------------------------------------------------
// Period comparison (5.4)
// ---------------------------------------------------------------------------

/** Minimum number of historical window pairs before the empirical SE is trusted. */
const MIN_EMPIRICAL_PAIRS = 8;

/**
 * Seasonally adjusted rate ratio of post versus pre (5.4), with SE = max(quasi-Poisson SE,
 * empirical SE from historical same-length window pairs), a 95% CI, a two-sided p and a verdict
 * decided with q = p and no identification checks. Callers in a BH family, or with identification
 * checks, call decideVerdict again with their own q and checks.
 *
 * With a zero total on either side the SE is infinite: ci95 = [-1, Infinity] and p = 1.
 * A zero pre total with a positive post total gives tau = Infinity; both zero gives tau = 0.
 */
export function periodCompare(i: PeriodCompareInput): PeriodEffect {
  const y = i.values;
  const n = y.length;
  if (i.s.length !== n) throw new RangeError(`periodCompare: ${n} values but ${i.s.length} seasonal factors`);
  if (!(i.phi > 0) || !Number.isFinite(i.phi)) throw new RangeError(`periodCompare: phi must be finite and > 0, got ${i.phi}`);

  const origin = dayNumber(i.start);
  const idx = (d: IsoDate): number => dayNumber(d) - origin;
  const pre0 = idx(i.pre[0]);
  const pre1 = idx(i.pre[1]);
  const post0 = idx(i.post[0]);
  const post1 = idx(i.post[1]);
  const len = pre1 - pre0 + 1;
  if (len < 1 || post1 - post0 + 1 !== len) {
    throw new RangeError(`periodCompare: pre and post must have the same positive length (${i.pre.join('..')} vs ${i.post.join('..')})`);
  }
  if (pre0 < 0 || post0 < 0 || pre1 > n - 1 || post1 > n - 1) {
    throw new RangeError(`periodCompare: windows must lie inside the series ${i.start} + ${n} days`);
  }

  const A = sumRange(y, pre0, pre1);
  const B = sumRange(y, post0, post1);
  const Sa = sumRange(i.s, pre0, pre1);
  const Sb = sumRange(i.s, post0, post1);
  if (!(Sa > 0) || !(Sb > 0)) throw new RangeError('periodCompare: seasonal factors must be positive');

  let R: number;
  if (A > 0 && B > 0) R = B / Sb / (A / Sa);
  else if (A <= 0 && B <= 0) R = 1;
  else R = A <= 0 ? Infinity : 0;
  const lnR = Math.log(R);
  const tau = R - 1;
  const seQp = A > 0 && B > 0 ? Math.sqrt(i.phi * (1 / A + 1 / B)) : Infinity;

  // Empirical null: same-length window pairs ending every 7 days back from the last day of the series.
  const spanFrom = Math.min(pre0, post0);
  const spanTo = Math.max(pre1, post1);
  const excluded = i.exclude.map(([a, b]) => {
    const x = idx(a);
    const z = idx(b);
    return [Math.min(x, z), Math.max(x, z)] as const;
  });
  // A historical pair counts only when both of its windows meet the same floor as the comparison
  // itself: pairs from a much quieter era carry extra counting noise and would inflate the spread.
  const pairFloor = Math.max(i.floor, Number.MIN_VALUE);
  const collect = (skipExcluded: boolean): number[] => {
    const out: number[] = [];
    for (let e = n - 1; e - 2 * len + 1 >= 0; e -= 7) {
      const first0 = e - 2 * len + 1;
      const first1 = e - len;
      const second0 = e - len + 1;
      if (overlaps(first0, e, spanFrom, spanTo)) continue;
      if (skipExcluded && excluded.some(([x, z]) => overlaps(first0, e, x, z))) continue;
      const y1 = sumRange(y, first0, first1);
      const y2 = sumRange(y, second0, e);
      const s1 = sumRange(i.s, first0, first1);
      const s2 = sumRange(i.s, second0, e);
      if (!(y1 >= pairFloor) || !(y2 >= pairFloor) || !(s1 > 0) || !(s2 > 0)) continue;
      out.push(Math.log(y2 / s2 / (y1 / s1)));
    }
    return out;
  };
  // Update windows are left out of the null so it describes ordinary weeks. When Google ships
  // updates so often that fewer than MIN_EMPIRICAL_PAIRS ordinary pairs remain (2025 to 2026 had
  // one every few weeks), the SE still uses every pair rather than fall back to the quasi-Poisson
  // SE alone: that SE ignores week-to-week swings and, on a real small site, was 2 to 8 times too
  // narrow. A robust (MAD) spread over the mixture widens only modestly from update tails, so this
  // mostly protects the SE when ordinary months are noisy.
  //
  // The "swings this size happen about 1 in N four-week periods" frequency is different: it counts
  // tails, and update periods are exactly the tails. So it only ever comes from ordinary pairs, and
  // is null (no sentence) when fewer than MIN_EMPIRICAL_PAIRS of them exist. Pairs end every 7 days,
  // so K overlapping pairs are worth about K * 7 / (2 * len) independent ones; overlap does not bias
  // a frequency, it only makes it noisier.
  const ordinary = collect(true);
  const r = ordinary.length < MIN_EMPIRICAL_PAIRS && excluded.length > 0 ? collect(false) : ordinary;
  const K = r.length;
  let seEmp: number | null = null;
  let freq: number | null = null;
  if (K >= MIN_EMPIRICAL_PAIRS) seEmp = 1.4826 * mad(r);
  if (ordinary.length >= MIN_EMPIRICAL_PAIRS) {
    const size = Math.abs(lnR);
    freq = ordinary.filter((v) => Math.abs(v) >= size).length / ordinary.length;
  }
  const useEmpirical = seEmp !== null && seEmp > seQp;
  const se = useEmpirical ? (seEmp as number) : seQp;

  let ci95: [number, number];
  let p: number;
  if (Number.isFinite(se) && Number.isFinite(lnR)) {
    ci95 = [Math.exp(lnR - 1.96 * se) - 1, Math.exp(lnR + 1.96 * se) - 1];
    p = se > 0 ? 2 * normalCdf(-Math.abs(lnR) / se) : lnR === 0 ? 1 : 0;
  } else {
    ci95 = [-1, Infinity];
    p = 1;
  }

  const floorsMet = A >= i.floor;
  const verdict = decideVerdict({
    estimate: tau,
    ci95,
    floorsMet,
    identification: [],
    q: p,
    delta: i.delta,
    fdrQ: i.fdrQ,
    weeksObserved: len / 7,
    counts: { pre: A, post: B, phi: i.phi },
  });

  return {
    pre: A,
    post: B,
    tau,
    ci95,
    p,
    se,
    seSource: useEmpirical ? 'empirical' : 'quasi_poisson',
    freq,
    floorsMet,
    real: verdict.verdict,
    reason: verdict.reason,
    power: verdict.power,
  };
}
