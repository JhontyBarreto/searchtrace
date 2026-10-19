// RFC 9309 robots.txt parser and matcher (4.4). Owner: WP-C.
//
// - Groups: consecutive user-agent lines open a group; the rules that follow belong to it.
//   Every group whose user-agent matches our product token (case-insensitive) is merged; with
//   none, every '*' group is merged; with neither, everything is allowed.
// - Rules: '*' matches any run of characters and a trailing '$' anchors the end. The longest
//   pattern (in octets) wins, and Allow beats Disallow on a tie. Empty rules are ignored.
// - Paths and patterns are compared after the same percent-encoding normalisation (RFC 9309
//   2.2.2): unreserved escapes decoded, other escapes upper-cased, non-ASCII percent-encoded.
// - /robots.txt itself is always allowed. Only the first 500 KiB is parsed.
// - Crawl-delay is not in RFC 9309 but is honoured up to 10 seconds (spec 4.4).
// Matching is a linear two-pointer wildcard match, never a regex built from file content.

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
  crawlDelaySec: number | null;
}

/** RFC 9309 asks crawlers to parse at least 500 KiB. */
export const ROBOTS_MAX_BYTES = 500 * 1024;
const MAX_CRAWL_DELAY_SEC = 10;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** The rules when robots.txt is unavailable (4xx): everything is allowed. */
export function allowAllRules(sitemaps: string[] = []): RobotsRules {
  return { allow: [], disallow: [], sitemaps, crawlDelaySec: null };
}

/** The rules when robots.txt is unreachable (5xx, network error): nothing is allowed. */
export function disallowAllRules(): RobotsRules {
  return { allow: [], disallow: ['/'], sitemaps: [], crawlDelaySec: null };
}

/** The product token of a user agent string: 'searchtrace/0.1 (+https://...)' -> 'searchtrace'. */
export function productToken(userAgent: string): string {
  return (String(userAgent).trim().split(/[\s/]/)[0] ?? '').toLowerCase();
}

const utf8 = new TextEncoder();

/** Percent-encoding normalisation shared by patterns and paths. '*' and '$' are kept as they are. */
export function normalizeRobotsPath(s: string): string {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(k + 1, k + 3))) {
      const hex = s.slice(k + 1, k + 3);
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      k += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code > 0x7e || code < 0x21) {
      // Non-ASCII (including surrogate pairs) and controls/space are percent-encoded as UTF-8.
      const cp = s.codePointAt(k) ?? code;
      const chars = String.fromCodePoint(cp);
      for (const b of utf8.encode(chars)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
      k += chars.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

function cleanPattern(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  const withSlash = v.startsWith('/') || v.startsWith('*') ? v : `/${v}`;
  return normalizeRobotsPath(withSlash);
}

/** Rules for the user-agent token (searchtrace, falling back to *). */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = productToken(userAgent);
  const body = String(text ?? '').slice(0, ROBOTS_MAX_BYTES).replace(/^﻿/, '');
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of body.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line === '') continue;
    // Split on the first colon. (A single regex with a lazy field and \s* both matching spaces
    // backtracked quadratically: one hostile 500 KiB line took minutes.)
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const rawField = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z_ -]*$/.test(rawField)) continue;
    const field = rawField.toLowerCase().replace(/[\s_]+/g, '-');
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent' || field === 'useragent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(productToken(value) || value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line belong to no group
      const pattern = cleanPattern(value);
      if (pattern === null) continue;
      (field === 'allow' ? current.allow : current.disallow).push(pattern);
    } else if (field === 'crawl-delay') {
      lastWasAgent = false;
      if (!current) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (field === 'sitemap' || field === 'site-map') {
      if (value) sitemaps.push(value);
    }
  }

  let chosen = groups.filter((g) => g.agents.includes(token));
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes('*'));
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    sitemaps: [...new Set(sitemaps)],
    crawlDelaySec: delays.length ? Math.min(MAX_CRAWL_DELAY_SEC, Math.max(...delays)) : null,
  };
}

/** Wildcard match where '*' is any run of characters; the whole of s must be consumed. */
function globMatch(p: string, s: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] !== '*' && p[i] === s[j]) {
      i++;
      j++;
    } else if (i < p.length && p[i] === '*') {
      star = i++;
      mark = j;
    } else if (star !== -1) {
      i = star + 1;
      j = ++mark;
    } else {
      return false;
    }
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/** True when the pattern matches the (normalised) path. A trailing '$' anchors the end; otherwise it is a prefix match. */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('$')) return globMatch(pattern.slice(0, -1), path);
  return globMatch(`${pattern}*`, path);
}

function longestMatch(patterns: string[], path: string): number {
  let best = -1;
  for (const p of patterns) if (p.length > best && patternMatches(p, path)) best = p.length;
  return best;
}

/** Longest match wins; Allow beats Disallow on a tie. pathAndQuery is the URL path plus query string. */
export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  const raw = pathAndQuery === '' ? '/' : pathAndQuery;
  const path = normalizeRobotsPath(raw.startsWith('/') ? raw : `/${raw}`);
  if (path === '/robots.txt') return true;
  const d = longestMatch(rules.disallow, path);
  if (d < 0) return true;
  return longestMatch(rules.allow, path) >= d;
}
