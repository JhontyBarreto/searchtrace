// Waterfall display groups and the notes around them (5.5.5, 6.2). Owner: WP-F.
//
// Split from copy.ts to keep files short; copy.ts re-exports everything here. The same copy rules
// apply: plain words, no statistics jargon, no long dashes. Output is plain text.
import type { AnalysisOutput, AnalysisUnit } from '../core/types.js';
import { fmtAbsPct, fmtInt } from './format.js';

/**
 * Waterfall display groups (5.5.5), in plain words with direction. The AI Overview row is the
 * position bump on searches that newly cite you (not counted as ranking), never the loss from AI
 * Overviews that don't cite you: that sits inside "Same position" and is sized separately.
 * Labels stay under 28 characters for the terminal and the chart's label column.
 */
export type DisplayGroup = 'demand' | 'ranking' | 'samePos' | 'aioCitation' | 'churn';
export const GROUP_LABEL: Record<DisplayGroup, string> = {
  demand: 'More or fewer searches',
  ranking: 'Ranking moved',
  samePos: 'Same position, fewer clicks',
  aioCitation: 'Newly cited in AI Overview',
  churn: 'Started or stopped showing',
};
const SAME_POS_UP = 'Same position, more clicks';

/** The note about the searches Google doesn't name, with their share of clicks. */
export function remainderNote(hidden: number): string {
  return `Google doesn't name the searches behind ${fmtAbsPct(hidden)} of your clicks, for privacy. Their clicks are already inside ` +
    "the numbers above; we just can't say which search they came from.";
}
/** The note under a part that is mostly searches Google doesn't name (5.5.3). */
export const HIDDEN_PART_NOTE = "Possible: most of this part is searches Google doesn't name, whose average position mixes different searches, so it is rough.";

/** One waterfall display group with its value and 95% range, when known. */
export interface GroupRow { group: DisplayGroup; label: string; value: number; ci: [number, number] | null }

type CiMap = Partial<Record<string, [number, number]>> | null | undefined;

/** The five display groups of a set of bars (5.5.5): ranking = rank + visibility, churn = appeared + disappeared. */
export function displayGroups(
  bars: { demand: number; visibility: number; rank: number; samePos: number; appeared: number; disappeared: number; aioCitation: number },
  ci: CiMap,
): GroupRow[] {
  const c = (ci ?? {}) as Record<string, [number, number] | undefined>;
  const pick = (...keys: (string | false)[]): [number, number] | null => {
    for (const k of keys) if (k && Array.isArray(c[k]) && c[k]!.length === 2) return c[k]!;
    return null;
  };
  const rows: GroupRow[] = [
    { group: 'demand', label: GROUP_LABEL.demand, value: bars.demand, ci: pick('demand') },
    { group: 'ranking', label: GROUP_LABEL.ranking, value: bars.rank + bars.visibility, ci: pick('ranking', bars.visibility === 0 && 'rank') },
    { group: 'samePos', label: bars.samePos > 0 ? SAME_POS_UP : GROUP_LABEL.samePos, value: bars.samePos, ci: pick('samePos') },
    { group: 'aioCitation', label: GROUP_LABEL.aioCitation, value: bars.aioCitation, ci: pick('aioCitation') },
    {
      group: 'churn', label: GROUP_LABEL.churn, value: bars.appeared + bars.disappeared,
      ci: pick('churn', bars.disappeared === 0 && 'appeared', bars.appeared === 0 && 'disappeared'),
    },
  ];
  return rows;
}

/**
 * A structural zero (no unit qualified for this part): "+0 (+0 to +0)" would read as a measured
 * zero. Judged on whole clicks, as shown, so a part of 0.004 with a range of 0.001 to 0.007 is hidden too.
 */
export function isEmptyRow(g: GroupRow): boolean {
  const zero = (x: number): boolean => Math.round(x) === 0;
  return zero(g.value) && (!g.ci || (zero(g.ci[0]) && zero(g.ci[1])));
}

/** The display groups worth showing: every part except structural zeros. Hidden rows are zero, so the rest still add up. */
export function shownGroups(bars: Parameters<typeof displayGroups>[0], ci: CiMap): GroupRow[] {
  return displayGroups(bars, ci).filter((g) => !isEmptyRow(g));
}

/**
 * The separately estimated AI Overview loss under "Same position" (5.11.4), only when the
 * before-and-after estimate is real and the site lost clicks at the same position. Data-driven:
 * it quotes the estimate's own clicks and range, never "most".
 */
export function aioBridgeSentence(out: AnalysisOutput): string | null {
  const did = out.aio?.estimates.find((e) => e.estimator === 'did');
  const site = out.scopes.find((x) => x.unit.level === 'site');
  if (!did || did.real !== 'signal' || !(did.missingClicks && did.missingClicks > 0) || !site || !(site.bars.samePos < 0)) return null;
  const range = did.missingCi95 ? ` (likely ${fmtInt(did.missingCi95[0])} to ${fmtInt(did.missingCi95[1])})` : '';
  return `About ${fmtInt(did.missingClicks)} of the clicks lost at the same position${range} were on searches where an AI Overview ` +
    "now shows and doesn't cite you, estimated separately and likely understated. See AI Overviews below.";
}

/** A unit's name for a list item or a heading: "Pages under /blog/", "Home page", "/pricing". */
export function unitDisplay(unit: Pick<AnalysisUnit, 'level' | 'key' | 'label'>): string {
  if (unit.level === 'template') {
    if (unit.key === '/') return 'Home page (with its ?query variants)';
    if (unit.key === 'other pages') return 'Other pages (small sections)';
    const tpl = /^(\/.*\/)\*$/.exec(unit.key);
    if (tpl) return `Pages under ${tpl[1]}`;
    return unit.label;
  }
  if (unit.level === 'page' && unit.label === '/') return 'Home page';
  return unit.label;
}
