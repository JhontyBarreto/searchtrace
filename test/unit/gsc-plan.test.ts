// Spec 5.13 test 50 (planner) plus calendar helpers. Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { addDays, dateRange, ptDayStart } from '../../src/core/time.js';
import type { GscPlanState } from '../../src/core/types.js';
import { backfillStart, effectiveIncompleteDate, monthChunks, planGsc, retentionStart, subtractMonths } from '../../src/sources/google/gsc-plan.js';

const base = (o: Partial<GscPlanState> = {}): GscPlanState => ({
  today: '2026-10-06',
  firstIncompleteDate: '2026-10-04',
  sealed: [],
  revalidated: [],
  backfillMonths: 16,
  revalidateAfterDays: 10,
  firstDataDay: null,
  ...o,
});

/** Simulates sealing every planned day at `at`. */
function sealAll(s: GscPlanState, days: string[], at: string): GscPlanState {
  return { ...s, sealed: [...s.sealed, ...days.map((day) => ({ day, revision: 1, fetchedAt: at }))], firstDataDay: s.firstDataDay ?? days[0] ?? null };
}

describe('calendar helpers', () => {
  it('subtracts calendar months and clamps the day', () => {
    expect(subtractMonths('2026-10-06', 16)).toBe('2025-06-06');
    expect(subtractMonths('2026-03-31', 1)).toBe('2026-02-28');
    expect(subtractMonths('2024-03-31', 1)).toBe('2024-02-29');
    expect(subtractMonths('2026-01-15', 13)).toBe('2024-12-15');
    expect(backfillStart('2026-10-06', 16)).toBe('2025-06-07');
    expect(retentionStart('2026-10-06')).toBe('2025-06-01');
    expect(retentionStart('2026-10-31')).toBe('2025-06-01');
    expect(retentionStart('2026-01-01')).toBe('2024-09-01');
  });

  it('falls back to today minus 3 when the probe has not given F, and never goes past today', () => {
    expect(effectiveIncompleteDate({ today: '2026-10-06', firstIncompleteDate: null })).toBe('2026-10-03');
    expect(effectiveIncompleteDate({ today: '2026-10-06', firstIncompleteDate: '2026-10-09' })).toBe('2026-10-06');
  });

  it('groups days into one span per calendar month', () => {
    expect(monthChunks(['2026-09-30', '2026-10-02', '2026-09-03', '2026-10-01', '2026-10-02'])).toEqual([
      ['2026-09-03', '2026-09-30'],
      ['2026-10-01', '2026-10-02'],
    ]);
    expect(monthChunks([])).toEqual([]);
  });
});

describe('planGsc (test 50)', () => {
  it('first run: a full backfill seals from the 1st of the month 16 months back up to F - 1, never F or later', () => {
    // Google still serves final data a few days past "16 months" (measured: back to 2025-05-25 on
    // 2026-10-06), so the full backfill asks from 2025-06-01, not today minus 16 months plus a day.
    const p = planGsc(base());
    expect(p.sealDays[0]).toBe('2025-06-01');
    expect(p.sealDays[p.sealDays.length - 1]).toBe('2026-10-03');
    expect(p.sealDays).toEqual(dateRange('2025-06-01', '2026-10-03'));
    expect(p.sealDays.some((d) => d >= '2026-10-04')).toBe(false);
    expect(p.revalidateDays).toEqual([]);
    expect(p.probeFrom).toBe('2026-09-26');
    expect(p.probeTo).toBe('2026-10-06');
    // One range chunk per calendar month, June 2025 to October 2026.
    expect(p.rangeChunks).toHaveLength(17);
    expect(p.rangeChunks[0]).toEqual(['2025-06-01', '2025-06-30']);
    expect(p.rangeChunks[16]).toEqual(['2026-10-01', '2026-10-03']);
  });

  it('respects a shorter backfill and an earlier F', () => {
    const p = planGsc(base({ backfillMonths: 1, firstIncompleteDate: '2026-10-02' }));
    expect(p.sealDays[0]).toBe('2026-09-07');
    expect(p.sealDays[p.sealDays.length - 1]).toBe('2026-10-01');
  });

  it('a second plan with the same state after sealing has 0 seal days', () => {
    const s0 = base({ backfillMonths: 2 });
    const first = planGsc(s0);
    const s1 = sealAll(s0, first.sealDays, '2026-10-06T13:00:00Z');
    const second = planGsc(s1);
    expect(second.sealDays).toEqual([]);
    expect(second.revalidateDays).toEqual([]);
    expect(second.rangeChunks).toEqual([]);
  });

  it('next day: only the newly final day is sealed, and gaps are filled', () => {
    const s0 = base({ backfillMonths: 2 });
    const sealedDays = planGsc(s0).sealDays.filter((d) => d !== '2026-09-01');
    const s1 = sealAll(s0, sealedDays, '2026-10-06T13:00:00Z');
    const next = planGsc({ ...s1, today: '2026-10-07', firstIncompleteDate: '2026-10-05' });
    expect(next.sealDays).toEqual(['2026-09-01', '2026-10-04']);
    // 2026-09-27 was sealed 9 days after it ended (young) and is now 10 days old: due for its check.
    expect(next.revalidateDays).toEqual(['2026-09-27']);
    expect(next.rangeChunks).toEqual([
      ['2026-09-01', '2026-09-27'],
      ['2026-10-04', '2026-10-04'],
    ]);
  });

  it('earlier days than the first data day are never sealed', () => {
    const p = planGsc(base({ firstDataDay: '2026-09-20', sealed: [{ day: '2026-09-25', revision: 1, fetchedAt: '2026-10-06T13:00:00Z' }] }));
    expect(p.sealDays[0]).toBe('2026-09-20');
    expect(p.sealDays).not.toContain('2026-09-25');
  });

  it('revalidation picks only young-sealed days that are old enough and not yet revalidated', () => {
    // Day A: sealed 2 days after it ended (young), now 12 days old -> revalidate.
    // Day B: sealed during the backfill, long after it ended (old) -> never.
    // Day C: young, but only 5 days old -> not yet.
    // Day D: young and old enough, but already revalidated -> no.
    // Day E: young and old enough, already at revision 2 -> no.
    const A = '2026-09-24';
    const B = '2026-06-01';
    const C = '2026-10-01';
    const D = '2026-09-23';
    const E = '2026-09-22';
    const s = base({
      firstDataDay: '2026-06-01',
      sealed: [
        { day: A, revision: 1, fetchedAt: '2026-09-26T13:00:00Z' },
        { day: B, revision: 1, fetchedAt: '2026-09-26T13:00:00Z' },
        { day: C, revision: 1, fetchedAt: '2026-10-03T13:00:00Z' },
        { day: D, revision: 1, fetchedAt: '2026-09-25T13:00:00Z' },
        { day: E, revision: 1, fetchedAt: '2026-09-24T13:00:00Z' },
        { day: E, revision: 2, fetchedAt: '2026-10-04T13:00:00Z' },
      ],
      revalidated: [D],
    });
    const p = planGsc(s);
    expect(p.revalidateDays).toEqual([A]);
    expect(p.rangeChunks.some(([a, b]) => a <= A && A <= b)).toBe(true);
  });

  it('the young test uses the start of the day in Pacific Time', () => {
    const day = '2026-09-20';
    const start = Date.parse(ptDayStart(day));
    const justYoung = new Date(start + 10 * 86_400_000 - 1000).toISOString();
    const justOld = new Date(start + 10 * 86_400_000).toISOString();
    const mk = (fetchedAt: string): GscPlanState =>
      base({ firstDataDay: day, sealed: dateRange(day, '2026-10-03').map((d) => ({ day: d, revision: 1, fetchedAt: d === day ? fetchedAt : '2026-10-06T13:00:00Z' })) });
    expect(planGsc(mk(justYoung)).revalidateDays).toEqual([day]);
    expect(planGsc(mk(justOld)).revalidateDays).toEqual([]);
    expect(planGsc(mk('')).revalidateDays).toEqual([]);
  });

  it('is pure: the same state gives the same plan', () => {
    const s = base({ backfillMonths: 3 });
    expect(planGsc(s)).toEqual(planGsc(structuredClone(s)));
    expect(addDays(planGsc(s).probeTo, -10)).toBe(planGsc(s).probeFrom);
  });
});
