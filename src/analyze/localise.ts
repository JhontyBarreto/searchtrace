// G-squared localisation test (5.6). Owner: WP-B.
//
// For a site-level change on date d: a 2 x S table of segment totals for the `days` days before d
// against the `days` days from d. Segments whose expected count is under 5 in either column merge
// into "other". G2 = 2 sum O ln(O / E), divided by phi for overdispersion, is compared with a
// chi-square on S - 1 degrees of freedom. Four outcomes (read with localiseOutcome):
//   concentrated: rejected at 0.05, some segments moved more than others;
//   proportional: every segment's change relative to the whole sits inside +-15% (an equivalence
//     check, so small sites rarely pass: that is the honest answer);
//   no_clear_section: not rejected, but not shown to be proportional either (too little data);
//   untestable: fewer than 2 segments with data, nothing was tested.
// Failing to reject is never read as proportional. `top` always lists the segments by Pearson
// residual with their own change, so the report can show them whatever the outcome.
import { addDays, diffDays } from '../core/time.js';
import type { IsoDate, LocaliseInput, LocaliseResult } from '../core/types.js';
import { chiSquareTail } from './stats.js';

const MIN_EXPECTED = 5;
const ALPHA = 0.05;
/** Equivalence margin for "in proportion": each segment's ratio to the whole within [1/1.15, 1.15]. */
const EQUIVALENCE = 0.15;
const TOP_N = 5;
export const OTHER_LABEL = 'other';

interface Row { label: string; before: number; after: number; beforeDays: number; afterDays: number }

/** Sum of values over [from, to] for a series starting at `start`, clipped to the data. Also returns the days covered. */
function windowSum(values: number[], start: IsoDate, from: IsoDate, to: IsoDate): { sum: number; days: number } {
  const lo = Math.max(0, diffDays(start, from));
  const hi = Math.min(values.length - 1, diffDays(start, to));
  let sum = 0;
  let days = 0;
  for (let k = lo; k <= hi; k++) {
    const v = values[k];
    if (Number.isFinite(v)) sum += v;
    days++;
  }
  return { sum, days };
}

function expected(rows: Row[]): { eb: number[]; ea: number[]; N: number } {
  const totB = rows.reduce((s, r) => s + r.before, 0);
  const totA = rows.reduce((s, r) => s + r.after, 0);
  const N = totB + totA;
  if (!(N > 0)) return { eb: rows.map(() => 0), ea: rows.map(() => 0), N: 0 };
  return {
    eb: rows.map((r) => ((r.before + r.after) * totB) / N),
    ea: rows.map((r) => ((r.before + r.after) * totA) / N),
    N,
  };
}

export function localise(i: LocaliseInput): LocaliseResult {
  const days = Math.max(1, Math.floor(i.days));
  const phi = i.phi > 0 && Number.isFinite(i.phi) ? Math.max(1, i.phi) : 1;
  let rows: Row[] = i.segments.map((seg) => {
    const b = windowSum(seg.values, seg.start, addDays(i.date, -days), addDays(i.date, -1));
    const a = windowSum(seg.values, seg.start, i.date, addDays(i.date, days - 1));
    return { label: seg.label, before: b.sum, after: a.sum, beforeDays: b.days, afterDays: a.days };
  });
  rows = rows.filter((r) => r.before + r.after > 0);

  // Merge sparse segments into "other".
  const first = expected(rows);
  const keep: Row[] = [];
  const other: Row = { label: OTHER_LABEL, before: 0, after: 0, beforeDays: 0, afterDays: 0 };
  let merged = 0;
  rows.forEach((r, k) => {
    if (Math.min(first.eb[k], first.ea[k]) < MIN_EXPECTED) {
      other.before += r.before;
      other.after += r.after;
      other.beforeDays = Math.max(other.beforeDays, r.beforeDays);
      other.afterDays = Math.max(other.afterDays, r.afterDays);
      merged++;
    } else {
      keep.push(r);
    }
  });
  if (merged > 0 && other.before + other.after > 0) keep.push(other);

  const S = keep.length;
  if (S < 2) return { proportional: false, g2: 0, df: 0, p: 1, top: [] };
  const { eb, ea } = expected(keep);
  let g2 = 0;
  keep.forEach((r, k) => {
    if (r.before > 0 && eb[k] > 0) g2 += r.before * Math.log(r.before / eb[k]);
    if (r.after > 0 && ea[k] > 0) g2 += r.after * Math.log(r.after / ea[k]);
  });
  g2 = Math.max(0, 2 * g2);
  const df = S - 1;
  const p = chiSquareTail(g2 / phi, df);
  // Proportional only when every segment's ratio to the whole is shown to sit within the margin.
  const A = keep.reduce((t, r) => t + r.before, 0);
  const B = keep.reduce((t, r) => t + r.after, 0);
  const equivalent = !(p < ALPHA) && A > 0 && B > 0 && keep.every((r) => {
    if (!(r.before > 0) || !(r.after > 0)) return false;
    const lr = Math.log(r.after / r.before / (B / A));
    const se = Math.sqrt(phi * (1 / r.before + 1 / r.after + 1 / A + 1 / B));
    return lr - 1.96 * se > -Math.log1p(EQUIVALENCE) && lr + 1.96 * se < Math.log1p(EQUIVALENCE);
  });
  const top = keep
    .map((r, k) => {
      const residual = ea[k] > 0 ? (r.after - ea[k]) / Math.sqrt(ea[k]) : 0;
      // Per-day rates, so a short "after" window (a change near the end of the data) compares fairly.
      const rb = r.beforeDays > 0 ? r.before / r.beforeDays : 0;
      const ra = r.afterDays > 0 ? r.after / r.afterDays : 0;
      // A segment with nothing before counts as +100% rather than an infinite change.
      const changePct = rb > 0 ? ra / rb - 1 : ra > 0 ? 1 : 0;
      return { label: r.label, residual, changePct };
    })
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, TOP_N);
  return { proportional: equivalent, g2, df, p, top };
}

export type LocaliseOutcome = 'concentrated' | 'proportional' | 'no_clear_section' | 'untestable';

/** The outcome of a localisation result (see the header). */
export function localiseOutcome(r: LocaliseResult): LocaliseOutcome {
  if (r.df === 0) return 'untestable';
  if (r.p < ALPHA) return 'concentrated';
  return r.proportional ? 'proportional' : 'no_clear_section';
}

/** One evidence line for a localisation result, or null when nothing was tested. */
export function localiseText(r: LocaliseResult): string | null {
  const o = localiseOutcome(r);
  if (o === 'untestable') return null;
  if (o === 'proportional') return 'Spread across your site in proportion';
  const parts = r.top.slice(0, 3).map((t) => `${t.label} ${t.changePct >= 0 ? '+' : '-'}${Math.round(Math.abs(t.changePct) * 100)}%`);
  if (o === 'concentrated') return `Concentrated in ${parts.join(', ')}`;
  return `No single section stood out (too little data to tell): ${parts.join(', ')}`;
}
