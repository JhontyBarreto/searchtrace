// runAnalysis orchestrator: loads via IndexReader, fits the curve once, calls every analyzer, BH families. Owner: WP-E.
//
// Order: windows and inputs hash -> templates, brand, events, SERP tallies -> headline (5.4) ->
// curve (5.3) -> waterfall units, scopes and bootstrap (5.5) -> change points (B), scorecard (B),
// site changes and index states (C), AI Overviews (D) -> synthesis (5.12) -> sorted findings.
// Everything random comes from rngFor(seed, key) with seed = sha256(property | D | inputsHash).
// Analyzers that are still Phase 0 stubs (StError 'not_implemented') are skipped and listed by
// runAnalysisDetailed; any other error propagates.
import { StError } from '../core/errors.js';
import { findingId, sha256Hex } from '../core/ids.js';
import { rngFor } from '../core/rng.js';
import { clusterTemplates, OTHER_PAGES } from '../core/templates.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import { defaultOrigins, pathOf } from '../core/url.js';
import type {
  AioOutput, AnalysisInput, AnalysisOutput, AnalysisUnit, Cell, ChangePoint, DayTotal, Device, Finding, GoogleEvent, IdCheck, IsoDate,
  PeriodEffect, ScopeDecomposition, SerpCandidate, SerpObservation, Series, SiteChangeImpact, UpdateRow, Verdict, VerdictReason,
} from '../core/types.js';
import { layout } from '../store/layout.js';
import { analyzeAio } from './aio.js';
import {
  causeForScope, eventsOverlapping, headlineFinding, LABEL_SITE, noticeFinding, scopeFinding, sortFindings, findingPriority, unitLabel,
  type ScopeFacts, type ScopeVerdict, type SynthesisContext,
} from './attribute.js';
import { buildBrandMatcher } from './brand.js';
import { analyzeChangePoints } from './changepoint.js';
import { fitCurve, segmentOf, type DatedCurveCell } from './ctr-curve.js';
import { analyzeIndexStates } from './index-state.js';
import { buildScorecard } from './scorecard.js';
import { analyzeSiteChanges } from './site-change.js';
import { benjaminiHochberg, dowFactors, normalCdf, overdispersion, periodCompare, seasonalSeries } from './stats.js';
import { DEFAULT_DELTA, decideVerdict } from './verdicts.js';
import { bootstrapScopes, bootstrapSize, buildUnits, decomposeUnits, scopeDecomposition, type ScopeBoot, type ScopeSpec } from './waterfall.js';
import { computeWindows, inWindow, windowsOverlap, withHistory } from './windows.js';

const TOP_SCOPES = 50;
const TOP_FINDINGS = 25;
const TOP_CP_PAGES = 200;
const AIO_FACT_CAP = 200;
const SERP_MAX_POSITION = 20;
const SERP_MIN_IMPRESSIONS = 10;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface AnalysisDetails { output: AnalysisOutput; skipped: string[] }

function optional<T>(name: string, skipped: string[], fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StError && e.code === 'not_implemented') {
      skipped.push(name);
      return fallback;
    }
    throw e;
  }
}

/** Contiguous values from `from` to `to` (zero where nothing is stored). */
function fill(from: IsoDate, to: IsoDate, rows: { date: IsoDate; c: number; i: number }[], metric: 'c' | 'i'): number[] {
  const n = diffDays(from, to) + 1;
  const out = new Array<number>(Math.max(0, n)).fill(0);
  for (const r of rows) {
    const k = diffDays(from, r.date);
    if (k >= 0 && k < n) out[k] += r[metric];
  }
  return out;
}

const sumRange = (values: number[], start: IsoDate, w: [IsoDate, IsoDate]): number => {
  let s = 0;
  const a = Math.max(0, diffDays(start, w[0]));
  const b = Math.min(values.length - 1, diffDays(start, w[1]));
  for (let k = a; k <= b; k++) s += values[k];
  return s;
};

interface SerpTally { checks: number; aio: number; cited: number }

function tallySerp(serp: SerpObservation[], w: [IsoDate, IsoDate]): Map<string, SerpTally> {
  const out = new Map<string, SerpTally>();
  for (const o of serp) {
    const d = ptDate(o.observedAt);
    if (!inWindow(d, w)) continue;
    const k = `${o.keyword}|${o.device}`;
    const t = out.get(k) ?? { checks: 0, aio: 0, cited: 0 };
    t.checks++;
    if (o.aio) {
      t.aio++;
      if (o.aio.citesUs) t.cited++;
    }
    out.set(k, t);
  }
  return out;
}

const citedMostly = (t: SerpTally | undefined): boolean => !!t && t.aio > 0 && t.cited / t.aio >= 0.5;

export function runAnalysis(i: AnalysisInput): AnalysisOutput {
  return runAnalysisDetailed(i).output;
}

export function runAnalysisDetailed(i: AnalysisInput): AnalysisDetails {
  const skipped: string[] = [];
  const cfg = i.config;
  const L = cfg.analysis.windowDays;
  const D = i.dataThrough;
  const fdrQ = cfg.analysis.fdrQ;
  const range = i.db.dataRange();
  const windows = withHistory(computeWindows(D, L), range.first);
  const [b0] = windows.baseline;
  const [c0] = windows.current;
  const historyStart = range.first && range.first <= D ? range.first : b0;
  const padFrom = historyStart < b0 ? historyStart : b0;

  const partitions = [...i.db.partitionsUsed()].sort((a, b) => cmp(a.path, b.path) || cmp(a.sha256, b.sha256));
  const inputsHash = sha256Hex(partitions.map((p) => `${p.path}\t${p.sha256}`).join('\n'));
  const seed = sha256Hex(`${i.property}|${D}|${inputsHash}`);
  const rng = (key: string) => rngFor(seed, key);

  const pageUrls = i.db.pages().map((p) => p.url).sort(cmp);
  const templates = clusterTemplates(pageUrls, cfg.analysis.templateOverrides);
  const templateOf = (u: string): string => templates.get(u) ?? OTHER_PAGES;
  const brand = buildBrandMatcher({ siteDomain: i.siteDomain, siteName: i.siteName, terms: cfg.analysis.brandTerms });
  const events: GoogleEvent[] = i.db.googleEvents();
  const measurement = events.filter((e) => e.kind === 'data_anomaly');
  const evSpan = (e: GoogleEvent): [IsoDate, IsoDate] => [ptDate(e.begin), ptDate(e.end ?? new Date(Date.parse(e.begin) + 14 * 86_400_000).toISOString())];
  const touchesWindows = measurement.some((e) => windowsOverlap(evSpan(e), [b0, D]));

  // ---- Site series, seasonal factors, dispersion, headline (5.4) ----
  const sealed = i.db.siteDaily(padFrom, D);
  const clicks = fill(padFrom, D, sealed, 'c');
  const impressions = fill(padFrom, D, sealed, 'i');
  const dow = dowFactors(padFrom, impressions);
  const s = seasonalSeries(padFrom, clicks.length, dow);
  const cpFrom = windows.changepoint[0] > historyStart ? windows.changepoint[0] : historyStart;
  const cpOff = diffDays(padFrom, cpFrom);
  const phiClicks = overdispersion(clicks.slice(cpOff), s.slice(cpOff));
  const phiImpr = overdispersion(impressions.slice(cpOff), s.slice(cpOff));
  const exclude: [IsoDate, IsoDate][] = events
    .filter((e) => e.kind === 'core' || e.kind === 'spam' || e.kind === 'data_anomaly')
    .map((e) => {
      const [a, b] = evSpan(e);
      return [addDays(a, -7), addDays(b, 7)];
    });
  const compare = (values: number[], phi: number, floor: number): PeriodEffect =>
    periodCompare({ values, start: padFrom, pre: windows.baseline, post: windows.current, s, phi, exclude, floor, delta: DEFAULT_DELTA.site, fdrQ });
  const hClicks = compare(clicks, phiClicks, 30);
  let hImpr = compare(impressions, phiImpr, 1000);
  // A reporting change touching either window caps the impressions comparison at unclear (5.1).
  if (touchesWindows && hImpr.floorsMet) hImpr = { ...hImpr, real: 'unclear', reason: 'identification', power: null };
  // Period-to-period variance of impressions beyond counting noise, measured on the whole site's own
  // history (empirical SE squared minus the quasi-Poisson part). Section, page and search impression
  // comparisons add it to their own counting variance: impressions swing from month to month far
  // more than Poisson counts do (on a real small site the empirical SE was 7 times the quasi-Poisson
  // one), and a page is at least as jumpy as the whole site.
  const imprExtraVar = hImpr.seSource === 'empirical' && hImpr.pre > 0 && hImpr.post > 0
    ? Math.max(0, hImpr.se ** 2 - phiImpr * (1 / hImpr.pre + 1 / hImpr.post))
    : 0;

  // ---- SERP tallies ----
  const serp = i.db.serp();
  const serpFit = tallySerp(serp, windows.fit);
  const serpCur = tallySerp(serp, windows.current);
  const serpBase = tallySerp(serp, windows.baseline);
  // Checks taken after the last final day still describe today's results page (they always land
  // 2 to 3 days after D, because Search Console lags), so they count as "checked" from b0 onwards.
  const serpRecent = tallySerp(serp, [b0, '9999-12-31']);
  // A search counts as checked when any device was checked (checks run on its main device only).
  const checkedKeywords = new Set([...serpRecent.keys()].map((k) => k.slice(0, k.lastIndexOf('|'))));
  const aioKeywords = new Set([...serpRecent.entries()].filter(([, t]) => t.aio > 0).map(([k]) => k.slice(0, k.lastIndexOf('|'))));
  const excludedPairs = new Set([...serpFit.keys(), ...serpCur.keys()].filter((k) => citedMostly(serpFit.get(k)) || citedMostly(serpCur.get(k))));
  const flattening = new Set([...serpCur.keys()].filter((k) => citedMostly(serpCur.get(k)) && !citedMostly(serpBase.get(k))));
  const uncitedAio = (k: string): boolean => {
    const t = serpCur.get(k);
    return !!t && t.checks > 0 && t.aio / t.checks >= 0.5 && !citedMostly(t);
  };

  // ---- Cells (one load covers the fit window, the placebo windows and both analysis windows) ----
  const cellsFrom = windows.fit[0] < windows.placebo.pre1[0] ? windows.fit[0] : windows.placebo.pre1[0];
  const cellsAll: Cell[] = i.db.cells(cellsFrom, D);
  const curveCells: DatedCurveCell[] = [];
  for (const c of cellsAll) {
    if (!inWindow(c.date, windows.fit) || !(c.i > 0) || excludedPairs.has(`${c.q}|${c.dv}`)) continue;
    curveCells.push({ p: c.ps / c.i, c: c.c, i: c.i, seg: segmentOf(c.dv, brand.isBrand(c.q)), date: c.date });
  }
  const curve = fitCurve(curveCells, { fitWindow: windows.fit, holdoutFrom: windows.holdoutFrom });

  // ---- Waterfall (5.5) ----
  const wCells = cellsAll.filter((c) => c.date >= b0);
  const wPages = i.db.pageDaily(b0, D);
  const model = buildUnits({
    windows,
    cells: wCells,
    pageDaily: wPages,
    deviceDaily: i.db.siteDeviceDaily(b0, D),
    siteImpressions: { base: sumRange(impressions, padFrom, windows.baseline), cur: sumRange(impressions, padFrom, windows.current) },
    curve,
    isBrand: brand.isBrand,
    templates,
    flattening,
  });
  const units = decomposeUnits(model, curve);
  const idx = units.map((_, k) => k);
  const named = (k: number): boolean => units[k].key.query !== null;
  const scopeSpecs: ScopeSpec[] = [{ unit: { level: 'site', key: 'site', label: LABEL_SITE }, members: idx }];
  const group = (key: (k: number) => string | null): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const k of idx) {
      const g = key(k);
      if (g === null) continue;
      const list = m.get(g) ?? [];
      list.push(k);
      m.set(g, list);
    }
    return m;
  };
  const sumOf = (members: number[], f: (k: number) => number): number => members.reduce((a, k) => a + f(k), 0);
  const ranked = (m: Map<string, number[]>): [string, number[]][] =>
    [...m.entries()]
      .map(([k, mem]) => ({ k, mem, dc: Math.abs(sumOf(mem, (u) => units[u].cur.C - units[u].base.C)), di: Math.abs(sumOf(mem, (u) => units[u].cur.I - units[u].base.I)) }))
      .sort((a, b) => b.dc - a.dc || b.di - a.di || cmp(a.k, b.k))
      .map((x) => [x.k, x.mem]);
  for (const [k, mem] of [...group((u) => units[u].template).entries()].sort(([a], [b]) => cmp(a, b))) {
    scopeSpecs.push({ unit: { level: 'template', key: k, label: k }, members: mem });
  }
  const pageRank = ranked(group((u) => units[u].key.page));
  const queryRank = ranked(group((u) => units[u].key.query));
  for (const [k, mem] of pageRank.slice(0, TOP_SCOPES)) scopeSpecs.push({ unit: { level: 'page', key: k, label: unitLabel('page', k) }, members: mem });
  for (const [k, mem] of queryRank.slice(0, TOP_SCOPES)) scopeSpecs.push({ unit: { level: 'query', key: k, label: k }, members: mem });

  const B = bootstrapSize(cfg.analysis.bootstrap.waterfall, model.cellCount);
  const boots: ScopeBoot[] = units.length > 0
    ? bootstrapScopes(model, units, scopeSpecs, {
        B, curve, rng: rng('waterfall:redraw'), scopeRng: (sp) => rng(`waterfall:${sp.unit.level}:${sp.unit.key}`), phi: phiClicks,
      })
    : scopeSpecs.map(() => ({ ci95: {}, groupCi: { demand: [0, 0], ranking: [0, 0], samePos: [0, 0], aioCitation: [0, 0], churn: [0, 0] }, pTotal: 1 }) as ScopeBoot);
  const decomps: ScopeDecomposition[] = scopeSpecs.map((sp, k) => scopeDecomposition(sp, units, boots[k]));

  // ---- SERP candidates (5.11.1) and per-query samePos (for AIO apportioning) ----
  const serpCandidates: SerpCandidate[] = [];
  const samePosByQuery = new Map<string, number>();
  for (const [q, mem] of [...group((u) => units[u].key.query).entries()].sort(([a], [b]) => cmp(a, b))) {
    const byDev = new Map<Device, number[]>();
    for (const k of mem) {
      const dv = units[k].key.device as Device;
      const list = byDev.get(dv) ?? [];
      list.push(k);
      byDev.set(dv, list);
      samePosByQuery.set(`${q}|${dv}`, (samePosByQuery.get(`${q}|${dv}`) ?? 0) + units[k].bars.samePos);
    }
    const devs = [...byDev.entries()].sort((a, b) => sumOf(b[1], (k) => units[k].cur.I) - sumOf(a[1], (k) => units[k].cur.I) || cmp(a[0], b[0]));
    const [dv, list] = devs[0];
    const I = sumOf(list, (k) => units[k].cur.I);
    if (!(I >= SERP_MIN_IMPRESSIONS)) continue;
    const pbar = sumOf(list, (k) => (units[k].cur.pbar ?? 0) * units[k].cur.I) / I;
    if (pbar > SERP_MAX_POSITION) continue;
    serpCandidates.push({
      keyword: q, device: dv, pbar, impressions: I, expectedBaseClicks: sumOf(list, (k) => units[k].Eb),
      deltaClicks: sumOf(list, (k) => units[k].cur.C - units[k].base.C), pages: [...new Set(list.map((k) => units[k].key.page))].sort(),
    });
  }

  // ---- Change points (B) ----
  const cpN = diffDays(cpFrom, D) + 1;
  const series: Series[] = [];
  const seasonalValues: Record<string, { start: IsoDate; values: number[] }> = {};
  const addSeries = (id: string, unit: AnalysisUnit, metric: 'clicks' | 'impressions', full: number[], fullStart: IsoDate, o: { primary?: boolean; segmentsOf?: string; seasonal?: boolean } = {}): void => {
    const off = diffDays(fullStart, cpFrom);
    series.push({ id, unit, metric, start: cpFrom, values: full.slice(off, off + cpN), primary: !!o.primary, ...(o.segmentsOf ? { segmentsOf: o.segmentsOf } : {}) });
    if (o.seasonal !== false) seasonalValues[id] = { start: fullStart, values: full };
  };
  const siteUnit: AnalysisUnit = { level: 'site', key: 'site', label: LABEL_SITE };
  addSeries('site:clicks', siteUnit, 'clicks', clicks, padFrom, { primary: true });
  addSeries('site:impressions', siteUnit, 'impressions', impressions, padFrom, { primary: true });
  const devRows = i.db.siteDeviceDaily(padFrom, D);
  for (const dv of ['desktop', 'mobile'] as Device[]) {
    const rows = devRows.filter((r) => r.dv === dv);
    const unit: AnalysisUnit = { level: 'site', key: 'site', label: `${LABEL_SITE} (${dv})`, device: dv };
    addSeries(`site:clicks:${dv}`, unit, 'clicks', fill(padFrom, D, rows, 'c'), padFrom, { segmentsOf: 'site:clicks' });
    addSeries(`site:impressions:${dv}`, unit, 'impressions', fill(padFrom, D, rows, 'i'), padFrom, { segmentsOf: 'site:impressions' });
  }
  const cpCells = cellsAll.filter((c) => c.date >= cpFrom);
  for (const cls of ['brand', 'nonbrand'] as const) {
    const rows = cpCells.filter((c) => brand.isBrand(c.q) === (cls === 'brand'));
    const unit: AnalysisUnit = { level: 'query', key: `class:${cls}`, label: cls === 'brand' ? 'Brand searches' : 'Other searches' };
    addSeries(`${cls}:clicks`, unit, 'clicks', fill(cpFrom, D, rows, 'c'), cpFrom, { seasonal: false });
    addSeries(`${cls}:impressions`, unit, 'impressions', fill(cpFrom, D, rows, 'i'), cpFrom, { seasonal: false });
  }
  const pageHistory = i.db.pageDaily(padFrom, D);
  const byTemplate = new Map<string, { date: IsoDate; c: number; i: number }[]>();
  const byPage = new Map<string, { date: IsoDate; c: number; i: number }[]>();
  for (const r of pageHistory) {
    const t = templateOf(r.p);
    const tl = byTemplate.get(t) ?? [];
    tl.push(r);
    byTemplate.set(t, tl);
    const list = byPage.get(r.p) ?? [];
    list.push(r);
    byPage.set(r.p, list);
  }
  for (const [t, rows] of [...byTemplate.entries()].sort(([a], [b]) => cmp(a, b))) {
    const unit: AnalysisUnit = { level: 'template', key: t, label: t };
    addSeries(`tpl:${t}:clicks`, unit, 'clicks', fill(padFrom, D, rows, 'c'), padFrom, { segmentsOf: 'site:clicks' });
    addSeries(`tpl:${t}:impressions`, unit, 'impressions', fill(padFrom, D, rows, 'i'), padFrom, { segmentsOf: 'site:impressions' });
  }
  const topPages = [...byPage.entries()]
    .map(([p, rows]) => ({ p, rows, c: rows.filter((r) => inWindow(r.date, windows.baseline)).reduce((a, r) => a + r.c, 0), im: rows.filter((r) => inWindow(r.date, windows.baseline)).reduce((a, r) => a + r.i, 0) }))
    .sort((a, b) => b.c - a.c || b.im - a.im || cmp(a.p, b.p))
    .slice(0, TOP_CP_PAGES);
  for (const { p, rows } of topPages) {
    const unit: AnalysisUnit = { level: 'page', key: p, label: unitLabel('page', p) };
    addSeries(`page:${p}:clicks`, unit, 'clicks', fill(padFrom, D, rows, 'c'), padFrom);
    addSeries(`page:${p}:impressions`, unit, 'impressions', fill(padFrom, D, rows, 'i'), padFrom);
  }
  const cpOut = optional('analyzeChangePoints', skipped, () => analyzeChangePoints({
    series, dow, events, dataThrough: D, historyStart, seasonalValues, fdrQ, delta: DEFAULT_DELTA.changepoint,
  }), { changePoints: [] as ChangePoint[], findings: [] as Finding[], dispersion: {} });

  // ---- Scorecard (B) ----
  const histOff = diffDays(padFrom, historyStart);
  const score = optional('buildScorecard', skipped, () => buildScorecard({
    clicks: clicks.slice(histOff), impressions: impressions.slice(histOff), start: historyStart, dow,
    phi: { clicks: phiClicks, impressions: phiImpr }, events, dataThrough: D, siteChanges: i.siteChanges, delta: DEFAULT_DELTA.site, fdrQ,
  }), { rows: [] as UpdateRow[], findings: [] as Finding[] });

  // ---- Snapshots: titles, links over time, first snapshot ----
  const fieldsByHash = i.db.fieldsByHash();
  const snaps = i.db.snapshots().filter((r) => (r.outcome === 'ok' || r.outcome === 'not_modified') && r.fieldsHash);
  const snapsByUrl = new Map<string, { at: string; hash: string }[]>();
  for (const r of snaps) {
    const list = snapsByUrl.get(r.url) ?? [];
    list.push({ at: r.fetchedAt, hash: r.fieldsHash as string });
    snapsByUrl.set(r.url, list);
  }
  const firstSnapshot = snaps.length ? ptDate(snaps.map((r) => r.fetchedAt).sort(cmp)[0]) : null;
  const pageTitles = new Map<string, string>();
  for (const [u, list] of snapsByUrl) {
    const title = fieldsByHash.get(list[list.length - 1].hash)?.title;
    if (title) pageTitles.set(u, title);
  }
  const linksBefore = (url: string, at: string): string[] => {
    const list = snapsByUrl.get(url) ?? [];
    let hit: string | null = null;
    for (const s2 of list) if (s2.at <= at) hit = s2.hash;
    return hit ? [...(fieldsByHash.get(hit)?.internalLinks ?? [])] : [];
  };

  // ---- Site changes and index states (C) ----
  let siteChangeImpacts: SiteChangeImpact[] = [];
  let siteChangeFindings: Finding[] = [];
  if (i.siteChanges.length > 0) {
    const earliest = i.siteChanges.map((c) => ptDate(c.deployed.from)).sort(cmp)[0];
    let spanFrom = addDays(earliest, -70);
    if (spanFrom < historyStart) spanFrom = historyStart;
    const scCells = spanFrom >= cellsFrom ? cellsAll.filter((c) => c.date >= spanFrom) : i.db.cells(spanFrom, D);
    const out = optional('analyzeSiteChanges', skipped, () => analyzeSiteChanges({
      changes: i.siteChanges, pageDaily: pageHistory.filter((r) => r.date >= spanFrom), cells: scCells, curve, isBrand: brand.isBrand, templates,
      linksBefore, events, demandK: model.demandK, dataThrough: D, rng: (key) => rng(`sitechange:${key}`), delta: DEFAULT_DELTA.siteChange,
      bootstrap: cfg.analysis.bootstrap.did, fdrQ,
    }), { impacts: [] as SiteChangeImpact[], findings: [] as Finding[] });
    siteChangeImpacts = out.impacts;
    siteChangeFindings = out.findings;
  }
  const indexFindings = optional('analyzeIndexStates', skipped, () => analyzeIndexStates({ inspections: i.db.inspections(), dataThrough: D }), [] as Finding[]);

  // ---- AI Overviews (D) ----
  let aio: AioOutput | null = null;
  if (serp.length > 0) {
    aio = optional('analyzeAio', skipped, () => analyzeAio({
      serp, cells: cellsAll.filter((c) => c.date >= windows.placebo.pre1[0]), curve, isBrand: brand.isBrand, windows, siteDomain: i.siteDomain,
      pageTitles, samePosByQuery, rng: (key) => rng(`aio:${key}`), delta: DEFAULT_DELTA.aio, bootstrap: cfg.analysis.bootstrap.aio, fdrQ,
    }), null);
  }
  const did = aio?.estimates.find((e) => e.estimator === 'did') ?? null;

  // ---- Synthesis (5.12) ----
  const ctx: SynthesisContext = {
    dataThrough: D, windows, windowDays: L, events, changePoints: cpOut.changePoints, siteChanges: i.siteChanges, siteChangeImpacts,
    impactFindingIds: new Map(siteChangeImpacts.map((x) => [x.siteChangeId, x.findingId])),
    impactSlots: new Map(siteChangeImpacts.map((x) => [x.siteChangeId, siteChangeFindings.find((f) => f.id === x.findingId)?.slots ?? {}])),
    aioDidSignal: did?.real === 'signal',
    aioDid: did ? { tau: did.tau, ci95: did.ci95 } : null, firstSnapshot,
    gscPartition: layout.gscDay(D, i.db.revisions().find((r) => r.day === D)?.revision ?? 1),
    costPerCheck: cfg.serp.provider === 'dataforseo' ? cfg.serp.costPerCheckUsd : 0.0012,
  };
  const cpKey = (u: AnalysisUnit, d: IsoDate | null): string => `${u.level}|${u.key}|${u.device ?? ''}|${d ?? ''}`;
  const cpFindingByUnitDate = new Map<string, string>(cpOut.findings.map((f) => [cpKey(f.unit, f.date), f.id]));
  const cpFindingIds = new Map<string, string>();
  for (const c of cpOut.changePoints) {
    const id = cpFindingByUnitDate.get(cpKey(c.unit, c.date));
    if (id) cpFindingIds.set(`${c.seriesId}|${c.date}`, id);
  }

  // Seasonal impressions per page and template (for the yoy slot and the seasonal alternative).
  const lastYear = new Map<string, { b: number; c: number }>();
  if (windows.seasonal) {
    for (const r of pageHistory) {
      const which = inWindow(r.date, windows.seasonal.baseline) ? 'b' : inWindow(r.date, windows.seasonal.current) ? 'c' : null;
      if (!which) continue;
      const acc = lastYear.get(r.p) ?? { b: 0, c: 0 };
      acc[which] += r.i;
      lastYear.set(r.p, acc);
    }
  }
  const yoyOf = (members: number[], level: AnalysisUnit['level']): number | null => {
    if (!windows.seasonal || level === 'query') return null;
    let before = 0;
    let after = 0;
    if (level === 'site') {
      before = sumRange(impressions, padFrom, windows.seasonal.baseline);
      after = sumRange(impressions, padFrom, windows.seasonal.current);
    } else {
      for (const p of new Set(members.map((k) => units[k].key.page))) {
        before += lastYear.get(p)?.b ?? 0;
        after += lastYear.get(p)?.c ?? 0;
      }
    }
    return before > 0 ? after / before - 1 : null;
  };

  const facts: ScopeFacts[] = scopeSpecs.map((sp, k) => {
    const d = decomps[k];
    const mem = sp.members;
    const nm = mem.filter(named);
    const Ib = sumOf(mem, (u) => units[u].base.I);
    const Ic = sumOf(mem, (u) => units[u].cur.I);
    const nIb = sumOf(nm, (u) => units[u].base.I);
    const nIc = sumOf(nm, (u) => units[u].cur.I);
    const posB = nIb > 0 ? sumOf(nm, (u) => (units[u].base.pbar ?? 0) * units[u].base.I) / nIb : null;
    const posC = nIc > 0 ? sumOf(nm, (u) => (units[u].cur.pbar ?? 0) * units[u].cur.I) / nIc : null;
    // Same-spot movement in the direction of the scope's change (a loss in a drop, a gain in a rise).
    const sameWay = (u: number): number => Math.max(0, (d.deltaClicks < 0 ? -1 : 1) * units[u].bars.samePos);
    const negLoss = sumOf(mem, sameWay);
    const share = (pred: (u: number) => boolean): number => (negLoss > 0 ? sumOf(nm.filter(pred), sameWay) / negLoss : 0);
    const qKey = (u: number): string => `${units[u].key.query}|${units[u].key.device}`;
    const queries = [...new Set(nm.map((u) => units[u].key.query as string))];
    const checkedQ = new Set(nm.filter((u) => checkedKeywords.has(units[u].key.query as string)).map((u) => units[u].key.query));
    const aioQ = new Set(nm.filter((u) => aioKeywords.has(units[u].key.query as string)).map((u) => units[u].key.query));
    const down = d.deltaClicks < 0;
    const moved = queries.filter((q) => {
      const qs = nm.filter((u) => units[u].key.query === q);
      const ib = sumOf(qs, (u) => units[u].base.I);
      const ic = sumOf(qs, (u) => units[u].cur.I);
      if (!(ib > 0) || !(ic > 0)) return false;
      const pb = sumOf(qs, (u) => (units[u].base.pbar ?? 0) * units[u].base.I) / ib;
      const pc = sumOf(qs, (u) => (units[u].cur.pbar ?? 0) * units[u].cur.I) / ic;
      return down ? pc >= pb + 0.5 : pc <= pb - 0.5;
    }).length;
    const curveMass = sumOf(mem, (u) => Math.abs(units[u].bars.rank) + Math.abs(units[u].bars.samePos));
    const unstableMass = sumOf(mem.filter((u) => units[u].flags.includes('curve_unstable')), (u) => Math.abs(units[u].bars.rank) + Math.abs(units[u].bars.samePos));
    const pages = new Set(mem.map((u) => units[u].key.page));
    const pageDelta = new Map<string, number>();
    for (const u of mem) pageDelta.set(units[u].key.page, (pageDelta.get(units[u].key.page) ?? 0) + units[u].cur.C - units[u].base.C);
    const movedPages = new Set([...pageDelta].filter(([, dc]) => (d.deltaClicks < 0 ? dc < 0 : d.deltaClicks > 0 && dc > 0)).map(([p]) => p));
    const top = topSegmentOf(sp.unit.level, mem);
    const impTau = Ib > 0 ? Ic / Ib - 1 : 0;
    let imprVerdict: Verdict = 'underpowered';
    let imprReason: VerdictReason = Ib >= 1000 ? 'wide_ci' : 'floors';
    if (Ib > 0 && Ic > 0) {
      const se = Math.sqrt(phiImpr * (1 / Ib + 1 / Ic) + imprExtraVar);
      const lr = Math.log(Ic / Ib);
      const iv = decideVerdict({
        estimate: impTau, ci95: [Math.exp(lr - 1.96 * se) - 1, Math.exp(lr + 1.96 * se) - 1], floorsMet: Ib >= 1000, identification: [],
        q: 2 * normalCdf(-Math.abs(lr) / se), delta: deltaFor(sp.unit.level), fdrQ, weeksObserved: L / 7,
      });
      imprVerdict = iv.verdict;
      imprReason = iv.reason;
    }
    return {
      unit: sp.unit, decomposition: d, groupCi: boots[k]?.groupCi ?? null, pages, movedPages, baseImpressions: Ib, curImpressions: Ic, pb: posB, pc: posC,
      ctrB: nIb > 0 ? sumOf(nm, (u) => units[u].base.C) / nIb : null, ctrC: nIc > 0 ? sumOf(nm, (u) => units[u].cur.C) / nIc : null,
      movedSearches: moved, checkedShare: share((u) => checkedKeywords.has(units[u].key.query as string)), aioUncitedShare: share((u) => uncitedAio(qKey(u))),
      checkedQueries: checkedQ.size, aioQueries: aioQ.size,
      candidates: serpCandidates.filter((c) => (sp.unit.level === 'query' ? c.keyword === sp.unit.key : c.pages.some((p) => pages.has(p)))).length,
      kFallback: mem.some((u) => units[u].flags.includes('k_fallback')), unstableShare: curveMass > 0 ? unstableMass / curveMass : 0,
      topSegment: top, yoy: yoyOf(mem, sp.unit.level), p: d.pTotal, q: null,
      // The waterfall is a claim about clicks, so its floor is clicks (5.8): the 1,000-impression
      // alternative is for impression claims only, which have their own verdict above.
      floorsMet: sp.unit.level === 'query' ? sumOf(nm, (u) => units[u].Eb) >= 30 : d.baseClicks >= 30,
      delta: deltaFor(sp.unit.level), phi: phiClicks, impressions: { tau: impTau, real: imprVerdict, reason: imprReason },
    };
  });

  function topSegmentOf(level: AnalysisUnit['level'], mem: number[]): string {
    const by = (key: (u: number) => string): string => {
      const m = new Map<string, number>();
      for (const u of mem) m.set(key(u), (m.get(key(u)) ?? 0) + units[u].cur.C - units[u].base.C);
      return [...m.entries()].sort((a, b) => a[1] - b[1] || cmp(a[0], b[0]))[0]?.[0] ?? '';
    };
    if (level === 'site') return by((u) => units[u].template);
    if (level === 'template' || level === 'query') return pathOf(by((u) => units[u].key.page));
    return by((u) => units[u].key.query ?? 'unattributed searches');
  }

  // BH family 2: template, page and query scope totals that met their floors.
  const family = facts.map((f, k) => (f.unit.level !== 'site' && f.floorsMet && f.p !== null ? k : -1)).filter((k) => k >= 0);
  const qs = benjaminiHochberg(family.map((k) => facts[k].p as number));
  family.forEach((k, j) => (facts[k].q = qs[j]));

  const scopeFindings: Finding[] = [];
  let underpoweredUnits = 0;
  const findingsFor = new Set<number>();
  facts.forEach((f, k) => {
    if (f.unit.level === 'template') findingsFor.add(k);
  });
  const pageKeys = new Set(pageRank.slice(0, TOP_FINDINGS).map(([p]) => p));
  const queryKeys = new Set(queryRank.slice(0, TOP_FINDINGS).map(([q]) => q));
  facts.forEach((f, k) => {
    if ((f.unit.level === 'page' && pageKeys.has(f.unit.key)) || (f.unit.level === 'query' && queryKeys.has(f.unit.key))) findingsFor.add(k);
  });
  let siteCause = null as ReturnType<typeof causeForScope> | null;
  facts.forEach((f, k) => {
    const cause = causeForScope(f, ctx);
    if (f.unit.level === 'site') {
      siteCause = cause;
      return;
    }
    const d = f.decomposition;
    const est = d.baseClicks > 0 ? d.deltaClicks / d.baseClicks : null;
    // As a share of the baseline; clicks can't fall by more than all of them, so the range stops at -100%.
    const ci = est !== null && d.ci95?.total
      ? ([Math.max(-1, d.ci95.total[0] / d.baseClicks), Math.max(-1, d.ci95.total[1] / d.baseClicks)] as [number, number])
      : null;
    const identification: IdCheck[] = cause.usesCurve && f.unstableShare >= 0.5 ? [{ name: 'curve_unstable', passed: false, detail: curve.unstable.join(',') }] : [];
    const r = decideVerdict({
      estimate: est ?? 0, ci95: ci, floorsMet: f.floorsMet, identification, q: f.q, delta: f.delta, fdrQ, weeksObserved: L / 7,
      counts: { pre: d.baseClicks, post: d.curClicks, phi: phiClicks },
    });
    if (r.verdict === 'underpowered') underpoweredUnits++;
    if (!findingsFor.has(k)) return;
    const v: ScopeVerdict = { real: r.verdict, reason: r.reason, power: r.power, failed: r.failed, estimate: est, ci95: ci, freq: null };
    scopeFindings.push(scopeFinding(f, v, cause, ctx, {
      kind: 'waterfall', id: findingId(['waterfall', f.unit.level, f.unit.key, b0, D]), B, cpFindingIds, measurementCap: touchesWindows,
    }));
  });
  // The headline's "impressions, which have far more data" sentence uses the headline impressions comparison.
  const site: ScopeFacts = { ...facts[0], impressions: { tau: hImpr.tau, real: hImpr.real, reason: hImpr.reason } };
  const headline = headlineFinding(site, hClicks, hImpr, siteCause ?? causeForScope(site, ctx), ctx, { B, cpFindingIds, measurementCap: false });

  // ---- Notices ----
  const namedShare = decomps[0]?.namedClickShare ?? 0;
  const provisional = range.provisionalThrough;
  const notices: Finding[] = [
    noticeFinding('coverage', { hidden: 1 - namedShare, shown: namedShare }, ctx),
    // No day count: it would come from the provisional tail in state/, which is not an input
    // (D24), so findings.json would change when state/ is cleared. The run summary prints the
    // live count instead.
    noticeFinding('freshness', { date: D }, ctx),
  ];
  if (i.siteChanges.length === 0) notices.push(noticeFinding('no_site_changes', {}, ctx));

  // ---- Collect, cap, prioritise, sort ----
  const aioFindings = aio?.findings ?? [];
  const aioFacts = aioFindings.filter((f) => f.kind === 'aio_fact').map((f) => ({ ...f, priority: findingPriority(f) }));
  const keptFacts = sortFindings(aioFacts).slice(0, AIO_FACT_CAP);
  const all = [
    headline, ...scopeFindings, ...cpOut.findings, ...score.findings, ...aioFindings.filter((f) => f.kind !== 'aio_fact'), ...keptFacts,
    ...siteChangeFindings, ...indexFindings, ...notices,
  ];
  const seen = new Set<string>();
  const findings = sortFindings(all.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).map((f) => ({ ...f, priority: findingPriority(f) })));

  // "New" means first reported for this data day or later. The pipeline saves each run's findings
  // with meta.day = dataThrough, so re-analysing the same data (why, run --offline, a second run the
  // same day) finds those ids already in the history; counting them as old there would flip
  // `boring` between identical runs. An AI Overview seen on a search is a record, not a change in
  // traffic, so it never makes a run interesting on its own (index transitions still do).
  const history = i.db.findingsHistory();
  const cpSignalInCurrent = cpOut.findings.some((f) => f.real === 'signal' && f.date !== null && f.date >= c0 && f.date <= D);
  const isNew = (id: string): boolean => {
    const h = history.get(id);
    return !h || h.firstReported >= D;
  };
  const newSignal = findings.some((f) => f.real === 'signal' && f.kind !== 'headline' && f.kind !== 'aio_fact' && isNew(f.id));
  const boring = hClicks.real === 'noise' && (hImpr.real === 'noise' || hImpr.real === 'underpowered') && !cpSignalInCurrent && !newSignal;

  const homepage = pickHomepage(units, i.property);
  const curCells = cellsAll.filter((c) => c.date >= c0);
  const sealedThrough = i.db.siteDaily(historyStart, D);
  const output: AnalysisOutput = {
    schemaVersion: 1,
    property: i.property,
    siteDomain: i.siteDomain,
    dataThrough: D,
    windows,
    inputsHash,
    headline: { clicks: hClicks, impressions: hImpr, findingId: headline.id, boring },
    findings,
    scopes: decomps,
    changePoints: cpOut.changePoints,
    scorecard: score.rows,
    siteChangeImpacts,
    siteChanges: i.siteChanges,
    aio,
    curve: { m: curve.m, unstable: [...curve.unstable], bins: curve.bins, fitWindow: curve.fitWindow },
    serpCandidates,
    timeline: {
      sealed: sealedThrough,
      provisional: provisional ? i.db.siteDaily(addDays(D, 1), provisional, { provisional: true }) : ([] as DayTotal[]),
    },
    templates: Object.fromEntries([...templates.entries()].sort(([a], [b]) => cmp(a, b))),
    diagnostics: {
      namedClickShare: namedShare,
      reconciliation: {
        byPageClicks: wPages.reduce((a, r) => a + r.c, 0),
        byPropertyClicks: sumRange(clicks, padFrom, [b0, D]),
      },
      truncatedDays: i.db.truncatedDays(),
      revisions: i.db.revisions().filter((r) => r.revision > 1).length,
      underpoweredUnits,
      measurementEvents: measurement.map((e) => e.id).sort(),
      bootstrapB: { waterfall: B, aio: cfg.analysis.bootstrap.aio, did: cfg.analysis.bootstrap.did },
      brandTokens: brand.tokens,
      brandSuggestions: brand.suggestions(curCells, curve, homepage),
      historyDays: range.first ? diffDays(range.first, D) + 1 : 0,
    },
  };
  return { output, skipped };
}

function deltaFor(level: AnalysisUnit['level']): number {
  return level === 'site' ? DEFAULT_DELTA.site : level === 'template' ? DEFAULT_DELTA.template : level === 'page' ? DEFAULT_DELTA.page : DEFAULT_DELTA.query;
}

function pickHomepage(units: { key: { page: string }; cur: { I: number } }[], property: string): string {
  const roots = new Map<string, number>();
  for (const u of units) if (pathOf(u.key.page) === '/') roots.set(u.key.page, (roots.get(u.key.page) ?? 0) + u.cur.I);
  const best = [...roots.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
  return best ? best[0] : (defaultOrigins(property)[0] ?? '');
}

