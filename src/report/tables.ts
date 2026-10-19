// Table cells shared by the HTML and Markdown reports: scorecard, site changes, ladder, ledger (6.5). Owner: WP-F.
//
// Plain text out; the renderers escape it. Dates are human dates ("24 Sep 2026") with no-break
// spaces inside, so a narrow table wraps between dates, never inside one.
import { DEFAULT_DELTA } from '../analyze/verdicts.js';
import { FIELD_TEXT } from '../analyze/site-change.js';
import { addDays, ptDate } from '../core/time.js';
import type { AnalysisOutput, PeriodEffect, PhaseResult, ReportContext, SiteChange, UpdateRow } from '../core/types.js';
import { FALLBACK_LAG_DAYS, retentionStart, subtractMonths } from '../sources/google/gsc-plan.js';
import { REAL_LABEL, realLabel, renderSentence } from './copy.js';
import { capitalise, eventName, fmtAbsPct, fmtDate, fmtInt, fmtPct } from './format.js';

const NBSP = ' ';
/** A human date that never breaks inside a table cell. */
export const dateCell = (d: string): string => fmtDate(d).replace(/ /g, NBSP);

function rangePct(ci: [number, number] | null | undefined): string {
  return ci ? `${fmtPct(ci[0])} to ${fmtPct(ci[1])}` : 'no range yet';
}

/**
 * Scorecard rows to show, newest first. Updates from before the Search Console history starts
 * can't be measured, so they are counted in one line (`older`) instead of filling the table.
 */
export function scorecardRows(out: AnalysisOutput): { shown: UpdateRow[]; older: number } {
  const sorted = [...out.scorecard].sort((a, b) => (a.begin < b.begin ? 1 : a.begin > b.begin ? -1 : a.eventId < b.eventId ? -1 : 1));
  const shown = sorted.filter((r) => r.status !== 'before_history');
  return { shown, older: sorted.length - shown.length };
}

/** The line under the scorecard for updates before the history starts, or null. */
export function olderUpdatesLine(older: number, o: { listed?: boolean } = {}): string | null {
  if (older <= 0) return null;
  const listed = o.listed === false ? '' : ' (listed in findings.json)';
  return `${fmtInt(older)} older Google ${older === 1 ? 'update' : 'updates'} happened before your Search Console history starts, so ${older === 1 ? "it can't" : "they can't"} be measured${listed}.`;
}

/**
 * A scorecard row's name. Status-page titles ("Serving was experiencing an issue") don't say what
 * they are, and curated reporting changes are whole sentences, so both get short names. The full
 * text stays in findings.json.
 */
export function updateName(row: Pick<UpdateRow, 'title' | 'kind'>): string {
  const name = eventName(row.title);
  if (row.kind === 'outage') {
    if (/outage/i.test(name)) return name;
    if (/serving/i.test(name)) return 'Google Search serving outage';
    if (/crawl/i.test(name)) return 'Google crawling outage';
    if (/index/i.test(name)) return 'Google indexing outage';
    return 'Google Search outage';
  }
  if (row.kind === 'data_anomaly') {
    if (/num\s*=\s*100|100 results/i.test(row.title)) return 'Reporting change: Google stopped showing 100 results per page';
    return /reporting/i.test(name) ? name : `Reporting change: ${name}`;
  }
  return name;
}

/** One metric cell: the change and its range, or why there is none (too few counts gets the counts, not a percent). */
function effectCell(e: PeriodEffect | null, metric: 'clicks' | 'impressions', unmeasured: string): string {
  if (!e) return unmeasured;
  if (e.reason === 'floors') return `Too few ${metric} (${fmtInt(e.pre)} before, ${fmtInt(e.post)} after)`;
  return `${fmtPct(e.tau)} (${rangePct(e.ci95)})`;
}

const excludesZero = (ci: [number, number] | null | undefined): boolean => !!ci && (ci[0] > 0 || ci[1] < 0);

export function scorecardCells(row: UpdateRow, out: AnalysisOutput): { name: string; dates: string; clicks: string; impressions: string; verdict: string; notes: string } {
  const f = out.findings.find((x) => x.id === row.findingId);
  const dates = row.end === row.begin ? dateCell(row.begin)
    : row.end === null ? `${dateCell(row.begin)}, still rolling out`
      : `${dateCell(row.begin)} to ${dateCell(row.end)}${row.endEstimated ? ' (end estimated)' : ''}`;
  const unmeasured = row.status === 'too_recent' ? 'not yet' : 'not measured';
  let verdict: string;
  if (row.status === 'too_recent') verdict = row.checkAgainOn ? `Too recent, check on ${dateCell(row.checkAgainOn)}` : 'Too recent to judge';
  else if (row.status === 'before_history') verdict = 'Before your history';
  else if (row.status === 'skipped_discover') verdict = 'Not measured (Discover only)';
  else verdict = f ? realLabel(f) : row.clicks ? realLabel(row.clicks) : REAL_LABEL.underpowered;
  const notes: string[] = [];
  if (row.competing.length) {
    const titles = row.competing.map((id) => updateName(out.scorecard.find((r) => r.eventId === id) ?? { title: id, kind: 'other_ranking' }));
    notes.push(`Overlaps ${titles.join(', ')}`);
  }
  const c = row.clicks;
  if (c && c.real === 'noise' && c.reason === 'noise_small') notes.push(`Small but real, under the ${fmtAbsPct(DEFAULT_DELTA.site)} we treat as worth acting on`);
  else if (c && c.reason !== 'floors' && c.real !== 'signal' && c.real !== 'unclear' && excludesZero(c.ci95)) notes.push("Didn't pass the check for testing many updates at once");
  if (row.status === 'partial' && row.window) notes.push('Partial window, still settling');
  if (row.checkAgainOn && row.status !== 'too_recent') notes.push(`Check again on ${fmtDate(row.checkAgainOn)}`);
  if (row.measurementOverlap) {
    notes.push(row.kind === 'data_anomaly' ? "Impressions before and after this change aren't comparable" : 'A reporting change overlaps, so impressions are not comparable');
  }
  if (row.siteChangesSeen > 0) notes.push(`${fmtInt(row.siteChangesSeen)} site change${row.siteChangesSeen === 1 ? '' : 's'} seen by Google around then`);
  return {
    name: updateName(row), dates, clicks: effectCell(row.clicks, 'clicks', unmeasured), impressions: effectCell(row.impressions, 'impressions', unmeasured),
    verdict, notes: notes.join('. '),
  };
}

const PAGES = (n: number): string => `${fmtInt(n)} page${n === 1 ? '' : 's'}`;

export function siteChangeCells(c: SiteChange, out: AnalysisOutput): { what: string; pages: string; deployed: string; seen: string; outcome: string } {
  const seen = c.touched.map((t) => t.googleSeen).filter((g): g is NonNullable<typeof g> => g !== null);
  const day = (i: string): string => {
    try {
      return dateCell(ptDate(i));
    } catch {
      return i;
    }
  };
  const seenText = seen.length
    ? `${day(seen.map((g) => g.from).sort()[0])} to ${day(seen.map((g) => g.to).sort()[seen.length - 1])} (${fmtInt(seen.length)} of ${fmtInt(c.touched.length)})`
    : 'Not recrawled yet';
  const impact = out.siteChangeImpacts.find((i) => i.siteChangeId === c.id);
  // A title or snippet change is measured on click rate against untouched pages: say so, never "fell 32%" as if it were clicks.
  const measure = impact?.outcome === 'ctr' ? 'click rate ' : impact?.outcome === 'impressions' ? 'impressions ' : '';
  const outcome = impact
    ? `${realLabel(impact)}${impact.tau !== null ? `, ${measure}${fmtPct(impact.tau)} (${rangePct(impact.ci95)})` : ''}`
    : 'Not measured yet';
  const field = FIELD_TEXT[c.field] ?? c.field;
  const where = /^(\/.*\/)\*$/.exec(c.templateKey);
  const what = c.source === 'annotation'
    ? `Your note: ${c.text ?? ''}`
    : `${capitalise(field)} changed on ${PAGES(c.touched.length)}${where ? ` under ${where[1]}` : c.templateKey === '/' ? ' (home page)' : ''}`;
  return { what, pages: fmtInt(c.touched.length), deployed: `${day(c.deployed.from)} to ${day(c.deployed.to)}`, seen: seenText, outcome };
}

/** The before_recording line, dated when the site's changes have been recorded since some day. */
export function beforeRecordingSentence(out: AnalysisOutput): string {
  const snapshots = out.siteChanges.filter((c) => c.source === 'snapshot').map((c) => c.deployed.from).sort();
  if (!snapshots.length) return renderSentence('before_recording', {});
  try {
    return renderSentence('before_recording', { since: ptDate(snapshots[0]) });
  } catch {
    return renderSentence('before_recording', {});
  }
}

/** Phase notes as one line: each note ends with a full stop. */
export function joinNotes(notes: string[]): string {
  return notes.filter(Boolean).map((n) => (/[.!?)]$/.test(n) ? n : `${n}.`)).join(' ');
}

export interface LadderRow { when: string; what: string; status: string }

/**
 * The first day of the month 17 months after a day's month: from then on Search Console has
 * deleted that day, so a saved history starting there goes past Google's limit.
 */
function passesLimitOn(first: string): string {
  return `${subtractMonths(`${first.slice(0, 7)}-01`, -17).slice(0, 7)}-01`;
}

export function ladder(out: AnalysisOutput, ctx: ReportContext): LadderRow[] {
  const serpOn = ctx.config.serp.provider === 'dataforseo';
  const facts = out.aio?.facts ?? [];
  // "Past Google's limit" means the oldest saved day has dropped out of Google's own retention,
  // not that the backfill was long: a first run already brings back about 490 days.
  const days = out.diagnostics.historyDays;
  const first = days > 0 ? addDays(out.dataThrough, 1 - days) : null;
  const googleFrom = retentionStart(addDays(out.dataThrough, FALLBACK_LAG_DAYS));
  const beyond = first !== null && first < googleFrom;
  const backfill = ctx.config.gsc.backfillMonths;
  return [
    {
      when: 'Tomorrow',
      what: 'A second snapshot of your pages, so changes you make from now on get a date.',
      status: out.siteChanges.some((c) => c.source === 'snapshot') ? 'Already true' : 'Not yet',
    },
    { when: 'Each day', what: "One more finished day of Search Console data, and Google's recrawl dates for your busiest pages.", status: 'Running' },
    {
      when: 'Week 1',
      what: 'A second AI Overview check of each search, enough to call it present or absent.',
      status: !serpOn && !facts.length ? 'Off (add a DataForSEO login)' : facts.some((x) => x.checks >= 2) ? 'Already true' : 'Not yet',
    },
    {
      when: 'Week 4',
      what: 'A full four weeks of recorded changes and checks, so before-and-after comparisons can start.',
      status: out.siteChangeImpacts.some((i) => i.tau !== null) || (out.aio?.estimates ?? []).some((e) => e.estimator === 'did' && e.tau !== null)
        ? 'Already true' : 'Not yet',
    },
    {
      when: backfill >= 16 ? 'Next month' : `Month ${Math.max(1, 17 - backfill)}`,
      what: 'Your saved history holds days Search Console has already deleted.',
      status: beyond ? 'Already true' : first ? `Not yet (from ${fmtDate(passesLimitOn(first))})` : 'Not yet',
    },
  ];
}

const PHASE_LABEL: Record<string, string> = {
  lock: 'Saved data lock', updates: 'Google updates', gsc: 'Search Console', index: 'Saved data', crawl: 'Your pages', inspect: 'Index checks',
  serp_collect: 'AI Overview results', analyze: 'Analysis', serp_post: 'AI Overview checks', report: 'Report', graph: 'Graph',
};
export function phaseLabel(name: string): string {
  return PHASE_LABEL[name] ?? name;
}
const STATUS_WORD: Record<PhaseResult['status'], string> = {
  ok: 'Done', skipped: 'Skipped', partial: 'Partly done', failed: 'Failed', deferred: 'Deferred',
};
export function statusWord(s: PhaseResult['status']): string {
  return STATUS_WORD[s] ?? s;
}

/** Ledger rows worth showing: the lock and the saved-data index only when they did not simply work. */
export function ledgerPhases(phases: PhaseResult[]): PhaseResult[] {
  return phases.filter((p) => !((p.name === 'lock' || p.name === 'index') && p.status === 'ok'));
}
