// DataForSEO basic-auth client, endpoint wrappers, status-code handling (4.5). Owner: WP-D.
//
// Every call goes through http/request.ts. GETs and the free id_list POST are idempotent and
// retried; task_post is sent exactly once (retry: false, idempotent: false) and the caller
// decides between "failed" and "unknown" from the thrown StError's `notSent` flag.
//
// A response is OK when the top-level status_code is 20000. Task codes 2xxxx are successes
// (task_post answers 20100 "Task Created"), 4060x means "not ready yet", other 4xxxx are
// per-task failures.
import { z } from 'zod';
import { StError } from '../../core/errors.js';
import type { Fetch, Limiter, SecretRegistry } from '../../core/types.js';
import { createLimiter } from '../../http/limiter.js';
import { requestJson } from '../../http/request.js';

export const DFS_BASE = 'https://api.dataforseo.com';
export const PATHS = {
  taskPost: '/v3/serp/google/organic/task_post',
  tasksReady: '/v3/serp/google/organic/tasks_ready',
  taskGet: (id: string): string => `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(id)}`,
  idList: '/v3/serp/id_list',
  userData: '/v3/appendix/user_data',
} as const;

export const AUTH_FIX = 'Check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (or the variables named in serp.loginEnv and serp.passwordEnv).';
export const BUDGET_FIX = 'Top up your DataForSEO balance, or lower serp.monthlyBudgetUsd.';

const TaskSchema = z.looseObject({
  id: z.string().optional(),
  status_code: z.number(),
  status_message: z.string().optional(),
  cost: z.number().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  result: z.array(z.unknown()).nullish(),
});
const EnvelopeSchema = z.looseObject({
  status_code: z.number(),
  status_message: z.string().optional(),
  cost: z.number().nullish(),
  tasks: z.array(TaskSchema).nullish(),
});

export type DfsTask = z.infer<typeof TaskSchema>;
export type DfsEnvelope = z.infer<typeof EnvelopeSchema>;

export interface DfsClient {
  /** Idempotent GET, retried on 429 and 5xx. */
  get(path: string): Promise<DfsEnvelope>;
  /**
   * POST. With idempotent: false (task_post) the request is sent once and never retried; a
   * network failure throws StError('network') whose `notSent` says whether it provably never left.
   */
  post(path: string, body: unknown, o: { idempotent: boolean }): Promise<DfsEnvelope>;
}

export interface DfsRates {
  idList: { rps: number; concurrency: number };
  tasksReady: { rps: number; concurrency: number };
  taskGet: { rps: number; concurrency: number };
}

/** Documented limits: id_list 10 per minute, tasks_ready 20 per minute. task_get is kept gentle. */
const DEFAULT_RATES: DfsRates = {
  idList: { rps: 10 / 60, concurrency: 1 },
  tasksReady: { rps: 20 / 60, concurrency: 1 },
  taskGet: { rps: 5, concurrency: 2 },
};

let limiters: { idList: Limiter; tasksReady: Limiter; taskGet: Limiter } | null = null;

/** Process-wide limiters, so repeated collector calls (the --wait loop) share one budget per endpoint. */
export function dfsLimiters(): { idList: Limiter; tasksReady: Limiter; taskGet: Limiter } {
  if (!limiters) {
    limiters = {
      idList: createLimiter(DEFAULT_RATES.idList),
      tasksReady: createLimiter(DEFAULT_RATES.tasksReady),
      taskGet: createLimiter(DEFAULT_RATES.taskGet),
    };
  }
  return limiters;
}

/** Test hook: replace the limiters (pass null to restore the documented limits). */
export function setDfsRatesForTests(rates: Partial<DfsRates> | null): void {
  const r = { ...DEFAULT_RATES, ...(rates ?? {}) };
  limiters = rates
    ? { idList: createLimiter(r.idList), tasksReady: createLimiter(r.tasksReady), taskGet: createLimiter(r.taskGet) }
    : null;
}

function authError(): StError {
  return new StError('auth', 'DataForSEO did not accept the login.', AUTH_FIX);
}

function budgetError(): StError {
  return new StError('budget', 'DataForSEO says the account balance is too low.', BUDGET_FIX);
}

/** Maps an HTTP status and envelope to an error, or returns the parsed envelope. */
function checkEnvelope(status: number, data: unknown, label: string): DfsEnvelope {
  const parsed = EnvelopeSchema.safeParse(data);
  const code = parsed.success ? parsed.data.status_code : null;
  if (status === 401 || status === 403 || (code !== null && code >= 40100 && code < 40200)) throw authError();
  if (status === 402 || (code !== null && code >= 40200 && code < 40300)) throw budgetError();
  if (status < 200 || status >= 300) {
    throw Object.assign(new StError('http', `DataForSEO ${label} returned HTTP ${status}.`), { status });
  }
  if (!parsed.success) throw Object.assign(new StError('http', `DataForSEO ${label} sent an unexpected response.`), { status });
  if (parsed.data.status_code !== 20000) {
    const msg = (parsed.data.status_message ?? '').slice(0, 200);
    throw Object.assign(
      new StError('http', `DataForSEO ${label} answered ${parsed.data.status_code}${msg ? ` (${msg})` : ''}.`),
      { status, dfsCode: parsed.data.status_code },
    );
  }
  return parsed.data;
}

function endpointLabel(path: string): string {
  if (path.startsWith('/v3/serp/google/organic/task_get/')) return 'task_get';
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function createDfsClient(o: {
  fetch: Fetch;
  login: string;
  password: string;
  secrets: SecretRegistry;
  signal?: AbortSignal;
  baseUrl?: string;
}): DfsClient {
  const token = Buffer.from(`${o.login}:${o.password}`, 'utf8').toString('base64');
  o.secrets.add(o.password);
  o.secrets.add(token);
  o.secrets.add(`Basic ${token}`);
  const base = o.baseUrl ?? DFS_BASE;
  const headers = { authorization: `Basic ${token}` };

  return {
    async get(path) {
      const res = await requestJson<unknown>(o.fetch, { url: `${base}${path}`, method: 'GET', headers, signal: o.signal });
      return checkEnvelope(res.status, res.data, endpointLabel(path));
    },
    async post(path, body, opts) {
      const res = await requestJson<unknown>(o.fetch, {
        url: `${base}${path}`,
        method: 'POST',
        headers,
        body,
        signal: o.signal,
        idempotent: opts.idempotent,
        ...(opts.idempotent ? {} : { retry: false as const }),
      });
      return checkEnvelope(res.status, res.data, endpointLabel(path));
    },
  };
}

/** True for a per-task success code (20000 ok, 20100 task created). */
export function taskOk(code: number): boolean {
  return code >= 20000 && code < 30000;
}

/** 40601 "Task Handed" and 40602 "Task in Queue": the result is not ready yet. */
export function taskPending(code: number): boolean {
  return code === 40601 || code === 40602;
}

/** "YYYY-MM-DD HH:MM:SS +00:00" (DataForSEO's datetime format), always UTC. */
export function dfsDatetime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +00:00`;
}

/** Parses DataForSEO's "2026-10-06 06:17:00 +00:00" (or an ISO string) into a UTC ISO instant, or null. */
export function parseDfsDatetime(s: unknown): string | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  const text = m ? `${m[1]}T${m[2]}${m[3] ? (m[3] === 'Z' ? 'Z' : m[3].length === 5 ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3]) : 'Z'}` : s;
  const t = Date.parse(text);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
