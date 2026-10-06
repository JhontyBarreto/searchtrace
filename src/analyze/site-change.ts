// Stacked difference-in-differences with calendar-matched controls, placebo, synthesis table (5.10). Owner: WP-C.
//
// For each SiteChange:
// - Outcome by class: snippet -> click rate at the same position (C / E with E = sum I f(p) over
//   named cells); content -> impressions (complete page totals); technical -> index state, which
//   index-state.ts reports as facts, plus impressions measured here.
// - Each touched URL u is dated d_u = ptDate(googleSeen.to). URLs Google has not recrawled are
//   left out and listed as notYetSeen. When googleSeen spans more than 7 days the gap is widened
//   by 4 days on the pre side (Google may have seen it as early as googleSeen.from). Annotation
//   changes without a narrow googleSeen use d_u = date + 3 and are never better than AMBIGUOUS.
// - pre_u = [d_u - 28, d_u - 1], a 3-day gap, post_u = [d_u + 3, d_u + 30]. When the data ends
//   before d_u + 30, both windows shrink to the L_u days the post window has (pre_u = [d_u - L_u,
//   d_u - 1]), as long as L_u is at least 14 (two full weeks, every weekday seen twice); with
//   fewer, u is too recent (check again on d_u + 16, the day it first has 14). Equal lengths keep
//   every ratio (tau, the untouched pages' change c, the placebo) a like-for-like comparison; the
//   shorter windows only cost precision, which the bootstrap intervals and weeks observed carry.
// - Controls: same template, not touched, no recorded change within 35 days of any d_u, no
//   change in links pointing at them from touched pages, outcome > 0 before. Fewer than 5 fall
//   back to every untouched page (AMBIGUOUS); none means no estimate (unclear).
// - tau = sum_u Y_u(post_u) / sum_u CF_u - 1 with CF_u = Y_u(pre_u) * g_u, g_u the controls'
//   post/pre ratio over u's own calendar windows. Click rate uses the ratio-of-ratios form.
// - Inference: controls resampled as clusters; treated as clusters when there are 10 or more,
//   else treated counts redrawn from a Poisson. Percentile CIs. Placebo: every d_u moved back 28
//   days; a placebo CI that excludes 0 with |tau| >= delta / 2 fails the placebo check.
// Pure and deterministic: dates come from the inputs and randomness from i.rng(key).
import { findingId } from '../core/ids.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import type {
  Cause, EvidenceRef, Finding, GoogleEvent, IdCheck, Interval, IsoDate, Rng, Segment, SiteChange, SiteChangeImpact,
  SiteChangeInput, TemplateId, VerdictResult,
} from '../core/types.js';
import { normalizeUrl, pathOf } from '../core/url.js';
import { benjaminiHochberg, bootstrapP, percentileCi, poissonDraw } from './stats.js';
import { decideVerdict } from './verdicts.js';

export const SITE_CHANGE_ANALYZER = { name: 'site-change', version: '1' };
const WINDOW = 28;
const GAP = 3;
/** Fewest post-window days a URL needs before it is measured (5.10 with truncated post windows). */
export const MIN_POST_DAYS = 14;
const WIDE_EXTRA = 4;
const WIDE_INTERVAL_MS = 7 * 86_400_000;
const CONTROL_QUIET_DAYS = 35;
const MIN_CONTROLS = 5;
const PLACEBO_SHIFT = 28;
const CLUSTER_TREATED_MIN = 10;
const WEEKS = WINDOW / 7;
const FLOOR = { treated: { clicks: 30, impressions: 1000 }, controls: { clicks: 50, impressions: 5000 } };
/** Upper bound on bootstrap work (replicates x treated x controls); B is reduced to stay under it. */
const WORK_LIMIT = 5e7;
const MIN_B = 200;
const RANKING_KINDS = new Set(['core', 'spam', 'other_ranking']);
const TIER: Record<string, number> = { signal: 1000, unclear: 100, underpowered: 10, noise: 1 };

type Win = [IsoDate, IsoDate];
type Measure = 'ctr' | 'impressions';
type Synthesis = SiteChangeImpact['synthesis'];
/** post: days in the post window, at most WINDOW, cut at the data's end (set once dataThrough is known). */
interface Arm { url: string; d: IsoDate; wide: boolean; seen: boolean; googleSeen: Interval | null; post: number }

// ---------- slot formatting (6.3 rules, local: analysis never imports report code) ----------

function fmtAbsPct(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const pct = Math.abs(x) * 100;
  const one = Math.round(pct * 10) / 10;
  return one >= 10 ? `${Math.round(pct)}%` : `${one.toFixed(1).replace(/\.0$/, '')}%`;
}

/** Signed percent: whole numbers from 10%, one decimal below, ASCII minus. */
export function fmtPct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return 'n/a';
  const body = fmtAbsPct(x);
  return body === '0%' ? body : `${x < 0 ? '-' : '+'}${body}`;
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 10) return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const minDate = (xs: IsoDate[]): IsoDate => xs.reduce((m, x) => (x < m ? x : m));
const maxDate = (xs: IsoDate[]): IsoDate => xs.reduce((m, x) => (x > m ? x : m));
const finite = (x: number | undefined | null): number | null => (x !== undefined && x !== null && Number.isFinite(x) ? x : null);

function safeNormalize(u: string): string {
  try {
    return normalizeUrl(u);
  } catch {
    return u;
  }
}

// ---------- dating and windows ----------

/** d_u for a touched URL: the Pacific Time day of googleSeen.to. '2026-09-24T03:00Z' -> '2026-09-23'. */
export function seenDay(googleSeen: Interval): IsoDate {
  return ptDate(googleSeen.to);
}

/** pre and post windows for a URL first seen on d; days < 28 shortens both (the post window was cut by the data's end). */
export function windowsFor(d: IsoDate, wide: boolean, shift = 0, days = WINDOW): { pre: Win; post: Win } {
  const dd = addDays(d, -shift);
  const extra = wide ? WIDE_EXTRA : 0;
  const len = Math.min(WINDOW, days);
  return { pre: [addDays(dd, -(len + extra)), addDays(dd, -(1 + extra))], post: [addDays(dd, GAP), addDays(dd, GAP + len - 1)] };
}

/** Post-window days available for a URL first seen on d, given data through dataThrough (0 when none). */
export function postDaysFor(d: IsoDate, dataThrough: IsoDate): number {
  return Math.max(0, Math.min(WINDOW, diffDays(addDays(d, GAP), dataThrough) + 1));
}

const armWindows = (a: Arm, shift = 0): { pre: Win; post: Win } => windowsFor(a.d, a.wide, shift, a.post);

function armsOf(e: SiteChange): { arms: Arm[]; notYetSeen: string[] } {
  const arms: Arm[] = [];
  const notYetSeen: string[] = [];
  const noteDay = ptDate(e.deployed.from);
  for (const t of e.touched) {
    const url = safeNormalize(t.url);
    const g = t.googleSeen;
    const width = g ? Date.parse(g.to) - Date.parse(g.from) : Number.POSITIVE_INFINITY;
    if (e.source === 'annotation') {
      if (g && width <= WIDE_INTERVAL_MS) arms.push({ url, d: seenDay(g), wide: false, seen: true, googleSeen: g, post: WINDOW });
      else arms.push({ url, d: addDays(noteDay, GAP), wide: false, seen: false, googleSeen: null, post: WINDOW });
    } else if (!g) {
      notYetSeen.push(url);
    } else {
      arms.push({ url, d: seenDay(g), wide: width > WIDE_INTERVAL_MS, seen: true, googleSeen: g, post: WINDOW });
    }
  }
  return { arms: arms.sort((a, b) => cmp(a.url, b.url)), notYetSeen: notYetSeen.sort(cmp) };
}

// ---------- page series (prefix sums per page and day) ----------

interface Bank {
  start: IsoDate;
  days: number;
  num: Map<string, Float64Array>;
  den: Map<string, Float64Array> | null;
  clicks: Map<string, Float64Array>;
  segE: Map<string, Map<Segment, number>>;
}

function prefix(daily: Float64Array): Float64Array {
  const p = new Float64Array(daily.length + 1);
  for (let k = 0; k < daily.length; k++) p[k + 1] = p[k] + daily[k];
  return p;
}

/** Impressions bank from page totals, or click-rate bank (clicks over curve-expected clicks) from named cells. */
function buildBank(i: SiteChangeInput, measure: Measure): Bank {
  const rows = measure === 'ctr' ? i.cells.filter((r) => r.i > 0) : i.pageDaily;
  if (rows.length === 0) return { start: '1970-01-01', days: 0, num: new Map(), den: null, clicks: new Map(), segE: new Map() };
  const start = minDate(rows.map((r) => r.date));
  const days = diffDays(start, maxDate(rows.map((r) => r.date))) + 1;
  const a = new Map<string, Float64Array>();
  const b = new Map<string, Float64Array>();
  const segE = new Map<string, Map<Segment, number>>();
  const add = (m: Map<string, Float64Array>, u: string, k: number, v: number): void => {
    let arr = m.get(u);
    if (!arr) m.set(u, (arr = new Float64Array(days)));
    arr[k] += v;
  };
  if (measure === 'ctr') {
    for (const r of i.cells) {
      if (!(r.i > 0)) continue;
      const u = safeNormalize(r.p);
      const k = diffDays(start, r.date);
      const seg = `${r.dv}|${i.isBrand(r.q) ? 'brand' : 'nonbrand'}` as Segment;
      const expected = r.i * i.curve.f(Math.min(100, Math.max(1, r.ps / r.i)), seg);
      add(a, u, k, r.c);
      add(b, u, k, expected);
      const m = segE.get(u) ?? new Map<Segment, number>();
      segE.set(u, m.set(seg, (m.get(seg) ?? 0) + expected));
    }
    const num = new Map([...a].map(([u, x]) => [u, prefix(x)]));
    return { start, days, num, den: new Map([...b].map(([u, x]) => [u, prefix(x)])), clicks: num, segE };
  }
  for (const r of i.pageDaily) {
    const u = safeNormalize(r.p);
    const k = diffDays(start, r.date);
    add(a, u, k, r.i);
    add(b, u, k, r.c);
  }
  return { start, days, num: new Map([...a].map(([u, x]) => [u, prefix(x)])), den: null, clicks: new Map([...b].map(([u, x]) => [u, prefix(x)])), segE };
}

function sumWin(bank: Bank, p: Float64Array | undefined, w: Win): number {
  if (!p || bank.days === 0) return 0;
  const a = Math.max(0, diffDays(bank.start, w[0]));
  const b = Math.min(bank.days - 1, diffDays(bank.start, w[1]));
  return b < a ? 0 : p[b + 1] - p[a];
}

// ---------- the estimator ----------

/** Window totals. Control arrays are row-major nT x nC: control b measured over treated a's windows. */
interface Did {
  nT: number; nC: number;
  tPre: Float64Array; tPost: Float64Array; tEpre: Float64Array | null; tEpost: Float64Array | null;
  cPre: Float64Array; cPost: Float64Array; cEpre: Float64Array | null; cEpost: Float64Array | null;
}

function buildDid(bank: Bank, arms: Arm[], controls: string[], shift: number): Did {
  const nT = arms.length;
  const nC = controls.length;
  const ctr = bank.den !== null;
  const f = (n: number): Float64Array => new Float64Array(n);
  const d: Did = {
    nT, nC, tPre: f(nT), tPost: f(nT), tEpre: ctr ? f(nT) : null, tEpost: ctr ? f(nT) : null,
    cPre: f(nT * nC), cPost: f(nT * nC), cEpre: ctr ? f(nT * nC) : null, cEpost: ctr ? f(nT * nC) : null,
  };
  arms.forEach((arm, a) => {
    const w = armWindows(arm, shift);
    d.tPre[a] = sumWin(bank, bank.num.get(arm.url), w.pre);
    d.tPost[a] = sumWin(bank, bank.num.get(arm.url), w.post);
    if (d.tEpre && d.tEpost && bank.den) {
      d.tEpre[a] = sumWin(bank, bank.den.get(arm.url), w.pre);
      d.tEpost[a] = sumWin(bank, bank.den.get(arm.url), w.post);
    }
    controls.forEach((v, b) => {
      d.cPre[a * nC + b] = sumWin(bank, bank.num.get(v), w.pre);
      d.cPost[a * nC + b] = sumWin(bank, bank.num.get(v), w.post);
      if (d.cEpre && d.cEpost && bank.den) {
        d.cEpre[a * nC + b] = sumWin(bank, bank.den.get(v), w.pre);
        d.cEpost[a * nC + b] = sumWin(bank, bank.den.get(v), w.post);
      }
    });
  });
  return d;
}

interface Est { tau: number; c: number; abs: number }

/** One estimate with treated weights tw, control weights cw, and (possibly redrawn) treated values. */
function estimate(d: Did, tw: Float64Array, cw: Float64Array, tPre: Float64Array, tPost: Float64Array): Est {
  const ctr = d.tEpre && d.tEpost && d.cEpre && d.cEpost;
  let tC0 = 0, tE0 = 0, tC1 = 0, tE1 = 0, nC0 = 0, nE0 = 0, nC1 = 0, nE1 = 0, sumCf = 0, sumPost = 0;
  for (let a = 0; a < d.nT; a++) {
    const wa = tw[a];
    if (wa === 0) continue;
    let cp = 0, cq = 0, ep = 0, eq = 0;
    for (let b = 0, row = a * d.nC; b < d.nC; b++) {
      const wb = cw[b];
      if (wb === 0) continue;
      cp += wb * d.cPre[row + b];
      cq += wb * d.cPost[row + b];
      if (ctr) {
        ep += wb * (d.cEpre as Float64Array)[row + b];
        eq += wb * (d.cEpost as Float64Array)[row + b];
      }
    }
    nC0 += wa * cp;
    nC1 += wa * cq;
    nE0 += wa * ep;
    nE1 += wa * eq;
    tC0 += wa * tPre[a];
    tC1 += wa * tPost[a];
    if (ctr) {
      tE0 += wa * (d.tEpre as Float64Array)[a];
      tE1 += wa * (d.tEpost as Float64Array)[a];
    } else if (cp > 0) {
      sumPost += wa * tPost[a];
      sumCf += wa * tPre[a] * (cq / cp);
    }
  }
  if (ctr) {
    const rN = nC1 / nE1 / (nC0 / nE0);
    const tau = tC1 / tE1 / (tC0 / tE0) / rN - 1;
    return { tau, c: rN - 1, abs: Number.isFinite(tau) && tau > -1 ? tC1 - tC1 / (1 + tau) : NaN };
  }
  return { tau: sumCf > 0 ? sumPost / sumCf - 1 : NaN, c: nC0 > 0 ? nC1 / nC0 - 1 : NaN, abs: sumCf > 0 ? sumPost - sumCf : NaN };
}

function resampleCounts(n: number, rng: Rng): Float64Array {
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) w[Math.min(n - 1, Math.floor(rng() * n))]++;
  return w;
}

interface BootOut {
  point: Est;
  tauCi: [number, number] | null; cCi: [number, number] | null; absCi: [number, number] | null;
  p: number | null; pc: number | null; b: number;
}

function ciOf(xs: number[]): [number, number] | null {
  const ok = xs.filter(Number.isFinite);
  if (ok.length === 0) return null;
  const ci = percentileCi(ok);
  return Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? ci : null;
}

function bootstrap(d: Did, B: number, rng: Rng): BootOut {
  const ones = (n: number): Float64Array => new Float64Array(n).fill(1);
  const point = estimate(d, ones(d.nT), ones(d.nC), d.tPre, d.tPost);
  const reps = Math.max(MIN_B, Math.min(B, Math.floor(WORK_LIMIT / Math.max(1, d.nT * d.nC))));
  const taus: number[] = [];
  const cs: number[] = [];
  const abss: number[] = [];
  const cluster = d.nT >= CLUSTER_TREATED_MIN;
  for (let r = 0; r < reps; r++) {
    const cw = resampleCounts(d.nC, rng);
    const tw = cluster ? resampleCounts(d.nT, rng) : ones(d.nT);
    const tPre = cluster ? d.tPre : d.tPre.map((x) => poissonDraw(rng, Math.max(0, x)));
    const tPost = cluster ? d.tPost : d.tPost.map((x) => poissonDraw(rng, Math.max(0, x)));
    const e = estimate(d, tw, cw, tPre, tPost);
    taus.push(e.tau);
    cs.push(e.c);
    abss.push(e.abs);
  }
  const p = taus.some(Number.isFinite) ? bootstrapP(taus.filter(Number.isFinite)) : null;
  const pc = cs.some(Number.isFinite) ? bootstrapP(cs.filter(Number.isFinite)) : null;
  return { point, tauCi: ciOf(taus), cCi: ciOf(cs), absCi: ciOf(abss), p, pc, b: reps };
}

/**
 * The "{k} of the {n} pages you changed lost clicks" sentence: n = changed pages measured, k = how
 * many of them had fewer clicks a day in their post window than in their pre window (more, for a
 * rise). Daily rates, because a post window can be shorter than its pre window. n is 0 when there
 * are no clicks to count from (the caller then falls back to the counterfactual comparison).
 */
export function movedPages(m: { mature: Arm[] }, clicks: Bank, direction: 'down' | 'up'): { k: number; n: number } {
  let k = 0;
  let n = 0;
  for (const a of m.mature) {
    const w = armWindows(a);
    const series = clicks.clicks.get(a.url);
    if (!series) continue;
    const pre = sumWin(clicks, series, w.pre) / (diffDays(w.pre[0], w.pre[1]) + 1);
    const post = sumWin(clicks, series, w.post) / (diffDays(w.post[0], w.post[1]) + 1);
    n++;
    if (direction === 'down' ? post < pre : post > pre) k++;
  }
  return { k, n };
}

/** Treated pages whose post window moved in the reported direction against their own counterfactual. */
export function countMoved(d: Did | null, direction: 'down' | 'up'): number {
  if (!d || d.nC === 0) return 0;
  let k = 0;
  for (let a = 0; a < d.nT; a++) {
    let c0 = 0, c1 = 0, e0 = 0, e1 = 0;
    for (let b = 0, row = a * d.nC; b < d.nC; b++) {
      c0 += d.cPre[row + b];
      c1 += d.cPost[row + b];
      e0 += d.cEpre?.[row + b] ?? 0;
      e1 += d.cEpost?.[row + b] ?? 0;
    }
    const ctr = d.tEpre && d.tEpost;
    const actual = ctr ? d.tPost[a] / (d.tEpost as Float64Array)[a] / (d.tPre[a] / (d.tEpre as Float64Array)[a]) : d.tPost[a];
    const expected = ctr ? c1 / e1 / (c0 / e0) : c0 > 0 ? (d.tPre[a] * c1) / c0 : NaN;
    if (Number.isFinite(actual) && Number.isFinite(expected) && (direction === 'down' ? actual < expected : actual > expected)) k++;
  }
  return k;
}

// ---------- controls ----------

interface ControlPick { controls: string[]; fallback: boolean; spillover: string[] }

function pickControls(e: SiteChange, arms: Arm[], i: SiteChangeInput, bank: Bank): ControlPick {
  const excluded = new Set(e.touched.map((t) => safeNormalize(t.url)));
  const lo = addDays(minDate(arms.map((a) => a.d)), -CONTROL_QUIET_DAYS);
  const hi = addDays(maxDate(arms.map((a) => a.d)), CONTROL_QUIET_DAYS);
  for (const c of i.changes) {
    if (ptDate(c.deployed.to) >= lo && ptDate(c.deployed.from) <= hi) for (const t of c.touched) excluded.add(safeNormalize(t.url));
  }
  // Spillover: pages whose inlinks from touched pages changed between the two snapshots.
  const spillover = new Set<string>();
  for (const t of e.touched) {
    const before = new Set(i.linksBefore(t.url, e.deployed.from).map(safeNormalize));
    const after = new Set(i.linksBefore(t.url, e.deployed.to).map(safeNormalize));
    for (const u of before) if (!after.has(u)) spillover.add(u);
    for (const u of after) if (!before.has(u)) spillover.add(u);
  }
  for (const u of spillover) excluded.add(u);
  const preWindows = arms.map((a) => armWindows(a).pre);
  const positive = (u: string): boolean => {
    let n = 0;
    let den = 0;
    for (const w of preWindows) {
      n += sumWin(bank, bank.num.get(u), w);
      if (bank.den) den += sumWin(bank, bank.den.get(u), w);
    }
    return n > 0 && (bank.den === null || den > 0);
  };
  const universe = [...bank.num.keys()].filter((u) => !excluded.has(u) && positive(u)).sort(cmp);
  const same = universe.filter((u) => i.templates.get(u) === e.templateKey);
  const spill = [...spillover].sort(cmp);
  return same.length >= MIN_CONTROLS ? { controls: same, fallback: false, spillover: spill } : { controls: universe, fallback: true, spillover: spill };
}

/** Keeps the work bounded: with too many treated x controls, keep the controls with the most pre-period volume. */
function capControls(controls: string[], arms: Arm[], bank: Bank): string[] {
  const maxControls = Math.max(MIN_CONTROLS, Math.floor(WORK_LIMIT / MIN_B / Math.max(1, arms.length)));
  if (controls.length <= maxControls) return controls;
  const pre = arms.map((a) => armWindows(a).pre);
  return controls
    .map((u) => ({ u, v: pre.reduce((s, w) => s + sumWin(bank, bank.num.get(u), w), 0) }))
    .sort((a, b) => b.v - a.v || cmp(a.u, b.u))
    .slice(0, maxControls)
    .map((x) => x.u)
    .sort(cmp);
}

function overlapping(events: GoogleEvent[], from: IsoDate, to: IsoDate, kind: (k: string) => boolean): GoogleEvent[] {
  return events
    .filter((ev) => {
      if (!kind(ev.kind)) return false;
      try {
        const begin = ptDate(ev.begin);
        const end = ev.end ? ptDate(ev.end) : addDays(begin, 14);
        return begin <= to && (end < begin ? begin : end) >= from;
      } catch {
        return false;
      }
    })
    .sort((a, b) => cmp(a.begin, b.begin) || cmp(a.id, b.id));
}

// ---------- measuring one change ----------

interface Measured {
  e: SiteChange; outcome: SiteChangeImpact['outcome']; measure: Measure;
  arms: Arm[]; mature: Arm[]; notYetSeen: string[];
  pick: ControlPick | null; did: Did | null; boot: BootOut | null; placebo: { tau: number; ci95: [number, number] } | null;
  ids: IdCheck[]; floorsMet: boolean; controlFloorsMet: boolean;
  treatedPre: number; treatedPost: number; treatedPreClicks: number;
  updates: GoogleEvent[]; anomalies: GoogleEvent[]; span: Win | null; checkDate: IsoDate | null;
  /** Weeks in each (possibly shortened) window, averaged over the measured URLs. */
  weeks: number;
}

function measureChange(e: SiteChange, i: SiteChangeInput, banks: Record<Measure, Bank>): Measured {
  const outcome: SiteChangeImpact['outcome'] = e.cls === 'snippet' ? 'ctr' : e.cls === 'technical' ? 'index_state' : 'impressions';
  const measure: Measure = outcome === 'ctr' ? 'ctr' : 'impressions';
  const bank = banks[measure];
  const { arms, notYetSeen } = armsOf(e);
  const base: Measured = {
    e, outcome, measure, arms, mature: [], notYetSeen, pick: null, did: null, boot: null, placebo: null, ids: [], floorsMet: false,
    controlFloorsMet: false, treatedPre: 0, treatedPost: 0, treatedPreClicks: 0, updates: [], anomalies: [], span: null, checkDate: null,
    weeks: WEEKS,
  };
  if (arms.length === 0) return base;
  for (const a of arms) a.post = postDaysFor(a.d, i.dataThrough);
  const mature = arms.filter((a) => a.post >= MIN_POST_DAYS);
  if (mature.length === 0) return { ...base, checkDate: addDays(maxDate(arms.map((a) => a.d)), GAP + MIN_POST_DAYS - 1) };
  const weeks = mature.reduce((sum, a) => sum + a.post, 0) / mature.length / 7;
  const wins = mature.map((a) => armWindows(a));
  const span: Win = [minDate(wins.map((w) => w.pre[0])), maxDate(wins.map((w) => w.post[1]))];
  const pick = pickControls(e, mature, i, bank);
  const controls = capControls(pick.controls, mature, bank);
  const anomalies = overlapping(i.events, span[0], span[1], (k) => k === 'data_anomaly');
  const ids: IdCheck[] = [{
    name: 'measurement_event',
    passed: anomalies.length === 0,
    detail: anomalies.length ? `Overlaps ${anomalies.map((a) => a.title).join(', ')}` : 'No reporting change overlaps these dates.',
  }];
  if (measure === 'ctr' && i.curve.unstable.length > 0) {
    const segE = new Map<Segment, number>();
    for (const a of mature) for (const [s, v] of bank.segE.get(a.url) ?? []) segE.set(s, (segE.get(s) ?? 0) + v);
    const total = [...segE.values()].reduce((x, y) => x + y, 0);
    const bad = i.curve.unstable.filter((s) => total > 0 && (segE.get(s) ?? 0) / total >= 0.25);
    ids.push({ name: 'curve_unstable', passed: bad.length === 0, detail: bad.length ? `Unstable click-rate curve for ${bad.join(', ')}` : 'Curve stable for these searches.' });
  }
  const did = buildDid(bank, mature, controls, 0);
  const treatedPre = did.tPre.reduce((s, x) => s + x, 0);
  const clicksBank = banks.impressions;
  const treatedPreClicks = mature.reduce((s, a) => s + sumWin(clicksBank, clicksBank.clicks.get(a.url), armWindows(a).pre), 0);
  const controlPre = controls.length ? did.cPre.reduce((s, x) => s + x, 0) / mature.length : 0;
  const floor = measure === 'ctr' ? 'clicks' : 'impressions';
  const controlFloorsMet = controls.length >= MIN_CONTROLS && controlPre >= FLOOR.controls[floor];
  const out: Measured = {
    ...base, mature, pick: { ...pick, controls }, did, ids, controlFloorsMet, span, anomalies, weeks,
    floorsMet: treatedPre >= FLOOR.treated[floor] && controlFloorsMet,
    treatedPre, treatedPost: did.tPost.reduce((s, x) => s + x, 0), treatedPreClicks,
    updates: overlapping(i.events, minDate(mature.map((a) => a.d)), span[1], (k) => RANKING_KINDS.has(k)),
  };
  if (controls.length === 0) {
    // A sitewide change: no comparison is possible, so the ceiling is unclear (5.10), unless the
    // changed pages themselves are too small to say anything.
    ids.push({ name: 'coverage', passed: false, detail: 'No comparable untouched pages to compare with.' });
    out.floorsMet = treatedPre >= FLOOR.treated[floor];
    return out;
  }
  out.boot = bootstrap(did, i.bootstrap, i.rng(`site-change:${e.id}`));
  // Placebo: every d_u moved back 28 days, same controls, when history covers it.
  const placeboStart = minDate(mature.map((a) => armWindows(a, PLACEBO_SHIFT).pre[0]));
  if (bank.days > 0 && bank.start <= placeboStart) {
    const pb = bootstrap(buildDid(bank, mature, controls, PLACEBO_SHIFT), i.bootstrap, i.rng(`site-change-placebo:${e.id}`));
    if (Number.isFinite(pb.point.tau) && pb.tauCi) {
      out.placebo = { tau: pb.point.tau, ci95: pb.tauCi };
      const fails = (pb.tauCi[0] > 0 || pb.tauCi[1] < 0) && Math.abs(pb.point.tau) >= i.delta / 2;
      ids.push({ name: 'placebo', passed: !fails, detail: `The same comparison 4 weeks earlier moved ${fmtPct(pb.point.tau)}.` });
    }
  }
  return out;
}

function synthesise(m: Measured, v: VerdictResult, cv: VerdictResult | null, demandK: number | null): Synthesis {
  if (!m.boot) return 'unclear';
  const tau = v.verdict;
  const c = cv?.verdict ?? 'underpowered';
  const placeboOk = !m.ids.some((x) => x.name === 'placebo' && !x.passed);
  const inUpdate = m.updates.length > 0;
  if (tau === 'signal' && placeboOk && c !== 'signal') return 'site_change';
  if (tau === 'noise' && c === 'signal' && inUpdate) return 'google';
  if (tau === 'signal' && c === 'signal' && inUpdate) return 'both';
  const cHat = m.boot.point.c;
  if (tau === 'noise' && demandK !== null && Number.isFinite(cHat) && Math.abs(cHat - (demandK - 1)) < 0.05) return 'demand';
  return 'unclear';
}

// ---------- findings ----------

export const FIELD_TEXT: Record<string, string> = {
  title: 'title', metaDescription: 'meta description', metaRobots: 'robots meta tag', xRobotsTag: 'X-Robots-Tag header',
  canonical: 'canonical', h1: 'main heading', jsonLdTypes: 'structured data', internalLinks: 'internal links', body: 'page text',
  status: 'status code', annotation: 'noted change',
};
const FIELD_PLURAL: Record<string, string> = {
  title: 'titles', metaDescription: 'meta descriptions', metaRobots: 'robots meta tags', xRobotsTag: 'X-Robots-Tag headers',
  canonical: 'canonicals', h1: 'main headings', jsonLdTypes: 'structured data', internalLinks: 'internal links', body: 'page text',
  status: 'status codes', annotation: 'noted changes',
};

function clipText(s: string | null, max: number): string {
  if (s === null) return 'none';
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * A short factual description of the change (may hold untrusted page or note text; escape on output):
 * 'title changed from "A" to "B"' on one page, 'new titles, for example "A" became "B"' on several.
 */
export function changeSummary(e: SiteChange, inScope?: (url: string) => boolean): string {
  if (e.source === 'annotation') return clipText(e.text, 120);
  // Within a page or search scope, describe the pages of that scope (a page's own before and after).
  const touched = inScope ? e.touched.filter((x) => inScope(x.url)) : e.touched;
  const t = touched[0] ?? e.touched[0];
  const one = touched.length === 1;
  const what = (one ? FIELD_TEXT[e.field] : FIELD_PLURAL[e.field]) ?? e.field;
  if (!t || e.field === 'body' || e.field === 'internalLinks') return one ? `${what} changed` : `${what} changed`;
  if (one) return `${what} changed from "${clipText(t.before, 60)}" to "${clipText(t.after, 60)}"`;
  return `new ${what}, for example "${clipText(t.before, 60)}" became "${clipText(t.after, 60)}"`;
}

function unitOf(e: SiteChange): Finding['unit'] {
  if (e.touched.length !== 1) return { level: 'template', key: e.templateKey, label: e.templateKey };
  const url = safeNormalize(e.touched[0].url);
  return { level: 'page', key: url, label: pathOf(url) };
}

function changeEvidence(e: SiteChange, m: Measured): EvidenceRef[] {
  const to = e.deployed.to;
  const n = e.touched.length;
  const out: EvidenceRef[] = [
    e.source === 'annotation'
      ? { type: 'annotation', confidence: 'EXTRACTED', partition: 'annotations.ndjson', key: { siteChange: e.id }, summary: `Noted change: ${clipText(e.text, 120)}` }
      : { type: 'snapshot_diff', confidence: 'EXTRACTED', partition: `crawl/${to.slice(0, 4)}/${to.slice(5, 7)}/`, key: { siteChange: e.id, field: e.field }, summary: `${n} ${n === 1 ? 'page' : 'pages'}: ${changeSummary(e)}` },
  ];
  const seen = m.mature.filter((a) => a.seen && a.googleSeen);
  if (seen.length) {
    const d1 = minDate(seen.map((a) => ptDate((a.googleSeen as Interval).from)));
    out.push({ type: 'inspection', confidence: 'EXTRACTED', partition: 'inspect/', key: { siteChange: e.id }, summary: `Google recrawled ${seen.length} of the changed pages between ${d1} and ${maxDate(seen.map((a) => a.d))}` });
  }
  if (m.boot && m.pick) {
    const ci = m.boot.tauCi;
    const range = ci ? ` (95% range ${fmtPct(ci[0])} to ${fmtPct(ci[1])})` : '';
    out.push({ type: 'statistic', confidence: 'INFERRED', partition: 'gsc/', key: { siteChange: e.id, method: 'stacked_did' }, summary: `Changed pages ${fmtPct(m.boot.point.tau)} against ${m.pick.controls.length} untouched pages${range}` });
  }
  return out;
}

function baseFinding(e: SiteChange, kind: Finding['kind'], discriminator: string): Pick<Finding, 'id' | 'kind' | 'unit' | 'windows' | 'components' | 'componentCi95' | 'analyzer'> {
  const unit = unitOf(e);
  const id = findingId([kind, unit.key, ptDate(e.deployed.to), `${e.id}:${discriminator}`]);
  return { id, kind, unit, windows: null, components: null, componentCi95: null, analyzer: { ...SITE_CHANGE_ANALYZER } };
}

const NO_EFFECT: Finding['effect'] = { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null };

function unseenFinding(e: SiteChange, urls: string[]): Finding {
  const date = ptDate(e.deployed.to);
  const pages = urls.length === 1 ? 'this page' : `these ${urls.length} pages`;
  return {
    ...baseFinding(e, 'notice', 'unseen'),
    metric: 'index_state', date, dateWindow: [ptDate(e.deployed.from), date], effect: { ...NO_EFFECT },
    real: 'underpowered', reason: 'fact', cause: null, causeConfidence: 'EXTRACTED', power: null,
    template: 'site_change_unseen', slots: { n: urls.length, date },
    evidence: [{ type: 'inspection', confidence: 'EXTRACTED', partition: 'inspect/', key: { siteChange: e.id }, summary: `No inspection shows Google crawling ${pages} since ${date}` }],
    alternatives: [], falsifier: { key: 'more_data', slots: { check_date: addDays(date, 7) } }, verify: null,
    related: { googleEvents: [], siteChanges: [e.id], findings: [] }, priority: 5,
  };
}

function chooseTemplate(m: Measured, v: VerdictResult, synthesis: Synthesis, tooRecent: boolean): { template: TemplateId; cause: Cause | null } {
  if (tooRecent) return { template: 'too_recent', cause: null };
  if (synthesis === 'site_change') return { template: 'real_site_change', cause: 'site_change' };
  if (synthesis === 'google') return { template: 'real_google', cause: 'google_update' };
  if (synthesis === 'both') return { template: 'mixed', cause: 'mixed' };
  if (synthesis === 'demand') return { template: 'demand', cause: 'demand' };
  if (v.verdict === 'underpowered' && m.boot) return { template: 'not_enough_data', cause: null };
  if (v.verdict === 'noise') return { template: 'noise', cause: null };
  return { template: 'cant_separate', cause: null };
}

function impactFinding(m: Measured, v: VerdictResult, cv: VerdictResult | null, q: number | null, i: SiteChangeInput, clicks: Bank): { finding: Finding; synthesis: Synthesis } {
  const e = m.e;
  const tau = finite(m.boot?.point.tau);
  const c = finite(m.boot?.point.c);
  const synthesis = synthesise(m, v, cv, i.demandK);
  const tooRecent = m.mature.length === 0 && m.checkDate !== null;
  const { template, cause } = chooseTemplate(m, v, synthesis, tooRecent);
  const date = m.mature.length ? minDate(m.mature.map((a) => a.d)) : m.arms.length ? minDate(m.arms.map((a) => a.d)) : ptDate(e.deployed.to);
  const fallback = (m.pick?.fallback ?? false) || e.source === 'annotation' || m.mature.some((a) => !a.seen);
  const causeConfidence = cause !== null && cause !== 'mixed' && v.verdict === 'signal' && !fallback ? 'INFERRED' : 'AMBIGUOUS';
  const level = v.verdict !== 'signal' ? 'low' : causeConfidence === 'INFERRED' && m.ids.every((x) => x.passed) ? 'high' : 'medium';
  const update = m.updates[0] ?? null;
  const direction = (tau ?? c ?? 0) < 0 ? 'down' : 'up';
  const cDirection = (c ?? 0) < 0 ? 'down' : 'up';
  const touchedChange = tau !== null && c !== null ? (1 + tau) * (1 + c) - 1 : null;
  const seen = m.mature.filter((a) => a.googleSeen);
  const counted = movedPages(m, clicks, direction);
  // With no page totals to count from, fall back to the changed pages against their counterfactual.
  const moved = counted.n > 0 ? counted : { k: countMoved(m.did, direction), n: m.mature.length };
  const slotsByTemplate: Partial<Record<TemplateId, () => Record<string, string | number>>> = {
    too_recent: () => ({ date, check_date: m.checkDate as string }),
    real_site_change: () => ({
      k: moved.k, n: moved.n, change_date: ptDate(e.source === 'annotation' ? e.deployed.from : e.deployed.to),
      summary: changeSummary(e), d1: seen.length ? minDate(seen.map((a) => ptDate((a.googleSeen as Interval).from))) : date,
      d2: seen.length ? maxDate(seen.map((a) => a.d)) : date, ctrl: fmtPct(c), level, direction,
    }),
    real_google: () => ({
      date, n_days: update ? Math.max(0, diffDays(ptDate(update.begin), date)) : 0, update: update?.title ?? 'Google update',
      touched: fmtPct(touchedChange), untouched: fmtPct(c), level, direction: cDirection,
    }),
    mixed: () => ({ a: 'a change on your site', b: update?.title ?? 'a Google update', x: '100%' }),
    demand: () => {
      const share = touchedChange && c !== null ? Math.min(1, Math.abs(c / touchedChange)) : 1;
      return { pct: fmtPct(c), share: fmtAbsPct(share), yoy_sentence: '', direction: cDirection };
    },
    not_enough_data: () => ({ cpw: fmtCount(m.treatedPreClicks / m.weeks), mde: v.power ? fmtAbsPct(v.power.mde) : 'n/a', weeks: Math.round(m.weeks), pct: fmtPct(tau), impr_sentence: '' }),
    noise: () => ({ pct: fmtPct(tau), freq: 'rarely' }),
    // check names the identification check that failed; the report words it (6.2 reason_text).
    cant_separate: () => ({
      date, check: v.failed[0]?.name ?? (m.pick?.controls.length ? 'competing_events' : 'coverage'),
      a: 'a change on your site', b: update ? `the ${update.title}` : 'a shift that also moved pages you did not touch',
    }),
  };
  const slots = slotsByTemplate[template]?.() ?? {};

  const alternatives: Finding['alternatives'] = [];
  if (!tooRecent) {
    alternatives.push(update
      ? { cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: update.title } }
      : { cause: 'google_update', ruledOut: true, key: 'update_no_overlap', slots: {} });
    const cCi = m.boot?.cCi;
    if (c !== null && cCi) {
      const flat = cCi[0] <= 0 && cCi[1] >= 0;
      alternatives.push({ cause: 'demand', ruledOut: flat, key: flat ? 'demand_ruled_out' : 'demand_possible', slots: { impr_pct: fmtPct(c) } });
    }
    if (synthesis === 'google') alternatives.push({ cause: 'site_change', ruledOut: true, key: 'site_change_controls_fell_too', slots: { ctrl: fmtPct(c) } });
    for (const a of m.anomalies) alternatives.push({ cause: 'data_anomaly', ruledOut: false, key: 'measurement_event_overlaps', slots: { event: a.title } });
  }
  const falsifier: Finding['falsifier'] =
    synthesis === 'site_change' ? { key: 'revert_and_recrawl', slots: {} }
      : synthesis === 'google' ? { key: 'next_update_recovery', slots: {} }
        : synthesis === 'demand' ? { key: 'impressions_recover', slots: {} }
          : { key: 'more_data', slots: { check_date: m.checkDate ?? addDays(i.dataThrough, WINDOW) } };

  const absolute = finite(m.boot?.point.abs);
  const absClicks = m.measure === 'ctr' ? Math.abs(absolute ?? 0) : Math.abs((tau ?? 0) * m.treatedPreClicks);
  const real = tooRecent ? 'underpowered' : v.verdict;
  const single = e.touched.length === 1 ? { page: safeNormalize(e.touched[0].url) } : {};
  const finding: Finding = {
    ...baseFinding(e, 'site_change_impact', m.outcome),
    metric: m.measure === 'ctr' ? 'ctr' : 'impressions',
    date,
    dateWindow: [ptDate(e.deployed.from), ptDate(e.deployed.to)],
    effect: { estimate: tau, ci95: m.boot?.tauCi ?? null, absolute, absoluteCi95: m.boot?.absCi ?? null, p: m.boot?.p ?? null, q },
    real,
    reason: tooRecent ? 'floors' : v.reason,
    cause,
    causeConfidence,
    power: v.power ? { ...v.power, perWeek: m.treatedPre / m.weeks } : null,
    template,
    slots,
    evidence: changeEvidence(e, m),
    alternatives,
    falsifier,
    verify: m.span ? { ...single, from: m.span[0], to: m.span[1] } : null,
    related: { googleEvents: m.updates.map((u) => u.id), siteChanges: [e.id], findings: [] },
    priority: (TIER[real] ?? 1) * Math.max(1, absClicks),
  };
  return { finding, synthesis };
}

export function analyzeSiteChanges(i: SiteChangeInput): { impacts: SiteChangeImpact[]; findings: Finding[] } {
  const banks: Record<Measure, Bank> = { impressions: buildBank(i, 'impressions'), ctr: buildBank(i, 'ctr') };
  const findings: Finding[] = [];
  const unseenIds = new Map<string, string>();
  const measured: Measured[] = [];
  for (const e of [...i.changes].sort((a, b) => cmp(a.id, b.id))) {
    if (e.touched.length === 0) continue;
    const m = measureChange(e, i, banks);
    if (m.notYetSeen.length > 0) {
      const f = unseenFinding(e, m.notYetSeen);
      findings.push(f);
      unseenIds.set(e.id, f.id);
    }
    measured.push(m);
  }

  // One BH family across every site-change impact with a p-value (5.8 family 5).
  const qs = benjaminiHochberg(measured.map((m) => m.boot?.p ?? NaN));
  const impacts: SiteChangeImpact[] = [];
  measured.forEach((m, k) => {
    const q = finite(qs[k]);
    const v = decideVerdict({
      estimate: finite(m.boot?.point.tau) ?? 0, ci95: m.boot?.tauCi ?? null, floorsMet: m.floorsMet, identification: m.ids, q,
      delta: i.delta, fdrQ: i.fdrQ, weeksObserved: m.weeks, counts: { pre: m.treatedPre, post: m.treatedPost, phi: 1 },
    });
    const cv = m.boot
      ? decideVerdict({
          estimate: finite(m.boot.point.c) ?? 0, ci95: m.boot.cCi, floorsMet: m.controlFloorsMet, identification: [], q: m.boot.pc,
          delta: i.delta, fdrQ: i.fdrQ, weeksObserved: m.weeks,
        })
      : null;
    const empty = { controlChange: null, controlCi95: null, placebo: null, notYetSeen: m.notYetSeen };
    if (m.arms.length === 0) {
      impacts.push({
        siteChangeId: m.e.id, outcome: m.outcome, treated: 0, controls: 0, controlFallback: false, tau: null, ci95: null, ...empty,
        synthesis: 'unclear', real: 'underpowered', reason: 'floors', findingId: unseenIds.get(m.e.id) ?? '',
      });
      return;
    }
    const { finding, synthesis } = impactFinding(m, v, cv, q, i, banks.impressions.days > 0 ? banks.impressions : banks.ctr);
    findings.push(finding);
    impacts.push({
      siteChangeId: m.e.id,
      outcome: m.outcome,
      treated: m.mature.length,
      controls: m.pick?.controls.length ?? 0,
      controlFallback: m.pick?.fallback ?? false,
      tau: finite(m.boot?.point.tau),
      ci95: m.boot?.tauCi ?? null,
      controlChange: finite(m.boot?.point.c),
      controlCi95: m.boot?.cCi ?? null,
      placebo: m.placebo,
      notYetSeen: m.notYetSeen,
      synthesis,
      real: finding.real,
      reason: finding.reason,
      findingId: finding.id,
    });
  });
  findings.sort((a, b) => b.priority - a.priority || cmp(a.id, b.id));
  return { impacts, findings };
}
