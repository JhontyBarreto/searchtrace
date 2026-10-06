// Pure planner: which days to seal, fetch fresh and revalidate (4.2). Owner: WP-B.
//
// Rules (spec 4.2, "Planning"):
// 1. sealDays: every day d with lower <= d < F that has no sealed file. lower is the first day with
//    data (from earlier sealed files) or, on the first run, today minus backfillMonths months plus
//    one day. A full 16-month backfill starts at the 1st of that month instead (retentionStart),
//    because Google still serves those days. Days on or after F (firstIncompleteDate) are never sealed: Google is still filling them in.
// 2. revalidateDays: sealed days that were sealed while young (fetchedAt - start of the day <
//    revalidateAfterDays days), are now at least revalidateAfterDays old, and have not been
//    revalidated. A day already at revision 2 or more has been revalidated (revisions are only
//    written by a revalidation).
// 3. rangeChunks: one [first, last] span per calendar month covering sealDays and revalidateDays.
import { addDays, dateRange, diffDays, ptDayStart } from '../../core/time.js';
import type { GscPlan, GscPlanState, IsoDate } from '../../core/types.js';

const DAY_MS = 86_400_000;

/** Search Console keeps about 16 months of history. Older days cannot be fetched. */
export const GSC_RETENTION_MONTHS = 16;
/** The probe asks for the last 10 days with dataState "all" to learn firstIncompleteDate. */
export const PROBE_DAYS = 10;
/** When the probe has not said (dry runs, or no recent data), assume the last 3 days are not final yet. */
export const FALLBACK_LAG_DAYS = 3;

/** Calendar-month subtraction, clamping the day to the target month's length (2026-03-31 minus 1 month = 2026-02-28). */
export function subtractMonths(d: IsoDate, months: number): IsoDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** First day of a backfill of `months` months ending today: today minus months, plus one day. */
export function backfillStart(today: IsoDate, months: number): IsoDate {
  return addDays(subtractMonths(today, months), 1);
}

/**
 * The earliest day worth asking Search Console for: the 1st of the month 16 months back. Google's
 * "16 months" is loose (measured on 2026-10-06: final data was still served back to 2025-05-25),
 * and asking for a day it no longer has just returns no rows, so a full backfill starts here
 * rather than at today minus 16 months. The range calls are per calendar month either way.
 */
export function retentionStart(today: IsoDate): IsoDate {
  return `${subtractMonths(today, GSC_RETENTION_MONTHS).slice(0, 7)}-01`;
}

/** firstIncompleteDate F, or today minus 3 days when the probe has not told us. Never later than today. */
export function effectiveIncompleteDate(s: Pick<GscPlanState, 'today' | 'firstIncompleteDate'>): IsoDate {
  const f = s.firstIncompleteDate ?? addDays(s.today, -FALLBACK_LAG_DAYS);
  return f > s.today ? s.today : f;
}

/** One [first, last] span per calendar month, in date order. */
export function monthChunks(days: IsoDate[]): [IsoDate, IsoDate][] {
  const byMonth = new Map<string, [IsoDate, IsoDate]>();
  for (const d of [...new Set(days)].sort()) {
    const key = d.slice(0, 7);
    const span = byMonth.get(key);
    if (!span) byMonth.set(key, [d, d]);
    else span[1] = d;
  }
  return [...byMonth.values()];
}

/** Highest revision per sealed day, with that revision's fetchedAt. */
export function latestRevisions(sealed: GscPlanState['sealed']): Map<IsoDate, { revision: number; fetchedAt: string }> {
  const out = new Map<IsoDate, { revision: number; fetchedAt: string }>();
  for (const s of sealed) {
    const prev = out.get(s.day);
    if (!prev || s.revision > prev.revision) out.set(s.day, { revision: s.revision, fetchedAt: s.fetchedAt });
  }
  return out;
}

/**
 * True when a day was sealed while Google might still have been revising it: fetchedAt is less
 * than `afterDays` days after the start of the day (Pacific Time). An unknown fetchedAt counts as no.
 */
export function sealedYoung(day: IsoDate, fetchedAt: string, afterDays: number): boolean {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return false;
  return at - Date.parse(ptDayStart(day)) < afterDays * DAY_MS;
}

export function planGsc(s: GscPlanState): GscPlan {
  const F = effectiveIncompleteDate(s);
  const latest = latestRevisions(s.sealed);
  const retention = retentionStart(s.today);
  const months = Math.max(1, Math.floor(s.backfillMonths));
  const lower = s.firstDataDay
    ? s.firstDataDay > retention
      ? s.firstDataDay
      : retention
    : months >= GSC_RETENTION_MONTHS
      ? retention
      : backfillStart(s.today, months);
  const lastSealable = addDays(F, -1);
  const sealDays = lower <= lastSealable ? dateRange(lower, lastSealable).filter((d) => !latest.has(d)) : [];

  const revalidated = new Set(s.revalidated);
  const after = s.revalidateAfterDays;
  const revalidateDays = [...latest.entries()]
    .filter(
      ([day, x]) =>
        day < F &&
        x.revision < 2 &&
        !revalidated.has(day) &&
        diffDays(day, s.today) >= after &&
        sealedYoung(day, x.fetchedAt, after),
    )
    .map(([day]) => day)
    .sort();

  return {
    probeFrom: addDays(s.today, -PROBE_DAYS),
    probeTo: s.today,
    sealDays,
    revalidateDays,
    rangeChunks: monthChunks([...sealDays, ...revalidateDays]),
  };
}
