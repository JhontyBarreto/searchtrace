// id_list reconcile by tag, unknown and abandoned resolution (4.5 step 1). Owner: WP-D.
//
// The spend ledger is the local truth; id_list (free) is DataForSEO's. The account is shared
// with other tools, so only tasks whose tag starts with 'st1:<propHash8>:' are ours.
//
// Intent states, from the latest ledger record per intentKey:
//   intent    the POST may or may not have happened (a crash between intent and outcome)
//   unknown   the POST was sent but the answer was lost (timeout, 5xx, reset)
//   posted    a task id is known            collected   its result is stored
//   failed    nothing was created           abandoned   unresolved, not found remotely after 15 minutes
//   unavailable  DataForSEO answered the task with a final error; never fetched again
// intent and unknown are unresolved: their worst-case cost stays reserved and they are never
// re-posted. failed and abandoned intents are eligible again.
//
// Every run reads id_list twice over:
//   - a sweep of the last 8 days, newest first and capped at SWEEP_MAX_PAGES, which adopts every
//     task of ours the ledger doesn't know (another data folder, a lost CI save, an old clone) and
//     feeds the cross-folder month spend. A capped sweep says so instead of passing as complete.
//   - a narrow lookup, made fresh, around each group of unresolved intents that are 15 minutes or
//     more old. An intent is abandoned only when that lookup came back complete without it, so a
//     stale cached answer or a busy shared account can never cause a second payment.
// An unresolved intent whose ISO week has ended can never be due again; if it still can't be
// settled it is abandoned as "unconfirmed" and its worst-case cost counts as spent in its month.
import { b32, sha256Hex } from '../../core/ids.js';
import { isoWeek, ptDate, toInstant, utcMonth } from '../../core/time.js';
import type { Device, Instant, Limiter, RunContext, SampleDesignKind, SpendEvent } from '../../core/types.js';
import { type DfsClient, PATHS, dfsDatetime, dfsLimiters, parseDfsDatetime } from './client.js';

export type DesignEvent = Extract<SpendEvent, { type: 'design' }>;
export type IntentStatus = 'intent' | 'unknown' | 'posted' | 'collected' | 'failed' | 'abandoned' | 'unavailable';

export const ABANDON_AFTER_MS = 15 * 60_000;
export const RECONCILE_DAYS = 8;
export const ID_LIST_MAX_DAYS = 30;
const ID_LIST_LIMIT = 1000;
/** The 8-day sweep reads at most this many pages (about a minute at id_list's 10 calls a minute). */
export const SWEEP_MAX_PAGES = 10;
/** A narrow lookup around a group of unresolved intents reads at most this many pages. */
export const GROUP_MAX_PAGES = 5;
/** Intents written within this gap of each other are looked up together. */
const GROUP_GAP_MS = 10 * 60_000;
/** How far either side of a group the lookup reaches. */
const GROUP_MARGIN_MS = 3_600_000;

export interface IntentState {
  intentKey: string;
  tag: string;
  status: IntentStatus;
  /** When the latest intent record for this key was written: each POST attempt gets its own grace period. */
  intentAt: Instant | null;
  estUsd: number;
  taskIds: string[];
  /** Abandoned without proof either way after its week ended: estUsd counts as spent in intentAt's month. */
  unconfirmed: boolean;
}

export interface PostedTask {
  taskId: string;
  intentKey: string;
  tag: string;
  costUsd: number;
  /** When DataForSEO created the task (postedAt for an adopted task, else when the outcome was recorded). */
  at: Instant;
  collected: boolean;
  /** DataForSEO answered it with a final error: done, never fetched again. */
  unavailable: boolean;
  /** The run whose ledger line recorded it. */
  runId: string;
}

export interface SpendState {
  designs: Map<string, DesignEvent>;
  intents: Map<string, IntentState>;
  tasks: Map<string, PostedTask>;
}

export interface RemoteTask {
  id: string;
  tag: string;
  costUsd: number;
  postedAt: Instant | null;
}

/** One id_list read: our tasks, when it was read, and whether every page was read. */
export interface RemoteSnapshot {
  tasks: RemoteTask[];
  fetchedAt: Instant;
  complete: boolean;
}

/** 'st1:' + b32(sha256(property)).slice(0, 8) + ':' */
export function ourTagPrefix(property: string): string {
  return `st1:${b32(sha256Hex(property)).slice(0, 8)}:`;
}

export function tagFor(property: string, intentKey: string): string {
  return `${ourTagPrefix(property)}${intentKey}`;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keeps only well-formed spend records (the ledger is a file on disk and may have been edited). */
export function cleanSpendEvents(raw: unknown[]): SpendEvent[] {
  const out: SpendEvent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (!isStr(e.at) || !isStr(e.type)) continue;
    switch (e.type) {
      case 'design':
        if (isStr(e.isoWeek) && Array.isArray(e.units)) out.push(e as unknown as SpendEvent);
        break;
      case 'intent':
        if (isStr(e.intentKey) && isStr(e.tag)) out.push(e as unknown as SpendEvent);
        break;
      case 'posted':
        if (isStr(e.intentKey) && isStr(e.taskId)) out.push(e as unknown as SpendEvent);
        break;
      case 'failed':
      case 'unknown':
      case 'abandoned':
        if (isStr(e.intentKey)) out.push(e as unknown as SpendEvent);
        break;
      case 'collected':
      case 'unavailable':
        if (isStr(e.intentKey) && isStr(e.taskId)) out.push(e as unknown as SpendEvent);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Replays the ledger, in order, into designs, intent states and posted tasks. */
export function spendState(events: SpendEvent[]): SpendState {
  const designs = new Map<string, DesignEvent>();
  const intents = new Map<string, IntentState>();
  const tasks = new Map<string, PostedTask>();
  const intentOf = (key: string, tag: string | undefined): IntentState => {
    let s = intents.get(key);
    if (!s) {
      s = { intentKey: key, tag: tag ?? '', status: 'intent', intentAt: null, estUsd: 0, taskIds: [], unconfirmed: false };
      intents.set(key, s);
    }
    if (tag && !s.tag) s.tag = tag;
    return s;
  };
  const done = (id: string): boolean => {
    const t = tasks.get(id);
    return !!t && (t.collected || t.unavailable);
  };
  for (const e of events) {
    switch (e.type) {
      case 'design':
        if (!designs.has(e.isoWeek)) designs.set(e.isoWeek, e);
        break;
      case 'intent': {
        const s = intentOf(e.intentKey, e.tag);
        s.status = 'intent';
        s.unconfirmed = false;
        s.intentAt = e.at;
        s.estUsd = isNum(e.estUsd) ? e.estUsd : s.estUsd;
        break;
      }
      case 'posted': {
        const s = intentOf(e.intentKey, e.tag);
        if ((s.status !== 'collected' && s.status !== 'unavailable') || !s.taskIds.includes(e.taskId)) s.status = 'posted';
        s.unconfirmed = false;
        if (!s.taskIds.includes(e.taskId)) s.taskIds.push(e.taskId);
        if (!tasks.has(e.taskId)) {
          const at = isStr(e.postedAt) ? e.postedAt : e.at;
          tasks.set(e.taskId, {
            taskId: e.taskId, intentKey: e.intentKey, tag: e.tag ?? s.tag, costUsd: isNum(e.costUsd) ? e.costUsd : 0, at, collected: false,
            unavailable: false, runId: typeof e.runId === 'string' ? e.runId : '',
          });
        }
        break;
      }
      case 'collected':
      case 'unavailable': {
        const s = intentOf(e.intentKey, undefined);
        const t = tasks.get(e.taskId);
        if (t) {
          if (e.type === 'collected') t.collected = true;
          else t.unavailable = true;
        }
        if (s.taskIds.length && s.taskIds.every(done)) {
          s.status = s.taskIds.some((id) => tasks.get(id)?.collected) ? 'collected' : 'unavailable';
        }
        break;
      }
      case 'failed':
      case 'unknown':
      case 'abandoned': {
        const s = intentOf(e.intentKey, e.tag);
        // An outcome never overrides a known task: once posted, the money is spent.
        if (s.status === 'posted' || s.status === 'collected' || s.status === 'unavailable') break;
        s.status = e.type;
        s.unconfirmed = e.type === 'abandoned' && e.unconfirmed === true;
        if (e.type === 'unknown' && s.intentAt === null) s.intentAt = e.at; // ledger without its intent line
        break;
      }
      default:
        break;
    }
  }
  return { designs, intents, tasks };
}

export function isUnresolved(s: IntentState | undefined): boolean {
  return !!s && (s.status === 'intent' || s.status === 'unknown');
}

/** No record, failed or abandoned: the intent may be posted (again). */
export function isEligible(s: IntentState | undefined): boolean {
  return !s || s.status === 'failed' || s.status === 'abandoned';
}

export function pendingUnknownCount(state: SpendState): number {
  let n = 0;
  for (const s of state.intents.values()) if (isUnresolved(s)) n++;
  return n;
}

/**
 * UTC-month spend: our tasks in id_list (by task id) united with the ledger's own posts (task_post
 * returns the real cost of each), plus the worst case of every unconfirmed intent of the month.
 */
export function monthSpendUsd(state: SpendState, remote: RemoteTask[], now: Date): number {
  const month = utcMonth(now);
  const seen = new Set<string>();
  let total = 0;
  for (const t of remote) {
    seen.add(t.id);
    if (t.postedAt && utcMonth(t.postedAt) === month) total += Math.max(0, t.costUsd);
  }
  for (const t of state.tasks.values()) {
    if (seen.has(t.taskId)) continue;
    if (utcMonth(t.at) === month) total += Math.max(0, t.costUsd);
  }
  for (const s of state.intents.values()) {
    if (s.status === 'abandoned' && s.unconfirmed && s.intentAt && utcMonth(s.intentAt) === month) total += Math.max(0, s.estUsd);
  }
  return total;
}

/**
 * 'posted' events for every remote task of ours the ledger doesn't know: extra tasks of known
 * intents, and tasks whose intent this ledger never saw (posted from another data folder, or a
 * run whose save was lost). Their postedAt keeps the real posting time for week and month sums.
 */
export function adoptRemote(state: SpendState, remote: RemoteTask[], now: Date, property: string, known: Set<string> = new Set()): SpendEvent[] {
  const at = toInstant(now);
  const prefix = ourTagPrefix(property);
  const out: SpendEvent[] = [];
  const sorted = [...remote].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of sorted) {
    if (!t.tag.startsWith(prefix) || state.tasks.has(t.id) || known.has(t.id)) continue;
    const key = state.intents.get(t.tag.slice(prefix.length))?.intentKey ?? t.tag.slice(prefix.length);
    if (!key) continue;
    known.add(t.id);
    out.push({ type: 'posted', at, runId: '', intentKey: key, tag: t.tag, taskId: t.id, costUsd: t.costUsd, ...(t.postedAt ? { postedAt: t.postedAt } : {}) });
  }
  return out;
}

/**
 * Ledger events that resolve unresolved intents against one id_list read: adopt what it holds,
 * and abandon an intent it lacks only when the read was complete and the intent was already 15
 * minutes old when it was read (asOf, not now: a cached read predates the run's analysis).
 */
export function resolveAgainstRemote(
  state: SpendState, remote: RemoteTask[], now: Date, property: string, o: { asOf?: Date; complete?: boolean } = {},
): SpendEvent[] {
  const at = toInstant(now);
  const prefix = ourTagPrefix(property);
  const out = adoptRemote(state, remote, now, property);
  const asOf = (o.asOf ?? now).getTime();
  const tags = new Set(remote.map((t) => t.tag));
  if (o.complete === false) return out;
  for (const key of [...state.intents.keys()].sort()) {
    const s = state.intents.get(key) as IntentState;
    if (!isUnresolved(s)) continue;
    const tag = s.tag || `${prefix}${key}`;
    if (tags.has(tag)) continue;
    const age = s.intentAt === null ? Infinity : asOf - Date.parse(s.intentAt);
    if (age >= ABANDON_AFTER_MS) {
      out.push({ type: 'abandoned', at, runId: '', intentKey: key, tag, reason: 'not found at DataForSEO 15 minutes after the request' });
    }
  }
  return out;
}

/** The sweep window: the last 8 days. Older unresolved intents get their own narrow lookups. */
export function reconcileWindow(_state: SpendState, now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - RECONCILE_DAYS * 86_400_000), to: now };
}

function remoteFrom(item: unknown, prefix: string): RemoteTask | null {
  if (!item || typeof item !== 'object') return null;
  const x = item as Record<string, unknown>;
  const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {};
  const tag = isStr(meta.tag) ? meta.tag : isStr(x.tag) ? x.tag : null;
  if (!tag || !tag.startsWith(prefix) || !isStr(x.id)) return null;
  return { id: x.id, tag, costUsd: isNum(x.cost) ? x.cost : 0, postedAt: parseDfsDatetime(x.datetime_posted) };
}

/**
 * Our tasks from id_list over [from, to], newest first, paginated at the documented 10 calls per
 * minute. complete is true only when a short page ended the scan; hitting maxPages (a busy
 * shared account) is reported, never mistaken for "not there".
 */
export async function fetchOurTasks(
  client: DfsClient,
  property: string,
  from: Date,
  to: Date,
  o: { maxPages?: number; limiter?: Limiter } = {},
): Promise<{ tasks: RemoteTask[]; requests: number; complete: boolean }> {
  const prefix = ourTagPrefix(property);
  const tasks = new Map<string, RemoteTask>();
  const limiter = o.limiter ?? dfsLimiters().idList;
  const maxPages = o.maxPages ?? SWEEP_MAX_PAGES;
  let requests = 0;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const body = [{
      datetime_from: dfsDatetime(from), datetime_to: dfsDatetime(to), limit: ID_LIST_LIMIT, offset: page * ID_LIST_LIMIT,
      sort: 'desc', include_metadata: true,
    }];
    const env = await limiter.run(() => client.post(PATHS.idList, body, { idempotent: true }));
    requests++;
    const result = env.tasks?.[0]?.result ?? [];
    for (const item of result) {
      const t = remoteFrom(item, prefix);
      if (t && !tasks.has(t.id)) tasks.set(t.id, t);
    }
    if (result.length < ID_LIST_LIMIT) {
      complete = true;
      break;
    }
  }
  return { tasks: [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), requests, complete };
}

/** The ISO week an intent belongs to: from its design, else from when it was written. */
function intentWeek(state: SpendState, s: IntentState): string | null {
  for (const d of state.designs.values()) if (d.units.some((u) => u.intentKey === s.intentKey)) return d.isoWeek;
  return s.intentAt ? isoWeek(ptDate(s.intentAt)) : null;
}

/** Unresolved intents old enough to settle, grouped by when they were written (a batch is written in seconds). */
function dueGroups(state: SpendState, now: Date, skip: Set<string>): IntentState[][] {
  const due = [...state.intents.values()]
    .filter((s) => isUnresolved(s) && !skip.has(s.intentKey) && s.intentAt !== null && now.getTime() - Date.parse(s.intentAt) >= ABANDON_AFTER_MS)
    .sort((a, b) => Date.parse(a.intentAt as string) - Date.parse(b.intentAt as string) || (a.intentKey < b.intentKey ? -1 : 1));
  const groups: IntentState[][] = [];
  for (const s of due) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && Date.parse(s.intentAt as string) - Date.parse(prev.intentAt as string) <= GROUP_GAP_MS) last.push(s);
    else groups.push([s]);
  }
  return groups;
}

export interface Resolution {
  events: SpendEvent[];
  requests: number;
  /** Unresolved intents whose lookup was too long (or failed); they stay reserved. */
  stillReserved: number;
}

/**
 * Settles what can be settled: adopts our tasks from the sweep, then looks up every group of
 * unresolved intents 15 minutes or older with a fresh, narrow id_list read. Writes nothing.
 */
export async function resolveIntents(
  ctx: Pick<RunContext, 'clock' | 'config'>, client: DfsClient, state: SpendState, snapshot: RemoteSnapshot, limiter?: Limiter,
): Promise<Resolution> {
  const now = ctx.clock.now();
  const property = ctx.config.property;
  const prefix = ourTagPrefix(property);
  const at = toInstant(now);
  const known = new Set<string>();
  const events = adoptRemote(state, snapshot.tasks, now, property, known);
  const settled = new Set(events.map((e) => (e as { intentKey: string }).intentKey));
  const week = isoWeek(ptDate(now));
  const expired = (s: IntentState): boolean => {
    const w = intentWeek(state, s);
    return (w !== null && w < week) || (s.intentAt !== null && now.getTime() - Date.parse(s.intentAt) > ID_LIST_MAX_DAYS * 86_400_000);
  };
  let requests = 0;
  let stillReserved = 0;
  // An intent with no intent line (only an 'unknown') has no time to look around: the sweep decides.
  for (const s of state.intents.values()) {
    if (!isUnresolved(s) || s.intentAt !== null || settled.has(s.intentKey)) continue;
    const tag = s.tag || `${prefix}${s.intentKey}`;
    if (snapshot.complete) events.push({ type: 'abandoned', at, runId: '', intentKey: s.intentKey, tag, reason: 'not found at DataForSEO' });
    else stillReserved++;
  }
  for (const group of dueGroups(state, now, settled)) {
    const times = group.map((s) => Date.parse(s.intentAt as string));
    const from = new Date(Math.min(...times) - GROUP_MARGIN_MS);
    const to = new Date(Math.min(Math.max(...times) + GROUP_MARGIN_MS, now.getTime()));
    let got: { tasks: RemoteTask[]; requests: number; complete: boolean } | null = null;
    try {
      got = await fetchOurTasks(client, property, from, to, { maxPages: GROUP_MAX_PAGES, ...(limiter ? { limiter } : {}) });
      requests += got.requests;
    } catch (e) {
      if ((e as { code?: string }).code === 'auth') throw e;
      got = null;
    }
    const adopted = got ? adoptRemote(state, got.tasks, now, property, known) : [];
    events.push(...adopted);
    const tags = new Set((got?.tasks ?? []).map((t) => t.tag));
    for (const s of group) {
      const tag = s.tag || `${prefix}${s.intentKey}`;
      if (tags.has(tag)) continue;
      if (got?.complete) {
        events.push({ type: 'abandoned', at, runId: '', intentKey: s.intentKey, tag, reason: 'not found at DataForSEO 15 minutes after the request' });
      } else if (expired(s)) {
        events.push({
          type: 'abandoned', at, runId: '', intentKey: s.intentKey, tag, unconfirmed: true,
          reason: 'unconfirmed: DataForSEO could not be checked before its week ended; its cost counts as spent',
        });
      } else stillReserved++;
    }
  }
  return { events, requests, stillReserved };
}

// ---------- per-run cache, so the poster reuses the collector's id_list sweep ----------
// Keyed by the store object and the run id, so two data folders (or two test worlds) never share an answer.

const cache = new WeakMap<object, Map<string, RemoteSnapshot>>();

function cacheKey(ctx: RunContext): string {
  return `${ctx.runId}|${ctx.config.property}`;
}

export function cachedRemote(ctx: RunContext): RemoteSnapshot | null {
  return cache.get(ctx.store)?.get(cacheKey(ctx)) ?? null;
}

export function rememberRemote(ctx: RunContext, snapshot: RemoteSnapshot): void {
  let m = cache.get(ctx.store);
  if (!m) {
    m = new Map();
    cache.set(ctx.store, m);
  }
  m.set(cacheKey(ctx), snapshot);
  while (m.size > 4) m.delete(m.keys().next().value as string);
}

/** The 8-day sweep, from this run's cache or a fresh read. */
export async function sweep(ctx: RunContext, client: DfsClient, o: { useCache?: boolean; limiter?: Limiter } = {}): Promise<{ snapshot: RemoteSnapshot; requests: number }> {
  const cached = o.useCache ? cachedRemote(ctx) : null;
  if (cached) return { snapshot: cached, requests: 0 };
  const now = ctx.clock.now();
  const win = reconcileWindow(spendState([]), now);
  const got = await fetchOurTasks(client, ctx.config.property, win.from, win.to, { maxPages: SWEEP_MAX_PAGES, ...(o.limiter ? { limiter: o.limiter } : {}) });
  const snapshot: RemoteSnapshot = { tasks: got.tasks, fetchedAt: toInstant(now), complete: got.complete };
  rememberRemote(ctx, snapshot);
  return { snapshot, requests: got.requests };
}

export interface ReconcileResult {
  remote: RemoteTask[];
  /** False when the sweep hit its page cap: other folders' spend may be missing from the month total. */
  complete: boolean;
  appended: SpendEvent[];
  requests: number;
  state: SpendState;
  stillReserved: number;
}

/** Reads the spend ledger, sweeps id_list, settles what it can (appending posted/abandoned), and caches the sweep for this run. */
export async function reconcile(ctx: RunContext, client: DfsClient, o: { useCache?: boolean; limiter?: Limiter } = {}): Promise<ReconcileResult> {
  let state = spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
  const sw = await sweep(ctx, client, o);
  const r = await resolveIntents(ctx, client, state, sw.snapshot, o.limiter);
  const appended = r.events.map((e) => ({ ...e, runId: ctx.runId }));
  for (const e of appended) await ctx.store.append('spend', e);
  if (appended.length) state = spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
  return { remote: sw.snapshot.tasks, complete: sw.snapshot.complete, appended, requests: sw.requests + r.requests, state, stillReserved: r.stillReserved };
}

/** Design and pi of an intent, looked up in the design records. */
export function designOf(state: SpendState, intentKey: string): { isoWeek: string; pi: number; design: SampleDesignKind; keyword: string; device: Device } | null {
  for (const d of state.designs.values()) {
    const u = d.units.find((x) => x.intentKey === intentKey);
    if (u) return { isoWeek: d.isoWeek, pi: u.pi, design: u.design, keyword: u.keyword, device: u.device };
  }
  return null;
}
