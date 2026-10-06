// "Check it yourself" Search Console performance URLs (6.6). Owner: WP-F.
//
// The filter parameter syntax is not verified against Google's docs: Search Console ignores
// parameters it does not know, so a wrong filter degrades to the unfiltered report for the
// same property and dates. Phase 2 checks one link by hand and records the result.
import type { IsoDate } from '../core/types.js';

const BASE = 'https://search.google.com/search-console/performance/search-analytics';

function compact(d: IsoDate): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, '') : '';
}

export function gscLink(property: string, v: { page?: string; query?: string; from: IsoDate; to: IsoDate }): string {
  const parts = [`resource_id=${encodeURIComponent(property)}`];
  const start = compact(v.from);
  const end = compact(v.to);
  if (start && end) parts.push(`start_date=${start}`, `end_date=${end}`);
  if (v.page) parts.push(`page=!${encodeURIComponent(v.page)}`);
  if (v.query) parts.push(`query=!${encodeURIComponent(v.query)}`);
  return `${BASE}?${parts.join('&')}`;
}
