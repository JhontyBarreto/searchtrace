// Test 59: the URL Inspection scheduler. Priorities, the budget across a PT day boundary, the 20 h
// skip, and a 429 that stops inspecting for the day. Also the response mapping and a 403.
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { Clock, Config, DataStore, GoogleAuth, IndexDb, IndexReader, InspectionRecord, RunContext, SiteChange } from '../../src/core/types.js';
import { INSPECT_ENDPOINT, buildQueue, inspectionCollector, toInspectionRecord } from '../../src/sources/google/inspection.js';
import { fakeFetch, fixedClock, memoryIndex, memoryStore, type FakeFetch } from '../helpers/index.js';

const PROPERTY = 'sc-domain:example.com';
const u = (p: string): string => `https://example.com/${p}`;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (h: number): string => new Date(NOW - h * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');

function insp(url: string, inspectedAt: string, lastCrawlTime?: string): InspectionRecord {
  return { url, inspectedAt, reason: 'traffic', verdict: 'PASS', lastCrawlTime };
}

function change(id: string, deployedTo: string, touched: { url: string; seen: boolean }[]): SiteChange {
  return {
    id, source: 'snapshot', field: 'title', cls: 'snippet', templateKey: '/blog/*', signature: `title:x:${id}`,
    deployed: { from: ago(400), to: deployedTo, precision: 'bounded' },
    touched: touched.map((t) => ({ url: t.url, before: 'a', after: 'b', googleSeen: t.seen ? { from: deployedTo, to: deployedTo, precision: 'bounded' } : null })),
    text: null,
  };
}

describe('buildQueue', () => {
  const inspections = [
    insp(u('p0a'), ago(48)),
    insp(u('recent'), ago(10)),
    insp(u('t1'), ago(240)),
    insp(u('t3'), ago(72)),
    insp(u('f1'), ago(96)),
    insp(u('f2'), ago(48)),
  ];
  const input = {
    now: NOW,
    property: PROPERTY,
    budget: 100,
    inspections,
    changes: [
      change('c1', ago(48), [{ url: u('p0a'), seen: false }, { url: u('p0b'), seen: true }, { url: u('recent'), seen: false }]),
      change('c-old', ago(240), [{ url: u('old'), seen: false }]),
    ],
    findingPages: [u('f1'), u('f2'), u('p0a')],
    traffic: new Map([[u('t1'), 50], [u('t2'), 10], [u('t3'), 900], [u('t4'), 500], ['https://other.example/x', 999]]),
    crawled: [u('c1'), u('t2'), u('p0a'), u('f2')],
  };

  it('orders P0, P1, P2, P3 and applies each staleness rule', () => {
    expect(buildQueue(input)).toEqual([
      { url: u('p0a'), reason: 'post_change' },
      { url: u('f1'), reason: 'blast_radius' },
      { url: u('t4'), reason: 'traffic' }, // never inspected comes first; ties go to more impressions
      { url: u('t2'), reason: 'traffic' },
      { url: u('t1'), reason: 'traffic' },
      { url: u('c1'), reason: 'coverage' },
    ]);
  });

  it('skips anything inspected in the last 20 hours, even P0', () => {
    expect(buildQueue(input).some((q) => q.url === u('recent'))).toBe(false);
    const moved = { ...input, now: NOW + 11 * HOUR };
    expect(buildQueue(moved).find((q) => q.url === u('recent'))).toEqual({ url: u('recent'), reason: 'post_change' });
  });

  it('caps the queue at the budget', () => {
    expect(buildQueue({ ...input, budget: 2 }).map((q) => q.reason)).toEqual(['post_change', 'blast_radius']);
    expect(buildQueue({ ...input, budget: 0 })).toEqual([]);
  });
});

describe('toInspectionRecord', () => {
  it('maps indexStatusResult and richResultsResult, normalising canonicals and capping referring URLs', () => {
    const raw = {
      inspectionResult: {
        inspectionResultLink: 'https://search.google.com/...',
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          lastCrawlTime: '2026-10-04T23:22:42.512Z',
          pageFetchState: 'SUCCESSFUL',
          googleCanonical: 'https://Example.com/#top',
          userCanonical: 'https://example.com/',
          crawledAs: 'MOBILE',
          sitemap: ['https://example.com/sitemap.xml'],
          referringUrls: Array.from({ length: 15 }, (_, k) => `https://example.com/r${k}`),
          extra: 'ignored',
        },
        richResultsResult: { verdict: 'PASS', detectedItems: [{ richResultType: 'Breadcrumbs' }, { richResultType: 'FAQ' }, { richResultType: 'Breadcrumbs' }] },
      },
    };
    const r = toInspectionRecord(raw, u(''), '2026-10-06T12:00:00Z', 'traffic');
    expect(r).toEqual({
      url: u(''),
      inspectedAt: '2026-10-06T12:00:00Z',
      reason: 'traffic',
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      indexingState: 'INDEXING_ALLOWED',
      robotsTxtState: 'ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: '2026-10-04T23:22:42Z',
      googleCanonical: 'https://example.com/',
      userCanonical: 'https://example.com/',
      crawledAs: 'MOBILE',
      sitemaps: ['https://example.com/sitemap.xml'],
      referringUrls: Array.from({ length: 10 }, (_, k) => `https://example.com/r${k}`),
      richResults: { verdict: 'PASS', types: ['Breadcrumbs', 'FAQ'] },
    });
    expect(toInspectionRecord({ nope: true }, u(''), '2026-10-06T12:00:00Z', 'traffic')).toBeNull();
  });
});

// ---------- the collector ----------

const google: GoogleAuth = { kind: 'service_account', principal: 'robot@project.iam.gserviceaccount.com', scopes: [], headers: async () => ({ authorization: 'Bearer test-token-value' }) };

function context(o: { clock: Clock; store: DataStore; index: IndexReader; ff: FakeFetch; config?: Config }): RunContext {
  const index: IndexDb = { ...o.index, sync: async () => ({ loaded: 0, skipped: 0, removed: 0 }), close: () => undefined };
  const silent = (): void => undefined;
  return {
    runId: 'r20261006t083000z-0001',
    startedAt: o.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    toolVersion: '0.1.0',
    config: o.config ?? ConfigSchema.parse({ version: 1, property: PROPERTY, inspection: { dailyBudget: 50 } }),
    store: o.store,
    index,
    clock: o.clock,
    fetch: o.ff.fetch,
    log: { info: silent, warn: silent, error: silent, debug: silent, progress: silent },
    secrets: createSecretRegistry({ ci: false }),
    signal: new AbortController().signal,
    flags: { dryRun: false, offline: false, noPaid: false, ci: false, yes: false, interactive: false, budgetUsd: null, waitMinutes: 0, credentials: null, forceGraph: false },
    google,
    env: {},
  };
}

function trafficIndex(n: number): IndexReader {
  const p = Array.from({ length: n }, (_, k) => ({ date: '2026-10-01', p: u(`page-${k}`), c: 1, i: 100 - k, ps: 500 }));
  return memoryIndex({ property: PROPERTY, p, t: [{ date: '2026-10-01', c: n, i: 1000, ps: 5000 }] });
}

const OK_BODY = { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-04T23:22:42Z' } } };

describe('inspectionCollector', () => {
  it('spends only what is left of the Pacific Time day', async () => {
    const store = memoryStore();
    await store.append('inspect', { at: '2026-10-05T20:00:00Z', runId: 'r20261005t200000z-0001', ptDay: '2026-10-05', count: 50 });
    // 06:59Z on 6 Oct is 23:59 on 5 Oct in Pacific Time: the day's 50 checks are used.
    const before = context({ clock: fixedClock('2026-10-06T06:59:00Z'), store, index: trafficIndex(8), ff: fakeFetch([]) });
    const p1 = await inspectionCollector.plan(before);
    expect(p1.skip).toMatch(/All 50 index checks for today are used/);
    // Two minutes later it is a new Pacific Time day.
    await store.append('inspect', { at: '2026-10-06T07:00:30Z', runId: 'r20261006t070000z-0001', ptDay: '2026-10-06', count: 45 });
    const after = context({ clock: fixedClock('2026-10-06T07:01:00Z'), store, index: trafficIndex(8), ff: fakeFetch([]) });
    const p2 = await inspectionCollector.plan(after);
    expect(p2.skip).toBeNull();
    expect(p2.payload.budget).toBe(5);
    expect(p2.payload.queue).toHaveLength(5);
    expect(p2.payload.queue.every((q) => q.reason === 'traffic')).toBe(true);
    expect(p2.lines[0]).toEqual({ group: 'free', label: 'Index checks', detail: '5 pages, 50 of your 2,000 daily checks' });
  });

  it('stops for the day on a 429 and records it', async () => {
    const store = memoryStore();
    const ff = fakeFetch([
      {
        method: 'POST',
        url: INSPECT_ENDPOINT,
        reply: (_req, n) => (n < 2 ? { body: OK_BODY } : { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } }),
      },
    ]);
    const ctx = context({ clock: fixedClock('2026-10-06T08:30:00Z'), store, index: trafficIndex(6), ff });
    const plan = await inspectionCollector.plan(ctx);
    expect(plan.payload.queue).toHaveLength(6);
    const res = await inspectionCollector.execute(plan, ctx);
    expect(res.status).toBe('deferred');
    expect(res.rows).toBe(2);
    expect(ff.calls.length).toBeGreaterThanOrEqual(3);
    expect(ff.calls.length).toBeLessThanOrEqual(4);
    const asked = ff.calls.map((c) => c.json<{ inspectionUrl: string; siteUrl: string; languageCode: string }>());
    expect(asked[0]).toEqual({ inspectionUrl: u('page-0'), siteUrl: PROPERTY, languageCode: 'en-US' });
    expect(asked.some((b) => b.inspectionUrl === u('page-5'))).toBe(false);
    expect(ff.calls[0].headers.authorization).toBe('Bearer test-token-value');
    expect(await store.readLedger('inspect')).toEqual([{ at: '2026-10-06T08:30:00Z', runId: ctx.runId, ptDay: '2026-10-06', count: 2 }]);
    expect(await store.readLedger('events')).toEqual([expect.objectContaining({ type: 'deferred', day: '2026-10-06' })]);
    const part = await store.readPartition<InspectionRecord>(res.partitions[0]);
    expect(part.meta).toMatchObject({ kind: 'inspect', schema: 1, property: PROPERTY, runId: ctx.runId });
    expect(part.rows.map((r) => r.lastCrawlTime)).toEqual(['2026-10-04T23:22:42Z', '2026-10-04T23:22:42Z']);
    expect(res.notes[0]).toBe('2 of your 2,000 daily checks used');
  });

  it('fails the phase with the Full permission fix on a 403', async () => {
    const store = memoryStore();
    const ff = fakeFetch([{ method: 'POST', url: INSPECT_ENDPOINT, reply: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } } } }]);
    const ctx = context({ clock: fixedClock('2026-10-06T08:30:00Z'), store, index: trafficIndex(1), ff });
    const res = await inspectionCollector.execute(await inspectionCollector.plan(ctx), ctx);
    expect(res.status).toBe('failed');
    expect(res.errors[0].code).toBe('permission');
    expect(res.errors[0].message).toContain(`Give ${google.principal} Full permission on ${PROPERTY} in Search Console`);
    expect(res.partitions).toEqual([]);
  });

  it('refreshes the token once on a 401, then gives up with an auth error on a second 401', async () => {
    let tokens = 0;
    let invalidated = 0;
    const refreshing: GoogleAuth = {
      ...google,
      headers: async () => ({ authorization: `Bearer token-number-${tokens++}` }),
      invalidate: () => {
        invalidated++;
      },
    };
    // The first token is stale; after one refresh every call succeeds.
    const ok = fakeFetch([{ method: 'POST', url: INSPECT_ENDPOINT, reply: (req) => (req.headers.authorization === 'Bearer token-number-0' ? { status: 401, body: { error: { code: 401 } } } : { body: OK_BODY }) }]);
    const ctx = { ...context({ clock: fixedClock('2026-10-06T08:30:00Z'), store: memoryStore(), index: trafficIndex(1), ff: ok }), google: refreshing };
    const res = await inspectionCollector.execute(await inspectionCollector.plan(ctx), ctx);
    expect(res.status).toBe('ok');
    expect(res.rows).toBe(1);
    expect(invalidated).toBe(1);
    // A credential Google keeps refusing fails the phase after exactly one retry.
    const refused = fakeFetch([{ method: 'POST', url: INSPECT_ENDPOINT, reply: { status: 401, body: { error: { code: 401 } } } }]);
    const ctx2 = { ...context({ clock: fixedClock('2026-10-06T08:30:00Z'), store: memoryStore(), index: trafficIndex(1), ff: refused }), google: refreshing };
    const res2 = await inspectionCollector.execute(await inspectionCollector.plan(ctx2), ctx2);
    expect(res2.status).toBe('failed');
    expect(res2.errors[0].code).toBe('auth');
    expect(refused.calls).toHaveLength(2);
  });

  it('skips cleanly when turned off, offline or without a credential', async () => {
    const store = memoryStore();
    const base = context({ clock: fixedClock('2026-10-06T08:30:00Z'), store, index: trafficIndex(1), ff: fakeFetch([]) });
    expect((await inspectionCollector.plan({ ...base, google: null })).skip).toMatch(/no working Google credential/);
    expect((await inspectionCollector.plan({ ...base, flags: { ...base.flags, offline: true } })).skip).toMatch(/offline/);
    const off = ConfigSchema.parse({ version: 1, property: PROPERTY, inspection: { enabled: false } });
    const plan = await inspectionCollector.plan({ ...base, config: off });
    expect(plan.skip).toMatch(/turned off/);
    expect((await inspectionCollector.execute(plan, base)).status).toBe('skipped');
  });
});
