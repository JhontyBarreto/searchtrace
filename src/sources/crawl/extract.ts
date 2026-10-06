// htmlparser2 SAX extraction into PageFields (4.4). Owner: WP-C.
//
// One streaming pass with no DOM. Main text comes from <main>, else every <article>, else the
// body minus nav, header, footer and aside. Script, style, noscript, template and svg content
// never counts as text. JSON-LD blocks are parsed on their own; a malformed block is ignored.
// xRobotsTag is an HTTP header, so it is always null here and the crawler fills it in.
import { Parser } from 'htmlparser2';
import { sha256Hex } from '../../core/ids.js';
import type { PageFields } from '../../core/types.js';
import { isOnProperty, normalizeUrl } from '../../core/url.js';
import { simhash64 } from './simhash.js';

/** Caps that keep one page's record small; real pages sit far below them. */
const MAX_INTERNAL_LINKS = 2000;
const MAX_TITLE = 1000;
const MAX_DESCRIPTION = 2000;
const MAX_H1 = 500;
const MAX_JSONLD_BYTES = 1_000_000;

/** Text inside these never counts. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
/** Page chrome, left out of the body fallback. */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
/** Inline tags do not split words; every other tag boundary inserts a space. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'mark', 'q', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function clip(s: string | null, max: number): string | null {
  if (s === null) return null;
  const t = squash(s);
  if (t === '') return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** JSON with sorted object keys at every level, so equal fields always hash the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 of the canonical JSON of the fields (SnapshotRecord.fieldsHash). */
export function fieldsHashOf(fields: PageFields): string {
  return sha256Hex(canonicalJson(fields));
}

function parseJsonLd(text: string): unknown {
  if (text.length > MAX_JSONLD_BYTES) return null;
  const cleaned = text.trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
  if (cleaned === '') return null;
  try {
    return JSON.parse(cleaned, (key, value: unknown) => (key === '__proto__' ? undefined : value));
  } catch {
    return null;
  }
}

function typeNames(t: unknown): string[] {
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().replace(/^https?:\/\/schema\.org\//i, ''))
    .filter((x) => x !== '');
}

/** Top-level JSON-LD nodes and @graph members (recursively through nested @graph). */
function jsonLdNodes(doc: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 8 || doc === null || typeof doc !== 'object') return out;
  if (Array.isArray(doc)) {
    for (const d of doc) jsonLdNodes(d, out, depth + 1);
    return out;
  }
  const node = doc as Record<string, unknown>;
  out.push(node);
  if (Array.isArray(node['@graph'])) jsonLdNodes(node['@graph'], out, depth + 1);
  return out;
}

function resolveHttp(href: string, base: string): string | null {
  const h = href.trim();
  if (h === '' || h.startsWith('#') || /^(javascript|mailto|tel|data|sms|ftp|file):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeUrl(u.href);
  } catch {
    return null;
  }
}

interface State {
  skip: number;
  chrome: number;
  head: number;
  title: number;
  h1: number;
  main: number;
  article: number;
  jsonLd: boolean;
  mainSeen: boolean;
  articleSeen: boolean;
}

export function extractFields(html: string, pageUrl: string, property: string): PageFields {
  const st: State = { skip: 0, chrome: 0, head: 0, title: 0, h1: 0, main: 0, article: 0, jsonLd: false, mainSeen: false, articleSeen: false };
  let title: string | null = null;
  let titleBuf = '';
  let metaDescription: string | null = null;
  const robots: string[] = [];
  let canonicalRaw: string | null = null;
  let baseRaw: string | null = null;
  let lang: string | null = null;
  let ogSiteName: string | null = null;
  let hreflangCount = 0;
  const hrefs: string[] = [];
  const h1s: string[] = [];
  let h1Buf = '';
  const jsonLdBlocks: string[] = [];
  let jsonLdBuf = '';
  let mainBuf = '';
  let articleBuf = '';
  let bodyBuf = '';

  const space = (): void => {
    if (st.title > 0 || st.skip > 0) return;
    if (st.h1 > 0) h1Buf += ' ';
    if (st.main > 0) mainBuf += ' ';
    if (st.article > 0) articleBuf += ' ';
    if (st.head === 0 && st.chrome === 0) bodyBuf += ' ';
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const a = (k: string): string | null => (Object.prototype.hasOwnProperty.call(attribs, k) ? attribs[k] : null);
        if (SKIP_TAGS.has(name)) {
          st.skip++;
          if (name === 'script' && st.skip === 1 && (a('type') ?? '').trim().toLowerCase() === 'application/ld+json') {
            st.jsonLd = true;
            jsonLdBuf = '';
          }
          return;
        }
        if (st.skip > 0) return;
        if (!INLINE_TAGS.has(name)) space();
        switch (name) {
          case 'html':
            if (lang === null && a('lang')) lang = squash(a('lang') ?? '').toLowerCase() || null;
            break;
          case 'head':
            st.head++;
            break;
          case 'title':
            st.title++;
            break;
          case 'h1':
            st.h1++;
            break;
          case 'main':
            st.main++;
            st.mainSeen = true;
            break;
          case 'article':
            st.article++;
            st.articleSeen = true;
            break;
          case 'base':
            if (baseRaw === null && a('href')) baseRaw = a('href');
            break;
          case 'a':
            if (a('href') !== null) hrefs.push(a('href') ?? '');
            break;
          case 'link': {
            const rel = (a('rel') ?? '').toLowerCase().split(/\s+/);
            if (rel.includes('canonical') && canonicalRaw === null && a('href')) canonicalRaw = a('href');
            if (rel.includes('alternate') && a('hreflang')) hreflangCount++;
            break;
          }
          case 'meta': {
            const metaName = (a('name') ?? '').trim().toLowerCase();
            const prop = (a('property') ?? '').trim().toLowerCase();
            const content = a('content');
            if (content === null) break;
            if (metaName === 'description' && metaDescription === null) metaDescription = clip(content, MAX_DESCRIPTION);
            else if (metaName === 'robots' && squash(content)) robots.push(squash(content).toLowerCase());
            else if (metaName === 'googlebot' && squash(content)) robots.push(`googlebot: ${squash(content).toLowerCase()}`);
            if ((prop === 'og:site_name' || metaName === 'og:site_name') && ogSiteName === null) ogSiteName = clip(content, MAX_TITLE);
            break;
          }
          default:
            if (CHROME_TAGS.has(name)) st.chrome++;
        }
      },
      ontext(data) {
        if (st.skip > 0) {
          if (st.jsonLd && jsonLdBuf.length <= MAX_JSONLD_BYTES) jsonLdBuf += data;
          return;
        }
        if (st.title > 0) {
          if (title === null) titleBuf += data;
          return;
        }
        if (st.h1 > 0) h1Buf += data;
        if (st.main > 0) mainBuf += data;
        if (st.article > 0) articleBuf += data;
        if (st.head === 0 && st.chrome === 0) bodyBuf += data;
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) {
          if (st.skip > 0) st.skip--;
          if (st.skip === 0 && st.jsonLd) {
            jsonLdBlocks.push(jsonLdBuf);
            st.jsonLd = false;
            jsonLdBuf = '';
          }
          return;
        }
        if (st.skip > 0) return;
        switch (name) {
          case 'head':
            if (st.head > 0) st.head--;
            break;
          case 'title':
            if (st.title > 0) st.title--;
            if (st.title === 0 && title === null) {
              title = clip(titleBuf, MAX_TITLE);
              titleBuf = '';
            }
            break;
          case 'h1':
            if (st.h1 > 0) st.h1--;
            if (st.h1 === 0) {
              const t = clip(h1Buf, MAX_H1);
              if (t !== null && h1s.length < 3) h1s.push(t);
              h1Buf = '';
            }
            break;
          case 'main':
            if (st.main > 0) st.main--;
            break;
          case 'article':
            if (st.article > 0) st.article--;
            break;
          default:
            if (CHROME_TAGS.has(name) && st.chrome > 0) st.chrome--;
        }
        if (!INLINE_TAGS.has(name)) space();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(String(html ?? ''));
  parser.end();

  const base = (baseRaw !== null ? resolveHttp(baseRaw, pageUrl) : null) ?? pageUrl;

  // JSON-LD types and the site name fallback.
  const types = new Set<string>();
  let webSiteName: string | null = null;
  let orgName: string | null = null;
  for (const block of jsonLdBlocks) {
    for (const node of jsonLdNodes(parseJsonLd(block))) {
      const names = typeNames(node['@type']);
      for (const t of names) types.add(t);
      const n = typeof node.name === 'string' ? clip(node.name, MAX_TITLE) : null;
      if (n !== null && webSiteName === null && names.includes('WebSite')) webSiteName = n;
      if (n !== null && orgName === null && names.some((t) => t === 'Organization' || t.endsWith('Organization'))) orgName = n;
    }
  }

  // Links.
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const href of hrefs) {
    const u = resolveHttp(href, base);
    if (u === null) continue;
    if (isOnProperty(u, property)) internal.add(u);
    else external.add(u);
  }
  const internalLinks = [...internal].sort().slice(0, MAX_INTERNAL_LINKS);

  // Main text.
  const mainText = squash(mainBuf);
  const articleText = squash(articleBuf);
  const text = st.mainSeen && mainText !== '' ? mainText : st.articleSeen && articleText !== '' ? articleText : squash(bodyBuf);

  return {
    title,
    metaDescription,
    metaRobots: robots.length ? robots.join(', ') : null,
    xRobotsTag: null,
    canonical: canonicalRaw !== null ? resolveHttp(canonicalRaw, base) : null,
    h1: h1s,
    lang,
    siteName: ogSiteName ?? webSiteName ?? orgName,
    wordCount: (text.match(/\p{L}+/gu) ?? []).length,
    textHash: sha256Hex(text),
    simhash: simhash64(text),
    jsonLdTypes: [...types].sort(),
    internalLinks,
    externalLinkCount: external.size,
    hreflangCount,
  };
}
