// Unit decomposition, edge cases, remainder, scope aggregation, bootstrap CIs (5.5). Owner: WP-E.
//
// Units are named (page, query, device) cells from the qpd slice plus one anonymised remainder
// per page (page totals minus named cells, all devices). Each unit's click change splits exactly
// into Bennet midpoint bars (the 3-player Shapley value):
//   demand  = (I_c - I_b) * mean CTR        rank = mean I * (F_c - F_b)        samePos = mean I * (r_c - r_b)
// where F is the curve-expected click rate (computed per day cell, never at the window mean
// position) and r = CTR - F. Scope bars are plain sums of unit bars, so they add up exactly too.
//
// Bootstrap (5.5.5): per replicate the curve is redrawn and every unit's clicks are redrawn from a
// Poisson in both windows (a sum of independent cell Poissons is Poisson, so drawing per unit is
// the same distribution as drawing per cell; the clamp C* <= I is applied per unit). Scopes with
// 30 or more units also resample their units with replacement. One set of unit redraws per
// replicate is shared by every scope, which keeps the cost at units x B instead of scopes x cells x B.
import type {
  AnalysisUnit, Bars, Cell, CtrCurve, Device, PageDay, Rng, ScopeDecomposition, Segment, UnitDecomposition, UnitFlag, UnitKey,
  Windows, WindowStats,
} from '../core/types.js';
import { OTHER_PAGES } from '../core/templates.js';
import { curveBasis, segmentOf } from './ctr-curve.js';
import { bootstrapP, percentileCi, poissonDraw } from './stats.js';

export const BAR_KEYS: readonly (keyof Bars)[] = ['demand', 'visibility', 'rank', 'samePos', 'appeared', 'disappeared', 'aioCitation'];
/** Display groups (5.5.5): ranking = rank + visibility, churn = appeared + disappeared. */
export type Group = 'demand' | 'ranking' | 'samePos' | 'aioCitation' | 'churn';
export const GROUPS: readonly Group[] = ['demand', 'ranking', 'samePos', 'aioCitation', 'churn'];

const PAGE_ONE = 10.5;
const MIN_STABLE_UNITS = 10;
const SPARSE_REMAINDER = 5;
const RESAMPLE_MIN_UNITS = 30;
const CELL_BUDGET = 3e8;
const MIN_B = 200;

export function zeroBars(): Bars {
  return { demand: 0, visibility: 0, rank: 0, samePos: 0, appeared: 0, disappeared: 0, aioCitation: 0 };
}

export function barsTotal(b: Bars): number {
  return b.demand + b.visibility + b.rank + b.samePos + b.appeared + b.disappeared + b.aioCitation;
}

export function groupsOf(b: Bars): Record<Group, number> {
  return {
    demand: b.demand,
    ranking: b.rank + b.visibility,
    samePos: b.samePos,
    aioCitation: b.aioCitation,
    churn: b.appeared + b.disappeared,
  };
}

function addInto(acc: Bars, b: Bars): void {
  for (const k of BAR_KEYS) acc[k] += b[k];
}

// ---------------------------------------------------------------------------
// Unit bars (5.5.1 and 5.5.2)
// ---------------------------------------------------------------------------

/** Edge-case inputs fixed by impressions and positions, so they hold in every bootstrap replicate. */
export interface UnitEdges {
  /** Demand index for a page-1 crossing; null when the unit did not cross. */
  crossingK: number | null;
  /** AIO citation flattening applies. */
  flatten: boolean;
}

/**
 * Bars for one unit from window totals: I (impressions), C (clicks) and FI (sum of I * f over day
 * cells, so F = FI / I). The bars always sum to Cc - Cb.
 */
export function barsFromTotals(Ib: number, Cb: number, FIb: number, Ic: number, Cc: number, FIc: number, edges?: UnitEdges): Bars {
  const out = zeroBars();
  if (!(Ib > 0) || !(Ic > 0)) {
    // 1. Appeared or disappeared (and the rare clamped remainder with clicks but no impressions).
    out.appeared = Cc;
    out.disappeared = -Cb;
    return out;
  }
  const ctrB = Cb / Ib;
  const ctrC = Cc / Ic;
  const fB = FIb / Ib;
  const fC = FIc / Ic;
  const iBar = (Ib + Ic) / 2;
  const ctrBar = (ctrB + ctrC) / 2;
  out.demand = (Ic - Ib) * ctrBar;
  out.rank = iBar * (fC - fB);
  out.samePos = iBar * (ctrC - fC - (ctrB - fB));
  if (edges?.crossingK != null) {
    // 2. Page-1 crossing: only the part of the impression change that stable units also saw is demand.
    const d = out.demand;
    out.demand = Ib * (edges.crossingK - 1) * ctrBar;
    out.visibility = d - out.demand;
  }
  if (edges?.flatten) {
    // 3. AIO citation flattening: the position "gain" is a citation, so rank and samePos merge.
    out.aioCitation = out.rank + out.samePos;
    out.rank = 0;
    out.samePos = 0;
  }
  return out;
}

/** Bennet midpoint bars for one unit (5.5.1 plus the appeared/disappeared case). Invariant: the bars sum to cur.C - base.C. */
export function unitBars(base: WindowStats, cur: WindowStats, edges?: UnitEdges): Bars {
  return barsFromTotals(base.I, base.C, base.F * base.I, cur.I, cur.C, cur.F * cur.I, edges);
}

// ---------------------------------------------------------------------------
// Building units
// ---------------------------------------------------------------------------

/** One term of sum(I * f): I impressions at position p, scored by one segment or a weighted mix. */
interface FTerm { i: number; p: number; seg: Segment | null; mix: Partial<Record<Segment, number>> | null }

interface Side { I: number; C: number; ps: number; terms: FTerm[] }

export interface WUnit {
  key: UnitKey;
  template: string;
  brand: boolean | null;
  seg: Segment | null;
  base: Side;
  cur: Side;
  edges: UnitEdges;
  flags: UnitFlag[];
}

export interface WaterfallInput {
  windows: Windows;
  /** Named cells covering at least both windows. */
  cells: Cell[];
  /** Page totals (p slice) covering at least both windows. */
  pageDaily: PageDay[];
  /** Site impressions by device per day (td), for the remainder's device mix. */
  deviceDaily: { date: string; dv: Device; i: number }[];
  /** Site t impressions per window: the last-resort demand index for page-1 crossings. */
  siteImpressions: { base: number; cur: number };
  curve: CtrCurve;
  isBrand: (q: string) => boolean;
  templates: Map<string, string>;
  /** 'keyword|device' pairs that qualify for AIO citation flattening (5.5.2 step 3). */
  flattening: Set<string>;
}

const emptySide = (): Side => ({ I: 0, C: 0, ps: 0, terms: [] });
const which = (d: string, w: Windows): 'base' | 'cur' | null =>
  d >= w.baseline[0] && d <= w.baseline[1] ? 'base' : d >= w.current[0] && d <= w.current[1] ? 'cur' : null;
const pbarOf = (s: Side): number | null => (s.I > 0 ? s.ps / s.I : null);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function evalTerms(curve: CtrCurve, terms: FTerm[]): number {
  let s = 0;
  for (const t of terms) s += t.i * (t.seg ? curve.f(t.p, t.seg) : curve.fMix(t.p, t.mix ?? {}));
  return s;
}

export interface WaterfallModel {
  units: WUnit[];
  /** Stable-unit demand index over all named units (C's "Demand" synthesis row); null with under 10 stable units. */
  demandK: number | null;
  /** Day cells used (named cells plus remainder page-days, both windows): sizes the bootstrap. */
  cellCount: number;
}

export function buildUnits(i: WaterfallInput): WaterfallModel {
  const w = i.windows;
  const templateOf = (p: string): string => i.templates.get(p) ?? OTHER_PAGES;
  const named = new Map<string, WUnit>();
  // Named cells grouped by (page, date) for the remainder.
  const byPageDay = new Map<string, { I: number; C: number; ps: number; terms: FTerm[] }>();
  let cellCount = 0;

  for (const c of i.cells) {
    const side = which(c.date, w);
    if (!side || !(c.i >= 0)) continue;
    cellCount++;
    const k = `${c.p}\u0000${c.q}\u0000${c.dv}`;
    let u = named.get(k);
    if (!u) {
      const brand = i.isBrand(c.q);
      u = {
        key: { page: c.p, query: c.q, device: c.dv },
        template: templateOf(c.p),
        brand,
        seg: segmentOf(c.dv, brand),
        base: emptySide(),
        cur: emptySide(),
        edges: { crossingK: null, flatten: false },
        flags: [],
      };
      named.set(k, u);
    }
    const s = u[side];
    s.I += c.i;
    s.C += c.c;
    s.ps += c.ps;
    const term: FTerm | null = c.i > 0 ? { i: c.i, p: c.ps / c.i, seg: u.seg, mix: null } : null;
    if (term) s.terms.push(term);
    const pdKey = `${c.p}\u0000${c.date}`;
    const pd = byPageDay.get(pdKey) ?? { I: 0, C: 0, ps: 0, terms: [] };
    pd.I += c.i;
    pd.C += c.c;
    pd.ps += c.ps;
    if (term) pd.terms.push(term);
    byPageDay.set(pdKey, pd);
  }

  // Device mix per day for the remainder (nonbrand segments weighted by site impressions).
  const mixByDate = new Map<string, Partial<Record<Segment, number>>>();
  for (const r of i.deviceDaily) {
    const m = mixByDate.get(r.date) ?? {};
    const seg = segmentOf(r.dv, false);
    m[seg] = (m[seg] ?? 0) + Math.max(0, r.i);
    mixByDate.set(r.date, m);
  }

  // Remainder per page: page totals minus named cells, per day (5.5.3).
  const remainder = new Map<string, WUnit>();
  const pageDays = new Map<string, PageDay>();
  for (const r of i.pageDaily) if (which(r.date, w)) pageDays.set(`${r.p}\u0000${r.date}`, r);
  const keys = new Set([...pageDays.keys(), ...byPageDay.keys()]);
  for (const k of [...keys].sort(cmp)) {
    const [page, date] = k.split('\u0000');
    const side = which(date, w);
    if (!side) continue;
    const p = pageDays.get(k) ?? { date, p: page, c: 0, i: 0, ps: 0 };
    const nm = byPageDay.get(k) ?? { I: 0, C: 0, ps: 0, terms: [] };
    let u = remainder.get(page);
    if (!u) {
      u = {
        key: { page, query: null, device: 'all' },
        template: templateOf(page),
        brand: null,
        seg: null,
        base: emptySide(),
        cur: emptySide(),
        edges: { crossingK: null, flatten: false },
        flags: ['remainder'],
      };
      remainder.set(page, u);
    }
    cellCount++;
    let Ir = p.i - nm.I;
    let Cr = p.c - nm.C;
    let psr = p.ps - nm.ps;
    let clamped = false;
    if (Ir < 0) { Ir = 0; clamped = true; }
    if (Cr < 0) { Cr = 0; clamped = true; }
    if (Ir > 0) {
      const pr = psr / Ir;
      if (!(pr >= 1 && pr <= 100)) {
        psr = Ir * Math.min(100, Math.max(1, Number.isFinite(pr) ? pr : 1));
        clamped = true;
      }
    } else {
      if (psr !== 0) clamped = clamped || psr < 0;
      psr = 0;
    }
    if (clamped && !u.flags.includes('remainder_clamped')) u.flags.push('remainder_clamped');
    const s = u[side];
    s.I += Ir;
    s.C += Cr;
    s.ps += psr;
    if (Ir > 0) {
      const pr = psr / Ir;
      if (Ir < SPARSE_REMAINDER && nm.I > 0 && nm.terms.length > 0) {
        // Too few hidden impressions to trust their average position: borrow the page's named F for the day.
        for (const t of nm.terms) s.terms.push({ ...t, i: (Ir * t.i) / nm.I });
        if (!u.flags.includes('remainder_sparse')) u.flags.push('remainder_sparse');
      } else {
        s.terms.push({ i: Ir, p: pr, seg: null, mix: mixByDate.get(date) ?? {} });
      }
    }
  }

  const units = [
    ...[...named.values()].sort((a, b) => cmp(a.key.page, b.key.page) || cmp(a.key.query ?? '', b.key.query ?? '') || cmp(a.key.device, b.key.device)),
    ...[...remainder.values()].sort((a, b) => cmp(a.key.page, b.key.page)),
  ];

  // Stable units and demand indexes for page-1 crossings (5.5.2 step 2).
  const stable = (u: WUnit): boolean => {
    const pb = pbarOf(u.base);
    const pc = pbarOf(u.cur);
    return u.key.query !== null && pb !== null && pc !== null && pb <= PAGE_ONE && pc <= PAGE_ONE && Math.abs(pc - pb) < 1;
  };
  const kGroups = new Map<string, { n: number; ib: number; ic: number }>();
  const site = { n: 0, ib: 0, ic: 0 };
  for (const u of units) {
    if (!stable(u)) continue;
    const g = `${u.template}\u0000${u.key.device}`;
    const acc = kGroups.get(g) ?? { n: 0, ib: 0, ic: 0 };
    acc.n++;
    acc.ib += u.base.I;
    acc.ic += u.cur.I;
    kGroups.set(g, acc);
    site.n++;
    site.ib += u.base.I;
    site.ic += u.cur.I;
  }
  const demandK = site.n >= MIN_STABLE_UNITS && site.ib > 0 ? site.ic / site.ib : null;
  const unstable = new Set(i.curve.unstable);
  for (const u of units) {
    const pb = pbarOf(u.base);
    const pc = pbarOf(u.cur);
    if (u.seg && unstable.has(u.seg)) u.flags.push('curve_unstable');
    if (u.seg === null && (unstable.has('desktop|nonbrand') || unstable.has('mobile|nonbrand'))) u.flags.push('curve_unstable');
    if (u.key.query === null || pb === null || pc === null) continue;
    if ((pb <= PAGE_ONE) !== (pc <= PAGE_ONE)) {
      const g = kGroups.get(`${u.template}\u0000${u.key.device}`);
      let K: number;
      if (g && g.n >= MIN_STABLE_UNITS && g.ib > 0) K = g.ic / g.ib;
      else if (demandK !== null) K = demandK;
      else {
        K = i.siteImpressions.base > 0 ? i.siteImpressions.cur / i.siteImpressions.base : 1;
        u.flags.push('k_fallback');
      }
      u.edges.crossingK = K;
      u.flags.push('page1_crossing');
    }
    if (i.flattening.has(`${u.key.query}|${u.key.device}`) && pc < pb) {
      u.edges.flatten = true;
      u.flags.push('aio_flattening');
    }
  }
  return { units, demandK, cellCount };
}

/** Window stats and bars of every unit at the point estimate. */
export function decomposeUnits(model: WaterfallModel, curve: CtrCurve): (UnitDecomposition & { Eb: number })[] {
  return model.units.map((u) => {
    const FIb = evalTerms(curve, u.base.terms);
    const FIc = evalTerms(curve, u.cur.terms);
    const base: WindowStats = { I: u.base.I, C: u.base.C, F: u.base.I > 0 ? FIb / u.base.I : 0, pbar: pbarOf(u.base) };
    const cur: WindowStats = { I: u.cur.I, C: u.cur.C, F: u.cur.I > 0 ? FIc / u.cur.I : 0, pbar: pbarOf(u.cur) };
    return {
      key: u.key,
      template: u.template,
      brand: u.brand,
      base,
      cur,
      bars: barsFromTotals(u.base.I, u.base.C, FIb, u.cur.I, u.cur.C, FIc, u.edges),
      flags: [...u.flags],
      Eb: FIb,
    };
  });
}

// ---------------------------------------------------------------------------
// Scopes and the bootstrap
// ---------------------------------------------------------------------------

export interface ScopeSpec { unit: AnalysisUnit; members: number[] }

export interface ScopeBoot {
  ci95: Partial<Record<keyof Bars | 'total', [number, number]>>;
  groupCi: Record<Group, [number, number]>;
  pTotal: number;
}

/** Point decomposition of a scope: sums of its units' bars. */
export function scopeDecomposition(spec: ScopeSpec, units: UnitDecomposition[], boot: ScopeBoot | null): ScopeDecomposition {
  const bars = zeroBars();
  let base = 0;
  let cur = 0;
  let namedClicks = 0;
  for (const m of spec.members) {
    const u = units[m];
    addInto(bars, u.bars);
    base += u.base.C;
    cur += u.cur.C;
    if (u.key.query !== null) namedClicks += u.base.C + u.cur.C;
  }
  return {
    unit: spec.unit,
    baseClicks: base,
    curClicks: cur,
    deltaClicks: cur - base,
    bars,
    ci95: boot ? boot.ci95 : null,
    pTotal: boot ? boot.pTotal : null,
    units: spec.members.length,
    namedClickShare: base + cur > 0 ? namedClicks / (base + cur) : 0,
  };
}

/** B reduced so that cells x B stays within 3e8, never below 200 (or below the configured value when that is smaller). */
export function bootstrapSize(configured: number, cells: number): number {
  const cap = cells > 0 ? Math.floor(CELL_BUDGET / cells) : configured;
  return Math.max(1, Math.min(configured, Math.max(MIN_B, cap)));
}

/** Precompiled sum(I * f) as a sparse dot product with the curve's bin fits (fast path). */
interface Compiled { idx: Int32Array; coef: Float64Array }

function compile(terms: FTerm[], weights: (p: number, seg: Segment) => [number, number, number, number]): Compiled {
  const acc = new Map<number, number>();
  const add = (j: number, v: number): void => {
    if (v !== 0) acc.set(j, (acc.get(j) ?? 0) + v);
  };
  for (const t of terms) {
    const parts: [Segment, number][] = [];
    if (t.seg) parts.push([t.seg, 1]);
    else {
      const mix = t.mix ?? {};
      let tot = 0;
      for (const v of Object.values(mix)) tot += v ?? 0;
      if (tot > 0) for (const [s, v] of Object.entries(mix) as [Segment, number][]) { if (v > 0) parts.push([s, v / tot]); }
      else parts.push(['desktop|nonbrand', 0.5], ['mobile|nonbrand', 0.5]);
    }
    for (const [seg, share] of parts) {
      const [i0, i1, w0, w1] = weights(t.p, seg);
      add(i0, t.i * share * w0);
      add(i1, t.i * share * w1);
    }
  }
  const idx = [...acc.keys()].sort((a, b) => a - b);
  return { idx: Int32Array.from(idx), coef: Float64Array.from(idx.map((j) => acc.get(j) as number)) };
}

function dot(c: Compiled, fit: Float64Array): number {
  let s = 0;
  for (let k = 0; k < c.idx.length; k++) s += c.coef[k] * fit[c.idx[k]];
  return s;
}

export interface BootstrapOptions {
  B: number;
  curve: CtrCurve;
  /** Shared redraws (curve and unit clicks). */
  rng: Rng;
  /** Unit resampling for one scope. */
  scopeRng: (scope: ScopeSpec) => Rng;
  /** Quasi-Poisson inflation: T*_adj = T + sqrt(phi) (T* - T). */
  phi: number;
}

export function bootstrapScopes(model: WaterfallModel, units: UnitDecomposition[], scopes: ScopeSpec[], o: BootstrapOptions): ScopeBoot[] {
  const nU = model.units.length;
  const B = o.B;
  const NK = BAR_KEYS.length;
  const basis = curveBasis(o.curve);
  const compiled = basis
    ? model.units.map((u) => ({ b: compile(u.base.terms, basis.weights), c: compile(u.cur.terms, basis.weights) }))
    : null;
  const rep = new Float64Array(nU * NK);
  const sums = scopes.map(() => Array.from({ length: NK }, () => new Float64Array(B)));
  const scopeRngs = scopes.map((s) => (s.members.length >= RESAMPLE_MIN_UNITS ? o.scopeRng(s) : null));

  for (let b = 0; b < B; b++) {
    const curveStar = o.curve.redraw(o.rng);
    const fit = basis ? basis.fitVector(curveStar) : null;
    for (let k = 0; k < nU; k++) {
      const u = model.units[k];
      const draw = (C: number, I: number): number => {
        const x = C > 0 ? poissonDraw(o.rng, C) : 0;
        return I > 0 ? Math.min(I, x) : x;
      };
      const Cb = draw(u.base.C, u.base.I);
      const Cc = draw(u.cur.C, u.cur.I);
      let FIb: number;
      let FIc: number;
      if (compiled && fit) {
        FIb = dot(compiled[k].b, fit);
        FIc = dot(compiled[k].c, fit);
      } else {
        FIb = evalTerms(curveStar, u.base.terms);
        FIc = evalTerms(curveStar, u.cur.terms);
      }
      const bars = barsFromTotals(u.base.I, Cb, FIb, u.cur.I, Cc, FIc, u.edges);
      for (let j = 0; j < NK; j++) rep[k * NK + j] = bars[BAR_KEYS[j]];
    }
    for (let s = 0; s < scopes.length; s++) {
      const members = scopes[s].members;
      const r = scopeRngs[s];
      const acc = sums[s];
      for (let n = 0; n < members.length; n++) {
        const k = r ? members[Math.floor(r() * members.length)] : members[n];
        for (let j = 0; j < NK; j++) acc[j][b] += rep[k * NK + j];
      }
    }
  }

  const sq = Math.sqrt(Math.max(1, o.phi));
  return scopes.map((spec, s) => {
    const point = zeroBars();
    for (const m of spec.members) addInto(point, units[m].bars);
    const adj = (t: number, star: number): number => t + sq * (star - t);
    const series: Record<keyof Bars | 'total' | 'ranking' | 'churn', number[]> = {
      demand: [], visibility: [], rank: [], samePos: [], appeared: [], disappeared: [], aioCitation: [], total: [], ranking: [], churn: [],
    };
    const total = barsTotal(point);
    for (let b = 0; b < B; b++) {
      let tot = 0;
      for (let j = 0; j < NK; j++) {
        const key = BAR_KEYS[j];
        const v = sums[s][j][b];
        tot += v;
        series[key].push(adj(point[key], v));
      }
      series.total.push(adj(total, tot));
      series.ranking.push(adj(point.rank + point.visibility, sums[s][1][b] + sums[s][2][b]));
      series.churn.push(adj(point.appeared + point.disappeared, sums[s][4][b] + sums[s][5][b]));
    }
    // Per-bar CIs plus the two display groups that are sums of bars (ranking, churn). The frozen
    // ScopeDecomposition type only names Bars keys and 'total'; the group keys ride along at runtime
    // so the report can draw their whiskers (report/copy.ts displayGroups reads them).
    const ci95: Record<string, [number, number]> = {};
    for (const key of [...BAR_KEYS, 'total', 'ranking', 'churn'] as const) ci95[key] = percentileCi(series[key]);
    return {
      ci95: ci95 as Partial<Record<keyof Bars | 'total', [number, number]>>,
      groupCi: {
        demand: ci95.demand,
        ranking: ci95.ranking,
        samePos: ci95.samePos,
        aioCitation: ci95.aioCitation,
        churn: ci95.churn,
      },
      pTotal: bootstrapP(series.total),
    };
  });
}
