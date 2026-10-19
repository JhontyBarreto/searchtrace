// Self-contained HTML report (6.5). Also hosts renderReports, the 2.4 entry for all three outputs. Owner: WP-F.
//
// One file, no script, no network: inline CSS and SVG only, with a CSP that forbids everything
// else. Every value from data (queries, URLs, titles, notes, domains, sentences) goes through
// esc(); the only links are https "Check it yourself" links, which open with noopener noreferrer.
// Tables scroll inside their own box, so the page never scrolls sideways on a phone.
import { remainderShareOf } from '../analyze/waterfall.js';
import { diffDays } from '../core/time.js';
import type { AnalysisOutput, Finding, ReportContext, VerdictReason } from '../core/types.js';
import {
  BADGE, HIDDEN_PART_NOTE, SMALL_CHANGE_LABEL, aioBridgeSentence, answerSentences, findingAlternatives, findingFalsifier, findingSentence,
  headlineFinding, REAL_LABEL, realLabel, remainderNote, renderSentence, shownGroups, unitDisplay, whyText, CAUSE_LABEL,
} from './copy.js';
import { esc, externalLink } from './escape.js';
import { capitalise, fmtAbsPct, fmtDate, fmtInt, fmtMoney, fmtPct, fmtSignedInt } from './format.js';
import { verifyLink } from './gsc-links.js';
import { renderFindingsJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { alsoWorthGroups, groupList, type ListEntry, type UnitGroup } from './select.js';
import { alsoWorthSentence, groupSummary } from './stories.js';
import { answerChart, timelineChart, timelineLegend, waterfallSvg } from './svg.js';
import {
  beforeRecordingSentence, joinNotes, ladder, ledgerPhases, olderUpdatesLine, phaseLabel, scorecardCells, scorecardRows, siteChangeCells, statusWord,
} from './tables.js';

export {
  beforeRecordingSentence, joinNotes, ladder, olderUpdatesLine, phaseLabel, scorecardCells, scorecardRows, siteChangeCells, statusWord, updateName,
} from './tables.js';
export type { LadderRow } from './tables.js';
export { whyText } from './copy.js';

export const TABLE_CAP = 25;
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const METHODOLOGY_URL = 'https://github.com/JhontyBarreto/searchtrace/blob/main/docs/METHODOLOGY.md';
/** "What we checked" sub-sections, in this order. */
export const REST_ORDER: string[] = [REAL_LABEL.signal, REAL_LABEL.unclear, SMALL_CHANGE_LABEL, REAL_LABEL.underpowered, REAL_LABEL.noise];

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1f21;--muted:#5d6166;--line:#d9d6cf;--card:#ffffff;--accent:#2457c5;--neg:#c2410c;--pos:#15803d;
--band-core:rgba(36,87,197,.14);--band-other:rgba(124,58,237,.55);--cp:rgba(194,65,12,.16);--unc:#8a5a00;--code:#efece6;
--span-base:rgba(93,97,102,.14);--span-cur:rgba(36,87,197,.16);--prov:rgba(93,97,102,.22)}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#e8e6e3;--muted:#a2a6ab;--line:#30343a;--card:#1a1d21;--accent:#7aa2ff;
--neg:#fb923c;--pos:#4ade80;--band-core:rgba(122,162,255,.18);--band-other:rgba(196,167,255,.6);--cp:rgba(251,146,60,.2);--unc:#f5c26b;--code:#262a30;
--span-base:rgba(162,166,171,.16);--span-cur:rgba(122,162,255,.2);--prov:rgba(162,166,171,.25)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main,header,footer{max-width:980px;margin:0 auto;padding:0 20px}
header{padding-top:28px}header h1{font-size:1.5rem;margin:0 0 4px}header p{margin:0;color:var(--muted)}
.demo{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);padding:10px 14px;margin:16px 0}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 22px;margin:20px 0}
h2{font-size:1.2rem;margin:0 0 12px}h3{font-size:1rem;margin:18px 0 8px}
.answer{font-size:1.15rem}.answer p{margin:0 0 10px}
.labels{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:.85rem;border:1px solid currentColor}
.r-signal{color:var(--fg);font-weight:600;border-width:1.5px}.r-noise{color:var(--muted);border-style:dashed}.r-small{border-style:solid}
.r-underpowered{color:var(--muted)}.r-unclear{color:var(--unc)}
.dir{font-weight:700;margin-right:3px}.dir.pos{color:var(--pos)}.dir.neg{color:var(--neg)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.badge{color:var(--muted);font-size:.85rem}.muted{color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;margin:0 0 4px}.table-wrap:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}td.num{text-align:right;white-space:nowrap}
ul.findings{list-style:none;padding:0;margin:0}ul.findings li{padding:10px 0;border-bottom:1px solid var(--line)}
ul.findings ul.findings{margin-left:12px}ul.findings ul.findings li:last-child{border-bottom:none}
details{margin-top:6px}summary{cursor:pointer;color:var(--accent);font-size:.9rem}
dl.maths{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:2px 14px;font-size:.88rem;margin:8px 0}
dl.maths dt{color:var(--muted)}dl.maths dd{margin:0}dl.maths dt,dl.maths dd{overflow-wrap:anywhere}
a{color:var(--accent)}
svg{max-width:100%;height:auto;display:block}figure{margin:10px 0}figcaption{color:var(--muted);font-size:.85rem}
.spark-line,.series{stroke:var(--accent);stroke-width:1.6}.series-i{stroke:var(--muted)}.provisional{stroke-dasharray:4 3}
.spark-base{fill:var(--span-base)}.spark-cur{fill:var(--span-cur)}.spark-avg{stroke:var(--fg);stroke-width:1;stroke-dasharray:3 2}
.prov-band{fill:var(--prov)}.band-label{fill:var(--fg);font-size:10px}
.axis{stroke:var(--line)}.axis-label,.axis-title,.bar-label,.bar-value{fill:var(--muted);font-size:11px}.axis-title{font-size:12px}
.band-core{fill:var(--band-core)}.band-spam{fill:url(#pat-spam)}.band-outage{fill:url(#pat-outage)}.band-report{fill:url(#pat-report)}
.pat-fill{fill:var(--band-other)}.pat-stroke{stroke:var(--band-other);stroke-width:1}
.cp-window{fill:var(--cp)}.cp-line{stroke:var(--neg);stroke-width:1.2}.sc-marker{fill:var(--accent)}
.bar.neg{fill:var(--neg)}.bar.pos{fill:var(--pos)}.bar.total{opacity:.75}.whisker{stroke:var(--fg);stroke-width:1.2;fill:none}
.bar-label.total{font-weight:600;fill:var(--fg)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.85rem;color:var(--muted)}.legend-item{display:inline-flex;gap:6px;align-items:center}
.ladder td:first-child{white-space:nowrap;font-weight:600}
footer{color:var(--muted);font-size:.85rem;padding-bottom:40px}
@media (max-width:600px){dl.maths{grid-template-columns:minmax(0,1fr)}dl.maths dd{margin-bottom:6px}main,header,footer{padding:0 12px}section{padding:14px}}
@media print{@page{size:A4;margin:14mm}body{background:#fff;color:#000;font-size:11pt}section{border:none;padding:0;margin:0 0 10mm;break-before:page;background:none}
section:first-of-type{break-before:auto}details{display:block}details>*{display:block}summary{display:none}a{color:#000;text-decoration:none}.table-wrap{overflow:visible}}
`.trim();

// ---------- small builders ----------

/** Escaped text with the copy's command spans (`npx -y ...`) shown as code; their content is escaped like everything else. */
export function textHtml(text: string): string {
  return esc(text).replace(/&#96;(npx -y .+?)&#96;/g, '<code>$1</code>');
}

/**
 * The "Is it real?" pill. Its colour is certainty only (neutral for a real change, dashed for
 * wobble); green and red mean direction, shown by an arrow on real changes alone, so a real rise
 * never looks like an alarm and wobble on a drop never looks like good news.
 */
export function pill(f: Pick<Finding, 'real' | 'reason' | 'effect'>): string {
  const est = f.effect.estimate;
  const dir = f.real === 'signal' && est !== null && Number.isFinite(est) && est !== 0
    ? est > 0 ? '<span class="dir pos" aria-hidden="true">▲</span>' : '<span class="dir neg" aria-hidden="true">▼</span>'
    : '';
  const said = dir ? `<span class="vh"> (${(est as number) > 0 ? 'rise' : 'drop'})</span>` : '';
  const small = f.real === 'noise' && f.reason === 'noise_small' ? ' r-small' : '';
  return `<span class="pill r-${f.real}${small}">${dir}${esc(realLabel(f))}${said}</span>`;
}

function rangePct(ci: [number, number] | null | undefined): string {
  return ci ? `${fmtPct(ci[0])} to ${fmtPct(ci[1])}` : 'no range yet';
}

function rangeInt(ci: [number, number] | null | undefined): string {
  return ci ? `${fmtSignedInt(ci[0])} to ${fmtSignedInt(ci[1])}` : 'no range yet';
}

/** Which verdict rule (5.8) decided the label, in words. */
const REASON_WORDS: Record<VerdictReason, string> = {
  floors: 'below the minimum amount of data',
  identification: 'a check for other explanations failed',
  signal: 'the range excludes zero, it passes false-discovery control, and it may be at least the smallest change worth acting on',
  noise_bounded: 'not shown to be real, and the whole range sits inside the smallest change worth acting on',
  noise_small: 'real (the range excludes zero and passes false-discovery control), but the whole range is smaller than the smallest change worth acting on',
  wide_ci: 'the range is too wide to say',
  fact: 'a measured fact, not an estimate',
};

/** The analyzers, in words. */
const METHOD_WORDS: Record<string, string> = {
  attribute: 'click breakdown', changepoint: 'change-point detection', scorecard: 'Google update scorecard', aio: 'AI Overview comparison',
  site_change: 'site change comparison', index_state: 'index status checks',
};

function num(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return x < 0.001 && x > 0 ? '< 0.001' : x.toFixed(digits);
}

function capRows<T>(items: T[], render: (x: T) => string, cols: number, what = 'rows'): string {
  const rows = items.slice(0, TABLE_CAP).map(render).join('');
  const more = items.length > TABLE_CAP
    ? `<tr><td colspan="${cols}" class="muted">and ${esc(fmtInt(items.length - TABLE_CAP))} more ${esc(what)} in findings.json</td></tr>`
    : '';
  return rows + more;
}

/** A table inside its own scroll box (keyboard-focusable), so a wide table never widens the page. */
function tableOpen(label: string, cls = ''): string {
  return `<div class="table-wrap" role="region" tabindex="0" aria-label="${esc(label)}"><table${cls ? ` class="${cls}"` : ''}>`;
}
const TABLE_CLOSE = '</table></div>';

function checkLink(f: Finding, out: AnalysisOutput): string {
  const v = verifyLink(out.property, f, out.diagnostics.brandTokens);
  if (!v) return '';
  return ` ${externalLink(v.url, 'Check it yourself')}${v.note ? ` <span class="muted">(${esc(v.note)})</span>` : ''}`;
}

/** The scope behind a waterfall finding, for its remainder shares. */
function scopeOf(f: Finding, out?: AnalysisOutput): AnalysisOutput['scopes'][number] | undefined {
  return out?.scopes.find((s) => s.unit.level === f.unit.level && s.unit.key === f.unit.key && (f.kind === 'waterfall' || f.kind === 'headline'));
}

/** "Show the maths" for one finding: every statistical detail lives here and nowhere else. */
export function mathsDetails(f: Finding, out?: AnalysisOutput): string {
  const rows: [string, string][] = [];
  const e = f.effect;
  if (f.kind === 'aio_fact') {
    rows.push(['AI Overview', `in ${fmtInt(Number(f.slots.k ?? 0))} of ${fmtInt(Number(f.slots.n ?? 0))} checks`]);
    if (typeof f.slots.attributed === 'number') rows.push(['Estimated share of the AI Overview loss', `${fmtInt(f.slots.attributed)} clicks (${BADGE.INFERRED})`]);
  }
  if (e.estimate !== null) rows.push(['Estimate', e.ci95 ? `${fmtPct(e.estimate)} (95% range ${rangePct(e.ci95)})` : `${fmtPct(e.estimate)} (no range: too little data)`]);
  if (e.absolute !== null) rows.push(['Clicks', e.absoluteCi95 ? `${fmtSignedInt(e.absolute)} (95% range ${rangeInt(e.absoluteCi95)})` : fmtSignedInt(e.absolute)]);
  if (e.p !== null && e.q !== null) rows.push(['p and q', `p = ${num(e.p)}, q = ${num(e.q)} (false-discovery control)`]);
  else if (e.p !== null) rows.push(['p', `${num(e.p)} (not tested for false discoveries: below the minimum data, or a single test)`]);
  else if (e.q !== null) rows.push(['q', `${num(e.q)} (false-discovery control)`]);
  if (typeof f.slots.delta === 'number' && f.reason !== 'fact') rows.push(['Smallest change worth acting on', fmtAbsPct(f.slots.delta)]);
  if (f.power) {
    const mdeOk = Number.isFinite(f.power.mde) && f.power.mde < 0.95;
    rows.push(['Smallest change we could detect', mdeOk ? fmtAbsPct(f.power.mde) : 'not measurable at this traffic level']);
    rows.push(['Weeks of data needed', f.power.weeksNeeded !== null ? fmtInt(f.power.weeksNeeded) : f.power.notMeasurable ? 'more than a year' : 'not worked out']);
    rows.push(['Clicks per week', fmtInt(f.power.perWeek)]);
  }
  rows.push(['Verdict rule', f.reason === 'fact' ? 'A measured fact, not an estimate' : `${realLabel(f)}: ${REASON_WORDS[f.reason] ?? f.reason}`]);
  const impact = out?.siteChangeImpacts.find((i) => i.findingId === f.id);
  if (impact) {
    rows.push(['Pages compared', `${impact.treated} changed, ${impact.controls} unchanged${impact.controlFallback ? ' (fallback controls)' : ''}`]);
    if (impact.controlChange !== null) rows.push(['Unchanged pages moved', `${fmtPct(impact.controlChange)} (95% range ${rangePct(impact.controlCi95)})`]);
    if (impact.placebo) rows.push(['Placebo check', `${fmtPct(impact.placebo.tau)} (95% range ${rangePct(impact.placebo.ci95)})`]);
    if (impact.notYetSeen.length) rows.push(['Not recrawled yet', `${impact.notYetSeen.length} pages`]);
  }
  const est = out?.aio?.estimates.find((x) => x.findingId === f.id);
  if (est) {
    rows.push(['Searches compared', `${est.groups.U} with an AI Overview that doesn't cite you, ${est.groups.N} without, ${est.groups.Cit} citing you`]);
    rows.push(['Comparable share', fmtAbsPct(est.coverage)]);
    if (est.placebo) rows.push(['Placebo check', `${fmtPct(est.placebo.tau)} (95% range ${rangePct(est.placebo.ci95)})`]);
  }
  const B = out ? Object.entries(out.diagnostics.bootstrapB).map(([k, v]) => `${k} ${fmtInt(v)}`).join(', ') : '';
  if (B && (f.kind === 'waterfall' || f.kind === 'headline' || impact || est)) rows.push(['Bootstrap replicates (B)', B]);
  if (f.cause) rows.push(['Cause', `${CAUSE_LABEL[f.cause]} (${BADGE[f.causeConfidence]})`]);
  if (f.components) {
    const rem = scopeOf(f, out);
    const share = rem ? remainderShareOf(rem) : { ranking: 0, samePos: 0 };
    const rough = (g: string): string => ((g === 'ranking' && share.ranking >= 0.5) || (g === 'samePos' && share.samePos >= 0.5) ? ' (Possible)' : '');
    const groups = shownGroups(f.components, f.componentCi95).map((g) => `${g.label}${rough(g.group)} ${fmtSignedInt(g.value)}${g.ci ? ` (${rangeInt(g.ci)})` : ''}`);
    if (groups.length) rows.push(['Parts (ranges: split given these two periods)', groups.join('; ')]);
  }
  for (const ev of f.evidence.slice(0, 8)) rows.push([BADGE[ev.confidence], `${ev.summary} (${ev.partition})`]);
  const alts = findingAlternatives(f);
  if (alts.length) rows.push(['Other explanations', alts.map((a) => a.text).join(' ')]);
  rows.push(['Method', `${METHOD_WORDS[f.analyzer.name] ?? f.analyzer.name}, version ${f.analyzer.version}`]);
  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<details><summary>Show the maths</summary><dl class="maths">${dl}</dl><p class="muted">${textHtml(findingFalsifier(f))}</p></details>`;
}

/** The label part of an item: the verdict pill and, when there is a cause to name, "Why: ... (badge)". */
function labelHtml(f: Finding): string {
  if (f.reason === 'fact') return `<span class="pill">${esc(BADGE.EXTRACTED)}</span>`;
  const why = whyText(f);
  return `${pill(f)}${why ? ` <span class="badge">${esc(why)}</span>` : ''}`;
}

function findingItem(f: Finding, out: AnalysisOutput, sel?: ReportSelections): string {
  const cp = sel?.reconciled.get(f.id);
  if (cp) {
    // A 28-day comparison that dilutes a real step: one item, led by the step (6.5).
    return `<li>${labelHtml(cp)} <strong>${esc(unitDisplay(f.unit))}</strong><br>${textHtml(reconciledSentence(f, cp, out))}` +
      `${checkLink(cp, out)}${mathsDetails(cp, out)}${mathsDetails(f, out).replace('Show the maths', 'Show the maths for the full period')}</li>`;
  }
  return `<li>${labelHtml(f)} <strong>${esc(unitDisplay(f.unit))}</strong><br>${textHtml(findingSentence(f))}${checkLink(f, out)}${mathsDetails(f, out)}</li>`;
}

function entryItem(e: ListEntry, out: AnalysisOutput, sel?: ReportSelections): string {
  if (e.kind === 'one') return findingItem(e.f, out, sel);
  const { text } = groupSummary(e, out);
  const members = e.members.slice(0, TABLE_CAP).map((f) => findingItem(f, out, sel)).join('');
  const more = e.members.length > TABLE_CAP ? `<li class="muted">and ${esc(fmtInt(e.members.length - TABLE_CAP))} more in findings.json</li>` : '';
  return `<li>${pill(e.members[0])} ${esc(text)}` +
    `<details><summary>Show all ${esc(fmtInt(e.members.length))}</summary><ul class="findings">${members}${more}</ul></details></li>`;
}

function findingList(items: Finding[], out: AnalysisOutput, empty: string, sel?: ReportSelections): string {
  if (!items.length) return empty ? `<p class="muted">${esc(empty)}</p>` : '';
  const entries = groupList(items, out);
  const shown = entries.slice(0, TABLE_CAP).map((e) => entryItem(e, out, sel)).join('');
  const more = entries.length > TABLE_CAP ? `<li class="muted">and ${esc(fmtInt(entries.length - TABLE_CAP))} more in findings.json</li>` : '';
  return `<ul class="findings">${shown}${more}</ul>`;
}

const byPriority = (a: Finding, b: Finding): number => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------- shared selections (also used by markdown.ts) ----------

export interface ReportSelections {
  head: Finding | null;
  alsoWorth: UnitGroup[];
  templates: Finding[];
  pages: Finding[];
  queries: Finding[];
  aioEffects: Finding[];
  siteChangeFindings: Finding[];
  /** The grouped fact for pages first seen in Google inside the window. */
  appearances: Finding[];
  coverage: string;
  freshness: string | null;
  beforeRecording: boolean;
  noSiteChanges: boolean;
  /** "What we checked", by label in REST_ORDER. */
  rest: Map<string, Finding[]>;
  facts: Finding[];
  /** Waterfall findings (wobble or thin over 28 days) shown with the real change point inside the window that they dilute. */
  reconciled: Map<string, Finding>;
}

export function coverageSentence(out: AnalysisOutput): string {
  const f = out.findings.find((x) => x.template === 'coverage');
  if (f) return findingSentence(f);
  const share = out.diagnostics.namedClickShare;
  return renderSentence('coverage', { hidden: 1 - share, shown: share });
}

/**
 * For a waterfall finding that is wobble or too thin over the 28 days, the real change point on the
 * same unit inside the current window that it links to, if any: the same story told by two tests
 * that must be reconciled, not contradicted.
 */
function dilutedBy(f: Finding, out: AnalysisOutput, byId: Map<string, Finding>): Finding | null {
  if (f.kind !== 'waterfall' || (f.real !== 'noise' && f.real !== 'underpowered')) return null;
  const [c0, c1] = out.windows.current;
  for (const id of f.related.findings) {
    const cp = byId.get(id);
    if (cp && cp.kind === 'change_point' && cp.real === 'signal' && cp.unit.key === f.unit.key && cp.unit.level === f.unit.level &&
      cp.date && cp.date >= c0 && cp.date <= c1) return cp;
  }
  return null;
}

/** The real change point a wobble or thin 28-day finding dilutes, if any (for why). */
export function reconciledFor(f: Finding, out: AnalysisOutput): Finding | null {
  return dilutedBy(f, out, new Map(out.findings.map((x) => [x.id, x])));
}

/** The change point's sentence, then what the full period shows and why it differs, and a linked change as Possible. */
export function reconciledSentence(f: Finding, cp: Finding, out: AnalysisOutput): string {
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  const lead = diffDays(out.windows.current[0], cp.date as string);
  const full = f.effect.estimate !== null ? `Over the full ${L} days it's ${fmtPct(f.effect.estimate)}` : `Over the full ${L} days the change is smaller`;
  const why = lead > 0 ? `, because the first ${lead} ${lead === 1 ? 'day was' : 'days were'} still at the old level.` : '.';
  const change = out.siteChanges.find((c) => f.related.siteChanges.includes(c.id));
  const linked = change ? ` Possibly linked to the ${change.source === 'annotation' ? 'change you noted' : `${change.field} change`} on ${fmtDate(change.deployed.to.slice(0, 10))} (${BADGE.AMBIGUOUS}).` : '';
  return `${findingSentence(cp)} ${full}${why}${linked}`;
}

export function selectFindings(out: AnalysisOutput): ReportSelections {
  const sorted = [...out.findings].sort(byPriority);
  const byId = new Map(out.findings.map((f) => [f.id, f]));
  const head = headlineFinding(out);
  const shown = new Set<string>(head ? [head.id] : []);
  const alsoWorth = alsoWorthGroups(out, 3);
  for (const g of alsoWorth) for (const f of [g.lead, ...g.others]) shown.add(f.id);
  const reconciled = new Map<string, Finding>();
  for (const f of sorted) {
    const cp = dilutedBy(f, out, byId);
    if (cp && !shown.has(f.id)) {
      reconciled.set(f.id, cp);
      shown.add(cp.id);
    }
  }
  const take = (pred: (f: Finding) => boolean): Finding[] => {
    const xs = sorted.filter((f) => !shown.has(f.id) && pred(f));
    for (const f of xs) shown.add(f.id);
    return xs;
  };
  const templates = take((f) => f.kind === 'waterfall' && f.unit.level === 'template');
  const pages = take((f) => f.kind === 'waterfall' && f.unit.level === 'page');
  const queries = take((f) => f.kind === 'waterfall' && f.unit.level === 'query');
  const aioEffects = take((f) => f.kind === 'aio_effect');
  take((f) => f.kind === 'aio_fact');
  const siteChangeFindings = take((f) => f.kind === 'site_change_impact' || f.template === 'site_change_unseen');
  const appearances = take((f) => f.kind === 'notice' && f.template === 'change_point');
  for (const f of sorted) if (f.kind === 'update_impact' || ['coverage', 'freshness', 'no_site_changes'].includes(f.template)) shown.add(f.id);
  const freshnessF = out.findings.find((f) => f.template === 'freshness');
  const remaining = sorted.filter((f) => !shown.has(f.id));
  const facts = remaining.filter((f) => f.causeConfidence === 'EXTRACTED' && f.reason === 'fact');
  const rest = new Map<string, Finding[]>();
  for (const label of REST_ORDER) rest.set(label, remaining.filter((f) => !facts.includes(f) && realLabel(f) === label));
  return {
    head, alsoWorth, templates, pages, queries, aioEffects, siteChangeFindings, appearances, reconciled,
    coverage: coverageSentence(out),
    freshness: freshnessF ? findingSentence(freshnessF) : null,
    beforeRecording: out.findings.some((f) => f.template === 'before_recording' || f.alternatives.some((a) => a.key === 'site_change_none_recorded')),
    noSiteChanges: out.siteChanges.length === 0,
    rest,
    facts,
  };
}

/** "pipewell-plumbing.example (Domain property)" for sc-domain properties, the URL prefix otherwise. */
export function propertyDisplay(p: string): string {
  return p.startsWith('sc-domain:') ? `${p.slice('sc-domain:'.length)} (Domain property)` : p;
}

/** The waterfall table rows for the whole site: parts (Possible when mostly hidden searches) and the headline's own range on the total. */
export function waterfallRows(out: AnalysisOutput, head: Finding | null): { rows: [string, string, string][]; rough: boolean; totalNote: string | null } | null {
  const site = out.scopes.find((x) => x.unit.level === 'site');
  if (!site) return null;
  const share = remainderShareOf(site);
  let rough = false;
  const rows: [string, string, string][] = shownGroups(site.bars, site.ci95).map((g) => {
    const mark = (g.group === 'ranking' && share.ranking >= 0.5) || (g.group === 'samePos' && share.samePos >= 0.5);
    rough = rough || mark;
    return [`${g.label}${mark ? ' (Possible)' : ''}`, fmtSignedInt(g.value), rangeInt(g.ci)];
  });
  // The total's range is the headline's "is it real?" range (same SE as the percent), never the split's.
  const totalCi = head?.effect.absoluteCi95 ?? site.ci95?.total ?? null;
  rows.push(['Total', fmtSignedInt(site.deltaClicks), rangeInt(totalCi)]);
  const headAbs = head?.effect.absolute ?? null;
  const totalNote = headAbs !== null && Math.round(headAbs) !== Math.round(site.deltaClicks)
    ? `Page totals give ${fmtSignedInt(site.deltaClicks)}; the site total from Search Console gives ${fmtSignedInt(headAbs)}.`
    : null;
  return { rows, rough, totalNote };
}

/** The reconciliation line, in plain words. */
export function reconciliationLine(out: AnalysisOutput): string {
  const rec = out.diagnostics.reconciliation;
  if (Math.round(rec.byPageClicks) === Math.round(rec.byPropertyClicks)) {
    return `Check: your pages add up to the site total across both periods (${fmtInt(rec.byPageClicks)} clicks).`;
  }
  return `Your pages add up to ${fmtInt(rec.byPageClicks)} clicks across both periods but the site total is ${fmtInt(rec.byPropertyClicks)}, ` +
    `a gap of ${fmtSignedInt(rec.byPropertyClicks - rec.byPageClicks)}.`;
}

/** The headline's "Is it real?" row: always the label; "Why?" only when whyText names a cause. */
function answerLabels(f: Finding): string {
  const why = whyText(f);
  const cause = why && f.cause ? ` <span>Why?</span> <span class="pill">${esc(CAUSE_LABEL[f.cause])}</span> <span class="badge">${esc(BADGE[f.causeConfidence])}</span>` : '';
  return `<div class="labels"><span>Is it real?</span> ${pill(f)}${cause}</div>`;
}

// ---------- the page ----------

export function renderHtml(out: AnalysisOutput, ctx: ReportContext): string {
  const sel = selectFindings(out);
  const answer = answerSentences(out);
  const p = out.property;
  const s: string[] = [];

  s.push(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">`);
  s.push(`<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="referrer" content="no-referrer">`);
  s.push(`<title>${esc(`Search traffic report: ${propertyDisplay(p)}`)}</title>\n<style>${CSS}</style>\n</head>\n<body>`);
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  s.push(`<header><h1>Why did your Google traffic change?</h1><p>${esc(propertyDisplay(p))} · data runs to ${esc(fmtDate(out.dataThrough))} (Pacific Time) · ` +
    `last ${esc(fmtInt(L))} days vs the ${esc(fmtInt(L))} before</p>`);
  if (ctx.demo) {
    s.push('<p class="demo">This is a demo on a made-up site (Pipewell Plumbing). None of these numbers are real; they show what each kind of answer looks like.</p>');
  }
  s.push('</header><main>');

  // 1. The answer
  s.push('<section id="answer"><h2>The answer</h2><div class="answer">');
  s.push(`<p>${esc(answer.sentence)}</p>`);
  if (answer.verdict) s.push(`<p>${textHtml(answer.verdict)}</p>`);
  s.push('</div>');
  if (!out.headline.boring && sel.head) {
    s.push(answerLabels(sel.head));
    s.push(mathsDetails(sel.head, out));
  }
  const chart = answerChart(out);
  if (chart) s.push(`<figure>${chart.svg}<figcaption id="answer-chart">${esc(chart.caption)}</figcaption></figure>`);
  if (sel.alsoWorth.length) {
    s.push('<h3>Also worth knowing</h3><ul class="findings">');
    for (const g of sel.alsoWorth) {
      s.push(`<li>${labelHtml(g.lead)} <strong>${esc(unitDisplay(g.lead.unit))}</strong><br>${textHtml(alsoWorthSentence(g))}` +
        `${checkLink(g.lead, out)}${mathsDetails(g.lead, out)}</li>`);
    }
    s.push('</ul>');
  }
  s.push('</section>');

  // 2. Where the clicks went
  s.push('<section id="waterfall"><h2>Where the clicks went</h2>');
  const wf = waterfallRows(out, sel.head);
  const site = out.scopes.find((x) => x.unit.level === 'site');
  if (site && wf) {
    s.push(waterfallSvg(site, { totalCi: sel.head?.effect.absoluteCi95 ?? null }));
    s.push(`${tableOpen('Where the clicks went')}<thead><tr><th>Part</th><th class="num">Clicks</th><th class="num">95% range</th></tr></thead><tbody>`);
    for (const [label, value, range] of wf.rows) {
      const strong = label === 'Total';
      s.push(`<tr><td>${strong ? '<strong>Total</strong>' : esc(label)}</td><td class="num">${strong ? `<strong>${esc(value)}</strong>` : esc(value)}</td><td class="num">${esc(range)}</td></tr>`);
    }
    s.push(`</tbody>${TABLE_CLOSE}`);
    s.push('<p class="muted">The parts\' ranges show how sure we are of the split given these two periods; the total\'s range is the same one the answer uses.</p>');
    const bridge = aioBridgeSentence(out);
    if (bridge) s.push(`<p>${esc(bridge)}</p>`);
    if (wf.rough) s.push(`<p class="muted">${esc(HIDDEN_PART_NOTE)}</p>`);
    if (wf.totalNote) s.push(`<p class="muted">${esc(wf.totalNote)}</p>`);
    s.push(`<p class="muted">${esc(remainderNote(1 - out.diagnostics.namedClickShare))}</p>`);
  } else {
    s.push('<p class="muted">No click breakdown yet.</p>');
  }
  s.push(`<p class="muted">${esc(reconciliationLine(out))}</p></section>`);

  // 3. Timeline
  s.push('<section id="timeline"><h2>Timeline</h2>');
  const tl = timelineChart(out);
  s.push(tl.svg ? tl.svg + timelineLegend(tl.drawn) : '<p class="muted">Not enough history to draw yet.</p>');
  if (sel.freshness) s.push(`<p class="muted">${esc(sel.freshness)}</p>`);
  const prov = out.timeline.provisional.length;
  if (tl.svg && prov > 0) s.push(`<p class="muted">The chart shades the newest ${esc(fmtInt(prov))} ${prov === 1 ? 'day' : 'days'} because ${prov === 1 ? 'it' : 'they'} may still change.</p>`);
  s.push('</section>');

  // 4. Google update scorecard
  s.push('<section id="updates"><h2>Google update scorecard</h2>');
  const { shown: rows, older } = scorecardRows(out);
  if (rows.length) {
    s.push(`${tableOpen('Google update scorecard')}<thead><tr><th>Update</th><th>Dates</th><th>Clicks change (range)</th><th>Impressions change (range)</th><th>Verdict</th><th>Notes</th></tr></thead><tbody>`);
    s.push(capRows(rows, (r) => {
      const c = scorecardCells(r, out);
      return `<tr><td>${esc(c.name)}</td><td>${esc(c.dates)}</td><td>${esc(c.clicks)}</td><td>${esc(c.impressions)}</td><td>${esc(c.verdict)}</td><td>${esc(c.notes)}</td></tr>`;
    }, 6, 'updates'));
    s.push(`</tbody>${TABLE_CLOSE}`);
  } else {
    s.push('<p class="muted">No Google updates overlap your data yet.</p>');
  }
  const olderLine = olderUpdatesLine(older, { listed: false });
  if (olderLine) s.push(`<p class="muted">${esc(olderLine)}</p>`);
  s.push('</section>');

  // 5. Pages and sections that moved
  s.push('<section id="pages"><h2>Pages and sections that moved</h2><h3>Sections of your site</h3>');
  s.push(findingList(sel.templates, out, 'No sections to compare yet.', sel));
  s.push('<h3>Pages</h3><p class="muted">Listed by size of change; each range is for that page alone, not adjusted for it being one of the biggest movers.</p>');
  for (const f of sel.appearances) s.push(`<p>${esc(findingSentence(f))}</p>`);
  s.push(findingList(sel.pages, out, sel.appearances.length ? '' : 'No pages to compare yet.', sel));
  s.push('</section>');

  // 6. Searches that moved
  s.push(`<section id="searches"><h2>Searches that moved</h2><p class="muted">${esc(sel.coverage)}</p>`);
  s.push(findingList(sel.queries, out, 'No searches to compare yet.', sel));
  if (sel.aioEffects.length) {
    s.push('<h3>AI Overviews</h3>');
    s.push(findingList(sel.aioEffects, out, '', sel));
  }
  const facts = out.aio?.facts ?? [];
  if (facts.length) {
    s.push(`<h3>AI Overview checks</h3>${tableOpen('AI Overview checks')}<thead><tr><th>Search</th><th>Device</th><th>Shown in</th><th>Cites you?</th><th>Other sites it cites</th><th>Google changed your title?</th></tr></thead><tbody>`);
    s.push(capRows(facts, (x) => `<tr><td>${esc(x.keyword)}</td><td>${esc(capitalise(x.device))}</td><td>${esc(`${x.aioChecks} of ${x.checks} ${x.checks === 1 ? 'check' : 'checks'}`)}</td>` +
      `<td>${x.aioChecks > 0 ? (x.cited ? 'Yes' : 'No') : 'No AI Overview'}</td><td>${esc(citedSites(x.topDomains))}</td>` +
      `<td>${x.titleRewritten === null ? "Can't tell" : x.titleRewritten ? 'Yes' : 'No'}</td></tr>`, 6, 'searches'));
    s.push(`</tbody>${TABLE_CLOSE}`);
  }
  s.push('</section>');

  // 7. Your site changes
  s.push('<section id="changes"><h2>Your site changes</h2>');
  if (out.siteChanges.length) {
    s.push(`${tableOpen('Your site changes')}<thead><tr><th>What changed</th><th class="num">Pages</th><th>When (deployed)</th><th>Google saw it</th><th>Outcome</th></tr></thead><tbody>`);
    s.push(capRows(out.siteChanges, (c) => {
      const x = siteChangeCells(c, out);
      return `<tr><td>${esc(x.what)}</td><td class="num">${esc(x.pages)}</td><td>${esc(x.deployed)}</td><td>${esc(x.seen)}</td><td>${esc(x.outcome)}</td></tr>`;
    }, 5, 'changes'));
    s.push(`</tbody>${TABLE_CLOSE}`);
    s.push(findingList(sel.siteChangeFindings, out, '', sel));
  } else {
    s.push(`<p>${esc(renderSentence('no_site_changes', {}))}</p>`);
  }
  if (sel.beforeRecording) s.push(`<p>${textHtml(beforeRecordingSentence(out))}</p>`);
  s.push('</section>');

  // 8. What we checked and what we couldn't
  s.push("<section id=\"checked\"><h2>What we checked and what we couldn't</h2>");
  let anyRest = false;
  for (const label of REST_ORDER) {
    const xs = sel.rest.get(label) ?? [];
    if (!xs.length) continue;
    anyRest = true;
    s.push(`<h3>${esc(label)}</h3>${findingList(xs, out, '', sel)}`);
  }
  if (sel.facts.length) {
    anyRest = true;
    s.push(`<h3>${esc(BADGE.EXTRACTED)} facts</h3>${findingList(sel.facts, out, '', sel)}`);
  }
  if (!anyRest) s.push('<p class="muted">Everything we found is shown above.</p>');
  const d = out.diagnostics;
  const B = Object.entries(d.bootstrapB).map(([k, v]) => `${k} ${fmtInt(v)}`).join(', ') || 'none';
  s.push('<details><summary>Show the maths for the whole report</summary><dl class="maths">' +
    `<dt>Click-rate curve strength (m)</dt><dd>${esc(fmtInt(out.curve.m))}</dd>` +
    `<dt>Curve fitted on</dt><dd>${esc(`${fmtDate(out.curve.fitWindow[0])} to ${fmtDate(out.curve.fitWindow[1])}`)}</dd>` +
    `<dt>Unstable curve segments</dt><dd>${esc(out.curve.unstable.join(', ') || 'none')}</dd>` +
    `<dt>Bootstrap replicates (B)</dt><dd>${esc(B)}</dd>` +
    `<dt>Searches named by Google</dt><dd>${esc(fmtAbsPct(d.namedClickShare))} of clicks</dd>` +
    `<dt>Days of history</dt><dd>${esc(fmtInt(d.historyDays))}</dd>` +
    `<dt>Days cut off at the row limit</dt><dd>${esc(d.truncatedDays.length ? d.truncatedDays.map(fmtDate).join(', ') : 'none')}</dd>` +
    `<dt>Revised days</dt><dd>${esc(fmtInt(d.revisions))}</dd>` +
    `<dt>Brand words</dt><dd>${esc(d.brandTokens.join(', ') || 'none')}</dd>` +
    `<dt>Inputs hash</dt><dd>${esc(out.inputsHash)}</dd>` +
    `</dl><p>${externalLink(METHODOLOGY_URL, 'How every number is worked out (methodology)')}</p></details>`);
  s.push('</section>');

  // 9. What gets smarter next
  s.push(`<section id="next"><h2>What gets smarter next</h2>${tableOpen('What gets smarter next', 'ladder')}<tbody>`);
  for (const r of ladder(out, ctx)) s.push(`<tr><td>${esc(r.when)}</td><td>${esc(r.what)}</td><td>${esc(r.status)}</td></tr>`);
  s.push(`</tbody>${TABLE_CLOSE}</section>`);

  // 10. What this run did and cost
  s.push('<section id="ledger"><h2>What this run did and cost</h2>');
  const run = ctx.run;
  if (run && run.phases.length) {
    s.push(`${tableOpen('What this run did and cost')}<thead><tr><th>Step</th><th>Status</th><th class="num">Requests</th><th class="num">Rows</th><th class="num">Cost</th><th>Notes</th></tr></thead><tbody>`);
    for (const ph of ledgerPhases(run.phases)) {
      const req = Object.values(ph.requests).reduce((a, b) => a + b, 0);
      s.push(`<tr><td>${esc(phaseLabel(ph.name))}</td><td>${esc(statusWord(ph.status))}</td><td class="num">${esc(fmtInt(req))}</td>` +
        `<td class="num">${esc(fmtInt(ph.rows))}</td><td class="num">${esc(fmtMoney(ph.costUsd))}</td><td>${esc(joinNotes(ph.notes))}</td></tr>`);
    }
    s.push(`</tbody>${TABLE_CLOSE}<p>Cost this run: ${esc(fmtMoney(run.spendUsd))}.</p>`);
  } else {
    s.push('<p class="muted">This report was rebuilt from saved data, so no collection ran.</p>');
  }
  s.push(`<p class="muted">searchtrace ${esc(ctx.toolVersion)} · data through ${esc(fmtDate(out.dataThrough))}</p>`);
  s.push('</section></main>');
  s.push(`<footer><p>Made with searchtrace ${esc(ctx.toolVersion)}. Your data stays in your own folder. ` +
    `${externalLink(METHODOLOGY_URL, 'Methodology')}</p></footer>\n</body>\n</html>\n`);
  return s.join('\n');
}

/** "a.com, b.com, c.com +6 more", or "none". */
export function citedSites(domains: string[]): string {
  if (!domains.length) return 'none';
  return `${domains.slice(0, 3).join(', ')}${domains.length > 3 ? ` +${domains.length - 3} more` : ''}`;
}

export function renderReports(out: AnalysisOutput, ctx: ReportContext): { html: string; md: string; json: string } {
  return { html: renderHtml(out, ctx), md: renderMarkdown(out, ctx), json: renderFindingsJson(out, ctx) };
}
