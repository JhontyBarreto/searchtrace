// The verdict engine (5.8), MDE, weeks-to-power, confidence mapping and default deltas. Owner: WP-A.
//
// "Is it real?" has four answers: signal, noise, underpowered, unclear. The rules run in a fixed
// order (floors, identification, signal, real but small, bounded noise, otherwise underpowered),
// so the same inputs always give the same verdict. Noise has two reasons that read differently:
// noise_small is a real but small change ("Small change"), noise_bounded is ordinary wobble.
// All functions are pure.
import type { AnalysisUnit, Confidence, PowerInfo, Verdict, VerdictInput, VerdictResult } from '../core/types.js';

/** Smallest relative effect worth acting on, per kind of claim (5.8). */
export const DEFAULT_DELTA: {
  site: number;
  template: number;
  page: number;
  query: number;
  aio: number;
  changepoint: number;
  siteChange: number;
} = Object.freeze({
  site: 0.1,
  template: 0.1,
  page: 0.2,
  query: 0.2,
  aio: 0.15,
  changepoint: 0.15,
  siteChange: 0.1,
});

/**
 * The delta for a claim about a unit, by its level: the same unit gets the same bar whether a
 * 28-day comparison or a change point judges it, so one estimate can't be "Real change" in one
 * section of the report and wobble in another. Brand and non-brand searches are site-wide
 * aggregates, so they use the site's delta.
 */
export function deltaForUnit(unit: Pick<AnalysisUnit, 'level' | 'key'>): number {
  if (unit.level === 'site' || unit.key.startsWith('class:')) return DEFAULT_DELTA.site;
  if (unit.level === 'template') return DEFAULT_DELTA.template;
  return unit.level === 'page' ? DEFAULT_DELTA.page : DEFAULT_DELTA.query;
}

/** 1.96 + 0.84: two-sided alpha 0.05 with 80% power. */
const Z_POWER = 2.8;
/** Width of a 95% normal interval in standard errors (2 * 1.96). */
const CI95_WIDTH_SE = 3.92;
/** Lower clamp on 1 + L before taking logs, so a CI reaching -100% stays finite. */
const MIN_RATIO = 1e-3;
/** Beyond this many extra weeks a change of size delta is reported as not measurable. */
const MAX_WEEKS = 52;

/**
 * Power from a standard error on the log scale:
 * mde = 1 - exp(-2.8 SE); weeksNeeded = T (2.8 SE / ln(1 + delta))^2 - T, floored at 0.
 * An infinite SE, or more than 52 extra weeks, is not measurable and has weeksNeeded = null.
 * With no observed weeks there is nothing to extrapolate from, so weeksNeeded is null.
 */
function powerFromSe(se: number, delta: number, weeksObserved: number): PowerInfo {
  if (!(delta > 0) || !Number.isFinite(delta)) throw new RangeError(`power: delta must be finite and > 0, got ${delta}`);
  if (Number.isNaN(se) || !Number.isFinite(se)) return { mde: 1, weeksNeeded: null, notMeasurable: true };
  const mde = 1 - Math.exp(-Z_POWER * se);
  if (!(weeksObserved > 0) || !Number.isFinite(weeksObserved)) return { mde, weeksNeeded: null, notMeasurable: false };
  const ratio = (Z_POWER * se) / Math.log1p(delta);
  const weeks = weeksObserved * ratio * ratio - weeksObserved;
  if (weeks > MAX_WEEKS) return { mde, weeksNeeded: null, notMeasurable: true };
  return { mde, weeksNeeded: Math.max(0, weeks), notMeasurable: false };
}

/** Power from a 95% CI on a relative effect: SE = (ln(1 + U) - ln(1 + L)) / 3.92, with 1 + L and 1 + U clamped at 1e-3. */
export function powerFromCi(ci: [number, number], delta: number, weeksObserved: number): PowerInfo {
  const lo = Math.max(1 + ci[0], MIN_RATIO);
  const hi = Math.max(1 + ci[1], MIN_RATIO);
  const se = Math.abs(Math.log(hi) - Math.log(lo)) / CI95_WIDTH_SE;
  return powerFromSe(se, delta, weeksObserved);
}

/** Power from window totals: SE = sqrt(phi (1/pre + 1/post)), infinite when either total is 0. */
export function powerFromCounts(pre: number, post: number, phi: number, delta: number, weeksObserved: number): PowerInfo {
  const se = pre > 0 && post > 0 ? Math.sqrt(phi * (1 / pre + 1 / post)) : Infinity;
  return powerFromSe(se, delta, weeksObserved);
}

/** Power from the CI when there is one, else from the counts, else none. */
function powerOf(v: VerdictInput): PowerInfo | null {
  if (v.ci95) return powerFromCi(v.ci95, v.delta, v.weeksObserved);
  if (v.counts) return powerFromCounts(v.counts.pre, v.counts.post, v.counts.phi, v.delta, v.weeksObserved);
  return null;
}

/**
 * The verdict rules of 5.8, applied in order. After the floors and the identification checks, the
 * verdict is a 2 x 2: is the change real (the 95% range excludes 0 and it survives false-discovery
 * control), and is it known to be small (the whole range sits inside (-delta, delta))?
 *   real, not known to be small  -> signal ("Real change"; the size may still be uncertain)
 *   real and small               -> noise, reason noise_small ("Small change": real, below delta)
 *   not real, known to be small  -> noise, reason noise_bounded ("Normal wobble")
 *   neither                      -> underpowered, reason wide_ci
 * A range that excludes 0 but fails the false-discovery control is never called real.
 */
export function decideVerdict(v: VerdictInput): VerdictResult {
  // 1. Floors: too little data to say anything.
  if (!v.floorsMet) return { verdict: 'underpowered', reason: 'floors', power: powerOf(v), failed: [] };
  // 2. Identification: a check that failed means the causes cannot be separated.
  const failed = v.identification.filter((c) => !c.passed);
  if (failed.length > 0) return { verdict: 'unclear', reason: 'identification', power: null, failed };
  if (!v.ci95) return { verdict: 'underpowered', reason: 'wide_ci', power: powerOf(v), failed: [] };
  const [L, U] = v.ci95;
  const d = v.delta;
  const real = (L > 0 || U < 0) && (v.q ?? 1) <= v.fdrQ;
  const bounded = L > -d && U < d;
  // 3. Signal: real, and the range reaches past delta (or the estimate itself is that big).
  if (real && !bounded) return { verdict: 'signal', reason: 'signal', power: null, failed: [] };
  // 4. Real but small: real, and the whole range sits inside (-delta, delta).
  if (real) return { verdict: 'noise', reason: 'noise_small', power: null, failed: [] };
  // 5. Bounded noise: not shown to be real, and any real change is smaller than delta.
  if (bounded) return { verdict: 'noise', reason: 'noise_bounded', power: null, failed: [] };
  // 6. Otherwise the interval is too wide to tell.
  return { verdict: 'underpowered', reason: 'wide_ci', power: powerOf(v), failed: [] };
}

/** Raw API facts are EXTRACTED; signal and noise are INFERRED; underpowered and unclear are AMBIGUOUS. */
export function confidenceFor(verdict: Verdict, isFact: boolean): Confidence {
  if (isFact) return 'EXTRACTED';
  return verdict === 'signal' || verdict === 'noise' ? 'INFERRED' : 'AMBIGUOUS';
}
