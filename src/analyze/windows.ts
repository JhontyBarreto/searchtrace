// Baseline, current, fit, placebo, change-point and seasonal windows from dataThrough (5.1). Owner: WP-E.
//
// D is the last sealed day and L the window length (28 by default). With L = 28:
//   current   [D-27, D]          baseline  [D-55, D-28]      (same weekdays)
//   fit       [D-209, D-28]      182 days ending at the end of the baseline, so it never includes the current window
//   holdout   the last L days of the fit window
//   placebo   pre1 [D-111, D-84], pre2 [D-83, D-56]
//   change point [D-181, D]      the last 182 sealed days
//   seasonal  baseline and current shifted back 364 days (52 weeks, so weekdays still line up)
// For other L, 28 becomes L, 55 becomes 2L-1, and so on.
import { addDays } from '../core/time.js';
import type { AnalysisWindows, IsoDate } from '../core/types.js';

/** Length of the curve fit window and of the change-point window, in days. */
export const FIT_DAYS = 182;
export const CHANGEPOINT_DAYS = 182;
/** Seasonal shift: 52 weeks, so the seasonal windows keep the same weekdays. */
export const SEASONAL_SHIFT_DAYS = 364;

const span = (end: IsoDate, days: number): [IsoDate, IsoDate] => [addDays(end, -(days - 1)), end];

/**
 * The analysis windows for data through D. The seasonal windows are always filled in here;
 * withHistory() sets them to null when the stored history does not reach back that far.
 */
export function computeWindows(dataThrough: IsoDate, windowDays: number): AnalysisWindows {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError(`computeWindows: windowDays must be a whole number >= 1, got ${windowDays}`);
  const L = windowDays;
  const current = span(dataThrough, L);
  const baseline = span(addDays(dataThrough, -L), L);
  const fit = span(baseline[1], FIT_DAYS);
  const holdoutFrom = addDays(fit[1], -(L - 1));
  const pre2 = span(addDays(dataThrough, -2 * L), L);
  const pre1 = span(addDays(dataThrough, -3 * L), L);
  const changepoint = span(dataThrough, CHANGEPOINT_DAYS);
  const shift = (w: [IsoDate, IsoDate]): [IsoDate, IsoDate] => [addDays(w[0], -SEASONAL_SHIFT_DAYS), addDays(w[1], -SEASONAL_SHIFT_DAYS)];
  const seasonal: AnalysisWindows['seasonal'] = { baseline: shift(baseline), current: shift(current) };
  return { baseline, current, fit, holdoutFrom, placebo: { pre1, pre2 }, changepoint, seasonal };
}

/** The same windows with `seasonal` set to null unless history (from historyStart) covers last year's baseline. */
export function withHistory(w: AnalysisWindows, historyStart: IsoDate | null): AnalysisWindows {
  if (w.seasonal && historyStart !== null && w.seasonal.baseline[0] >= historyStart) return w;
  return { ...w, seasonal: null };
}

/** True when day d lies in the inclusive window w. IsoDates compare correctly as strings. */
export function inWindow(d: IsoDate, w: [IsoDate, IsoDate]): boolean {
  return d >= w[0] && d <= w[1];
}

/** True when the inclusive windows a and b share at least one day. */
export function windowsOverlap(a: [IsoDate, IsoDate], b: [IsoDate, IsoDate]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
