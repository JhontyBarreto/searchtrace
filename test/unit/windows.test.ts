// Analysis windows (spec 5.1). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { diffDays, weekday } from '../../src/core/time.js';
import { computeWindows, inWindow, windowsOverlap, withHistory } from '../../src/analyze/windows.js';

describe('computeWindows', () => {
  it('matches the 5.1 table for D = 2026-10-03 and L = 28', () => {
    const w = computeWindows('2026-10-03', 28);
    expect(w.current).toEqual(['2026-09-06', '2026-10-03']);
    expect(w.baseline).toEqual(['2026-08-09', '2026-09-05']);
    expect(w.fit).toEqual(['2026-03-08', '2026-09-05']);
    expect(diffDays(w.fit[0], w.fit[1]) + 1).toBe(182);
    expect(w.holdoutFrom).toBe('2026-08-09');
    expect(w.placebo).toEqual({ pre1: ['2026-06-14', '2026-07-11'], pre2: ['2026-07-12', '2026-08-08'] });
    expect(w.changepoint).toEqual(['2026-04-05', '2026-10-03']);
    expect(w.seasonal).toEqual({ baseline: ['2025-08-10', '2025-09-06'], current: ['2025-09-07', '2025-10-04'] });
    // Same weekdays in baseline and current, and in the seasonal windows.
    expect(weekday(w.baseline[0])).toBe(weekday(w.current[0]));
    expect(weekday(w.seasonal!.current[1])).toBe(weekday(w.current[1]));
    // The fit window never includes the current window.
    expect(w.fit[1] < w.current[0]).toBe(true);
  });

  it('scales with other window lengths (28 -> L, 55 -> 2L - 1, ...)', () => {
    const w = computeWindows('2026-10-03', 14);
    expect(w.current).toEqual(['2026-09-20', '2026-10-03']);
    expect(w.baseline).toEqual(['2026-09-06', '2026-09-19']);
    expect(w.placebo.pre2).toEqual(['2026-08-23', '2026-09-05']);
    expect(w.placebo.pre1).toEqual(['2026-08-09', '2026-08-22']);
    expect(w.holdoutFrom).toBe('2026-09-06');
    expect(() => computeWindows('2026-10-03', 0)).toThrow();
  });

  it('drops the seasonal windows when history does not cover them', () => {
    const w = computeWindows('2026-10-03', 28);
    expect(withHistory(w, '2025-06-01').seasonal).not.toBeNull();
    expect(withHistory(w, '2025-08-10').seasonal).not.toBeNull();
    expect(withHistory(w, '2025-08-11').seasonal).toBeNull();
    expect(withHistory(w, null).seasonal).toBeNull();
    expect(inWindow('2026-09-06', w.current)).toBe(true);
    expect(inWindow('2026-09-05', w.current)).toBe(false);
    expect(windowsOverlap(w.baseline, w.current)).toBe(false);
    expect(windowsOverlap(w.fit, w.baseline)).toBe(true);
  });
});
