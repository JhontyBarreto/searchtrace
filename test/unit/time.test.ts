import { describe, expect, it } from 'vitest';
import {
  addDays, dateRange, diffDays, fixedClock, isIsoDate, isoWeek, ptDate, ptDayStart, systemClock, toInstant, utcMonth, weekday,
} from '../../src/core/time.js';
import { StError } from '../../src/core/errors.js';

describe('ptDate across daylight saving (test 69)', () => {
  it('maps UTC instants to the Pacific Time calendar day around the March change (2026-03-08)', () => {
    expect(ptDate('2026-03-08T07:59:59Z')).toBe('2026-03-07'); // 23:59:59 PST on the 7th
    expect(ptDate('2026-03-08T08:00:00Z')).toBe('2026-03-08'); // midnight PST
    expect(ptDate('2026-03-08T09:59:59Z')).toBe('2026-03-08'); // 01:59:59 PST
    expect(ptDate('2026-03-08T10:00:00Z')).toBe('2026-03-08'); // 03:00 PDT (02:00 never happens)
    expect(ptDate('2026-03-09T06:59:59Z')).toBe('2026-03-08'); // 23:59:59 PDT
    expect(ptDate('2026-03-09T07:00:00Z')).toBe('2026-03-09'); // midnight PDT
  });

  it('maps UTC instants to the Pacific Time calendar day around the November change (2026-11-01)', () => {
    expect(ptDate('2026-11-01T06:59:59Z')).toBe('2026-10-31');
    expect(ptDate('2026-11-01T07:00:00Z')).toBe('2026-11-01'); // midnight PDT
    expect(ptDate('2026-11-01T08:30:00Z')).toBe('2026-11-01'); // 01:30 PDT
    expect(ptDate('2026-11-01T09:30:00Z')).toBe('2026-11-01'); // 01:30 PST (the repeated hour)
    expect(ptDate('2026-11-02T07:59:59Z')).toBe('2026-11-01'); // 23:59:59 PST
    expect(ptDate('2026-11-02T08:00:00Z')).toBe('2026-11-02');
  });

  it('dates a crawl the way site-change dating expects (test 39 example)', () => {
    expect(ptDate('2026-09-24T03:00:00Z')).toBe('2026-09-23');
    expect(ptDate(new Date('2026-10-04T23:22:42Z'))).toBe('2026-10-04');
  });

  it('rejects instants that do not parse', () => {
    expect(() => ptDate('not a date')).toThrow(StError);
    expect(() => ptDate(new Date(Number.NaN))).toThrow(StError);
  });
});

describe('ptDayStart', () => {
  it('is 08:00Z on PST days and 07:00Z on PDT days, including both change days', () => {
    expect(ptDayStart('2026-03-07')).toBe('2026-03-07T08:00:00Z');
    expect(ptDayStart('2026-03-08')).toBe('2026-03-08T08:00:00Z'); // midnight is still PST
    expect(ptDayStart('2026-03-09')).toBe('2026-03-09T07:00:00Z');
    expect(ptDayStart('2026-11-01')).toBe('2026-11-01T07:00:00Z'); // midnight is still PDT
    expect(ptDayStart('2026-11-02')).toBe('2026-11-02T08:00:00Z');
    expect(ptDayStart('2026-07-04')).toBe('2026-07-04T07:00:00Z');
  });

  it('round-trips with ptDate for every day of 2026', () => {
    for (const d of dateRange('2026-01-01', '2026-12-31')) {
      expect(ptDate(ptDayStart(d))).toBe(d);
      expect(ptDate(new Date(Date.parse(ptDayStart(d)) - 1000))).toBe(addDays(d, -1));
    }
  });
});

describe('calendar math', () => {
  it('adds and diffs days across months, years, leap days and DST', () => {
    expect(addDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDays('2026-10-03', -3)).toBe('2026-09-30');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(diffDays('2026-10-01', '2026-10-03')).toBe(2);
    expect(diffDays('2026-10-03', '2026-10-01')).toBe(-2);
    expect(diffDays('2025-06-01', '2026-10-03')).toBe(489);
    expect(diffDays('2026-03-01', '2026-11-30')).toBe(274);
  });

  it('dateRange is inclusive and empty when reversed', () => {
    expect(dateRange('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(dateRange('2026-10-03', '2026-10-03')).toEqual(['2026-10-03']);
    expect(dateRange('2026-10-04', '2026-10-03')).toEqual([]);
    expect(dateRange('2025-06-01', '2026-10-03')).toHaveLength(490);
  });

  it('isoWeek follows ISO 8601 (weeks start Monday, week 1 holds the first Thursday)', () => {
    expect(isoWeek('2026-10-06')).toBe('2026-W41');
    expect(isoWeek('2026-01-01')).toBe('2026-W01'); // a Thursday
    expect(isoWeek('2025-12-29')).toBe('2026-W01'); // Monday of that week
    expect(isoWeek('2025-12-28')).toBe('2025-W52');
    expect(isoWeek('2021-01-03')).toBe('2020-W53');
    expect(isoWeek('2026-12-31')).toBe('2026-W53');
  });

  it('weekday is Monday 0 to Sunday 6', () => {
    expect(weekday('2026-10-05')).toBe(0);
    expect(weekday('2026-10-06')).toBe(1);
    expect(weekday('2026-10-11')).toBe(6);
  });

  it('isIsoDate accepts real calendar days only', () => {
    expect(isIsoDate('2026-10-03')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-10-3', '2026-10-03T00:00:00Z', '', '20261003']) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });

  it('rejects invalid input instead of guessing', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(StError);
    expect(() => addDays('2026-10-03', 1.5)).toThrow(StError);
    expect(() => isoWeek('soon')).toThrow(StError);
  });
});

describe('instants and clocks', () => {
  it('toInstant drops milliseconds and utcMonth uses the UTC month', () => {
    expect(toInstant(new Date('2026-10-06T06:17:00.123Z'))).toBe('2026-10-06T06:17:00Z');
    expect(toInstant('2026-10-06T06:17:00+02:00')).toBe('2026-10-06T04:17:00Z');
    expect(utcMonth('2026-10-31T23:59:59Z')).toBe('2026-10');
    expect(utcMonth('2026-11-01T00:00:00Z')).toBe('2026-11');
  });

  it('fixedClock is frozen and cannot be moved by mutating its Date', () => {
    const clock = fixedClock('2026-10-06T06:17:00Z');
    const a = clock.now();
    a.setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-10-06T06:17:00.000Z');
    expect(() => fixedClock('nope')).toThrow(StError);
  });

  it('systemClock tells the real time', () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
