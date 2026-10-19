// WP-D: the at-most-once posting protocol and the hard budget guard, against a fake DataForSEO
// account (spec tests 60 and 61, and the 9.2 acceptance items):
// - 3 consecutive runs in one ISO week post each intent exactly once;
// - a crash after 'intent' resolves through id_list with no second POST;
// - 'unknown' is never re-posted; 'abandoned' after 15 minutes makes the intent eligible again;
// - spend never exceeds the caps under 200 randomised budgets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/rng.js';
import type { DataStore, IndexReader, PhaseResult, SerpCandidate, SpendEvent } from '../../src/core/types.js';
import { setDfsRatesForTests } from '../../src/sources/dataforseo/client.js';
import { cleanSpendEvents, ourTagPrefix, spendState } from '../../src/sources/dataforseo/reconcile.js';
import { serpCollectCollector, serpPoster } from '../../src/sources/dataforseo/serp.js';
import { manualClock, memoryIndex, memoryStore, type ManualClock, type MemoryStore } from '../helpers/index.js';
import { dfsConfig, fakeDataForSeo, type FakeDfs, type PostBehaviour, makeCtx, TEST_PROPERTY } from './fake-dataforseo.js';

beforeAll(() => setDfsRatesForTests({ idList: { rps: 1e6, concurrency: 1 }, tasksReady: { rps: 1e6, concurrency: 1 }, taskGet: { rps: 1e6, concurrency: 8 } }));
afterAll(() => setDfsRatesForTests(null));

const INDEX: IndexReader = memoryIndex({
  property: TEST_PROPERTY,
  t: [{ date: '2026-10-01', c: 5, i: 500, ps: 4000 }],
  tc: [
    { date: '2026-10-01', cc: 'usa', c: 1, i: 100, ps: 800 },
    { date: '2026-10-01', cc: 'gbr', c: 4, i: 400, ps: 3200 },
  ],
});

function cands(n: number, prefix = 'how to fix'): SerpCandidate[] {
  return Array.from({ length: n }, (_, k) => ({
    keyword: `${k % 3 === 0 ? prefix : 'plumber'} ${k}`,
    device: k % 4 === 0 ? 'mobile' : 'desktop',
    pbar: 2 + (k % 15),
    impressions: 20 + k,
    expectedBaseClicks: 1 + (k % 9),
    deltaClicks: (k % 5) - 2,
    pages: ['https://example.com/'],
  }));
}

interface World { clock: ManualClock; store: MemoryStore; dfs: FakeDfs }

function world(o: { at: string; post?: (n: number) => PostBehaviour; balance?: number; cost?: (n: number) => number }): World {
  const clock = manualClock(o.at);
  return { clock, store: memoryStore(), dfs: fakeDataForSeo({ clock, post: o.post, balance: o.balance, cost: o.cost }) };
}

async function spend(store: DataStore): Promise<SpendEvent[]> {
  return cleanSpendEvents(await store.readLedger<unknown>('spend'));
}

async function runOnce(
  w: World,
  candidates: SerpCandidate[],
  o: { store?: DataStore; suffix?: string; config?: ReturnType<typeof dfsConfig>; budgetUsd?: number | null; collect?: boolean } = {},
): Promise<{ collect: PhaseResult | null; post: PhaseResult }> {
  const ctx = makeCtx({
    store: o.store ?? w.store, clock: w.clock, fetch: w.dfs.fetch, config: o.config ?? dfsConfig(), index: INDEX,
    flags: { budgetUsd: o.budgetUsd ?? null }, runSuffix: o.suffix,
  });
  let collect: PhaseResult | null = null;
  if (o.collect !== false) collect = await serpCollectCollector.execute(await serpCollectCollector.plan(ctx), ctx);
  const plan = await serpPoster.plan(ctx, candidates);
  const post = await serpPoster.execute(plan, ctx);
  return { collect, post };
}

function tagsOnServer(w: World): string[] {
  return w.dfs.ours().map((t) => t.tag).sort();
}

function expectEachTagOnce(w: World): void {
  const tags = tagsOnServer(w);
  expect(new Set(tags).size).toBe(tags.length);
}

describe('posting protocol (test 60)', () => {
  it('posts each intent exactly once over 3 runs in one ISO week, then collects the results', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' }); // Monday, first week ever: everything is due on day 0
    const c = cands(150);
    const r1 = await runOnce(w, c);
    expect(r1.post.status).toBe('ok');
    expect(r1.post.rows).toBe(150);
    // A 10-check price probe first, then batches of 100 (the probe keeps a price rise from overspending a whole batch).
    expect(w.dfs.postCalls).toBe(3);
    const posted1 = (await spend(w.store)).filter((e) => e.type === 'posted');
    expect(posted1).toHaveLength(150);
    expect(posted1.every((e) => e.type === 'posted' && e.tag.startsWith(ourTagPrefix(TEST_PROPERTY)))).toBe(true);

    w.clock.set('2026-10-06T18:00:00Z');
    const r2 = await runOnce(w, c, { suffix: 'b0b0' });
    expect(r2.collect?.rows).toBe(150);
    expect(r2.collect?.partitions).toHaveLength(1);
    expect(r2.post.status).toBe('skipped');
    w.clock.set('2026-10-08T18:00:00Z');
    const r3 = await runOnce(w, c, { suffix: 'c0c0' });
    expect(r3.collect?.rows ?? 0).toBe(0);
    expect(r3.post.rows).toBe(0);

    expect(w.dfs.postCalls).toBe(3);
    expect(w.dfs.ours()).toHaveLength(150);
    expectEachTagOnce(w);
    const ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'intent')).toHaveLength(150);
    expect(ev.filter((e) => e.type === 'design')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'collected')).toHaveLength(150);

    // The serp partition holds normalised observations with the design's pi.
    const part = r2.collect?.partitions[0] as string;
    const { meta, rows } = await w.store.readPartition<{ aio: unknown; pi: number; design: string; isoWeek: string; keyword: string }>(part);
    expect(meta.kind).toBe('serp');
    expect(rows).toHaveLength(150);
    expect(rows.every((r) => r.pi === 1 && r.design === 'census' && r.isoWeek === '2026-W41')).toBe(true);
    expect(rows.filter((r) => r.aio !== null).length).toBe(c.filter((x) => x.keyword.includes('how')).length);
  });

  it('uses the location from the top country and sends the documented task fields', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    await runOnce(w, cands(3));
    const body = w.dfs.ff.callsTo(/task_post/)[0].json<Record<string, unknown>[]>();
    expect(body[0]).toMatchObject({ location_code: 2826, language_code: 'en', depth: 10, priority: 1, load_async_ai_overview: true });
    expect(body.find((b) => b.device === 'mobile')?.os).toBe('android');
    expect(body.find((b) => b.device === 'desktop')?.os).toBe('windows');
    expect(String(body[0].tag).length).toBeLessThanOrEqual(255);
  });

  it('a crash after intent (before the outcome is written) resolves through id_list without a second POST', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    const killed = new Proxy(w.store, {
      get(target, key, recv) {
        if (key === 'append') {
          return async (stream: string, rec: { type?: string }) => {
            if (stream === 'spend' && rec.type === 'posted') throw new Error('killed');
            return target.append(stream as 'spend', rec);
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DataStore;
    const r1 = await runOnce(w, cands(40), { store: killed });
    expect(r1.post.status).not.toBe('ok');
    // The crash hits the first batch, which is the 10-check price probe: the server created those 10.
    expect(w.dfs.ours()).toHaveLength(10);
    let ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'intent')).toHaveLength(10);
    expect(ev.filter((e) => e.type === 'posted')).toHaveLength(0);

    w.clock.advance(5 * 60_000);
    const r2 = await runOnce(w, cands(40), { suffix: 'b0b0' });
    // The 10 are adopted from id_list, never sent again; only the 30 that were never sent go out.
    expect(r2.post.rows).toBe(30);
    ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'posted')).toHaveLength(40);
    expect(ev.filter((e) => e.type === 'abandoned')).toHaveLength(0);
    expect(w.dfs.ours()).toHaveLength(40);
    expectEachTagOnce(w);
  });

  it('an unknown outcome (sent, answer lost) is never re-posted: reconcile finds it', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: (n) => (n === 0 ? 'reset_after_send' : 'ok') });
    const r1 = await runOnce(w, cands(30));
    expect(r1.post.status).toBe('partial');
    // The lost answer was the 10-check probe's; posting stopped there.
    expect((await spend(w.store)).filter((e) => e.type === 'unknown')).toHaveLength(10);
    // Same run day, a minute later: the unknowns are found and adopted, never re-sent; the other 20 go out.
    w.clock.advance(60_000);
    await runOnce(w, cands(30), { suffix: 'b0b0' });
    expect(w.dfs.postCalls).toBe(3);
    expect(w.dfs.ours()).toHaveLength(30);
    expect((await spend(w.store)).filter((e) => e.type === 'posted')).toHaveLength(30);
    expectEachTagOnce(w);
  });

  it('a timeout after sending is unknown, and the next run settles it', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: (n) => (n === 0 ? 'timeout' : 'ok') });
    await runOnce(w, cands(10));
    w.clock.advance(20 * 60_000);
    await runOnce(w, cands(10), { suffix: 'b0b0' });
    expect(w.dfs.postCalls).toBe(1);
    expectEachTagOnce(w);
    expect(w.dfs.ours()).toHaveLength(10);
  });

  it('a request that never left (DNS) is failed and posted again next run, once', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: (n) => (n === 0 ? 'dns' : 'ok') });
    const r1 = await runOnce(w, cands(12));
    expect(r1.post.status).toBe('partial');
    // The 10-check probe never left; posting stopped there.
    expect((await spend(w.store)).filter((e) => e.type === 'failed')).toHaveLength(10);
    expect(w.dfs.ours()).toHaveLength(0);
    w.clock.advance(60_000);
    await runOnce(w, cands(12), { suffix: 'b0b0' });
    w.clock.advance(60_000);
    await runOnce(w, cands(12), { suffix: 'c0c0' });
    expect(w.dfs.ours()).toHaveLength(12);
    expectEachTagOnce(w);
    // The failed probe, then a probe of 10 and a batch of the last 2.
    expect(w.dfs.postCalls).toBe(3);
  });

  it('a 500 is unknown; with nothing at DataForSEO it is abandoned after 15 minutes and posted once more', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: (n) => (n === 0 ? 'http500' : 'ok') });
    await runOnce(w, cands(8));
    expect((await spend(w.store)).filter((e) => e.type === 'unknown')).toHaveLength(8);
    w.clock.advance(10 * 60_000);
    await runOnce(w, cands(8), { suffix: 'b0b0' });
    expect(w.dfs.postCalls).toBe(1); // still inside the 15-minute window: reserved, not re-sent
    expect((await spend(w.store)).filter((e) => e.type === 'abandoned')).toHaveLength(0);
    w.clock.advance(6 * 60_000);
    await runOnce(w, cands(8), { suffix: 'c0c0' });
    const ev = await spend(w.store);
    expect(ev.filter((e) => e.type === 'abandoned')).toHaveLength(8);
    expect(w.dfs.postCalls).toBe(2);
    expect(w.dfs.ours()).toHaveLength(8);
    expectEachTagOnce(w);
  });

  it('a crash before the POST is sent: reserved for 15 minutes, then posted exactly once', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    let intents = 0;
    const killed = new Proxy(w.store, {
      get(target, key, recv) {
        if (key === 'append') {
          return async (stream: string, rec: { type?: string }) => {
            if (stream === 'spend' && rec.type === 'intent' && ++intents === 3) throw new Error('killed before send');
            return target.append(stream as 'spend', rec);
          };
        }
        const v = Reflect.get(target, key, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DataStore;
    await runOnce(w, cands(5), { store: killed });
    expect(w.dfs.postCalls).toBe(0);
    w.clock.advance(5 * 60_000);
    await runOnce(w, cands(5), { suffix: 'b0b0' });
    expect(w.dfs.ours()).toHaveLength(3); // the two pending intents are held back
    w.clock.advance(15 * 60_000);
    await runOnce(w, cands(5), { suffix: 'c0c0' });
    expect(w.dfs.ours()).toHaveLength(5);
    expectEachTagOnce(w);
  });

  it('per-task refusals are failed; a 401 fails the phase with an auth error and posts nothing', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: () => 'task_errors' });
    const r = await runOnce(w, cands(4));
    expect((await spend(w.store)).filter((e) => e.type === 'failed')).toHaveLength(4);
    expect(r.post.status).toBe('partial');
    const w2 = world({ at: '2026-10-05T18:00:00Z', post: () => 'auth' });
    const r2 = await runOnce(w2, cands(4));
    expect(r2.post.status).toBe('failed');
    expect(r2.post.errors[0]?.code).toBe('auth');
    expect(w2.dfs.ours()).toHaveLength(0);
  });

  it('a 402 (balance too low) is a warning: nothing posted, intents eligible again', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', post: (n) => (n === 0 ? 'budget' : 'ok') });
    const r = await runOnce(w, cands(6));
    expect(r.post.status).toBe('ok');
    expect(r.post.notes.join(' ')).toMatch(/balance is too low/);
    expect((await spend(w.store)).filter((e) => e.type === 'failed')).toHaveLength(6);
    w.clock.advance(60_000);
    await runOnce(w, cands(6), { suffix: 'b0b0' });
    expect(w.dfs.ours()).toHaveLength(6);
    expectEachTagOnce(w);
  });

  it('later weeks spread checks over weekdays', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    await runOnce(w, cands(70));
    w.clock.set('2026-10-12T18:00:00Z'); // Monday of the next ISO week
    const before = w.dfs.ours().length;
    await runOnce(w, cands(70), { suffix: 'b0b0' });
    const state = spendState(await spend(w.store));
    const design = state.designs.get('2026-W42');
    expect(design).toBeDefined();
    const monday = design?.units.filter((u) => u.weekday === 0).length ?? 0;
    expect(w.dfs.ours().length - before).toBe(monday);
    w.clock.set('2026-10-14T18:00:00Z'); // Wednesday
    await runOnce(w, cands(70), { suffix: 'c0c0' });
    const upToWed = design?.units.filter((u) => u.weekday <= 2).length ?? 0;
    expect(w.dfs.ours().length - before).toBe(upToWed);
    expectEachTagOnce(w);
  });

  it('ignores other tools on the shared account when adding up spend', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    for (const t of w.dfs.tasks) t.cost = 10; // other tools spent a lot this month
    const r = await runOnce(w, cands(20));
    expect(r.post.rows).toBe(20);
  });

  it('a dry run makes no network calls and writes nothing', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    const ctx = makeCtx({ store: w.store, clock: w.clock, fetch: w.dfs.fetch, config: dfsConfig(), index: INDEX, flags: { dryRun: true } });
    const cp = await serpCollectCollector.plan(ctx);
    const pp = await serpPoster.plan(ctx, cands(206));
    expect(cp.skip).toBeNull();
    expect(pp.skip).toBeNull();
    expect(pp.estUsd).toBeCloseTo(206 * 0.0012, 9);
    expect(pp.lines.find((l) => l.label === 'AI Overview checks')?.detail).toMatch(/= 206 checks x \$0\.0012 = \$0\.247 \(worst case\)/);
    expect(pp.lines.find((l) => l.label === 'This month so far')?.detail).toBe('$0.00 of your $1.00 cap  ->  $0.247 after this run');
    expect(w.dfs.ff.calls).toHaveLength(0);
    expect(w.store.files.size).toBe(0);
    const ex = await serpPoster.execute(pp, ctx);
    expect(ex.status).toBe('skipped');
    expect(w.dfs.ff.calls).toHaveLength(0);
  });

  it('skips cleanly when off, offline, --no-paid, or without a login', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    const mk = (o: Parameters<typeof makeCtx>[0]['flags'], config = dfsConfig(), env?: Record<string, string>) =>
      makeCtx({ store: w.store, clock: w.clock, fetch: w.dfs.fetch, config, index: INDEX, flags: o, env });
    const off = { ...dfsConfig(), serp: { provider: 'none' as const } };
    expect((await serpPoster.plan(mk({}, off), cands(3))).skip).toMatch(/off/);
    expect((await serpPoster.plan(mk({ offline: true }), cands(3))).skip).toMatch(/Offline/);
    expect((await serpPoster.plan(mk({ noPaid: true }), cands(3))).skip).toMatch(/--no-paid/);
    expect((await serpPoster.plan(mk({}, dfsConfig(), {}), cands(3))).skip).toMatch(/DATAFORSEO_LOGIN/);
    expect((await serpCollectCollector.plan(mk({}, off))).skip).toMatch(/off/);
    expect(w.dfs.ff.calls).toHaveLength(0);
  });

  it('asks for a location when the top country is unknown and config has none', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    const idx = memoryIndex({ t: [{ date: '2026-10-01', c: 1, i: 10, ps: 10 }], tc: [{ date: '2026-10-01', cc: 'xkx', c: 1, i: 10, ps: 10 }] });
    const ctx = makeCtx({ store: w.store, clock: w.clock, fetch: w.dfs.fetch, config: dfsConfig(), index: idx });
    expect((await serpPoster.plan(ctx, cands(3))).skip).toMatch(/serp\.locationCode/);
    const ctx2 = makeCtx({ store: w.store, clock: w.clock, fetch: w.dfs.fetch, config: dfsConfig({ locationCode: 2840, languageCode: 'en' }), index: idx });
    const r = await serpPoster.execute(await serpPoster.plan(ctx2, cands(3)), ctx2);
    expect(r.rows).toBe(3);
    expect(w.dfs.ours().every((t) => t.location_code === 2840)).toBe(true);
  });
});

describe('hard budget guard (test 61)', () => {
  it('stops at the per-run cap and the --budget override', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z' });
    const r = await runOnce(w, cands(400)); // census of 400 > $0.30 per run, so sampled; capped at 250 checks
    expect(r.post.rows).toBeLessThanOrEqual(250);
    const w2 = world({ at: '2026-10-05T18:00:00Z' });
    const r2 = await runOnce(w2, cands(400), { budgetUsd: 0.012 });
    expect(r2.post.rows).toBeLessThanOrEqual(10);
    expect(w2.dfs.ours().length).toBeLessThanOrEqual(10);
  });

  it('respects the balance and the monthly cap across runs', async () => {
    const w = world({ at: '2026-10-05T18:00:00Z', balance: 0.006 });
    const r = await runOnce(w, cands(100));
    expect(r.post.rows).toBeLessThanOrEqual(5);
    const w2 = world({ at: '2026-10-05T18:00:00Z', cost: () => 0.0012 });
    const cfg = dfsConfig({ monthlyBudgetUsd: 0.05, maxPerRunUsd: 0.3 });
    let total = 0;
    for (let d = 0; d < 6; d++) {
      w2.clock.set(`2026-10-${String(5 + d * 2).padStart(2, '0')}T18:00:00Z`);
      const x = await runOnce(w2, cands(300), { config: cfg, suffix: `${d}a${d}a` });
      total += x.post.costUsd;
    }
    expect(total).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(w2.dfs.ours().reduce((s, t) => s + t.cost, 0)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it('never exceeds any cap under 200 randomised budgets', async () => {
    const rng = mulberry32(20261006);
    const u = (a: number, b: number): number => a + (b - a) * rng();
    let casesThatPosted = 0;
    let capsHit = 0;
    for (let i = 0; i < 200; i++) {
      const cost = [0.0012, 0.0006, 0.002][Math.floor(rng() * 3)];
      const monthly = u(0, 1.5);
      const perRun = u(0, 0.5);
      const override = rng() < 0.3 ? u(0, 0.4) : null;
      const balance = rng() < 0.2 ? u(0, 0.2) : 25;
      const n = Math.floor(u(0, 320));
      const w = world({ at: '2026-10-19T17:00:00Z', balance, cost: () => u(0.3, 1) * cost });
      // Spend earlier this month (outside the id_list window, so only the ledger knows it).
      const prior = rng() < 0.5 ? u(0, monthly * 1.2) : 0;
      if (prior > 0) {
        await w.store.append('spend', { type: 'posted', at: '2026-10-03T10:00:00Z', runId: 'r20261003t100000z-0000', intentKey: `old${i}`, tag: `${ourTagPrefix(TEST_PROPERTY)}old${i}`, taskId: `old-task-${i}`, costUsd: prior });
      }
      // Requests in flight from a minute ago (reserved at worst-case cost).
      const pending = rng() < 0.3 ? Math.floor(u(1, 30)) : 0;
      for (let k = 0; k < pending; k++) {
        await w.store.append('spend', { type: 'intent', at: '2026-10-19T16:59:00Z', runId: 'r20261019t165900z-0000', intentKey: `p${i}x${k}`, tag: `${ourTagPrefix(TEST_PROPERTY)}p${i}x${k}`, estUsd: cost });
      }
      const cfg = dfsConfig({ monthlyBudgetUsd: monthly, maxPerRunUsd: perRun, costPerCheckUsd: cost });
      const c = cands(n);
      let monthTotal = prior;
      for (let r = 0; r < 3; r++) {
        w.clock.set(['2026-10-19T17:00:00Z', '2026-10-21T17:00:00Z', '2026-10-23T17:00:00Z'][r]);
        const balanceBefore = balance - w.dfs.ours().reduce((s, t) => s + t.cost, 0);
        const before = w.dfs.ours().length;
        const res = await runOnce(w, c, { config: cfg, budgetUsd: override, collect: false });
        const made = w.dfs.ours().slice(before);
        const runCost = made.reduce((s, t) => s + t.cost, 0);
        const worst = made.length * cost;
        // In-flight intents are reserved on the first run; two days later they are abandoned and released.
        const reserved = r === 0 ? pending * cost : 0;
        const cap = Math.min(override ?? perRun, Math.max(0, balanceBefore), Math.max(0, monthly - monthTotal - reserved));
        const msg = `case ${i} run ${r}: made ${made.length} worst ${worst} cap ${cap}`;
        expect(worst, msg).toBeLessThanOrEqual(cap + 1e-9);
        expect(res.post.costUsd, msg).toBeLessThanOrEqual(worst + 1e-9);
        monthTotal += runCost;
        if (prior <= monthly) expect(monthTotal, msg).toBeLessThanOrEqual(monthly + 1e-9);
        if (cap - worst < cost) capsHit++;
      }
      if (w.dfs.ours().length > 0) casesThatPosted++;
      expectEachTagOnce(w);
    }
    // The property is only meaningful if many cases spend money and many run into a cap.
    expect(casesThatPosted).toBeGreaterThan(60);
    expect(capsHit).toBeGreaterThan(60);
  }, 120_000);
});
