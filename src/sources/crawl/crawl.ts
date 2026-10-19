// crawlCollector: URL set, frequency gate, delta and keyframe snapshot partitions (4.4). Owner: WP-C.
//
// One run: pick the origin (config.siteOrigin, or the first default origin whose homepage lands
// on the property), read robots.txt per origin (RFC 9309), collect sitemap URLs (robots Sitemap:
// lines, else /sitemap.xml then /sitemap_index.xml; indexes and .xml.gz, at most 3 levels and 50
// files), add Search Console pages with impressions in the last 90 days, rank by impressions and
// cap at crawl.maxUrls. Each page is fetched politely (crawl.concurrency in flight, at least
// crawl.delayMs or the robots Crawl-delay between requests to one host, conditional GET from
// state/cache/etags.json) and stored as a SnapshotRecord. fields are written only when the
// fields hash differs from the URL's previous snapshot, or in the month's keyframe partition.
// The crawl is never fatal: problems become outcomes, notes and a partial phase.
import { StError } from '../../core/errors.js';
import { addDays } from '../../core/time.js';
import type {
  Collector,
  CollectorPlan,
  CrawlPlan,
  FetchOutcome,
  PageFields,
  PartitionMeta,
  PhaseResult,
  RunContext,
  SnapshotRecord,
} from '../../core/types.js';
import { defaultOrigins, isOnProperty, normalizeUrl, pathOf } from '../../core/url.js';
import { createLimiter } from '../../http/limiter.js';
import { layout } from '../../store/layout.js';
import { extractFields, fieldsHashOf } from './extract.js';
import { USER_AGENT, fetchPage, guardedGet, loadRobots, originPort, urlAllowed, type PageFetch, type ResolveHost, type RobotsResult } from './fetcher.js';
import { isAllowed } from './robots.js';
import { parseSitemapXml } from './sitemap.js';

const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const ETAG_CACHE = `${layout.cacheDir}/etags.json`;
const GSC_LOOKBACK_DAYS = 90;
const MAX_SITEMAPS = 50;
const MAX_SITEMAP_DEPTH = 3;
const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
const MAX_SITEMAP_URLS = 50_000;
const MAX_CRAWL_DELAY_MS = 10_000;

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  fieldsHash: string;
}

class RobotsBlocked extends Error {}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function safeNormalize(u: string): string | null {
  try {
    return normalizeUrl(u);
  } catch {
    return null;
  }
}

function originOf(url: string): string {
  return `${new URL(url).origin}/`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal.aborted) {
      reject(new StError('network', 'The crawl was cancelled.'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new StError('network', 'The crawl was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Spaces request starts to one host by at least its delay, first come first served. */
function createPacer(defaultDelayMs: number, signal: AbortSignal): { wait(url: string): Promise<void>; setDelay(host: string, ms: number): void } {
  const nextAt = new Map<string, number>();
  const delays = new Map<string, number>();
  return {
    async wait(url: string) {
      const host = new URL(url).host;
      const now = Date.now();
      const at = Math.max(now, nextAt.get(host) ?? 0);
      nextAt.set(host, at + (delays.get(host) ?? defaultDelayMs));
      await sleep(at - now, signal);
    },
    setDelay(host: string, ms: number) {
      delays.set(host, Math.max(defaultDelayMs, Math.min(MAX_CRAWL_DELAY_MS, ms)));
    },
  };
}

/** Search Console pages (normalised, on the property) with their impressions over the last 90 sealed days. */
function gscImpressions(ctx: RunContext): Map<string, number> {
  const out = new Map<string, number>();
  const through = ctx.index.dataRange().sealedThrough;
  if (!through) return out;
  for (const r of ctx.index.pageDaily(addDays(through, -(GSC_LOOKBACK_DAYS - 1)), through)) {
    const u = safeNormalize(r.p);
    if (!u || !isOnProperty(u, ctx.config.property)) continue;
    out.set(u, (out.get(u) ?? 0) + r.i);
  }
  return out;
}

/** Ranked by impressions (descending), then URL; capped. The homepage, when given, always comes first. */
function rankUrls(candidates: Map<string, number>, cap: number, homepage: string | null): string[] {
  const ranked = [...candidates.entries()].filter(([u]) => u !== homepage).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([u]) => u);
  const all = homepage ? [homepage, ...ranked] : ranked;
  return all.slice(0, Math.max(0, cap));
}

async function lastCrawlPartition(ctx: RunContext): Promise<{ path: string; fetchedAt: string | null } | null> {
  const files = (await ctx.store.list('crawl/')).filter((f) => f.path.endsWith('.ndjson.gz'));
  const last = files[files.length - 1];
  if (!last) return null;
  try {
    const { meta } = await ctx.store.readPartition(last.path);
    return { path: last.path, fetchedAt: typeof meta.fetchedAt === 'string' ? meta.fetchedAt : null };
  } catch {
    return { path: last.path, fetchedAt: null };
  }
}

function partitionFolder(ctx: RunContext): string {
  const path = layout.perRun('crawl', ctx.runId, ctx.startedAt);
  return path.slice(0, path.lastIndexOf('/') + 1);
}

async function isKeyframe(ctx: RunContext): Promise<boolean> {
  return (await ctx.store.list(partitionFolder(ctx))).every((f) => !f.path.endsWith('.ndjson.gz'));
}

function skipPlan(origin: string, reason: string): CollectorPlan<CrawlPlan> {
  return {
    lines: [{ group: 'free', label: 'Your pages', detail: reason }],
    estRequests: 0,
    estUsd: 0,
    payload: { origin, urls: [], keyframe: false },
    skip: reason,
  };
}

async function plan(ctx: RunContext): Promise<CollectorPlan<CrawlPlan>> {
  const c = ctx.config.crawl;
  const origin = ctx.config.siteOrigin ?? defaultOrigins(ctx.config.property)[0] ?? '';
  if (!c.enabled) return skipPlan(origin, 'Page snapshots are turned off (crawl.enabled is false).');
  if (ctx.flags.offline) return skipPlan(origin, 'Skipped in offline mode.');
  const last = await lastCrawlPartition(ctx);
  if (last?.fetchedAt) {
    const hours = (ctx.clock.now().getTime() - Date.parse(last.fetchedAt)) / 3_600_000;
    if (hours >= 0 && hours < c.minHoursBetween) {
      const h = Math.max(1, Math.round(hours));
      return skipPlan(origin, `Pages were saved ${h} hour${h === 1 ? '' : 's'} ago; they are saved at most once every ${c.minHoursBetween} hours.`);
    }
  }
  const home = safeNormalize(origin);
  const urls = rankUrls(gscImpressions(ctx), c.maxUrls, home);
  const recent = new Set(
    ctx.index.snapshots({ since: iso(new Date(ctx.clock.now().getTime() - 7 * 86_400_000)) }).map((s) => s.url),
  );
  const est = Math.min(c.maxUrls, Math.max(urls.length, recent.size, 1));
  // Before the first run nothing is known but the homepage: the sitemap is only read when the crawl starts.
  const firstRun = urls.length <= 1 && recent.size === 0;
  // Pages are spaced delayMs apart on one host, so concurrency doesn't shorten this much.
  const minutes = Math.max(1, Math.ceil(((firstRun ? c.maxUrls : est) * Math.max(c.delayMs, 1)) / 60_000));
  const count = firstRun
    ? `up to ${groupDigits(c.maxUrls)} pages (your sitemap is read when the run starts)`
    : `${groupDigits(est)} page${est === 1 ? '' : 's'}`;
  return {
    lines: [{ group: 'free', label: 'Your pages', detail: `${count}, ${c.concurrency} at a time, ${firstRun ? 'up to' : 'about'} ${minutes} minute${minutes === 1 ? '' : 's'}` }],
    estRequests: est + 3,
    estUsd: 0,
    payload: { origin, urls, keyframe: await isKeyframe(ctx) },
    skip: null,
  };
}

async function readCache(ctx: RunContext): Promise<Record<string, CacheEntry>> {
  try {
    const text = await ctx.store.readFile(ETAG_CACHE);
    if (!text) return {};
    const parsed = JSON.parse(text, (k, v: unknown) => (k === '__proto__' ? undefined : v)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, CacheEntry> = Object.create(null) as Record<string, CacheEntry>;
    for (const [url, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<CacheEntry> | null;
      if (!e || typeof e.fieldsHash !== 'string') continue;
      out[url] = {
        etag: typeof e.etag === 'string' ? e.etag : null,
        lastModified: typeof e.lastModified === 'string' ? e.lastModified : null,
        fieldsHash: e.fieldsHash,
      };
    }
    return out;
  } catch {
    return {};
  }
}

const PROBLEM_NOTES: Partial<Record<FetchOutcome, (n: number) => string>> = {
  robots_disallowed: (n) => `${n} ${n === 1 ? 'page is' : 'pages are'} blocked by robots.txt, so ${n === 1 ? 'it was' : 'they were'} skipped.`,
  blocked_challenge: (n) => `${n} ${n === 1 ? 'page' : 'pages'} answered with a bot check instead of the page, so ${n === 1 ? 'it was' : 'they were'} skipped.`,
  http_error: (n) => `${n} ${n === 1 ? 'page' : 'pages'} returned an error status.`,
  timeout: (n) => `${n} ${n === 1 ? 'page' : 'pages'} took too long to answer.`,
  network_error: (n) => `${n} ${n === 1 ? 'page' : 'pages'} could not be reached.`,
  too_large: (n) => `${n} ${n === 1 ? 'page was' : 'pages were'} bigger than the size limit (crawl.maxBytes).`,
  off_property: (n) => `${n} ${n === 1 ? 'page redirects' : 'pages redirect'} off your site, so the redirect was not followed.`,
  private_address: (n) => `${n} ${n === 1 ? 'page points' : 'pages point'} at a private network address, so ${n === 1 ? 'it was' : 'they were'} not fetched. ` +
    'If that is your own network (split DNS or a hosts-file entry), set crawl.allowPrivateAddresses to true in config.json.',
  not_html: (n) => `${n} ${n === 1 ? 'address is' : 'addresses are'} not a web page (for example a PDF or an image).`,
};

async function execute(p: CollectorPlan<CrawlPlan>, ctx: RunContext): Promise<PhaseResult> {
  const startedAt = iso(ctx.clock.now());
  const requests: Record<string, number> = { 'crawl.page': 0, 'crawl.robots': 0, 'crawl.sitemap': 0 };
  const result = (status: PhaseResult['status'], extra: Partial<PhaseResult> = {}): PhaseResult => ({
    name: 'crawl',
    status,
    startedAt,
    endedAt: iso(ctx.clock.now()),
    requests,
    rows: 0,
    costUsd: 0,
    partitions: [],
    notes: [],
    errors: [],
    ...extra,
  });
  if (p.skip) return result('skipped', { notes: [p.skip] });
  try {
    return await crawl(p.payload, ctx, requests, result);
  } catch (e) {
    const err = e instanceof StError ? e : null;
    const message = ctx.secrets.redact(e instanceof Error ? e.message : String(e));
    return result('failed', {
      notes: ['Page snapshots stopped early. The next run will try again.'],
      errors: [{ code: err?.code ?? 'internal', message }],
    });
  }
}

async function crawl(
  payload: CrawlPlan,
  ctx: RunContext,
  requests: Record<string, number>,
  result: (status: PhaseResult['status'], extra?: Partial<PhaseResult>) => PhaseResult,
): Promise<PhaseResult> {
  const c = ctx.config.crawl;
  const property = ctx.config.property;
  const signal = ctx.signal;
  const inner = ctx.fetch;
  const counted = (kind: string) =>
    (async (input: Parameters<typeof inner>[0], init?: Parameters<typeof inner>[1]) => {
      requests[kind] = (requests[kind] ?? 0) + 1;
      return inner(input, init);
    }) as typeof inner;
  const pageFetch = counted('crawl.page');
  const robotsFetch = counted('crawl.robots');
  const sitemapFetch = counted('crawl.sitemap');
  const pacer = createPacer(c.delayMs, signal);
  const notes: string[] = [];
  // Only the site's own port, and (unless turned off) no host that resolves to a private address.
  const port = originPort(ctx.config.siteOrigin);
  const guard = { ...(port ? { port } : {}), ...(ctx.resolveHost && !c.allowPrivateAddresses ? { resolveHost: ctx.resolveHost } : {}) };

  // robots.txt per origin, loaded once (concurrent callers share the promise).
  const robots = new Map<string, Promise<RobotsResult>>();
  const robotsFor = (origin: string): Promise<RobotsResult> => {
    let r = robots.get(origin);
    if (!r) {
      r = loadRobots(robotsFetch, origin, { property, userAgent: USER_AGENT, timeoutMs: c.timeoutMs, signal, beforeRequest: (u) => pacer.wait(u), ...guard }).then((res) => {
        if (res.rules.crawlDelaySec !== null) pacer.setDelay(new URL(origin).host, res.rules.crawlDelaySec * 1000);
        return res;
      });
      robots.set(origin, r);
    }
    return r;
  };
  const politely = async (u: string): Promise<void> => {
    const r = await robotsFor(originOf(u));
    if (!isAllowed(r.rules, pathOf(u))) throw new RobotsBlocked();
    await pacer.wait(u);
  };
  const pageOpts = { property, userAgent: USER_AGENT, timeoutMs: c.timeoutMs, maxBytes: c.maxBytes, signal, beforeRequest: politely, ...guard };

  // 1. Origin: the first candidate whose homepage lands on the property.
  const candidates = ctx.config.siteOrigin ? [ctx.config.siteOrigin] : defaultOrigins(property);
  let origin: string | null = null;
  let homeProbe: PageFetch | null = null;
  for (const cand of candidates) {
    const home = safeNormalize(cand);
    if (!home || !urlAllowed(home, property, port)) continue;
    // A host that does not answer at all (robots.txt never arrived) is not the site: try the next one.
    const rb = await robotsFor(originOf(home));
    if (rb.state === 'unreachable' && rb.status === null) continue;
    let probe: PageFetch;
    try {
      probe = await fetchPage(pageFetch, home, pageOpts);
    } catch (e) {
      if (e instanceof RobotsBlocked) {
        origin = originOf(home);
        break;
      }
      throw e;
    }
    if (probe.finalUrl && !['off_property', 'timeout', 'network_error'].includes(probe.outcome) && isOnProperty(probe.finalUrl, property)) {
      origin = originOf(probe.finalUrl);
      // Reuse the probe as the homepage snapshot when it was the homepage itself, not a redirect.
      if (probe.redirects.length === 0 && probe.finalUrl === normalizeUrl(origin)) homeProbe = probe;
      break;
    }
  }
  if (!origin) {
    let refused = false;
    for (const r of robots.values()) if ((await r).privateAddress) refused = true;
    return result('partial', {
      notes: [refused
        ? `Your site at ${candidates.join(' or ')} resolves to a private network address, so searchtrace didn't fetch it. ` +
          'If that is your own network (split DNS or a hosts-file entry), set crawl.allowPrivateAddresses to true in config.json.'
        : `Could not reach your site at ${candidates.join(' or ')}. Set siteOrigin in config.json if it lives somewhere else.`],
    });
  }
  const homepage = normalizeUrl(origin);

  // 2. Sitemaps.
  const sitemapUrls = await collectSitemaps(origin, ctx, robotsFor, (u) => pacer.wait(u), sitemapFetch, guard);

  // 3. The URL set.
  const gsc = gscImpressions(ctx);
  const pool = new Map<string, number>();
  const guessedHome = safeNormalize(payload.origin);
  for (const u of payload.urls) {
    const n = safeNormalize(u);
    // The plan's homepage was a guess at the origin; the resolved homepage replaces it.
    if (!n || (n === guessedHome && n !== homepage && !gsc.has(n))) continue;
    if (isOnProperty(n, property)) pool.set(n, gsc.get(n) ?? 0);
  }
  for (const [u, i] of gsc) if (i > 0) pool.set(u, i);
  for (const u of sitemapUrls) if (!pool.has(u)) pool.set(u, gsc.get(u) ?? 0);
  const urls = rankUrls(pool, c.maxUrls, homepage);

  // 4. Previous state: the latest hashed snapshot per URL, known field sets, cached validators.
  const keyframe = await isKeyframe(ctx);
  const latestHash = new Map<string, string>();
  const latestAt = new Map<string, number>();
  for (const s of ctx.index.snapshots({ urls })) {
    const at = Date.parse(s.fetchedAt);
    if (!s.fieldsHash || !(at >= (latestAt.get(s.url) ?? Number.NEGATIVE_INFINITY))) continue;
    latestHash.set(s.url, s.fieldsHash);
    latestAt.set(s.url, at);
  }
  const firstSnapshot = (await lastCrawlPartition(ctx)) === null;
  const knownFields = ctx.index.fieldsByHash();
  const cache = await readCache(ctx);
  const nextCache: Record<string, CacheEntry> = { ...cache };

  // 5. Fetch.
  const records: SnapshotRecord[] = [];
  let changed = 0;
  const sem = createLimiter({ rps: 0, concurrency: c.concurrency });
  const snapshotOne = async (url: string): Promise<void> => {
    if (signal.aborted) return;
    const prevHash = latestHash.get(url) ?? null;
    const cached = cache[url];
    const validators = cached && prevHash && cached.fieldsHash === prevHash && knownFields.has(prevHash) ? cached : null;
    let page: PageFetch;
    try {
      page =
        url === homepage && homeProbe
          ? homeProbe
          : await fetchPage(pageFetch, url, { ...pageOpts, etag: validators?.etag ?? null, lastModified: validators?.lastModified ?? null });
    } catch (e) {
      if (e instanceof RobotsBlocked) {
        records.push({ url, fetchedAt: iso(ctx.clock.now()), outcome: 'robots_disallowed', status: null, finalUrl: null, redirects: [], fieldsHash: null });
        return;
      }
      throw e;
    }
    const base: SnapshotRecord = {
      url,
      fetchedAt: iso(ctx.clock.now()),
      outcome: page.outcome,
      status: page.status,
      finalUrl: page.finalUrl,
      redirects: page.redirects,
      fieldsHash: null,
    };
    if (page.outcome === 'ok' && page.html !== null) {
      const fields: PageFields = { ...extractFields(page.html, page.finalUrl ?? url, property), xRobotsTag: page.xRobotsTag };
      const hash = fieldsHashOf(fields);
      if (prevHash !== null && hash !== prevHash) changed++;
      const withFields = keyframe || hash !== prevHash || !knownFields.has(hash);
      records.push({ ...base, fieldsHash: hash, ...(withFields ? { fields } : {}) });
      if (page.etag || page.lastModified) nextCache[url] = { etag: page.etag, lastModified: page.lastModified, fieldsHash: hash };
      else delete nextCache[url];
      return;
    }
    if (page.outcome === 'not_modified') {
      const hash = validators?.fieldsHash ?? null;
      if (hash === null) {
        records.push({ ...base, outcome: 'http_error' });
        return;
      }
      const fields = keyframe ? knownFields.get(hash) : undefined;
      records.push({ ...base, fieldsHash: hash, ...(fields ? { fields } : {}) });
      return;
    }
    records.push(base);
  };
  let cancelled = false;
  await Promise.all(
    urls.map((u) =>
      sem.run(async () => {
        try {
          await snapshotOne(u);
        } catch (e) {
          if (signal.aborted) {
            cancelled = true;
            return;
          }
          throw e;
        }
      }),
    ),
  );

  // 6. Write the partition (records that would trip the secret guard are left out).
  records.sort((a, b) => cmp(a.url, b.url));
  const safe: SnapshotRecord[] = [];
  let dropped = 0;
  for (const r of records) {
    try {
      ctx.secrets.assertNoSecret(JSON.stringify(r));
      safe.push(r);
    } catch {
      dropped++;
    }
  }
  const partitions: string[] = [];
  if (safe.length > 0) {
    const meta: PartitionMeta = {
      kind: 'crawl',
      schema: 1,
      property,
      toolVersion: ctx.toolVersion,
      runId: ctx.runId,
      fetchedAt: iso(ctx.clock.now()),
      keyframe,
    };
    const written = await ctx.store.writePartition(layout.perRun('crawl', ctx.runId, ctx.startedAt), meta, safe);
    partitions.push(written.path);
    try {
      await ctx.store.writeFileAtomic(ETAG_CACHE, `${JSON.stringify(nextCache)}\n`);
    } catch {
      // the cache only saves bandwidth; losing it is harmless
    }
  }

  // 7. Notes.
  const saved = safe.filter((r) => r.outcome === 'ok' || r.outcome === 'not_modified').length;
  const savedText = `${saved} ${saved === 1 ? 'page' : 'pages'} saved`;
  const summary = firstSnapshot
    ? `${savedText} · first snapshot, changes can be dated from the next run`
    : `${savedText} · ${changed} changed since the last snapshot`;
  const counts = new Map<FetchOutcome, number>();
  for (const r of safe) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const problemNotes: string[] = [];
  for (const [outcome, note] of Object.entries(PROBLEM_NOTES) as [FetchOutcome, (n: number) => string][]) {
    const n = counts.get(outcome) ?? 0;
    if (n > 0) problemNotes.push(note(n));
  }
  if (dropped > 0) problemNotes.push(`${dropped} ${dropped === 1 ? 'page was' : 'pages were'} left out because ${dropped === 1 ? 'it' : 'they'} contained text that looks like a password or key.`);
  if (cancelled) problemNotes.push('The run was stopped before every page was saved.');
  // robots.txt that could not be read blocks every page of its origin (RFC 9309); say so for origins we crawled.
  const crawledOrigins = new Set(safe.map((r) => originOf(r.url)));
  let robotsUnreachable = false;
  for (const [o, r] of robots) {
    if (!crawledOrigins.has(o) || (await r).state !== 'unreachable') continue;
    robotsUnreachable = true;
    notes.push(`robots.txt at ${o} could not be read, so pages there were not fetched (robots rules say to wait until it answers).`);
  }
  return result(cancelled || robotsUnreachable || safe.length === 0 ? 'partial' : 'ok', {
    rows: safe.length,
    partitions,
    notes: [summary, ...notes, ...problemNotes],
  });
}

async function collectSitemaps(
  origin: string,
  ctx: RunContext,
  robotsFor: (origin: string) => Promise<RobotsResult>,
  pace: (u: string) => Promise<void>,
  fetchFn: RunContext['fetch'],
  guard: { port?: string; resolveHost?: ResolveHost } = {},
): Promise<string[]> {
  const port = guard.port ?? '';
  const property = ctx.config.property;
  const declared = (await robotsFor(origin)).rules.sitemaps
    .map((s) => {
      try {
        return new URL(s, origin).href;
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null);
  const fallbacks = [new URL('/sitemap.xml', origin).href, new URL('/sitemap_index.xml', origin).href];
  const found = new Set<string>();
  const seen = new Set<string>();
  let fetched = 0;

  const walk = async (start: string[]): Promise<void> => {
    const queue = start.map((url) => ({ url, depth: 1 }));
    while (queue.length > 0 && fetched < MAX_SITEMAPS && found.size < MAX_SITEMAP_URLS) {
      const { url, depth } = queue.shift() as { url: string; depth: number };
      const key = safeNormalize(url);
      if (!key || seen.has(key) || !urlAllowed(key, property, port)) continue;
      seen.add(key);
      const rules = (await robotsFor(originOf(key))).rules;
      if (!isAllowed(rules, pathOf(key))) continue;
      fetched++;
      const g = await guardedGet(fetchFn, key, {
        property,
        userAgent: USER_AGENT,
        timeoutMs: ctx.config.crawl.timeoutMs,
        maxBytes: SITEMAP_MAX_BYTES,
        headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
        signal: ctx.signal,
        beforeRequest: pace,
        gunzip: true,
        ...guard,
      });
      if (g.outcome !== 'ok' || g.status === null || g.status < 200 || g.status >= 300) continue;
      const parsed = parseSitemapXml(g.text);
      for (const e of parsed.entries) {
        let loc: string;
        try {
          loc = new URL(e.loc, key).href;
        } catch {
          continue;
        }
        if (parsed.kind === 'index') {
          if (depth < MAX_SITEMAP_DEPTH) queue.push({ url: loc, depth: depth + 1 });
          continue;
        }
        const n = safeNormalize(loc);
        if (n && urlAllowed(n, property, port)) found.add(n);
        if (found.size >= MAX_SITEMAP_URLS) break;
      }
    }
  };

  if (declared.length > 0) {
    await walk(declared);
  } else {
    for (const f of fallbacks) {
      await walk([f]);
      if (found.size > 0) break;
    }
  }
  return [...found];
}

export const crawlCollector: Collector<CrawlPlan> = {
  name: 'crawl',
  plan,
  execute,
};
