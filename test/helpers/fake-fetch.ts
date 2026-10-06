// A route-table fetch with call recording, so no test touches the network. Owner: WP-A.
//
//   const ff = fakeFetch([
//     { method: 'POST', url: 'https://searchconsole.googleapis.com/*', reply: (req, n) => ({ body: { rows: [] } }) },
//     { url: /incidents\.json$/, reply: { status: 503 }, times: 1 },
//   ]);
//   await request(ff.fetch, { url: ... });
//   expect(ff.callsTo('https://searchconsole.googleapis.com/*')).toHaveLength(1);
//   expect(ff.unmatched()).toEqual([]);
//
// Routes are tried in order; the first whose method and URL match and whose `times` is not
// used up answers. Unmatched calls get a 599 reply and are listed by unmatched().
// Simulated failures throw what Node's fetch throws: TypeError('fetch failed') with a cause
// carrying the system error code, or a DOMException named TimeoutError.
import type { Fetch } from '../../src/core/types.js';

export interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** body parsed as JSON. */
  json<T = unknown>(): T;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON. */
  body?: string | Uint8Array | object;
  /** Resolve after this many ms (respects the request's AbortSignal). */
  delayMs?: number;
  /** Simulate a failure instead of a response. */
  error?: 'network' | 'dns' | 'refused' | 'timeout' | 'reset_after_send';
}

/** n is the zero-based count of earlier calls this route has answered. */
export type FakeHandler = (req: FakeRequest, n: number) => FakeReply | Promise<FakeReply>;

export interface FakeRoute {
  method?: 'GET' | 'POST' | 'HEAD';
  /** A string matches the full URL exactly, or as a prefix when it ends with '*'. */
  url: string | RegExp;
  reply: FakeReply | FakeHandler;
  /** Stop matching after this many calls. */
  times?: number;
}

export interface FakeFetch {
  fetch: Fetch;
  /** Every call in order, including unmatched ones (which get a 599 reply and fail the test via unmatched()). */
  calls: FakeRequest[];
  callsTo(url: string | RegExp): FakeRequest[];
  unmatched(): FakeRequest[];
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

type HeadersInput = ConstructorParameters<typeof Headers>[0];
type BodyInput = ConstructorParameters<typeof Response>[0];

function urlMatches(pattern: string | RegExp, url: string): boolean {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(url);
  return pattern.endsWith('*') ? url.startsWith(pattern.slice(0, -1)) : url === pattern;
}

function headersToRecord(h: HeadersInput | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function bodyToString(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function systemError(code: string, message: string): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError('fetch failed', { cause });
}

function failure(kind: NonNullable<FakeReply['error']>): Error {
  switch (kind) {
    case 'dns':
      return systemError('ENOTFOUND', 'getaddrinfo ENOTFOUND');
    case 'refused':
      return systemError('ECONNREFUSED', 'connect ECONNREFUSED');
    case 'reset_after_send':
      return systemError('ECONNRESET', 'read ECONNRESET');
    case 'timeout':
      return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    default:
      return systemError('UND_ERR_SOCKET', 'other side closed');
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toResponse(reply: FakeReply, url: string): Response {
  const status = reply.status ?? 200;
  const headers = new Headers(reply.headers ?? {});
  let body: BodyInput = null;
  if (!NULL_BODY_STATUS.has(status) && reply.body !== undefined) {
    if (typeof reply.body === 'string') {
      body = reply.body;
    } else if (reply.body instanceof Uint8Array) {
      body = reply.body as unknown as BodyInput;
    } else {
      body = JSON.stringify(reply.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    }
  }
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: FakeRequest[] = [];
  const unmatchedCalls: FakeRequest[] = [];
  const used = routes.map(() => 0);

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const fromRequest = input instanceof Request ? input : null;
    const url = fromRequest ? fromRequest.url : String(input);
    const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
    const headers = { ...headersToRecord(fromRequest?.headers), ...headersToRecord(init?.headers) };
    const body = bodyToString(init?.body);
    const signal = init?.signal ?? fromRequest?.signal ?? null;
    const req: FakeRequest = {
      url,
      method,
      headers,
      body,
      json<T = unknown>(): T {
        return JSON.parse(body ?? 'null') as T;
      },
    };
    calls.push(req);
    if (signal?.aborted) throw abortReason(signal);

    const index = routes.findIndex(
      (r, k) =>
        (r.method === undefined || r.method === method) &&
        urlMatches(r.url, url) &&
        (r.times === undefined || used[k] < r.times),
    );
    if (index < 0) {
      unmatchedCalls.push(req);
      return toResponse({ status: 599, body: `fakeFetch: no route for ${method} ${url}` }, url);
    }
    const n = used[index]++;
    const route = routes[index];
    const reply = typeof route.reply === 'function' ? await route.reply(req, n) : route.reply;
    if (reply.delayMs !== undefined && reply.delayMs > 0) await wait(reply.delayMs, signal);
    if (reply.error) throw failure(reply.error);
    return toResponse(reply, url);
  };

  return {
    fetch: fetchImpl as Fetch,
    calls,
    callsTo: (pattern) => calls.filter((c) => urlMatches(pattern, c.url)),
    unmatched: () => [...unmatchedCalls],
  };
}
