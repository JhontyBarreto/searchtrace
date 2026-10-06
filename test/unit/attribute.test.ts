// Synthesis: cause per scope, overrides, alternatives, falsifiers and priorities (spec 5.12). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import type { Bars, ChangePoint, Finding, GoogleEvent, ScopeDecomposition, SiteChange, SiteChangeImpact } from '../../src/core/types.js';
import {
  alternativesFor, causeForScope, falsifierFor, findingPriority, levelFor, noticeFinding, scopeFinding, significantGroups, sortFindings,
  type ScopeFacts, type SynthesisContext,
} from '../../src/analyze/attribute.js';
import { computeWindows } from '../../src/analyze/windows.js';
import type { Group } from '../../src/analyze/waterfall.js';

const D = '2026-10-03';
const windows = computeWindows(D, 28);
const zero: Bars = { demand: 0, visibility: 0, rank: 0, samePos: 0, appeared: 0, disappeared: 0, aioCitation: 0 };
const tight = (v: number): [number, number] => (v < 0 ? [v * 1.4, v * 0.6] : v > 0 ? [v * 0.6, v * 1.4] : [-5, 5]);

function ctx(over: Partial<SynthesisContext> = {}): SynthesisContext {
  return {
    dataThrough: D, windows, windowDays: 28, events: [], changePoints: [], siteChanges: [], siteChangeImpacts: [], impactFindingIds: new Map(),
    aioDidSignal: false, aioDid: null, firstSnapshot: null, gscPartition: 'gsc/2026/10/2026-10-03.ndjson.gz', costPerCheck: 0.0012, ...over,
  };
}

function facts(bars: Partial<Bars>, over: Partial<ScopeFacts> = {}, ci?: Partial<Record<Group, [number, number]>>): ScopeFacts {
  const b = { ...zero, ...bars };
  const delta = Object.values(b).reduce((a, x) => a + x, 0);
  const d: ScopeDecomposition = {
    unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, baseClicks: 1000, curClicks: 1000 + delta, deltaClicks: delta, bars: b,
    ci95: { total: tight(delta) }, pTotal: 0.001, units: 50, namedClickShare: 0.7,
  };
  const g = { demand: b.demand, ranking: b.rank + b.visibility, samePos: b.samePos, aioCitation: b.aioCitation, churn: b.appeared + b.disappeared };
  return {
    unit: d.unit, decomposition: d,
    groupCi: { demand: tight(g.demand), ranking: tight(g.ranking), samePos: tight(g.samePos), aioCitation: tight(g.aioCitation), churn: tight(g.churn), ...ci },
    pages: new Set(['https://x.example/blog/a', 'https://x.example/blog/b']), movedPages: new Set(['https://x.example/blog/a']), baseImpressions: 50_000, curImpressions: 50_000 * (1 + b.demand / 1000),
    pb: 4.2, pc: 4.3, ctrB: 0.02, ctrC: 0.018, movedSearches: 3, checkedShare: 0, aioUncitedShare: 0, checkedQueries: 0, aioQueries: 0, candidates: 12,
    kFallback: false, unstableShare: 0, topSegment: '/blog/a', yoy: null, p: 0.001, q: 0.01, floorsMet: true, delta: 0.1, phi: 1.2,
    impressions: { tau: 0.01, real: 'noise' }, ...over,
  };
}

const update = (id: string, kind: GoogleEvent['kind'], title: string, begin: string, end: string | null): GoogleEvent => ({
  id, source: 'seed', service: 'Ranking', kind, title, begin, end, endEstimated: end === null, url: null, modified: null,
});

describe('cause for a scope (5.12)', () => {
  it('maps the significant groups to a cause and template', () => {
    expect(causeForScope(facts({ demand: -200, samePos: -10 }), ctx())).toMatchObject({ cause: 'demand', template: 'demand', groups: ['demand'] });
    expect(causeForScope(facts({ rank: -150, demand: 5 }), ctx())).toMatchObject({ cause: 'rank', template: 'ranking' });
    expect(causeForScope(facts({ samePos: -150 }), ctx())).toMatchObject({ cause: 'ctr_serp', template: 'same_spot_unchecked' });
    expect(causeForScope(facts({ samePos: -150 }, { checkedShare: 0.8, aioQueries: 4 }), ctx())).toMatchObject({ cause: 'ctr_serp', template: 'same_spot_checked' });
    expect(causeForScope(facts({ samePos: -150 }, { checkedShare: 0.9, aioUncitedShare: 0.7 }), ctx({ aioDidSignal: true, aioDid: { tau: -0.26, ci95: [-0.35, -0.17] } })))
      .toMatchObject({ cause: 'ai_overview', template: 'aio_not_cited', slots: { x: -0.26, lo: -0.35, hi: -0.17 } });
    // An AIO signal elsewhere on the site does not explain a scope whose loss is on unchecked searches.
    expect(causeForScope(facts({ samePos: -150 }), ctx({ aioDidSignal: true })).cause).toBe('ctr_serp');
    expect(causeForScope(facts({ aioCitation: -90 }), ctx())).toMatchObject({ cause: 'ai_overview', template: 'aio_flattening', ambiguous: true });
    expect(causeForScope(facts({ appeared: -100 }), ctx())).toMatchObject({ cause: 'unknown', template: 'cause_unknown' });
    const mixed = causeForScope(facts({ demand: -120, rank: -80 }), ctx());
    expect(mixed).toMatchObject({ cause: 'mixed', template: 'mixed', slots: { a: 'demand', b: 'rank' } });
    expect(mixed.slots.x).toBeCloseTo(1, 12);
  });

  it('needs a CI that excludes 0, the same sign as the change and a quarter of it', () => {
    const f = facts({ demand: -200, samePos: -40 }, {}, { demand: [-300, 20] });
    expect(significantGroups(f.decomposition, f.groupCi)).toEqual([]);
    const small = facts({ demand: -200, samePos: -40 });
    expect(significantGroups(small.decomposition, small.groupCi)).toEqual(['demand']);
    const wrongSign = facts({ demand: 100, samePos: -400 });
    expect(significantGroups(wrongSign.decomposition, wrongSign.groupCi)).toEqual(['samePos']);
    expect(causeForScope(facts({ demand: 10 }, {}, { demand: [-3, 25] }), ctx())).toMatchObject({ cause: 'unknown', slots: { top_segment: '/blog/a' } });
  });

  it('override a: a site change in scope whose post window overlaps the current window', () => {
    const change: SiteChange = {
      id: 'sitechg_x', source: 'snapshot', field: 'title', cls: 'snippet', templateKey: '/blog/*', signature: 'title:x', text: null,
      deployed: { from: '2026-09-08T10:00:00Z', to: '2026-09-09T10:00:00Z', precision: 'bounded' },
      touched: [{ url: 'https://x.example/blog/a', before: 'A | X', after: 'A - X', googleSeen: { from: '2026-09-09T10:00:00Z', to: '2026-09-13T18:00:00Z', precision: 'bounded' } }],
    };
    const impact: SiteChangeImpact = {
      siteChangeId: 'sitechg_x', outcome: 'ctr', treated: 1, controls: 9, controlFallback: false, tau: -0.3, ci95: [-0.4, -0.2], controlChange: 0.01,
      controlCi95: [-0.05, 0.06], placebo: { tau: 0, ci95: [-0.1, 0.1] }, notYetSeen: [], synthesis: 'site_change', real: 'signal', reason: 'signal', findingId: 'fimpact',
    };
    const c = ctx({ siteChanges: [change], siteChangeImpacts: [impact], impactFindingIds: new Map([['sitechg_x', 'fimpact']]) });
    const r = causeForScope(facts({ samePos: -150 }), c);
    expect(r).toMatchObject({ cause: 'site_change', template: 'real_site_change', related: { siteChanges: ['sitechg_x'], findings: ['fimpact'] } });
    expect(r.slots).toMatchObject({ k: 1, change_date: '2026-09-09', d1: '2026-09-09', d2: '2026-09-13', ctrl: 0.01, direction: 'down' });
    const both = causeForScope(facts({ samePos: -150 }), ctx({
      siteChanges: [change], siteChangeImpacts: [{ ...impact, synthesis: 'both' }],
      events: [update('sep', 'spam', 'September 2026 spam update', '2026-09-24T16:15:00Z', null)],
    }));
    expect(both).toMatchObject({ cause: 'mixed', template: 'mixed', slots: { a: 'site_change', b: 'September 2026 spam update' } });
    // A page outside the blast radius is not explained by it.
    expect(causeForScope(facts({ samePos: -150 }, { pages: new Set(['https://x.example/other']) }), c).cause).toBe('ctr_serp');
  });

  it('override b: a change point near the current window overlapping a core update is google_update', () => {
    const cp: ChangePoint = {
      seriesId: 'tpl:/blog/*:clicks', unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, metric: 'clicks', date: '2026-09-20',
      dateWindow: ['2026-09-18', '2026-09-22'], before: 30, after: 20, ratio: 0.67, ci95: [0.6, 0.75], p: 0.001, q: 0.01, shape: 'step',
      slopePerWeek: null, overlaps: [{ eventId: 'core1', kind: 'core', title: 'September 2026 core update' }], localisation: null,
      seasonalMatch: false, tooRecent: false, mode: 'daily',
    };
    const c = ctx({ changePoints: [cp], events: [update('core1', 'core', 'September 2026 core update', '2026-09-15T16:00:00Z', '2026-09-29T16:00:00Z')] });
    expect(causeForScope(facts({ rank: -150 }), c)).toMatchObject({
      cause: 'google_update', template: 'real_google_no_changes', slots: { date: '2026-09-20', n_days: 5, update: 'September 2026 core update' },
    });
  });
});

describe('alternatives, falsifiers and level', () => {
  it('lists what else could explain it, minus the chosen cause', () => {
    const c = ctx({ events: [update('aug', 'spam', 'August 2026 spam update', '2026-08-18T16:27:00Z', '2026-08-21T08:49:00Z')] });
    const alts = alternativesFor(facts({ samePos: -150, demand: -5 }, {}, { demand: [-20, 10] }), 'ctr_serp', c);
    const keys = alts.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(['demand_ruled_out', 'rank_ruled_out', 'site_change_none_recorded', 'update_overlaps', 'aio_not_checked']));
    expect(alts.find((a) => a.key === 'update_overlaps')?.slots).toEqual({ update: 'August 2026 spam update' });
    expect(alts.find((a) => a.key === 'demand_ruled_out')?.ruledOut).toBe(true);
    // No update in the windows: ruled out. Crawling since before the window: nothing to say about site changes.
    const quiet = alternativesFor(facts({ demand: -150 }), 'demand', ctx({ firstSnapshot: '2026-01-01' })).map((a) => a.key);
    expect(quiet).toContain('update_no_overlap');
    expect(quiet).not.toContain('demand_possible');
    expect(quiet).not.toContain('site_change_none_recorded');
  });

  it('picks the falsifier from the verdict and cause', () => {
    const c = ctx();
    expect(falsifierFor('underpowered', 'rank', c, { mde: 0.4, weeksNeeded: 6.2, notMeasurable: false })).toEqual({ key: 'more_data', slots: { check_date: '2026-11-21' } });
    expect(falsifierFor('underpowered', null, c, { mde: 0.9, weeksNeeded: null, notMeasurable: true })).toEqual({ key: 'more_data', slots: { check_date: '2026-10-31' } });
    expect(falsifierFor('signal', 'site_change', c, null).key).toBe('revert_and_recrawl');
    expect(falsifierFor('signal', 'google_update', c, null).key).toBe('next_update_recovery');
    expect(falsifierFor('signal', 'demand', c, null).key).toBe('impressions_recover');
    expect(falsifierFor('signal', 'ai_overview', c, null).key).toBe('aio_disappears');
    expect(falsifierFor('signal', 'rank', c, null).key).toBe('position_recovers');
    expect(falsifierFor('signal', 'unknown', c, null).key).toBe('record_changes');
    expect(levelFor('signal', 'INFERRED')).toBe('high');
    expect(levelFor('signal', 'AMBIGUOUS')).toBe('medium');
    expect(levelFor('underpowered', 'INFERRED')).toBe('low');
  });

  it('builds a waterfall finding whose template follows the verdict', () => {
    const f = facts({ samePos: -150 });
    const c = ctx();
    const cause = causeForScope(f, c);
    const signal = scopeFinding(f, { real: 'signal', reason: 'signal', power: null, failed: [], estimate: -0.15, ci95: [-0.2, -0.1], freq: null }, cause, c, {
      kind: 'waterfall', id: 'fwf', B: 200, cpFindingIds: new Map(), measurementCap: false,
    });
    expect(signal).toMatchObject({ template: 'same_spot_unchecked', cause: 'ctr_serp', causeConfidence: 'INFERRED', metric: 'clicks' });
    expect(signal.slots).toMatchObject({ n: 12, cb: 0.02, cc: 0.018 });
    expect(signal.slots.cost).toBeCloseTo(0.0144, 12);
    const under = scopeFinding(f, { real: 'underpowered', reason: 'wide_ci', power: { mde: 0.3, weeksNeeded: 5, notMeasurable: false }, failed: [], estimate: -0.15, ci95: [-0.4, 0.1], freq: null }, cause, c, {
      kind: 'waterfall', id: 'fwf2', B: 200, cpFindingIds: new Map(), measurementCap: false,
    });
    expect(under).toMatchObject({ template: 'not_enough_data', causeConfidence: 'AMBIGUOUS', falsifier: { key: 'more_data' } });
    expect(under.slots).toMatchObject({ cpw: 250, mde: 0.3, weeks: 4, pct: -0.15, impr_pct: 0.01, impr_real: 'noise', not_measurable: 0 });
    expect(under.power?.perWeek).toBe(250);
    // A reporting change caps demand claims at unclear.
    const capped = scopeFinding(facts({ demand: -150 }), { real: 'signal', reason: 'signal', power: null, failed: [], estimate: -0.15, ci95: [-0.2, -0.1], freq: null },
      causeForScope(facts({ demand: -150 }), c),
      ctx({ events: [update('num100', 'data_anomaly', 'num=100', '2026-09-10T00:00:00Z', '2026-09-16T00:00:00Z')] }),
      { kind: 'waterfall', id: 'fwf3', B: 200, cpFindingIds: new Map(), measurementCap: true });
    expect(capped).toMatchObject({ real: 'unclear', template: 'reporting_artefact', slots: { metric: 'clicks', date: '2026-09-09', event: 'num=100' } });
  });
});

describe('priorities', () => {
  const base = (over: Partial<Finding>): Finding => ({
    ...noticeFinding('coverage', {}, ctx()),
    ...over,
  });

  it('follows the 5.12 rule and sorts by priority then id', () => {
    expect(findingPriority(base({ kind: 'headline' }))).toBe(1e9);
    expect(findingPriority(base({ kind: 'waterfall', reason: 'signal', real: 'signal', causeConfidence: 'INFERRED', effect: { estimate: -0.2, ci95: null, absolute: -40, absoluteCi95: null, p: null, q: null } }))).toBe(40_000);
    expect(findingPriority(base({ kind: 'waterfall', reason: 'wide_ci', real: 'underpowered', causeConfidence: 'AMBIGUOUS', effect: { estimate: null, ci95: null, absolute: 0.4, absoluteCi95: null, p: null, q: null } }))).toBe(10);
    expect(findingPriority(base({ kind: 'update_impact', reason: 'noise_bounded', real: 'noise', causeConfidence: 'INFERRED', effect: { estimate: null, ci95: null, absolute: -3, absoluteCi95: null, p: null, q: null } }))).toBe(3.5);
    expect(findingPriority(base({ kind: 'notice' }))).toBe(5);
    expect(findingPriority(base({ kind: 'change_point', metric: 'impressions', reason: 'signal', real: 'signal', causeConfidence: 'INFERRED', effect: { estimate: 0.2, ci95: null, absolute: 900, absoluteCi95: null, p: null, q: null } }))).toBe(1000);
    const sorted = sortFindings([{ ...base({}), id: 'fb', priority: 5 }, { ...base({}), id: 'fa', priority: 5 }, { ...base({}), id: 'fc', priority: 9 }]);
    expect(sorted.map((f) => f.id)).toEqual(['fc', 'fa', 'fb']);
  });
});
