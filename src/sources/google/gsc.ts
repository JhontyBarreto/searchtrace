// gscCollector: range and per-day calls, paging, sealing, fresh tail, revalidation (4.2). Owner: WP-B.
//
// One run, in order:
//   1. Probe: [date] over the last 10 days with dataState "all". Gives firstIncompleteDate F.
//   2. Re-plan with the real F (plan() only estimates F, because a dry run fetches nothing).
//   3. Range calls per calendar-month chunk: t [date], td [date, device], tc [date, country], all byProperty.
//   4. Per seal day: p [page] and qpd [query, page, device], byPage, one day each, paged.
//      Each day file is written as soon as its five slices are in hand.
//   5. Revalidation of young-sealed days: a difference over 0.5% writes revision n+1.
//   6. The provisional tail (probe t rows and a fresh td call from F to today) goes to state/gsc-fresh.
// Page is never requested with country, and with device only inside the named-query slice
// (query, page, device): any other page grouping that adds device or country silently drops the
// anonymised queries (spec 0.2 F1). No request uses dimension filters.
import { StError } from '../../core/errors.js';
import { addDays, dateRange, diffDays, ptDate } from '../../core/time.js';
import type {
  Collector, CollectorPlan, DataStore, Device, GoogleAuth, GscPlan, GscPlanState, Instant, IsoDate, PartitionMeta, PhaseResult,
  PlanLine, RunContext, SliceName,
} from '../../core/types.js';
import { normalizeUrl } from '../../core/url.js';
import { createLimiter } from '../../http/limiter.js';
import { layout } from '../../store/layout.js';
import { googleJson } from './auth.js';
import { effectiveIncompleteDate, planGsc } from './gsc-plan.js';

export const GSC_BASE = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

/** Paging and retry knobs. Tests shrink the backoff; real runs use the defaults (spec 4.2 and 4.7). */
export const gscTuning = { rowLimit: 25_000, maxRows: 50_000, retryBaseMs: 1000, retryCapMs: 64_000, attempts: 6, timeoutMs: 60_000 };

/** A sealed day differs from the range totals when clicks or impressions move by more than this share. */
export const REVALIDATE_TOLERANCE = 0.005;

type Dim = 'date' | 'page' | 'query' | 'device' | 'country';

export interface GscQueryBody {
  startDate: IsoDate;
  endDate: IsoDate;
  dimensions: Dim[];
  type: 'web';
  dataState: 'final' | 'all';
  aggregationType?: 'byProperty' | 'byPage';
  rowLimit: number;
  startRow: number;
}

interface ApiRow { keys: string[]; c: number; i: number; ps: number }
interface Fetched { rows: ApiRow[]; truncated: boolean; duplicates: number; firstIncompleteDate: IsoDate | null }
interface Sums { c: number; i: number; ps: number }

type DayRow =
  | { s: 't'; c: number; i: number; ps: number }
  | { s: 'td'; dv: Device; c: number; i: number; ps: number }
  | { s: 'tc'; cc: string; c: number; i: number; ps: number }
  | { s: 'p'; p: string; c: number; i: number; ps: number }
  | { s: 'qpd'; q: string; p: string; dv: Device; c: number; i: number; ps: number };

type FreshRow = { s: 't'; date: IsoDate; c: number; i: number; ps: number } | { s: 'td'; date: IsoDate; dv: Device; c: number; i: number; ps: number };

/** Per-day results of the range calls. */
interface RangeDay {
  t: Sums | null;
  td: Map<string, Sums>;
  tc: Map<string, Sums>;
  truncated: { t: boolean; td: boolean; tc: boolean };
}

// ---------- small helpers ----------

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function instant(d: Date): Instant {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deviceOf(raw: string): Device | null {
  const v = raw.toUpperCase();
  if (v === 'DESKTOP') return 'desktop';
  if (v === 'MOBILE' || v === 'TABLET') return 'mobile'; // D22: tablet is summed into mobile
  return null;
}

function add(map: Map<string, Sums>, key: string, r: Sums): void {
  const prev = map.get(key);
  if (prev) {
    prev.c += r.c;
    prev.i += r.i;
    prev.ps += r.ps;
  } else {
    map.set(key, { c: r.c, i: r.i, ps: r.ps });
  }
}

function safePage(raw: string): string | null {
  try {
    return normalizeUrl(raw);
  } catch {
    return null;
  }
}

/** True when a and b differ by more than the revalidation tolerance. */
export function differs(a: number, b: number): boolean {
  if (a === b) return false;
  return Math.abs(a - b) > REVALIDATE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

// ---------- state from the store (the source of truth; the index may be empty in CI) ----------

const GSC_PATH = /^gsc\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})(?:\.r(\d+))?\.ndjson\.gz$/;

/** fetchedAt by partition path, per store. Saved partitions never change, so entries never go stale. */
const fetchedAtCache = new WeakMap<DataStore, Map<string, Instant>>();

export interface SealedState {
  state: GscPlanState;
  /** Highest-revision partition path per sealed day. */
  paths: Map<IsoDate, { path: string; revision: number }>;
}

/** Reads sealed days from gsc/ partition names and revalidations from the events ledger. */
export async function readSealedState(store: DataStore, cfg: { backfillMonths: number; revalidateAfterDays: number }, today: IsoDate): Promise<SealedState> {
  const paths = new Map<IsoDate, { path: string; revision: number }>();
  for (const f of await store.list('gsc/')) {
    const m = GSC_PATH.exec(f.path);
    if (!m) continue;
    const revision = m[4] === undefined ? 1 : Number(m[4]);
    const prev = paths.get(m[3]);
    if (!prev || revision > prev.revision) paths.set(m[3], { path: f.path, revision });
  }
  const revalidated = new Set<IsoDate>();
  for (const e of await store.readLedger<{ type?: unknown; day?: unknown }>('events')) {
    if (e && e.type === 'revalidated' && typeof e.day === 'string') revalidated.add(e.day);
  }
  const sealed: GscPlanState['sealed'] = [];
  let cache = fetchedAtCache.get(store);
  if (!cache) {
    cache = new Map();
    fetchedAtCache.set(store, cache);
  }
  for (const [day, x] of [...paths.entries()].sort(([a], [b]) => cmp(a, b))) {
    // fetchedAt only matters for days that could be revalidated now; reading every meta would cost
    // a full gunzip per day, so other days carry '' (the planner treats that as "not young").
    const candidate = x.revision < 2 && !revalidated.has(day) && diffDays(day, today) >= cfg.revalidateAfterDays;
    let fetchedAt = cache.get(x.path) ?? '';
    if (candidate && fetchedAt === '') {
      const { meta } = await store.readPartition(x.path);
      fetchedAt = typeof meta.fetchedAt === 'string' ? meta.fetchedAt : '';
      cache.set(x.path, fetchedAt);
    }
    sealed.push({ day, revision: x.revision, fetchedAt });
  }
  const days = [...paths.keys()].sort(cmp);
  return {
    paths,
    state: {
      today,
      firstIncompleteDate: null,
      sealed,
      revalidated: [...revalidated].sort(cmp),
      backfillMonths: cfg.backfillMonths,
      revalidateAfterDays: cfg.revalidateAfterDays,
      firstDataDay: days[0] ?? null,
    },
  };
}

// ---------- the API ----------

interface Api {
  query(body: Omit<GscQueryBody, 'rowLimit' | 'startRow'>, kind: 'probe' | 'query'): Promise<Fetched>;
}

function createApi(auth: GoogleAuth, ctx: RunContext, counts: { probe: number; query: number }): Api {
  const property = ctx.config.property;
  const url = `${GSC_BASE}/${encodeURIComponent(property)}/searchAnalytics/query`;
  const limiter = createLimiter({ rps: ctx.config.gsc.requestsPerSecond, concurrency: ctx.config.gsc.concurrency });
  const page = (body: GscQueryBody, kind: 'probe' | 'query'): Promise<unknown> =>
    limiter.run(() => {
      counts[kind]++;
      return googleJson<unknown>(
        auth,
        ctx.fetch,
        {
          url,
          method: 'POST',
          body,
          timeoutMs: gscTuning.timeoutMs,
          retry: { attempts: gscTuning.attempts, baseMs: gscTuning.retryBaseMs, capMs: gscTuning.retryCapMs, on: [429, 500, 502, 503, 504] },
          idempotent: true, // a query only reads, so a network error can safely be retried
          signal: ctx.signal,
        },
        { property, what: 'Search Console query' },
      );
    });

  return {
    async query(base, kind) {
      const seen = new Set<string>();
      const rows: ApiRow[] = [];
      let duplicates = 0;
      let truncated = false;
      let firstIncompleteDate: IsoDate | null = null;
      for (let startRow = 0; ; ) {
        const data = (await page({ ...base, rowLimit: gscTuning.rowLimit, startRow }, kind)) as {
          rows?: unknown;
          metadata?: { firstIncompleteDate?: unknown };
        } | null;
        const f = data?.metadata?.firstIncompleteDate;
        if (firstIncompleteDate === null && typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f)) firstIncompleteDate = f;
        const got = Array.isArray(data?.rows) ? data.rows : [];
        for (const raw of got) {
          const r = raw as { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown };
          if (!Array.isArray(r?.keys) || !r.keys.every((k) => typeof k === 'string')) continue;
          const keys = r.keys as string[];
          const key = JSON.stringify(keys);
          if (seen.has(key)) {
            duplicates++; // keep the first copy
            continue;
          }
          seen.add(key);
          const i = num(r.impressions);
          rows.push({ keys, c: num(r.clicks), i, ps: num(r.position) * i });
        }
        if (got.length < gscTuning.rowLimit) break;
        startRow += gscTuning.rowLimit;
        if (startRow >= gscTuning.maxRows) {
          truncated = true;
          break;
        }
      }
      return { rows, truncated, duplicates, firstIncompleteDate };
    },
  };
}

// ---------- slices ----------

async function fetchRange(api: Api, from: IsoDate, to: IsoDate, out: Map<IsoDate, RangeDay>, anomalies: { duplicates: number }): Promise<void> {
  const base = { startDate: from, endDate: to, type: 'web' as const, dataState: 'final' as const, aggregationType: 'byProperty' as const };
  const t = await api.query({ ...base, dimensions: ['date'] }, 'query');
  const td = await api.query({ ...base, dimensions: ['date', 'device'] }, 'query');
  const tc = await api.query({ ...base, dimensions: ['date', 'country'] }, 'query');
  anomalies.duplicates += t.duplicates + td.duplicates + tc.duplicates;
  const day = (d: IsoDate): RangeDay => {
    let x = out.get(d);
    if (!x) {
      x = { t: null, td: new Map(), tc: new Map(), truncated: { t: t.truncated, td: td.truncated, tc: tc.truncated } };
      out.set(d, x);
    }
    return x;
  };
  for (const d of dateRange(from, to)) day(d);
  for (const r of t.rows) {
    if (r.keys[0] < from || r.keys[0] > to) continue;
    const x = day(r.keys[0]);
    x.t = { c: (x.t?.c ?? 0) + r.c, i: (x.t?.i ?? 0) + r.i, ps: (x.t?.ps ?? 0) + r.ps };
  }
  for (const r of td.rows) {
    const dv = deviceOf(r.keys[1] ?? '');
    if (dv && r.keys[0] >= from && r.keys[0] <= to) add(day(r.keys[0]).td, dv, r);
  }
  for (const r of tc.rows) {
    const cc = (r.keys[1] ?? '').toLowerCase();
    if (cc && r.keys[0] >= from && r.keys[0] <= to) add(day(r.keys[0]).tc, cc, r);
  }
}

interface PageSlices { p: Map<string, Sums>; qpd: Map<string, Sums & { q: string; p: string; dv: Device }>; truncated: { p: boolean; qpd: boolean } }

async function fetchDay(api: Api, d: IsoDate, anomalies: { duplicates: number; badPages: number }): Promise<PageSlices> {
  const base = { startDate: d, endDate: d, type: 'web' as const, dataState: 'final' as const, aggregationType: 'byPage' as const };
  const pRes = await api.query({ ...base, dimensions: ['page'] }, 'query');
  const qRes = await api.query({ ...base, dimensions: ['query', 'page', 'device'] }, 'query');
  anomalies.duplicates += pRes.duplicates + qRes.duplicates;
  const p = new Map<string, Sums>();
  for (const r of pRes.rows) {
    const url = safePage(r.keys[0] ?? '');
    if (url) add(p, url, r);
    else anomalies.badPages++;
  }
  const qpd = new Map<string, Sums & { q: string; p: string; dv: Device }>();
  for (const r of qRes.rows) {
    const url = safePage(r.keys[1] ?? '');
    const dv = deviceOf(r.keys[2] ?? '');
    if (!url || !dv) {
      if (!url) anomalies.badPages++;
      continue;
    }
    const q = r.keys[0] ?? '';
    const key = JSON.stringify([q, url, dv]);
    const prev = qpd.get(key);
    if (prev) {
      prev.c += r.c;
      prev.i += r.i;
      prev.ps += r.ps;
    } else {
      qpd.set(key, { q, p: url, dv, c: r.c, i: r.i, ps: r.ps });
    }
  }
  return { p, qpd, truncated: { p: pRes.truncated, qpd: qRes.truncated } };
}

/** The day file's rows in a fixed order: t, td, tc, p, qpd. */
export function dayRows(range: RangeDay, pages: PageSlices): DayRow[] {
  const rows: DayRow[] = [];
  if (range.t && (range.t.i > 0 || range.t.c > 0)) rows.push({ s: 't', c: range.t.c, i: range.t.i, ps: range.t.ps });
  for (const dv of ['desktop', 'mobile'] as Device[]) {
    const x = range.td.get(dv);
    if (x) rows.push({ s: 'td', dv, c: x.c, i: x.i, ps: x.ps });
  }
  for (const [cc, x] of [...range.tc.entries()].sort(([a], [b]) => cmp(a, b))) rows.push({ s: 'tc', cc, c: x.c, i: x.i, ps: x.ps });
  for (const [p, x] of [...pages.p.entries()].sort(([a], [b]) => cmp(a, b))) rows.push({ s: 'p', p, c: x.c, i: x.i, ps: x.ps });
  const named = [...pages.qpd.values()].sort((a, b) => cmp(a.q, b.q) || cmp(a.p, b.p) || cmp(a.dv, b.dv));
  for (const x of named) rows.push({ s: 'qpd', q: x.q, p: x.p, dv: x.dv, c: x.c, i: x.i, ps: x.ps });
  return rows;
}

function sliceMeta(rows: DayRow[], range: RangeDay, pages: PageSlices): NonNullable<PartitionMeta['slices']> {
  const count = (s: SliceName): number => rows.filter((r) => r.s === s).length;
  return {
    t: { rows: count('t'), truncated: range.truncated.t },
    td: { rows: count('td'), truncated: range.truncated.td },
    tc: { rows: count('tc'), truncated: range.truncated.tc },
    p: { rows: count('p'), truncated: pages.truncated.p },
    qpd: { rows: count('qpd'), truncated: pages.truncated.qpd },
  };
}

// ---------- the collector ----------

function emptyPayload(today: IsoDate): GscPlan {
  return { probeFrom: addDays(today, -10), probeTo: today, sealDays: [], revalidateDays: [], rangeChunks: [] };
}

/** Counts with thousands separators (6.3): "1,019". */
const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function planLines(p: GscPlan, today: IsoDate, F: IsoDate, est: number): PlanLine[] {
  const tail = Math.max(0, diffDays(F, today) + 1);
  const parts = [
    p.sealDays.length === 1 ? '1 day to seal' : `${count(p.sealDays.length)} days to seal`,
    ...(p.revalidateDays.length > 0 ? [`${count(p.revalidateDays.length)} to double-check`] : []),
    `last ${tail} ${tail === 1 ? 'day' : 'days'} refreshed`,
    `about ${count(est)} requests`,
  ];
  return [{ group: 'free', label: 'Search Console data', detail: parts.join(', ') }];
}

function estimateRequests(p: GscPlan): number {
  return 2 + 3 * p.rangeChunks.length + 2 * p.sealDays.length;
}

const FATAL = new Set(['auth', 'reauth_required', 'permission', 'property_not_found', 'internal', 'config']);

function isFatal(e: unknown): boolean {
  return e instanceof StError && FATAL.has(e.code);
}

function errorOf(e: unknown, ctx: RunContext): { code: string; message: string } {
  const code = e instanceof StError ? e.code : 'internal';
  const message = e instanceof Error ? e.message : String(e);
  return { code, message: ctx.secrets.redact(message).slice(0, 500) };
}

async function plan(ctx: RunContext): Promise<CollectorPlan<GscPlan>> {
  const today = ptDate(ctx.clock.now());
  if (ctx.flags.offline) {
    return { lines: [{ group: 'free', label: 'Search Console data', detail: 'offline, nothing fetched' }], estRequests: 0, estUsd: 0, payload: emptyPayload(today), skip: 'offline' };
  }
  const { state } = await readSealedState(ctx.store, ctx.config.gsc, today);
  const payload = planGsc(state);
  const est = estimateRequests(payload);
  return {
    lines: planLines(payload, today, effectiveIncompleteDate(state), est),
    estRequests: est,
    estUsd: 0,
    payload,
    skip: ctx.google ? null : 'no Google credential',
  };
}

async function execute(p: CollectorPlan<GscPlan>, ctx: RunContext): Promise<PhaseResult> {
  const startedAt = instant(ctx.clock.now());
  const counts = { probe: 0, query: 0 };
  const result: PhaseResult = {
    name: 'gsc', status: 'ok', startedAt, endedAt: startedAt, requests: {}, rows: 0, costUsd: 0, partitions: [], notes: [], errors: [],
  };
  const finish = (): PhaseResult => {
    result.endedAt = instant(ctx.clock.now());
    result.requests = counts.probe + counts.query > 0 ? { 'gsc.probe': counts.probe, 'gsc.query': counts.query } : {};
    return result;
  };
  const auth = ctx.google;
  if (p.skip || !auth) {
    result.status = 'skipped';
    result.notes.push(p.skip === 'offline' ? 'Offline: Search Console was not contacted.' : 'Skipped: no Google credential.');
    return finish();
  }

  const api = createApi(auth, ctx, counts);
  const today = ptDate(ctx.clock.now());
  const anomalies = { duplicates: 0, badPages: 0 };
  const event = (type: string, day: IsoDate, detail: string): Promise<void> =>
    ctx.store.append('events', { at: instant(ctx.clock.now()), runId: ctx.runId, type, day, detail });
  const meta = (extra: Partial<PartitionMeta> & Pick<PartitionMeta, 'kind'>): PartitionMeta => ({
    schema: 1, property: ctx.config.property, toolVersion: ctx.toolVersion, runId: ctx.runId, fetchedAt: instant(ctx.clock.now()), ...extra,
  });

  let pending: IsoDate[] = [...p.payload.sealDays];
  let sealedNow = 0;
  let revised = 0;
  let checked = 0;
  let totalSealed = 0;
  try {
    // 1. Probe.
    const probe = await api.query({ startDate: p.payload.probeFrom, endDate: p.payload.probeTo, dimensions: ['date'], type: 'web', dataState: 'all' }, 'probe');
    // 2. Re-plan with the real F.
    const sealedState = await readSealedState(ctx.store, ctx.config.gsc, today);
    const state = { ...sealedState.state, firstIncompleteDate: probe.firstIncompleteDate };
    const F = effectiveIncompleteDate(state);
    const real = planGsc(state);
    pending = [...real.sealDays];
    totalSealed = sealedState.paths.size;

    // 3. Range calls.
    const range = new Map<IsoDate, RangeDay>();
    for (const [from, to] of real.rangeChunks) await fetchRange(api, from, to, range, anomalies);

    // The first run learns where the property's data starts; earlier days are never sealed.
    let sealDays = real.sealDays;
    if (state.firstDataDay === null) {
      const first = sealDays.find((d) => (range.get(d)?.t?.i ?? 0) > 0);
      sealDays = first ? sealDays.filter((d) => d >= first) : [];
      if (!first && real.sealDays.length > 0) result.notes.push('Search Console has no data for this property yet.');
    }
    pending = [...sealDays];

    // 4. Per-day calls, `concurrency` days in flight, each day written as soon as it is complete.
    const queue = [...sealDays];
    let stop: unknown = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop !== null) return;
        const d = queue.shift();
        if (d === undefined) return;
        try {
          const rd = range.get(d);
          if (!rd) continue;
          const pages = await fetchDay(api, d, anomalies);
          const rows = dayRows(rd, pages);
          const slices = sliceMeta(rows, rd, pages);
          const w = await ctx.store.writePartition(layout.gscDay(d), meta({ kind: 'gsc_day', day: d, revision: 1, dataState: 'final', slices }), rows);
          result.partitions.push(w.path);
          result.rows += w.rows;
          sealedNow++;
          pending = pending.filter((x) => x !== d);
          const cut = (Object.entries(slices) as [SliceName, { truncated: boolean }][]).filter(([, v]) => v.truncated).map(([k]) => k);
          if (cut.length > 0) await event('truncated', d, `Search Console stopped at ${gscTuning.maxRows} rows for: ${cut.join(', ')}`);
        } catch (e) {
          if (stop === null) stop = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.config.gsc.concurrency) }, () => worker()));
    if (stop !== null) throw stop;

    // 5. Revalidation of young-sealed days.
    for (const d of real.revalidateDays) {
      const rd = range.get(d);
      const cur = sealedState.paths.get(d);
      if (!rd || !cur) continue;
      const stored = await ctx.store.readPartition<DayRow>(cur.path);
      const old = { t: { c: 0, i: 0 }, td: new Map<string, { c: number; i: number }>() };
      for (const r of stored.rows) {
        if (r.s === 't') old.t = { c: old.t.c + num(r.c), i: old.t.i + num(r.i) };
        else if (r.s === 'td') {
          const x = old.td.get(r.dv) ?? { c: 0, i: 0 };
          old.td.set(r.dv, { c: x.c + num(r.c), i: x.i + num(r.i) });
        }
      }
      const nt = rd.t ?? { c: 0, i: 0, ps: 0 };
      let changed = differs(old.t.c, nt.c) || differs(old.t.i, nt.i);
      for (const dv of ['desktop', 'mobile'] as Device[]) {
        const a = old.td.get(dv) ?? { c: 0, i: 0 };
        const b = rd.td.get(dv) ?? { c: 0, i: 0, ps: 0 };
        if (differs(a.c, b.c) || differs(a.i, b.i)) changed = true;
      }
      if (changed) {
        const pages = await fetchDay(api, d, anomalies);
        const rows = dayRows(rd, pages);
        const revision = cur.revision + 1;
        const w = await ctx.store.writePartition(
          layout.gscDay(d, revision),
          meta({ kind: 'gsc_day', day: d, revision, dataState: 'final', slices: sliceMeta(rows, rd, pages) }),
          rows,
        );
        result.partitions.push(w.path);
        result.rows += w.rows;
        revised++;
        await event('revision', d, `revision ${revision}: clicks ${old.t.c} to ${nt.c}, impressions ${old.t.i} to ${nt.i}`);
      }
      await event('revalidated', d, changed ? `changed, wrote revision ${cur.revision + 1}` : 'unchanged');
      checked++;
    }

    // 6. Provisional tail: never analysed, only drawn as the dashed end of the timeline.
    const fresh: FreshRow[] = [];
    for (const r of probe.rows) {
      const d = r.keys[0];
      if (d >= F && d <= today) fresh.push({ s: 't', date: d, c: r.c, i: r.i, ps: r.ps });
    }
    if (F <= today) {
      const ftd = await api.query({ startDate: F, endDate: today, dimensions: ['date', 'device'], type: 'web', dataState: 'all', aggregationType: 'byProperty' }, 'query');
      const sums = new Map<string, Sums>();
      for (const r of ftd.rows) {
        const dv = deviceOf(r.keys[1] ?? '');
        if (dv && r.keys[0] >= F && r.keys[0] <= today) add(sums, `${r.keys[0]}|${dv}`, r);
      }
      for (const [k, x] of [...sums.entries()].sort(([a], [b]) => cmp(a, b))) {
        const [date, dv] = k.split('|') as [IsoDate, Device];
        fresh.push({ s: 'td', date, dv, c: x.c, i: x.i, ps: x.ps });
      }
    }
    fresh.sort((a, b) => cmp(a.date, b.date) || cmp(a.s, b.s) || cmp(a.s === 'td' ? a.dv : '', b.s === 'td' ? b.dv : ''));
    const fw = await ctx.store.writePartition(layout.gscFresh, meta({ kind: 'gsc_fresh', dataState: 'all' }), fresh);
    result.partitions.push(fw.path);
  } catch (e) {
    // Credential, permission and property problems end the phase with their own exit code, and so
    // does anything that is not an StError (a bug). Quota, network and server errors keep what was saved.
    if (!(e instanceof StError) || isFatal(e)) throw e;
    result.status = 'partial';
    result.errors.push(errorOf(e, ctx));
    if (e instanceof StError && e.code === 'quota') {
      for (const d of pending) await event('deferred', d, 'quota');
      result.notes.push('Search Console stopped early (quota). Finished days are saved; the rest will be fetched next run.');
    } else {
      result.notes.push("Search Console stopped early. Finished days are saved; the rest will be fetched next run.");
    }
  }

  const stored = totalSealed + sealedNow;
  result.notes.unshift(`${stored} ${stored === 1 ? 'day' : 'days'} stored (${sealedNow} new)`);
  if (checked > 0) result.notes.push(`${checked} recent ${checked === 1 ? 'day' : 'days'} double-checked, ${revised} updated by Google since`);
  if (anomalies.duplicates > 0) result.notes.push(`Search Console sent ${anomalies.duplicates} duplicate rows; the first copy of each was kept.`);
  if (anomalies.badPages > 0) ctx.log.debug(`gsc: skipped ${anomalies.badPages} rows with a page that is not an http(s) URL`);
  return finish();
}

export const gscCollector: Collector<GscPlan> = { name: 'gsc', plan, execute };
