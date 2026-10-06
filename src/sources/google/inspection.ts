// inspectionCollector: priority scheduler, quota accounting, URL Inspection calls (4.3). Owner: WP-C.
//
// Budget for the Pacific Time day: min(inspection.dailyBudget, floor(2000 * shareOfPropertyQuota))
// minus every count already in ledger/inspect for that PT day. Calls are paced at 4 per second.
// Queue, highest priority first, skipping any URL inspected in the last 20 hours:
//   P0 post_change   URLs of site changes deployed in the last 7 days that Google has not
//                    recrawled since (googleSeen is null). Inspected daily until it has.
//   P1 blast_radius  pages tied to the top 20 findings of the latest findings partition,
//                    not inspected in 3 days.
//   P2 traffic       pages with impressions in the last 28 days, not inspected in 7 days;
//                    oldest inspection first, then impressions.
//   P3 coverage      pages in the latest crawl that were never inspected.
// A 429 or RESOURCE_EXHAUSTED stops inspecting for the day (a 'deferred' ledger event). A 403
// fails the phase with the fix line for Full permission. Records are written as one partition.
import { z } from 'zod';
import { StError } from '../../core/errors.js';
import { addDays, ptDate } from '../../core/time.js';
import type {
  Collector,
  CollectorPlan,
  Finding,
  InspectionPlan,
  InspectionRecord,
  InspectReason,
  IsoDate,
  PartitionMeta,
  PhaseResult,
  RunContext,
  SiteChange,
} from '../../core/types.js';
import { isOnProperty, normalizeUrl } from '../../core/url.js';
import { createLimiter } from '../../http/limiter.js';
import { requestJson } from '../../http/request.js';
import { layout } from '../../store/layout.js';
import { deriveSiteChanges } from '../crawl/diff.js';

export const INSPECT_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
/** URL Inspection quota per property per day, shared with every other tool the owner runs. */
export const PROPERTY_DAILY_QUOTA = 2000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SKIP_RECENT_MS = 20 * HOUR;
const P0_WINDOW_MS = 7 * DAY;
const P1_STALE_MS = 3 * DAY;
const P2_STALE_MS = 7 * DAY;
const TOP_FINDINGS = 20;
const TRAFFIC_DAYS = 28;
const SNAPSHOT_LOOKBACK_MS = 60 * DAY;
const MAX_CONSECUTIVE_FAILURES = 10;

export interface InspectLedgerRecord {
  at: string;
  runId: string;
  ptDay: IsoDate;
  count: number;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Inspections in flight at once (see execute). */
export const INSPECT_CONCURRENCY = 8;
const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function safeNormalize(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    return normalizeUrl(u);
  } catch {
    return null;
  }
}

/** The day's ceiling before anything is used: min(dailyBudget, floor(2000 * share)). */
export function dailyCap(cfg: RunContext['config']): number {
  return Math.max(0, Math.min(cfg.inspection.dailyBudget, Math.floor(PROPERTY_DAILY_QUOTA * cfg.inspection.shareOfPropertyQuota)));
}

/** Checks already counted in ledger/inspect for this PT day (every run, every tool version). */
export async function usedOn(store: RunContext['store'], ptDay: IsoDate): Promise<number> {
  const recs = await store.readLedger<Partial<InspectLedgerRecord>>('inspect');
  return recs.reduce((sum, r) => sum + (r.ptDay === ptDay && typeof r.count === 'number' && r.count > 0 ? r.count : 0), 0);
}

export interface QueueInput {
  now: number;
  property: string;
  budget: number;
  inspections: InspectionRecord[];
  changes: SiteChange[];
  /** Pages tied to the top findings, in priority order. */
  findingPages: string[];
  /** Pages with impressions in the last 28 days. */
  traffic: Map<string, number>;
  /** Pages in the latest crawl. */
  crawled: string[];
}

/** The pure priority scheduler (P0 to P3), capped at budget. */
export function buildQueue(i: QueueInput): { url: string; reason: InspectReason }[] {
  if (i.budget <= 0) return [];
  const last = new Map<string, number>();
  for (const r of i.inspections) {
    const u = safeNormalize(r.url);
    const t = Date.parse(r.inspectedAt);
    if (u && Number.isFinite(t) && t > (last.get(u) ?? Number.NEGATIVE_INFINITY)) last.set(u, t);
  }
  const ageOf = (u: string): number => {
    const t = last.get(u);
    return t === undefined ? Number.POSITIVE_INFINITY : i.now - t;
  };
  const out: { url: string; reason: InspectReason }[] = [];
  const taken = new Set<string>();
  const take = (urls: string[], reason: InspectReason, minAge: number): void => {
    for (const raw of urls) {
      if (out.length >= i.budget) return;
      const u = safeNormalize(raw);
      if (!u || taken.has(u) || !isOnProperty(u, i.property)) continue;
      const age = ageOf(u);
      if (age < SKIP_RECENT_MS || age < minAge) continue;
      taken.add(u);
      out.push({ url: u, reason });
    }
  };

  // P0: recent site changes Google has not recrawled yet, newest first.
  const p0 = i.changes
    .filter((c) => {
      const to = Date.parse(c.deployed.to);
      return Number.isFinite(to) && to <= i.now && i.now - to <= P0_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.deployed.to) - Date.parse(a.deployed.to) || cmp(a.id, b.id))
    .flatMap((c) => c.touched.filter((t) => t.googleSeen === null).map((t) => t.url).sort(cmp));
  take(p0, 'post_change', 0);
  // P1: pages behind the top findings.
  take(i.findingPages, 'blast_radius', P1_STALE_MS);
  // P2: traffic pages, oldest inspection first, then impressions.
  const p2 = [...i.traffic.entries()]
    .filter(([, n]) => n > 0)
    .map(([u, n]) => ({ u: safeNormalize(u) ?? u, n }))
    .sort((a, b) => {
      const ta = last.get(a.u) ?? Number.NEGATIVE_INFINITY;
      const tb = last.get(b.u) ?? Number.NEGATIVE_INFINITY;
      return ta - tb || b.n - a.n || cmp(a.u, b.u);
    })
    .map((x) => x.u);
  take(p2, 'traffic', P2_STALE_MS);
  // P3: crawled pages never inspected.
  take(
    [...new Set(i.crawled.map((u) => safeNormalize(u) ?? u))].filter((u) => !last.has(u)).sort(cmp),
    'coverage',
    0,
  );
  return out;
}

/** Pages a finding points at: its page unit, its verify page, and page or url keys in its evidence. */
function pagesOfFinding(f: Finding, changesById: Map<string, SiteChange>): string[] {
  const out: string[] = [];
  if (f.unit?.level === 'page' && f.unit.key) out.push(f.unit.key);
  if (f.verify?.page) out.push(f.verify.page);
  for (const e of f.evidence ?? []) {
    if (e.key?.page) out.push(e.key.page);
    if (e.key?.url) out.push(e.key.url);
  }
  for (const id of f.related?.siteChanges ?? []) for (const t of changesById.get(id)?.touched ?? []) out.push(t.url);
  return out;
}

async function latestPartitionRows<T>(ctx: RunContext, prefix: string): Promise<T[]> {
  const files = (await ctx.store.list(prefix)).filter((f) => f.path.endsWith('.ndjson.gz'));
  const last = files[files.length - 1];
  if (!last) return [];
  try {
    return (await ctx.store.readPartition<T>(last.path)).rows;
  } catch {
    return [];
  }
}

function skipPlan(reason: string): CollectorPlan<InspectionPlan> {
  return {
    lines: [{ group: 'free', label: 'Index checks', detail: reason }],
    estRequests: 0,
    estUsd: 0,
    payload: { budget: 0, queue: [] },
    skip: reason,
  };
}

async function plan(ctx: RunContext): Promise<CollectorPlan<InspectionPlan>> {
  const cfg = ctx.config;
  if (!cfg.inspection.enabled) return skipPlan('Index checks are turned off (inspection.enabled is false).');
  if (ctx.flags.offline) return skipPlan('Skipped in offline mode.');
  if (!ctx.google) return skipPlan('Skipped: no working Google credential.');
  const now = ctx.clock.now().getTime();
  const cap = dailyCap(cfg);
  if (cap <= 0) return skipPlan('Index checks are turned off (the daily budget is 0).');
  const used = await usedOn(ctx.store, ptDate(ctx.clock.now()));
  const budget = cap - used;
  if (budget <= 0) return skipPlan(`All ${fmtInt(cap)} index checks for today are used. More tomorrow.`);

  const inspections = ctx.index.inspections();
  const changes = deriveSiteChanges({
    snapshots: ctx.index.snapshots({ since: iso(now - SNAPSHOT_LOOKBACK_MS) }),
    fieldsByHash: ctx.index.fieldsByHash(),
    annotations: ctx.index.annotations(),
    inspections,
    templates: new Map(),
  });
  const changesById = new Map(changes.map((c) => [c.id, c]));
  const findings = (await latestPartitionRows<Finding>(ctx, 'findings/'))
    .filter((f) => f && typeof f.id === 'string')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || cmp(a.id, b.id))
    .slice(0, TOP_FINDINGS);
  const findingPages = findings.flatMap((f) => pagesOfFinding(f, changesById));
  const traffic = new Map<string, number>();
  const through = ctx.index.dataRange().sealedThrough;
  if (through) {
    for (const r of ctx.index.pageDaily(addDays(through, -(TRAFFIC_DAYS - 1)), through)) traffic.set(r.p, (traffic.get(r.p) ?? 0) + r.i);
  }
  const crawled = (await latestPartitionRows<{ url?: unknown }>(ctx, 'crawl/')).map((r) => r.url).filter((u): u is string => typeof u === 'string');

  const queue = buildQueue({ now, property: cfg.property, budget, inspections, changes, findingPages, traffic, crawled });
  return {
    lines: [
      {
        group: 'free',
        label: 'Index checks',
        detail: queue.length === 0 && !through
          ? `pages are picked once Search Console data is in, up to ${fmtInt(budget)} checks today`
          : `${fmtInt(queue.length)} page${queue.length === 1 ? '' : 's'}, ${fmtInt(used + queue.length)} of your ${fmtInt(PROPERTY_DAILY_QUOTA)} daily checks`,
      },
    ],
    estRequests: queue.length,
    estUsd: 0,
    payload: { budget, queue },
    skip: queue.length === 0 ? 'Nothing needs an index check right now.' : null,
  };
}

// ---------- response parsing ----------

const IndexStatusSchema = z.object({
  verdict: z.string().optional(),
  coverageState: z.string().optional(),
  robotsTxtState: z.string().optional(),
  indexingState: z.string().optional(),
  lastCrawlTime: z.string().optional(),
  pageFetchState: z.string().optional(),
  googleCanonical: z.string().optional(),
  userCanonical: z.string().optional(),
  crawledAs: z.string().optional(),
  sitemap: z.array(z.string()).optional(),
  referringUrls: z.array(z.string()).optional(),
});
const RichResultsSchema = z.object({
  verdict: z.string().optional(),
  detectedItems: z.array(z.object({ richResultType: z.string().optional() })).optional(),
});
const InspectResponseSchema = z.object({
  inspectionResult: z.object({
    indexStatusResult: IndexStatusSchema.optional(),
    richResultsResult: RichResultsSchema.optional(),
  }),
});

function instantOrUndefined(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? iso(ms) : undefined;
}

/** Maps a urlInspection/index:inspect response into an InspectionRecord, or null when it does not look like one. */
export function toInspectionRecord(raw: unknown, url: string, inspectedAt: string, reason: InspectReason): InspectionRecord | null {
  const parsed = InspectResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data.inspectionResult.indexStatusResult ?? {};
  const rich = parsed.data.inspectionResult.richResultsResult;
  const rec: InspectionRecord = { url, inspectedAt, reason, verdict: s.verdict ?? 'VERDICT_UNSPECIFIED' };
  if (s.coverageState) rec.coverageState = s.coverageState;
  if (s.indexingState) rec.indexingState = s.indexingState;
  if (s.robotsTxtState) rec.robotsTxtState = s.robotsTxtState;
  if (s.pageFetchState) rec.pageFetchState = s.pageFetchState;
  const lastCrawlTime = instantOrUndefined(s.lastCrawlTime);
  if (lastCrawlTime) rec.lastCrawlTime = lastCrawlTime;
  const gc = safeNormalize(s.googleCanonical);
  if (gc) rec.googleCanonical = gc;
  const uc = safeNormalize(s.userCanonical);
  if (uc) rec.userCanonical = uc;
  if (s.crawledAs) rec.crawledAs = s.crawledAs;
  if (s.sitemap?.length) rec.sitemaps = [...new Set(s.sitemap)].sort().slice(0, 50);
  if (s.referringUrls?.length) rec.referringUrls = s.referringUrls.slice(0, 10);
  if (rich) {
    const types = (rich.detectedItems ?? []).map((d) => d.richResultType).filter((t): t is string => typeof t === 'string' && t !== '');
    rec.richResults = { verdict: rich.verdict ?? 'VERDICT_UNSPECIFIED', types: [...new Set(types)].sort() };
  }
  return rec;
}

function googleErrorStatus(data: unknown): string | null {
  const err = (data as { error?: { status?: unknown } } | null)?.error;
  return typeof err?.status === 'string' ? err.status : null;
}

// ---------- execute ----------

async function execute(p: CollectorPlan<InspectionPlan>, ctx: RunContext): Promise<PhaseResult> {
  const startedAt = iso(ctx.clock.now().getTime());
  const requests: Record<string, number> = { 'inspect.call': 0 };
  const done = (status: PhaseResult['status'], extra: Partial<PhaseResult> = {}): PhaseResult => ({
    name: 'inspect',
    status,
    startedAt,
    endedAt: iso(ctx.clock.now().getTime()),
    requests,
    rows: 0,
    costUsd: 0,
    partitions: [],
    notes: [],
    errors: [],
    ...extra,
  });
  if (p.skip) return done('skipped', { notes: [p.skip] });
  const google = ctx.google;
  if (!google) return done('skipped', { notes: ['Skipped: no working Google credential.'] });

  const property = ctx.config.property;
  const ptDay = ptDate(ctx.clock.now());
  const used = await usedOn(ctx.store, ptDay);
  const budget = Math.min(p.payload.budget, dailyCap(ctx.config) - used);
  const queue = p.payload.queue.slice(0, Math.max(0, budget));
  // 4 req/s as 4.3 says. Google takes about 4 to 10 s to answer each inspection (measured on a
  // real property: a median of 8 s), so with only 2 in flight 200 checks took 13 minutes. Eight in
  // flight keeps the same 4 req/s ceiling, well inside the 600 per minute quota.
  const limiter = createLimiter({ rps: 4, concurrency: INSPECT_CONCURRENCY });
  const records: InspectionRecord[] = [];
  let calls = 0;
  let failures = 0;
  let consecutive = 0;
  let quotaHit = false;
  let fatal: StError | null = null;

  const inspectOne = async (item: { url: string; reason: InspectReason }): Promise<void> => {
    if (quotaHit || fatal || ctx.signal.aborted || consecutive >= MAX_CONSECUTIVE_FAILURES) return;
    let res: { status: number; data: unknown };
    try {
      const call = async (): Promise<{ status: number; data: unknown }> => {
        const headers = await google.headers(ctx.signal);
        requests['inspect.call']++;
        return requestJson<unknown>(ctx.fetch, {
          url: INSPECT_ENDPOINT,
          method: 'POST',
          headers,
          body: { inspectionUrl: item.url, siteUrl: property, languageCode: 'en-US' },
          idempotent: true,
          retry: { attempts: 4, baseMs: 1000, capMs: 64_000, on: [500, 502, 503, 504] },
          signal: ctx.signal,
        });
      };
      res = await call();
      // 4.7: a 401 means the access token went stale; drop it, refresh once, and try again.
      if (res.status === 401 && google.invalidate) {
        google.invalidate();
        res = await call();
      }
    } catch (e) {
      if (ctx.signal.aborted) return;
      if (e instanceof StError && (e.code === 'auth' || e.code === 'reauth_required' || e.code === 'permission')) {
        fatal = e;
        return;
      }
      failures++;
      consecutive++;
      return;
    }
    if (res.status === 429 || googleErrorStatus(res.data) === 'RESOURCE_EXHAUSTED') {
      quotaHit = true;
      return;
    }
    calls++;
    if (res.status === 401) {
      fatal = new StError('auth', 'Google turned down the credential while checking index status.', 'Run `npx searchtrace doctor` to see what is wrong with the credential.');
      return;
    }
    if (res.status === 403) {
      fatal = new StError(
        'permission',
        `URL Inspection is not allowed for ${google.principal} on ${property}.`,
        `Give ${google.principal} Full permission on ${property} in Search Console (Restricted users may not be allowed to inspect URLs).`,
      );
      return;
    }
    const rec = res.status >= 200 && res.status < 300 ? toInspectionRecord(res.data, item.url, iso(ctx.clock.now().getTime()), item.reason) : null;
    if (!rec) {
      failures++;
      consecutive++;
      return;
    }
    consecutive = 0;
    records.push(rec);
  };

  await Promise.all(queue.map((item) => limiter.run(() => inspectOne(item))));

  // Persist what was collected, whatever stopped the loop.
  const at = iso(ctx.clock.now().getTime());
  if (calls > 0) await ctx.store.append('inspect', { at, runId: ctx.runId, ptDay, count: calls } satisfies InspectLedgerRecord);
  if (quotaHit) await ctx.store.append('events', { at, runId: ctx.runId, type: 'deferred', day: ptDay, detail: 'URL Inspection quota reached; the rest waits for the next Pacific Time day.' });
  const partitions: string[] = [];
  records.sort((a, b) => cmp(a.url, b.url) || cmp(a.inspectedAt, b.inspectedAt));
  if (records.length > 0) {
    const meta: PartitionMeta = { kind: 'inspect', schema: 1, property, toolVersion: ctx.toolVersion, runId: ctx.runId, fetchedAt: at };
    const written = await ctx.store.writePartition(layout.perRun('inspect', ctx.runId, ctx.startedAt), meta, records);
    partitions.push(written.path);
  }

  const notes = [`${fmtInt(used + calls)} of your ${fmtInt(PROPERTY_DAILY_QUOTA)} daily checks used`];
  if (quotaHit) notes.push("Google's daily limit for index checks was reached. The rest will be checked tomorrow.");
  if (failures > 0) notes.push(`${failures} ${failures === 1 ? 'check' : 'checks'} failed and will be retried on a later run.`);
  const base = { rows: records.length, partitions, notes };
  const err = fatal as StError | null;
  if (err) {
    const message = ctx.secrets.redact(err.fix ? `${err.message} ${err.fix}` : err.message);
    return done('failed', { ...base, errors: [{ code: err.code, message }] });
  }
  if (quotaHit) return done('deferred', base);
  return done(failures > 0 || ctx.signal.aborted ? 'partial' : 'ok', base);
}

export const inspectionCollector: Collector<InspectionPlan> = {
  name: 'inspect',
  plan,
  execute,
};
