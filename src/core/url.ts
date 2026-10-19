// normalizeUrl (the join contract), property domains, on-property checks and the private-host guard. Owner: WP-A.
//
// Every URL that is stored, compared or joined goes through normalizeUrl first, so GSC pages,
// crawl records, inspections and internal links all meet on the same string.
import { StError } from './errors.js';

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Uppercases percent-escape hex digits and decodes escapes of unreserved characters (RFC 3986 6.2.2). */
function normalizeEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function parseHttpUrl(u: string): URL | null {
  if (typeof u !== 'string') return null;
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * The join contract. Lowercase scheme and host, no default port, no fragment, no credentials,
 * no trailing dot on the host, percent-escapes normalised, query string and trailing slash kept
 * exactly. An empty path becomes '/'. Throws StError('internal') on anything that is not an
 * absolute http(s) URL, so callers filter mailto:, javascript: and relative links first.
 */
export function normalizeUrl(u: string): string {
  const url = parseHttpUrl(u);
  if (!url) {
    const shown = typeof u === 'string' ? u.slice(0, 200) : String(u);
    throw new StError('internal', `Not an absolute http(s) URL: ${JSON.stringify(shown)}`);
  }
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  url.pathname = normalizeEscapes(url.pathname);
  url.search = url.search === '' ? '' : normalizeEscapes(url.search);
  return url.href;
}

/** 'sc-domain:seoengico.com' -> 'seoengico.com'; 'https://www.x.com/' -> 'x.com' */
export function siteDomainOf(property: string): string {
  const p = String(property).trim();
  if (p.toLowerCase().startsWith('sc-domain:')) return p.slice('sc-domain:'.length).toLowerCase().replace(/\.$/, '');
  const url = parseHttpUrl(p);
  const host = (url ? url.hostname : p).toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Whether url belongs to the Search Console property. A Domain property (sc-domain:x) covers
 * x and every subdomain on http and https. A URL-prefix property covers URLs that start with
 * the prefix exactly (same scheme, host and path prefix), as Search Console does.
 */
export function isOnProperty(url: string, property: string): boolean {
  const target = parseHttpUrl(url);
  if (!target) return false;
  const p = String(property).trim();
  if (p.toLowerCase().startsWith('sc-domain:')) return domainMatches(target.hostname, siteDomainOf(p));
  if (!parseHttpUrl(p)) return false;
  return normalizeUrl(url).startsWith(normalizeUrl(p));
}

/** d === s || d.endsWith('.' + s), case-insensitive. Trailing dots are ignored. */
export function domainMatches(domain: string, siteDomain: string): boolean {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, '');
  const s = String(siteDomain).trim().toLowerCase().replace(/\.$/, '');
  if (!d || !s) return false;
  return d === s || d.endsWith(`.${s}`);
}

/** Path plus query string, without the fragment: 'https://x.com/a/b?c=1#d' -> '/a/b?c=1'. Lenient with bare paths. */
export function pathOf(url: string): string {
  const parsed = parseHttpUrl(url);
  if (parsed) return `${parsed.pathname}${parsed.search}`;
  const s = String(url);
  const hash = s.indexOf('#');
  return hash >= 0 ? s.slice(0, hash) : s;
}

/** sc-domain:x -> ['https://x/', 'https://www.x/']; a URL-prefix property -> its origin with a trailing slash. */
export function defaultOrigins(property: string): string[] {
  const p = String(property).trim();
  if (p.toLowerCase().startsWith('sc-domain:')) {
    const d = siteDomainOf(p);
    return d.startsWith('www.') ? [`https://${d}/`] : [`https://${d}/`, `https://www.${d}/`];
  }
  const url = parseHttpUrl(p);
  return url ? [`${url.origin}/`] : [];
}

const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.localdomain'];

function v4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||               // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) ||                         // carrier-grade NAT
    (a === 169 && b === 254) ||                                   // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||             // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) ||                      // benchmarking
    (a === 198 && b === 51 && c === 100) ||                       // TEST-NET-2
    (a === 203 && b === 0 && c === 113)                           // TEST-NET-3
  );
}

/** Eight 16-bit groups of a canonical IPv6 address (no embedded dotted quad), or null. */
function v6Groups(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const parts = s.split(':');
    if (!parts.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
    return parts.map((x) => parseInt(x, 16));
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...tail] : null;
}

function isPrivateV6(host: string): boolean {
  let canon: string;
  try {
    canon = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  const g = v6Groups(canon);
  if (!g) return true;
  const embeddedV4 = (): number[] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (g.every((x) => x === 0)) return true;                                       // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;              // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(embeddedV4()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4());       // ::a.b.c.d (deprecated)
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(embeddedV4()); // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4()); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;                // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2002) return isPrivateV4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]); // 6to4 2002::/16
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true;         // discard-only 100::/64
  if ((g[0] & 0xffc0) === 0xfec0) return true;                                     // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                     // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                     // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true;                                     // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                             // documentation
  return false;
}

/**
 * True for hosts the crawler must never fetch: loopback, private, link-local, reserved and
 * documentation IP ranges (v4 and v6, including mapped and odd numeric forms such as
 * '2130706433' or '0x7f.1'), localhost and internal-only names, single-label names, and
 * anything unparsable. This is a string check; it does not resolve DNS (the crawler checks the
 * resolved addresses separately, see guardedGet's resolveHost).
 */
export function isPrivateHost(host: string): boolean {
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return true;
  if (h.includes(':')) return isPrivateV6(h);
  let canon: string;
  try {
    canon = new URL(`http://${h}/`).hostname;
  } catch {
    return true;
  }
  if (canon.endsWith('.')) canon = canon.slice(0, -1);
  const v4 = v4Octets(canon);
  if (v4) return isPrivateV4(v4);
  if (canon === 'localhost' || PRIVATE_NAME_SUFFIXES.some((s) => canon.endsWith(s))) return true;
  return !canon.includes('.');
}
