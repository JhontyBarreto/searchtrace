// Spec 5.13 test 31: the G-squared localisation test. Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import { OTHER_LABEL, localise } from '../../src/analyze/localise.js';

const START = '2026-06-01';
const DATE = addDays(START, 60);
/** A flat segment of `before` a day that becomes `after` a day from DATE. */
const seg = (label: string, before: number, after: number) => ({
  label,
  start: START,
  values: Array.from({ length: 120 }, (_, k) => (k < 60 ? before : after)),
});

describe('localise (test 31)', () => {
  it('does not reject when every segment falls by the same share', () => {
    const r = localise({ date: DATE, segments: [seg('/blog/*', 50, 35), seg('/services/*', 20, 14), seg('other pages', 10, 7)], phi: 1, days: 28 });
    expect(r.proportional).toBe(true);
    expect(r.df).toBe(2);
    expect(r.g2).toBeCloseTo(0, 9);
    expect(r.p).toBeGreaterThan(0.5);
    expect(r.top).toEqual([]);
  });

  it('rejects when one segment carries the loss, and lists it first', () => {
    const r = localise({ date: DATE, segments: [seg('/blog/*', 50, 15), seg('/services/*', 20, 20), seg('other pages', 10, 10)], phi: 1, days: 28 });
    expect(r.proportional).toBe(false);
    expect(r.p).toBeLessThan(1e-6);
    expect(r.top[0].label).toBe('/blog/*');
    expect(r.top[0].residual).toBeLessThan(0);
    expect(r.top[0].changePct).toBeCloseTo(-0.7, 9);
    expect(r.top.find((t) => t.label === '/services/*')?.changePct).toBeCloseTo(0, 9);
  });

  it('divides by phi, so overdispersion makes the test harder to reject', () => {
    const segs = [seg('a', 20, 15), seg('b', 20, 19), seg('c', 20, 20)];
    const plain = localise({ date: DATE, segments: segs, phi: 1, days: 28 });
    const wide = localise({ date: DATE, segments: segs, phi: 50, days: 28 });
    expect(plain.proportional).toBe(false);
    expect(wide.proportional).toBe(true);
    expect(wide.g2).toBeCloseTo(plain.g2, 9);
  });

  it('merges segments with an expected count under 5 into "other"', () => {
    const r = localise({
      date: DATE,
      segments: [seg('/blog/*', 50, 15), seg('/services/*', 20, 20), seg('tiny-a', 0.05, 0), seg('tiny-b', 0.1, 0.05)],
      phi: 1,
      days: 28,
    });
    expect(r.df).toBe(2); // blog, services, other
    expect(r.top.map((t) => t.label)).toContain(OTHER_LABEL);
  });

  it('needs at least two segments with data', () => {
    expect(localise({ date: DATE, segments: [seg('only', 10, 5)], phi: 1, days: 28 })).toEqual({ proportional: true, g2: 0, df: 0, p: 1, top: [] });
    expect(localise({ date: DATE, segments: [seg('a', 0, 0), seg('b', 0, 0)], phi: 1, days: 28 }).df).toBe(0);
  });

  it('compares per-day rates when the after window is cut short by the end of the data', () => {
    const short = { label: 'x', start: START, values: Array.from({ length: 70 }, (_, k) => (k < 60 ? 10 : 5)) };
    const other = { label: 'y', start: START, values: Array.from({ length: 70 }, () => 10) };
    const r = localise({ date: DATE, segments: [short, other], phi: 1, days: 28 });
    expect(r.proportional).toBe(false);
    expect(r.top.find((t) => t.label === 'x')?.changePct).toBeCloseTo(-0.5, 9);
    expect(r.top.find((t) => t.label === 'y')?.changePct).toBeCloseTo(0, 9);
  });
});
