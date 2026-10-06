// Spec 5.13 test 33 (scorecard): classification, open incidents use begin + 14 days, competing
// March 2026 events give unclear, too recent with checkAgainOn, skipped_discover. Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { findingId } from '../../src/core/ids.js';
import { addDays, diffDays } from '../../src/core/time.js';
import type { GoogleEvent, ScorecardInput, SiteChange, UpdateRow } from '../../src/core/types.js';
import { buildScorecard, eventDates } from '../../src/analyze/scorecard.js';
import { loadSeedEvents } from '../../src/sources/google/updates.js';
import { DEFAULT_DOW, dowMeans, poissonSeries, testRng } from '../helpers/index.js';

const START = '2025-06-01';
const D = '2026-10-03';
const N = diffDays(START, D) + 1; // 490 days, as on the real test property
const DROP = diffDays(START, '2025-12-11');

const clicks = poissonSeries(testRng('sc-clicks'), dowMeans(START, N, 12).map((m, k) => (k >= DROP ? m * 0.55 : m)));
const impressions = poissonSeries(testRng('sc-impr'), dowMeans(START, N, 3000).map((m, k) => (k >= DROP ? m * 0.7 : m)));

const PARTIAL: GoogleEvent = {
  id: 'test-partial', source: 'curated', service: 'Ranking', kind: 'other_ranking', title: 'Test reviews update',
  begin: '2026-09-10T17:00:00Z', end: '2026-09-15T17:00:00Z', endEstimated: false, url: null, modified: null,
};

function input(o: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    clicks, impressions, start: START, dow: DEFAULT_DOW, phi: { clicks: 1, impressions: 1 }, events: [...loadSeedEvents(), PARTIAL],
    dataThrough: D, siteChanges: [], delta: 0.1, fdrQ: 0.1, ...o,
  };
}

const byTitle = (rows: UpdateRow[], t: string): UpdateRow => {
  const r = rows.find((x) => x.title === t);
  if (!r) throw new Error(`no row ${t}`);
  return r;
};

describe('buildScorecard (test 33)', () => {
  const { rows, findings } = buildScorecard(input());

  it('has one row and one finding per event, with discover skipped', () => {
    expect(rows).toHaveLength(60);
    expect(findings).toHaveLength(60);
    const disc = byTitle(rows, 'February 2026 Discover update');
    expect(disc.status).toBe('skipped_discover');
    expect(disc.window).toBeNull();
    expect(disc.clicks).toBeNull();
    // Every Ranking/Serving/Indexing event is classified and kept.
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['core', 'spam', 'discover', 'other_ranking', 'outage', 'data_anomaly']));
  });

  it('events before history start + 28 days are before_history; June 2025 core is measured', () => {
    expect(rows.filter((r) => r.begin < addDays(START, 28)).every((r) => r.status === 'before_history' || r.status === 'skipped_discover')).toBe(true);
    expect(rows.find((r) => r.begin === '2025-06-12')?.status).toBe('before_history');
    const june = byTitle(rows, 'June 2025 core update');
    expect(june.status).toBe('measured');
    expect(june.window).toEqual({ pre: ['2025-06-02', '2025-06-29'], post: ['2025-07-18', '2025-08-14'] });
  });

  it('finds the planted December 2025 drop', () => {
    const dec = byTitle(rows, 'December 2025 core update');
    expect(dec.status).toBe('measured');
    expect(dec.begin).toBe('2025-12-11');
    expect(dec.end).toBe('2025-12-29');
    expect(dec.window).toEqual({ pre: ['2025-11-13', '2025-12-10'], post: ['2025-12-30', '2026-01-26'] });
    expect(dec.clicks?.real).toBe('signal');
    expect(dec.clicks?.tau).toBeGreaterThan(-0.6);
    expect(dec.clicks?.tau).toBeLessThan(-0.3);
    expect(dec.impressions?.real).toBe('signal');
    expect(dec.competing).toEqual([]);
    const f = findings.find((x) => x.id === dec.findingId);
    expect(f?.id).toBe(findingId(['update_impact', 'site', dec.eventId]));
    expect(f?.real).toBe('signal');
    expect(f?.template).toBe('update_row');
    expect(f?.slots).toMatchObject({ update: 'December 2025 core update', dates: '2025-12-11 to 2025-12-29', clicks_label: 'Real change', status: 'measured' });
    expect(f?.slots.clicks_pct).toBeCloseTo(dec.clicks?.tau as number, 12);
    expect(f?.effect.q).not.toBeNull();
    expect(f?.effect.absolute as number).toBeLessThan(0);
    expect(f?.cause).toBe('google_update');
    expect(f?.causeConfidence).toBe('INFERRED');
    expect(f?.falsifier.key).toBe('next_update_recovery');
    expect(f?.verify).toEqual({ from: '2025-11-13', to: '2026-01-26' });
    expect(f?.alternatives.map((a) => a.key)).toContain('site_change_none_recorded');
  });

  it('competing March 2026 spam and core updates are both unclear', () => {
    for (const [t, other] of [
      ['March 2026 spam update', 'March 2026 core update'],
      ['March 2026 core update', 'March 2026 spam update'],
    ]) {
      const r = byTitle(rows, t);
      expect(r.competing).toEqual([other]);
      expect(r.clicks?.real).toBe('unclear');
      expect(r.clicks?.reason).toBe('identification');
      expect(r.impressions?.real).toBe('unclear');
      const f = findings.find((x) => x.id === r.findingId);
      expect(f?.real).toBe('unclear');
      expect(f?.alternatives).toContainEqual({ cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: other } });
      expect(f?.related.googleEvents).toHaveLength(2);
    }
  });

  it('the open September 2026 spam update uses begin + 14 days and is too recent', () => {
    const sept = byTitle(rows, 'September 2026 spam update');
    expect(sept.end).toBeNull();
    expect(sept.endEstimated).toBe(true);
    expect(eventDates(loadSeedEvents().find((e) => e.title === 'September 2026 spam update') as GoogleEvent)).toEqual({ b: '2026-09-24', e: '2026-10-08' });
    expect(sept.status).toBe('too_recent');
    expect(sept.checkAgainOn).toBe('2026-10-15');
    expect(sept.window).toBeNull();
    const f = findings.find((x) => x.id === sept.findingId);
    expect(f?.real).toBe('underpowered');
    expect(f?.slots).toMatchObject({ status: 'too_recent', check_date: '2026-10-15', dates: '2026-09-24 to 2026-10-08' });
    expect(f?.falsifier).toEqual({ key: 'more_data', slots: { check_date: '2026-10-15' } });
  });

  it('an event that ended 18 days before the data end gets a partial 18-day window', () => {
    const r = byTitle(rows, 'Test reviews update');
    expect(r.status).toBe('partial');
    expect(r.window).toEqual({ pre: ['2026-08-23', '2026-09-09'], post: ['2026-09-16', '2026-10-03'] });
  });

  it('a reporting change caps the impressions rows it overlaps, not the clicks rows', () => {
    const num100 = rows.find((r) => r.kind === 'data_anomaly') as UpdateRow;
    expect(num100.begin).toBe('2025-09-09'); // 2025-09-10T00:00Z is still 9 Sep in Pacific Time
    expect(num100.measurementOverlap).toBe(true);
    expect(num100.impressions?.real).toBe('unclear');
    const aug = byTitle(rows, 'August 2025 spam update');
    expect(aug.measurementOverlap).toBe(true);
    expect(aug.impressions?.real).toBe('unclear');
    const augF = findings.find((x) => x.id === aug.findingId);
    expect(augF?.alternatives.map((a) => a.key)).toContain('measurement_event_overlaps');
    const dec = byTitle(rows, 'December 2025 core update');
    expect(dec.measurementOverlap).toBe(false);
  });

  it('BH family 3 gives q >= p on every measured row, and findings are sorted by priority', () => {
    for (const r of rows) {
      for (const eff of [r.clicks, r.impressions]) if (eff) expect(eff.p).toBeLessThanOrEqual(1);
    }
    for (const f of findings) if (f.effect.p !== null) expect(f.effect.q as number).toBeGreaterThanOrEqual((f.effect.p as number) - 1e-12);
    const pr = findings.map((f) => f.priority);
    expect([...pr].sort((a, b) => b - a)).toEqual(pr);
    const tier = { signal: 1000, unclear: 100, underpowered: 10, noise: 1 } as const;
    for (const f of findings) {
      expect(f.kind).toBe('update_impact');
      expect(f.priority).toBeCloseTo(tier[f.real] * Math.max(1, Math.abs(f.effect.absolute ?? 0)) + 0.5, 9);
    }
  });

  it('counts site changes Google saw in [begin - 28, end]', () => {
    const change: SiteChange = {
      id: 'sitechg_test', source: 'snapshot', field: 'title', cls: 'snippet', templateKey: '/blog/*', signature: 'title:x:/blog/*',
      deployed: { from: '2025-11-20T00:00:00Z', to: '2025-11-21T00:00:00Z', precision: 'bounded' },
      touched: [{ url: 'https://example.com/blog/a', before: 'a', after: 'b', googleSeen: { from: '2025-11-21T00:00:00Z', to: '2025-11-25T12:00:00Z', precision: 'bounded' } }],
      text: null,
    };
    const out = buildScorecard(input({ siteChanges: [change] }));
    const dec = byTitle(out.rows, 'December 2025 core update');
    expect(dec.siteChangesSeen).toBe(1);
    const f = out.findings.find((x) => x.id === dec.findingId);
    expect(f?.related.siteChanges).toEqual(['sitechg_test']);
    expect(f?.alternatives).toContainEqual({ cause: 'site_change', ruledOut: false, key: 'site_change_possible', slots: { n: 1, date: '2025-11-25' } });
    expect(byTitle(out.rows, 'May 2026 core update').siteChangesSeen).toBe(0);
  });

  it('is deterministic and free of long dashes', () => {
    expect(buildScorecard(input())).toEqual(buildScorecard(input()));
    expect(JSON.stringify(buildScorecard(input()))).not.toMatch(/[\u2013\u2014]/);
  });

  it('copes with no data at all', () => {
    const out = buildScorecard(input({ clicks: [], impressions: [] }));
    expect(out.rows.every((r) => r.window === null)).toBe(true);
  });
});
