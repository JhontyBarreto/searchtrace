// Change points: DOW factors, overdispersion, CUSUM p-values, BH, optimal partitioning, labels (5.6). Owner: WP-B.
//
// Stage 1 gives every series one valid p-value: a seasonally adjusted CUSUM whose scale is the
// long-run (Bartlett) standard deviation of residuals around the best single split, compared with
// the Kolmogorov distribution. Benjamini-Hochberg runs across every series that met its floors
// (BH family 1). Stage 2 locates the change for discoveries only: exact optimal partitioning of a
// quasi-Poisson cost with penalty 3 ln n and a minimum segment, small steps (< 15%) dropped and
// merged, then each boundary gets an approximate date window (cost within 3.84) and a rate ratio
// over at most 28 days each side. Labels: too recent, gradual, seasonal (same dates last year),
// Google update overlap and measurement events. Pure: no clock, no randomness.
import { findingId } from '../core/ids.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import type {
  AnalysisUnit, ChangePoint, ChangePointInput, ChangePointOutput, EvidenceRef, Finding, GoogleEvent, IdCheck, IsoDate, LocaliseResult,
  Series, Verdict,
} from '../core/types.js';
import { layout } from '../store/layout.js';
import { localise } from './localise.js';
import { benjaminiHochberg, dowFactors, kolmogorovTail, overdispersion, seasonalSeries, theilSen } from './stats.js';
import { confidenceFor, decideVerdict } from './verdicts.js';

export const CHANGEPOINT_VERSION = '1';
const DAILY_MIN_SEG = 14;
const WEEKLY_MIN_SEG = 3;
const RECENT_DAYS = 14;
const RECENT_MIN_SEG = 3;
const EFFECT_CAP_DAYS = 28;
const MIN_STEP = 0.15;
const WINDOW_CHI2 = 3.84;
const OWN_DOW_MEAN = 50;
const GRADUAL_GAP_DAYS = 60;
const GRADUAL_SHARE = 0.6;
const SEASONAL_HISTORY_DAYS = 53 * 7;
const DAY_MS = 86_400_000;
const TIER: Record<Verdict, number> = { signal: 1000, unclear: 100, underpowered: 10, noise: 1 };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Numerics (exported for tests)
// ---------------------------------------------------------------------------

export interface Prefix { y: Float64Array; s: Float64Array; yl: Float64Array }

export function prefixSums(y: number[], s: number[]): Prefix {
  const n = y.length;
  const P: Prefix = { y: new Float64Array(n + 1), s: new Float64Array(n + 1), yl: new Float64Array(n + 1) };
  for (let t = 0; t < n; t++) {
    P.y[t + 1] = P.y[t] + y[t];
    P.s[t + 1] = P.s[t] + s[t];
    P.yl[t + 1] = P.yl[t] + (y[t] > 0 ? y[t] * Math.log(s[t]) : 0);
  }
  return P;
}

/** Quasi-Poisson cost of one segment a..b (inclusive): (2/phi) [mu sum s - (sum y) ln mu - sum y ln s], mu = sum y / sum s. */
export function segCost(P: Prefix, a: number, b: number, phi: number): number {
  const sy = P.y[b + 1] - P.y[a];
  const ss = P.s[b + 1] - P.s[a];
  const syl = P.yl[b + 1] - P.yl[a];
  if (!(ss > 0)) return 0;
  const mu = sy / ss;
  const c = mu * ss - (sy > 0 ? sy * Math.log(mu) : 0) - syl;
  return (2 / phi) * c;
}

function rate(P: Prefix, a: number, bExcl: number): number {
  const ss = P.s[bExcl] - P.s[a];
  return ss > 0 ? (P.y[bExcl] - P.y[a]) / ss : 0;
}

/** The single split (first index of the second segment) with the lowest two-segment cost, both sides >= minSeg. */
export function bestSplit(P: Prefix, from: number, toExcl: number, minSeg: number, phi = 1): number | null {
  let best: number | null = null;
  let bestCost = Infinity;
  for (let t = from + minSeg; t <= toExcl - minSeg; t++) {
    const c = segCost(P, from, t - 1, phi) + segCost(P, t, toExcl - 1, phi);
    if (c < bestCost - 1e-12) {
      bestCost = c;
      best = t;
    }
  }
  return best;
}

/**
 * Stage 1: K = max_k |S_k| / (sigma_LR sqrt(n)) with S_k the cumulative sum of y_t - mu0 s_t, and
 * p = P(sup |Brownian bridge| > K). argmax is the last index before the change (-1 when there is none).
 */
export function cusumTest(y: number[], s: number[], minSeg: number, phi = 1): { K: number; p: number; argmax: number } {
  const n = y.length;
  let sy = 0;
  let ss = 0;
  for (let t = 0; t < n; t++) {
    sy += y[t];
    ss += s[t];
  }
  if (n < 2 * minSeg || !(sy > 0) || !(ss > 0)) return { K: 0, p: 1, argmax: -1 };
  const mu0 = sy / ss;
  let S = 0;
  let argmax = -1;
  let maxAbs = 0;
  for (let k = 0; k < n - 1; k++) {
    S += y[k] - mu0 * s[k];
    if (Math.abs(S) > maxAbs) {
      maxAbs = Math.abs(S);
      argmax = k;
    }
  }
  // Residuals around the best single-split Poisson fit, so a real step does not inflate the scale.
  const P = prefixSums(y, s);
  const tau = bestSplit(P, 0, n, minSeg);
  const m1 = tau === null ? mu0 : rate(P, 0, tau);
  const m2 = tau === null ? mu0 : rate(P, tau, n);
  const e = y.map((v, t) => v - (tau === null || t < tau ? m1 : m2) * s[t]);
  const gamma = (j: number): number => {
    let acc = 0;
    for (let t = j; t < n; t++) acc += e[t] * e[t - j];
    return acc / n;
  };
  const h = Math.floor(4 * Math.pow(n / 100, 2 / 9));
  const g0 = gamma(0);
  let sigma2 = g0;
  for (let j = 1; j <= h; j++) sigma2 += 2 * (1 - j / (h + 1)) * gamma(j);
  // Floors (a deliberate, conservative addition to the 5.6 formula). With h = 4 on 182 days the
  // Bartlett sum is noisy, and residuals around the best split shrink exactly when the CUSUM is
  // large, so on its own the far tail came out about 3.5 times too likely (P(p < 0.0005) = 0.0018
  // on Poisson nulls), which broke BH across hundreds of series (test 29). The scale is therefore
  // never below the lag-0 variance nor below the robust quasi-Poisson variance phi * mean(y), which
  // a step barely moves. Measured on 40,000 nulls per shape: P(p < 0.05) about 0.03, BH family-wise
  // rate 0.03 to 0.08 at q = 0.10, and power for a -40% step at 3 a day falls only from 0.95 to 0.93.
  sigma2 = Math.max(sigma2, g0, (phi > 0 ? phi : 1) * (sy / n));
  if (!(sigma2 > 0)) return { K: 0, p: 1, argmax };
  const K = maxAbs / (Math.sqrt(sigma2) * Math.sqrt(n));
  return { K, p: kolmogorovTail(K), argmax };
}

/** Exact optimal partitioning: F(t) = min_s F(s) + cost(s..t-1) + beta, every segment >= minSeg. Returns segment starts after 0. */
export function optimalPartition(P: Prefix, n: number, phi: number, minSeg: number, beta: number): number[] {
  if (n < minSeg) return [];
  const F = new Float64Array(n + 1).fill(Infinity);
  const last = new Int32Array(n + 1).fill(-1);
  F[0] = -beta;
  for (let t = minSeg; t <= n; t++) {
    let best = Infinity;
    let arg = -1;
    const consider = (s: number): void => {
      if (!Number.isFinite(F[s])) return;
      const v = F[s] + segCost(P, s, t - 1, phi) + beta;
      if (v < best - 1e-12) {
        best = v;
        arg = s;
      }
    };
    consider(0);
    for (let s = minSeg; s <= t - minSeg; s++) consider(s);
    F[t] = best;
    last[t] = arg;
  }
  const bounds: number[] = [];
  for (let t = n; t > 0; ) {
    const s = last[t];
    if (s <= 0) break;
    bounds.push(s);
    t = s;
  }
  return bounds.reverse();
}

/** Drops the boundary with the smallest step below minStep until none is left, then moves each boundary to its local best spot. */
export function pruneBoundaries(P: Prefix, n: number, bounds: number[], minSeg: number, phi: number, minStep = MIN_STEP): number[] {
  const b = [...bounds];
  for (;;) {
    let worst = -1;
    let worstDev = Infinity;
    for (let j = 0; j < b.length; j++) {
      const a = j === 0 ? 0 : b[j - 1];
      const c = j === b.length - 1 ? n : b[j + 1];
      const before = rate(P, a, b[j]);
      const after = rate(P, b[j], c);
      const dev = before > 0 ? Math.abs(after / before - 1) : after > 0 ? Infinity : 0;
      if (dev < minStep && dev < worstDev) {
        worstDev = dev;
        worst = j;
      }
    }
    if (worst < 0) break;
    b.splice(worst, 1);
  }
  for (let j = 0; j < b.length; j++) {
    const a = j === 0 ? 0 : b[j - 1];
    const c = j === b.length - 1 ? n : b[j + 1];
    const t = bestSplit(P, a, c, minSeg, phi);
    if (t !== null) b[j] = t;
  }
  return b;
}

/** All split points between a and c whose two-segment cost is within 3.84 of the best: the approximate date window. */
function splitWindow(P: Prefix, a: number, c: number, at: number, minSeg: number, phi: number): [number, number] {
  const cost = (t: number): number => segCost(P, a, t - 1, phi) + segCost(P, t, c - 1, phi);
  const ref = cost(at);
  let lo = at;
  let hi = at;
  for (let t = a + minSeg; t <= c - minSeg; t++) {
    if (cost(t) - ref <= WINDOW_CHI2) {
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  return [lo, hi];
}

interface Effect {
  before: number; after: number; ratio: number; ci95: [number, number];
  sumBefore: number; sumAfter: number; sBefore: number; sAfter: number; beforeLen: number; afterLen: number;
}

/** Rate ratio of [afterFrom, afterTo) over [beforeFrom, beforeTo), CI exp(ln r +- 1.96 sqrt(phi (1/A + 1/B))). A zero count uses 0.5. */
function effectBetween(P: Prefix, beforeFrom: number, beforeTo: number, afterFrom: number, afterTo: number, phi: number): Effect {
  const yB = P.y[beforeTo] - P.y[beforeFrom];
  const sB = P.s[beforeTo] - P.s[beforeFrom];
  const yA = P.y[afterTo] - P.y[afterFrom];
  const sA = P.s[afterTo] - P.s[afterFrom];
  const cb = yB > 0 ? yB : 0.5;
  const ca = yA > 0 ? yA : 0.5;
  const ratio = sB > 0 && sA > 0 ? ca / sA / (cb / sB) : 1;
  const se = Math.sqrt(phi * (1 / ca + 1 / cb));
  return {
    before: sB > 0 ? yB / sB : 0,
    after: sA > 0 ? yA / sA : 0,
    ratio,
    ci95: [ratio * Math.exp(-1.96 * se), ratio * Math.exp(1.96 * se)],
    sumBefore: yB, sumAfter: yA, sBefore: sB, sAfter: sA, beforeLen: beforeTo - beforeFrom, afterLen: afterTo - afterFrom,
  };
}

// ---------------------------------------------------------------------------
// Per-series preparation
// ---------------------------------------------------------------------------

interface Prepared {
  series: Series;
  phiDaily: number;
  mode: 'daily' | 'weekly' | null;
  y: number[];
  s: number[];
  phi: number;
  P: Prefix;
  dateOf: (k: number) => IsoDate;
  stepDays: number;
  minSeg: number;
  recent: number;
  cap: number;
  test: { K: number; p: number; argmax: number } | null;
  q: number | null;
}

function prepare(series: Series, dow: number[]): Prepared {
  const y = series.values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const n = y.length;
  const total = y.reduce((a, b) => a + b, 0);
  const mean = n > 0 ? total / n : 0;
  const base = dow.length === 7 && dow.every((f) => f > 0) ? dow : [1, 1, 1, 1, 1, 1, 1];
  const f = mean >= OWN_DOW_MEAN && n >= 28 ? dowFactors(series.start, y) : base;
  const s = n > 0 ? seasonalSeries(series.start, n, f) : [];
  const phiDaily = n > 0 ? overdispersion(y, s) : 1;
  const prepared: Prepared = {
    series, phiDaily, mode: null, y, s, phi: phiDaily, P: prefixSums(y, s), dateOf: (k) => addDays(series.start, k), stepDays: 1,
    minSeg: DAILY_MIN_SEG, recent: RECENT_DAYS, cap: EFFECT_CAP_DAYS, test: null, q: null,
  };
  if (n >= 2 * DAILY_MIN_SEG && mean >= 1 && total >= 100) {
    prepared.mode = 'daily';
  } else if (total >= 60 && Math.floor(n / 7) >= 2 * WEEKLY_MIN_SEG) {
    const drop = n % 7;
    const weeks = Math.floor(n / 7);
    const yw: number[] = [];
    const sw: number[] = [];
    for (let j = 0; j < weeks; j++) {
      let a = 0;
      let b = 0;
      for (let t = drop + 7 * j; t < drop + 7 * j + 7; t++) {
        a += y[t];
        b += s[t];
      }
      yw.push(a);
      sw.push(b);
    }
    Object.assign(prepared, {
      mode: 'weekly', y: yw, s: sw, phi: overdispersion(yw, sw), P: prefixSums(yw, sw),
      dateOf: (k: number) => addDays(series.start, drop + 7 * k), stepDays: 7, minSeg: WEEKLY_MIN_SEG,
      recent: Math.ceil(RECENT_DAYS / 7), cap: Math.ceil(EFFECT_CAP_DAYS / 7),
    });
  }
  if (prepared.mode) prepared.test = cusumTest(prepared.y, prepared.s, prepared.minSeg, prepared.phi);
  return prepared;
}

// ---------------------------------------------------------------------------
// Locating changes (stage 2)
// ---------------------------------------------------------------------------

interface Located {
  idx: number; window: [number, number]; effect: Effect; shape: 'step' | 'gradual'; slopePerWeek: number | null; tooRecent: boolean;
}

function slopeOf(pr: Prepared, from: number, toExcl: number): number | null {
  const x: number[] = [];
  const v: number[] = [];
  const per = pr.stepDays === 7 ? 1 : 7;
  for (let a = from, j = 0; a + per <= toExcl; a += per, j++) {
    const ss = pr.P.s[a + per] - pr.P.s[a];
    if (!(ss > 0)) continue;
    x.push(j);
    v.push((7 * (pr.P.y[a + per] - pr.P.y[a])) / ss);
  }
  if (x.length < 2) return null;
  const { slope } = theilSen(x, v);
  return Number.isFinite(slope) ? slope : null;
}

function locate(pr: Prepared): Located[] {
  const m = pr.y.length;
  const test = pr.test as { argmax: number };
  // Where the change most likely starts. The raw CUSUM argmax is a poor locator near the end of the
  // series (the bridge is pinned to 0 there), so the "too recent" test uses the maximum-likelihood
  // single split, which may sit as close as 3 days (1 week in weekly mode) to the end.
  const change = bestSplit(pr.P, 0, m, pr.stepDays === 7 ? 1 : RECENT_MIN_SEG, pr.phi) ?? test.argmax + 1;
  if (change > 0 && change > m - pr.recent) {
    const effect = effectBetween(pr.P, Math.max(0, change - pr.cap), change, change, m, pr.phi);
    return [{ idx: change, window: [change, m - 1], effect, shape: 'step', slopePerWeek: null, tooRecent: true }];
  }
  let bounds = pruneBoundaries(pr.P, m, optimalPartition(pr.P, m, pr.phi, pr.minSeg, 3 * Math.log(m)), pr.minSeg, pr.phi);
  if (bounds.length === 0) {
    const t = bestSplit(pr.P, 0, m, pr.minSeg, pr.phi);
    bounds = t === null ? [] : [t];
  }
  if (bounds.length === 0) return [];
  const edges = [0, ...bounds, m];
  const mus = edges.slice(0, -1).map((a, j) => rate(pr.P, a, edges[j + 1]));
  const logStep = (j: number): number => Math.log(Math.max(mus[j + 1], 1e-9) / Math.max(mus[j], 1e-9));
  let gradual = false;
  for (let j = 0; j + 1 < bounds.length; j++) {
    const sameSign = Math.sign(logStep(j)) === Math.sign(logStep(j + 1)) && logStep(j) !== 0;
    if (sameSign && (bounds[j + 1] - bounds[j]) * pr.stepDays <= GRADUAL_GAP_DAYS) gradual = true;
  }
  if (bounds.length >= 2) {
    const total = Math.log(Math.max(mus[mus.length - 1], 1e-9) / Math.max(mus[0], 1e-9));
    const biggest = Math.max(...bounds.map((_, j) => Math.abs(logStep(j))));
    if (Math.abs(total) > 0 && biggest < GRADUAL_SHARE * Math.abs(total)) gradual = true;
  }
  if (gradual) {
    const first = bounds[0];
    const lastB = bounds[bounds.length - 1];
    const effect = effectBetween(pr.P, Math.max(0, first - pr.cap), first, lastB, Math.min(m, lastB + pr.cap), pr.phi);
    const slope = slopeOf(pr, Math.max(0, first - pr.cap), Math.min(m, lastB + pr.cap));
    return [{ idx: first, window: [first, lastB], effect, shape: 'gradual', slopePerWeek: slope, tooRecent: false }];
  }
  return bounds.map((b, j) => {
    const a = edges[j];
    const c = edges[j + 2];
    const effect = effectBetween(pr.P, Math.max(a, b - pr.cap), b, b, Math.min(c, b + pr.cap), pr.phi);
    return { idx: b, window: splitWindow(pr.P, a, c, b, pr.minSeg, pr.phi), effect, shape: 'step' as const, slopePerWeek: null, tooRecent: false };
  });
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** [ptDate(begin) - 2, ptDate(end, or begin + 14 days) + 7]: the window in which a change counts as overlapping the event. */
export function eventWindow(e: GoogleEvent): [IsoDate, IsoDate] {
  const b = ptDate(e.begin);
  const endAt = e.end ?? new Date(Date.parse(e.begin) + 14 * DAY_MS).toISOString();
  return [addDays(b, -2), addDays(ptDate(endAt), 7)];
}

const intersects = (a: [IsoDate, IsoDate], b: [IsoDate, IsoDate]): boolean => a[0] <= b[1] && b[0] <= a[1];

/** Last year's 28 days around the date must average 1 a day (the daily change-point floor) to say anything. */
const SEASONAL_MIN_TOTAL = 28;

function seasonalCheck(
  i: ChangePointInput, series: Series, date: IsoDate, ci: [number, number], ratioNow: number,
): { checked: boolean; match: boolean; ratio: number | null } {
  const hist = i.seasonalValues[series.id];
  if (!hist || diffDays(i.historyStart, i.dataThrough) + 1 < SEASONAL_HISTORY_DAYS) return { checked: false, match: false, ratio: null };
  const ly = addDays(date, -364);
  const at = diffDays(hist.start, ly);
  if (at - 14 < 0 || at + 14 > hist.values.length) return { checked: false, match: false, ratio: null };
  let before = 0;
  let after = 0;
  for (let k = at - 14; k < at; k++) before += Math.max(0, hist.values[k] || 0);
  for (let k = at; k < at + 14; k++) after += Math.max(0, hist.values[k] || 0);
  if (!(before > 0) || !(after > 0)) return { checked: false, match: false, ratio: null };
  // A handful of clicks last year swings on counting noise alone, so it can't speak to the season.
  if (before + after < SEASONAL_MIN_TOTAL) return { checked: false, match: false, ratio: null };
  const ratio = after / before;
  // "The same thing happened last year" needs last year to have moved the same way: a flat year
  // can sit inside a wide interval without being the same thing.
  const sameWay = (ratio - 1) * (ratioNow - 1) > 0;
  return { checked: true, match: sameWay && ratio >= ci[0] && ratio <= ci[1], ratio };
}

function localiseFor(i: ChangePointInput, pr: Prepared, date: IsoDate): LocaliseResult | null {
  const segs = i.series.filter((s) => s.segmentsOf === pr.series.id && s.metric === pr.series.metric);
  const groups = new Map<string, Series[]>();
  for (const s of segs) {
    const key = s.unit.device ? 'device' : s.unit.level;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let best: LocaliseResult | null = null;
  for (const key of [...groups.keys()].sort((a, b) => (a === 'template' ? -1 : b === 'template' ? 1 : cmp(a, b)))) {
    const g = groups.get(key) as Series[];
    if (g.length < 2) continue;
    const r = localise({ date, segments: g.map((s) => ({ label: s.unit.label, values: s.values, start: s.start })), phi: pr.phiDaily, days: EFFECT_CAP_DAYS });
    if (!best || r.p < best.p) best = r;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function round(x: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** A daily average for evidence lines: whole numbers with thousands separators from 10, one decimal below. */
function perDay(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  if (Math.abs(x) < 10) return String(Math.round(x * 10) / 10);
  return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function buildFinding(
  i: ChangePointInput, pr: Prepared, cp: ChangePoint, loc: Located,
  extra: { seasonal: { checked: boolean; match: boolean; ratio: number | null }; measurement: GoogleEvent | null; events: GoogleEvent[] },
): Finding {
  const unit: AnalysisUnit = pr.series.unit;
  const metric = pr.series.metric;
  const checks: IdCheck[] = [];
  if (extra.seasonal.checked) {
    checks.push({ name: 'seasonal', passed: !extra.seasonal.match, detail: `same dates last year: ratio ${round(extra.seasonal.ratio ?? 1, 3)}` });
  }
  if (extra.measurement && metric === 'impressions') {
    checks.push({ name: 'measurement_event', passed: false, detail: extra.measurement.title.slice(0, 120) });
  }
  const e = loc.effect;
  const ci: [number, number] = [cp.ci95[0] - 1, cp.ci95[1] - 1];
  const v = decideVerdict({
    estimate: cp.ratio - 1,
    ci95: ci,
    floorsMet: !cp.tooRecent,
    identification: checks,
    q: cp.q,
    delta: i.delta,
    fdrQ: i.fdrQ,
    weeksObserved: (e.beforeLen * pr.stepDays) / 7,
    counts: { pre: e.sumBefore, post: e.sumAfter, phi: pr.phi },
  });
  const counterfactual = e.before * e.sAfter;
  const absolute = e.sumAfter - counterfactual;
  const absoluteCi95: [number, number] = [counterfactual * ci[0], counterfactual * ci[1]];
  const direction = cp.ratio < 1 ? 'down' : 'up';

  const overlapIds = cp.overlaps.map((o) => o.eventId);
  const ranking = cp.overlaps.find((o) => o.kind === 'core' || o.kind === 'spam' || o.kind === 'other_ranking');
  const outage = cp.overlaps.find((o) => o.kind === 'outage');
  let cause: Finding['cause'] = 'unknown';
  if (extra.measurement && metric === 'impressions') cause = 'data_anomaly';
  else if (extra.seasonal.match) cause = 'seasonal';
  else if (ranking) cause = 'google_update';
  else if (outage) cause = 'outage';

  let template: Finding['template'] = 'change_point';
  // Daily levels before and after (weekday-adjusted), so the report can say "from about 0.1 to 12
  // a day" when a percent would be meaningless (a page that only just started showing up).
  const levels = { from: round(e.before, 2), to: round(e.after, 2) };
  let slots: Finding['slots'] = { metric, unit: unit.label, pct: Math.abs(cp.ratio - 1), date: cp.date, d1: cp.dateWindow[0], d2: cp.dateWindow[1], direction, ...levels };
  if (cp.tooRecent) {
    template = 'too_recent';
    // metric and unit name the series, so two too-recent changes on one page read differently.
    slots = { metric, unit: unit.label, date: cp.date, check_date: addDays(cp.date, RECENT_DAYS), direction };
  } else if (extra.measurement && metric === 'impressions') {
    template = 'reporting_artefact';
    slots = { metric, date: cp.date, event: extra.measurement.title };
  } else if (cp.shape === 'gradual') {
    template = 'gradual';
    // slopePerWeek is in counts per week, per week (Theil-Sen over weekly rates). The sentence wants
    // a share of the starting level, which only means something when there was a level to start from.
    const weekly = 7 * e.before;
    const rel = cp.slopePerWeek !== null && weekly >= 7 ? Math.abs(cp.slopePerWeek) / weekly : null;
    slots = { metric, unit: unit.label, date: cp.date, direction, ...levels, ...(rel !== null ? { slope: round(rel, 4) } : {}) };
  }
  // A change we can't attribute says which check stopped it (the report words the IdCheck name).
  if (v.verdict === 'unclear' && v.failed[0] && (template === 'change_point' || template === 'gradual')) slots = { ...slots, check: v.failed[0].name };

  const where = layout.gscDay(cp.date);
  const evidence: EvidenceRef[] = [
    {
      type: 'gsc', confidence: 'EXTRACTED', partition: where, key: { series: pr.series.id },
      summary: `Daily ${metric} on ${unit.label}: about ${perDay(e.before)} before ${cp.date}, ${perDay(e.after)} after`,
    },
    {
      type: 'statistic', confidence: confidenceFor(v.verdict, false), partition: where, key: { series: pr.series.id },
      summary: cp.tooRecent
        ? `Possible change on ${unit.label} ${metric} from ${cp.date}, too recent to judge`
        : `Change point on ${unit.label} ${metric}, ${cp.date}${cp.dateWindow[0] === cp.dateWindow[1] ? '' : ` (likely ${cp.dateWindow[0]} to ${cp.dateWindow[1]})`}`,
    },
  ];
  if (cp.localisation) {
    const top = cp.localisation.top.slice(0, 3).map((t) => t.label);
    evidence.push({
      type: 'statistic', confidence: confidenceFor(v.verdict, false), partition: where,
      summary: cp.localisation.proportional ? 'Spread across your site in proportion' : `Concentrated in ${top.join(', ')}`,
    });
  }
  for (const ev of extra.events) {
    const end = ev.end ? ptDate(ev.end) : null;
    evidence.push({
      type: 'google_event', confidence: 'EXTRACTED', partition: 'google/', key: { id: ev.id },
      summary: `${ev.title.slice(0, 120)} (${ptDate(ev.begin)}${end ? ` to ${end}` : ', no end date yet'})`,
    });
  }

  const alternatives: Finding['alternatives'] = [];
  const firstRanking = extra.events.find((x) => x.kind === 'core' || x.kind === 'spam' || x.kind === 'other_ranking');
  if (firstRanking) alternatives.push({ cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: firstRanking.title } });
  else alternatives.push({ cause: 'google_update', ruledOut: true, key: 'update_no_overlap', slots: {} });
  if (extra.seasonal.checked) {
    alternatives.push(
      extra.seasonal.match
        ? { cause: 'seasonal', ruledOut: false, key: 'seasonal_same_last_year', slots: { yoy: (extra.seasonal.ratio ?? 1) - 1 } }
        : { cause: 'seasonal', ruledOut: true, key: 'seasonal_not_last_year', slots: {} },
    );
  }
  if (extra.measurement) alternatives.push({ cause: 'data_anomaly', ruledOut: false, key: 'measurement_event_overlaps', slots: { event: extra.measurement.title } });
  const outageEv = extra.events.find((x) => x.kind === 'outage');
  if (outageEv) alternatives.push({ cause: 'outage', ruledOut: false, key: 'outage_overlaps', slots: { event: outageEv.title } });

  const from = addDays(cp.date, -EFFECT_CAP_DAYS) < pr.series.start ? pr.series.start : addDays(cp.date, -EFFECT_CAP_DAYS);
  const toRaw = addDays(cp.date, EFFECT_CAP_DAYS - 1);
  const verify: NonNullable<Finding['verify']> = { from, to: toRaw > i.dataThrough ? i.dataThrough : toRaw };
  if (unit.level === 'page') verify.page = unit.key;
  if (unit.level === 'query') verify.query = unit.key;

  const absClicks = metric === 'clicks' ? Math.abs(absolute) : 1;
  return {
    id: findingId(['change_point', unit.key, cp.date, pr.series.id]),
    kind: 'change_point',
    unit,
    metric,
    windows: null,
    date: cp.date,
    dateWindow: cp.dateWindow,
    effect: { estimate: cp.ratio - 1, ci95: ci, absolute, absoluteCi95, p: cp.p, q: cp.q },
    real: v.verdict,
    reason: v.reason,
    cause,
    causeConfidence: 'AMBIGUOUS', // timing lines up; that alone never proves a cause
    components: null,
    componentCi95: null,
    power: v.power ? { ...v.power, perWeek: e.beforeLen > 0 ? (e.sumBefore / (e.beforeLen * pr.stepDays)) * 7 : 0 } : null,
    template,
    slots,
    evidence,
    alternatives,
    falsifier: cp.tooRecent ? { key: 'more_data', slots: { check_date: addDays(cp.date, RECENT_DAYS) } } : { key: 'reverts', slots: {} },
    verify,
    related: { googleEvents: overlapIds, siteChanges: [], findings: [] },
    analyzer: { name: 'changepoint', version: CHANGEPOINT_VERSION },
    priority: TIER[v.verdict] * Math.max(1, absClicks),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function analyzeChangePoints(i: ChangePointInput): ChangePointOutput {
  const prepared = i.series.map((s) => prepare(s, i.dow));
  const dispersion: Record<string, number> = {};
  for (const pr of prepared) dispersion[pr.series.id] = pr.phiDaily;

  // BH family 1: every series that met its floors.
  const family = prepared.filter((pr) => pr.test !== null);
  const q = benjaminiHochberg(family.map((pr) => (pr.test as { p: number }).p));
  family.forEach((pr, k) => {
    pr.q = q[k];
  });

  const events = [...i.events].sort((a, b) => cmp(a.begin, b.begin) || cmp(a.id, b.id));
  const changePoints: ChangePoint[] = [];
  const findings: Finding[] = [];
  for (const pr of family) {
    if (!(pr.q !== null && pr.q <= i.fdrQ)) continue;
    for (const loc of locate(pr)) {
      const date = pr.dateOf(loc.idx);
      const lastDate = pr.dateOf(loc.window[1]);
      const windowEnd = loc.tooRecent ? i.dataThrough : pr.stepDays === 7 ? addDays(lastDate, 6) : lastDate;
      const dateWindow: [IsoDate, IsoDate] = [pr.dateOf(loc.window[0]), windowEnd > i.dataThrough ? i.dataThrough : windowEnd];
      const touching = events.filter((ev) => intersects(dateWindow, eventWindow(ev)));
      const measurement = touching.find((ev) => ev.kind === 'data_anomaly') ?? null;
      const seasonal = loc.tooRecent ? { checked: false, match: false, ratio: null } : seasonalCheck(i, pr.series, date, loc.effect.ci95, loc.effect.ratio);
      const cp: ChangePoint = {
        seriesId: pr.series.id,
        unit: pr.series.unit,
        metric: pr.series.metric,
        date,
        dateWindow,
        before: loc.effect.before,
        after: loc.effect.after,
        ratio: loc.effect.ratio,
        ci95: loc.effect.ci95,
        p: (pr.test as { p: number }).p,
        q: pr.q,
        shape: loc.shape,
        slopePerWeek: loc.slopePerWeek,
        overlaps: touching.map((ev) => ({ eventId: ev.id, kind: ev.kind, title: ev.title })),
        localisation: pr.series.primary && !loc.tooRecent ? localiseFor(i, pr, date) : null,
        seasonalMatch: seasonal.match,
        tooRecent: loc.tooRecent,
        mode: pr.mode as 'daily' | 'weekly',
      };
      changePoints.push(cp);
      findings.push(buildFinding(i, pr, cp, loc, { seasonal, measurement, events: touching }));
    }
  }

  changePoints.sort((a, b) => cmp(a.date, b.date) || cmp(a.seriesId, b.seriesId));
  findings.sort((a, b) => b.priority - a.priority || cmp(a.id, b.id));
  return { changePoints, findings, dispersion };
}
