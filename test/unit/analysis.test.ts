// runAnalysis over memoryIndex fixtures: determinism, the waterfall invariant for every scope, ordering,
// notices and diagnostics (spec 5.12, 9.2 WP-E acceptance). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { sha256Hex } from '../../src/core/ids.js';
import { addDays, dateRange, weekday } from '../../src/core/time.js';
import type { AnalysisInput, AnalysisOutput, Cell, Config, DayTotal, Device, GoogleEvent, PageDay, TemplateId } from '../../src/core/types.js';
import { runAnalysis, runAnalysisDetailed } from '../../src/analyze/index.js';
import { renderReports } from '../../src/report/html.js';
import { barsTotal } from '../../src/analyze/waterfall.js';
import { binomialOne, memoryIndex, poissonOne, testRng } from '../helpers/index.js';

const PROPERTY = 'sc-domain:acme-heating.example';
const ORIGIN = 'https://acme-heating.example/';
const D = '2026-10-03';
const START = addDays(D, -159);
const CURRENT_START = addDays(D, -27);
const DOW = [1.08, 1.1, 1.08, 1.04, 0.97, 0.82, 0.91];

const TEMPLATE_IDS: TemplateId[] = [
  'headline', 'boring', 'real_google', 'real_google_no_changes', 'real_site_change', 'demand', 'ranking', 'aio_not_cited', 'aio_cited',
  'aio_flattening', 'same_spot_unchecked', 'same_spot_checked', 'noise', 'not_enough_data', 'cause_unknown', 'cant_separate', 'mixed',
  'reporting_artefact', 'too_recent', 'no_site_changes', 'before_recording', 'site_change_unseen', 'index_change', 'update_row',
  'change_point', 'gradual', 'aio_fact', 'coverage', 'freshness',
];

interface Site { t: DayTotal[]; td: { date: string; dv: Device; c: number; i: number; ps: number }[]; p: PageDay[]; qpd: Cell[]; events: GoogleEvent[] }

/** A small made-up heating site: a homepage with brand searches, 8 guides and 6 products. Guides lose 40% of clicks at the same position in the current window. */
function synthSite(seed = 'analysis:site', guideHit = 0.6): Site {
  const rng = testRng(seed);
  const pages = [
    { url: ORIGIN, qs: ['acme heating', 'acme heating reviews', 'acme boilers'], imp: 40, pos: 1.1, brand: true },
    ...Array.from({ length: 8 }, (_, k) => ({ url: `${ORIGIN}guides/guide-${k}`, qs: [`how to fix boiler ${k}`, `boiler guide ${k}`, `heating tips ${k}`], imp: 30, pos: 3 + (k % 4), brand: false })),
    ...Array.from({ length: 6 }, (_, k) => ({ url: `${ORIGIN}products/product-${k}`, qs: [`buy radiator ${k}`, `radiator price ${k}`], imp: 20, pos: 5 + (k % 3), brand: false })),
  ];
  const site: Site = { t: [], td: [], p: [], qpd: [], events: [] };
  for (const date of dateRange(START, D)) {
    const dow = DOW[weekday(date)];
    const dev = { desktop: { c: 0, i: 0, ps: 0 }, mobile: { c: 0, i: 0, ps: 0 } };
    for (const pg of pages) {
      let pc = 0;
      let pi = 0;
      let pps = 0;
      const hit = pg.url.includes('/guides/') && date >= CURRENT_START ? guideHit : 1;
      for (const q of pg.qs) {
        for (const dv of ['desktop', 'mobile'] as Device[]) {
          const i = poissonOne(rng, pg.imp * dow * (dv === 'desktop' ? 0.6 : 0.4));
          if (i === 0) continue;
          const pos = pg.pos * Math.exp(0.05 * (rng() - 0.5));
          const ctr = Math.min(0.8, (pg.brand ? 0.6 * pos ** -0.8 : 0.3 * pos ** -1.15) * (dv === 'mobile' ? 0.85 : 1) * hit);
          const c = binomialOne(rng, i, ctr);
          site.qpd.push({ date, q, p: pg.url, dv, c, i, ps: pos * i });
          pc += c;
          pi += i;
          pps += pos * i;
          dev[dv].c += c;
          dev[dv].i += i;
          dev[dv].ps += pos * i;
        }
      }
      const hi = poissonOne(rng, Math.max(2, pi) * 0.5);
      const hc = binomialOne(rng, hi, 0.03 * hit);
      site.p.push({ date, p: pg.url, c: pc + hc, i: pi + hi, ps: pps + hi * 8 });
      dev.desktop.c += hc;
      dev.desktop.i += hi;
      dev.desktop.ps += hi * 8;
    }
    for (const dv of ['desktop', 'mobile'] as Device[]) site.td.push({ date, dv, ...dev[dv] });
    site.t.push({ date, c: dev.desktop.c + dev.mobile.c, i: dev.desktop.i + dev.mobile.i, ps: dev.desktop.ps + dev.mobile.ps });
  }
  site.events = [{
    id: 'core-1', source: 'seed', service: 'Ranking', kind: 'core', title: 'June 2026 core update', begin: '2026-06-02T16:00:00Z',
    end: '2026-06-16T16:00:00Z', endEstimated: false, url: null, modified: null,
  }];
  return site;
}

function config(): Config {
  const c = defaultConfig(PROPERTY);
  return { ...c, analysis: { ...c.analysis, bootstrap: { waterfall: 200, aio: 200, did: 200 } } };
}

function input(site: Site, extra: Partial<Parameters<typeof memoryIndex>[0]> = {}): AnalysisInput {
  return {
    property: PROPERTY, siteDomain: 'acme-heating.example', dataThrough: D, config: config(), siteChanges: [], siteName: 'Acme Heating',
    db: memoryIndex({
      property: PROPERTY, t: site.t, td: site.td, p: site.p, qpd: site.qpd, events: site.events, freshT: [{ date: '2026-10-04', c: 3, i: 90, ps: 500 }],
      ...extra,
    }),
  };
}

describe('runAnalysis over a memory index', () => {
  const site = synthSite();
  const out: AnalysisOutput = runAnalysis(input(site));

  it('is deterministic: two calls give deep-equal output', () => {
    expect(runAnalysis(input(site))).toEqual(out);
  }, 60_000);

  it('keeps the waterfall invariant for every scope, and the site scope covers every page click', () => {
    expect(out.scopes[0].unit).toEqual({ level: 'site', key: 'site', label: 'Whole site' });
    for (const s of out.scopes) {
      expect(Math.abs(barsTotal(s.bars) - s.deltaClicks)).toBeLessThan(1e-6);
      expect(s.ci95?.total).toBeDefined();
      expect(s.pTotal).toBeGreaterThan(0);
    }
    const inWin = (d: string, w: [string, string]): boolean => d >= w[0] && d <= w[1];
    const pBase = site.p.filter((r) => inWin(r.date, out.windows.baseline)).reduce((a, r) => a + r.c, 0);
    const pCur = site.p.filter((r) => inWin(r.date, out.windows.current)).reduce((a, r) => a + r.c, 0);
    expect(out.scopes[0].baseClicks).toBe(pBase);
    expect(out.scopes[0].curClicks).toBe(pCur);
    expect(out.diagnostics.reconciliation.byPageClicks).toBe(pBase + pCur);
    expect(out.diagnostics.reconciliation.byPropertyClicks).toBe(pBase + pCur);
    const levels = out.scopes.map((s) => s.unit.level);
    expect(levels.filter((l) => l === 'template').length).toBeGreaterThanOrEqual(2);
    expect(levels.filter((l) => l === 'page').length).toBeLessThanOrEqual(50);
    expect(levels.filter((l) => l === 'query').length).toBeLessThanOrEqual(50);
  });

  it('sorts findings by priority then id, with the headline first and the notices present', () => {
    const ids = out.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let k = 1; k < out.findings.length; k++) {
      const a = out.findings[k - 1];
      const b = out.findings[k];
      expect(a.priority > b.priority || (a.priority === b.priority && a.id < b.id)).toBe(true);
    }
    expect(out.findings[0]).toMatchObject({ kind: 'headline', priority: 1e9, id: out.headline.findingId });
    expect(out.findings[0].slots).toMatchObject({ days: 28, clicks: out.headline.clicks.post, abs: Math.abs(out.headline.clicks.post - out.headline.clicks.pre) });
    const notices = out.findings.filter((f) => f.kind === 'notice').map((f) => f.template).sort();
    expect(notices).toEqual(['coverage', 'freshness', 'no_site_changes']);
    const coverage = out.findings.find((f) => f.template === 'coverage');
    expect(Number(coverage?.slots.hidden) + Number(coverage?.slots.shown)).toBeCloseTo(1, 12);
    // No day count: it would come from the provisional tail in state/, which is not an input (D24).
    expect(out.findings.find((f) => f.template === 'freshness')?.slots).toEqual({ date: D });
    for (const f of out.findings) {
      expect(TEMPLATE_IDS).toContain(f.template);
      for (const v of Object.values(f.slots)) expect(typeof v === 'string' || Number.isFinite(v)).toBe(true);
    }
  });

  it('finds the planted same-position drop on the guides', () => {
    const guides = out.findings.find((f) => f.kind === 'waterfall' && f.unit.key === '/guides/*');
    expect(guides).toBeDefined();
    expect(guides?.real).toBe('signal');
    expect(guides?.cause).toBe('ctr_serp');
    expect(guides?.template).toBe('same_spot_unchecked');
    expect(guides?.components?.samePos).toBeLessThan(0);
    expect(Math.abs(guides!.components!.samePos)).toBeGreaterThan(Math.abs(guides!.components!.demand));
    expect(guides?.alternatives.map((a) => a.key)).toEqual(expect.arrayContaining(['demand_ruled_out', 'rank_ruled_out', 'aio_not_checked']));
    expect(guides?.falsifier.key).toBe('aio_disappears');
    expect(guides?.verify).toEqual({ from: out.windows.baseline[0], to: D });
  });

  it('records diagnostics, windows and the inputs hash', () => {
    expect(out.windows.seasonal).toBeNull();
    expect(out.dataThrough).toBe(D);
    expect(out.diagnostics.historyDays).toBe(160);
    expect(out.diagnostics.bootstrapB.waterfall).toBe(200);
    expect(out.diagnostics.brandTokens).toEqual(['acmeheating']);
    expect(out.diagnostics.namedClickShare).toBeGreaterThan(0.5);
    expect(out.diagnostics.namedClickShare).toBeLessThan(1);
    expect(out.timeline.sealed.length).toBe(160);
    expect(out.timeline.provisional).toEqual([{ date: '2026-10-04', c: 3, i: 90, ps: 500 }]);
    expect(out.curve.fitWindow).toEqual(out.windows.fit);
    expect(out.templates[`${ORIGIN}guides/guide-0`]).toBe('/guides/*');
    expect(out.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    const partitions = input(site).db.partitionsUsed().sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(out.inputsHash).toBe(sha256Hex(partitions.map((p) => `${p.path}\t${p.sha256}`).join('\n')));
    // Different data, different hash and different random streams.
    expect(runAnalysis(input(synthSite('analysis:other', 1))).inputsHash).not.toBe(out.inputsHash);
  }, 60_000);

  it('lists SERP candidates within position 20 and 10 impressions, sorted by keyword', () => {
    expect(out.serpCandidates.length).toBeGreaterThan(10);
    for (const c of out.serpCandidates) {
      expect(c.pbar).toBeLessThanOrEqual(20);
      expect(c.impressions).toBeGreaterThanOrEqual(10);
    }
    const kws = out.serpCandidates.map((c) => c.keyword);
    expect([...kws].sort()).toEqual(kws);
  });

  it('48. the same inputs give byte-identical findings.json (rendered by report/json.ts)', () => {
    const ctx = { toolVersion: '0.1.0', config: config(), run: null, demo: false };
    const a = renderReports(runAnalysis(input(site)), ctx).json;
    const b = renderReports(runAnalysis(input(site)), ctx).json;
    expect(a.length).toBeGreaterThan(1000);
    expect(b).toBe(a);
    expect(JSON.parse(a).inputs_hash).toBe(out.inputsHash);
  }, 60_000);

  it('gives the same findings.json without the provisional tail (state/ cleared, 10.3 step 7)', () => {
    // Found on the real property: the freshness notice counted provisional days from
    // state/gsc-fresh.ndjson.gz, so deleting state/ changed one sentence in findings.json.
    const ctx = { toolVersion: '0.1.0', config: config(), run: null, demo: false };
    const withTail = renderReports(runAnalysis(input(site)), ctx).json;
    const noTail = renderReports(runAnalysis(input(site, { freshT: [], freshTd: [] })), ctx).json;
    expect(noTail).toBe(withTail);
  }, 60_000);

  it('reports which analyzers were skipped (none, once every package has landed)', () => {
    const { skipped } = runAnalysisDetailed(input(site));
    expect(Array.isArray(skipped)).toBe(true);
  }, 60_000);
});

describe('runAnalysis edge cases', () => {
  it('runs on an empty index: everything is "not enough data"', () => {
    const out = runAnalysis({
      property: PROPERTY, siteDomain: 'acme-heating.example', dataThrough: D, config: config(), siteChanges: [], siteName: null,
      db: memoryIndex({ property: PROPERTY }),
    });
    expect(out.headline.clicks.real).toBe('underpowered');
    expect(out.headline.boring).toBe(false);
    expect(out.scopes).toHaveLength(1);
    expect(out.scopes[0]).toMatchObject({ baseClicks: 0, curClicks: 0, deltaClicks: 0, units: 0 });
    expect(out.findings[0]).toMatchObject({ kind: 'headline', template: 'not_enough_data' });
    expect(out.diagnostics.historyDays).toBe(0);
  }, 60_000);

  it('runs on a history shorter than the two windows', () => {
    const site = synthSite('analysis:short');
    const keep = <T extends { date: string }>(rows: T[]): T[] => rows.filter((r) => r.date >= addDays(D, -20));
    const out = runAnalysis({
      property: PROPERTY, siteDomain: 'acme-heating.example', dataThrough: D, config: config(), siteChanges: [], siteName: null,
      db: memoryIndex({ property: PROPERTY, t: keep(site.t), td: keep(site.td), p: keep(site.p), qpd: keep(site.qpd) }),
    });
    expect(out.headline.clicks.floorsMet).toBe(false);
    expect(out.headline.clicks.real).toBe('underpowered');
    expect(out.diagnostics.historyDays).toBe(21);
    for (const s of out.scopes) expect(Math.abs(barsTotal(s.bars) - s.deltaClicks)).toBeLessThan(1e-6);
  }, 60_000);
});

describe('headline.boring across re-runs of the same data', () => {
  // A quiet site (guides -10%, inside normal wobble) whose only news is one page leaving Google's
  // index: a new signal, so the run is not boring. The pipeline then saves the findings with
  // meta.day = dataThrough; analysing the same data again must not call it boring.
  const site = synthSite('analysis:boring', 0.9);
  const page = `${ORIGIN}guides/guide-1`;
  const inspections = [
    { url: page, inspectedAt: '2026-09-20T10:00:00Z', reason: 'traffic' as const, verdict: 'PASS', coverageState: 'Submitted and indexed' },
    { url: page, inspectedAt: '2026-10-01T10:00:00Z', reason: 'traffic' as const, verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' },
  ];
  const first = runAnalysis(input(site, { inspections }));

  it('is not boring the first time a real change is reported', () => {
    expect(first.headline.clicks.real).toBe('noise');
    expect(first.findings.some((f) => f.kind === 'index_transition' && f.real === 'signal')).toBe(true);
    expect(first.headline.boring).toBe(false);
  });

  it('gives the same answer and the same findings.json when the same data day is analysed again', () => {
    const again = runAnalysis(input(site, { inspections, findings: [{ reportedOn: D, findings: first.findings }] }));
    expect(again.headline.boring).toBe(first.headline.boring);
    const ctx = { toolVersion: '0.1.0', config: config(), run: null, demo: false };
    expect(renderReports(again, ctx).json).toBe(renderReports(first, ctx).json);
  });

  it('is boring once that change was already reported for an earlier data day', () => {
    const later = runAnalysis(input(site, { inspections, findings: [{ reportedOn: addDays(D, -1), findings: first.findings }] }));
    expect(later.headline.boring).toBe(true);
  });
});
