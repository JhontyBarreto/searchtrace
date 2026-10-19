// "Check it yourself" Search Console performance URLs (6.6). Owner: WP-F.
//
// The filter parameter syntax is not verified against Google's docs: Search Console ignores
// parameters it does not know, so a wrong filter degrades to the unfiltered report for the
// same property and dates. Exact filters use "!" (page=!url, query=!text) and "contains" filters
// use "*" (page=*%2Fblog%2F); this prefix convention is widely seen but still needs one link of
// each kind checked by hand in a signed-in Search Console before it is relied on.
//
// When a link can't filter to exactly what a finding is about (a section with a wildcard in the
// middle, "other pages", brand and non-brand searches, one device), the link carries no filter it
// can't honour and comes with a note saying how to filter by hand, so a reader who checks sees
// the same scope the report measured instead of concluding the tool is wrong.
import type { Finding, IsoDate } from '../core/types.js';

const BASE = 'https://search.google.com/search-console/performance/search-analytics';

function compact(d: IsoDate): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, '') : '';
}

export function gscLink(property: string, v: { page?: string; query?: string; from: IsoDate; to: IsoDate }, o: { pageContains?: string } = {}): string {
  const parts = [`resource_id=${encodeURIComponent(property)}`];
  const start = compact(v.from);
  const end = compact(v.to);
  if (start && end) parts.push(`start_date=${start}`, `end_date=${end}`);
  if (v.page) parts.push(`page=!${encodeURIComponent(v.page)}`);
  else if (o.pageContains) parts.push(`page=*${encodeURIComponent(o.pageContains)}`);
  if (v.query) parts.push(`query=!${encodeURIComponent(v.query)}`);
  return `${BASE}?${parts.join('&')}`;
}

/** The link for a finding and, when it can't filter exactly, a note on what it shows and how to filter by hand. */
export function verifyLink(property: string, f: Pick<Finding, 'verify' | 'unit'>, brandTokens: string[] = []): { url: string; note: string | null } | null {
  if (!f.verify) return null;
  const notes: string[] = [];
  let pageContains: string | undefined;
  if (f.unit.level === 'template' && !f.verify.page) {
    // A literal prefix then a single trailing "/*" can be a "URLs containing" filter (it can also match
    // the section's index page and other hosts on a domain property, so it is approximate).
    const m = /^(\/[^*]*\/)\*$/.exec(f.unit.key);
    if (m) {
      pageContains = m[1];
      notes.push(`approximate: Search Console filters URLs containing "${m[1]}"`);
    } else {
      notes.push(`Search Console shows the whole site; filter Pages to ${f.unit.label} by hand`);
    }
  }
  if (f.unit.level === 'query' && f.unit.key.startsWith('class:')) {
    const brand = f.unit.key === 'class:brand';
    const words = brandTokens.filter(Boolean);
    const how = words.length === 1 ? `Queries ${brand ? 'containing' : 'not containing'} "${words[0]}"`
      : words.length > 1 ? `Queries with a custom (regex) filter ${brand ? 'matching' : 'not matching'} ${words.join('|')}`
        : `Queries by ${brand ? 'containing' : 'not containing'} your business name`;
    notes.push(`Search Console shows every search; filter ${how}, which is close: we also count misspellings and spacing`);
  }
  if (f.unit.device) notes.push(`Search Console shows all devices; pick ${f.unit.device} under Devices`);
  return { url: gscLink(property, f.verify, { pageContains }), note: notes.length ? notes.join('; ') : null };
}
