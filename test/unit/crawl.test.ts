// WP-C acceptance: a crawl against a local node:http fixture server (robots, a sitemap index with a
// .xml.gz child, redirects on and off the property, a 304, a challenge page, an oversize page)
// gives the expected outcomes and correct delta and keyframe partitions over three runs.
//
// The property is sc-domain:fixture.example. The test's fetch sends fixture.example requests to
// the local server, so the crawler's private-host guard stays fully on: the crawler only ever sees
// public-looking URLs, and the server's Location headers point at fixture.example (or at blocked
// targets, which must never be requested).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { Config, DataStore, Fetch, IndexDb, PageFields, RunContext, SnapshotRecord } from '../../src/core/types.js';
import { openIndex } from '../../src/index/db.js';
import { crawlCollector, ETAG_CACHE } from '../../src/sources/crawl/crawl.js';
import { deriveSiteChanges } from '../../src/sources/crawl/diff.js';
import { USER_AGENT } from '../../src/sources/crawl/fetcher.js';
import { fakeFetch, manualClock, memoryStore, type ManualClock } from '../helpers/index.js';

const PROPERTY = 'sc-domain:fixture.example';
const ORIGIN = 'https://fixture.example/';
const u = (path: string): string => new URL(path, ORIGIN).href;

// ---------- the fixture site ----------

let server: Server;
let port = 0;
let blogVersion = 1;
const hits = new Map<string, number>();
const conditional: string[] = [];
const userAgents = new Set<string>();

const page = (title: string, body: string, extra = ''): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta property="og:site_name" content="Fixture Plumbing">${extra}</head><body><main><h1>${title}</h1><p>${body}</p><a href="/about">About</a> <a href="/blog/a">A</a></main></body></html>`;

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  hits.set(path, (hits.get(path) ?? 0) + 1);
  userAgents.add(String(req.headers['user-agent']));
  const html = (status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  switch (path) {
    case '/robots.txt':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private/\n\nSitemap: https://fixture.example/sitemap_index.xml\n');
      return;
    case '/sitemap_index.xml':
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://fixture.example/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://fixture.example/sitemap-posts.xml.gz</loc></sitemap>
      </sitemapindex>`);
      return;
    case '/sitemap-pages.xml': {
      const paths = ['/', '/about', '/old-page', '/offsite', '/admin-redirect', '/challenge', '/moment', '/big', '/doc.pdf', '/private/secret', '/gone'];
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset>${paths.map((p) => `<url><loc>https://fixture.example${p}</loc></url>`).join('')}</urlset>`);
      return;
    }
    case '/sitemap-posts.xml.gz':
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync('<urlset><url><loc>https://fixture.example/blog/a</loc></url><url><loc>https://fixture.example/blog/b</loc></url><url><loc>https://elsewhere.example/x</loc></url></urlset>'));
      return;
    case '/':
      html(200, page('Fixture Plumbing', 'Boilers, taps and emergency call outs across the city.'));
      return;
    case '/about':
      if (req.headers['if-none-match'] === '"about-v1"') {
        conditional.push(path);
        res.writeHead(304, { etag: '"about-v1"' });
        res.end();
        return;
      }
      html(200, page('About us', 'A family business since 1990.'), { etag: '"about-v1"' });
      return;
    case '/old-page':
      res.writeHead(301, { location: '/blog/a' });
      res.end();
      return;
    case '/offsite':
      res.writeHead(302, { location: 'https://evil.example/collect' });
      res.end();
      return;
    case '/admin-redirect':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    case '/challenge':
      html(503, '<html><head><title>Attention required</title></head></html>', { 'cf-mitigated': 'challenge' });
      return;
    case '/moment':
      html(200, '<html><head><title>Just a moment...</title></head><body></body></html>');
      return;
    case '/big':
      html(200, page('Big', 'x '.repeat(40_000)));
      return;
    case '/doc.pdf':
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7 fake');
      return;
    case '/gone':
      html(404, page('Not found', 'Nothing here.'));
      return;
    case '/blog/a':
      html(200, page(blogVersion === 1 ? 'Fixing a leaky tap | Fixture' : 'Fixing a leaky tap - Fixture', 'Turn off the water first, then remove the handle.'));
      return;
    case '/blog/b':
      html(200, page('Bleeding a radiator | Fixture', 'You need a radiator key and a cloth.'));
      return;
    default:
      html(404, 'not found');
  }
}

/** Sends fixture.example requests to the local server; anything else must never be fetched. */
const blockedRequests: string[] = [];
const fixtureFetch: Fetch = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
  const target = new URL(String(input));
  if (target.hostname !== 'fixture.example' && target.hostname !== 'www.fixture.example') {
    blockedRequests.push(target.href);
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  }
  const res = await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
  Object.defineProperty(res, 'url', { value: target.href });
  return res;
}) as Fetch;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------- run context ----------

function config(): Config {
  const base = ConfigSchema.parse({ version: 1, property: PROPERTY });
  // Faster than real politeness settings; the schema floor (250 ms) applies to real configs.
  return { ...base, crawl: { ...base.crawl, delayMs: 2, timeoutMs: 5000, maxBytes: 50_000, concurrency: 2 } };
}

function runIdAt(clock: ManualClock, n: number): string {
  const iso = clock.now().toISOString();
  return `r${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}t${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}z-000${n}`;
}

function context(store: DataStore, index: IndexDb, clock: ManualClock, n: number): RunContext {
  const silent = (): void => undefined;
  return {
    runId: runIdAt(clock, n),
    startedAt: clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    toolVersion: '0.1.0',
    config: config(),
    store,
    index,
    clock,
    fetch: fixtureFetch,
    log: { info: silent, warn: silent, error: silent, debug: silent, progress: silent },
    secrets: createSecretRegistry({ ci: false }),
    signal: new AbortController().signal,
    flags: { dryRun: false, offline: false, noPaid: false, ci: false, yes: false, interactive: false, budgetUsd: null, waitMinutes: 0, credentials: null, forceGraph: false },
    google: null,
    env: {},
  };
}

async function crawlOnce(store: DataStore, index: IndexDb, clock: ManualClock, n: number) {
  const ctx = context(store, index, clock, n);
  const plan = await crawlCollector.plan(ctx);
  const result = await crawlCollector.execute(plan, ctx);
  await index.sync(store);
  const records = result.partitions.length ? await store.readPartition<SnapshotRecord>(result.partitions[0]) : null;
  const byUrl = new Map((records?.rows ?? []).map((r) => [r.url, r]));
  return { plan, result, meta: records?.meta, byUrl };
}

describe('crawl against a local fixture server', () => {
  const store = memoryStore();
  const clock = manualClock('2026-10-01T10:00:00Z');
  let index: IndexDb;

  beforeAll(async () => {
    index = await openIndex(':memory:');
  });
  afterAll(() => index.close());

  it('run 1 (first of the month): keyframe partition with every expected outcome', async () => {
    const { plan, result, meta, byUrl } = await crawlOnce(store, index, clock, 1);
    expect(plan.skip).toBeNull();
    expect(result.status).toBe('ok');
    expect(result.partitions[0]).toBe(`crawl/2026/10/${runIdAt(clock, 1)}.ndjson.gz`);
    expect(meta).toMatchObject({ kind: 'crawl', schema: 1, property: PROPERTY, keyframe: true });

    const outcome = (path: string): string | undefined => byUrl.get(u(path))?.outcome;
    expect(outcome('/')).toBe('ok');
    expect(outcome('/about')).toBe('ok');
    expect(outcome('/blog/a')).toBe('ok');
    expect(outcome('/blog/b')).toBe('ok');
    expect(outcome('/old-page')).toBe('ok');
    expect(byUrl.get(u('/old-page'))).toMatchObject({ redirects: [u('/blog/a')], finalUrl: u('/blog/a'), status: 200 });
    expect(outcome('/offsite')).toBe('off_property');
    expect(outcome('/admin-redirect')).toBe('off_property');
    expect(outcome('/challenge')).toBe('blocked_challenge');
    expect(outcome('/moment')).toBe('blocked_challenge');
    expect(outcome('/big')).toBe('too_large');
    expect(outcome('/doc.pdf')).toBe('not_html');
    expect(outcome('/gone')).toBe('http_error');
    expect(outcome('/private/secret')).toBe('robots_disallowed');
    expect(byUrl.has('https://elsewhere.example/x')).toBe(false);

    // Keyframe: every ok record carries its fields; failures carry none.
    for (const r of byUrl.values()) {
      if (r.outcome === 'ok') {
        expect(r.fields).toBeDefined();
        expect(r.fieldsHash).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(r.fields).toBeUndefined();
        expect(r.fieldsHash).toBeNull();
      }
    }
    expect((byUrl.get(u('/'))?.fields as PageFields).siteName).toBe('Fixture Plumbing');

    // Safety: blocked targets were never requested, robots-disallowed pages never fetched.
    expect(blockedRequests).toEqual([]);
    expect(hits.get('/private/secret')).toBeUndefined();
    expect([...userAgents]).toEqual([USER_AGENT]);
    expect(result.requests['crawl.sitemap']).toBe(3);
    expect(result.notes[0]).toBe('5 pages saved · first snapshot, changes can be dated from the next run');
    expect(result.rows).toBe(13);
    expect(result.notes).toContain('1 page is blocked by robots.txt, so it was skipped.');
    expect(await store.readFile(ETAG_CACHE)).toContain('about-v1');
  });

  it('skips a second crawl within crawl.minHoursBetween', async () => {
    clock.advance(3 * 3_600_000);
    const plan = await crawlCollector.plan(context(store, index, clock, 9));
    expect(plan.skip).toMatch(/at most once every 20 hours/);
    expect((await crawlCollector.execute(plan, context(store, index, clock, 9))).status).toBe('skipped');
  });

  it('run 2 (same month): a delta partition with a 304 and one changed page', async () => {
    clock.set('2026-10-02T09:00:00Z');
    blogVersion = 2;
    const before = await store.readPartition<SnapshotRecord>(`crawl/2026/10/r20261001t100000z-0001.ndjson.gz`);
    const firstHash = new Map(before.rows.map((r) => [r.url, r.fieldsHash]));
    const { result, meta, byUrl } = await crawlOnce(store, index, clock, 2);
    expect(result.status).toBe('ok');
    expect(meta?.keyframe).toBe(false);

    const about = byUrl.get(u('/about'));
    expect(about).toMatchObject({ outcome: 'not_modified', status: 304, fieldsHash: firstHash.get(u('/about')) });
    expect(about?.fields).toBeUndefined();
    expect(conditional).toEqual(['/about']);

    const home = byUrl.get(u('/'));
    expect(home).toMatchObject({ outcome: 'ok', fieldsHash: firstHash.get(u('/')) });
    expect(home?.fields).toBeUndefined(); // unchanged, so a delta record

    const blogA = byUrl.get(u('/blog/a'));
    expect(blogA?.outcome).toBe('ok');
    expect(blogA?.fieldsHash).not.toBe(firstHash.get(u('/blog/a')));
    expect(blogA?.fields?.title).toBe('Fixing a leaky tap - Fixture');
    expect(result.notes[0]).toBe('5 pages saved · 2 changed since the last snapshot'); // /blog/a and /old-page (redirects to it)

    // The index replays the delta: the edit is seen on both URLs that serve /blog/a.
    const changes = deriveSiteChanges({
      snapshots: index.snapshots(),
      fieldsByHash: index.fieldsByHash(),
      annotations: [],
      inspections: [],
      templates: new Map(),
    });
    // The fixture's h1 repeats the title, so the edit shows up as a title change and an h1 change.
    expect(changes.map((c) => [c.field, c.cls, c.signature]).sort()).toEqual([
      ['h1', 'content', 'h1:|->-:other pages'],
      ['title', 'snippet', 'title:|->-:other pages'],
    ]);
    for (const c of changes) expect(c.touched.map((t) => t.url)).toEqual([u('/blog/a'), u('/old-page')]);
  });

  it('run 3 (new month): a keyframe again, with fields on every saved record including 304s', async () => {
    clock.set('2026-11-01T12:00:00Z');
    const { meta, byUrl } = await crawlOnce(store, index, clock, 3);
    expect(meta?.keyframe).toBe(true);
    const about = byUrl.get(u('/about'));
    expect(about?.outcome).toBe('not_modified');
    expect(about?.fields?.title).toBe('About us');
    for (const r of byUrl.values()) if (r.outcome === 'ok' || r.outcome === 'not_modified') expect(r.fields).toBeDefined();
  });
});

describe('crawl edge cases (fake fetch)', () => {
  const html = { 'content-type': 'text/html' };

  async function runWith(ff: ReturnType<typeof fakeFetch>, over: (c: Config) => Config = (c) => c) {
    const store = memoryStore();
    const index = await openIndex(':memory:');
    const clock = manualClock('2026-10-01T10:00:00Z');
    const ctx = { ...context(store, index, clock, 1), fetch: ff.fetch };
    const cfg = over(ctx.config);
    const plan = await crawlCollector.plan({ ...ctx, config: cfg });
    const result = await crawlCollector.execute(plan, { ...ctx, config: cfg });
    const rows = result.partitions.length ? (await store.readPartition<SnapshotRecord>(result.partitions[0])).rows : [];
    index.close();
    return { plan, result, rows };
  }

  it('fetches no pages when robots.txt answers with a server error, and reports partial', async () => {
    const ff = fakeFetch([{ url: 'https://fixture.example/robots.txt', reply: { status: 503 } }]);
    const { result, rows } = await runWith(ff);
    expect(result.status).toBe('partial');
    expect(rows.map((r) => [r.url, r.outcome])).toEqual([[ORIGIN, 'robots_disallowed']]);
    expect(ff.calls.map((c) => c.url)).toEqual(['https://fixture.example/robots.txt']);
    expect(result.notes.join(' ')).toMatch(/robots\.txt at https:\/\/fixture\.example\/ could not be read/);
  });

  it('falls back to the www origin when the bare domain does not answer', async () => {
    const ff = fakeFetch([
      { url: /^https:\/\/fixture\.example\//, reply: { error: 'refused' } },
      { url: 'https://www.fixture.example/robots.txt', reply: { status: 404 } },
      { url: 'https://www.fixture.example/', reply: { headers: html, body: '<html><title>Home</title></html>' } },
      { url: /^https:\/\/www\.fixture\.example\/sitemap/, reply: { status: 404 } },
    ]);
    const { result, rows } = await runWith(ff);
    expect(result.status).toBe('ok');
    expect(rows.map((r) => [r.url, r.outcome])).toEqual([['https://www.fixture.example/', 'ok']]);
    expect(result.notes[0]).toBe('1 page saved · first snapshot, changes can be dated from the next run');
    // The homepage probe is reused as the homepage snapshot: fetched once.
    expect(ff.callsTo('https://www.fixture.example/')).toHaveLength(1);
  });

  it('skips when turned off or offline', async () => {
    const off = await runWith(fakeFetch([]), (c) => ({ ...c, crawl: { ...c.crawl, enabled: false } }));
    expect(off.plan.skip).toMatch(/turned off/);
    expect(off.result.status).toBe('skipped');
    const store = memoryStore();
    const index = await openIndex(':memory:');
    const ctx = context(store, index, manualClock('2026-10-01T10:00:00Z'), 1);
    expect((await crawlCollector.plan({ ...ctx, flags: { ...ctx.flags, offline: true } })).skip).toMatch(/offline/);
    index.close();
  });
});
