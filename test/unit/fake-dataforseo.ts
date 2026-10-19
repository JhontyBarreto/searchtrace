// A fake DataForSEO account for WP-D tests: task_post, tasks_ready, task_get/advanced, id_list
// and user_data, on top of fakeFetch. It is shared with "other tools" (foreign tasks in id_list),
// charges a per-task cost, and can misbehave on task_post to exercise the at-most-once protocol.
// Nothing here talks to the network or spends money.
import { createLogger } from '../../src/core/log.js';
import { ConfigSchema } from '../../src/core/config.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { Clock, Config, DataStore, Fetch, IndexDb, IndexReader, RunContext, RunFlags } from '../../src/core/types.js';
import { fakeFetch, type FakeFetch, type FakeReply, type FakeRequest } from '../helpers/index.js';

const BASE = 'https://api.dataforseo.com';

export interface FakeTask {
  id: string;
  tag: string;
  keyword: string;
  device: string;
  location_code: number;
  language_code: string;
  cost: number;
  postedAt: Date;
  collected: boolean;
  foreign: boolean;
}

/** What task_post does with a batch: create the tasks or not, and what the client sees. */
export type PostBehaviour =
  | 'ok'
  | 'reset_after_send'   // tasks created, connection dropped before the answer
  | 'timeout'            // tasks created, no answer in time
  | 'dns'                // never left the machine: nothing created
  | 'http500'            // server error: nothing created, but the client can't know
  | 'auth'               // 401: nothing created
  | 'budget'             // 402: nothing created
  | 'task_errors';       // 200 with every task refused (40501)

export interface FakeDfsOptions {
  clock: Clock;
  balance?: number;
  /** Charged per created task (at most the worst case). */
  cost?: (n: number) => number;
  foreignTasks?: number;
  /** Behaviour for the n-th task_post call (0-based). */
  post?: (n: number) => PostBehaviour;
  /** Builds the SERP for a task; default has an AI Overview on keywords containing 'how'. */
  serp?: (t: FakeTask) => Record<string, unknown>;
  readyAfterMs?: number;
  /** id_list lags: a task shows up only this long after it was created. */
  idListLagMs?: number;
  /** A per-task status code task_get answers with instead of the result (e.g. 40102). */
  taskCode?: (t: FakeTask) => number | undefined;
}

export interface FakeDfs {
  ff: FakeFetch;
  fetch: Fetch;
  tasks: FakeTask[];
  postCalls: number;
  ours(): FakeTask[];
  setBalance(x: number): void;
}

const dfsTime = (d: Date): string => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} +00:00`;
const parseDfs = (s: string): number => Date.parse(s.replace(' +00:00', 'Z').replace(' ', 'T'));

export function defaultSerp(t: FakeTask, siteDomain = 'example.com'): Record<string, unknown> {
  const hasAio = t.keyword.includes('how');
  const items: Record<string, unknown>[] = [];
  if (hasAio) {
    items.push({
      type: 'ai_overview', rank_group: 1, rank_absolute: 1, asynchronous_ai_overview: true,
      items: [{ type: 'ai_overview_element', title: 'x', references: [{ type: 'ai_overview_reference', domain: 'www.semrush.com', url: 'https://www.semrush.com/blog/a', title: 'A', source: 'Semrush' }] }],
      references: [{ type: 'ai_overview_reference', domain: `www.${siteDomain}`, url: `https://www.${siteDomain}/how`, title: 'Ours', source: 'Us' }],
    });
  }
  items.push({ type: 'organic', rank_group: 1, rank_absolute: hasAio ? 2 : 1, domain: 'www.semrush.com', url: 'https://www.semrush.com/x', title: 'Semrush' });
  items.push({ type: 'organic', rank_group: 2, rank_absolute: hasAio ? 3 : 2, domain: siteDomain, url: `https://${siteDomain}/${encodeURIComponent(t.keyword)}`, title: 'Our page' });
  return {
    keyword: t.keyword, type: 'organic', location_code: t.location_code, language_code: t.language_code,
    datetime: dfsTime(new Date(t.postedAt.getTime() + 60_000)), item_types: hasAio ? ['ai_overview', 'organic'] : ['organic'], items,
  };
}

function envelope(tasks: unknown[], status = 20000): Record<string, unknown> {
  return { version: '0.1', status_code: status, status_message: status === 20000 ? 'Ok.' : 'Error.', cost: 0, tasks_count: tasks.length, tasks };
}

export function fakeDataForSeo(o: FakeDfsOptions): FakeDfs {
  const tasks: FakeTask[] = [];
  let balance = o.balance ?? 25;
  let seq = 0;
  let postCalls = 0;
  const mkId = (): string => `10061234-1111-0066-0000-${String(++seq).padStart(12, '0')}`;
  for (let k = 0; k < (o.foreignTasks ?? 3); k++) {
    tasks.push({
      id: mkId(), tag: `othertool:${k}`, keyword: `foreign ${k}`, device: 'desktop', location_code: 2840, language_code: 'en', cost: 0.0006,
      postedAt: new Date(o.clock.now().getTime() - (k + 1) * 3_600_000), collected: false, foreign: true,
    });
  }

  const taskPost = (req: FakeRequest, n: number): FakeReply => {
    postCalls++;
    const behaviour = o.post?.(n) ?? 'ok';
    const body = req.json<Record<string, unknown>[]>();
    if (behaviour === 'dns') return { error: 'dns' };
    if (behaviour === 'auth') return { status: 401, body: envelope([], 40100) };
    if (behaviour === 'budget') return { status: 402, body: envelope([], 40200) };
    if (behaviour === 'http500') return { status: 500, body: 'Internal Server Error' };
    if (behaviour === 'task_errors') {
      return { body: envelope(body.map((b) => ({ id: mkId(), status_code: 40501, status_message: 'Invalid Field', cost: 0, data: b, result: null }))) };
    }
    const now = o.clock.now();
    const created = body.map((b, k) => {
      const t: FakeTask = {
        id: mkId(), tag: String(b.tag), keyword: String(b.keyword), device: String(b.device), location_code: Number(b.location_code),
        language_code: String(b.language_code), cost: o.cost ? o.cost(tasks.length + k) : 0.0006, postedAt: now, collected: false, foreign: false,
      };
      return t;
    });
    tasks.push(...created);
    balance -= created.reduce((s, t) => s + t.cost, 0);
    if (behaviour === 'reset_after_send') return { error: 'reset_after_send' };
    if (behaviour === 'timeout') return { error: 'timeout' };
    return {
      body: {
        ...envelope(created.map((t) => ({ id: t.id, status_code: 20100, status_message: 'Task Created.', cost: t.cost, result_count: 0, data: { api: 'serp', function: 'task_post', se: 'google', keyword: t.keyword, tag: t.tag, device: t.device }, result: null }))),
        cost: created.reduce((s, t) => s + t.cost, 0),
      },
    };
  };

  const idList = (req: FakeRequest): FakeReply => {
    const [q] = req.json<{ datetime_from: string; datetime_to: string; limit: number; offset: number; sort?: string }[]>();
    const from = parseDfs(q.datetime_from);
    const to = parseDfs(q.datetime_to);
    const visibleBy = o.clock.now().getTime() - (o.idListLagMs ?? 0);
    const dir = q.sort === 'desc' ? -1 : 1;
    const inRange = tasks
      .filter((t) => t.postedAt.getTime() >= from && t.postedAt.getTime() <= to && t.postedAt.getTime() <= visibleBy)
      .sort((a, b) => dir * (a.postedAt.getTime() - b.postedAt.getTime()) || dir * (a.id < b.id ? -1 : 1));
    const page = inRange.slice(q.offset, q.offset + q.limit).map((t) => ({
      id: t.id, url: `${BASE}/v3/serp/google/organic/task_get/advanced/${t.id}`, datetime_posted: dfsTime(t.postedAt),
      datetime_done: dfsTime(new Date(t.postedAt.getTime() + 60_000)), status: 'Completed', cost: t.cost,
      metadata: { api: 'serp', function: 'task_post', se: 'google', keyword: t.keyword, location_code: t.location_code, tag: t.tag },
    }));
    return { body: envelope([{ id: 'idl', status_code: 20000, status_message: 'Ok.', cost: 0, result_count: page.length, result: page }]) };
  };

  const ready = (t: FakeTask): boolean => o.clock.now().getTime() - t.postedAt.getTime() >= (o.readyAfterMs ?? 0);

  const tasksReady = (): FakeReply => {
    const list = tasks.filter((t) => !t.collected && ready(t)).map((t) => ({ id: t.id, se: 'google', se_type: 'organic', tag: t.tag }));
    return { body: envelope([{ id: 'tr', status_code: 20000, status_message: 'Ok.', cost: 0, result_count: list.length, result: list }]) };
  };

  const taskGet = (req: FakeRequest): FakeReply => {
    const id = decodeURIComponent(req.url.split('/').pop() ?? '');
    const t = tasks.find((x) => x.id === id);
    if (!t) return { body: envelope([{ id, status_code: 40400, status_message: 'Not Found.', cost: 0, result: null }]) };
    if (!ready(t)) return { body: envelope([{ id, status_code: 40602, status_message: 'Task In Queue.', cost: 0, result: null }]) };
    const forced = o.taskCode?.(t);
    if (forced !== undefined) return { body: envelope([{ id, status_code: forced, status_message: forced === 40102 ? 'No Search Results.' : 'Error.', cost: 0, result: null }]) };
    t.collected = true;
    const result = (o.serp ?? ((x: FakeTask) => defaultSerp(x)))(t);
    return {
      body: envelope([{
        id, status_code: 20000, status_message: 'Ok.', cost: 0, result_count: 1,
        data: { api: 'serp', function: 'task_get', se: 'google', se_type: 'organic', keyword: t.keyword, location_code: t.location_code, language_code: t.language_code, device: t.device, os: t.device === 'desktop' ? 'windows' : 'android', tag: t.tag, load_async_ai_overview: true, depth: 10 },
        result: [result],
      }]),
    };
  };

  const ff = fakeFetch([
    { method: 'POST', url: `${BASE}/v3/serp/google/organic/task_post`, reply: taskPost },
    { method: 'POST', url: `${BASE}/v3/serp/id_list`, reply: idList },
    { method: 'GET', url: `${BASE}/v3/serp/google/organic/tasks_ready`, reply: tasksReady },
    { method: 'GET', url: `${BASE}/v3/serp/google/organic/task_get/advanced/*`, reply: taskGet },
    {
      method: 'GET', url: `${BASE}/v3/appendix/user_data`,
      reply: () => ({ body: envelope([{ id: 'ud', status_code: 20000, status_message: 'Ok.', cost: 0, result: [{ login: 'x', money: { total: 50, balance } }] }]) }),
    },
  ]);
  return {
    ff,
    fetch: ff.fetch,
    tasks,
    get postCalls() {
      return postCalls;
    },
    ours: () => tasks.filter((t) => !t.foreign),
    setBalance: (x: number) => {
      balance = x;
    },
  };
}

export const TEST_PROPERTY = 'sc-domain:example.com';

export function dfsConfig(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    property: TEST_PROPERTY,
    serp: { provider: 'dataforseo', monthlyBudgetUsd: 1, maxPerRunUsd: 0.3, ...over },
  });
}

export const NO_FLAGS: RunFlags = {
  dryRun: false, offline: false, noPaid: false, ci: false, yes: true, interactive: false, budgetUsd: null, waitMinutes: 0,
  credentials: null, forceGraph: false,
};

let runCounter = 0;

/** A RunContext over in-memory pieces. The run id follows the clock, like a real run, with a unique suffix. */
export function makeCtx(o: {
  store: DataStore;
  clock: Clock;
  fetch: Fetch;
  config: Config;
  index: IndexReader;
  env?: Record<string, string | undefined>;
  flags?: Partial<RunFlags>;
  runSuffix?: string;
}): RunContext {
  const secrets = createSecretRegistry({ ci: false });
  const now = o.clock.now().toISOString();
  const stamp = `${now.slice(0, 4)}${now.slice(5, 7)}${now.slice(8, 10)}t${now.slice(11, 13)}${now.slice(14, 16)}${now.slice(17, 19)}z`;
  const index = Object.assign(Object.create(null) as object, o.index, {
    sync: async () => ({ loaded: 0, skipped: 0, removed: 0 }),
    close: () => undefined,
  }) as IndexDb;
  return {
    runId: `r${stamp}-${o.runSuffix ?? (++runCounter % 0x10000).toString(16).padStart(4, '0')}`,
    startedAt: now.replace(/\.\d{3}Z$/, 'Z'),
    toolVersion: '0.1.0',
    config: o.config,
    store: o.store,
    index,
    clock: o.clock,
    fetch: o.fetch,
    log: createLogger({ quiet: true, ci: false, color: false, secrets }),
    secrets,
    signal: new AbortController().signal,
    flags: { ...NO_FLAGS, ...(o.flags ?? {}) },
    google: null,
    env: o.env ?? { DATAFORSEO_LOGIN: 'test-login@example.com', DATAFORSEO_PASSWORD: 'test-password-not-real-1234' },
  };
}
