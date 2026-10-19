// The spend ledger against id_list when the ledger is behind or the account is busy, plus the
// collector's handling of final task errors and untrusted text, and the price guard.
// Every case runs against the fake DataForSEO account: nothing is sent anywhere, nothing is spent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataStore, IndexReader, PhaseResult, SerpCandidate, SpendEvent } from '../../src/core/types.js';
import { setDfsRatesForTests } from '../../src/sources/dataforseo/client.js';
import { SWEEP_MAX_PAGES, cleanSpendEvents, ourTagPrefix, spendState } from '../../src/sources/dataforseo/reconcile.js';
import { BATCH_SIZE, PROBE_BATCH, priceFor, serpCollectCollector, serpPoster } from '../../src/sources/dataforseo/serp.js';
import { manualClock, memoryIndex, memoryStore, type ManualClock, type MemoryStore } from '../helpers/index.js';
import { dfsConfig, fakeDataForSeo, type FakeDfs, type FakeDfsOptions, type FakeTask, makeCtx, TEST_PROPERTY } from './fake-dataforseo.js';

beforeAll(() => setDfsRatesForTests({ idList: { rps: 1e6, concurrency: 1 }, tasksReady: { rps: 1e6, concurrency: 1 }, taskGet: { rps: 1e6, concurrency: 8 } }));
afterAll(() => setDfsRatesForTests(null));

const INDEX: IndexReader = memoryIndex({
  property: TEST_PROPERTY,
  t: [{ date: '2026-10-01', c: 5, i: 500, ps: 4000 }],
  tc: [{ date: '2026-10-01', cc: 'gbr', c: 4, i: 400, ps: 3200 }],
});

function cands(n: number): SerpCandidate[] {
  return Array.from({ length: n }, (_, k) => ({
    keyword: `${k % 3 === 0 ? 'how to fix' : 'plumber'} ${k}`, device: 'desktop' as const, pbar: 2 + (k % 15), impressions: 20 + k,
    expectedBaseClicks: 1 + (k % 9), deltaClicks: 0, pages: ['https://example.com/'],
  }));
}

async function spend(store: DataStore): Promise<SpendEvent[]> {
  return cleanSpendEvents(await store.readLedger<unknown>('spend'));
}

let suffix = 0;
function ctxFor(store: DataStore, clock: ManualClock, dfs: FakeDfs, config = dfsConfig()) {
  return makeCtx({ store, clock, fetch: dfs.fetch, config, index: INDEX, runSuffix: `e${(++suffix).toString(16).padStart(3, '0')}` });
}

async function collect(store: DataStore, clock: ManualClock, dfs: FakeDfs, config = dfsConfig()): Promise<PhaseResult> {
  const ctx = ctxFor(store, clock, dfs, config);
  return serpCollectCollector.execute(await serpCollectCollector.plan(ctx), ctx);
}

/** A whole run: collect, then (after `analysisMs` on the clock) post. */
async function run(store: DataStore, clock: ManualClock, dfs: FakeDfs, c: SerpCandidate[], o: { analysisMs?: number; config?: ReturnType<typeof dfsConfig> } = {}) {
  const ctx = ctxFor(store, clock, dfs, o.config);
  const got = await serpCollectCollector.execute(await serpCollectCollector.plan(ctx), ctx);
  if (o.analysisMs) clock.advance(o.analysisMs);
  const post = await serpPoster.execute(await serpPoster.plan(ctx, c), ctx);
  return { collect: got, post };
}

function dupTags(dfs: FakeDfs): number {
  const tags = dfs.ours().map((t) => t.tag);
  return tags.length - new Set(tags).size;
}

function world(at: string, o: Partial<FakeDfsOptions> = {}): { clock: ManualClock; store: MemoryStore; dfs: FakeDfs } {
  const clock = manualClock(at);
  return { clock, store: memoryStore(), dfs: fakeDataForSeo({ clock, ...o }) };
}

describe('a ledger that is behind DataForSEO', () => {
  it('adopts tasks another data folder posted, posts nothing twice, and collects them', async () => {
    const w = world('2026-10-05T18:00:00Z');
    const a = await run(w.store, w.clock, w.dfs, cands(40));
    expect(a.post.rows).toBe(40);
    // Folder B: same property, same account, a stale (empty) ledger, an hour later.
    w.clock.advance(3_600_000);
    const storeB = memoryStore();
    const b = await run(storeB, w.clock, w.dfs, cands(40));
    expect(b.post.rows).toBe(0);
    expect(dupTags(w.dfs)).toBe(0);
    expect(w.dfs.ours()).toHaveLength(40);
    expect(b.collect.notes.join(' ')).toContain('Confirmed 40 earlier checks');
    expect(b.collect.rows).toBe(40);
  });

  it('dates an adopted task by when DataForSEO created it, not when it was adopted', async () => {
    const w = world('2026-10-05T18:00:00Z'); // Monday, ISO week 41
    await run(w.store, w.clock, w.dfs, cands(5));
    w.clock.set('2026-10-12T18:00:00Z'); // the next ISO week
    const storeB = memoryStore();
    await collect(storeB, w.clock, w.dfs);
    const ev = await spend(storeB);
    const adopted = ev.filter((e) => e.type === 'posted');
    expect(adopted).toHaveLength(5);
    const state = spendState(ev);
    for (const t of state.tasks.values()) expect(t.at.startsWith('2026-10-05')).toBe(true);
    const part = (await storeB.list('serp/'))[0].path;
    const rows = (await storeB.readPartition<{ isoWeek: string }>(part)).rows;
    expect(rows.every((r) => r.isoWeek === '2026-W41')).toBe(true);
  });
});

describe('a busy shared account', () => {
  function crowd(dfs: FakeDfs, n: number, now: Date, spanMs: number): void {
    for (let k = 0; k < n; k++) {
      dfs.tasks.push({
        id: `other-${k}`, tag: `othertool:${k}`, keyword: `foreign ${k}`, device: 'desktop', location_code: 2840, language_code: 'en', cost: 0.0006,
        postedAt: new Date(now.getTime() - Math.floor((k / n) * spanMs) - 1000), collected: false, foreign: true,
      } satisfies FakeTask);
    }
  }

  it('finds a timed-out POST among 51,000 other tasks: no duplicates, nothing abandoned, few id_list pages', async () => {
    const w = world('2026-10-05T18:00:00Z', { post: (n) => (n === 0 ? 'timeout' : 'ok') });
    crowd(w.dfs, 51_000, w.clock.now(), 7 * 86_400_000);
    await run(w.store, w.clock, w.dfs, cands(20));
    expect(w.dfs.ours()).toHaveLength(PROBE_BATCH);
    w.clock.advance(20 * 60_000);
    const before = w.dfs.ff.callsTo(/id_list/).length;
    const second = await run(w.store, w.clock, w.dfs, cands(20));
    const ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'abandoned')).toHaveLength(0);
    expect(dupTags(w.dfs)).toBe(0);
    expect(w.dfs.ours()).toHaveLength(20);
    // Newest first, so our recent tasks are on the first page. The 8-day sweep stops at its cap
    // (about a minute of id_list) instead of 50 pages, and says the list was cut short.
    expect(w.dfs.ff.callsTo(/id_list/).length - before).toBeLessThanOrEqual(SWEEP_MAX_PAGES + 1);
    expect(second.collect.notes.join(' ')).toContain('too long to read in full');
  });

  it('keeps an unconfirmable intent reserved, never re-posts it, and settles it as spent once its week ends', async () => {
    const w = world('2026-10-05T18:00:00Z', { post: (n) => (n === 0 ? 'http500' : 'ok') });
    await run(w.store, w.clock, w.dfs, cands(5));
    // So many other tasks around the failed request that no narrow read can finish.
    crowd(w.dfs, 12_000, new Date(Date.parse('2026-10-05T18:30:00Z')), 3_600_000);
    w.clock.advance(2 * 86_400_000);
    const mid = await run(w.store, w.clock, w.dfs, cands(5));
    let ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'abandoned')).toHaveLength(0);
    expect(w.dfs.postCalls).toBe(1);
    expect(mid.collect.notes.join(' ')).toContain('stay reserved');
    // The next ISO week: the intents can never be due again, so they settle, counted as spent.
    w.clock.set('2026-10-12T18:00:00Z');
    await collect(w.store, w.clock, w.dfs);
    ev = await spend(w.store);
    const settled = ev.filter((e) => e.type === 'abandoned');
    expect(settled).toHaveLength(5);
    expect(settled.every((e) => e.type === 'abandoned' && e.unconfirmed === true)).toBe(true);
    const state = spendState(ev);
    expect([...state.intents.values()].filter((s) => s.unconfirmed)).toHaveLength(5);
  });
});

describe('a cached id_list answer', () => {
  it('never abandons on a read made before the 15 minutes were up (id_list lagging 12 minutes)', async () => {
    const w = world('2026-10-05T18:00:00Z', { post: (n) => (n === 0 ? 'timeout' : 'ok'), idListLagMs: 12 * 60_000 });
    await run(w.store, w.clock, w.dfs, cands(5));
    w.clock.advance(11 * 60_000);
    // The collector reads id_list at +11 min (task hidden by lag); analysis takes 5 minutes; then the poster.
    await run(w.store, w.clock, w.dfs, cands(5), { analysisMs: 5 * 60_000 });
    expect(w.dfs.postCalls).toBe(1);
    expect(dupTags(w.dfs)).toBe(0);
    expect((await spend(w.store)).filter((e) => e.type === 'abandoned')).toHaveLength(0);
  });

  it('gives a re-post its own 15 minutes (failed, then a timed-out re-post, then a run 3 minutes later)', async () => {
    const w = world('2026-10-05T18:00:00Z', { post: (n) => (n === 0 ? 'task_errors' : n === 1 ? 'timeout' : 'ok'), idListLagMs: 5 * 60_000 });
    await run(w.store, w.clock, w.dfs, cands(5));
    w.clock.advance(86_400_000);
    await run(w.store, w.clock, w.dfs, cands(5));
    w.clock.advance(3 * 60_000);
    await run(w.store, w.clock, w.dfs, cands(5));
    expect((await spend(w.store)).filter((e) => e.type === 'abandoned')).toHaveLength(0);
    expect(dupTags(w.dfs)).toBe(0);
    expect(w.dfs.postCalls).toBe(2);
  });
});

describe('collecting', () => {
  it('settles a task DataForSEO answers with a final error, so it stops being pending', async () => {
    const w = world('2026-10-05T18:00:00Z', { taskCode: (t) => (t.keyword === 'plumber 1' ? 40102 : undefined) });
    await run(w.store, w.clock, w.dfs, cands(3));
    w.clock.advance(3_600_000);
    const got = await collect(w.store, w.clock, w.dfs);
    expect(got.rows).toBe(2);
    expect(got.notes.join(' ')).toMatch(/DataForSEO had no result for 1 check \(40102 No Search Results\.\); it won't be retried/);
    const ctx = ctxFor(w.store, w.clock, w.dfs);
    expect((await serpCollectCollector.plan(ctx)).payload.pendingTaskIds).toEqual([]);
    const before = w.dfs.ff.callsTo(/task_get/).length;
    await collect(w.store, w.clock, w.dfs);
    expect(w.dfs.ff.callsTo(/task_get/).length).toBe(before);
    // The unit is not paid for again that week.
    expect((await run(w.store, w.clock, w.dfs, cands(3))).post.rows).toBe(0);
  });

  it('keeps a paid result whose third-party titles quote a private key header, with the header defanged', async () => {
    const marker = '-----BEGIN PRIVATE KEY-----';
    const w = world('2026-10-05T18:00:00Z', {
      serp: (t) => ({
        keyword: t.keyword, type: 'organic', location_code: t.location_code, language_code: t.language_code,
        datetime: '2026-10-05 18:01:00 +00:00', item_types: ['ai_overview', 'organic'],
        items: [
          { type: 'ai_overview', rank_absolute: 1, references: [{ domain: 'leaks.example', url: 'https://leaks.example/k', title: `Leaked? ${marker} lol`, source: 'x' }] },
          { type: 'organic', rank_absolute: 2, domain: 'leaks.example', url: 'https://leaks.example/k', title: `Leaked? ${marker} lol` },
        ],
      }),
    });
    await run(w.store, w.clock, w.dfs, cands(3));
    w.clock.advance(3_600_000);
    const got = await collect(w.store, w.clock, w.dfs);
    expect(got.status).toBe('ok');
    expect(got.rows).toBe(3);
    const text = JSON.stringify((await w.store.readPartition(got.partitions[0])).rows);
    expect(text).not.toContain(marker);
    expect(text).toContain('[BEGIN PRIVATE KEY]');
    expect((await spend(w.store)).filter((e) => e.type === 'collected')).toHaveLength(3);
  });
});

describe('the price guard', () => {
  it('plans with at least $0.0012 a check even when config says less', async () => {
    const w = world('2026-10-05T18:00:00Z', { cost: () => 0.0012 });
    const cfg = dfsConfig({ costPerCheckUsd: 0.0006, maxPerRunUsd: 0.3 });
    const r = await run(w.store, w.clock, w.dfs, cands(600), { config: cfg });
    expect(r.post.costUsd).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it('stops at the cap when DataForSEO bills 2x or 5x the planned price, overshooting by at most the probe', async () => {
    for (const k of [2, 5]) {
      const w = world('2026-10-05T18:00:00Z', { cost: () => 0.0012 * k });
      const r = await run(w.store, w.clock, w.dfs, cands(600));
      const billed = w.dfs.ours().reduce((s, t) => s + t.cost, 0);
      expect(billed).toBeLessThanOrEqual(0.3 + PROBE_BATCH * 0.0012 * (k - 1) + 1e-9);
      expect(r.post.notes.join(' ')).toContain('above the $0.0012 searchtrace plans with');
    }
  });

  it('learns the real price from recent charges, ignoring operator searches', () => {
    const tag = ourTagPrefix(TEST_PROPERTY);
    const ev: SpendEvent[] = [];
    for (let k = 0; k < 20; k++) {
      ev.push({ type: 'posted', at: `2026-10-0${1 + (k % 5)}T10:00:00Z`, runId: 'r', intentKey: `i${k}`, tag: `${tag}i${k}`, taskId: `t${k}`, costUsd: 0.0024 });
    }
    expect(priceFor(spendState(ev), 0.0012)).toBe(0.0024);
    // Fewer than 10 charges: not enough to learn from.
    expect(priceFor(spendState(ev.slice(0, 5)), 0.0006)).toBe(0.0012);
    expect(BATCH_SIZE).toBe(100);
  });
});
