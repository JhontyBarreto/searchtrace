// Change-point helpers that read a series' stored history outside the change-point window (5.6). Owner: WP-B.
//
// Wander: real traffic drifts from month to month far more than Poisson counts do, and the day-level
// dispersion (MAD around a +-7 day mean) cannot see drift longer than about two weeks. Left out, a
// slow wander looks like a string of "Real change" steps. So each series gets an extra log-ratio
// variance between adjacent 28-day periods, measured on its own history before the window:
//   v_extra = (1.4826 MAD of ln(S2 / S1))^2 - mean Poisson part phi (1/S1 + 1/S2), floored at 0,
// using only pairs whose windows both hold at least half the window's current 28-day level (a much
// quieter era carries extra counting noise and would inflate it). With fewer than 8 such pairs the
// caller falls back to the whole site's estimate. It enters the tests as extra long-run variance
// per observation, L m^2 v / 2 with L = 56 days (twice the measuring window: a safety factor that
// a simulation with AR(1) wander showed is needed), and as an effective dispersion phi + L m v / 2.
//
// Lifecycle: a page first seen inside the window ("born") is zero and then positive, so a test of
// "constant rate over the window" rejects by construction and says nothing about the page. A birth
// is the first day with any value lying after the window's first day, judged on the whole stored
// history (a page active last year is seasonal, not new). Births are tested only from 28 days after
// they appear; the appearance itself is reported as one grouped fact.
import { findingId } from '../core/ids.js';
import { addDays, diffDays } from '../core/time.js';
import type { ChangePoint, ChangePointInput, Finding, IsoDate, Series } from '../core/types.js';
import { layout } from '../store/layout.js';
import { mad } from './stats.js';

export const CHANGEPOINT_VERSION = '1';
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Days in each window of a wander pair. */
const PAIR_DAYS = 28;
/** Pairs end every 7 days. */
const PAIR_STEP = 7;
/** Fewer comparable pairs than this and the series uses the site's estimate. */
export const MIN_WANDER_PAIRS = 8;
/** The L in L m^2 v / 2 (days). */
export const WANDER_L_DAYS = 56;
/** Days of burn-in after a birth before the series is tested. */
export const BIRTH_BURN_IN = 28;

/**
 * Extra log-ratio variance between adjacent 28-day periods, beyond counting noise, from the history
 * before `windowStart`. Null when fewer than MIN_WANDER_PAIRS comparable pairs exist.
 */
export function wanderVariance(
  hist: { start: IsoDate; values: number[] } | undefined, windowStart: IsoDate, windowMean: number, phi: number,
): number | null {
  if (!hist || !(windowMean > 0)) return null;
  const end = Math.min(hist.values.length, diffDays(hist.start, windowStart));
  if (end < 2 * PAIR_DAYS) return null;
  const floor = 0.5 * windowMean * PAIR_DAYS;
  const sum = (a: number, b: number): number => {
    let s = 0;
    for (let k = a; k < b; k++) s += Math.max(0, hist.values[k] || 0);
    return s;
  };
  const r: number[] = [];
  let poisson = 0;
  for (let e = end; e - 2 * PAIR_DAYS >= 0; e -= PAIR_STEP) {
    const s1 = sum(e - 2 * PAIR_DAYS, e - PAIR_DAYS);
    const s2 = sum(e - PAIR_DAYS, e);
    if (!(s1 >= floor) || !(s2 >= floor)) continue;
    r.push(Math.log(s2 / s1));
    poisson += Math.max(1, phi) * (1 / s1 + 1 / s2);
  }
  if (r.length < MIN_WANDER_PAIRS) return null;
  const robust = (1.4826 * mad(r)) ** 2;
  return Math.max(0, robust - poisson / r.length);
}

/** Extra long-run variance per observation for the CUSUM scale: L m^2 v / 2 (L and m per observation). */
export function wanderLongRun(v: number, meanPerObs: number, stepDays: number): number {
  return v > 0 && meanPerObs > 0 ? ((WANDER_L_DAYS / stepDays) * meanPerObs * meanPerObs * v) / 2 : 0;
}

/** Effective dispersion for costs and ranges: phi + L m v / 2. */
export function wanderPhi(phi: number, v: number, meanPerObs: number, stepDays: number): number {
  return phi + (v > 0 && meanPerObs > 0 ? ((WANDER_L_DAYS / stepDays) * meanPerObs * v) / 2 : 0);
}

/**
 * The day a series first shows any value, judged on its whole stored history, when that day lies
 * after `windowStart` (a birth inside the window); otherwise null. With at least 28 days of empty
 * history before the window any later first day is a birth. Without that history a few zero days
 * at the start are ordinary counting noise, so it takes 14 empty days in a row to call a birth.
 */
export function birthDay(windowStart: IsoDate, windowValues: number[], hist?: { start: IsoDate; values: number[] }): IsoDate | null {
  let priorDays = 0;
  if (hist) {
    const before = Math.min(hist.values.length, Math.max(0, diffDays(hist.start, windowStart)));
    for (let k = 0; k < before; k++) if ((hist.values[k] || 0) > 0) return null;
    priorDays = before;
  }
  const first = windowValues.findIndex((v) => (v || 0) > 0);
  if (first <= 0) return null;
  return first >= (priorDays >= BIRTH_BURN_IN ? 1 : 14) ? addDays(windowStart, first) : null;
}

/**
 * Never say "in proportion" when a segment of the same series has its own real change around the
 * same dates (a section that carries the whole change): say so instead.
 */
export function guardProportional(
  i: ChangePointInput, cps: ChangePoint[], findings: Finding[], bySeries: { seriesId: string; f: Finding }[],
  intersects: (a: [IsoDate, IsoDate], b: [IsoDate, IsoDate]) => boolean,
): void {
  for (const cp of cps) {
    if (!cp.localisation?.proportional) continue;
    const pad: [IsoDate, IsoDate] = [addDays(cp.dateWindow[0], -7), addDays(cp.dateWindow[1], 7)];
    const segs = new Set(i.series.filter((x) => x.segmentsOf === cp.seriesId && x.metric === cp.metric).map((x) => x.id));
    const hit = bySeries.find((b) => segs.has(b.seriesId) && b.f.real === 'signal' && b.f.dateWindow && intersects(b.f.dateWindow, pad));
    if (!hit) continue;
    cp.localisation = { ...cp.localisation, proportional: false };
    const f = findings.find((x) => x.date === cp.date && x.evidence.some((e) => e.key?.localisation === cp.seriesId));
    const ev = f?.evidence.find((e) => e.key?.localisation === cp.seriesId);
    if (ev) ev.summary = `Not in proportion: ${hit.f.unit.label} has its own real change around then`;
  }
}

/** Mean daily value of a series over its last `days` days. */
function recentLevel(series: Series | undefined, days: number): number {
  if (!series || !series.values.length) return 0;
  const tail = series.values.slice(-days);
  return tail.reduce((a, b) => a + Math.max(0, b || 0), 0) / tail.length;
}

/**
 * One grouped fact for pages that started appearing in Google inside the window (5.6): the
 * appearance itself, with today's level, never a percent change or an update cause.
 */
export function appearanceFinding(i: ChangePointInput, appeared: Map<string, { label: string; date: IsoDate }>, days: number): Finding | null {
  if (appeared.size === 0) return null;
  const list = [...appeared.entries()].sort((a, b) => cmp(a[1].date, b[1].date) || cmp(a[0], b[0]));
  const dates = list.map(([, x]) => x.date).sort();
  const level = (key: string, metric: Series['metric']): number => recentLevel(i.series.find((x) => x.unit.level === 'page' && x.unit.key === key && x.metric === metric), days);
  const impr = list.reduce((t, [k]) => t + level(k, 'impressions'), 0);
  const clicks = list.reduce((t, [k]) => t + level(k, 'clicks'), 0);
  const names = list.slice(0, 8).map(([, x]) => x.label);
  const more = list.length > names.length ? ` and ${list.length - names.length} more` : '';
  return {
    id: findingId(['notice', 'appearances', i.dataThrough]),
    kind: 'notice',
    unit: { level: 'site', key: 'site', label: 'Whole site' },
    metric: 'impressions',
    windows: null,
    date: dates[dates.length - 1],
    dateWindow: [dates[0], dates[dates.length - 1]],
    effect: { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null },
    real: 'noise',
    reason: 'fact',
    cause: null,
    causeConfidence: 'EXTRACTED',
    components: null,
    componentCi95: null,
    power: null,
    template: 'change_point',
    slots: { appeared: list.length, d1: dates[0], d2: dates[dates.length - 1], impr_day: Math.round(impr * 10) / 10, clicks_day: Math.round(clicks * 10) / 10 },
    evidence: [{ type: 'gsc', confidence: 'EXTRACTED', partition: layout.gscDay(dates[0]), summary: `Started appearing: ${names.join(', ')}${more}` }],
    alternatives: [],
    falsifier: { key: 'record_changes', slots: {} },
    verify: null,
    related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { name: 'changepoint', version: CHANGEPOINT_VERSION },
    priority: 5,
  };
}
