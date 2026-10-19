// Spec 5.13 test 31: the G-squared localisation test. Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import { OTHER_LABEL, localise, localiseOutcome, localiseText } from '../../src/analyze/localise.js';

const START = '2026-06-01';
const DATE = addDays(START, 60);
/** A flat segment of `before` a day that becomes `after` a day from DATE. */
const seg = (label: string, before: number, after: number) => ({
  label,
  start: START,
  values: Array.from({ length: 120 }, (_, k) => (k < 60 ? before : after)),
});

describe('localise (test 31)', () => {
  it('does not reject when every segment falls by the same share, but only calls it proportional with enough data', () => {
    // Failing to reject is not proof: at these counts a segment could still differ by more than 15%,
    // so the outcome is "no single section stood out" (it used to read "in proportion").
    const r = localise({ date: DATE, segments: [seg('/blog/*', 50, 35), seg('/services/*', 20, 14), seg('other pages', 10, 7)], phi: 1, days: 28 });
    expect(r.proportional).toBe(false);
    expect(localiseOutcome(r)).toBe('no_clear_section');
    expect(r.df).toBe(2);
    expect(r.g2).toBeCloseTo(0, 9);
    expect(r.p).toBeGreaterThan(0.5);
    expect(r.top.map((t) => t.label).sort()).toEqual(['/blog/*', '/services/*', 'other pages']);
    expect(localiseText(r)).toMatch(/^No single section stood out/);
    // With 20 times the traffic every segment's ratio is shown to sit within +-15%: proportional.
    const big = localise({ date: DATE, segments: [seg('/blog/*', 1000, 700), seg('/services/*', 400, 280), seg('other pages', 200, 140)], phi: 1, days: 28 });
    expect(big.proportional).toBe(true);
    expect(localiseOutcome(big)).toBe('proportional');
    expect(localiseText(big)).toBe('Spread across your site in proportion');
  });

  it('never calls an uneven change proportional on a small site (found on a real site: one section +75%, the rest flat)', () => {
    const blog = localise({ date: DATE, segments: [seg('/blog/*', 1, 1.75), seg('/', 0.9, 0.85), seg('other pages', 0.6, 0.6)], phi: 1.6, days: 28 });
    expect(blog.proportional).toBe(false);
    expect(localiseOutcome(blog)).not.toBe('proportional');
    expect(blog.top[0].label).toBe('/blog/*');
    expect(blog.top[0].changePct).toBeCloseTo(0.75, 9);
    const split = localise({ date: DATE, segments: [seg('a', 1.5, 0.6), seg('b', 2, 1.8)], phi: 1.5, days: 28 });
    expect(localiseOutcome(split)).not.toBe('proportional');
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
    expect(localiseOutcome(plain)).toBe('concentrated');
    expect(localiseOutcome(wide)).toBe('no_clear_section');
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
    // Nothing is tested with one segment: untestable, never "proportional", and no evidence line.
    const one = localise({ date: DATE, segments: [seg('only', 10, 5)], phi: 1, days: 28 });
    expect(one).toEqual({ proportional: false, g2: 0, df: 0, p: 1, top: [] });
    expect(localiseOutcome(one)).toBe('untestable');
    expect(localiseText(one)).toBeNull();
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
