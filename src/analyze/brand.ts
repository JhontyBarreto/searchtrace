// Brand matcher and doctor suggestions (5.2). Owner: WP-E.
//
// compact(s) = NFKD, strip combining marks, lowercase, keep only [a-z0-9].
// Brand terms = config terms + compact(domain label) + compact(site name).
// Brand tokens come from the domain label: generic words are stripped from either end (longest
// first) while at least 4 characters remain; what is left (4+ characters) is a token.
// A query is brand when its compact form contains a term, a token or compact(siteDomain), or when
// one of its words (5+ characters) is within Damerau-Levenshtein distance 1 of a token.
import type { BrandMatcher, Cell, CtrCurve, Device, Segment } from '../core/types.js';

/** Words that never make a brand on their own (5.2). */
export const GENERIC_WORDS: readonly string[] = [
  'seo', 'web', 'digital', 'marketing', 'agency', 'design', 'designs', 'law', 'legal', 'dental', 'clinic', 'shop', 'store',
  'online', 'media', 'group', 'studio', 'solutions', 'services', 'tech', 'labs', 'consulting', 'global', 'uk', 'usa', 'london',
  'the', 'my', 'get', 'best', 'pro', 'plus', 'hub', 'cloud', 'app', 'net', 'co', 'inc', 'ltd', 'company', 'official', 'plumbing',
  'electric', 'homes', 'health',
];
const GENERIC = new Set(GENERIC_WORDS);
/**
 * Longest first, so 'designs' is stripped before 'design'. Two-letter words ('co', 'uk', 'my') are
 * never stripped from inside a run of letters: they would eat real brand endings ('norvico' must not
 * become 'norvi').
 */
const GENERIC_BY_LENGTH = GENERIC_WORDS.filter((w) => w.length >= 3).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

const MIN_TOKEN = 4;
const MIN_FUZZY_WORD = 5;
const MIN_TERM = 3;

/** NFKD, strip combining marks, lowercase, remove everything outside [a-z0-9]. */
export function compact(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Words of a query, each compacted, empty ones dropped. */
function words(q: string): string[] {
  return String(q ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** The registrable label of a domain: 'seonorvico.example' -> 'seonorvico', 'www.pipewell-plumbing.co.uk' -> 'pipewell-plumbing'. */
export function domainLabel(siteDomain: string): string {
  const parts = String(siteDomain ?? '').toLowerCase().replace(/\.$/, '').split('.').filter((p) => p !== '');
  while (parts.length > 1 && parts[0] === 'www') parts.shift();
  if (parts.length <= 1) return parts[0] ?? '';
  // Skip short second-level suffixes such as co.uk, com.au, org.nz.
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'ltd', 'plc'].includes(sld)) return parts[parts.length - 3];
  return sld;
}

/** Strips generic words from either end of a compact piece while 4+ characters remain. */
function stripGeneric(piece: string): string {
  let s = piece;
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of GENERIC_BY_LENGTH) {
      if (s.length - g.length < MIN_TOKEN) continue;
      if (s.startsWith(g)) {
        s = s.slice(g.length);
        changed = true;
        break;
      }
      if (s.endsWith(g)) {
        s = s.slice(0, s.length - g.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

/**
 * Brand tokens from a domain label (5.2): the whole label is compacted (hyphens go), then generic
 * words are stripped from either end, longest first, while 4+ characters remain. The leftover is
 * the token unless it is itself generic. 'seonorvico' -> ['norvico'], 'pipewell-plumbing' -> ['pipewell'].
 * The label is not split at hyphens: 'acme-heating' must not make 'heating' a brand word.
 */
export function brandTokens(label: string): string[] {
  const piece = compact(label);
  if (piece.length < MIN_TOKEN || GENERIC.has(piece)) return [];
  const left = stripGeneric(piece);
  return left.length >= MIN_TOKEN && !GENERIC.has(left) ? [left] : [];
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), stopping early above max. */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

const MIN_SUGGEST_QUERIES = 3;
const MIN_SUGGEST_RATIO = 3;
/** Without a curve, a click rate this high on the homepage stands in for "3x the curve". */
const FALLBACK_SUGGEST_CTR = 0.3;

export function buildBrandMatcher(i: { siteDomain: string; siteName: string | null; terms: string[] }): BrandMatcher {
  const label = domainLabel(i.siteDomain);
  const tokens = brandTokens(label);
  const termSet = new Set<string>();
  for (const t of [...(i.terms ?? []), label, i.siteName ?? '']) {
    const c = compact(t);
    if (c.length >= MIN_TERM && !GENERIC.has(c)) termSet.add(c);
  }
  const terms = [...termSet].sort();
  const domainCompact = compact(i.siteDomain);
  const cache = new Map<string, boolean>();

  const isBrand = (query: string): boolean => {
    const hit = cache.get(query);
    if (hit !== undefined) return hit;
    const cq = compact(query);
    let brand = false;
    if (cq !== '') {
      if (domainCompact.length >= MIN_TERM && cq.includes(domainCompact)) brand = true;
      else if (terms.some((t) => cq.includes(t)) || tokens.some((t) => cq.includes(t))) brand = true;
      else {
        brand = words(query).some(
          (w) => w.length >= MIN_FUZZY_WORD && tokens.some((t) => damerauLevenshtein(w, t, 1) <= 1),
        );
      }
    }
    if (cache.size < 100_000) cache.set(query, brand);
    return brand;
  };

  const suggestions = (cells: Cell[], curve: CtrCurve | null, homepage: string): string[] => {
    // Per query: totals, impressions by device, and clicks or impressions by page (for its top page).
    const byQuery = new Map<string, { c: number; i: number; ps: number; dev: Record<Device, number>; pages: Map<string, { c: number; i: number }> }>();
    for (const cell of cells) {
      if (!(cell.i > 0)) continue;
      let q = byQuery.get(cell.q);
      if (!q) {
        q = { c: 0, i: 0, ps: 0, dev: { desktop: 0, mobile: 0 }, pages: new Map() };
        byQuery.set(cell.q, q);
      }
      q.c += cell.c;
      q.i += cell.i;
      q.ps += cell.ps;
      q.dev[cell.dv] += cell.i;
      const pg = q.pages.get(cell.p) ?? { c: 0, i: 0 };
      pg.c += cell.c;
      pg.i += cell.i;
      q.pages.set(cell.p, pg);
    }
    const counts = new Map<string, number>();
    for (const [query, q] of [...byQuery.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (isBrand(query) || q.i === 0) continue;
      const top = [...q.pages.entries()].sort((a, b) => b[1].c - a[1].c || b[1].i - a[1].i || (a[0] < b[0] ? -1 : 1))[0];
      if (!top || top[0] !== homepage) continue;
      const ctr = q.c / q.i;
      const dv: Device = q.dev.desktop >= q.dev.mobile ? 'desktop' : 'mobile';
      const seg: Segment = `${dv}|nonbrand`;
      const expected = curve ? curve.f(Math.min(100, Math.max(1, q.ps / q.i)), seg) : null;
      const strong = expected !== null ? ctr / expected >= MIN_SUGGEST_RATIO : ctr >= FALLBACK_SUGGEST_CTR;
      if (!strong) continue;
      for (const w of new Set(words(query))) {
        if (w.length < MIN_TOKEN || GENERIC.has(w) || /^\d+$/.test(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= MIN_SUGGEST_QUERIES)
      .map(([w]) => w)
      .sort();
  };

  return { isBrand, tokens, suggestions };
}
