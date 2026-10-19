// Grouped and merged copy for the report's lists: one story told once (6.5). Owner: WP-F.
//
// select.ts decides what goes together; this file words it. Every number keeps its own label
// ("clicks", "click rate against untouched pages"), so merged stories never mix two measures.
import { diffDays } from '../core/time.js';
import type { AnalysisOutput, Finding } from '../core/types.js';
import { findingSentence, realLabel } from './copy.js';
import { unitDisplay } from './copy-parts.js';
import { fmtAbsPct, fmtCount, fmtDate, fmtInt, fmtPct, fmtSignedInt } from './format.js';
import type { ListEntry, UnitGroup } from './select.js';

/**
 * "1,615 fewer clicks than the 28 days before (-12%)." for a windowed click finding, with the size
 * range of a real change below the size we flag ("-9.4%, at least 7.2%, possibly 12%"), else ''.
 */
function windowedClicks(f: Finding): string {
  if (f.metric !== 'clicks' || f.effect.absolute === null || !f.windows) return '';
  const L = diffDays(f.windows.current[0], f.windows.current[1]) + 1;
  const lo = Number(f.slots.size_lo);
  const hi = Number(f.slots.size_hi);
  const size = Number.isFinite(lo) && Number.isFinite(hi) && f.slots.size_lo !== undefined
    ? `, at least ${fmtAbsPct(Math.min(Math.abs(lo), Math.abs(hi)))}, possibly ${fmtAbsPct(Math.max(Math.abs(lo), Math.abs(hi)))}` : '';
  const pct = f.effect.estimate !== null ? ` (${fmtPct(f.effect.estimate)}${size})` : '';
  return `${fmtInt(Math.abs(f.effect.absolute))} ${f.effect.absolute < 0 ? 'fewer' : 'more'} clicks than the ${L} days before${pct}.`;
}

/** The finding's sentence without the size clause (the merged item gives the size up front). */
function sentenceWithoutSize(f: Finding): string {
  if (f.slots.size_lo === undefined) return findingSentence(f);
  const { size_lo: _a, size_hi: _b, size_pct: _c, ...slots } = f.slots;
  return findingSentence({ ...f, slots });
}

/** One clause per other finding about the same unit, each number labelled. */
function clause(f: Finding): string {
  if ((f.kind === 'change_point') && f.effect.estimate !== null && f.date) {
    return `A step ${f.effect.estimate < 0 ? 'down' : 'up'} of about ${fmtAbsPct(f.effect.estimate)} in ${f.metric} from ${fmtDate(f.date)}.`;
  }
  if (f.kind === 'site_change_impact' && f.effect.estimate !== null) {
    const what = f.metric === 'ctr' ? 'click rate' : f.metric;
    const ci = f.effect.ci95 ? ` (range ${fmtPct(f.effect.ci95[0])} to ${fmtPct(f.effect.ci95[1])})` : '';
    return `The changed pages' ${what} moved ${fmtPct(f.effect.estimate)} against what similar untouched pages predict${ci}.`;
  }
  return windowedClicks(f);
}

/** The merged sentence for an "Also worth knowing" item: the lead's own numbers, its sentence, then the folded findings. */
export function alsoWorthSentence(g: UnitGroup): string {
  const lead = windowedClicks(g.lead);
  return [lead, lead ? sentenceWithoutSize(g.lead) : findingSentence(g.lead), ...g.others.map(clause)].filter(Boolean).join(' ');
}

const NOUN: Record<Finding['unit']['level'], [string, string]> = {
  site: ['part', 'parts'], template: ['section', 'sections'], page: ['page', 'pages'], query: ['search', 'searches'],
};

function noun(members: Finding[]): string {
  const levels = new Set(members.map((f) => f.unit.level));
  if (levels.size !== 1) return members.length === 1 ? 'item' : 'items';
  const [one, many] = NOUN[members[0].unit.level];
  return members.length === 1 ? one : many;
}

/** "biggest: a -107, b -86, c -78" by clicks. */
function biggest(members: Finding[]): string {
  const top = [...members]
    .filter((f) => f.effect.absolute !== null && f.metric === 'clicks')
    .sort((a, b) => Math.abs(b.effect.absolute as number) - Math.abs(a.effect.absolute as number) || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((f) => `${unitDisplay(f.unit)} ${fmtSignedInt(f.effect.absolute as number)}`);
  return top.length ? ` (biggest: ${top.join(', ')})` : '';
}

/** "from -13% to +6.6%" over the members' own estimates. */
function spread(members: Finding[]): string {
  const xs = members.map((f) => f.effect.estimate).filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return 'sizes vary';
  return xs[0] === xs[xs.length - 1] ? fmtPct(xs[0]) : `from ${fmtPct(xs[0])} to ${fmtPct(xs[xs.length - 1])}`;
}

/** The label and the one-line summary for a grouped list entry. */
export function groupSummary(e: Extract<ListEntry, { kind: 'group' }>, out: AnalysisOutput): { label: string; text: string } {
  const m = e.members;
  const n = m.length;
  const sum = m.reduce((t, f) => t + (f.metric === 'clicks' && f.effect.absolute !== null ? f.effect.absolute : 0), 0);
  const lostWord = sum < 0 ? 'lost' : 'gained';
  const label = realLabel(m[0]);
  switch (e.group) {
    case 'aio': {
      const did = out.aio?.estimates.find((x) => x.estimator === 'did');
      const site = did?.tau != null
        ? ` Site-wide, on searches like these, click rate fell about ${fmtAbsPct(did.tau)} more than on similar ones without an AI Overview` +
          `${did.ci95 ? ` (likely ${fmtAbsPct(Math.min(Math.abs(did.ci95[0]), Math.abs(did.ci95[1])))} to ${fmtAbsPct(Math.max(Math.abs(did.ci95[0]), Math.abs(did.ci95[1])))})` : ''}.`
        : '';
      return {
        label,
        text: `${fmtInt(n)} ${noun(m)} ${lostWord} ${fmtInt(Math.abs(sum))} clicks at the same position where Google now shows an AI Overview ` +
          `that doesn't cite you${biggest(m)}.${site}`,
      };
    }
    case 'site_change': {
      const change = out.siteChanges.find((c) => `site_change|${c.id}` === e.key);
      const what = change ? `the ${change.source === 'annotation' ? 'change you noted' : `${change.field} change`} on ${fmtDate(change.deployed.to.slice(0, 10))}` : 'the same site change';
      return { label, text: `${fmtInt(n)} ${noun(m)} ${lostWord} ${fmtInt(Math.abs(sum))} clicks after ${what}${biggest(m)}. See Your site changes.` };
    }
    case 'thin': {
      // Below the minimum data is "too few clicks"; a range too wide to call is not the same thing.
      if (m.every((f) => f.reason === 'floors')) {
        const perWeek = Math.max(0, ...m.map((f) => f.power?.perWeek ?? 0));
        const under = perWeek > 0 ? ` (at most about ${fmtCount(perWeek)} clicks a week each)` : '';
        return { label, text: `${fmtInt(n)} ${noun(m)} had too few clicks to judge${under}. That's normal for a site this size.` };
      }
      return { label, text: `${fmtInt(n)} ${noun(m)} moved (${spread(m)}), but not clearly enough to call either way yet.` };
    }
    case 'small': {
      const delta = typeof m[0].slots.delta === 'number' ? fmtAbsPct(m[0].slots.delta) : null;
      return {
        label,
        text: `${fmtInt(n)} ${noun(m)} changed a little, but really (${spread(m)})${biggest(m)}. Each is smaller than ` +
          `${delta ? `the ${delta}` : 'the size'} we treat as worth acting on, so keep an eye on them rather than act on them.`,
      };
    }
    case 'wobble':
      return { label, text: `${fmtInt(n)} ${noun(m)} moved within normal ups and downs (${spread(m)}). Nothing to act on.` };
    case 'impressions': {
      const [, tpl, month] = e.key.split('|');
      const when = fmtDate(`${month}-01`).replace(/^1 /, '');
      const where = tpl === 'other pages' ? 'other pages' : `pages under ${tpl.replace(/\*$/, '')}`;
      const up = m.filter((f) => (f.effect.estimate ?? 0) > 0).length;
      const dir = up === n ? 'rose' : up === 0 ? 'fell' : 'moved';
      return { label, text: `Impressions ${dir} on ${fmtInt(n)} ${where} in ${when}.` };
    }
  }
}
