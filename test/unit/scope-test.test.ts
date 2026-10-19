// Scope totals: one closed-form "is it real?" SE, and BH family 2 fixed in advance (5.4, 5.12). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { compareCounts, extraVariance, familyKey, scopeFamilyQ, type FamilyScope } from '../../src/analyze/scope-test.js';
import type { PeriodEffect } from '../../src/core/types.js';
import { normalCdf, poissonDraw } from '../../src/analyze/stats.js';
import { testRng } from '../helpers/index.js';

const effect = (pre: number, post: number, se: number, seSource: PeriodEffect['seSource']): PeriodEffect => ({
  pre, post, tau: post / pre - 1, ci95: [0, 0], p: 0.5, se, seSource, freq: null, floorsMet: true, real: 'noise', reason: 'noise_bounded', power: null,
});

describe('scope comparison', () => {
  it('adds the site\'s period-to-period variance to counting noise, like the headline', () => {
    // Empirical SE 0.1 on 1,000 vs 900 with phi 1: extra = 0.01 - (1/1000 + 1/900).
    const extra = extraVariance(effect(1000, 900, 0.1, 'empirical'), 1);
    expect(extra).toBeCloseTo(0.01 - (1 / 1000 + 1 / 900), 12);
    expect(extraVariance(effect(1000, 900, 0.1, 'quasi_poisson'), 1)).toBe(0);
    const plain = compareCounts(200, 150, 1.2, 0);
    const wide = compareCounts(200, 150, 1.2, extra);
    expect(plain.se).toBeCloseTo(Math.sqrt(1.2 * (1 / 200 + 1 / 150)), 12);
    expect(wide.se).toBeCloseTo(Math.sqrt(1.2 * (1 / 200 + 1 / 150) + extra), 12);
    expect(wide.p).toBeGreaterThan(plain.p);
    expect(plain.estimate).toBeCloseTo(-0.25, 12);
    expect(plain.p).toBeCloseTo(2 * normalCdf(-Math.abs(Math.log(150 / 200)) / plain.se), 12);
    // The click range is the baseline times the relative range, so it agrees with the percent range.
    expect(plain.absoluteCi95?.[0]).toBeCloseTo(200 * (plain.ci95 as [number, number])[0], 9);
  });

  it('handles a search with no clicks left (continuity 0.5) and no clicks at all', () => {
    const gone = compareCounts(40, 0, 1, 0);
    expect(gone.estimate).toBe(-1);
    expect(Number.isFinite(gone.se)).toBe(true);
    expect((gone.ci95 as [number, number])[0]).toBeGreaterThanOrEqual(-1);
    expect(compareCounts(0, 0, 1, 0)).toMatchObject({ estimate: null, ci95: null, p: 1 });
  });
});

describe('BH family 2 (bh-family2-selected-on-outcome)', () => {
  it('tests every eligible scope, not only the top movers, so null searches do not inflate the shown ones', () => {
    const rng = testRng('family');
    const scopes: FamilyScope[] = [];
    // 1,000 null searches with 40 to 80 expected clicks, plus 3 planted movers.
    for (let k = 0; k < 1000; k++) {
      const mean = 40 + (k % 41);
      scopes.push({ level: 'query', key: `q${k}`, baseClicks: poissonDraw(rng, mean), curClicks: poissonDraw(rng, mean), baseExpected: mean });
    }
    for (let k = 0; k < 3; k++) scopes.push({ level: 'query', key: `mover${k}`, baseClicks: 400, curClicks: 200, baseExpected: 400 });
    // Below the floor: not a hypothesis.
    scopes.push({ level: 'query', key: 'thin', baseClicks: 5, curClicks: 0, baseExpected: 6 });
    const q = scopeFamilyQ(scopes, 1, 0);
    expect(q.size).toBe(1003);
    expect(q.has(familyKey('query', 'thin'))).toBe(false);
    for (let k = 0; k < 3; k++) expect(q.get(familyKey('query', `mover${k}`))).toBeLessThan(0.001);
    // Selecting the top 50 by |change| first would hand the noise a q-value up to 1003 / 53 times too small.
    const falseCalls = [...q.entries()].filter(([key, v]) => key.startsWith('query|q') && v <= 0.1).length;
    expect(falseCalls).toBeLessThanOrEqual(3);
  });
});
