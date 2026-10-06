// A small synthetic site for the WP-D graph tests and the graphify contract test.
// Everything is made up: example.com, fake queries, fake findings.
import { nodeId } from '../../src/core/ids.js';
import { addDays, dateRange } from '../../src/core/time.js';
import type {
  AnalysisOutput, Cell, Finding, GoogleEvent, GraphInput, InspectionRecord, IsoDate, PageDay, PageFields, PeriodEffect,
  SerpObservation, SiteChange, SnapshotRecord,
} from '../../src/core/types.js';
import { memoryIndex } from '../helpers/index.js';

export const PROPERTY = 'sc-domain:example.com';
export const SITE = 'example.com';
export const D = '2026-10-03';
const U = (path: string): string => `https://example.com${path}`;
export const PAGES = ['/', '/blog/fix-a-leak', '/blog/boiler-noise', '/blog/radiator-bleed', '/services/emergency', '/about'].map(U);
const QUERIES: [string, string, number][] = [
  ['example plumbing', U('/'), 2],
  ['how to fix a leak', U('/blog/fix-a-leak'), 4],
  ['leak repair', U('/blog/fix-a-leak'), 9],
  ['boiler noise', U('/blog/boiler-noise'), 6],
  ['bleed a radiator', U('/blog/radiator-bleed'), 12],
  ['emergency plumber', U('/services/emergency'), 15],
  ['ranking', U('/about'), 30],
];

const WINDOWS: AnalysisOutput['windows'] = {
  current: [addDays(D, -27), D],
  baseline: [addDays(D, -55), addDays(D, -28)],
  fit: [addDays(D, -209), addDays(D, -28)],
  holdoutFrom: addDays(D, -55),
  placebo: { pre1: [addDays(D, -111), addDays(D, -84)], pre2: [addDays(D, -83), addDays(D, -56)] },
  changepoint: [addDays(D, -181), D],
  seasonal: null,
};

export function fields(title: string, links: string[]): PageFields {
  return {
    title, metaDescription: null, metaRobots: null, xRobotsTag: null, canonical: null, h1: [title], lang: 'en', siteName: 'Example',
    wordCount: 500, textHash: 'b'.repeat(64), simhash: '0123456789abcdef', jsonLdTypes: [], internalLinks: [...links].sort(), externalLinkCount: 1, hreflangCount: 0,
  };
}

function finding(id: string, over: Partial<Finding>): Finding {
  return {
    id, kind: 'waterfall', unit: { level: 'site', key: 'site', label: 'Whole site' }, metric: 'clicks', windows: { baseline: WINDOWS.baseline, current: WINDOWS.current },
    date: null, dateWindow: null, effect: { estimate: -0.12, ci95: [-0.4, 0.2], absolute: -3, absoluteCi95: [-9, 2], p: 0.4, q: 0.6 },
    real: 'underpowered', reason: 'floors', cause: 'unknown', causeConfidence: 'AMBIGUOUS', components: null, componentCi95: null, power: null,
    template: 'not_enough_data', slots: {}, evidence: [{ type: 'gsc', confidence: 'EXTRACTED', partition: `gsc/2026/10/${D}.ndjson.gz`, summary: 'x' }],
    alternatives: [], falsifier: { key: 'more_data', slots: {} }, verify: null, related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { name: 'waterfall', version: '1' }, priority: 10, ...over,
  };
}

const RUN = (stamp: string): string => `r${stamp}-0a0b`;
const SNAP1 = '2026-09-08T10:00:00Z';
const SNAP2 = '2026-09-10T10:00:00Z';

export interface GraphFixture {
  input: GraphInput;
  partitions: string[];
  changes: SiteChange[];
}

export function graphFixture(o: { maxQueries?: number; extraFindings?: Finding[]; renderLabel?: GraphInput['renderLabel'] } = {}): GraphFixture {
  const days = dateRange(addDays(D, -119), D);
  const t: { date: IsoDate; c: number; i: number; ps: number }[] = [];
  const p: PageDay[] = [];
  const qpd: Cell[] = [];
  days.forEach((date, k) => {
    let c = 0;
    let im = 0;
    PAGES.forEach((url, j) => {
      if (url.endsWith('/about') && k < 60) return; // /about first appears in GSC later
      const i = 20 + j * 5 + (k % 7);
      const cl = (k + j) % 4 === 0 ? 1 : 0;
      p.push({ date, p: url, c: cl, i, ps: i * (3 + j) });
      c += cl;
      im += i;
    });
    t.push({ date, c, i: im, ps: im * 5 });
    for (const [q, page, pos] of QUERIES) {
      if (q === 'bleed a radiator' && k > 85) continue; // stopped ranking: valid_to set
      if (k % 2 === 1) continue;
      qpd.push({ date, q, p: page, dv: 'desktop', c: pos < 5 && k % 4 === 0 ? 1 : 0, i: 5, ps: 5 * pos });
    }
  });

  const snapshots: SnapshotRecord[] = [];
  const f1 = new Map<string, PageFields>();
  for (const [at, title] of [[SNAP1, 'Old'], [SNAP2, 'New']] as const) {
    for (const url of PAGES.filter((u) => !u.endsWith('/about'))) {
      const links = url === U('/') ? PAGES.filter((x) => x !== url && (at === SNAP2 || !x.includes('radiator'))) : [U('/')];
      const pf = fields(`${title} ${url}`, links);
      const hash = `${url}|${at}`.replace(/[^a-z0-9]/gi, '').slice(-40);
      f1.set(hash, pf);
      snapshots.push({ url, fetchedAt: at, outcome: 'ok', status: 200, finalUrl: url, redirects: [], fieldsHash: hash, fields: pf });
    }
  }
  snapshots.push({ url: U('/crawled-only'), fetchedAt: SNAP2, outcome: 'ok', status: 200, finalUrl: U('/crawled-only'), redirects: [], fieldsHash: 'co', fields: fields('Crawled only', []) });

  const inspections: InspectionRecord[] = [
    { url: U('/'), inspectedAt: '2026-09-01T12:00:00Z', reason: 'traffic', verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-08-30T01:00:00Z' },
    { url: U('/'), inspectedAt: '2026-09-12T12:00:00Z', reason: 'post_change', verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', lastCrawlTime: '2026-09-11T01:00:00Z' },
    { url: U('/'), inspectedAt: '2026-09-20T12:00:00Z', reason: 'traffic', verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-19T01:00:00Z' },
    { url: U('/blog/fix-a-leak'), inspectedAt: '2026-09-12T13:00:00Z', reason: 'post_change', verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-12T02:00:00Z' },
  ];

  const serp: SerpObservation[] = ['how to fix a leak', 'leak repair', 'example plumbing'].flatMap((kw, k) =>
    [0, 1].map((n): SerpObservation => ({
      intentKey: `ik${k}`, taskId: `task-${k}-${n}`, keyword: kw, device: 'desktop', locationCode: 2826, languageCode: 'en', isoWeek: '2026-W39',
      observedAt: `2026-09-${String(22 + n * 7).padStart(2, '0')}T08:00:00Z`, design: 'census', pi: 1, itemTypes: ['ai_overview', 'organic'],
      aio: kw === 'example plumbing' ? null : {
        async: false, citesUs: kw === 'how to fix a leak',
        refs: [
          { domain: 'www.semrush.com', url: 'https://www.semrush.com/a', title: 'A', source: null },
          ...(kw === 'how to fix a leak' ? [{ domain: 'www.example.com', url: U('/blog/fix-a-leak'), title: 'Us', source: null }] : []),
        ],
      },
      organic: [
        { rankAbsolute: 1, domain: 'www.semrush.com', url: 'https://www.semrush.com/x', title: 'S' },
        { rankAbsolute: 2, domain: 'ahrefs.com', url: 'https://ahrefs.com/y', title: 'A' },
        { rankAbsolute: 3, domain: 'www.example.com', url: U('/blog/fix-a-leak'), title: 'Fix | Example' },
      ],
      ours: { rankAbsolute: 3, url: U('/blog/fix-a-leak'), title: 'Fix | Example' },
    })),
  );

  const events: GoogleEvent[] = [
    { id: 'core-sep-2026', source: 'seed', service: 'Ranking', kind: 'core', title: 'September 2026 core update', begin: '2026-09-09T16:00:00Z', end: '2026-09-25T16:00:00Z', endEstimated: false, url: 'https://status.search.google.com/incidents/x', modified: '2026-09-25T17:00:00Z' },
    { id: 'old-2021', source: 'seed', service: 'Ranking', kind: 'core', title: 'November 2021 core update', begin: '2021-11-17T16:00:00Z', end: '2021-11-30T16:00:00Z', endEstimated: false, url: null, modified: '2021-11-30T17:00:00Z' },
    { id: 'open-spam', source: 'incidents', service: 'Ranking', kind: 'spam', title: 'October 2026 spam update', begin: '2026-10-01T16:00:00Z', end: null, endEstimated: true, url: null, modified: '2026-10-02T00:00:00Z' },
  ];

  const changeId = nodeId('sitechg', `title:shape:/blog/*${SNAP2}`);
  const changes: SiteChange[] = [
    {
      id: changeId, source: 'snapshot', field: 'title', cls: 'snippet', templateKey: '/blog/*', signature: 'title:shape:/blog/*',
      deployed: { from: SNAP1, to: SNAP2, precision: 'bounded' },
      touched: [
        { url: U('/blog/fix-a-leak'), before: 'Old', after: 'New', googleSeen: { from: SNAP2, to: '2026-09-12T02:00:00Z', precision: 'bounded' } },
        { url: U('/blog/boiler-noise'), before: 'Old', after: 'New', googleSeen: null },
      ],
      text: null,
    },
    {
      id: nodeId('sitechg', 'annotation:n1'), source: 'annotation', field: 'annotation', cls: 'content', templateKey: 'other pages', signature: 'annotation:n1',
      deployed: { from: '2026-08-01T07:00:00Z', to: '2026-08-02T07:00:00Z', precision: 'unknown' }, touched: [{ url: U('/about'), before: null, after: null, googleSeen: null }],
      text: 'Rewrote the about page <script>alert(1)</script>',
    },
  ];

  const pastSignal = finding('fpastsignal00001', { kind: 'change_point', real: 'signal', reason: 'signal', cause: 'google_update', causeConfidence: 'INFERRED', unit: { level: 'page', key: U('/blog/radiator-bleed'), label: '/blog/radiator-bleed' } });
  const pastNoise = finding('fpastnoise000001', { real: 'noise', reason: 'noise_bounded' });
  const ancient = finding('fancient00000001', { real: 'signal', reason: 'signal' });

  const findings: Finding[] = [
    finding('fheadline0000001', { kind: 'headline', template: 'headline', priority: 1e9, unit: { level: 'site', key: 'site', label: 'Whole site' } }),
    finding('fpagewaterfall01', { unit: { level: 'page', key: U('/blog/fix-a-leak'), label: '/blog/fix-a-leak' }, real: 'signal', reason: 'signal', cause: 'site_change', causeConfidence: 'INFERRED', related: { googleEvents: ['core-sep-2026'], siteChanges: [changeId], findings: [] } }),
    finding('ftemplate0000001', { unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, cause: 'mixed' }),
    finding('fquery000000001', { unit: { level: 'query', key: 'emergency plumber', label: 'emergency plumber' }, cause: 'rank' }),
    finding('fquerynotincells', { unit: { level: 'query', key: 'never seen query', label: 'never seen query' }, cause: null }),
    finding('fsiteimpact00001', { kind: 'site_change_impact', unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, real: 'signal', reason: 'signal', cause: 'site_change', causeConfidence: 'INFERRED', effect: { estimate: -0.3, ci95: [-0.38, -0.21], absolute: -20, absoluteCi95: [-25, -15], p: 0.001, q: 0.004 }, related: { googleEvents: [], siteChanges: [changeId], findings: [] } }),
    finding('fupdate000000001', { kind: 'update_impact', template: 'update_row', cause: 'google_update', related: { googleEvents: ['core-sep-2026', 'old-2021'], siteChanges: [], findings: [] } }),
    finding('faiofact00000001', { kind: 'aio_fact', metric: 'aio_presence', real: 'signal', reason: 'fact', cause: 'ai_overview', causeConfidence: 'EXTRACTED', template: 'aio_fact', unit: { level: 'query', key: 'how to fix a leak', label: 'how to fix a leak', device: 'desktop' }, evidence: [{ type: 'serp', confidence: 'EXTRACTED', partition: 'serp/2026/09/', summary: 'x' }] }),
    ...(o.extraFindings ?? []),
  ];

  const partitions = [
    ...days.map((d) => `gsc/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.ndjson.gz`),
    `gsc/2026/09/2026-09-20.r2.ndjson.gz`,
    `crawl/2026/09/${RUN('20260908t095900z')}.ndjson.gz`,
    `crawl/2026/09/${RUN('20260910t095900z')}.ndjson.gz`,
    `inspect/2026/09/${RUN('20260901t115900z')}.ndjson.gz`,
    `inspect/2026/09/${RUN('20260912t115900z')}.ndjson.gz`,
    `inspect/2026/09/${RUN('20260920t115900z')}.ndjson.gz`,
    `serp/2026/09/${RUN('20260923t061700z')}.ndjson.gz`,
    `serp/2026/09/${RUN('20260930t061700z')}.ndjson.gz`,
    `google/2026/08/${RUN('20260801t061700z')}.ndjson.gz`,
    `google/2026/10/${RUN('20261002t061700z')}.ndjson.gz`,
  ];

  const db = memoryIndex({
    property: PROPERTY, t, p, qpd, inspections, snapshots, fields: f1, serp, events,
    findings: [
      { reportedOn: '2025-08-01', findings: [ancient] },
      { reportedOn: '2026-07-01', findings: [pastSignal, pastNoise] },
      { reportedOn: '2026-09-01', findings: [findings[0]] },
    ],
    partitions: partitions.map((path) => ({ path, sha256: 'x' })),
  });

  const pe = { pre: 10, post: 9, tau: -0.1, ci95: [-0.5, 0.4], p: 0.6, se: 0.3, seSource: 'quasi_poisson', freq: null, floorsMet: false, real: 'underpowered', reason: 'floors', power: null } as PeriodEffect;
  const analysis: AnalysisOutput = {
    schemaVersion: 1, property: PROPERTY, siteDomain: SITE, dataThrough: D, windows: WINDOWS, inputsHash: 'h',
    headline: { clicks: pe, impressions: pe, findingId: 'fheadline0000001', boring: false },
    findings, scopes: [], changePoints: [], scorecard: [], siteChangeImpacts: [], siteChanges: changes, aio: null,
    curve: { m: 500, unstable: [], bins: [], fitWindow: WINDOWS.fit }, serpCandidates: [], timeline: { sealed: [], provisional: [] },
    templates: Object.fromEntries([...PAGES, U('/crawled-only')].map((u) => [u, u.includes('/blog/') ? '/blog/*' : 'other pages'])),
    diagnostics: {
      namedClickShare: 0.2, reconciliation: { byPageClicks: 1, byPropertyClicks: 1 }, truncatedDays: [], revisions: 0, underpoweredUnits: 0,
      measurementEvents: [], bootstrapB: {}, brandTokens: ['example'], brandSuggestions: [], historyDays: 120,
    },
  };

  return {
    input: {
      property: PROPERTY, siteDomain: SITE, dataThrough: D, db, analysis, previous: null, maxQueries: o.maxQueries ?? 2000,
      renderLabel: o.renderLabel ?? ((f) => `${f.kind} about ${f.unit.label}`),
    },
    partitions,
    changes,
  };
}
