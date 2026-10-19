// Shared finding selections for the HTML report, the Markdown report and findings.json (6.5). Owner: WP-F.
//
// Pure filtering and grouping: no copy here (copy.ts and copy-parts.ts word what is selected), so
// every output picks the same findings in the same order.
import type { AnalysisOutput, Finding } from '../core/types.js';

/** One unit's story: its strongest finding and the others about the same unit, folded under it. */
export interface UnitGroup { lead: Finding; others: Finding[] }

const NOT_ALSO = new Set<Finding['kind']>(['update_impact', 'aio_fact', 'notice', 'index_transition', 'headline']);
/** An impressions-only page change point needs this many impressions a day after the change to stand on its own. */
const IMPR_FLOOR = 5;
/** Three or more findings of one kind of story become one summary line with the list folded under it. */
export const GROUP_MIN = 3;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unitKey = (f: Finding): string => `${f.unit.level}|${f.unit.key}|${f.unit.device ?? ''}`;

/** Dated findings must touch the two compared windows; windowed ones (waterfall, AI Overviews) do by construction. */
function inSpan(f: Finding, out: AnalysisOutput): boolean {
  const from = out.windows.baseline[0];
  const to = out.windows.current[1];
  if (f.dateWindow) return f.dateWindow[0] <= to && f.dateWindow[1] >= from;
  if (f.date) return f.date >= from && f.date <= to;
  return f.windows !== null;
}

/** Clicks first; an impressions-only change point on a page only when it reached a real level. */
function material(f: Finding): boolean {
  if (f.kind !== 'change_point' || f.metric === 'clicks') return true;
  if (f.unit.level === 'site' || f.unit.level === 'template') return true;
  const to = Number(f.slots.to);
  return Number.isFinite(to) && to >= IMPR_FLOOR;
}

const clicksOf = (f: Finding): number => (f.metric === 'clicks' && f.effect.absolute !== null ? Math.abs(f.effect.absolute) : 0);

/**
 * "Also worth knowing": real changes about the compared period, at most one item per unit (a
 * section's 28-day change, its change point and its site-change impact are one story), ranked by
 * clicks and then by recency, never by hash id. Nothing qualifies, nothing is shown: older signals
 * already live under "What we checked".
 */
export function alsoWorthGroups(out: AnalysisOutput, max = 3): UnitGroup[] {
  const head = out.headline.findingId;
  // Sections, pages and searches first: a whole-site or brand / non-brand series mostly restates the headline.
  const broad = (f: Finding): number => Number(f.unit.level === 'site' || f.unit.key.startsWith('class:'));
  const eligible = out.findings
    .filter((f) => f.id !== head && f.real === 'signal' && f.reason !== 'fact' && !NOT_ALSO.has(f.kind) && inSpan(f, out) && material(f))
    .sort((a, b) => broad(a) - broad(b) || clicksOf(b) - clicksOf(a) || Number(b.metric === 'clicks') - Number(a.metric === 'clicks') ||
      cmp(b.date ?? out.dataThrough, a.date ?? out.dataThrough) || cmp(a.id, b.id));
  const groups = new Map<string, UnitGroup>();
  for (const f of eligible) {
    const g = groups.get(unitKey(f));
    if (g) g.others.push(f);
    else groups.set(unitKey(f), { lead: f, others: [] });
  }
  // The unit's own 28-day finding leads when there is one: it carries the cause ("Why: Your change"),
  // and the change point and the site-change impact fold under it as labelled clauses.
  for (const g of groups.values()) {
    const own = g.others.find((f) => f.kind === 'waterfall');
    if (own && g.lead.kind !== 'waterfall') {
      g.others = [g.lead, ...g.others.filter((f) => f !== own)];
      g.lead = own;
    }
  }
  return [...groups.values()].slice(0, max);
}

export type GroupKind = 'aio' | 'site_change' | 'thin' | 'small' | 'wobble' | 'impressions';

/** A list entry: one finding, or a story that several findings tell, summarised once. */
export type ListEntry = { kind: 'one'; f: Finding } | { kind: 'group'; group: GroupKind; key: string; members: Finding[] };

/**
 * Groups a section's findings so one story is told once (6.5): searches losing clicks to the same
 * AI Overview estimate, pages and searches moved by the same site change, everything too thin to
 * judge, small real changes, ordinary wobble, and page impressions moving in one section in one month. A group needs GROUP_MIN members;
 * each member stays available (with its own "Show the maths") under the summary.
 */
export function groupList(items: Finding[], out: AnalysisOutput): ListEntry[] {
  const keyOf = (f: Finding): string | null => {
    if (f.cause === 'ai_overview' && f.template === 'aio_not_cited' && f.unit.level !== 'site') return 'aio|';
    if (f.template === 'real_site_change' && f.related.siteChanges.length) return `site_change|${f.related.siteChanges[0]}`;
    if (f.kind === 'waterfall' && f.real === 'underpowered' && f.reason !== 'fact') return 'thin|';
    if (f.kind === 'waterfall' && f.real === 'noise' && f.reason === 'noise_small') return 'small|';
    if (f.kind === 'waterfall' && f.real === 'noise' && f.reason === 'noise_bounded') return 'wobble|';
    if (f.kind === 'change_point' && f.metric === 'impressions' && f.unit.level === 'page' && f.date) {
      return `impressions|${out.templates[f.unit.key] ?? 'other pages'}|${f.date.slice(0, 7)}`;
    }
    return null;
  };
  const byKey = new Map<string, Finding[]>();
  for (const f of items) {
    const k = keyOf(f);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const out2: ListEntry[] = [];
  const placed = new Set<string>();
  for (const f of items) {
    const k = keyOf(f);
    const members = k ? byKey.get(k) ?? [] : [];
    if (k && members.length >= GROUP_MIN) {
      if (!placed.has(k)) {
        placed.add(k);
        out2.push({ kind: 'group', group: k.split('|')[0] as GroupKind, key: k, members });
      }
      continue;
    }
    out2.push({ kind: 'one', f });
  }
  return out2;
}
