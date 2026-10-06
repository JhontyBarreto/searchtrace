// Polite page fetch: host guard, manual redirects, conditional GET, decoded-size cap, outcomes (4.4). Owner: WP-C.
//
// Every request goes through http/request.ts (the only fetch caller) with redirect: 'manual'
// and no retries. Before each hop the URL is checked: http(s) only, on the property, and not a
// private or internal host. A hop that fails the check is never requested and the page is
// recorded as off_property. At most 5 redirects are followed.
import { StError } from '../../core/errors.js';
import type { Fetch, FetchOutcome } from '../../core/types.js';
import { isOnProperty, isPrivateHost, normalizeUrl } from '../../core/url.js';
import { request } from '../../http/request.js';
import { ROBOTS_MAX_BYTES, allowAllRules, disallowAllRules, parseRobots, type RobotsRules } from './robots.js';

export const USER_AGENT = 'searchtrace/0.1 (+https://github.com/searchtrace/searchtrace)';
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
/** How much of a body is searched for a challenge page title. */
const CHALLENGE_SCAN = 100_000;

export interface PageFetch {
  url: string;
  outcome: FetchOutcome;
  status: number | null;
  finalUrl: string | null;
  redirects: string[];
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  xRobotsTag: string | null;
  html: string | null;
}

export interface GuardedOptions {
  property: string;
  userAgent?: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Awaited before every request, including each redirect hop (per-host pacing). */
  beforeRequest?: (url: string) => Promise<void>;
  maxRedirects?: number;
}

export interface GuardedResponse {
  outcome: 'ok' | 'too_large' | 'off_property' | 'redirect_limit' | 'timeout' | 'network_error';
  status: number | null;
  finalUrl: string | null;
  redirects: string[];
  headers: Headers | null;
  text: string;
}

/** True when the crawler may request url: http(s), on the property, and not a private or internal host. */
export function urlAllowed(url: string, property: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (isPrivateHost(u.hostname)) return false;
  return isOnProperty(u.href, property);
}

function safeNormalize(u: string): string | null {
  try {
    return normalizeUrl(u);
  } catch {
    return null;
  }
}

function isCancelled(e: unknown): boolean {
  return e instanceof StError && (e as StError & { cancelled?: boolean }).cancelled === true;
}

/** GET with manual, guarded redirects. Never throws for network trouble; rethrows only when the run is cancelled. */
export async function guardedGet(fetchFn: Fetch, url: string, o: GuardedOptions): Promise<GuardedResponse> {
  const headers: Record<string, string> = { 'user-agent': o.userAgent ?? USER_AGENT, ...(o.headers ?? {}) };
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!urlAllowed(current, o.property)) {
      return { outcome: 'off_property', status: null, finalUrl: safeNormalize(current), redirects, headers: null, text: '' };
    }
    if (o.beforeRequest) await o.beforeRequest(current);
    let res;
    try {
      res = await request(fetchFn, {
        url: current,
        method: 'GET',
        headers,
        timeoutMs: o.timeoutMs,
        maxBytes: o.maxBytes,
        redirect: 'manual',
        retry: false,
        signal: o.signal,
      });
    } catch (e) {
      if (isCancelled(e) || o.signal?.aborted) throw e;
      const timedOut = e instanceof StError && (e as StError & { timedOut?: boolean }).timedOut === true;
      return { outcome: timedOut ? 'timeout' : 'network_error', status: null, finalUrl: safeNormalize(current), redirects, headers: null, text: '' };
    }
    const location = res.headers.get('location');
    if (REDIRECT_STATUS.has(res.status) && location) {
      if (hop >= maxRedirects) {
        return { outcome: 'redirect_limit', status: res.status, finalUrl: safeNormalize(current), redirects, headers: res.headers, text: '' };
      }
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        return { outcome: 'off_property', status: res.status, finalUrl: null, redirects, headers: res.headers, text: '' };
      }
      redirects.push(safeNormalize(next) ?? next);
      current = next;
      continue;
    }
    return {
      outcome: res.truncated ? 'too_large' : 'ok',
      status: res.status,
      finalUrl: safeNormalize(current),
      redirects,
      headers: res.headers,
      text: res.text,
    };
  }
}

function headerValue(h: Headers | null, name: string): string | null {
  const v = h?.get(name);
  if (v === null || v === undefined) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/** True for a Cloudflare-style bot check: 403/503 with cf-mitigated, or a "Just a moment" title. */
export function isChallenge(status: number | null, headers: Headers | null, text: string): boolean {
  if ((status === 403 || status === 503) && headers?.has('cf-mitigated')) return true;
  return /<title[^<>]{0,200}>\s*just a moment/i.test(text.slice(0, CHALLENGE_SCAN));
}

function looksLikeHtml(contentType: string | null, text: string): boolean {
  if (contentType) return /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  return /^\s*(<!doctype html|<html[\s>]|<head[\s>])/i.test(text.slice(0, 1024));
}

export async function fetchPage(
  fetchFn: Fetch,
  url: string,
  o: {
    property: string;
    userAgent: string;
    timeoutMs: number;
    maxBytes: number;
    etag?: string | null;
    lastModified?: string | null;
    signal?: AbortSignal;
    beforeRequest?: (url: string) => Promise<void>;
  },
): Promise<PageFetch> {
  const headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' };
  if (o.etag) headers['if-none-match'] = o.etag;
  if (o.lastModified) headers['if-modified-since'] = o.lastModified;
  const g = await guardedGet(fetchFn, url, {
    property: o.property,
    userAgent: o.userAgent,
    timeoutMs: o.timeoutMs,
    maxBytes: o.maxBytes,
    headers,
    signal: o.signal,
    beforeRequest: o.beforeRequest,
  });
  const contentType = headerValue(g.headers, 'content-type');
  const base: PageFetch = {
    url,
    outcome: 'network_error',
    status: g.status,
    finalUrl: g.finalUrl,
    redirects: g.redirects,
    contentType,
    etag: headerValue(g.headers, 'etag'),
    lastModified: headerValue(g.headers, 'last-modified'),
    xRobotsTag: headerValue(g.headers, 'x-robots-tag')?.toLowerCase() ?? null,
    html: null,
  };
  switch (g.outcome) {
    case 'off_property':
      return { ...base, outcome: 'off_property' };
    case 'redirect_limit':
      return { ...base, outcome: 'http_error' };
    case 'timeout':
    case 'network_error':
      return { ...base, outcome: g.outcome };
    case 'too_large':
      return { ...base, outcome: 'too_large' };
    default:
      break;
  }
  const status = g.status ?? 0;
  if (status === 304) return { ...base, outcome: 'not_modified' };
  if (isChallenge(status, g.headers, g.text)) return { ...base, outcome: 'blocked_challenge' };
  if (status < 200 || status >= 300) return { ...base, outcome: 'http_error' };
  if (!looksLikeHtml(contentType, g.text)) return { ...base, outcome: 'not_html' };
  return { ...base, outcome: 'ok', html: g.text };
}

// ---------- robots.txt ----------

export interface RobotsResult {
  rules: RobotsRules;
  /** 'parsed' (2xx), 'unavailable' (4xx: everything allowed), 'unreachable' (5xx, 429 or network: nothing allowed). */
  state: 'parsed' | 'unavailable' | 'unreachable';
  status: number | null;
}

/** Fetches and interprets <origin>/robots.txt per RFC 9309 2.3.1. origin ends with '/'. */
export async function loadRobots(
  fetchFn: Fetch,
  origin: string,
  o: { property: string; userAgent: string; timeoutMs: number; signal?: AbortSignal; beforeRequest?: (url: string) => Promise<void> },
): Promise<RobotsResult> {
  const url = new URL('/robots.txt', origin).href;
  const g = await guardedGet(fetchFn, url, {
    property: o.property,
    userAgent: o.userAgent,
    timeoutMs: o.timeoutMs,
    maxBytes: ROBOTS_MAX_BYTES,
    headers: { accept: 'text/plain,*/*;q=0.1' },
    signal: o.signal,
    beforeRequest: o.beforeRequest,
  });
  if (g.outcome === 'timeout' || g.outcome === 'network_error') {
    return { rules: disallowAllRules(), state: 'unreachable', status: null };
  }
  if (g.outcome === 'off_property' || g.outcome === 'redirect_limit') {
    // RFC 9309: a robots.txt that cannot be followed to the end may be treated as unavailable.
    return { rules: allowAllRules(), state: 'unavailable', status: g.status };
  }
  const status = g.status ?? 0;
  if (status >= 200 && status < 300) return { rules: parseRobots(g.text, o.userAgent), state: 'parsed', status };
  if (status === 429 || status >= 500) return { rules: disallowAllRules(), state: 'unreachable', status };
  return { rules: allowAllRules(), state: 'unavailable', status };
}

// ---------- gzip bodies (sitemaps) ----------

/**
 * Wraps the injected fetch so a body that starts with the gzip magic bytes (an .xml.gz sitemap
 * served without Content-Encoding) is decompressed as a stream. request() still reads the
 * result and still enforces its decoded-size cap, so a gzip bomb is cut off at maxBytes.
 */
export function gunzipBodies(inner: Fetch): Fetch {
  const wrapped = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const res = await inner(input, init);
    if (!res.body || NULL_BODY_STATUS.has(res.status)) return res;
    const reader = res.body.getReader();
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let done = false;
    while (headBytes < 2) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        break;
      }
      head.push(r.value);
      headBytes += r.value.byteLength;
    }
    const first = head.length ? Buffer.concat(head) : new Uint8Array(0);
    const isGzip = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.length) controller.enqueue(new Uint8Array(first));
        if (done) controller.close();
      },
      async pull(controller) {
        const r = await reader.read();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    let body: ReadableStream<Uint8Array> = replay;
    if (isGzip) {
      headers.delete('content-encoding');
      headers.set('content-type', 'application/xml; charset=utf-8');
      body = replay.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
    }
    const out = new Response(body, { status: res.status, statusText: res.statusText, headers });
    Object.defineProperty(out, 'url', { value: res.url });
    return out;
  };
  return wrapped as Fetch;
}
