// Markdown report, also used for the GitHub step summary (6.5). Owner: WP-F.
//
// Same sections and order as the HTML report, without charts. Every value from data goes
// through mdEscape(), so a query or page title cannot add links, HTML, autolinks, mentions or
// table cells. Commands the copy marks as `code` become code spans (built from fixed text plus
// slots that can't hold a backtick).
import { diffDays } from '../core/time.js';
import type { AnalysisOutput, Finding, ReportContext } from '../core/types.js';
import {
  BADGE, CAUSE_LABEL, HIDDEN_PART_NOTE, aioBridgeSentence, answerSentences, findingFalsifier, findingSentence, realLabel, remainderNote,
  renderSentence, unitDisplay, whyText,
} from './copy.js';
import { mdEscape, safeHref } from './escape.js';
import { capitalise, fmtAbsPct, fmtDate, fmtInt, fmtMoney } from './format.js';
import { verifyLink } from './gsc-links.js';
import {
  REST_ORDER, TABLE_CAP, citedSites, propertyDisplay, reconciledSentence, reconciliationLine, selectFindings, waterfallRows, type ReportSelections,
} from './html.js';
import { groupList, type ListEntry } from './select.js';
import { alsoWorthSentence, groupSummary } from './stories.js';
import {
  beforeRecordingSentence, joinNotes, ladder, ledgerPhases, olderUpdatesLine, phaseLabel, scorecardCells, scorecardRows, siteChangeCells, statusWord,
} from './tables.js';

function link(url: string | null, text: string): string {
  const href = safeHref(url);
  // The href is our own https URL; parentheses and spaces are percent-encoded so it cannot end early.
  return href ? `[${mdEscape(text)}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : mdEscape(text);
}

/**
 * Escaped text with the copy's command spans (`npx -y ... `) kept as Markdown code spans. Only
 * spans that start with the CLI are kept: backticks typed into a query or a note stay escaped.
 */
export function mdText(text: string): string {
  return text.split(/(`npx -y [^`\n]+`)/g).map((part) => (/^`npx -y [^`\n]+`$/.test(part) ? part : mdEscape(part))).join('');
}

function checkLink(f: Finding, out: AnalysisOutput): string {
  const v = verifyLink(out.property, f, out.diagnostics.brandTokens);
  if (!v) return '';
  return ` ${link(v.url, 'Check it yourself')}${v.note ? ` _(${mdEscape(v.note)})_` : ''}`;
}

function labelMd(f: Finding): string {
  if (f.reason === 'fact') return `**${BADGE.EXTRACTED}**`;
  const why = whyText(f);
  return `**${mdEscape(realLabel(f))}**${why ? ` · ${mdEscape(why)} ·` : ''}`;
}

function findingLine(f: Finding, out: AnalysisOutput, sel?: ReportSelections, indent = ''): string {
  const cp = sel?.reconciled.get(f.id);
  if (cp) return `${indent}- ${labelMd(cp)} **${mdEscape(unitDisplay(f.unit))}**: ${mdText(reconciledSentence(f, cp, out))}${checkLink(cp, out)}`;
  return `${indent}- ${labelMd(f)} **${mdEscape(unitDisplay(f.unit))}**: ${mdText(findingSentence(f))}${checkLink(f, out)}`;
}

function entryLines(e: ListEntry, out: AnalysisOutput, sel?: ReportSelections): string[] {
  if (e.kind === 'one') return [findingLine(e.f, out, sel)];
  const { label, text } = groupSummary(e, out);
  const lines = [`- **${mdEscape(label)}** ${mdEscape(text)}`];
  for (const f of e.members.slice(0, TABLE_CAP)) lines.push(findingLine(f, out, sel, '  '));
  if (e.members.length > TABLE_CAP) lines.push(`  - and ${fmtInt(e.members.length - TABLE_CAP)} more in findings.json`);
  return lines;
}

function findingLines(items: Finding[], out: AnalysisOutput, empty: string, sel?: ReportSelections): string[] {
  if (!items.length) return empty ? [`_${mdEscape(empty)}_`] : [];
  const entries = groupList(items, out);
  const lines = entries.slice(0, TABLE_CAP).flatMap((e) => entryLines(e, out, sel));
  if (entries.length > TABLE_CAP) lines.push(`- and ${fmtInt(entries.length - TABLE_CAP)} more in findings.json`);
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
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  const md: string[] = [];

  md.push('# Why did your Google traffic change?', '');
  md.push(`${mdEscape(propertyDisplay(out.property))} · data runs to ${fmtDate(out.dataThrough)} (Pacific Time) · last ${L} days vs the ${L} before`, '');
  if (ctx.demo) md.push('> This is a demo on a made-up site (Pipewell Plumbing). None of these numbers are real.', '');

  md.push('## The answer', '', mdEscape(answer.sentence), '');
  if (answer.verdict) md.push(mdText(answer.verdict), '');
  if (!out.headline.boring && sel.head) {
    const why = whyText(sel.head);
    const cause = why && sel.head.cause ? ` · **Why?** ${mdEscape(CAUSE_LABEL[sel.head.cause])} (${mdEscape(BADGE[sel.head.causeConfidence])})` : '';
    md.push(`**Is it real?** ${mdEscape(realLabel(sel.head))}${cause}`, '');
    md.push(`_${mdText(findingFalsifier(sel.head))}_`, '');
  }
  if (sel.alsoWorth.length) {
    md.push('**Also worth knowing**', '');
    for (const g of sel.alsoWorth) md.push(`- ${labelMd(g.lead)} **${mdEscape(unitDisplay(g.lead.unit))}**: ${mdText(alsoWorthSentence(g))}${checkLink(g.lead, out)}`);
    md.push('');
  }

  md.push('## Where the clicks went', '');
  const wf = waterfallRows(out, sel.head);
  if (wf) {
    md.push(...table(['Part', 'Clicks', '95% range'], wf.rows, wf.rows.length, 'rows'), '');
    md.push("_The parts' ranges show how sure we are of the split given these two periods; the total's range is the same one the answer uses._", '');
    const bridge = aioBridgeSentence(out);
    if (bridge) md.push(mdEscape(bridge), '');
    if (wf.rough) md.push(`_${mdEscape(HIDDEN_PART_NOTE)}_`, '');
    if (wf.totalNote) md.push(`_${mdEscape(wf.totalNote)}_`, '');
    md.push(`_${mdEscape(remainderNote(1 - out.diagnostics.namedClickShare))}_`, '');
  } else {
    md.push('_No click breakdown yet._', '');
  }
  md.push(mdEscape(reconciliationLine(out)), '');

  md.push('## Timeline', '');
  md.push(out.timeline.sealed.length
    ? `The chart is in the HTML report. ${fmtInt(out.timeline.sealed.length)} finished days are stored.`
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

  md.push('## Pages and sections that moved', '', '### Sections of your site', '', ...findingLines(sel.templates, out, 'No sections to compare yet.', sel), '');
  md.push('### Pages', '');
  for (const f of sel.appearances) md.push(mdEscape(findingSentence(f)), '');
  md.push(...findingLines(sel.pages, out, sel.appearances.length ? '' : 'No pages to compare yet.', sel), '');

  md.push('## Searches that moved', '', mdEscape(sel.coverage), '', ...findingLines(sel.queries, out, 'No searches to compare yet.', sel), '');
  if (sel.aioEffects.length) md.push('### AI Overviews', '', ...findingLines(sel.aioEffects, out, '', sel), '');
  const facts = out.aio?.facts ?? [];
  if (facts.length) {
    md.push('### AI Overview checks', '', ...table(['Search', 'Device', 'Shown in', 'Cites you?', 'Other sites it cites', 'Google changed your title?'],
      facts.map((x) => [x.keyword, capitalise(x.device), `${x.aioChecks} of ${x.checks} ${x.checks === 1 ? 'check' : 'checks'}`,
        x.aioChecks > 0 ? (x.cited ? 'Yes' : 'No') : 'No AI Overview', citedSites(x.topDomains),
        x.titleRewritten === null ? "Can't tell" : x.titleRewritten ? 'Yes' : 'No']), facts.length, 'searches'), '');
  }

  md.push('## Your site changes', '');
  if (out.siteChanges.length) {
    md.push(...table(['What changed', 'Pages', 'When (deployed)', 'Google saw it', 'Outcome'], out.siteChanges.map((c) => {
      const x = siteChangeCells(c, out);
      return [x.what, x.pages, x.deployed, x.seen, x.outcome];
    }), out.siteChanges.length, 'changes'), '');
    md.push(...findingLines(sel.siteChangeFindings, out, '', sel), '');
  } else {
    md.push(mdEscape(renderSentence('no_site_changes', {})), '');
  }
  if (sel.beforeRecording) md.push(mdText(beforeRecordingSentence(out)), '');

  md.push("## What we checked and what we couldn't", '');
  let any = false;
  for (const label of REST_ORDER) {
    const xs = sel.rest.get(label) ?? [];
    if (!xs.length) continue;
    any = true;
    md.push(`### ${mdEscape(label)}`, '', ...findingLines(xs, out, '', sel), '');
  }
  if (sel.facts.length) {
    any = true;
    md.push(`### ${BADGE.EXTRACTED} facts`, '', ...findingLines(sel.facts, out, '', sel), '');
  }
  if (!any) md.push('_Everything we found is shown above._', '');

  md.push('## What gets smarter next', '', ...table(['When', 'What', 'Status'], ladder(out, ctx).map((r) => [r.when, r.what, r.status]), 5, 'rows'), '');

  md.push('## What this run did and cost', '');
  const run = ctx.run;
  if (run && run.phases.length) {
    const phases = ledgerPhases(run.phases);
    md.push(...table(['Step', 'Status', 'Requests', 'Cost', 'Notes'], phases.map((ph) => [
      phaseLabel(ph.name), statusWord(ph.status), fmtInt(Object.values(ph.requests).reduce((a, b) => a + b, 0)), fmtMoney(ph.costUsd),
      joinNotes(ph.notes),
    ]), phases.length, 'steps'), '', `Cost this run: ${fmtMoney(run.spendUsd)}.`, '');
  } else {
    md.push('_This report was rebuilt from saved data, so no collection ran._', '');
  }
  md.push(`searchtrace ${mdEscape(ctx.toolVersion)} · data through ${fmtDate(out.dataThrough)} · searches named by Google: ${fmtAbsPct(out.diagnostics.namedClickShare)} of clicks`, '');
  return `${md.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Re-exported for the step summary: the headline sentence with its sign, for commit messages and logs. */
export function headlineLine(out: AnalysisOutput): string {
  const a = answerSentences(out);
  return a.verdict ? `${a.sentence} ${a.verdict}` : a.sentence;
}
