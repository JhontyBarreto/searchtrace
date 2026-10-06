// A small synthetic data folder with every partition kind, written through a DataStore. Owner: WP-A.
// Used by the index tests (sync round trip, revisions, delta snapshots) and handy for pipeline tests.
// All data is made up: example.com, fake queries, fake events.
import type {
  Annotation, Cell, DataStore, Finding, GoogleEvent, InspectionRecord, PageDay, PageFields, PartitionMeta, SerpObservation,
  SnapshotRecord,
} from '../../src/core/types.js';
import { layout } from '../../src/store/layout.js';

export const FIXTURE_PROPERTY = 'sc-domain:example.com';
export const FIXTURE_RUNS = ['r20261004t061700z-0a01', 'r20261005t061700z-0a02'] as const;
const HOME = 'https://example.com/';
const POST = 'https://example.com/blog/first-post';

const meta = (kind: PartitionMeta['kind'], runId: string, fetchedAt: string, extra: Partial<PartitionMeta> = {}): PartitionMeta => ({
  kind, schema: 1, property: FIXTURE_PROPERTY, toolVersion: '0.1.0', runId, fetchedAt, ...extra,
});

export function fixtureFields(title: string, links: string[] = []): PageFields {
  return {
    title, metaDescription: null, metaRobots: null, xRobotsTag: null, canonical: null, h1: [title], lang: 'en', siteName: 'Example',
    wordCount: 300, textHash: 'a'.repeat(64), simhash: '0123456789abcdef', jsonLdTypes: [], internalLinks: links,
    externalLinkCount: 0, hreflangCount: 0,
  };
}

/** A minimal Finding for history tests. */
export function fixtureFinding(id: string, real: Finding['real'], label = 'Whole site'): Finding {
  return {
    id, kind: 'headline', unit: { level: 'site', key: 'site', label }, metric: 'clicks', windows: null, date: null, dateWindow: null,
    effect: { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null }, real, reason: 'floors', cause: null,
    causeConfidence: 'AMBIGUOUS', components: null, componentCi95: null, power: null, template: 'not_enough_data', slots: {},
    evidence: [], alternatives: [], falsifier: { key: 'more_data', slots: {} }, verify: null,
    related: { googleEvents: [], siteChanges: [], findings: [] }, analyzer: { name: 'fixture', version: '1' }, priority: 1,
  };
}

/** Rows for one sealed day, scaled by k (k = 0 writes a day file with no rows, as Search Console does for a zero day). */
function dayRows(k: number): Record<string, unknown>[] {
  if (k === 0) return [];
  return [
    { s: 't', c: 3 * k, i: 100 * k, ps: 800 * k },
    { s: 'td', dv: 'desktop', c: 2 * k, i: 70 * k, ps: 490 * k },
    { s: 'td', dv: 'mobile', c: k, i: 30 * k, ps: 310 * k },
    { s: 'tc', cc: 'gbr', c: 2 * k, i: 60 * k, ps: 480 * k },
    { s: 'tc', cc: 'usa', c: k, i: 40 * k, ps: 320 * k },
    { s: 'p', p: HOME, c: 2 * k, i: 60 * k, ps: 300 * k },
    { s: 'p', p: POST, c: k, i: 45 * k, ps: 540 * k },
    { s: 'qpd', q: 'example brand', p: HOME, dv: 'desktop', c: k, i: 10 * k, ps: 10 * k },
    { s: 'qpd', q: 'how to example', p: POST, dv: 'mobile', c: 0, i: 5 * k, ps: 40 * k },
  ];
}

export interface FixtureSummary {
  days: string[];
  inspections: InspectionRecord[];
  snapshots: SnapshotRecord[];
  serp: SerpObservation[];
  events: GoogleEvent[];
  annotations: Annotation[];
  findings: { reportedOn: string; findings: Finding[] }[];
}

/**
 * Writes: meta.json; sealed days 2026-09-28 to 2026-10-03 (09-30 is a zero day, 10-01 has a
 * revision r2, 10-02 is truncated); the provisional tail (10-02 to 10-05, with 10-02 overlapping
 * sealed data); one inspect, two crawl (keyframe, then a delta), one serp, two google and two
 * findings partitions; and annotations.ndjson.
 */
export async function seedDataDir(store: DataStore): Promise<FixtureSummary> {
  const [run1, run2] = FIXTURE_RUNS;
  const at1 = '2026-10-04T06:17:00Z';
  const at2 = '2026-10-05T06:17:00Z';
  await store.writeFileAtomic(layout.meta, `${JSON.stringify({ schema: 1, property: FIXTURE_PROPERTY, createdAt: at1, toolVersion: '0.1.0' })}\n`);

  const scale: Record<string, number> = { '2026-09-28': 1, '2026-09-29': 2, '2026-09-30': 0, '2026-10-01': 3, '2026-10-02': 4, '2026-10-03': 5 };
  for (const [day, k] of Object.entries(scale)) {
    const slices = day === '2026-10-02' ? { t: { rows: 1, truncated: false }, qpd: { rows: 2, truncated: true } } : undefined;
    await store.writePartition(layout.gscDay(day), meta('gsc_day', run1, at1, { day, revision: 1, dataState: 'final', ...(slices ? { slices } : {}) }), dayRows(k));
  }
  // A revalidation found a difference on 2026-10-01: revision 2 replaces it (x10 so it is easy to spot).
  await store.writePartition(
    layout.gscDay('2026-10-01', 2),
    meta('gsc_day', run2, at2, { day: '2026-10-01', revision: 2, dataState: 'final' }),
    dayRows(30),
  );

  await store.writePartition(layout.gscFresh, meta('gsc_fresh', run2, at2, { dataState: 'all' }), [
    { s: 't', date: '2026-10-02', c: 99, i: 999, ps: 9990 },
    { s: 't', date: '2026-10-04', c: 1, i: 50, ps: 400 },
    { s: 't', date: '2026-10-05', c: 0, i: 20, ps: 180 },
    { s: 'td', date: '2026-10-04', dv: 'desktop', c: 1, i: 40, ps: 300 },
    { s: 'td', date: '2026-10-04', dv: 'mobile', c: 0, i: 10, ps: 100 },
  ]);

  const inspections: InspectionRecord[] = [
    { url: HOME, inspectedAt: '2026-10-04T07:00:00Z', reason: 'traffic', verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-03T23:22:42Z' },
    { url: POST, inspectedAt: '2026-10-04T07:00:05Z', reason: 'coverage', verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' },
  ];
  await store.writePartition(layout.perRun('inspect', run1, at1), meta('inspect', run1, at1), inspections);

  const fA = fixtureFields('Home | Example', [POST]);
  const fB = fixtureFields('First post | Example');
  const fC = fixtureFields('First post, updated | Example');
  const keyframe: SnapshotRecord[] = [
    { url: HOME, fetchedAt: '2026-10-04T06:20:00Z', outcome: 'ok', status: 200, finalUrl: HOME, redirects: [], fieldsHash: 'hash-a', fields: fA },
    { url: POST, fetchedAt: '2026-10-04T06:20:02Z', outcome: 'ok', status: 200, finalUrl: POST, redirects: [], fieldsHash: 'hash-b', fields: fB },
  ];
  const delta: SnapshotRecord[] = [
    { url: HOME, fetchedAt: '2026-10-05T06:20:00Z', outcome: 'not_modified', status: 304, finalUrl: HOME, redirects: [], fieldsHash: 'hash-a' },
    { url: POST, fetchedAt: '2026-10-05T06:20:02Z', outcome: 'ok', status: 200, finalUrl: POST, redirects: [], fieldsHash: 'hash-c', fields: fC },
    { url: 'https://example.com/new-page', fetchedAt: '2026-10-05T06:20:04Z', outcome: 'http_error', status: 404, finalUrl: null, redirects: [], fieldsHash: null },
  ];
  await store.writePartition(layout.perRun('crawl', run1, at1), meta('crawl', run1, at1, { keyframe: true }), keyframe);
  await store.writePartition(layout.perRun('crawl', run2, at2), meta('crawl', run2, at2, { keyframe: false }), delta);

  const serp: SerpObservation[] = [{
    intentKey: 'aaaaaaaaaaaaaaaaaaaaaaaa', taskId: '10051234-0000-0000-0000-000000000001', keyword: 'how to example', device: 'mobile',
    locationCode: 2826, languageCode: 'en', isoWeek: '2026-W41', observedAt: '2026-10-05T06:30:00Z', design: 'census', pi: 1,
    itemTypes: ['ai_overview', 'organic'], aio: { async: false, citesUs: false, refs: [{ domain: 'other.example', url: 'https://other.example/x', title: 'X', source: null }] },
    organic: [{ rankAbsolute: 2, domain: 'example.com', url: POST, title: 'First post' }], ours: { rankAbsolute: 2, url: POST, title: 'First post' },
  }];
  await store.writePartition(layout.perRun('serp', run2, at2), meta('serp', run2, at2), serp);

  const ev = (id: string, modified: string, title: string, begin: string): GoogleEvent => ({
    id, source: 'incidents', service: 'Ranking', kind: 'core', title, begin, end: null, endEstimated: true, url: null, modified,
  });
  const events1 = [ev('e-core', '2026-09-24T16:15:00Z', 'Fake core update', '2026-09-24T16:15:00Z'), ev('e-spam', '2026-08-01T00:00:00Z', 'Fake spam update', '2026-07-30T00:00:00Z')];
  const events2 = [ev('e-core', '2026-10-04T10:00:00Z', 'Fake core update (complete)', '2026-09-24T16:15:00Z')];
  await store.writePartition(layout.perRun('google', run1, at1), meta('google_events', run1, at1), events1);
  await store.writePartition(layout.perRun('google', run2, at2), meta('google_events', run2, at2), events2);

  const f1 = fixtureFinding('fheadline0000001', 'underpowered');
  const f1b = fixtureFinding('fheadline0000001', 'signal', 'Whole site (updated)');
  const f2 = fixtureFinding('fchangepoint0002', 'noise');
  const f3 = fixtureFinding('fnew000000000003', 'signal');
  await store.writePartition(layout.perRun('findings', run1, at1), meta('findings', run1, at1), [f1, f2]);
  await store.writePartition(layout.perRun('findings', run2, at2), meta('findings', run2, at2), [f1b, f3]);

  const annotations: Annotation[] = [
    { id: 'ann-2', at: '2026-10-05T08:00:00Z', date: '2026-09-09', text: 'New title template on blog posts', urls: [POST], field: 'title' },
    { id: 'ann-1', at: '2026-10-04T08:00:00Z', date: '2026-08-01', text: 'Moved to a new host', urls: [], field: 'annotation' },
  ];
  await store.writeFileAtomic(layout.annotations, `${annotations.map((a) => JSON.stringify(a)).join('\n')}\n{"id":"torn`);

  return {
    days: Object.keys(scale),
    inspections,
    snapshots: [...keyframe, ...delta],
    serp,
    events: [...events1, ...events2],
    annotations,
    // reported on the PT date of each run's fetchedAt (06:17Z is the previous evening in Pacific Time)
    findings: [{ reportedOn: '2026-10-03', findings: [f1, f2] }, { reportedOn: '2026-10-04', findings: [f1b, f3] }],
  };
}

/** The sealed rows the fixture's active revisions hold, in memoryIndex input shape. */
export function fixtureSealedRows(): { t: { date: string; c: number; i: number; ps: number }[]; p: PageDay[]; qpd: Cell[] } {
  const scale: Record<string, number> = { '2026-09-28': 1, '2026-09-29': 2, '2026-09-30': 0, '2026-10-01': 30, '2026-10-02': 4, '2026-10-03': 5 };
  const t: { date: string; c: number; i: number; ps: number }[] = [];
  const p: PageDay[] = [];
  const qpd: Cell[] = [];
  for (const [date, k] of Object.entries(scale)) {
    for (const r of dayRows(k) as Record<string, never>[]) {
      if (r.s === 't') t.push({ date, c: r.c, i: r.i, ps: r.ps });
      if (r.s === 'p') p.push({ date, p: r.p, c: r.c, i: r.i, ps: r.ps });
      if (r.s === 'qpd') qpd.push({ date, q: r.q, p: r.p, dv: r.dv, c: r.c, i: r.i, ps: r.ps });
    }
  }
  return { t, p, qpd };
}
