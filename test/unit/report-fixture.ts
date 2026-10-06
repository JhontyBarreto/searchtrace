// A synthetic AnalysisOutput for WP-F report, why and CLI tests. Owner: WP-F.
// Made-up site (example.com); every number is invented. With { xss: true } the untrusted text
// fields (queries, URLs, titles, annotation notes, domains) carry script-injection payloads.
import { addDays, dateRange } from '../../src/core/time.js';
import type {
  AnalysisOutput, Bars, Finding, PeriodEffect, ReportContext, RunSummary, ScopeDecomposition, UpdateRow,
} from '../../src/core/types.js';
import { defaultConfig } from '../../src/core/config.js';

export const XSS = {
  script: '<script>alert(1)</script>',
  img: '"><img src=x onerror=1>',
  js: 'javascript:alert(1)',
};

const PROPERTY = 'sc-domain:example.com';
const D = '2026-10-03';
const CURRENT: [string, string] = ['2026-09-06', '2026-10-03'];
const BASELINE: [string, string] = ['2026-08-09', '2026-09-05'];

function bars(p: Partial<Bars>): Bars {
  return { demand: 0, visibility: 0, rank: 0, samePos: 0, appeared: 0, disappeared: 0, aioCitation: 0, ...p };
}

function finding(p: Partial<Finding> & Pick<Finding, 'id' | 'kind' | 'template' | 'real'>): Finding {
  return {
    unit: { level: 'site', key: 'site', label: 'Whole site' },
    metric: 'clicks',
    windows: null,
    date: null,
    dateWindow: null,
    effect: { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null },
    reason: p.real === 'signal' ? 'signal' : p.real === 'noise' ? 'noise_bounded' : p.real === 'unclear' ? 'identification' : 'wide_ci',
    cause: null,
    causeConfidence: 'AMBIGUOUS',
    components: null,
    componentCi95: null,
    power: null,
    slots: {},
    evidence: [],
    alternatives: [],
    falsifier: { key: 'more_data', slots: { check_date: '2026-10-31' } },
    verify: null,
    related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { name: 'fixture', version: '1' },
    priority: 1,
    ...p,
  };
}

function effect(pre: number, post: number, real: PeriodEffect['real']): PeriodEffect {
  const tau = post / pre - 1;
  return {
    pre, post, tau, ci95: [tau - 0.3, tau + 0.3], p: 0.4, se: 0.15, seSource: 'empirical', freq: 0.25, floorsMet: true,
    real, reason: real === 'signal' ? 'signal' : 'wide_ci', power: { mde: 0.45, weeksNeeded: 30, notMeasurable: false },
  };
}

export function makeAnalysisOutput(o: { xss?: boolean; boring?: boolean } = {}): AnalysisOutput {
  const x = o.xss ?? false;
  const pageUrl = x ? `https://example.com/blog/${encodeURIComponent(XSS.img)}` : 'https://example.com/blog/slow-drains';
  const pageLabel = x ? `/blog/${XSS.img}` : '/blog/slow-drains';
  const query = x ? XSS.script : 'slow drain fix';
  const note = x ? `<img src=x onerror=alert(1)> ${XSS.js}` : 'New title template on blog posts';
  const domain = x ? `${XSS.img}.example` : 'competitor.example';

  const headline = finding({
    id: 'faaaaaaaaaaaaaaaa', kind: 'headline', template: 'not_enough_data', real: 'underpowered', reason: 'wide_ci',
    windows: { baseline: BASELINE, current: CURRENT }, cause: 'unknown',
    effect: { estimate: -0.1, ci95: [-0.48, 0.31], absolute: -9, absoluteCi95: [-30, 12], p: 0.52, q: 0.52 },
    power: { mde: 0.45, weeksNeeded: 30, notMeasurable: false, perWeek: 20 },
    slots: { cpw: 20, mde: 0.45, weeks: 4, pct: -0.1, impr_pct: 0.03, impr_label: 'Normal wobble' },
    evidence: [{ type: 'gsc', confidence: 'EXTRACTED', partition: 'gsc/2026/10/2026-10-03.ndjson.gz', summary: 'Search Console: 80 clicks, 19,030 impressions' }],
    alternatives: [
      { cause: 'demand', ruledOut: false, key: 'demand_possible', slots: { impr_pct: 0.03 } },
      { cause: 'site_change', ruledOut: false, key: 'site_change_none_recorded', slots: {} },
      { cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: 'September 2026 spam update' } },
    ],
    verify: { from: CURRENT[0], to: CURRENT[1] },
    priority: 1e9,
  });
  const tpl = finding({
    id: 'fbbbbbbbbbbbbbbbb', kind: 'waterfall', template: 'ranking', real: 'signal', cause: 'rank', causeConfidence: 'INFERRED',
    unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, windows: { baseline: BASELINE, current: CURRENT },
    effect: { estimate: -0.31, ci95: [-0.45, -0.15], absolute: -21, absoluteCi95: [-30, -12], p: 0.002, q: 0.01 },
    components: bars({ demand: -2, rank: -17, samePos: -2 }), componentCi95: { rank: [-25, -9] },
    slots: { pb: 6.2, pc: 8.9, n: 14, lo: -30, hi: -12, direction: 'down' },
    falsifier: { key: 'position_recovers', slots: {} }, verify: { from: CURRENT[0], to: CURRENT[1] }, priority: 21000,
  });
  const page = finding({
    id: 'fcccccccccccccccc', kind: 'waterfall', template: 'not_enough_data', real: 'underpowered',
    unit: { level: 'page', key: pageUrl, label: pageLabel }, windows: { baseline: BASELINE, current: CURRENT }, cause: 'unknown',
    effect: { estimate: -0.4, ci95: [-0.8, 0.5], absolute: -3, absoluteCi95: [-6, 2], p: 0.3, q: 0.6 },
    components: bars({ demand: -1, samePos: -2 }), power: { mde: 0.9, weeksNeeded: null, notMeasurable: true, perWeek: 2 },
    slots: { cpw: 2, weeks: 4, pct: -0.4 },
    evidence: [{ type: 'inspection', confidence: 'EXTRACTED', partition: 'inspect/2026/10/r20261004t061700z-0a01.ndjson.gz', summary: `Last crawled 2026-10-01 (${x ? XSS.script : 'Submitted and indexed'})` }],
    verify: { page: pageUrl, from: CURRENT[0], to: CURRENT[1] }, priority: 30,
  });
  const q = finding({
    id: 'fdddddddddddddddd', kind: 'waterfall', template: 'noise', real: 'noise', cause: 'unknown',
    unit: { level: 'query', key: query, label: query }, windows: { baseline: BASELINE, current: CURRENT },
    effect: { estimate: 0.05, ci95: [-0.05, 0.08], absolute: 1, absoluteCi95: [-1, 2], p: 0.5, q: 0.7 },
    slots: { pct: 0.05, freq: 0.25 }, verify: { query, from: CURRENT[0], to: CURRENT[1] }, priority: 1,
  });
  const cp = finding({
    id: 'feeeeeeeeeeeeeeee', kind: 'change_point', template: 'change_point', real: 'signal', metric: 'impressions',
    causeConfidence: 'INFERRED', unit: { level: 'template', key: '/blog/*', label: '/blog/*' },
    date: '2026-09-12', dateWindow: ['2026-09-09', '2026-09-15'],
    effect: { estimate: -0.18, ci95: [-0.25, -0.1], absolute: null, absoluteCi95: null, p: 0.001, q: 0.02 },
    slots: { metric: 'impressions', unit: '/blog/*', pct: -0.18, date: '2026-09-12', d1: '2026-09-09', d2: '2026-09-15', direction: 'down' },
    falsifier: { key: 'reverts', slots: {} }, priority: 1000,
  });
  const upd = finding({
    id: 'ffffffffffffffff2', kind: 'update_impact', template: 'update_row', real: 'underpowered',
    slots: { update: 'September 2026 spam update', status: 'too_recent', check_date: '2026-10-15' }, priority: 10.5,
  });
  const fact = finding({
    id: 'fgggggggggggggggg', kind: 'aio_fact', template: 'aio_fact', real: 'signal', reason: 'fact', causeConfidence: 'EXTRACTED',
    unit: { level: 'query', key: x ? XSS.js : 'how to clear a drain', label: x ? XSS.js : 'how to clear a drain' }, metric: 'aio_presence',
    slots: { query: x ? XSS.js : 'how to clear a drain', device: 'desktop', k: 2, n: 2, cited: 0, domains: domain }, priority: 5,
  });
  const idx = finding({
    id: 'fhhhhhhhhhhhhhhhh', kind: 'index_transition', template: 'index_change', real: 'signal', reason: 'fact',
    causeConfidence: 'EXTRACTED', metric: 'index_state', unit: { level: 'page', key: pageUrl, label: pageLabel },
    slots: { url: pageLabel, before: 'Submitted and indexed', after: 'Crawled - currently not indexed', date: '2026-10-01' }, priority: 5,
  });
  const scImpact = finding({
    id: 'fiiiiiiiiiiiiiiii', kind: 'site_change_impact', template: 'cant_separate', real: 'unclear',
    unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, slots: { date: '2026-09-09', check: 'placebo' }, priority: 100,
  });
  const coverage = finding({
    id: 'fjjjjjjjjjjjjjjjj', kind: 'notice', template: 'coverage', real: 'signal', reason: 'fact', causeConfidence: 'EXTRACTED',
    slots: { hidden: 0.81, shown: 0.19 }, priority: 5,
  });
  const fresh = finding({
    id: 'fkkkkkkkkkkkkkkkk', kind: 'notice', template: 'freshness', real: 'signal', reason: 'fact', causeConfidence: 'EXTRACTED',
    slots: { date: D, n: 3 }, priority: 5,
  });

  const findings = [headline, tpl, cp, scImpact, page, upd, fact, idx, coverage, fresh, q].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1),
  );

  const siteScope: ScopeDecomposition = {
    unit: { level: 'site', key: 'site', label: 'Whole site' }, baseClicks: 89, curClicks: 80, deltaClicks: -9,
    bars: bars({ demand: -3, rank: -4, samePos: -2 }), ci95: { demand: [-8, 2], rank: [-9, 1], samePos: [-6, 3], total: [-30, 12] },
    pTotal: 0.52, units: 240, namedClickShare: 0.19,
  };

  const days = dateRange(addDays(D, -489), D);
  const sealed = days.map((date, i) => ({ date, c: 2 + (i % 5), i: 600 + ((i * 37) % 200), ps: 6000 }));
  const provisional = dateRange(addDays(D, 1), addDays(D, 3)).map((date) => ({ date, c: 1, i: 300, ps: 3000 }));

  const scorecard: UpdateRow[] = [
    {
      eventId: 'sep26spam', title: 'September 2026 spam update', kind: 'spam', begin: '2026-09-24', end: null, endEstimated: true,
      status: 'too_recent', window: null, clicks: null, impressions: null, competing: [], measurementOverlap: false,
      siteChangesSeen: 0, checkAgainOn: '2026-10-15', findingId: upd.id,
    },
    {
      eventId: 'curated-num100', title: 'Google stops supporting num=100 (reporting change)', kind: 'data_anomaly',
      begin: '2025-09-10', end: '2025-09-16', endEstimated: false, status: 'measured',
      window: { pre: ['2025-08-13', '2025-09-09'], post: ['2025-09-17', '2025-10-14'] },
      clicks: effect(60, 58, 'underpowered'), impressions: effect(30000, 18000, 'unclear'), competing: [],
      measurementOverlap: true, siteChangesSeen: 0, checkAgainOn: null, findingId: 'fnotlisted0000000',
    },
  ];

  return {
    schemaVersion: 1,
    property: PROPERTY,
    siteDomain: 'example.com',
    dataThrough: D,
    windows: {
      baseline: BASELINE, current: CURRENT, fit: ['2026-02-27', '2026-09-05'], holdoutFrom: '2026-08-09',
      placebo: { pre1: ['2026-06-14', '2026-07-11'], pre2: ['2026-07-12', '2026-08-08'] },
      changepoint: ['2026-04-05', D], seasonal: null,
    },
    inputsHash: 'abc123',
    headline: { clicks: effect(89, 80, 'underpowered'), impressions: effect(18500, 19030, 'noise'), findingId: headline.id, boring: o.boring ?? false },
    findings,
    scopes: [siteScope],
    changePoints: [{
      seriesId: 'site:impressions', unit: { level: 'site', key: 'site', label: 'Whole site' }, metric: 'impressions',
      date: '2026-09-12', dateWindow: ['2026-09-09', '2026-09-15'], before: 700, after: 574, ratio: 0.82, ci95: [0.75, 0.9],
      p: 0.001, q: 0.02, shape: 'step', slopePerWeek: null, overlaps: [], localisation: null, seasonalMatch: false,
      tooRecent: false, mode: 'daily',
    }],
    scorecard,
    siteChangeImpacts: [{
      siteChangeId: 'sitechg_aaaaaaaaaaaa', outcome: 'ctr', treated: 3, controls: 2, controlFallback: true, tau: null, ci95: null,
      controlChange: null, controlCi95: null, placebo: null, notYetSeen: [], synthesis: 'unclear', real: 'unclear',
      reason: 'identification', findingId: scImpact.id,
    }],
    siteChanges: [{
      id: 'sitechg_aaaaaaaaaaaa', source: 'annotation', field: 'annotation', cls: 'content', templateKey: '/blog/*',
      signature: 'annotation', deployed: { from: '2026-09-09T07:00:00Z', to: '2026-09-10T07:00:00Z', precision: 'unknown' },
      touched: [{ url: pageUrl, before: null, after: null, googleSeen: null }], text: note,
    }],
    aio: {
      facts: [{
        keyword: x ? XSS.js : 'how to clear a drain', device: 'desktop', checks: 2, aioChecks: 2, status: 'present', cited: false,
        topDomains: [domain], ourRank: 4, titleRewritten: null, attributedClicks: null, findingId: fact.id,
      }],
      estimates: [],
      findings: [fact],
    },
    curve: { m: 480, unstable: [], bins: [], fitWindow: ['2026-02-27', '2026-09-05'] },
    serpCandidates: [],
    timeline: { sealed, provisional },
    templates: { [pageUrl]: '/blog/*' },
    diagnostics: {
      namedClickShare: 0.19, reconciliation: { byPageClicks: 252, byPropertyClicks: 252 }, truncatedDays: [], revisions: 0,
      underpoweredUnits: 12, measurementEvents: ['curated-num100'], bootstrapB: { waterfall: 1000 }, brandTokens: ['engico'],
      brandSuggestions: [], historyDays: 490,
    },
  };
}

export function makeRunSummary(p: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r20261006t061700z-3f2a', exit: 'ok', dataThrough: D, headline: null, reportPath: null, graphPath: null, spendUsd: 0, plan: null,
    phases: [
      { name: 'gsc', status: 'ok', startedAt: '2026-10-06T06:17:00Z', endedAt: '2026-10-06T06:22:00Z', requests: { 'gsc.query': 1031 }, rows: 300, costUsd: 0, partitions: [], notes: ['490 days stored (490 new)'], errors: [] },
    ],
    ...p,
  };
}

export function makeReportContext(p: Partial<ReportContext> = {}): ReportContext {
  return { toolVersion: '0.1.0', config: defaultConfig(PROPERTY), run: makeRunSummary(), demo: false, ...p };
}
