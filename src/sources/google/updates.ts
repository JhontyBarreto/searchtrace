// updatesCollector: incidents.json fetch, classification, seed merge, measurement events (4.6). Owner: WP-B.
//
// Google's live feed only holds the 10 most recent incidents, so a bundled seed
// (assets/google-updates-seed.json: 58 incidents scraped from the status history pages plus
// curated reporting anomalies such as num=100) supplies the rest. Each run merges
// stored + seed + curated + live, keeping the latest `modified` per id, and writes only the
// (id, modified) pairs that are not stored yet into google/YYYY/MM/<runId>.ndjson.gz.
// Offline, or when the feed cannot be fetched, the seed and stored events are used instead.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { StError } from '../../core/errors.js';
import type { Collector, CollectorPlan, GoogleEvent, GoogleEventKind, Instant, PhaseResult, RunContext, UpdatesPlan } from '../../core/types.js';
import { requestJson } from '../../http/request.js';
import { layout } from '../../store/layout.js';

export const INCIDENTS_URL = 'https://status.search.google.com/incidents.json';
const STATUS_ORIGIN = 'https://status.search.google.com/';
const SEED_URL = new URL('../../../assets/google-updates-seed.json', import.meta.url);

/** Retry knobs for the feed (2 attempts, spec 4.7). Tests shrink the backoff. */
export const updatesTuning = { attempts: 2, retryBaseMs: 1000, retryCapMs: 4000, timeoutMs: 30_000 };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** UTC ISO instant with second precision ('2026-09-24T16:15:00Z'), or null when s is not a date-time. */
function toInstant(s: unknown): Instant | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Ranking titles: Discover first, then core, then spam (the order the seed was generated with). */
export function kindFor(service: string, title: string): GoogleEventKind {
  if (service.toLowerCase() !== 'ranking') return 'outage';
  const t = title.toLowerCase();
  if (t.includes('discover')) return 'discover';
  if (t.includes('core update')) return 'core';
  if (t.includes('spam')) return 'spam';
  return 'other_ranking';
}

// ---------- the bundled seed ----------

const SeedEventSchema = z
  .object({
    id: z.string().min(1),
    service: z.string().min(1),
    kind: z.enum(['core', 'spam', 'discover', 'other_ranking', 'outage', 'data_anomaly']),
    title: z.string().min(1),
    begin: z.string(),
    end: z.string().nullable().optional(),
    endEstimated: z.boolean().optional(),
    url: z.string().nullable().optional(),
    modified: z.string().nullable().optional(),
  })
  .passthrough();

const SeedSchema = z.object({ events: z.array(SeedEventSchema), curated: z.array(SeedEventSchema).default([]) }).passthrough();

function fromSeed(e: z.infer<typeof SeedEventSchema>, source: 'seed' | 'curated'): GoogleEvent {
  const begin = toInstant(e.begin);
  if (!begin) throw new StError('internal', `The bundled Google update list has a bad begin date for ${e.id}.`);
  const end = e.end ? toInstant(e.end) : null;
  return {
    id: e.id,
    source,
    service: e.service,
    kind: source === 'curated' ? 'data_anomaly' : e.kind,
    title: e.title,
    begin,
    end,
    endEstimated: e.endEstimated ?? end === null,
    url: typeof e.url === 'string' && e.url !== '' ? e.url : null,
    modified: e.modified ? toInstant(e.modified) : null,
  };
}

let seedCache: GoogleEvent[] | null = null;

/** The bundled seed (source 'seed') plus curated anomalies (source 'curated', kind 'data_anomaly'), sorted by begin. */
export function loadSeedEvents(): GoogleEvent[] {
  if (!seedCache) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(SEED_URL, 'utf8'));
    } catch {
      throw new StError('internal', 'The bundled list of Google updates (assets/google-updates-seed.json) is missing or unreadable. Reinstall searchtrace.');
    }
    const parsed = SeedSchema.safeParse(raw);
    if (!parsed.success) throw new StError('internal', 'The bundled list of Google updates is not in the expected format. Reinstall searchtrace.');
    seedCache = sortEvents([...parsed.data.events.map((e) => fromSeed(e, 'seed')), ...parsed.data.curated.map((e) => fromSeed(e, 'curated'))]);
  }
  return seedCache.map((e) => ({ ...e }));
}

// ---------- the live feed ----------

/** One incidents.json entry as a GoogleEvent, or null when it lacks an id, a title or a begin time. */
export function classifyIncident(raw: unknown): GoogleEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : null;
  const title = typeof r.external_desc === 'string' ? r.external_desc.trim() : '';
  const service = typeof r.service_name === 'string' && r.service_name.trim() !== '' ? r.service_name.trim() : null;
  const begin = toInstant(r.begin);
  if (!id || !title || !service || !begin) return null;
  const end = r.end === undefined || r.end === null || r.end === '' ? null : toInstant(r.end);
  const uri = typeof r.uri === 'string' && /^incidents\/[A-Za-z0-9_-]+$/.test(r.uri) ? r.uri : `incidents/${id}`;
  return {
    id,
    source: 'incidents',
    service,
    kind: kindFor(service, title),
    title: title.slice(0, 300),
    begin,
    end,
    endEstimated: end === null,
    url: `${STATUS_ORIGIN}${uri}`,
    modified: toInstant(r.modified),
  };
}

/** Events with kind 'data_anomaly': changes in how Google counts, not changes in traffic. */
export function measurementEvents(events: GoogleEvent[]): GoogleEvent[] {
  return events.filter((e) => e.kind === 'data_anomaly');
}

function sortEvents(events: GoogleEvent[]): GoogleEvent[] {
  return events.sort((a, b) => cmp(a.begin, b.begin) || cmp(a.id, b.id));
}

/**
 * Latest version per id: a later `modified` wins (null counts as oldest); on a tie the later
 * list wins, so pass lists oldest source first (stored, seed, live).
 */
export function mergeEvents(...lists: GoogleEvent[][]): GoogleEvent[] {
  const byId = new Map<string, GoogleEvent>();
  for (const list of lists) {
    for (const e of list) {
      const prev = byId.get(e.id);
      if (!prev || (e.modified ?? '') >= (prev.modified ?? '')) byId.set(e.id, e);
    }
  }
  return sortEvents([...byId.values()]);
}

const pairKey = (e: Pick<GoogleEvent, 'id' | 'modified'>): string => `${e.id}|${e.modified ?? ''}`;

async function readStored(ctx: RunContext): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  for (const f of await ctx.store.list('google/')) {
    if (!f.path.endsWith('.ndjson.gz')) continue;
    const { rows } = await ctx.store.readPartition<GoogleEvent>(f.path);
    for (const r of rows) if (r && typeof r.id === 'string' && typeof r.begin === 'string') out.push(r);
  }
  return out;
}

async function plan(ctx: RunContext): Promise<CollectorPlan<UpdatesPlan>> {
  const offline = ctx.flags.offline;
  return {
    lines: [{ group: 'free', label: 'Google update feed', detail: offline ? 'offline, using the bundled list' : '1 request' }],
    estRequests: offline ? 0 : 1,
    estUsd: 0,
    payload: { url: INCIDENTS_URL },
    // Never skipped: offline runs still need the bundled list stored so analysis can see it.
    skip: null,
  };
}

async function execute(p: CollectorPlan<UpdatesPlan>, ctx: RunContext): Promise<PhaseResult> {
  const startedAt = new Date(ctx.clock.now().getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result: PhaseResult = {
    name: 'updates', status: 'ok', startedAt, endedAt: startedAt, requests: {}, rows: 0, costUsd: 0, partitions: [], notes: [], errors: [],
  };

  let live: GoogleEvent[] = [];
  if (ctx.flags.offline) {
    result.status = 'skipped';
    result.notes.push('Offline: used the bundled list of Google updates.');
  } else {
    result.requests['google.incidents'] = 1;
    try {
      const res = await requestJson<unknown>(ctx.fetch, {
        url: p.payload.url,
        method: 'GET',
        timeoutMs: updatesTuning.timeoutMs,
        retry: { attempts: updatesTuning.attempts, baseMs: updatesTuning.retryBaseMs, capMs: updatesTuning.retryCapMs, on: [429, 500, 502, 503, 504] },
        maxBytes: 2_000_000,
        signal: ctx.signal,
      });
      if (res.status < 200 || res.status >= 300 || !Array.isArray(res.data)) {
        throw new StError('http', `Google's update feed answered HTTP ${res.status}${Array.isArray(res.data) ? '' : ' without a list'}.`);
      }
      live = res.data.map(classifyIncident).filter((e): e is GoogleEvent => e !== null);
    } catch (e) {
      result.status = 'partial';
      result.errors.push({ code: e instanceof StError ? e.code : 'network', message: ctx.secrets.redact(e instanceof Error ? e.message : String(e)).slice(0, 500) });
      result.notes.push("Couldn't reach Google's update feed, so the bundled list and stored updates were used.");
    }
  }

  const stored = await readStored(ctx);
  const merged = mergeEvents(stored, loadSeedEvents(), live);
  const have = new Set(stored.map(pairKey));
  const fresh = merged.filter((e) => !have.has(pairKey(e)));
  if (fresh.length > 0) {
    const fetchedAt = new Date(ctx.clock.now().getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const w = await ctx.store.writePartition(
      layout.perRun('google', ctx.runId, ctx.startedAt),
      { kind: 'google_events', schema: 1, property: ctx.config.property, toolVersion: ctx.toolVersion, runId: ctx.runId, fetchedAt },
      fresh,
    );
    result.partitions.push(w.path);
    result.rows = w.rows;
  }
  result.notes.unshift(`${merged.length} known, ${fresh.length} new`);
  result.endedAt = new Date(ctx.clock.now().getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return result;
}

export const updatesCollector: Collector<UpdatesPlan> = { name: 'updates', plan, execute };
