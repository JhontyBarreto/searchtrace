// The verdict engine (spec 5.8; 5.13 tests 19 and 20). Expected power numbers were worked out by hand
// from the formulas in 5.8 and are written out in the comments.
import { describe, expect, it } from 'vitest';

import { confidenceFor, decideVerdict, DEFAULT_DELTA, powerFromCi, powerFromCounts } from '../../src/analyze/verdicts.js';
import type { IdCheck, VerdictInput } from '../../src/core/types.js';

const base: VerdictInput = {
  estimate: -0.31,
  ci95: [-0.45, -0.15],
  floorsMet: true,
  identification: [],
  q: 0.01,
  delta: 0.1,
  fdrQ: 0.1,
  weeksObserved: 4,
};

const passed: IdCheck = { name: 'placebo', passed: true, detail: 'placebo window flat' };
const failedCheck: IdCheck = { name: 'measurement_event', passed: false, detail: 'num=100 overlaps the baseline' };

describe('decideVerdict (test 19)', () => {
  it('rule 1: floors not met gives underpowered with power', () => {
    const r = decideVerdict({ ...base, floorsMet: false });
    expect(r.verdict).toBe('underpowered');
    expect(r.reason).toBe('floors');
    expect(r.power).not.toBeNull();
    expect(r.failed).toEqual([]);
    // Floors win over a failed identification check.
    expect(decideVerdict({ ...base, floorsMet: false, identification: [failedCheck] }).reason).toBe('floors');
  });

  it('rule 2: a failed identification check gives unclear and lists only the failures', () => {
    const r = decideVerdict({ ...base, identification: [passed, failedCheck] });
    expect(r.verdict).toBe('unclear');
    expect(r.reason).toBe('identification');
    expect(r.power).toBeNull();
    expect(r.failed).toEqual([failedCheck]);
    // Passing checks change nothing.
    expect(decideVerdict({ ...base, identification: [passed] }).verdict).toBe('signal');
  });

  it('rule 3: signal when the CI excludes 0, the effect is at least delta and q <= fdrQ', () => {
    const r = decideVerdict(base);
    expect(r).toEqual({ verdict: 'signal', reason: 'signal', power: null, failed: [] });
    // Positive direction, effect exactly at delta, q exactly at fdrQ.
    expect(decideVerdict({ ...base, estimate: 0.1, ci95: [0.02, 0.2], q: 0.1 }).verdict).toBe('signal');
  });

  it('rule 4: bounded noise when the whole CI sits inside (-delta, delta)', () => {
    const r = decideVerdict({ ...base, estimate: 0.01, ci95: [-0.06, 0.08], q: 0.7 });
    expect(r).toEqual({ verdict: 'noise', reason: 'noise_bounded', power: null, failed: [] });
  });

  it('rule 5: real but small when the CI excludes 0 and the effect is below delta', () => {
    const r = decideVerdict({ ...base, estimate: -0.08, ci95: [-0.12, -0.04], q: 0.001 });
    expect(r).toEqual({ verdict: 'noise', reason: 'noise_small', power: null, failed: [] });
  });

  it('rule 6: a wide CI gives underpowered with power', () => {
    const r = decideVerdict({ ...base, estimate: -0.2, ci95: [-0.5, 0.25], q: 0.4 });
    expect(r.verdict).toBe('underpowered');
    expect(r.reason).toBe('wide_ci');
    expect(r.power).not.toBeNull();
  });

  it('a large effect whose q is above fdrQ is underpowered, not signal', () => {
    const r = decideVerdict({ ...base, q: 0.2 });
    expect(r.verdict).toBe('underpowered');
    expect(r.reason).toBe('wide_ci');
    // A missing q counts as 1.
    expect(decideVerdict({ ...base, q: null }).verdict).toBe('underpowered');
  });

  it('without a CI it is underpowered, with power from the counts when given', () => {
    const noCi = decideVerdict({ ...base, ci95: null });
    expect(noCi.verdict).toBe('underpowered');
    expect(noCi.reason).toBe('wide_ci');
    expect(noCi.power).toBeNull();
    const withCounts = decideVerdict({ ...base, ci95: null, counts: { pre: 400, post: 300, phi: 1.5 } });
    expect(withCounts.power?.mde).toBeCloseTo(0.23042434779139198, 12);
    // Identification still beats the missing CI.
    expect(decideVerdict({ ...base, ci95: null, identification: [failedCheck] }).verdict).toBe('unclear');
  });

  it('prefers the CI over the counts for power', () => {
    const r = decideVerdict({ ...base, floorsMet: false, ci95: [-0.2, 0.25], counts: { pre: 400, post: 300, phi: 1.5 } });
    expect(r.power?.mde).toBeCloseTo(0.2729619772174766, 12);
  });
});

describe('power (test 20)', () => {
  it('powerFromCi matches hand-computed values', () => {
    // SE = (ln 1.25 - ln 0.8) / 3.92 = 0.11384875067051517
    // mde = 1 - exp(-2.8 SE) = 0.2729619772174766
    // weeks = 4 (2.8 SE / ln 1.1)^2 - 4 = 40.74597902549759
    const p = powerFromCi([-0.2, 0.25], 0.1, 4);
    expect(p.mde).toBeCloseTo(0.2729619772174766, 12);
    expect(p.weeksNeeded).toBeCloseTo(40.74597902549759, 9);
    expect(p.notMeasurable).toBe(false);
  });

  it('powerFromCounts matches hand-computed values', () => {
    // SE = sqrt(1.5 (1/400 + 1/300)) = 0.09354143466934854
    // mde = 0.23042434779139198, weeks = 4 (2.8 SE / ln 1.1)^2 - 4 = 26.206856284334645
    const p = powerFromCounts(400, 300, 1.5, 0.1, 4);
    expect(p.mde).toBeCloseTo(0.23042434779139198, 12);
    expect(p.weeksNeeded).toBeCloseTo(26.206856284334645, 9);
    expect(p.notMeasurable).toBe(false);
  });

  it('is not measurable above 52 weeks, with weeksNeeded null', () => {
    // SE = ln 4 / 3.92 = 0.3536; weeks = 4 (2.8 SE / ln 1.1)^2 - 4 = 427.75
    const p = powerFromCi([-0.5, 1], 0.1, 4);
    expect(p.notMeasurable).toBe(true);
    expect(p.weeksNeeded).toBeNull();
    expect(p.mde).toBeCloseTo(0.6285014277157629, 12);
    // Just either side of the 52-week line: weeks = T (k^2 - 1) with k = 2.8 SE / ln 1.1.
    const seFor = (weeks: number, t: number): number => (Math.sqrt((weeks + t) / t) * Math.log(1.1)) / 2.8;
    const ciFor = (se: number): [number, number] => [Math.exp(-1.96 * se) - 1, Math.exp(1.96 * se) - 1];
    expect(powerFromCi(ciFor(seFor(51.9, 4)), 0.1, 4).notMeasurable).toBe(false);
    expect(powerFromCi(ciFor(seFor(52.1, 4)), 0.1, 4).notMeasurable).toBe(true);
  });

  it('treats an infinite SE as not measurable', () => {
    expect(powerFromCi([-1, Infinity], 0.1, 4)).toEqual({ mde: 1, weeksNeeded: null, notMeasurable: true });
    expect(powerFromCounts(0, 30, 1, 0.1, 4)).toEqual({ mde: 1, weeksNeeded: null, notMeasurable: true });
    expect(powerFromCounts(30, 0, 1, 0.1, 4).notMeasurable).toBe(true);
  });

  it('clamps 1 + L at 1e-3, floors weeksNeeded at 0, and needs delta > 0', () => {
    // L = -1 is clamped: SE = (ln 1.1 - ln 0.001) / 3.92 = 1.7865, mde = 0.99328.
    const clamped = powerFromCi([-1, 0.1], 0.2, 4);
    expect(clamped.mde).toBeCloseTo(0.9932767903596323, 12);
    expect(clamped.notMeasurable).toBe(true);
    // A CI already tighter than needed: no more weeks.
    const tight = powerFromCi([-0.01, 0.01], 0.1, 4);
    expect(tight.weeksNeeded).toBe(0);
    expect(tight.notMeasurable).toBe(false);
    expect(() => powerFromCi([-0.1, 0.1], 0, 4)).toThrow(RangeError);
    // Nothing observed yet: no basis for a weeks estimate.
    expect(powerFromCi([-0.2, 0.25], 0.1, 0).weeksNeeded).toBeNull();
  });
});

describe('confidenceFor and DEFAULT_DELTA', () => {
  it('maps facts to EXTRACTED, signal and noise to INFERRED, the rest to AMBIGUOUS', () => {
    expect(confidenceFor('signal', true)).toBe('EXTRACTED');
    expect(confidenceFor('underpowered', true)).toBe('EXTRACTED');
    expect(confidenceFor('signal', false)).toBe('INFERRED');
    expect(confidenceFor('noise', false)).toBe('INFERRED');
    expect(confidenceFor('underpowered', false)).toBe('AMBIGUOUS');
    expect(confidenceFor('unclear', false)).toBe('AMBIGUOUS');
  });

  it('holds the spec deltas and cannot be changed', () => {
    expect(DEFAULT_DELTA).toEqual({ site: 0.1, template: 0.1, page: 0.2, query: 0.2, aio: 0.15, changepoint: 0.15, siteChange: 0.1 });
    expect(Object.isFrozen(DEFAULT_DELTA)).toBe(true);
  });
});
