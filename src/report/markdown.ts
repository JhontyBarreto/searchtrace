// Markdown report, also used for the GitHub step summary (6.5). Owner: WP-F.
//
// Same sections and order as the HTML report, without charts. Every value from data goes
// through mdEscape(), so a query or page title cannot add links, HTML, mentions or table cells.
import { diffDays } from '../core/time.js';
import type { AnalysisOutput, Finding, ReportContext, Verdict } from '../core/types.js';
import {
  BADGE, CAUSE_LABEL, REAL_LABEL, REMAINDER_NOTE, answerSentences, displayGroups, findingFalsifier, findingSentence,
  renderSentence,
} from './copy.js';
import { mdEscape, safeHref } from './escape.js';
import { fmtAbsPct, fmtDate, fmtInt, fmtMoney, fmtSignedInt } from './format.js';
import { gscLink } from './gsc-links.js';
import {
  TABLE_CAP, beforeRecordingSentence, joinNotes, ladder, olderUpdatesLine, phaseLabel, scorecardCells, scorecardRows, selectFindings,
  siteChangeCells, statusWord, whyText,
} from './html.js';

const LABEL_ORDER: Verdict[] = ['signal', 'unclear', 'underpowered', 'noise'];

function link(url: string | null, text: string): string {
  const href = safeHref(url);
  // The href is our own https URL; parentheses and spaces are percent-encoded so it cannot end early.
  return href ? `[${mdEscape(text)}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : mdEscape(text);
}

function findingLine(f: Finding, property: string): string {
  const check = f.verify ? ` ${link(gscLink(property, f.verify), 'Check it yourself')}` : '';
  const why = whyText(f);
  const label = f.reason === 'fact' ? `**${BADGE.EXTRACTED}**` : `**${mdEscape(REAL_LABEL[f.real])}**${why ? ` · ${mdEscape(why)} ·` : ''}`;
  return `- ${label} **${mdEscape(f.unit.label)}**: ` +
    `${mdEscape(findingSentence(f))}${check}`;
}

function findingLines(items: Finding[], property: string, empty: string): string[] {
  if (!items.length) return empty ? [`_${mdEscape(empty)}_`] : [];
  const lines = items.slice(0, TABLE_CAP).map((f) => findingLine(f, property));
  if (items.length > TABLE_CAP) lines.push(`- and ${fmtInt(items.length - TABLE_CAP)} more in findings.json`);
  return lines;
}

function table(head: string[], rows: string[][], total: number, what: string): string[] {
  const out = [`| ${head.map(mdEscape).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows.slice(0, TABLE_CAP)) out.push(`| ${r.map(mdEscape).join(' | ')} |`);
  if (total > TABLE_CAP) out.push(`| and ${fmtInt(total - TABLE_CAP)} more ${mdEscape(what)} in findings.json |${' |'.repeat(head.length - 1)}`);
  return out;
}

export function renderMarkdown(out: AnalysisOutput, ctx: ReportContext): string {
  const sel = selectFindings(out);
  const answer = answerSentences(out);
  const p = out.property;
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  const md: string[] = [];

  md.push('# Why did your Google traffic change?', '');
  md.push(`${mdEscape(p)} · data runs to ${fmtDate(out.dataThrough)} (Pacific Time) · last ${L} days vs the ${L} before`, '');
  if (ctx.demo) md.push('> This is a demo on a made-up site (Pipewell Plumbing). None of these numbers are real.', '');

  md.push('## The answer', '', mdEscape(answer.sentence), '');
  if (answer.verdict) md.push(mdEscape(answer.verdict), '');
  if (!out.headline.boring && sel.head) {
    md.push(`**Is it real?** ${mdEscape(REAL_LABEL[sel.head.real])} · **Why?** ${mdEscape(CAUSE_LABEL[sel.head.cause ?? 'unknown'])} ` +
      `(${mdEscape(BADGE[sel.head.causeConfidence])})`, '');
    md.push(`_${mdEscape(findingFalsifier(sel.head))}_`, '');
  }
  if (sel.alsoWorth.length) md.push('**Also worth knowing**', '', ...findingLines(sel.alsoWorth, p, ''), '');

  md.push('## Where the clicks went', '');
  const site = out.scopes.find((x) => x.unit.level === 'site');
  if (site) {
    const rows = displayGroups(site.bars, site.ci95)
      .map((r) => [r.label, fmtSignedInt(r.value), r.ci ? `${fmtSignedInt(r.ci[0])} to ${fmtSignedInt(r.ci[1])}` : 'no range yet']);
    rows.push(['Total', fmtSignedInt(site.deltaClicks), site.ci95?.total ? `${fmtSignedInt(site.ci95.total[0])} to ${fmtSignedInt(site.ci95.total[1])}` : 'no range yet']);
    md.push(...table(['Part', 'Clicks', '95% range'], rows, rows.length, 'rows'), '', `_${mdEscape(REMAINDER_NOTE)}_`, '');
  } else {
    md.push('_No click breakdown yet._', '');
  }
  const rec = out.diagnostics.reconciliation;
  md.push(mdEscape(sel.coverage), '', `Page totals ${fmtInt(rec.byPageClicks)} clicks, property total ${fmtInt(rec.byPropertyClicks)}.`, '');

  md.push('## Timeline', '');
  md.push(out.timeline.sealed.length
    ? `The chart is in the HTML report. ${fmtInt(out.timeline.sealed.length)} sealed days are stored.`
    : '_Not enough history to draw yet._', '');
  if (sel.freshness) md.push(mdEscape(sel.freshness), '');

  md.push('## Google update scorecard', '');
  const { shown: rows, older } = scorecardRows(out);
  if (rows.length) {
    md.push(...table(['Update', 'Dates', 'Clicks change (range)', 'Impressions change (range)', 'Verdict', 'Notes'], rows.map((r) => {
      const c = scorecardCells(r, out);
      return [c.name, c.dates, c.clicks, c.impressions, c.verdict, c.notes];
    }), rows.length, 'updates'), '');
  } else {
    md.push('_No Google updates overlap your data yet._', '');
  }
  const olderLine = olderUpdatesLine(older);
  if (olderLine) md.push(`_${mdEscape(olderLine)}_`, '');

  md.push('## Pages and sections that moved', '', '### Sections of your site', '', ...findingLines(sel.templates, p, 'No sections to compare yet.'), '');
  md.push('### Pages', '', ...findingLines(sel.pages, p, 'No pages to compare yet.'), '');

  md.push('## Searches that moved', '', mdEscape(sel.coverage), '', ...findingLines(sel.queries, p, 'No searches to compare yet.'), '');
  if (sel.aioEffects.length) md.push('### AI Overviews', '', ...findingLines(sel.aioEffects, p, ''), '');
  const facts = out.aio?.facts ?? [];
  if (facts.length) {
    md.push('### AI Overview checks', '', ...table(['Search', 'Device', 'AI Overview shown', 'Cites you?', 'Top cited sites', 'Title rewritten?'],
      facts.map((x) => [x.keyword, x.device, `${x.aioChecks} of ${x.checks}`, x.aioChecks > 0 ? (x.cited ? 'Yes' : 'No') : 'No AI Overview',
        x.topDomains.slice(0, 3).join(', ') || 'none', x.titleRewritten === null ? "Can't tell" : x.titleRewritten ? 'Yes' : 'No']), facts.length, 'searches'), '');
  }

  md.push('## Your site changes', '');
  if (out.siteChanges.length) {
    md.push(...table(['What changed', 'Pages', 'When (deployed)', 'Google saw it', 'Outcome'], out.siteChanges.map((c) => {
      const x = siteChangeCells(c, out);
      return [x.what, x.pages, x.deployed, x.seen, x.outcome];
    }), out.siteChanges.length, 'changes'), '');
    md.push(...findingLines(sel.siteChangeFindings, p, ''), '');
  } else {
    md.push(mdEscape(renderSentence('no_site_changes', {})), '');
  }
  if (sel.beforeRecording) md.push(mdEscape(beforeRecordingSentence(out)), '');

  md.push("## What we checked and what we couldn't", '');
  let any = false;
  for (const v of LABEL_ORDER) {
    const xs = sel.rest.get(v) ?? [];
    if (!xs.length) continue;
    any = true;
    md.push(`### ${mdEscape(REAL_LABEL[v])}`, '', ...findingLines(xs, p, ''), '');
  }
  if (sel.facts.length) {
    any = true;
    md.push(`### ${BADGE.EXTRACTED} facts`, '', ...findingLines(sel.facts, p, ''), '');
  }
  if (!any) md.push('_Everything we found is shown above._', '');

  md.push('## What gets smarter next', '', ...table(['When', 'What', 'Status'], ladder(out, ctx).map((r) => [r.when, r.what, r.status]), 5, 'rows'), '');

  md.push('## Run ledger', '');
  const run = ctx.run;
  if (run && run.phases.length) {
    md.push(...table(['Step', 'Status', 'Requests', 'Cost', 'Notes'], run.phases.map((ph) => [
      phaseLabel(ph.name), statusWord(ph.status), fmtInt(Object.values(ph.requests).reduce((a, b) => a + b, 0)), fmtMoney(ph.costUsd),
      joinNotes(ph.notes),
    ]), run.phases.length, 'steps'), '', `Cost this run: ${fmtMoney(run.spendUsd)}.`, '');
  } else {
    md.push('_This report was rebuilt from saved data, so no collection ran._', '');
  }
  if (sel.freshness) md.push(mdEscape(sel.freshness), '');
  md.push(`searchtrace ${mdEscape(ctx.toolVersion)} · data through ${out.dataThrough} · searches named by Google: ${fmtAbsPct(out.diagnostics.namedClickShare)} of clicks`, '');
  return `${md.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Re-exported for the step summary: the headline sentence with its sign, for commit messages and logs. */
export function headlineLine(out: AnalysisOutput): string {
  const a = answerSentences(out);
  return a.verdict ? `${a.sentence} ${a.verdict}` : a.sentence;
}

