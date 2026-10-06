// The only module that calls the injected fetch: timeouts, retries, Retry-After, size cap, redacted errors. Owner: WP-A.
//
// Behaviour (spec 4.7):
// - Each attempt gets AbortSignal.timeout(timeoutMs) (default 60 s), combined with req.signal.
// - Retries: by default 6 attempts on 429, 500, 502, 503 and 504 with full-jitter exponential
//   backoff (base 1 s, cap 64 s), honouring Retry-After. Network errors and timeouts are retried
//   only when the request is idempotent (default: GET only). `retry: false` means one attempt.
//   When Retry-After asks for longer than capMs, retrying stops and the response is returned.
// - When retries run out on a retryable status, the last response is returned, not thrown:
//   callers map statuses (401, 403, 404, persistent 429) to their own errors and fix lines.
// - Bodies are read as a stream and cut at maxBytes decoded bytes (default 64 MiB), with
//   `truncated: true`. Text is decoded with the charset from Content-Type (UTF-8 otherwise).
// - Failures throw StError('network') with extra fields: url (no query string), method,
//   attempts, timedOut, cancelled, and notSent (true only when the request provably never left
//   this machine: DNS failure, connection refused, TLS setup). Non-idempotent callers use
//   notSent to tell "failed" from "unknown" (DataForSEO at-most-once posting).
// - Error messages carry at most 500 characters of the response body, with tokens, keys and
//   passwords removed. Headers are never put in messages.
import { StError } from '../core/errors.js';
import type { Fetch, HttpRequest, HttpResponse } from '../core/types.js';
import { parseJsonSafe } from '../store/ndjson.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY = { attempts: 6, baseMs: 1000, capMs: 64_000, on: [429, 500, 502, 503, 504] };
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const BODY_SNIPPET = 500;

/** System error codes that mean the request was never sent. */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** Extra fields on the StError that request() and requestJson() throw. */
export interface HttpFailure {
  url: string;
  method: string;
  attempts: number;
  status?: number;
  notSent: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Redacted, at most 500 characters. */
  body?: string;
}

/** Origin and path only: query strings can carry keys, and URLs are shown to users. */
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

/** Removes tokens, keys and passwords from a response body, then cuts it to 500 characters. */
export function redactBody(text: string): string {
  const s = String(text)
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret|private_key|private_key_id|password|passwd|token|api_key|apikey|secret|authorization)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi,
      '$1[redacted]$3',
    )
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > BODY_SNIPPET ? `${s.slice(0, BODY_SNIPPET)}...` : s;
}

function fail(code: 'network' | 'http', message: string, info: HttpFailure): StError {
  return Object.assign(new StError(code, message), info);
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '(invalid URL)';
  }
}

function serialiseBody(body: unknown): { body?: string | Uint8Array; json: boolean } {
  if (body === undefined || body === null) return { json: false };
  if (typeof body === 'string' || body instanceof Uint8Array) return { body, json: false };
  return { body: JSON.stringify(body), json: true };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** Milliseconds from a Retry-After header (delta seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function backoffMs(attempt: number, retry: { baseMs: number; capMs: number }): number {
  const ceiling = Math.min(retry.capMs, retry.baseMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling); // full jitter
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function charsetOf(contentType: string | null): string {
  const m = contentType ? /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType) : null;
  return m ? m[1].toLowerCase() : 'utf-8';
}

async function readBody(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = Buffer.concat(chunks, total);
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(charsetOf(res.headers.get('content-type')));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(buf), truncated };
}

interface Classified { timedOut: boolean; notSent: boolean; reason: string }

function classify(e: unknown, timeoutMs: number, timeoutSignal: AbortSignal): Classified {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const timedOut = timeoutSignal.aborted || err.name === 'TimeoutError';
  const code = err.cause?.code ?? err.code;
  if (timedOut) {
    const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    return { timedOut: true, notSent: false, reason: `no answer within ${limit}` };
  }
  return {
    timedOut: false,
    notSent: code !== undefined && NOT_SENT_CODES.has(code),
    reason: code ?? err.cause?.message ?? err.message ?? 'network error',
  };
}

export async function request(fetchFn: Fetch, req: HttpRequest): Promise<HttpResponse> {
  const method = req.method ?? 'GET';
  const retry = req.retry === false ? null : { ...DEFAULT_RETRY, ...(req.retry ?? {}) };
  const attempts = retry ? Math.max(1, Math.floor(retry.attempts)) : 1;
  const idempotent = req.idempotent ?? method === 'GET';
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const shownUrl = safeUrl(req.url);
  const { body, json } = serialiseBody(req.body);
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (json && !hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';

  const info = (attempt: number, extra: Partial<HttpFailure> = {}): HttpFailure => ({
    url: shownUrl, method, attempts: attempt, notSent: false, timedOut: false, cancelled: false, ...extra,
  });
  const cancelled = (attempt: number): StError =>
    fail('network', `${method} ${shownUrl} was cancelled.`, info(attempt, { cancelled: true }));
  const wait = async (ms: number, attempt: number): Promise<void> => {
    try {
      await sleep(ms, req.signal);
    } catch {
      throw cancelled(attempt);
    }
  };

  for (let attempt = 1; ; attempt++) {
    if (req.signal?.aborted) throw cancelled(attempt - 1);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    let text: string;
    let truncated: boolean;
    try {
      res = await fetchFn(req.url, {
        method,
        headers,
        body: body as RequestInit['body'],
        redirect: req.redirect ?? 'follow',
        signal,
      });
      ({ text, truncated } = await readBody(res, maxBytes));
    } catch (e) {
      if (req.signal?.aborted) throw cancelled(attempt);
      const c = classify(e, timeoutMs, timeout);
      // Network errors and timeouts are retried only for idempotent requests (HttpRequest.idempotent).
      if (retry && idempotent && attempt < attempts) {
        await wait(backoffMs(attempt, retry), attempt);
        continue;
      }
      const tries = attempt > 1 ? ` after ${attempt} attempts` : '';
      throw fail('network', `Could not reach ${hostOf(req.url)} (${c.reason})${tries}.`, info(attempt, { notSent: c.notSent, timedOut: c.timedOut }));
    }

    const out: HttpResponse = { status: res.status, headers: res.headers, url: res.url || req.url, text, truncated };
    if (retry && retry.on.includes(res.status) && attempt < attempts) {
      const asked = retryAfterMs(res.headers.get('retry-after'));
      if (asked !== null && asked > retry.capMs) return out;
      await wait(Math.min(retry.capMs, Math.max(asked ?? 0, backoffMs(attempt, retry))), attempt);
      continue;
    }
    return out;
  }
}

/**
 * request() plus JSON parsing ("__proto__" keys are dropped). Any status with a JSON body is
 * returned, so callers can read Google's and DataForSEO's error objects and map them. A
 * non-JSON or empty body on a non-2xx status, an unparseable 2xx body, or a body cut at
 * maxBytes throws StError('http') with status, url and a redacted body snippet attached.
 */
export async function requestJson<T>(fetchFn: Fetch, req: HttpRequest): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (!hasHeader(headers, 'accept')) headers.accept = 'application/json';
  const method = req.method ?? 'GET';
  const res = await request(fetchFn, { ...req, headers });
  const ok = res.status >= 200 && res.status < 300;
  const failure = (why: string): StError =>
    fail('http', `${method} ${safeUrl(req.url)} returned HTTP ${res.status}${why}`, {
      url: safeUrl(req.url), method, attempts: 0, status: res.status, notSent: false, timedOut: false, cancelled: false,
      body: redactBody(res.text),
    });
  if (res.truncated) throw failure(': the response was larger than the size limit.');
  if (res.text.trim() === '') {
    if (ok) return { status: res.status, data: null as T, headers: res.headers };
    throw failure(' with an empty body.');
  }
  let data: unknown;
  try {
    data = parseJsonSafe(res.text);
  } catch {
    throw failure(ok ? ' but the body is not JSON.' : `: ${redactBody(res.text)}`);
  }
  return { status: res.status, data: data as T, headers: res.headers };
}
