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
// intent and unknown are unresolved: their worst-case cost stays reserved and they are never
// re-posted. Reconcile turns them into posted (found by tag) or abandoned (not found after
// 15 minutes). failed and abandoned intents are eligible again.
import { b32, sha256Hex } from '../../core/ids.js';
import { toInstant, utcMonth } from '../../core/time.js';
import type { Device, Instant, Limiter, RunContext, SampleDesignKind, SpendEvent } from '../../core/types.js';
import { type DfsClient, PATHS, dfsDatetime, dfsLimiters, parseDfsDatetime } from './client.js';

export type DesignEvent = Extract<SpendEvent, { type: 'design' }>;
export type IntentStatus = 'intent' | 'unknown' | 'posted' | 'collected' | 'failed' | 'abandoned';

export const ABANDON_AFTER_MS = 15 * 60_000;
export const RECONCILE_DAYS = 8;
export const ID_LIST_MAX_DAYS = 30;
const ID_LIST_LIMIT = 1000;
const ID_LIST_MAX_PAGES = 50;

export interface IntentState {
  intentKey: string;
  tag: string;
  status: IntentStatus;
  /** When the first intent record for this key was written (null when only outcomes exist). */
  intentAt: Instant | null;
  estUsd: number;
  taskIds: string[];
}

export interface PostedTask {
  taskId: string;
  intentKey: string;
  tag: string;
  costUsd: number;
  at: Instant;
  collected: boolean;
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
      s = { intentKey: key, tag: tag ?? '', status: 'intent', intentAt: null, estUsd: 0, taskIds: [] };
      intents.set(key, s);
    }
    if (tag && !s.tag) s.tag = tag;
    return s;
  };
  for (const e of events) {
    switch (e.type) {
      case 'design':
        if (!designs.has(e.isoWeek)) designs.set(e.isoWeek, e);
        break;
      case 'intent': {
        const s = intentOf(e.intentKey, e.tag);
        s.status = 'intent';
        if (s.intentAt === null) s.intentAt = e.at;
        s.estUsd = isNum(e.estUsd) ? e.estUsd : s.estUsd;
        break;
      }
      case 'posted': {
        const s = intentOf(e.intentKey, e.tag);
        if (s.status !== 'collected' || !s.taskIds.includes(e.taskId)) s.status = 'posted';
        if (!s.taskIds.includes(e.taskId)) s.taskIds.push(e.taskId);
        if (!tasks.has(e.taskId)) {
          tasks.set(e.taskId, { taskId: e.taskId, intentKey: e.intentKey, tag: e.tag ?? s.tag, costUsd: isNum(e.costUsd) ? e.costUsd : 0, at: e.at, collected: false });
        }
        break;
      }
      case 'collected': {
        const s = intentOf(e.intentKey, undefined);
        const t = tasks.get(e.taskId);
        if (t) t.collected = true;
        if (s.taskIds.every((id) => tasks.get(id)?.collected ?? id === e.taskId)) s.status = 'collected';
        break;
      }
      case 'failed':
      case 'unknown':
      case 'abandoned': {
        const s = intentOf(e.intentKey, e.tag);
        // An outcome never overrides a known task: once posted, the money is spent.
        if (s.status === 'posted' || s.status === 'collected') break;
        s.status = e.type;
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

/** UTC-month spend: ours in id_list (by task id) united with ledger posts not seen remotely. */
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
  return total;
}

/** Ledger events that resolve unresolved intents and adopt our remote tasks the ledger doesn't know. */
export function resolveAgainstRemote(state: SpendState, remote: RemoteTask[], now: Date, property: string): SpendEvent[] {
  const at = toInstant(now);
  const prefix = ourTagPrefix(property);
  const out: SpendEvent[] = [];
  const byTag = new Map<string, RemoteTask[]>();
  for (const t of remote) {
    if (!t.tag.startsWith(prefix)) continue;
    const list = byTag.get(t.tag) ?? [];
    list.push(t);
    byTag.set(t.tag, list);
  }
  const keys = [...state.intents.keys()].sort();
  for (const key of keys) {
    const s = state.intents.get(key) as IntentState;
    const tag = s.tag || `${prefix}${key}`;
    const found = (byTag.get(tag) ?? []).filter((t) => !state.tasks.has(t.id));
    for (const t of found) {
      out.push({ type: 'posted', at, runId: '', intentKey: key, tag, taskId: t.id, costUsd: t.costUsd });
    }
    if (found.length === 0 && isUnresolved(s)) {
      const age = s.intentAt === null ? Infinity : now.getTime() - Date.parse(s.intentAt);
      if (age >= ABANDON_AFTER_MS) {
        out.push({ type: 'abandoned', at, runId: '', intentKey: key, tag, reason: 'not found at DataForSEO 15 minutes after the request' });
      }
    }
  }
  return out;
}

/** The id_list window: 8 days, stretched back to cover the oldest unresolved intent (at most 30 days). */
export function reconcileWindow(state: SpendState, now: Date): { from: Date; to: Date } {
  let from = now.getTime() - RECONCILE_DAYS * 86_400_000;
  for (const s of state.intents.values()) {
    if (isUnresolved(s) && s.intentAt) from = Math.min(from, Date.parse(s.intentAt) - 3_600_000);
  }
  from = Math.max(from, now.getTime() - ID_LIST_MAX_DAYS * 86_400_000);
  return { from: new Date(from), to: now };
}

function remoteFrom(item: unknown, prefix: string): RemoteTask | null {
  if (!item || typeof item !== 'object') return null;
  const x = item as Record<string, unknown>;
  const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {};
  const tag = isStr(meta.tag) ? meta.tag : isStr(x.tag) ? x.tag : null;
  if (!tag || !tag.startsWith(prefix) || !isStr(x.id)) return null;
  return { id: x.id, tag, costUsd: isNum(x.cost) ? x.cost : 0, postedAt: parseDfsDatetime(x.datetime_posted) };
}

/** Our tasks from id_list over [from, to], paginated at the documented 10 calls per minute. */
export async function fetchOurTasks(
  client: DfsClient,
  property: string,
  from: Date,
  to: Date,
  limiter: Limiter = dfsLimiters().idList,
): Promise<{ tasks: RemoteTask[]; requests: number }> {
  const prefix = ourTagPrefix(property);
  const tasks = new Map<string, RemoteTask>();
  let requests = 0;
  for (let page = 0; page < ID_LIST_MAX_PAGES; page++) {
    const body = [{
      datetime_from: dfsDatetime(from), datetime_to: dfsDatetime(to), limit: ID_LIST_LIMIT, offset: page * ID_LIST_LIMIT,
      sort: 'asc', include_metadata: true,
    }];
    const env = await limiter.run(() => client.post(PATHS.idList, body, { idempotent: true }));
    requests++;
    const result = env.tasks?.[0]?.result ?? [];
    for (const item of result) {
      const t = remoteFrom(item, prefix);
      if (t && !tasks.has(t.id)) tasks.set(t.id, t);
    }
    if (result.length < ID_LIST_LIMIT) break;
  }
  return { tasks: [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), requests };
}

// ---------- per-run cache, so the poster reuses the collector's id_list answer ----------
// Keyed by the store object and the run id, so two data folders (or two test worlds) never share an answer.

const cache = new WeakMap<object, Map<string, RemoteTask[]>>();

function cacheKey(ctx: RunContext): string {
  return `${ctx.runId}|${ctx.config.property}`;
}

export function cachedRemote(ctx: RunContext): RemoteTask[] | null {
  return cache.get(ctx.store)?.get(cacheKey(ctx)) ?? null;
}

export function rememberRemote(ctx: RunContext, remote: RemoteTask[]): void {
  let m = cache.get(ctx.store);
  if (!m) {
    m = new Map();
    cache.set(ctx.store, m);
  }
  m.set(cacheKey(ctx), remote);
  while (m.size > 4) m.delete(m.keys().next().value as string);
}

export interface ReconcileResult {
  remote: RemoteTask[];
  appended: SpendEvent[];
  requests: number;
  state: SpendState;
}

/** Reads the spend ledger, asks id_list, appends posted/abandoned resolutions, and caches the answer for this run. */
export async function reconcile(ctx: RunContext, client: DfsClient, o: { useCache?: boolean; limiter?: Limiter } = {}): Promise<ReconcileResult> {
  const now = ctx.clock.now();
  let state = spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
  let remote = o.useCache ? cachedRemote(ctx) : null;
  let requests = 0;
  if (!remote) {
    const win = reconcileWindow(state, now);
    const got = await fetchOurTasks(client, ctx.config.property, win.from, win.to, o.limiter);
    remote = got.tasks;
    requests = got.requests;
    rememberRemote(ctx, remote);
  }
  const appended = resolveAgainstRemote(state, remote, now, ctx.config.property).map((e) => ({ ...e, runId: ctx.runId }));
  for (const e of appended) await ctx.store.append('spend', e);
  if (appended.length) state = spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
  return { remote, appended, requests, state };
}

/** Design and pi of an intent, looked up in the design records. */
export function designOf(state: SpendState, intentKey: string): { isoWeek: string; pi: number; design: SampleDesignKind; keyword: string; device: Device } | null {
  for (const d of state.designs.values()) {
    const u = d.units.find((x) => x.intentKey === intentKey);
    if (u) return { isoWeek: d.isoWeek, pi: u.pi, design: u.design, keyword: u.keyword, device: u.device };
  }
  return null;
}
