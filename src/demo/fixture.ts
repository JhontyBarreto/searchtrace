// Planted-story synthetic site ("Pipewell Plumbing", made up) written through DataStore, plus truth.json (6.9). Owner: WP-E.
//
// Everything here is invented: the domain uses the reserved .example TLD, the towns, queries and
// competitor domains are made up, and every number comes from a seeded generator, so two calls
// write byte-identical partitions. The story (spec 6.9):
//   1. December 2025 core update: /services/* slips about 2 positions (touched and untouched alike).
//      A 10% site-wide dip during the March 2026 spam and core updates (competing events).
//   2. A title template change on 40 of the 90 /blog/* posts on 9 Sep 2026, recrawled 12 to 15 Sep:
//      click rate at the same position -30% from the day after each recrawl.
//   3. An AI Overview on 40 how-to searches from 1 Sep 2026 (30 not citing us: click rate x0.7;
//      10 citing us), with 60 checked control searches that never show one.
//   4. A noise week: brand searches +25% for one week inside the current window (about +6% over
//      the 28 days, inside the homepage's normal range).
//   5. A thin page (/areas/pellowby, 29 clicks in the baseline window, 17 in the current one).
// The thin page carries about 29 clicks per window rather than 8: findings are emitted for the top
// 25 pages by click change, and a -40% move on 8 clicks (-3) would never make that list. 29 still
// misses the 30-click floor, so the page is "not enough data" with an MDE, as planted.
import { intentKey, sha256Hex } from '../core/ids.js';
import { rngFor } from '../core/rng.js';
import { addDays, dateRange, isoWeek, weekday } from '../core/time.js';
import type {
  DataStore, DemoTruth, Device, GoogleEvent, InspectionRecord, IsoDate, PageFields, PartitionMeta, Rng, SerpObservation, SnapshotRecord,
} from '../core/types.js';
import { layout } from '../store/layout.js';
import { poissonDraw } from '../analyze/stats.js';

export const DEMO_PROPERTY = 'sc-domain:pipewell-plumbing.example';
export const DEMO_ORIGIN = 'https://pipewell-plumbing.example/';
export const DEMO_DATA_THROUGH = '2026-10-03';
export const DEMO_DAYS = 490;
export const DEMO_START = addDays(DEMO_DATA_THROUGH, -(DEMO_DAYS - 1));
/** When the demo pretends it ran: the clock the demo pipeline should use. */
export const DEMO_NOW = '2026-10-06T06:17:00Z';
export const DEMO_THIN_PAGE = `${DEMO_ORIGIN}areas/pellowby`;
const TOOL_VERSION = '0.1.0';
const SEED = 'pipewell-demo-v1';
const SITE_NAME = 'Pipewell Plumbing';
const TRUTH_FILE = 'truth.json';
const WRITE_BATCH = 64;

const RUN = {
  gsc: 'r20261006t061700z-de01', crawl1: 'r20260908t100000z-de02', crawl2: 'r20260909t100000z-de03',
  inspect1: 'r20260908t090000z-de04', inspect2: 'r20260916t090000z-de05', google: 'r20261006t061700z-de06',
} as const;

// Planted dates.
const DEC_CORE = { from: '2025-12-11', to: '2025-12-29' };
const MARCH_DIP = { from: '2026-03-24', to: '2026-04-20' };
const AIO_FROM = '2026-09-01';
const NOISE_WEEK = { from: '2026-09-21', to: '2026-09-27' };
const BASELINE: [IsoDate, IsoDate] = [addDays(DEMO_DATA_THROUGH, -55), addDays(DEMO_DATA_THROUGH, -28)];
const CURRENT: [IsoDate, IsoDate] = [addDays(DEMO_DATA_THROUGH, -27), DEMO_DATA_THROUGH];
const DOW = [1.08, 1.1, 1.08, 1.04, 0.97, 0.82, 0.91];

/** Extra fields on truth expectations; the e2e test reads them, DemoTruth stays as frozen. */
export interface DemoExpectation {
  kind: DemoTruth['expect'][number]['kind'];
  unitKey: string;
  real: DemoTruth['expect'][number]['real'];
  cause: DemoTruth['expect'][number]['cause'];
  tauRange?: [number, number];
  /** Any of these verdicts passes (when the planted effect is diluted at this level). */
  realAnyOf?: DemoTruth['expect'][number]['real'][];
  eventId?: string;
  failedCheck?: string;
  estimator?: 'cross_section' | 'did';
  synthesis?: string;
  needsMde?: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// The made-up site
// ---------------------------------------------------------------------------

type Kind = 'brand' | 'single' | 'service' | 'aio_u' | 'aio_c' | 'control' | 'area' | 'blog' | 'thin';
interface Query { q: string; page: string; kind: Kind; imp: number; desk: number; pos: number; brand: boolean }
interface Page { url: string; title: string; tpl: 'home' | 'single' | 'services' | 'areas' | 'blog'; treated: boolean; recrawl: IsoDate | null; hidden: number }

const SERVICES = [
  'blocked-drains', 'boiler-repair', 'leak-detection', 'burst-pipes', 'tap-repair', 'radiator-repair',
  'boiler-installation', 'bathroom-installation', 'toilet-repair', 'water-heaters', 'gas-safety-checks', 'central-heating',
];
const TOWNS = [
  'ashby-vale', 'brackenford', 'cinderbrook', 'dunmere', 'elmswick', 'fernley', 'glenholt', 'harrowby', 'ivydale', 'kestleton',
  'larchmoor', 'millbrook-green', 'northwold', 'oakhampstead', 'pellowby',
];
const SINGLES = ['contact', 'about', 'pricing', 'reviews', 'emergency-plumber'];
const BLOG_VERBS = ['how-to-fix', 'how-to-unblock', 'why-is', 'how-to-bleed', 'when-to-replace', 'how-to-stop', 'what-causes', 'how-to-clean', 'how-much-to-fix'];
const BLOG_THINGS = ['a-dripping-tap', 'a-sink', 'my-boiler-losing-pressure', 'a-radiator', 'a-toilet-cistern', 'a-leaking-pipe', 'low-water-pressure', 'a-shower-head', 'a-noisy-boiler', 'a-frozen-pipe'];
const HOWTO = [
  'how to unblock a drain', 'how to clear a blocked toilet', 'how to repressurise a boiler', 'how to find a hidden leak', 'how to fix a burst pipe',
  'how to change a tap washer', 'how to bleed a radiator', 'how to balance radiators', 'how to reset a boiler', 'how to fix a running toilet',
  'how to stop a dripping tap', 'how to thaw a frozen pipe', 'how to fix low water pressure', 'how to descale a shower head', 'how to clear a slow drain',
  'how to fix a leaking radiator valve', 'how to replace a toilet flush', 'how to insulate pipes', 'how to fix a noisy radiator', 'how to fix a boiler leak',
  'how to unblock a kitchen sink', 'how to fix a leaking shower', 'how to drain a central heating system', 'how to fix a stiff tap', 'how to fix a cold radiator',
  'how to check for a gas leak', 'how to fix a leaking toilet', 'how to replace a radiator', 'how to fix an airlock', 'how to unblock a bath',
  'how to read a water meter', 'how to fix a dripping overflow', 'how to fix a leaky joint', 'how to stop water hammer', 'how to fix a boiler pressure drop',
  'how to replace a shower cartridge', 'how to fix a toilet that keeps running', 'how to clear a blocked outside drain', 'how to fix a leaking sink trap', 'how to service a boiler',
];
const COMPETITORS = ['plumbinghelp.example', 'diy-advice.example', 'heatingguide.example', 'homefix.example', 'tradesdirect.example'];

const titleCase = (slug: string): string => slug.split('-').map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

function buildSite(rng: Rng): { pages: Page[]; queries: Query[] } {
  const pages: Page[] = [];
  const queries: Query[] = [];
  const page = (path: string, tpl: Page['tpl'], title: string, hidden: number): Page => {
    const p: Page = { url: `${DEMO_ORIGIN}${path}`, title, tpl, treated: false, recrawl: null, hidden };
    pages.push(p);
    return p;
  };
  const query = (q: string, pg: Page, kind: Kind, imp: number, pos: number, desk = 0.6): void => {
    queries.push({ q, page: pg.url, kind, imp, desk, pos, brand: kind === 'brand' });
  };

  const home = page('', 'home', `${SITE_NAME} | Local plumbers and heating engineers`, 0.25);
  const brandQs = [
    'pipewell plumbing', 'pipewell', 'pipewell plumbers', 'pipewell plumbing reviews', 'pipewell plumbing phone number', 'pipewel plumbing',
    'pipewell plumbing prices', 'pipewell emergency plumber', 'pipewell boiler service', 'pipewell plumbing contact', 'pipewell heating',
    'pipe well plumbing', 'pipewell plumbing jobs', 'pipewell plumbing opening hours', 'pipewell plumbing address',
  ];
  brandQs.forEach((q, k) => query(q, home, 'brand', k === 0 ? 120 : k < 4 ? 30 : 8, 1.05 + 0.05 * (k % 3), 0.55));
  for (const s of SINGLES) {
    const pg = page(s, 'single', `${titleCase(s)} | ${SITE_NAME}`, 0.4);
    query(`plumber ${s.replace('-', ' ')}`, pg, 'single', 14, 7 + (s.length % 5));
  }

  // Services: six big pages host the AI Overview searches; six small ones.
  let aio = 0;
  let control = 0;
  SERVICES.forEach((slug, k) => {
    const big = k < 6;
    const pg = page(`services/${slug}`, 'services', `${titleCase(slug)} | ${SITE_NAME}`, 0.45);
    const name = slug.replace(/-/g, ' ');
    const variants = [`${name} near me`, `${name} cost`, `${name} plumber`, `emergency ${name}`, `${name} prices`, `local ${name}`, `${name} same day`, `best ${name} company`];
    variants.forEach((q, v) => {
      const isControl = big && control < 48;
      if (isControl) control++;
      query(q, pg, isControl ? 'control' : 'service', isControl ? 120 - 8 * v : 4 - 0.3 * v, [2, 3, 4, 5, 7][v % 5] + (big ? 0 : 3), v % 2 === 0 ? 0.62 : 0.4);
    });
    if (big) {
      for (let j = 0; j < 7 && aio < 40; j++) {
        const kind: Kind = aio < 30 ? 'aio_u' : 'aio_c';
        query(HOWTO[aio], pg, kind, 140, [2, 3, 4, 5, 7][aio % 5], aio % 2 === 0 ? 0.62 : 0.4);
        aio++;
      }
    }
  });
  // Areas: two busy towns, the thin page, the rest small. Their first three searches are checked controls.
  TOWNS.forEach((town, k) => {
    const pg = page(`areas/${town}`, 'areas', `Plumbers in ${titleCase(town)} | ${SITE_NAME}`, 0.4);
    const name = town.replace(/-/g, ' ');
    if (pg.url === DEMO_THIN_PAGE) {
      pg.hidden = 0;
      query(`plumber ${name}`, pg, 'thin', 20, 4, 1);
      return;
    }
    const scale = k < 2 ? 3 : 0.15;
    [`plumber ${name}`, `plumbers in ${name}`, `emergency plumber ${name}`, `boiler repair ${name}`, `heating engineer ${name}`, `drain unblocking ${name}`, `bathroom fitter ${name}`, `gas engineer ${name}`]
      .forEach((q, v) => {
        const isControl = v < 3 && control < 60;
        if (isControl) control++;
        query(q, pg, isControl ? 'control' : 'area', (isControl ? 12 : 10 - v) * scale, [2, 3, 4, 5, 7, 9, 11, 14][v], v % 2 === 0 ? 0.62 : 0.4);
      });
  });
  // Blog: 90 posts; 40 get the new title template (the popular ones first), recrawled 12 to 15 Sep.
  let n = 0;
  for (const verb of BLOG_VERBS) {
    for (const thing of BLOG_THINGS) {
      const slug = `${verb}-${thing}`;
      const pg = page(`blog/${slug}`, 'blog', `${titleCase(slug)} | ${SITE_NAME}`, 0.45);
      const treated = n % 9 < 4 && n < 90;
      pg.treated = treated;
      if (treated) pg.recrawl = addDays('2026-09-12', n % 4);
      // A few popular posts (four of them get the new titles), then a long tail of quiet ones.
      const pop = n < 4 ? 5 : n >= 4 && n < 7 ? 2.5 : 0.05 + 0.07 * rng();
      const words = slug.split('-');
      const qs = [
        words.join(' '), words.slice(-3).join(' '), `${words.slice(-2).join(' ')} fix`, `${words.slice(0, 3).join(' ')} ${words[words.length - 1]}`,
        `${words.join(' ')} step by step`, `${words.join(' ')} uk`,
      ];
      const weight = [12, 9, 6, 3, 2, 1.5];
      [...new Set(qs)].forEach((q, v) => query(q, pg, 'blog', pop * weight[v], 3 + v * 2 + (n % 3), v % 2 === 0 ? 0.6 : 0.45));
      n++;
    }
  }
  return { pages, queries };
}

// ---------------------------------------------------------------------------
// Click model and planted effects
// ---------------------------------------------------------------------------

function trueCtr(p: number, dv: Device, brand: boolean): number {
  const v = brand ? (dv === 'desktop' ? 0.62 : 0.55) * p ** -0.8 : (dv === 'desktop' ? 0.3 : 0.24) * p ** -1.15;
  return Math.min(0.85, v);
}

function binomial(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (n > 400) return Math.min(n, poissonDraw(rng, n * p));
  let k = 0;
  for (let j = 0; j < n; j++) if (rng() < p) k++;
  return k;
}

interface Mods { pos: number; ctr: number; imp: number }

function effects(q: Query | null, pg: Page, d: IsoDate): Mods {
  const m: Mods = { pos: 0, ctr: 1, imp: 1 };
  if (pg.tpl === 'services' && d >= DEC_CORE.from) {
    const ramp = d >= DEC_CORE.to ? 1 : (Date.parse(d) - Date.parse(DEC_CORE.from)) / (Date.parse(DEC_CORE.to) - Date.parse(DEC_CORE.from));
    m.pos += 2 * ramp;
  }
  if (d >= MARCH_DIP.from && d <= MARCH_DIP.to) m.ctr *= 0.9;
  if (pg.treated && pg.recrawl && d > pg.recrawl) m.ctr *= 0.7;
  if (q?.kind === 'aio_u' && d >= AIO_FROM) m.ctr *= 0.7;
  if (q?.kind === 'brand' && d >= NOISE_WEEK.from && d <= NOISE_WEEK.to) m.imp *= 1.25;
  return m;
}

type Row = Record<string, string | number>;

function generateDay(d: IsoDate, site: { pages: Page[]; queries: Query[] }, byUrl: Map<string, Page>, rng: Rng): Row[] {
  const dow = DOW[weekday(d)];
  const named = new Map<string, { c: number; i: number; ps: number; dv: Record<Device, number> }>();
  const qpd: Row[] = [];
  const thinK = d >= CURRENT[0] ? (Math.round((Date.parse(d) - Date.parse(CURRENT[0])) / 86_400_000) * 17) % 28 : -1;
  for (const q of site.queries) {
    const pg = byUrl.get(q.page) as Page;
    const m = effects(q, pg, d);
    for (const dv of ['desktop', 'mobile'] as Device[]) {
      const share = dv === 'desktop' ? q.desk : 1 - q.desk;
      if (share <= 0) continue;
      let i: number;
      let c: number;
      let pos = Math.max(1, (q.pos + m.pos) * Math.exp(0.08 * (rng() - 0.5)));
      if (q.kind === 'thin' && d >= BASELINE[0]) {
        // Deterministic: 29 clicks in the baseline window, 17 in the current one (-41%), 20 impressions a day.
        i = 20;
        c = d <= BASELINE[1] ? (d === BASELINE[0] ? 2 : 1) : thinK < 17 ? 1 : 0;
        pos = 4;
      } else {
        i = poissonDraw(rng, q.imp * share * dow * m.imp);
        c = binomial(rng, i, trueCtr(pos, dv, q.brand) * m.ctr);
      }
      if (i === 0) continue;
      const ps = Math.round(pos * i * 100) / 100;
      qpd.push({ s: 'qpd', q: q.q, p: q.page, dv, c, i, ps });
      const agg = named.get(q.page) ?? { c: 0, i: 0, ps: 0, dv: { desktop: 0, mobile: 0 } };
      agg.c += c;
      agg.i += i;
      agg.ps += ps;
      agg.dv[dv] += i;
      named.set(q.page, agg);
    }
  }
  // Page totals: named searches plus the anonymised ones Search Console hides (about 30% of clicks).
  const p: Row[] = [];
  const dev: Record<Device, { c: number; i: number; ps: number }> = { desktop: { c: 0, i: 0, ps: 0 }, mobile: { c: 0, i: 0, ps: 0 } };
  for (const pg of site.pages) {
    const agg = named.get(pg.url) ?? { c: 0, i: 0, ps: 0, dv: { desktop: 0, mobile: 0 } };
    let hi = 0;
    let hc = 0;
    let hps = 0;
    if (pg.hidden > 0) {
      const m = effects(null, pg, d);
      const avgPos = agg.i > 0 ? agg.ps / agg.i : 6;
      const pos = Math.min(100, avgPos + 1.5);
      hi = poissonDraw(rng, Math.max(2, agg.i) * pg.hidden * 2.2);
      hc = binomial(rng, hi, trueCtr(pos, 'desktop', false) * 0.9 * m.ctr);
      hps = Math.round(pos * hi * 100) / 100;
    }
    const c = agg.c + hc;
    const i = agg.i + hi;
    if (i === 0) continue;
    p.push({ s: 'p', p: pg.url, c, i, ps: Math.round((agg.ps + hps) * 100) / 100 });
    const deskShare = agg.i > 0 ? agg.dv.desktop / agg.i : 0.6;
    for (const dv of ['desktop', 'mobile'] as Device[]) {
      const f = dv === 'desktop' ? deskShare : 1 - deskShare;
      dev[dv].c += c * f;
      dev[dv].i += i * f;
      dev[dv].ps += (agg.ps + hps) * f;
    }
  }
  // Property totals count a search once even when two pages show, so impressions run a little lower.
  const td: Row[] = (['desktop', 'mobile'] as Device[]).map((dv) => ({
    s: 'td', dv, c: Math.round(dev[dv].c), i: Math.round(dev[dv].i * 0.96), ps: Math.round(dev[dv].ps * 0.96 * 100) / 100,
  }));
  const t = { s: 't', c: Number(td[0].c) + Number(td[1].c), i: Number(td[0].i) + Number(td[1].i), ps: Math.round((Number(td[0].ps) + Number(td[1].ps)) * 100) / 100 };
  const countries: [string, number][] = [['irl', 0.05], ['usa', 0.04], ['can', 0.03], ['aus', 0.02]];
  const tc: Row[] = [];
  let restC = t.c;
  let restI = t.i;
  for (const [cc, f] of countries) {
    const c = Math.floor(t.c * f);
    const i = Math.floor(t.i * f);
    restC -= c;
    restI -= i;
    tc.push({ s: 'tc', cc, c, i, ps: Math.round(i * (t.i > 0 ? t.ps / t.i : 0) * 1.3 * 100) / 100 });
  }
  tc.unshift({ s: 'tc', cc: 'gbr', c: restC, i: restI, ps: Math.round(restI * (t.i > 0 ? t.ps / t.i : 0) * 100) / 100 });
  return [t, ...td, ...tc, ...p.sort((a, b) => (a.p < b.p ? -1 : 1)), ...qpd];
}

// ---------------------------------------------------------------------------
// Pages, inspections, SERP checks, events
// ---------------------------------------------------------------------------

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function fieldsFor(pg: Page, title: string, all: Page[]): PageFields {
  const h = sha256Hex(pg.url);
  const links = all.filter((x) => x.tpl === pg.tpl && x.url !== pg.url).slice(0, 4).map((x) => x.url);
  return {
    title,
    metaDescription: `${titleCase(pg.url.slice(DEMO_ORIGIN.length).split('/').pop() || 'home')}: friendly local plumbers, made up for the searchtrace demo.`,
    metaRobots: null,
    xRobotsTag: null,
    canonical: pg.url,
    h1: [pg.title.split(' | ')[0]],
    lang: 'en-GB',
    siteName: SITE_NAME,
    wordCount: 400 + (parseInt(h.slice(0, 4), 16) % 1200),
    textHash: h,
    simhash: h.slice(0, 16),
    jsonLdTypes: pg.tpl === 'blog' ? ['Article', 'BreadcrumbList'] : ['LocalBusiness', 'WebPage'],
    internalLinks: [DEMO_ORIGIN, ...links].sort(),
    externalLinkCount: 2,
    hreflangCount: 0,
  };
}

const newTitle = (pg: Page): string => `${pg.title.split(' | ')[0]} - ${SITE_NAME}`;

function snapshots(site: { pages: Page[] }): { keyframe: SnapshotRecord[]; delta: SnapshotRecord[] } {
  const keyframe: SnapshotRecord[] = [];
  const delta: SnapshotRecord[] = [];
  site.pages.forEach((pg, k) => {
    const sec = String(k % 60).padStart(2, '0');
    const before = fieldsFor(pg, pg.title, site.pages);
    const h1 = sha256Hex(canonicalJson(before));
    keyframe.push({ url: pg.url, fetchedAt: `2026-09-08T10:${String(Math.floor(k / 60)).padStart(2, '0')}:${sec}Z`, outcome: 'ok', status: 200, finalUrl: pg.url, redirects: [], fieldsHash: h1, fields: before });
    const at = `2026-09-09T10:${String(Math.floor(k / 60)).padStart(2, '0')}:${sec}Z`;
    if (pg.treated) {
      const after = fieldsFor(pg, newTitle(pg), site.pages);
      delta.push({ url: pg.url, fetchedAt: at, outcome: 'ok', status: 200, finalUrl: pg.url, redirects: [], fieldsHash: sha256Hex(canonicalJson(after)), fields: after });
    } else {
      delta.push({ url: pg.url, fetchedAt: at, outcome: 'not_modified', status: 304, finalUrl: pg.url, redirects: [], fieldsHash: h1 });
    }
  });
  return { keyframe, delta };
}

function inspections(site: { pages: Page[] }): { first: InspectionRecord[]; second: InspectionRecord[] } {
  const base = (url: string, inspectedAt: string, lastCrawlTime: string, reason: InspectionRecord['reason']): InspectionRecord => ({
    url, inspectedAt, reason, verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED',
    pageFetchState: 'SUCCESSFUL', lastCrawlTime, googleCanonical: url, userCanonical: url, crawledAs: 'MOBILE',
  });
  const first = site.pages.map((pg, k) => base(pg.url, `2026-09-08T09:${String(k % 60).padStart(2, '0')}:00Z`, `2026-08-${String(10 + (k % 18)).padStart(2, '0')}T14:00:00Z`, 'traffic'));
  const second = site.pages.map((pg, k) => base(
    pg.url,
    `2026-09-16T09:${String(k % 60).padStart(2, '0')}:00Z`,
    pg.recrawl ? `${pg.recrawl}T18:00:00Z` : `2026-08-${String(10 + (k % 18)).padStart(2, '0')}T14:00:00Z`,
    pg.treated ? 'post_change' : 'traffic',
  ));
  return { first, second };
}

function serpChecks(site: { queries: Query[]; pages: Page[] }): Map<string, SerpObservation[]> {
  const byWeek = new Map<string, SerpObservation[]>();
  const checked = site.queries.filter((q) => q.kind === 'aio_u' || q.kind === 'aio_c' || q.kind === 'control');
  const titles = new Map(site.pages.map((p) => [p.url, p.title]));
  for (const monday of ['2026-09-14', '2026-09-21', '2026-09-28']) {
    const week = isoWeek(monday);
    const list: SerpObservation[] = [];
    for (const q of checked) {
      const device: Device = q.desk >= 0.5 ? 'desktop' : 'mobile';
      const h = parseInt(sha256Hex(q.q).slice(0, 6), 16);
      for (const off of [h % 3, (h % 3) + 3]) {
        const day = addDays(monday, off);
        const ik = intentKey([DEMO_PROPERTY, q.q, '2826', 'en', device, week]);
        const taskId = sha256Hex(`${ik}|${day}`).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
        const rank = Math.round(q.pos + 2);
        const ours = { rankAbsolute: rank, url: q.page, title: titles.get(q.page) ?? q.q };
        const organic = COMPETITORS.map((dom, k) => ({ rankAbsolute: k + 1 + (k + 1 >= rank ? 1 : 0), domain: dom, url: `https://${dom}/${q.q.replace(/ /g, '-')}`, title: `${q.q} (${dom})` }));
        organic.push({ rankAbsolute: rank, domain: 'pipewell-plumbing.example', url: q.page, title: ours.title });
        organic.sort((a, b) => a.rankAbsolute - b.rankAbsolute);
        const cites = q.kind === 'aio_c';
        const aio = q.kind === 'control' ? null : {
          async: false,
          citesUs: cites,
          refs: [
            ...(cites ? [{ domain: 'pipewell-plumbing.example', url: q.page, title: ours.title, source: SITE_NAME }] : []),
            ...COMPETITORS.slice(0, 3).map((dom) => ({ domain: dom, url: `https://${dom}/${q.q.replace(/ /g, '-')}`, title: q.q, source: null })),
          ],
        };
        list.push({
          intentKey: ik, taskId, keyword: q.q, device, locationCode: 2826, languageCode: 'en', isoWeek: week, observedAt: `${day}T15:00:00Z`,
          design: 'census', pi: 1, itemTypes: aio ? ['ai_overview', 'organic'] : ['organic'], aio, organic: organic.slice(0, 10), ours,
        });
      }
    }
    byWeek.set(monday, list);
  }
  return byWeek;
}

/** Google Search status incidents in the demo history (copied from the bundled seed, same ids), plus num=100. */
const EVENTS: [string, GoogleEvent['service'], GoogleEvent['kind'], string, string, string | null][] = [
  ['wNcefVMLpVGGoFLzgMEg', 'Serving', 'outage', "There's an ongoing issue with serving Google Lens, Discover, and Voice Search.", '2025-06-12T18:00:00Z', '2025-06-12T20:30:00Z'],
  ['rX6zGEp9vJJxxrY16g4A', 'Indexing', 'outage', 'Google Search is experiencing an indexing issue', '2025-06-12T23:54:00Z', '2025-06-13T05:15:00Z'],
  ['riq1AuqETW46NfBCe5NT', 'Ranking', 'core', 'June 2025 core update', '2025-06-30T14:30:00Z', '2025-07-17T08:00:00Z'],
  ['a7Aainy6E9rZsmfq82xt', 'Ranking', 'spam', 'August 2025 spam update', '2025-08-26T16:00:00Z', '2025-09-22T07:00:00Z'],
  ['pW6WN7Ymo49q7z8pKk9w', 'Serving', 'outage', 'Serving is experiencing an ongoing issue', '2025-10-03T20:00:00Z', '2025-10-06T20:40:00Z'],
  ['DsirqJ1gpPRgVQeccPRv', 'Ranking', 'core', 'December 2025 core update', '2025-12-11T17:25:00Z', '2025-12-29T19:00:00Z'],
  ['mYbNTqV1ytDc2fA8hUz4', 'Ranking', 'discover', 'February 2026 Discover update', '2026-02-05T17:00:00Z', '2026-02-27T10:00:00Z'],
  ['TZF4pLmbzFdoBPP6o3iv', 'Serving', 'outage', 'Serving was experiencing an issue', '2026-02-25T03:55:00Z', '2026-02-25T04:10:00Z'],
  ['VbnSXAH4SmEcxPtx4YSD', 'Ranking', 'spam', 'March 2026 spam update', '2026-03-24T19:00:00Z', '2026-03-25T14:30:00Z'],
  ['7eTbAa2jWdToLkraZj5y', 'Ranking', 'core', 'March 2026 core update', '2026-03-27T09:00:00Z', '2026-04-08T13:00:00Z'],
  ['wdAXJk6LRRihEjpzEeWE', 'Ranking', 'core', 'May 2026 core update', '2026-05-21T15:40:00Z', '2026-06-02T12:40:00Z'],
  ['YUX1peHev5a4fkxLDiUQ', 'Ranking', 'spam', 'June 2026 spam update', '2026-06-24T16:00:00Z', '2026-06-26T17:00:00Z'],
  ['LEubPCm2octf2uMqCFKE', 'Ranking', 'spam', 'August 2026 spam update', '2026-08-18T16:27:00Z', '2026-08-21T08:49:00Z'],
  ['XhUDXP7A67iHCD2kmbVu', 'Ranking', 'spam', 'September 2026 spam update', '2026-09-24T16:15:00Z', null],
];

function googleEvents(): GoogleEvent[] {
  const out: GoogleEvent[] = EVENTS.map(([id, service, kind, title, begin, end]) => ({
    id, source: 'seed', service, kind, title, begin, end, endEstimated: end === null, url: `https://status.search.google.com/incidents/${id}`, modified: null,
  }));
  out.push({
    id: 'curated-num100-2025-09', source: 'curated', service: 'Reporting', kind: 'data_anomaly',
    title: 'Google stopped honouring the &num=100 results parameter. Many sites saw desktop impressions fall and average position improve in Search Console from mid-September 2025, with no change in real traffic.',
    begin: '2025-09-10T00:00:00Z', end: '2025-09-16T00:00:00Z', endEstimated: true, url: 'https://support.google.com/webmasters/answer/6211453', modified: null,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const meta = (kind: PartitionMeta['kind'], runId: string, fetchedAt: string, extra: Partial<PartitionMeta> = {}): PartitionMeta => ({
  kind, schema: 1, property: DEMO_PROPERTY, toolVersion: TOOL_VERSION, runId, fetchedAt, ...extra,
});

export function demoTruth(): { truth: DemoTruth; expectations: DemoExpectation[] } {
  const expectations: DemoExpectation[] = [
    { kind: 'update_impact', unitKey: 'site', real: 'signal', cause: null, eventId: 'DsirqJ1gpPRgVQeccPRv', note: 'December 2025 core update: clicks fell, a real change' },
    { kind: 'update_impact', unitKey: 'site', real: 'unclear', cause: null, eventId: '7eTbAa2jWdToLkraZj5y', failedCheck: 'competing_events', note: 'March 2026 core update overlaps the March 2026 spam update' },
    { kind: 'site_change_impact', unitKey: '/blog/*', real: 'signal', cause: 'site_change', tauRange: [-0.4, -0.2], synthesis: 'site_change', note: 'New blog title template on 40 posts' },
    { kind: 'waterfall', unitKey: '/blog/*', real: 'signal', realAnyOf: ['signal', 'underpowered'], cause: 'site_change', note: 'The blog section points at the title change' },
    { kind: 'aio_effect', unitKey: 'site', real: 'signal', cause: 'ai_overview', tauRange: [-0.45, -0.15], estimator: 'did', note: 'AI Overviews on 30 uncited how-to searches' },
    { kind: 'waterfall', unitKey: DEMO_ORIGIN, real: 'noise', cause: null, note: 'Homepage: a noise week inside the normal range' },
    { kind: 'waterfall', unitKey: DEMO_THIN_PAGE, real: 'underpowered', cause: null, needsMde: true, note: 'A thin page with a -40% move' },
  ];
  return { truth: { property: DEMO_PROPERTY, dataThrough: DEMO_DATA_THROUGH, expect: expectations }, expectations };
}

export async function writeDemoFixture(store: DataStore): Promise<DemoTruth> {
  return writeDemoFixtureSeeded(store, SEED);
}

/** The same fixture from another seed (robustness checks: the planted story should come back for most seeds). */
export async function writeDemoFixtureSeeded(store: DataStore, seed: string): Promise<DemoTruth> {
  const rng = rngFor(seed, 'gsc');
  const site = buildSite(rngFor(seed, 'site'));
  const byUrl = new Map(site.pages.map((p) => [p.url, p]));

  // config.json and meta.json are left to the caller (the demo command writes both, with crawling
  // and URL inspection off); every partition carries the property in its meta line.
  // Days are generated in order (one random stream), then written a batch at a time: each write is
  // atomic and fsynced by the store, so overlapping them keeps the demo fast on real disks.
  let batch: Promise<unknown>[] = [];
  for (const d of dateRange(DEMO_START, DEMO_DATA_THROUGH)) {
    const rows = generateDay(d, site, byUrl, rng);
    const count = (s: string): number => rows.filter((r) => r.s === s).length;
    const slices = Object.fromEntries((['t', 'td', 'tc', 'p', 'qpd'] as const).map((s) => [s, { rows: count(s), truncated: false }]));
    batch.push(store.writePartition(layout.gscDay(d), meta('gsc_day', RUN.gsc, DEMO_NOW, { day: d, revision: 1, dataState: 'final', slices }), rows));
    if (batch.length >= WRITE_BATCH) {
      await Promise.all(batch);
      batch = [];
    }
  }
  await Promise.all(batch);
  // The provisional tail Google has not finalised yet (dashed on the timeline, never analysed).
  const fresh: Row[] = [];
  for (const d of ['2026-10-04', '2026-10-05']) {
    const [t, td1, td2] = generateDay(d, site, byUrl, rng);
    fresh.push({ ...t, date: d }, { ...td1, date: d }, { ...td2, date: d });
  }
  await store.writePartition(layout.gscFresh, meta('gsc_fresh', RUN.gsc, DEMO_NOW, { dataState: 'all' }), fresh);

  const snaps = snapshots(site);
  await store.writePartition(layout.perRun('crawl', RUN.crawl1, '2026-09-08T10:00:00Z'), meta('crawl', RUN.crawl1, '2026-09-08T10:00:00Z', { keyframe: true }), snaps.keyframe);
  await store.writePartition(layout.perRun('crawl', RUN.crawl2, '2026-09-09T10:00:00Z'), meta('crawl', RUN.crawl2, '2026-09-09T10:00:00Z', { keyframe: false }), snaps.delta);
  const insp = inspections(site);
  await store.writePartition(layout.perRun('inspect', RUN.inspect1, '2026-09-08T09:00:00Z'), meta('inspect', RUN.inspect1, '2026-09-08T09:00:00Z'), insp.first);
  await store.writePartition(layout.perRun('inspect', RUN.inspect2, '2026-09-16T09:00:00Z'), meta('inspect', RUN.inspect2, '2026-09-16T09:00:00Z'), insp.second);
  for (const [monday, obs] of serpChecks(site)) {
    const at = `${addDays(monday, 6)}T07:00:00Z`;
    const runId = `r${monday.replace(/-/g, '')}t070000z-de1${monday.slice(-1)}`;
    await store.writePartition(layout.perRun('serp', runId, at), meta('serp', runId, at), obs);
  }
  await store.writePartition(layout.perRun('google', RUN.google, DEMO_NOW), meta('google_events', RUN.google, DEMO_NOW), googleEvents());

  const { truth } = demoTruth();
  await store.writeFileAtomic(TRUTH_FILE, `${JSON.stringify(truth, null, 2)}\n`);
  return truth;
}
