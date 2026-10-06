// Sitemaps: robots Sitemap: lines, sitemap index, .xml.gz, regex-only <loc>/<lastmod> (4.4). Owner: WP-C.
//
// Security (4.11): sitemaps are scanned with plain string searches and small bounded regexes,
// never an XML parser, so there is no DTD processing and no entity expansion. Comments,
// processing instructions and any DOCTYPE (with its internal subset) are cut out first. Only
// the five predefined XML entities and numeric character references are decoded; any other
// '&name;' is left exactly as written. Every scan moves forward, so hostile input (thousands of
// unclosed tags) stays linear.

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** Sitemap protocol limit: 50,000 URLs per file. */
export const MAX_SITEMAP_ENTRIES = 50_000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** An optional namespace prefix on a tag name, e.g. 'sm:' in <sm:loc>. */
const NS = '(?:[A-Za-z_][\\w.-]{0,40}:)?';

/** Decodes the five XML entities and numeric character references. Other entities stay unexpanded. */
export function decodeXmlText(s: string): string {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{1,10});/g, (whole, name: string) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const cp = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : whole;
  });
}

/** Cuts every open...close span (an unterminated one cuts to the end). */
function cutSpans(s: string, open: string, close: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const a = s.indexOf(open, pos);
    if (a < 0) return out + s.slice(pos);
    out += `${s.slice(pos, a)} `;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) return out;
    pos = b + close.length;
  }
}

/** Cuts DOCTYPE declarations, including an internal subset in [...]. */
function cutDoctypes(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  let pos = 0;
  for (;;) {
    const a = lower.indexOf('<!doctype', pos);
    if (a < 0) return out + s.slice(pos);
    out += `${s.slice(pos, a)} `;
    let j = a + 9;
    while (j < s.length && s[j] !== '[' && s[j] !== '>') j++;
    if (j >= s.length) return out;
    if (s[j] === '[') {
      const endRe = /\]\s*>/g;
      endRe.lastIndex = j;
      const m = endRe.exec(s);
      if (!m) return out;
      pos = m.index + m[0].length;
    } else {
      pos = j + 1;
    }
  }
}

function stripMarkup(xml: string): string {
  return cutDoctypes(cutSpans(cutSpans(xml, '<!--', '-->'), '<?', '?>'));
}

/** Text content of an element body: CDATA unwrapped, entities decoded outside CDATA, tags dropped, trimmed. */
function elementText(inner: string): string {
  let out = '';
  let pos = 0;
  const plain = (t: string): string => decodeXmlText(t.replace(/<[^<>]{0,2000}>/g, ''));
  for (;;) {
    const start = inner.indexOf('<![CDATA[', pos);
    if (start < 0) {
      out += plain(inner.slice(pos));
      break;
    }
    out += plain(inner.slice(pos, start));
    const end = inner.indexOf(']]>', start + 9);
    if (end < 0) {
      out += inner.slice(start + 9);
      break;
    }
    out += inner.slice(start + 9, end);
    pos = end + 3;
  }
  return out.trim();
}

/** Each <tag>...</tag> element body in order, scanning forward only. */
function* elements(body: string, tag: string, from = 0, to = body.length): Generator<string> {
  const openRe = new RegExp(`<${NS}${tag}(?:\\s[^<>]{0,2000})?>`, 'gi');
  const closeRe = new RegExp(`</${NS}${tag}\\s{0,20}>`, 'gi');
  let pos = from;
  while (pos < to) {
    openRe.lastIndex = pos;
    const o = openRe.exec(body);
    if (!o || o.index >= to) return;
    const innerStart = o.index + o[0].length;
    closeRe.lastIndex = innerStart;
    const c = closeRe.exec(body);
    if (!c || c.index > to) return;
    yield body.slice(innerStart, c.index);
    pos = c.index + c[0].length;
  }
}

function childText(block: string, tag: string): string | null {
  for (const inner of elements(block, tag)) {
    const text = elementText(inner);
    return text === '' ? null : text;
  }
  return null;
}

export function parseSitemapXml(xml: string): { kind: 'index' | 'urlset' | 'unknown'; entries: SitemapEntry[] } {
  const body = stripMarkup(String(xml ?? ''));
  const isIndex = new RegExp(`<${NS}sitemapindex[\\s>]`, 'i').test(body);
  const isUrlset = new RegExp(`<${NS}urlset[\\s>]`, 'i').test(body);
  const kind: 'index' | 'urlset' | 'unknown' = isIndex ? 'index' : isUrlset ? 'urlset' : 'unknown';
  if (kind === 'unknown') return { kind, entries: [] };
  const entries: SitemapEntry[] = [];
  for (const block of elements(body, kind === 'index' ? 'sitemap' : 'url')) {
    const loc = childText(block, 'loc');
    if (!loc) continue;
    entries.push({ loc, lastmod: childText(block, 'lastmod') });
    if (entries.length >= MAX_SITEMAP_ENTRIES) break;
  }
  return { kind, entries };
}
