// Spec 5.13 test 49 (fake GSC server), the revision part of test 50, and the WP-B acceptance check:
// a fake server replaying the 0.2 F1/F2 shapes gives sealed day files whose p clicks equal the t
// clicks. Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { addDays, dateRange } from '../../src/core/time.js';
import type { Config, GoogleAuth, IsoDate, Logger, PartitionMeta, RunContext, RunFlags } from '../../src/core/types.js';
import { differs, gscCollector, gscTuning, type GscQueryBody } from '../../src/sources/google/gsc.js';
import { fakeFetch, fixedClock, memoryIndex, memoryStore, type FakeReply, type FakeRequest, type MemoryStore } from '../helpers/index.js';

gscTuning.retryBaseMs = 1;
gscTuning.retryCapMs = 20;

const PROPERTY = 'sc-domain:example.com';
const QUERY_URL = /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites\/sc-domain%3Aexample\.com\/searchAnalytics\/query$/;
const silent: Logger = { info() {}, warn() {}, error() {}, debug() {}, progress() {} };
const AUTH: GoogleAuth = { kind: 'service_account', principal: 'robot@example.iam.gserviceaccount.com', scopes: [], headers: async () => ({ authorization: 'Bearer test-token-value' }) };

// ---------- a fake Search Console with the 0.2 F1 shape ----------

type ApiDevice = 'DESKTOP' | 'MOBILE' | 'TABLET';
interface Cell { q: string | null; p: string; dv: ApiDevice; c: number; i: number; pos: number }

const HOME = 'https://example.com/';
const A = 'https://example.com/blog/a';
const B = 'https://example.com/blog/b';
const C_RAW = 'HTTPS://Example.com:443/blog/c'; // normalised to https://example.com/blog/c

/** Named cells (q set) and anonymised traffic (q null) for one day. Named clicks are a small share, as in F1. */
function cellsFor(day: IsoDate, start: IsoDate, bump = 1): Cell[] {
  const k = Math.round((Date.parse(day) - Date.parse(start)) / 86_400_000);
  return [
    { q: 'example brand', p: HOME, dv: 'DESKTOP', c: (2 + (k % 3)) * bump, i: 20 + (k % 5), pos: 1.2 },
    { q: 'example brand', p: HOME, dv: 'MOBILE', c: 1, i: 8, pos: 1.5 },
    { q: 'example brand', p: HOME, dv: 'TABLET', c: k % 2, i: 2, pos: 1 },
    { q: 'how to x', p: A, dv: 'DESKTOP', c: k % 2, i: 30, pos: 6.5 },
    { q: 'how to x', p: A, dv: 'TABLET', c: 0, i: 3, pos: 7 },
    { q: 'how to x', p: A, dv: 'MOBILE', c: 1, i: 10, pos: 5 },
    { q: null, p: HOME, dv: 'DESKTOP', c: 5, i: 50, pos: 3 },
    { q: null, p: HOME, dv: 'MOBILE', c: 2, i: 20, pos: 4 },
    { q: null, p: A, dv: 'DESKTOP', c: 3, i: 100, pos: 9 },
    { q: null, p: B, dv: 'MOBILE', c: 1 + (k % 2), i: 40, pos: 12 },
    { q: null, p: C_RAW, dv: 'DESKTOP', c: 0, i: 15, pos: 20 },
  ];
}

interface Agg { c: number; i: number; ps: number }
const agg = (cells: Cell[]): Agg => cells.reduce((a, x) => ({ c: a.c + x.c, i: a.i + x.i, ps: a.ps + x.pos * x.i }), { c: 0, i: 0, ps: 0 });
const row = (keys: string[], a: Agg) => ({ keys, clicks: a.c, impressions: a.i, ctr: a.i > 0 ? a.c / a.i : 0, position: a.i > 0 ? a.ps / a.i : 0 });

interface FakeGscOptions {
  dataStart: IsoDate;
  F: IsoDate;
  today: IsoDate;
  /** Multiplies the first named cell's clicks on these days (to simulate Google revising a day). */
  bump?: Map<IsoDate, number>;
  /** Return this instead of the normal answer (status overrides, failures). */
  override?: (body: GscQueryBody, n: number) => FakeReply | null;
  /** A day whose named-query table has this many rows. */
  big?: { day: IsoDate; rows: number };
  /** Repeat the first row of the [page] answer on this day. */
  duplicateOn?: IsoDate;
}

function rowsFor(o: FakeGscOptions, body: GscQueryBody) {
  const final = body.dataState === 'final';
  const days = dateRange(body.startDate, body.endDate).filter((d) => d >= o.dataStart && d <= o.today && (!final || d < o.F));
  const dims = body.dimensions.join(',');
  const out: ReturnType<typeof row>[] = [];
  for (const d of days) {
    const cells = cellsFor(d, o.dataStart, o.bump?.get(d) ?? 1);
    if (dims === 'date') {
      const t = agg(cells);
      out.push(row([d], { ...t, i: Math.max(0, t.i - 5) })); // byProperty counts a search once
    } else if (dims === 'date,device') {
      for (const dv of ['DESKTOP', 'MOBILE', 'TABLET'] as ApiDevice[]) {
        const x = cells.filter((c) => c.dv === dv);
        if (x.length) out.push(row([d, dv], agg(x)));
      }
    } else if (dims === 'date,country') {
      const t = agg(cells);
      const g = { c: Math.round(t.c * 0.6), i: Math.round(t.i * 0.6), ps: t.ps * 0.6 };
      out.push(row([d, 'gbr'], g), row([d, 'USA'], { c: t.c - g.c, i: t.i - g.i, ps: t.ps - g.ps }));
    } else if (dims === 'page') {
      for (const p of [...new Set(cells.map((c) => c.p))]) out.push(row([p], agg(cells.filter((c) => c.p === p))));
      if (o.duplicateOn === d) out.push({ ...out[0], clicks: 999 });
    } else if (dims === 'query,page,device') {
      if (o.big?.day === d) {
        for (let k = 0; k < o.big.rows; k++) out.push(row([`q${k}`, HOME, 'DESKTOP'], { c: 0, i: 1, ps: 3 }));
      } else {
        for (const c of cells.filter((x) => x.q !== null)) out.push(row([c.q as string, c.p, c.dv], { c: c.c, i: c.i, ps: c.pos * c.i }));
      }
    } else {
      throw new Error(`fake GSC: unexpected dimensions ${dims}`);
    }
  }
  return out;
}

function fakeGsc(o: FakeGscOptions) {
  return {
    method: 'POST' as const,
    url: QUERY_URL,
    reply: (req: FakeRequest, n: number): FakeReply => {
      const body = req.json<GscQueryBody>();
      const over = o.override?.(body, n);
      if (over) return over;
      const all = rowsFor(o, body);
      const page = all.slice(body.startRow, body.startRow + body.rowLimit);
      const res: Record<string, unknown> = { responseAggregationType: body.aggregationType ?? 'byProperty' };
      if (page.length) res.rows = page;
      if (body.dataState === 'all' && body.dimensions.includes('date')) res.metadata = { firstIncompleteDate: o.F };
      return { body: res };
    },
  };
}

// ---------- context ----------

function config(o: Partial<Config['gsc']> = {}): Config {
  const c = defaultConfig(PROPERTY);
  return { ...c, gsc: { ...c.gsc, backfillMonths: 2, requestsPerSecond: 0, concurrency: 2, ...o } };
}

function ctxFor(store: MemoryStore, fetch: typeof globalThis.fetch, at: string, o: { cfg?: Config; offline?: boolean; google?: GoogleAuth | null } = {}): RunContext {
  const stamp = at.replace(/[-:]/g, '').toLowerCase().replace('.000', '');
  const flags: RunFlags = {
    dryRun: false, offline: o.offline ?? false, noPaid: true, ci: false, yes: true, interactive: false, budgetUsd: null, waitMinutes: 0, credentials: null, forceGraph: false,
  };
  return {
    runId: `r${stamp.slice(0, 15)}z-00a1`, startedAt: at, toolVersion: '0.1.0', config: o.cfg ?? config(), store,
    index: Object.assign(memoryIndex({}), { sync: async () => ({ loaded: 0, skipped: 0, removed: 0 }), close() {} }),
    clock: fixedClock(at), fetch, log: silent, secrets: createSecretRegistry({ ci: false }), signal: new AbortController().signal, flags,
    google: o.google === undefined ? AUTH : o.google, env: {},
  };
}

async function run(store: MemoryStore, fetch: typeof globalThis.fetch, at: string, o: { cfg?: Config; offline?: boolean; google?: GoogleAuth | null } = {}) {
  const ctx = ctxFor(store, fetch, at, o);
  const plan = await gscCollector.plan(ctx);
  return { plan, result: await gscCollector.execute(plan, ctx) };
}

type Row = { s: string; c: number; i: number; ps: number; dv?: string; cc?: string; p?: string; q?: string; date?: string };
const dayFiles = async (store: MemoryStore) => (await store.list('gsc/')).map((f) => f.path);
const bodies = (calls: FakeRequest[]) => calls.filter((c) => QUERY_URL.test(c.url)).map((c) => c.json<GscQueryBody & Record<string, unknown>>());

// ---------- tests ----------

describe('gscCollector', () => {
  const AT = '2026-10-06T13:00:00Z'; // 06:00 PT, today = 2026-10-06
  const opts: FakeGscOptions = { dataStart: '2026-08-20', F: '2026-10-04', today: '2026-10-06' };

  it('first run seals every final day from the first data day, with p clicks equal to t clicks', async () => {
    const store = memoryStore();
    const ff = fakeFetch([fakeGsc(opts)]);
    const { plan, result } = await run(store, ff.fetch, AT);
    expect(plan.skip).toBeNull();
    expect(plan.lines[0].label).toBe('Search Console data');
    expect(result.status).toBe('ok');

    const expected = dateRange('2026-08-20', '2026-10-03');
    const files = (await dayFiles(store)).filter((p) => !p.includes('gsc-fresh'));
    expect(files).toEqual(expected.map((d) => `gsc/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.ndjson.gz`));
    // Probe + 3 month chunks x 3 range calls + 2 per day + 1 fresh td call.
    expect(result.requests).toEqual({ 'gsc.probe': 1, 'gsc.query': 9 + 2 * expected.length + 1 });
    expect(result.notes[0]).toBe(`${expected.length} days stored (${expected.length} new)`);
    expect(ff.unmatched()).toEqual([]);

    for (const d of expected) {
      const part = await store.readPartition<Row>(`gsc/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.ndjson.gz`);
      const meta = part.meta as PartitionMeta;
      expect(meta).toMatchObject({ kind: 'gsc_day', schema: 1, property: PROPERTY, day: d, revision: 1, dataState: 'final' });
      const sum = (s: string, f: (r: Row) => number) => part.rows.filter((r) => r.s === s).reduce((a, r) => a + f(r), 0);
      const cells = cellsFor(d, opts.dataStart);
      const truth = agg(cells);
      expect(sum('t', (r) => r.c)).toBe(truth.c);
      expect(sum('p', (r) => r.c)).toBe(sum('t', (r) => r.c)); // the F1 reconciliation: complete page totals
      expect(sum('td', (r) => r.c)).toBe(truth.c);
      expect(sum('tc', (r) => r.c)).toBe(truth.c);
      // Named queries hold only part of the clicks (the anonymised remainder is real).
      expect(sum('qpd', (r) => r.c)).toBeLessThan(sum('p', (r) => r.c));
      // Tablet is summed into mobile, in td and in qpd.
      expect(part.rows.filter((r) => r.s === 'td').map((r) => r.dv)).toEqual(['desktop', 'mobile']);
      const mobileTd = part.rows.find((r) => r.s === 'td' && r.dv === 'mobile') as Row;
      expect(mobileTd.c).toBe(agg(cells.filter((c) => c.dv !== 'DESKTOP')).c);
      const brandMobile = part.rows.filter((r) => r.s === 'qpd' && r.q === 'example brand' && r.dv === 'mobile');
      expect(brandMobile).toHaveLength(1);
      expect(brandMobile[0].i).toBe(10);
      expect(brandMobile[0].ps).toBeCloseTo(8 * 1.5 + 2 * 1, 9);
      // Pages are normalised, countries lowercased, slices recorded.
      expect(part.rows.filter((r) => r.s === 'p').map((r) => r.p)).toContain('https://example.com/blog/c');
      expect(part.rows.filter((r) => r.s === 'tc').map((r) => r.cc)).toEqual(['gbr', 'usa']);
      expect(meta.slices?.p).toEqual({ rows: 4, truncated: false });
      // ps is position x impressions.
      const t = part.rows.find((r) => r.s === 't') as Row;
      // ps = position x impressions re-aggregates exactly: GSC's position is ps / i of its own rows.
      expect(t.ps).toBeCloseTo(truth.ps, 6);
      expect(t.i).toBe(truth.i - 5);
    }

    // The fresh tail: t from the probe and td from one call, days >= F only.
    const fresh = await store.readPartition<Row>('state/gsc-fresh.ndjson.gz');
    expect(fresh.meta).toMatchObject({ kind: 'gsc_fresh', dataState: 'all' });
    expect([...new Set(fresh.rows.map((r) => r.date))]).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(fresh.rows.filter((r) => r.s === 'td').every((r) => r.dv === 'desktop' || r.dv === 'mobile')).toBe(true);
  });

  it('never combines page with country, or page with device outside the named-query table, and uses no filters (F1)', async () => {
    const store = memoryStore();
    const ff = fakeFetch([fakeGsc(opts)]);
    await run(store, ff.fetch, AT);
    const all = bodies(ff.calls);
    expect(all.length).toBeGreaterThan(50);
    for (const b of all) {
      const dims = b.dimensions;
      if (dims.includes('page')) {
        expect(dims).not.toContain('country');
        if (dims.includes('device')) expect(dims).toContain('query');
        expect(b.aggregationType).toBe('byPage');
        expect(b.startDate).toBe(b.endDate); // one call per day
        expect(dims).not.toContain('date');
      } else if (b.dataState === 'final') {
        expect(b.aggregationType).toBe('byProperty');
      }
      expect(b).not.toHaveProperty('dimensionFilterGroups');
      expect(b.type).toBe('web');
      expect(b.rowLimit).toBe(25_000);
    }
    // The probe: [date], last 10 days, dataState all.
    expect(all[0]).toMatchObject({ dimensions: ['date'], dataState: 'all', startDate: '2026-09-26', endDate: '2026-10-06' });
  });

  it('a second run the same day makes only the probe and the fresh td call', async () => {
    const store = memoryStore();
    const ff = fakeFetch([fakeGsc(opts)]);
    await run(store, ff.fetch, AT);
    const before = await dayFiles(store);
    const ff2 = fakeFetch([fakeGsc(opts)]);
    const { plan, result } = await run(store, ff2.fetch, '2026-10-06T18:00:00Z');
    expect(plan.payload.sealDays).toEqual([]);
    expect(result.requests).toEqual({ 'gsc.probe': 1, 'gsc.query': 1 });
    expect(await dayFiles(store)).toEqual(before);
    expect(result.notes[0]).toBe('45 days stored (0 new)');
  });

  it('revalidates young-sealed days and writes a revision when Google changed a day by more than 0.5%', async () => {
    const store = memoryStore();
    // Run 1 on 2026-09-20 (F = 2026-09-18): days from 2026-09-11 on are sealed while young.
    await run(store, fakeFetch([fakeGsc({ ...opts, F: '2026-09-18', today: '2026-09-20' })]).fetch, '2026-09-20T13:00:00Z');
    // Google later revises 2026-09-15 (clicks up), and leaves the other days alone.
    const ff = fakeFetch([fakeGsc({ ...opts, bump: new Map([['2026-09-15', 3]]) })]);
    const { plan, result } = await run(store, ff.fetch, AT);
    expect(plan.payload.revalidateDays).toEqual(dateRange('2026-09-11', '2026-09-17'));
    expect(result.status).toBe('ok');
    expect(await store.exists('gsc/2026/09/2026-09-15.r2.ndjson.gz')).toBe(true);
    expect(await store.exists('gsc/2026/09/2026-09-14.r2.ndjson.gz')).toBe(false);
    const r2 = await store.readPartition<Row>('gsc/2026/09/2026-09-15.r2.ndjson.gz');
    expect(r2.meta).toMatchObject({ revision: 2, day: '2026-09-15' });
    const t = r2.rows.find((r) => r.s === 't') as Row;
    expect(t.c).toBe(agg(cellsFor('2026-09-15', opts.dataStart, 3)).c);
    expect(r2.rows.filter((r) => r.s === 'p').reduce((a, r) => a + r.c, 0)).toBe(t.c);
    const events = await store.readLedger<{ type: string; day: string; detail: string }>('events');
    expect(events.filter((e) => e.type === 'revision').map((e) => e.day)).toEqual(['2026-09-15']);
    expect(events.filter((e) => e.type === 'revalidated').map((e) => e.day).sort()).toEqual(dateRange('2026-09-11', '2026-09-17'));
    expect(result.notes.join(' | ')).toContain('7 recent days double-checked, 1 updated by Google since');

    // Nothing is revalidated twice.
    const { plan: again } = await run(store, fakeFetch([fakeGsc(opts)]).fetch, '2026-10-07T13:00:00Z');
    // Only 2026-09-27 (sealed young by the second run, now 10 days old) is new; 09-11 to 09-17 are done.
    expect(again.payload.revalidateDays).toEqual(['2026-09-27']);
  });

  it('the 0.5% rule', () => {
    expect(differs(1000, 1005)).toBe(false);
    expect(differs(1000, 1006)).toBe(true);
    expect(differs(0, 0)).toBe(false);
    expect(differs(0, 1)).toBe(true);
    expect(differs(6, 7)).toBe(true);
  });

  it('pages until a short page, deduplicates keeping the first copy, and flags truncation at 50,000 rows', async () => {
    const store = memoryStore();
    const small: FakeGscOptions = { dataStart: '2026-10-01', F: '2026-10-04', today: '2026-10-06', big: { day: '2026-10-02', rows: 60_000 }, duplicateOn: '2026-10-03' };
    const ff = fakeFetch([fakeGsc(small)]);
    const { result } = await run(store, ff.fetch, AT, { cfg: config({ backfillMonths: 1 }) });
    expect(result.status).toBe('ok');
    const qpdCalls = bodies(ff.calls).filter((b) => b.dimensions.join(',') === 'query,page,device');
    // 2026-10-02 is paged at 0 and 25,000 and stops at the 50,000 cap; the other days need one page.
    expect(qpdCalls.filter((b) => b.startDate === '2026-10-02').map((b) => b.startRow)).toEqual([0, 25_000]);
    expect(qpdCalls.filter((b) => b.startDate !== '2026-10-02').every((b) => b.startRow === 0)).toBe(true);
    const big = await store.readPartition<Row>('gsc/2026/10/2026-10-02.ndjson.gz');
    expect(big.meta.slices?.qpd).toEqual({ rows: 50_000, truncated: true });
    const events = await store.readLedger<{ type: string; day: string }>('events');
    expect(events.filter((e) => e.type === 'truncated').map((e) => e.day)).toEqual(['2026-10-02']);
    // The duplicated [page] row was dropped and the first copy kept.
    const dup = await store.readPartition<Row>('gsc/2026/10/2026-10-03.ndjson.gz');
    const home = dup.rows.filter((r) => r.s === 'p' && r.p === HOME);
    expect(home).toHaveLength(1);
    expect(home[0].c).toBe(agg(cellsFor('2026-10-03', small.dataStart).filter((c) => c.p === HOME)).c);
    expect(result.notes.join(' | ')).toContain('1 duplicate rows');
  });

  it('persistent 429 saves finished days, defers the rest and ends partial', async () => {
    const store = memoryStore();
    let pageCalls = 0;
    const ff = fakeFetch([
      fakeGsc({
        ...opts,
        override: (body) => {
          if (body.dimensions.join(',') !== 'page') return null;
          pageCalls++;
          return pageCalls > 5 ? { status: 429, headers: { 'retry-after': '3600' }, body: { error: { code: 429, message: 'Quota exceeded' } } } : null;
        },
      }),
    ]);
    const { result } = await run(store, ff.fetch, AT, { cfg: config({ concurrency: 1 }) });
    expect(result.status).toBe('partial');
    expect(result.errors[0].code).toBe('quota');
    const sealed = (await dayFiles(store)).filter((p) => !p.includes('fresh'));
    expect(sealed).toHaveLength(5);
    const deferred = (await store.readLedger<{ type: string; day: string }>('events')).filter((e) => e.type === 'deferred');
    expect(deferred).toHaveLength(45 - 5);
    expect(result.notes.join(' ')).toContain('stopped early (quota)');
    // The next run picks up where it left off.
    const next = await run(store, fakeFetch([fakeGsc(opts)]).fetch, '2026-10-06T20:00:00Z');
    expect(next.result.status).toBe('ok');
    expect(next.result.notes[0]).toBe('45 days stored (40 new)');
    expect((await dayFiles(store)).filter((p) => !p.includes('fresh'))).toHaveLength(45);
  });

  it('a first run never saves a later day before the first data day, so a failed first day is fetched next run', async () => {
    const store = memoryStore();
    let failing = true;
    const fail = (body: GscQueryBody): FakeReply | null =>
      failing && body.dimensions.join(',') === 'page' && body.startDate === opts.dataStart ? { status: 500, body: { error: { code: 500, message: 'backend error' } } } : null;
    const first = await run(store, fakeFetch([fakeGsc({ ...opts, override: fail })]).fetch, AT);
    expect(first.result.status).toBe('partial');
    // Nothing later than the failed first day was saved, so the next run is a clean first run again.
    expect((await dayFiles(store)).filter((p) => !p.includes('fresh'))).toEqual([]);
    failing = false;
    await run(store, fakeFetch([fakeGsc(opts)]).fetch, '2026-10-07T13:00:00Z');
    const days = (await dayFiles(store)).filter((p) => !p.includes('fresh'));
    expect(days[0]).toContain(opts.dataStart);
    expect(days).toHaveLength(45);
  });

  it('403 on the probe throws a permission error with the fix line', async () => {
    const ff = fakeFetch([
      fakeGsc({ ...opts, override: () => ({ status: 403, body: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:example.com'." } } }) }),
    ]);
    const err = (await run(memoryStore(), ff.fetch, AT).catch((e: unknown) => e)) as StError;
    expect(err).toBeInstanceOf(StError);
    expect(err.code).toBe('permission');
    expect(err.fix).toBe(`Add ${AUTH.principal} as a user on ${PROPERTY} in Search Console > Settings > Users and permissions.`);
  });

  it('retries a 503 and carries on', async () => {
    const store = memoryStore();
    let failed = false;
    const ff = fakeFetch([
      fakeGsc({
        ...opts,
        override: (body) => {
          if (!failed && body.dimensions.join(',') === 'query,page,device') {
            failed = true;
            return { status: 503, body: { error: { message: 'backend error' } } };
          }
          return null;
        },
      }),
    ]);
    const { result } = await run(store, ff.fetch, AT);
    expect(result.status).toBe('ok');
    expect((await dayFiles(store)).filter((p) => !p.includes('fresh'))).toHaveLength(45);
  });

  it('offline or without a credential the phase is skipped and nothing is fetched', async () => {
    const ff = fakeFetch([]);
    const off = await run(memoryStore(), ff.fetch, AT, { offline: true });
    expect(off.plan.skip).toBe('offline');
    expect(off.result.status).toBe('skipped');
    const noAuth = await run(memoryStore(), ff.fetch, AT, { google: null });
    expect(noAuth.plan.skip).toBe('no Google credential');
    expect(noAuth.plan.payload.sealDays.length).toBeGreaterThan(0); // the dry-run plan is still sized
    expect(noAuth.result.status).toBe('skipped');
    expect(ff.calls).toHaveLength(0);
  });

  it('plan() fetches nothing and estimates requests from the plan', async () => {
    const ff = fakeFetch([]);
    const ctx = ctxFor(memoryStore(), ff.fetch, AT);
    const plan = await gscCollector.plan(ctx);
    expect(ff.calls).toHaveLength(0);
    // F is unknown before the probe, so the plan assumes today - 3.
    expect(plan.payload.sealDays[plan.payload.sealDays.length - 1]).toBe(addDays('2026-10-06', -4));
    expect(plan.estRequests).toBe(2 + 3 * plan.payload.rangeChunks.length + 2 * plan.payload.sealDays.length);
    expect(plan.estUsd).toBe(0);
    expect(plan.lines[0].detail).toContain('last 4 days refreshed');
  });

  it('a property with no data seals nothing', async () => {
    const store = memoryStore();
    const ff = fakeFetch([fakeGsc({ ...opts, dataStart: '2027-01-01' })]);
    const { result } = await run(store, ff.fetch, AT);
    expect(result.status).toBe('ok');
    expect((await dayFiles(store)).filter((p) => !p.includes('fresh'))).toEqual([]);
    expect(result.notes.join(' ')).toContain('no data');
  });
});
