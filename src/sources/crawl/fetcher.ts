// Polite page fetch: host guard, manual redirects, conditional GET, decoded-size cap, outcomes (4.4). Owner: WP-C.
//
// Every request goes through http/request.ts (the only fetch caller) with redirect: 'manual'
// and no retries. Before each hop the URL is checked: http(s) only, on the property, on the
// site's own port (the default one unless siteOrigin names another), and not a private or
// internal host. A hop that fails the check is never requested and the page is recorded as
// off_property. When a resolver is given, the hop's host is also looked up and refused
// (private_address) if any address is private: a name on your own property can point at
// 127.0.0.1 or 10.x. A lookup-then-fetch check leaves a small DNS rebinding window; see
// docs/PRIVACY.md. At most 5 redirects are followed.
import { StError } from '../../core/errors.js';
import type { Fetch, FetchOutcome } from '../../core/types.js';
import { isOnProperty, isPrivateHost, normalizeUrl } from '../../core/url.js';
import { request } from '../../http/request.js';
import { ROBOTS_MAX_BYTES, allowAllRules, disallowAllRules, parseRobots, type RobotsRules } from './robots.js';

// The product token stays "searchtrace" (robots.txt groups match on it); the URL is the owner's repo.
export const USER_AGENT = 'searchtrace/0.1 (+https://github.com/JhontyBarreto/searchtrace)';
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
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
  /** Decompress a body that starts with the gzip magic bytes (an .xml.gz sitemap); maxBytes caps the result. */
  gunzip?: boolean;
  /** The only explicit port allowed ('' means only the scheme's default port). */
  port?: string;
  /** Looks up a host name's addresses before each hop; a private address refuses the hop. */
  resolveHost?: ResolveHost;
}

/** All addresses a host name resolves to (dns.lookup with all: true). */
export type ResolveHost = (host: string) => Promise<string[]>;

export interface GuardedResponse {
  outcome: 'ok' | 'too_large' | 'off_property' | 'private_address' | 'redirect_limit' | 'timeout' | 'network_error';
  status: number | null;
  finalUrl: string | null;
  redirects: string[];
  headers: Headers | null;
  text: string;
}

/**
 * True when the crawler may request url: http(s), on the property, on the default port (or the
 * one explicit port siteOrigin names), and not a private or internal host.
 */
export function urlAllowed(url: string, property: string, port = ''): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port !== '' && u.port !== port) return false;
  if (isPrivateHost(u.hostname)) return false;
  return isOnProperty(u.href, property);
}

/** The explicit port a configured siteOrigin uses, or '' for the scheme's default. */
export function originPort(siteOrigin: string | undefined | null): string {
  if (!siteOrigin) return '';
  try {
    return new URL(siteOrigin).port;
  } catch {
    return '';
  }
}

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|:/;

/** 'ok', 'private' when any address the host resolves to is private, or 'failed' when the lookup failed. */
async function checkResolved(url: string, resolveHost: ResolveHost): Promise<'ok' | 'private' | 'failed'> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (IP_LITERAL.test(host)) return 'ok'; // literals were already checked by urlAllowed
  let addrs: string[];
  try {
    addrs = await resolveHost(host);
  } catch {
    return 'failed';
  }
  if (!addrs.length) return 'failed';
  return addrs.some((a) => isPrivateHost(a)) ? 'private' : 'ok';
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
    if (!urlAllowed(current, o.property, o.port ?? '')) {
      return { outcome: 'off_property', status: null, finalUrl: safeNormalize(current), redirects, headers: null, text: '' };
    }
    if (o.resolveHost) {
      const r = await checkResolved(current, o.resolveHost);
      if (r !== 'ok') {
        return { outcome: r === 'private' ? 'private_address' : 'network_error', status: null, finalUrl: safeNormalize(current), redirects, headers: null, text: '' };
      }
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
        ...(o.gunzip ? { gunzip: true } : {}),
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
    port?: string;
    resolveHost?: ResolveHost;
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
    ...(o.port ? { port: o.port } : {}),
    ...(o.resolveHost ? { resolveHost: o.resolveHost } : {}),
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
    case 'private_address':
      return { ...base, outcome: 'private_address' };
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
  /** The host resolved to a private network address, so nothing there is fetched. */
  privateAddress?: boolean;
}

/** Fetches and interprets <origin>/robots.txt per RFC 9309 2.3.1. origin ends with '/'. */
export async function loadRobots(
  fetchFn: Fetch,
  origin: string,
  o: {
    property: string; userAgent: string; timeoutMs: number; signal?: AbortSignal; beforeRequest?: (url: string) => Promise<void>;
    port?: string; resolveHost?: ResolveHost;
  },
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
    ...(o.port ? { port: o.port } : {}),
    ...(o.resolveHost ? { resolveHost: o.resolveHost } : {}),
  });
  if (g.outcome === 'private_address') return { rules: disallowAllRules(), state: 'unreachable', status: null, privateAddress: true };
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
