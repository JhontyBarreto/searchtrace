// AI Overview status, strata, cross-section, DiD, placebo, HT bootstrap, apportioning, per-query facts (5.11). Owner: WP-D.
//
// Status per (keyword, device) uses the checks from the start of the current window onwards
// (SERP checks run after the last sealed day, and they describe the results page as it is now).
//   present: >= 2 checks and an AI Overview in at least half; absent: >= 2 checks and none;
//   intermittent otherwise; exactly one check: single_present / single_absent.
// Groups: U = present and not cited, N = absent, Cit = present and cited (reported, no verdict).
// "Day 0" (no search has 2 checks yet): single_* stand in for present/absent in the
// cross-section only, and IdCheck('single_check') fails, so it can never be a signal (D11).
//
// Strata are (baseline position bucket, device). With HT weights w = 1/pi and E = sum I*f(p):
//   R_gs = sum w C / sum w E over group g in stratum s
//   cross-section: CF = sum_s E_U,s,c * R_N,s,c          gap = Obs_U,c / CF - 1
//   DiD:           CF = sum_s E_U,s,c * R_U,s,b * R_N,s,c / R_N,s,b    tau = Obs_U,c / CF - 1
//   placebo:       the DiD with b -> pre1 and c -> pre2 (labels from the current window)
// Inference is a query-cluster bootstrap within stratum x group, carrying the weights.
//
// Slot conventions for WP-E and WP-F (numbers are raw; F formats them):
//   aio_effect (unit: the site, key 'site'; one finding per estimator): estimator 'cross_section' | 'did';
//     wording 'comparison_not_proof' (cross-section) or 'estimate_not_measured' (DiD); x = tau,
//     lo/hi = its 95% range (raw fractions, as WP-E passes them for aio_not_cited); direction;
//     u/n/cit/intermittent counts; coverage; strata; missing (clicks). not_enough_data adds cpw,
//     mde, weeks (observed), weeks_needed, pct, impr_sentence ''. cant_separate adds date and check = the failed IdCheck
//     name (F maps it to words). single_check is 'yes' when day-0 single checks were used.
//   aio_fact: query, device, k, n, status, cited_text 'cites_you' | 'doesnt_cite_you' | 'none'
//     (F maps it to words), domains (comma-separated, untrusted), our_rank (0 = not in the top 10).
import { findingId } from '../core/ids.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import { domainMatches, normalizeUrl } from '../core/url.js';
import type {
  AioEstimate, AioInput, AioOutput, AioQueryFact, Cell, Confidence, Device, Finding, IdCheck, IsoDate, Rng, Segment,
  SerpObservation, TemplateId, Verdict, VerdictResult,
} from '../core/types.js';
import { benjaminiHochberg, bootstrapP, percentileCi } from './stats.js';
import { decideVerdict } from './verdicts.js';

export const ANALYZER = { name: 'aio', version: '1' } as const;
export const FDR_Q = 0.1; // AioInput carries no fdrQ; this is the config default (family 4 is AIO-only)
export const FACT_FINDINGS_CAP = 200;
export const FACTS_CAP = 1000;
const MIN_PER_GROUP = 20;
const MIN_E = 30;
const MIN_STRATA = 2;
const MIN_PER_CELL = 3;
const MIN_COVERAGE = 0.7;

export type WindowName = 'b' | 'c' | 'pre1' | 'pre2';
export type Group = 'U' | 'N' | 'Cit';
export type AioStatus = AioQueryFact['status'];

/** [1,1.5) [1.5,2.5) [2.5,3.5) [3.5,5.5) [5.5,10.5) [10.5,20.5] */
export const BUCKETS: readonly [number, number][] = [[1, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 5.5], [5.5, 10.5], [10.5, 20.5]];

export function bucketOf(p: number): number | null {
  if (!(p >= 1) || p > 20.5) return null;
  for (let k = 0; k < BUCKETS.length; k++) {
    const [lo, hi] = BUCKETS[k];
    if (p >= lo && (p < hi || (k === BUCKETS.length - 1 && p <= hi))) return k;
  }
  return null;
}

/** One searched (keyword, device) as the estimators see it. C and E are unweighted window totals. */
export interface QueryData {
  key: string;
  group: Group;
  stratum: string | null;
  w: number;
  C: Record<WindowName, number>;
  E: Record<WindowName, number>;
}

export interface Estimation {
  tau: number | null;
  ci95: [number, number] | null;
  missing: number | null;
  missingCi95: [number, number] | null;
  obs: number;
  cf: number;
  p: number | null;
  kept: string[];
  coverage: number;
  nU: number;
  nN: number;
  /** Unweighted E sums over kept strata, per group and window, for the floors. */
  eSum: { U: { from: number; to: number }; N: { from: number; to: number } };
  floorsMet: boolean;
}

interface Row { w: number; cF: number; eF: number; cT: number; eT: number }
interface Sums { cF: number; eF: number; cT: number; eT: number }
interface Cellset { stratum: string; U: Row[]; N: Row[] }

function sumRows(rows: Row[], idx?: number[]): Sums {
  const s = { cF: 0, eF: 0, cT: 0, eT: 0 };
  const n = idx ? idx.length : rows.length;
  for (let k = 0; k < n; k++) {
    const r = rows[idx ? idx[k] : k];
    s.cF += r.w * r.cF;
    s.eF += r.w * r.eF;
    s.cT += r.w * r.cT;
    s.eT += r.w * r.eT;
  }
  return s;
}

/** Point value of the estimator from per-stratum weighted sums; null when a denominator is zero. */
function valueOf(kind: 'cross_section' | 'did', strata: { U: Sums; N: Sums }[]): { value: number; obs: number; cf: number } | null {
  let obs = 0;
  let cf = 0;
  for (const { U, N } of strata) {
    obs += U.cT;
    if (kind === 'cross_section') {
      if (!(N.eT > 0)) return null;
      cf += U.eT * (N.cT / N.eT);
    } else {
      if (!(N.eT > 0) || !(N.cF > 0) || !(N.eF > 0) || !(U.eF > 0)) return null;
      cf += U.eT * (U.cF / U.eF) * ((N.cT / N.eT) / (N.cF / N.eF));
    }
  }
  if (!(cf > 0)) return null;
  return { value: obs / cf - 1, obs, cf };
}

/** Stratified estimate with a query-cluster bootstrap (resampling within stratum x group, weights carried). */
export function estimateGroups(
  qs: QueryData[],
  o: { estimator: 'cross_section' | 'did'; from?: WindowName; to?: WindowName; B: number; rng: Rng },
): Estimation {
  const from: WindowName = o.from ?? 'b';
  const to: WindowName = o.to ?? 'c';
  const byStratum = new Map<string, Cellset>();
  let eUAll = 0;
  for (const q of qs) {
    if (q.group === 'U') eUAll += q.w * q.E.c;
    if (q.group === 'Cit' || q.stratum === null) continue;
    let cell = byStratum.get(q.stratum);
    if (!cell) {
      cell = { stratum: q.stratum, U: [], N: [] };
      byStratum.set(q.stratum, cell);
    }
    cell[q.group].push({ w: q.w, cF: q.C[from], eF: q.E[from], cT: q.C[to], eT: q.E[to] });
  }
  const kept: Cellset[] = [];
  for (const cell of [...byStratum.values()].sort((a, b) => (a.stratum < b.stratum ? -1 : 1))) {
    if (cell.U.length < MIN_PER_CELL || cell.N.length < MIN_PER_CELL) continue;
    const N = sumRows(cell.N);
    const U = sumRows(cell.U);
    if (!(N.eT > 0)) continue;
    if (o.estimator === 'did' && (!(N.cF > 0) || !(N.eF > 0) || !(U.eF > 0))) continue;
    kept.push(cell);
  }
  const unweighted = (rows: Row[], key: 'eF' | 'eT'): number => rows.reduce((s, r) => s + r[key], 0);
  const eSum = {
    U: { from: kept.reduce((s, c) => s + unweighted(c.U, 'eF'), 0), to: kept.reduce((s, c) => s + unweighted(c.U, 'eT'), 0) },
    N: { from: kept.reduce((s, c) => s + unweighted(c.N, 'eF'), 0), to: kept.reduce((s, c) => s + unweighted(c.N, 'eT'), 0) },
  };
  const nU = kept.reduce((s, c) => s + c.U.length, 0);
  const nN = kept.reduce((s, c) => s + c.N.length, 0);
  const eUKept = kept.reduce((s, c) => s + sumRows(c.U).eT, 0);
  const coverage = eUAll > 0 ? eUKept / eUAll : 0;
  const ePeriods = o.estimator === 'did' ? [eSum.U.from, eSum.U.to, eSum.N.from, eSum.N.to] : [eSum.U.to, eSum.N.to];
  const floorsMet = kept.length >= MIN_STRATA && nU >= MIN_PER_GROUP && nN >= MIN_PER_GROUP && ePeriods.every((e) => e >= MIN_E);

  const point = kept.length ? valueOf(o.estimator, kept.map((c) => ({ U: sumRows(c.U), N: sumRows(c.N) }))) : null;
  const base: Estimation = {
    tau: point ? point.value : null, ci95: null, missing: point ? point.cf - point.obs : null, missingCi95: null,
    obs: point?.obs ?? 0, cf: point?.cf ?? 0, p: null, kept: kept.map((c) => c.stratum), coverage, nU, nN, eSum, floorsMet,
  };
  if (!point || o.B <= 0) return base;

  const taus: number[] = [];
  const missing: number[] = [];
  const draw = (n: number): number[] => {
    const idx = new Array<number>(n);
    for (let k = 0; k < n; k++) idx[k] = Math.min(n - 1, Math.floor(o.rng() * n));
    return idx;
  };
  for (let b = 0; b < o.B; b++) {
    const v = valueOf(o.estimator, kept.map((c) => ({ U: sumRows(c.U, draw(c.U.length)), N: sumRows(c.N, draw(c.N.length)) })));
    taus.push(v ? v.value : Number.NaN);
    missing.push(v ? v.cf - v.obs : Number.NaN);
  }
  const ok = taus.filter((t) => Number.isFinite(t));
  if (ok.length < Math.max(20, o.B / 2)) return base;
  return { ...base, ci95: percentileCi(taus), missingCi95: percentileCi(missing), p: bootstrapP(taus) };
}

// ---------- statuses and query data ----------

export interface KeyChecks {
  key: string;
  keyword: string;
  device: Device;
  current: SerpObservation[];
  all: SerpObservation[];
}

export function statusOf(checks: SerpObservation[], siteDomain: string): { status: AioStatus | null; k: number; n: number; cited: boolean } {
  const n = checks.length;
  const withAio = checks.filter((c) => c.aio !== null);
  const k = withAio.length;
  const citedK = withAio.filter((c) => c.aio?.citesUs || (c.aio?.refs ?? []).some((r) => domainMatches(stripWww(r.domain), siteDomain))).length;
  const cited = k > 0 && citedK / k >= 0.5;
  if (n === 0) return { status: null, k, n, cited };
  if (n === 1) return { status: k === 1 ? 'single_present' : 'single_absent', k, n, cited };
  const a = k / n;
  return { status: a >= 0.5 ? 'present' : a === 0 ? 'absent' : 'intermittent', k, n, cited };
}

function stripWww(d: string): string {
  const x = String(d).trim().toLowerCase();
  return x.startsWith('www.') ? x.slice(4) : x;
}

const inWin = (d: IsoDate, w: [IsoDate, IsoDate]): boolean => d >= w[0] && d <= w[1];

function segmentOf(dv: Device, brand: boolean): Segment {
  return `${dv}|${brand ? 'brand' : 'nonbrand'}` as Segment;
}

/** Per key and window: clicks, expected clicks and impression-weighted position (for the baseline stratum). */
function cellTotals(i: AioInput, keys: Set<string>): Map<string, { C: Record<WindowName, number>; E: Record<WindowName, number>; psB: number; iB: number }> {
  const w = i.windows;
  const wins: [WindowName, [IsoDate, IsoDate]][] = [['b', w.baseline], ['c', w.current], ['pre1', w.placebo.pre1], ['pre2', w.placebo.pre2]];
  const out = new Map<string, { C: Record<WindowName, number>; E: Record<WindowName, number>; psB: number; iB: number }>();
  const brandCache = new Map<string, boolean>();
  for (const cell of i.cells as Cell[]) {
    const key = `${cell.q}|${cell.dv}`;
    if (!keys.has(key) || !(cell.i > 0)) continue;
    let t = out.get(key);
    if (!t) {
      t = { C: { b: 0, c: 0, pre1: 0, pre2: 0 }, E: { b: 0, c: 0, pre1: 0, pre2: 0 }, psB: 0, iB: 0 };
      out.set(key, t);
    }
    let brand = brandCache.get(cell.q);
    if (brand === undefined) {
      brand = i.isBrand(cell.q);
      brandCache.set(cell.q, brand);
    }
    const p = Math.min(100, Math.max(1, cell.ps / cell.i));
    const e = cell.i * i.curve.f(p, segmentOf(cell.dv, brand));
    for (const [name, win] of wins) {
      if (!inWin(cell.date, win)) continue;
      t.C[name] += cell.c;
      t.E[name] += e;
      if (name === 'b') {
        t.psB += cell.ps;
        t.iB += cell.i;
      }
    }
  }
  return out;
}

/** Groups SERP checks by (keyword, device); "current" means observed on or after the current window starts. */
export function groupChecks(serp: SerpObservation[], currentFrom: IsoDate): KeyChecks[] {
  const by = new Map<string, KeyChecks>();
  const sorted = [...serp].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.taskId < b.taskId ? -1 : 1));
  for (const o of sorted) {
    const key = `${o.keyword}|${o.device}`;
    let g = by.get(key);
    if (!g) {
      g = { key, keyword: o.keyword, device: o.device, current: [], all: [] };
      by.set(key, g);
    }
    g.all.push(o);
    if (ptDate(o.observedAt) >= currentFrom) g.current.push(o);
  }
  return [...by.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---------- titles ----------

// Separators sites put before their name in a title: | - : and the en dash, em dash, middle dot and bullet.
const SEP_CHARS = String.fromCharCode(0x2013, 0x2014, 0xb7, 0x2022);
const ELLIPSIS = String.fromCharCode(0x2026);
const SUFFIX_SEP = new RegExp(`\\s+(?:\\||-|:|[${SEP_CHARS}])\\s+[^|:${SEP_CHARS}]+$`);
const TRAILING_ELLIPSIS = new RegExp(`(?:\\.\\.\\.|${ELLIPSIS})\\s*$`);

function cleanTitle(t: string): string {
  let s = t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(TRAILING_ELLIPSIS, '').trim();
  const stripped = s.replace(SUFFIX_SEP, '').trim();
  return stripped || s;
}

/** Google showed a different title than the page's own (case, spacing, a trailing site name and truncation ignored). */
export function titleRewritten(serpTitle: string, pageTitle: string): boolean {
  const a = cleanTitle(serpTitle);
  const b = cleanTitle(pageTitle);
  if (!a || !b) return false;
  if (a === b) return false;
  const truncated = TRAILING_ELLIPSIS.test(serpTitle.trim());
  return !(truncated && b.startsWith(a));
}

function pageTitleFor(titles: Map<string, string>, url: string): string | null {
  const direct = titles.get(url);
  if (direct !== undefined) return direct;
  try {
    return titles.get(normalizeUrl(url)) ?? null;
  } catch {
    return null;
  }
}

// ---------- findings ----------

function tier(real: Verdict, fact: boolean): number {
  if (fact) return 5;
  return real === 'signal' ? 1000 : real === 'unclear' ? 100 : real === 'underpowered' ? 10 : 1;
}

function serpFolder(observedAt: string): string {
  return `serp/${observedAt.slice(0, 4)}/${observedAt.slice(5, 7)}/`;
}

function templateFor(v: VerdictResult): TemplateId {
  if (v.verdict === 'signal') return 'aio_not_cited';
  if (v.verdict === 'noise') return 'noise';
  if (v.verdict === 'unclear') return 'cant_separate';
  return 'not_enough_data';
}

function estimateFinding(
  i: AioInput, est: Estimation, estimator: 'cross_section' | 'did', v: VerdictResult, q: number | null,
  extra: { groups: AioEstimate['groups']; singles: boolean; placebo: AioEstimate['placebo'] },
): Finding {
  const W = i.windows;
  const weeks = (diffDays(W.current[0], W.current[1]) + 1) / 7;
  const unitKey = 'site';
  const tau = est.tau;
  const conf: Confidence = estimator === 'did' && v.verdict === 'signal' ? 'INFERRED' : 'AMBIGUOUS';
  const slots: Record<string, string | number> = {
    estimator,
    wording: estimator === 'cross_section' ? 'comparison_not_proof' : 'estimate_not_measured',
    direction: tau !== null && tau > 0 ? 'up' : 'down',
    x: tau ?? 0,
    lo: est.ci95 ? est.ci95[0] : 0,
    hi: est.ci95 ? est.ci95[1] : 0,
    u: extra.groups.U, n: extra.groups.N, cit: extra.groups.Cit, intermittent: extra.groups.intermittent,
    coverage: est.coverage, strata: est.kept.length, missing: est.missing ?? 0,
    single_check: extra.singles ? 'yes' : 'no',
  };
  if (v.verdict === 'underpowered') {
    Object.assign(slots, {
      cpw: est.obs / weeks, mde: v.power?.mde ?? 1, weeks: Math.round(weeks), weeks_needed: v.power?.weeksNeeded ?? 0, pct: tau ?? 0, impr_sentence: '',
      not_measurable: v.power?.notMeasurable ? 'yes' : 'no',
    });
  }
  if (v.verdict === 'unclear') Object.assign(slots, { date: W.current[1], check: v.failed[0]?.name ?? 'coverage' });
  if (v.verdict === 'noise') Object.assign(slots, { pct: tau ?? 0, freq: '' });
  const absolute = est.missing === null ? null : -est.missing;
  const checkDate = addDays(W.current[1], v.power?.weeksNeeded ? Math.ceil(v.power.weeksNeeded * 7) : 28);
  return {
    id: findingId(['aio_effect', unitKey, `${W.baseline[0]}..${W.current[1]}`, estimator]),
    kind: 'aio_effect',
    unit: { level: 'site', key: unitKey, label: 'Whole site' },
    metric: 'clicks',
    windows: { baseline: W.baseline, current: W.current },
    date: null,
    dateWindow: null,
    effect: {
      estimate: tau, ci95: est.ci95, absolute,
      absoluteCi95: est.missingCi95 ? [-est.missingCi95[1], -est.missingCi95[0]] : null, p: est.p, q,
    },
    real: v.verdict,
    reason: v.reason,
    cause: 'ai_overview',
    causeConfidence: conf,
    components: null,
    componentCi95: null,
    power: v.power ? { ...v.power, perWeek: est.obs / weeks } : null,
    template: templateFor(v),
    slots,
    evidence: [{
      type: 'statistic', confidence: conf, partition: 'serp/',
      summary: `${extra.groups.U} searches with an AI Overview that doesn't cite you, ${extra.groups.N} without one, ${est.kept.length} matched position groups`,
    }],
    alternatives: [],
    falsifier: v.verdict === 'underpowered' ? { key: 'more_data', slots: { check_date: checkDate } } : { key: 'aio_disappears', slots: {} },
    verify: { from: W.current[0], to: W.current[1] },
    related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { ...ANALYZER },
    priority: tier(v.verdict, false) * Math.max(1, Math.abs(absolute ?? 0)),
  };
}

function factFinding(i: AioInput, f: AioQueryFact, checks: SerpObservation[], eC: number): Finding {
  const last = checks[checks.length - 1];
  const first = checks[0];
  const citedText = f.aioChecks === 0 ? 'none' : f.cited ? 'cites_you' : 'doesnt_cite_you';
  return {
    id: f.findingId,
    kind: 'aio_fact',
    unit: { level: 'query', key: f.keyword, label: f.keyword, device: f.device },
    metric: 'aio_presence',
    windows: null,
    date: ptDate(last.observedAt),
    dateWindow: [ptDate(first.observedAt), ptDate(last.observedAt)],
    effect: {
      estimate: f.checks ? f.aioChecks / f.checks : null, ci95: null,
      absolute: f.attributedClicks === null ? null : -f.attributedClicks, absoluteCi95: null, p: null, q: null,
    },
    real: 'signal',
    reason: 'fact',
    cause: f.aioChecks > 0 ? 'ai_overview' : null,
    causeConfidence: 'EXTRACTED',
    components: null,
    componentCi95: null,
    power: null,
    template: 'aio_fact',
    slots: {
      query: f.keyword, device: f.device, k: f.aioChecks, n: f.checks, status: f.status, cited_text: citedText,
      domains: f.topDomains.join(', '), our_rank: f.ourRank ?? 0, expected_clicks: eC,
      title_rewritten: f.titleRewritten === null ? 'unknown' : f.titleRewritten ? 'yes' : 'no',
    },
    evidence: [{
      type: 'serp', confidence: 'EXTRACTED', partition: serpFolder(last.observedAt),
      key: { taskId: last.taskId, keyword: f.keyword, device: f.device },
      summary: `AI Overview in ${f.aioChecks} of ${f.checks} checks${f.aioChecks ? (f.cited ? ', cites you' : ", doesn't cite you") : ''}`,
    }],
    alternatives: [],
    falsifier: { key: 'aio_disappears', slots: {} },
    verify: { query: f.keyword, from: i.windows.current[0], to: i.windows.current[1] },
    related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { ...ANALYZER },
    priority: 5 * Math.max(1, Math.abs(f.attributedClicks ?? 0)),
  };
}

// ---------- the analyzer ----------

export function analyzeAio(i: AioInput): AioOutput {
  if (i.serp.length === 0) return { facts: [], estimates: [], findings: [] };
  const W = i.windows;
  const site = stripWww(i.siteDomain);
  const groups = groupChecks(i.serp, W.current[0]);
  const dayZero = !groups.some((g) => g.current.length >= 2);
  const keys = new Set(groups.map((g) => g.key));
  const totals = cellTotals(i, keys);

  // Query data for the estimators.
  const qsFull: QueryData[] = [];
  const qsDay0: QueryData[] = [];
  let intermittent = 0;
  const counts = { U: 0, N: 0, Cit: 0 };
  const statusByKey = new Map<string, ReturnType<typeof statusOf>>();
  for (const g of groups) {
    const st = statusOf(g.current, site);
    statusByKey.set(g.key, st);
    if (st.status === 'intermittent') intermittent++;
    const t = totals.get(g.key);
    const pB = t && t.iB > 0 ? t.psB / t.iB : Number.NaN;
    const b = bucketOf(pB);
    const latestPi = g.current[g.current.length - 1]?.pi ?? 1;
    const w = latestPi > 0 && latestPi <= 1 ? 1 / latestPi : 1;
    const base = {
      key: g.key, stratum: b === null ? null : `${b}|${g.device}`, w,
      C: t?.C ?? { b: 0, c: 0, pre1: 0, pre2: 0 }, E: t?.E ?? { b: 0, c: 0, pre1: 0, pre2: 0 },
    };
    const grp = (present: boolean): Group => (present ? (st.cited ? 'Cit' : 'U') : 'N');
    if (st.status === 'present' || st.status === 'absent') {
      const q: QueryData = { ...base, group: grp(st.status === 'present') };
      qsFull.push(q);
      qsDay0.push(q);
      counts[q.group]++;
    } else if (dayZero && (st.status === 'single_present' || st.status === 'single_absent')) {
      const q: QueryData = { ...base, group: grp(st.status === 'single_present') };
      qsDay0.push(q);
      counts[q.group]++;
    }
  }

  const B = Math.max(0, Math.floor(i.bootstrap));
  const delta = i.delta > 0 ? i.delta : 0.15;
  const weeksObserved = (diffDays(W.current[0], W.current[1]) + 1) / 7;
  const cs = estimateGroups(dayZero ? qsDay0 : qsFull, { estimator: 'cross_section', B, rng: i.rng('aio:cross_section') });
  const dd = estimateGroups(qsFull, { estimator: 'did', from: 'b', to: 'c', B, rng: i.rng('aio:did') });
  const pl = estimateGroups(qsFull, { estimator: 'did', from: 'pre1', to: 'pre2', B, rng: i.rng('aio:placebo') });
  const placebo = pl.tau !== null && pl.ci95 ? { tau: pl.tau, ci95: pl.ci95 } : null;

  const ps = [cs.p, dd.p];
  const present = ps.map((p, k) => (p === null ? -1 : k)).filter((k) => k >= 0);
  const qv = benjaminiHochberg(present.map((k) => ps[k] as number));
  const qOf = (k: number): number | null => {
    const at = present.indexOf(k);
    return at >= 0 ? qv[at] : null;
  };

  const checksFor = (est: Estimation, estimator: 'cross_section' | 'did'): IdCheck[] => {
    const out: IdCheck[] = [{ name: 'coverage', passed: est.coverage >= MIN_COVERAGE, detail: `coverage ${est.coverage.toFixed(2)}` }];
    if (estimator === 'cross_section' && dayZero) out.push({ name: 'single_check', passed: false, detail: 'each search checked once so far' });
    if (estimator === 'did' && placebo) {
      const excludes0 = placebo.ci95[0] > 0 || placebo.ci95[1] < 0;
      out.push({ name: 'placebo', passed: !(excludes0 && Math.abs(placebo.tau) >= delta / 2), detail: `placebo ${placebo.tau.toFixed(3)}` });
    }
    return out;
  };
  const verdictFor = (est: Estimation, estimator: 'cross_section' | 'did', q: number | null): VerdictResult =>
    decideVerdict({
      estimate: est.tau ?? 0, ci95: est.ci95, floorsMet: est.floorsMet && est.tau !== null, identification: checksFor(est, estimator),
      q, delta, fdrQ: FDR_Q, weeksObserved, counts: { pre: est.cf, post: est.obs, phi: 1 },
    });
  const vCs = verdictFor(cs, 'cross_section', qOf(0));
  const vDd = verdictFor(dd, 'did', qOf(1));
  const groupCounts = { U: counts.U, N: counts.N, Cit: counts.Cit, intermittent };
  const fullCounts = {
    U: qsFull.filter((q) => q.group === 'U').length, N: qsFull.filter((q) => q.group === 'N').length,
    Cit: qsFull.filter((q) => q.group === 'Cit').length, intermittent,
  };
  const fCs = estimateFinding(i, cs, 'cross_section', vCs, qOf(0), { groups: dayZero ? groupCounts : fullCounts, singles: dayZero, placebo: null });
  const fDd = estimateFinding(i, dd, 'did', vDd, qOf(1), { groups: fullCounts, singles: false, placebo });
  const estimates: AioEstimate[] = [
    {
      estimator: 'cross_section', tau: cs.tau, ci95: cs.ci95, missingClicks: cs.missing, missingCi95: cs.missingCi95,
      groups: dayZero ? groupCounts : fullCounts, coverage: cs.coverage, placebo: null, real: vCs.verdict, reason: vCs.reason, findingId: fCs.id,
    },
    {
      estimator: 'did', tau: dd.tau, ci95: dd.ci95, missingClicks: dd.missing, missingCi95: dd.missingCi95,
      groups: fullCounts, coverage: dd.coverage, placebo, real: vDd.verdict, reason: vDd.reason, findingId: fDd.id,
    },
  ];

  // Per-query facts and apportioning (5.11.4).
  const didSignal = vDd.verdict === 'signal' && dd.tau !== null;
  const facts: AioQueryFact[] = [];
  const factRows: { fact: AioQueryFact; checks: SerpObservation[]; eC: number }[] = [];
  for (const g of groups) {
    const checks = g.current.length ? g.current : g.all;
    const st = g.current.length ? (statusByKey.get(g.key) as ReturnType<typeof statusOf>) : statusOf(g.all, site);
    const status: AioStatus = st.status ?? 'single_absent';
    const domains = new Map<string, number>();
    for (const c of checks) {
      for (const d of new Set((c.aio?.refs ?? []).map((r) => stripWww(r.domain)))) {
        if (!d || domainMatches(d, site)) continue;
        domains.set(d, (domains.get(d) ?? 0) + 1);
      }
    }
    const topDomains = [...domains.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([d]) => d);
    const last = checks[checks.length - 1];
    const withOurs = [...checks].reverse().find((c) => c.ours !== null) ?? null;
    const pageTitle = withOurs?.ours ? pageTitleFor(i.pageTitles, withOurs.ours.url) : null;
    const eC = totals.get(g.key)?.E.c ?? 0;
    const sq = i.samePosByQuery.get(g.key);
    const uncitedPresent = (status === 'present' || status === 'single_present') && !st.cited;
    const attributed = didSignal && uncitedPresent && sq !== undefined && sq < 0
      ? Math.min(Math.abs(sq), eC * Math.abs(dd.tau as number))
      : null;
    const fact: AioQueryFact = {
      keyword: g.keyword, device: g.device, checks: checks.length, aioChecks: st.k, status, cited: st.cited, topDomains,
      ourRank: last.ours?.rankAbsolute ?? null,
      titleRewritten: withOurs?.ours && pageTitle !== null ? titleRewritten(withOurs.ours.title, pageTitle) : null,
      attributedClicks: attributed, findingId: findingId(['aio_fact', g.keyword, g.device]),
    };
    factRows.push({ fact, checks, eC });
  }
  factRows.sort((a, b) =>
    Number(b.fact.aioChecks > 0) - Number(a.fact.aioChecks > 0) || b.eC - a.eC || (a.fact.keyword < b.fact.keyword ? -1 : a.fact.keyword > b.fact.keyword ? 1 : a.fact.device < b.fact.device ? -1 : 1));
  for (const r of factRows.slice(0, FACTS_CAP)) facts.push(r.fact);
  const findings: Finding[] = [fCs, fDd, ...factRows.slice(0, FACT_FINDINGS_CAP).map((r) => factFinding(i, r.fact, r.checks, r.eC))];
  findings.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { facts, estimates, findings };
}
