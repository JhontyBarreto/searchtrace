// Self-contained HTML report (6.5). Also hosts renderReports, the 2.4 entry for all three outputs. Owner: WP-F.
//
// One file, no script, no network: inline CSS and SVG only, with a CSP that forbids everything
// else. Every value from data (queries, URLs, titles, notes, domains, sentences) goes through
// esc(); the only links are https "Check it yourself" links, which open with noopener noreferrer.
import { diffDays, ptDate } from '../core/time.js';
import type { AnalysisOutput, Finding, PhaseResult, ReportContext, SiteChange, UpdateRow, Verdict } from '../core/types.js';
import {
  BADGE, CAUSE_LABEL, REAL_LABEL, REMAINDER_LABEL, answerSentences, displayGroups, findingAlternatives, findingFalsifier,
  findingSentence, headlineFinding, renderSentence,
} from './copy.js';
import { esc, externalLink } from './escape.js';
import { fmtAbsPct, fmtDate, fmtInt, fmtMoney, fmtPct, fmtSignedInt } from './format.js';
import { gscLink } from './gsc-links.js';
import { renderFindingsJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { sparklineSvg, timelineLegend, timelineSvg, waterfallSvg } from './svg.js';

export const TABLE_CAP = 25;
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const METHODOLOGY_URL = 'https://github.com/JhontyBarreto/searchtrace/blob/main/docs/METHODOLOGY.md';
const LABEL_ORDER: Verdict[] = ['signal', 'unclear', 'underpowered', 'noise'];

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1f21;--muted:#5d6166;--line:#d9d6cf;--card:#ffffff;--accent:#2457c5;--neg:#c2410c;--pos:#15803d;
--band-core:rgba(36,87,197,.14);--band-other:rgba(124,58,237,.55);--cp:rgba(194,65,12,.16);--sig:#b42318;--unc:#8a5a00;--und:#475467;--noi:#2f6f3e}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#e8e6e3;--muted:#a2a6ab;--line:#30343a;--card:#1a1d21;--accent:#7aa2ff;
--neg:#fb923c;--pos:#4ade80;--band-core:rgba(122,162,255,.18);--band-other:rgba(196,167,255,.6);--cp:rgba(251,146,60,.2);--sig:#ff8a7a;--unc:#f5c26b;--und:#b4bcc8;--noi:#86d39a}}
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
.r-signal{color:var(--sig)}.r-unclear{color:var(--unc)}.r-underpowered{color:var(--und)}.r-noise{color:var(--noi)}
.badge{color:var(--muted);font-size:.85rem}.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}td.num{text-align:right;white-space:nowrap}
ul.findings{list-style:none;padding:0;margin:0}ul.findings li{padding:10px 0;border-bottom:1px solid var(--line)}
details{margin-top:6px}summary{cursor:pointer;color:var(--accent);font-size:.9rem}
dl.maths{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;font-size:.88rem;margin:8px 0}dl.maths dt{color:var(--muted)}dl.maths dd{margin:0}
a{color:var(--accent)}
svg{max-width:100%;height:auto;display:block}
.spark-line,.series{stroke:var(--accent);stroke-width:1.6}.series-i{stroke:var(--muted)}.provisional{stroke-dasharray:4 3}
.axis{stroke:var(--line)}.axis-label,.axis-title,.bar-label,.bar-value{fill:var(--muted);font-size:11px}.axis-title{font-size:12px}
.band-core{fill:var(--band-core)}.band-spam{fill:url(#pat-spam)}.band-outage{fill:url(#pat-outage)}.band-report{fill:url(#pat-report)}
.pat-fill{fill:var(--band-other)}.pat-stroke{stroke:var(--band-other);stroke-width:1}
.cp-window{fill:var(--cp)}.cp-line{stroke:var(--neg);stroke-width:1.2}.sc-marker{fill:var(--accent)}
.bar.neg{fill:var(--neg)}.bar.pos{fill:var(--pos)}.bar.total{opacity:.75}.whisker{stroke:var(--fg);stroke-width:1.2;fill:none}
.bar-label.total{font-weight:600;fill:var(--fg)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.85rem;color:var(--muted)}.legend-item{display:inline-flex;gap:6px;align-items:center}
.ladder td:first-child{white-space:nowrap;font-weight:600}
footer{color:var(--muted);font-size:.85rem;padding-bottom:40px}
@media print{@page{size:A4;margin:14mm}body{background:#fff;color:#000;font-size:11pt}section{border:none;padding:0;margin:0 0 10mm;break-before:page;background:none}
section:first-of-type{break-before:auto}details{display:block}details>*{display:block}summary{display:none}a{color:#000;text-decoration:none}}
`.trim();

// ---------- small builders ----------

function pill(real: Verdict): string {
  return `<span class="pill r-${real}">${esc(REAL_LABEL[real])}</span>`;
}

function rangePct(ci: [number, number] | null | undefined): string {
  return ci ? `${fmtPct(ci[0])} to ${fmtPct(ci[1])}` : 'n/a';
}

function rangeInt(ci: [number, number] | null | undefined): string {
  return ci ? `${fmtSignedInt(ci[0])} to ${fmtSignedInt(ci[1])}` : 'n/a';
}

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

function checkLink(f: Finding, property: string): string {
  return f.verify ? ` ${externalLink(gscLink(property, f.verify), 'Check it yourself')}` : '';
}

/** "Show the maths" for one finding: every statistical detail lives here and nowhere else. */
export function mathsDetails(f: Finding, out?: AnalysisOutput): string {
  const rows: [string, string][] = [];
  const e = f.effect;
  if (e.estimate !== null) rows.push(['Estimate', `${fmtPct(e.estimate)} (95% range ${rangePct(e.ci95)})`]);
  if (e.absolute !== null) rows.push(['Clicks', `${fmtSignedInt(e.absolute)} (95% range ${rangeInt(e.absoluteCi95)})`]);
  if (e.p !== null || e.q !== null) rows.push(['p and q', `p = ${num(e.p)}, q = ${num(e.q)} (false-discovery control)`]);
  if (f.power) {
    rows.push(['Smallest change we could detect', f.power.notMeasurable ? 'not measurable at this traffic level' : fmtAbsPct(f.power.mde)]);
    rows.push(['Weeks of data needed', f.power.weeksNeeded === null ? 'n/a' : fmtInt(f.power.weeksNeeded)]);
    rows.push(['Clicks per week', fmtInt(f.power.perWeek)]);
  }
  rows.push(['Verdict rule', `${f.real} (${f.reason})`]);
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
  const B = out ? Object.entries(out.diagnostics.bootstrapB).map(([k, v]) => `${k} ${v}`).join(', ') : '';
  if (B && (f.kind === 'waterfall' || f.kind === 'headline' || impact || est)) rows.push(['Bootstrap replicates (B)', B]);
  if (f.cause) rows.push(['Cause', `${CAUSE_LABEL[f.cause]} (${BADGE[f.causeConfidence]})`]);
  if (f.components) {
    const groups = displayGroups(f.components, f.componentCi95 as Record<string, [number, number]> | null)
      .filter((g) => g.value !== 0 || g.ci)
      .map((g) => `${g.label} ${fmtSignedInt(g.value)}${g.ci ? ` (${rangeInt(g.ci)})` : ''}`);
    if (groups.length) rows.push(['Parts', groups.join('; ')]);
  }
  for (const ev of f.evidence.slice(0, 8)) rows.push([BADGE[ev.confidence], `${ev.summary} (${ev.partition})`]);
  const alts = findingAlternatives(f);
  if (alts.length) rows.push(['Other explanations', alts.map((a) => a.text).join(' ')]);
  rows.push(['Method', `${f.analyzer.name} ${f.analyzer.version}`]);
  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<details><summary>Show the maths</summary><dl class="maths">${dl}</dl><p class="muted">${esc(findingFalsifier(f))}</p></details>`;
}

function findingItem(f: Finding, property: string, out?: AnalysisOutput): string {
  const label = f.reason === 'fact'
    ? `<span class="pill">${esc(BADGE.EXTRACTED)}</span>`
    : `${pill(f.real)} <span class="badge">${esc(BADGE[f.causeConfidence])}</span>`;
  return `<li>${label} <strong>${esc(f.unit.label)}</strong>` +
    `<br>${esc(findingSentence(f))}${checkLink(f, property)}${mathsDetails(f, out)}</li>`;
}

function findingList(items: Finding[], property: string, empty: string, out?: AnalysisOutput): string {
  if (!items.length) return `<p class="muted">${esc(empty)}</p>`;
  const shown = items.slice(0, TABLE_CAP).map((f) => findingItem(f, property, out)).join('');
  const more = items.length > TABLE_CAP ? `<li class="muted">and ${esc(fmtInt(items.length - TABLE_CAP))} more in findings.json</li>` : '';
  return `<ul class="findings">${shown}${more}</ul>`;
}

const byPriority = (a: Finding, b: Finding): number => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------- shared selections (also used by markdown.ts) ----------

export interface ReportSelections {
  head: Finding | null;
  alsoWorth: Finding[];
  templates: Finding[];
  pages: Finding[];
  queries: Finding[];
  aioEffects: Finding[];
  siteChangeFindings: Finding[];
  coverage: string;
  freshness: string | null;
  beforeRecording: boolean;
  noSiteChanges: boolean;
  rest: Map<Verdict, Finding[]>;
  facts: Finding[];
}

export function coverageSentence(out: AnalysisOutput): string {
  const f = out.findings.find((x) => x.template === 'coverage');
  if (f) return findingSentence(f);
  const share = out.diagnostics.namedClickShare;
  return renderSentence('coverage', { hidden: 1 - share, shown: share });
}

export function selectFindings(out: AnalysisOutput): ReportSelections {
  const sorted = [...out.findings].sort(byPriority);
  const head = headlineFinding(out);
  const shown = new Set<string>(head ? [head.id] : []);
  const take = (pred: (f: Finding) => boolean, cap = TABLE_CAP): Finding[] => {
    const xs = sorted.filter((f) => !shown.has(f.id) && pred(f));
    for (const f of xs.slice(0, cap)) shown.add(f.id);
    return xs;
  };
  const alsoWorth = sorted.filter((f) => f.id !== head?.id && f.real === 'signal' && f.kind !== 'update_impact').slice(0, 3);
  const templates = take((f) => f.kind === 'waterfall' && f.unit.level === 'template');
  const pages = take((f) => f.kind === 'waterfall' && f.unit.level === 'page');
  const queries = take((f) => f.kind === 'waterfall' && f.unit.level === 'query');
  const aioEffects = take((f) => f.kind === 'aio_effect');
  take((f) => f.kind === 'aio_fact');
  const siteChangeFindings = take((f) => f.kind === 'site_change_impact' || f.template === 'site_change_unseen');
  for (const f of sorted) if (f.kind === 'update_impact' || ['coverage', 'freshness', 'no_site_changes'].includes(f.template)) shown.add(f.id);
  const freshnessF = out.findings.find((f) => f.template === 'freshness');
  const remaining = sorted.filter((f) => !shown.has(f.id));
  const facts = remaining.filter((f) => f.causeConfidence === 'EXTRACTED' && f.reason === 'fact');
  const rest = new Map<Verdict, Finding[]>();
  for (const v of LABEL_ORDER) rest.set(v, remaining.filter((f) => f.real === v && !facts.includes(f)));
  return {
    head,
    alsoWorth,
    templates,
    pages,
    queries,
    aioEffects,
    siteChangeFindings,
    coverage: coverageSentence(out),
    freshness: freshnessF ? findingSentence(freshnessF) : null,
    beforeRecording: out.findings.some((f) => f.template === 'before_recording' || f.alternatives.some((a) => a.key === 'site_change_none_recorded')),
    noSiteChanges: out.siteChanges.length === 0,
    rest,
    facts,
  };
}

/** Weekly click totals for the last 16 weeks of sealed data (the answer's sparkline). */
export function weeklyClicks(out: AnalysisOutput, weeks = 16): number[] {
  const days = out.timeline.sealed.slice(-weeks * 7);
  const out2: number[] = [];
  for (let i = days.length % 7; i < days.length; i += 7) out2.push(days.slice(i, i + 7).reduce((s, d) => s + d.c, 0));
  return out2;
}

export function scorecardCells(row: UpdateRow, out: AnalysisOutput): { dates: string; clicks: string; impressions: string; verdict: string; notes: string } {
  const f = out.findings.find((x) => x.id === row.findingId);
  const dates = `${row.begin} to ${row.end ?? 'ongoing'}${row.endEstimated ? ' (end estimated)' : ''}`;
  const eff = (e: UpdateRow['clicks']): string => (e ? `${fmtPct(e.tau)} (${rangePct(e.ci95)})` : 'n/a');
  let verdict: string;
  if (row.status === 'too_recent') verdict = 'Too recent to judge';
  else if (row.status === 'before_history') verdict = 'Before your history';
  else if (row.status === 'skipped_discover') verdict = 'Discover, skipped';
  else verdict = REAL_LABEL[f?.real ?? row.clicks?.real ?? 'underpowered'];
  const notes: string[] = [];
  if (row.competing.length) {
    const titles = row.competing.map((id) => out.scorecard.find((r) => r.eventId === id)?.title ?? id);
    notes.push(`Overlaps ${titles.join(', ')}`);
  }
  if (row.status === 'partial' && row.window) notes.push('Partial window, still settling');
  if (row.checkAgainOn) notes.push(`Check again on ${fmtDate(row.checkAgainOn)}`);
  if (row.measurementOverlap) notes.push('A reporting change overlaps, so impressions are not comparable');
  if (row.siteChangesSeen > 0) notes.push(`${fmtInt(row.siteChangesSeen)} site change${row.siteChangesSeen === 1 ? '' : 's'} seen by Google around then`);
  return { dates, clicks: eff(row.clicks), impressions: eff(row.impressions), verdict, notes: notes.join('. ') };
}

export function siteChangeCells(c: SiteChange, out: AnalysisOutput): { what: string; pages: string; deployed: string; seen: string; outcome: string } {
  const seen = c.touched.map((t) => t.googleSeen).filter((g): g is NonNullable<typeof g> => g !== null);
  const day = (i: string): string => {
    try {
      return fmtDate(ptDate(i));
    } catch {
      return i;
    }
  };
  const seenText = seen.length
    ? `${day(seen.map((g) => g.from).sort()[0])} to ${day(seen.map((g) => g.to).sort()[seen.length - 1])} (${fmtInt(seen.length)} of ${fmtInt(c.touched.length)})`
    : 'Not recrawled yet';
  const impact = out.siteChangeImpacts.find((i) => i.siteChangeId === c.id);
  const outcome = impact
    ? `${REAL_LABEL[impact.real]}${impact.tau !== null ? `, ${fmtPct(impact.tau)} (${rangePct(impact.ci95)})` : ''}`
    : 'Not measured yet';
  const what = c.source === 'annotation' ? `Your note: ${c.text ?? ''}` : `${c.field} changed (${c.cls}) on ${c.templateKey}`;
  return { what, pages: fmtInt(c.touched.length), deployed: `${day(c.deployed.from)} to ${day(c.deployed.to)}`, seen: seenText, outcome };
}

export interface LadderRow { when: string; what: string; status: string }

export function ladder(out: AnalysisOutput, ctx: ReportContext): LadderRow[] {
  const serpOn = ctx.config.serp.provider === 'dataforseo';
  const facts = out.aio?.facts ?? [];
  return [
    {
      when: 'Tomorrow',
      what: 'A second snapshot of your pages, so changes you make from now on get a date.',
      status: out.siteChanges.some((c) => c.source === 'snapshot') ? 'Already true' : 'Not yet',
    },
    { when: 'Each day', what: "One more sealed day of Search Console data, and Google's recrawl dates for your busiest pages.", status: 'Running' },
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
      when: 'Month 16',
      what: "Your history goes past Search Console's 16-month limit.",
      status: out.diagnostics.historyDays > 486 ? 'Already true' : `Not yet (${fmtInt(out.diagnostics.historyDays)} days so far)`,
    },
  ];
}

const PHASE_LABEL: Record<string, string> = {
  lock: 'Lock', updates: 'Google updates', gsc: 'Search Console', index: 'Index', crawl: 'Your pages', inspect: 'Index checks',
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

// ---------- the page ----------

export function renderHtml(out: AnalysisOutput, ctx: ReportContext): string {
  const sel = selectFindings(out);
  const answer = answerSentences(out);
  const p = out.property;
  const s: string[] = [];

  s.push(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">`);
  s.push(`<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="referrer" content="no-referrer">`);
  s.push(`<title>${esc(`searchtrace report: ${p}`)}</title>\n<style>${CSS}</style>\n</head>\n<body>`);
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  s.push(`<header><h1>Why did your Google traffic change?</h1><p>${esc(p)} · data runs to ${esc(fmtDate(out.dataThrough))} (Pacific Time) · ` +
    `last ${esc(fmtInt(L))} days vs the ${esc(fmtInt(L))} before</p>`);
  if (ctx.demo) {
    s.push('<p class="demo">This is a demo on a made-up site (Pipewell Plumbing). None of these numbers are real; they show what each kind of answer looks like.</p>');
  }
  s.push('</header><main>');

  // 1. The answer
  s.push('<section id="answer"><h2>The answer</h2><div class="answer">');
  s.push(`<p>${esc(answer.sentence)}</p>`);
  if (answer.verdict) s.push(`<p>${esc(answer.verdict)}</p>`);
  s.push('</div>');
  if (!out.headline.boring && sel.head) {
    const cause = sel.head.cause ?? 'unknown';
    s.push(`<div class="labels"><span>Is it real?</span> ${pill(sel.head.real)} <span>Why?</span> <span class="pill">${esc(CAUSE_LABEL[cause])}</span>` +
      ` <span class="badge">${esc(BADGE[sel.head.causeConfidence])}</span></div>`);
    s.push(mathsDetails(sel.head, out));
  }
  const spark = sparklineSvg(weeklyClicks(out), { width: 240, height: 40, label: 'Weekly clicks, last 16 weeks' });
  if (spark) s.push(`<p class="muted">Weekly clicks, last 16 weeks</p>${spark}`);
  if (sel.alsoWorth.length) {
    s.push('<h3>Also worth knowing</h3>');
    s.push(findingList(sel.alsoWorth, p, '', out));
  }
  s.push('</section>');

  // 2. Where the clicks went
  s.push('<section id="waterfall"><h2>Where the clicks went</h2>');
  const site = out.scopes.find((x) => x.unit.level === 'site');
  if (site) {
    s.push(waterfallSvg(site));
    const rows = displayGroups(site.bars, site.ci95 as Record<string, [number, number]> | null);
    s.push('<table><thead><tr><th>Part</th><th class="num">Clicks</th><th class="num">95% range</th></tr></thead><tbody>');
    for (const r of rows) s.push(`<tr><td>${esc(r.label)}</td><td class="num">${esc(fmtSignedInt(r.value))}</td><td class="num">${esc(rangeInt(r.ci))}</td></tr>`);
    s.push(`<tr><td><strong>Total</strong></td><td class="num"><strong>${esc(fmtSignedInt(site.deltaClicks))}</strong></td><td class="num">${esc(rangeInt(site.ci95?.total))}</td></tr>`);
    s.push(`</tbody></table><p class="muted">${esc(REMAINDER_LABEL)}: counted in the parts above.</p>`);
  } else {
    s.push('<p class="muted">No click breakdown yet.</p>');
  }
  s.push(`<p>${esc(sel.coverage)}</p>`);
  const rec = out.diagnostics.reconciliation;
  s.push(`<p class="muted">Page totals ${esc(fmtInt(rec.byPageClicks))} clicks, property total ${esc(fmtInt(rec.byPropertyClicks))}.</p></section>`);

  // 3. Timeline
  s.push('<section id="timeline"><h2>Timeline</h2>');
  const tl = timelineSvg(out);
  s.push(tl ? tl + timelineLegend() : '<p class="muted">Not enough history to draw yet.</p>');
  if (sel.freshness) s.push(`<p class="muted">${esc(sel.freshness)}</p>`);
  s.push('</section>');

  // 4. Google update scorecard
  s.push('<section id="updates"><h2>Google update scorecard</h2>');
  const rows = [...out.scorecard].sort((a, b) => (a.begin < b.begin ? 1 : a.begin > b.begin ? -1 : 0));
  if (rows.length) {
    s.push('<table><thead><tr><th>Update</th><th>Dates</th><th>Clicks change (range)</th><th>Impressions change (range)</th><th>Verdict</th><th>Notes</th></tr></thead><tbody>');
    s.push(capRows(rows, (r) => {
      const c = scorecardCells(r, out);
      return `<tr><td>${esc(r.title)}</td><td>${esc(c.dates)}</td><td>${esc(c.clicks)}</td><td>${esc(c.impressions)}</td><td>${esc(c.verdict)}</td><td>${esc(c.notes)}</td></tr>`;
    }, 6, 'updates'));
    s.push('</tbody></table>');
  } else {
    s.push('<p class="muted">No Google updates overlap your data yet.</p>');
  }
  s.push('</section>');

  // 5. Pages and sections that moved
  s.push('<section id="pages"><h2>Pages and sections that moved</h2><h3>Sections of your site</h3>');
  s.push(findingList(sel.templates, p, 'No sections to compare yet.', out));
  s.push('<h3>Pages</h3>');
  s.push(findingList(sel.pages, p, 'No pages to compare yet.', out));
  s.push('</section>');

  // 6. Searches that moved
  s.push(`<section id="searches"><h2>Searches that moved</h2><p class="muted">${esc(sel.coverage)}</p>`);
  s.push(findingList(sel.queries, p, 'No searches to compare yet.', out));
  if (sel.aioEffects.length) {
    s.push('<h3>AI Overviews</h3>');
    s.push(findingList(sel.aioEffects, p, '', out));
  }
  const facts = out.aio?.facts ?? [];
  if (facts.length) {
    s.push('<h3>AI Overview checks</h3><table><thead><tr><th>Search</th><th>Device</th><th>AI Overview shown</th><th>Cites you?</th><th>Top cited sites</th><th>Title rewritten?</th></tr></thead><tbody>');
    s.push(capRows(facts, (x) => `<tr><td>${esc(x.keyword)}</td><td>${esc(x.device)}</td><td>${esc(`${x.aioChecks} of ${x.checks}`)}</td>` +
      `<td>${x.aioChecks > 0 ? (x.cited ? 'Yes' : 'No') : 'n/a'}</td><td>${esc(x.topDomains.slice(0, 3).join(', '))}</td>` +
      `<td>${x.titleRewritten === null ? 'n/a' : x.titleRewritten ? 'Yes' : 'No'}</td></tr>`, 6, 'searches'));
    s.push('</tbody></table>');
  }
  s.push('</section>');

  // 7. Your site changes
  s.push('<section id="changes"><h2>Your site changes</h2>');
  if (out.siteChanges.length) {
    s.push('<table><thead><tr><th>What changed</th><th class="num">Pages</th><th>When (deployed)</th><th>Google saw it</th><th>Outcome</th></tr></thead><tbody>');
    s.push(capRows(out.siteChanges, (c) => {
      const x = siteChangeCells(c, out);
      return `<tr><td>${esc(x.what)}</td><td class="num">${esc(x.pages)}</td><td>${esc(x.deployed)}</td><td>${esc(x.seen)}</td><td>${esc(x.outcome)}</td></tr>`;
    }, 5, 'changes'));
    s.push('</tbody></table>');
    s.push(findingList(sel.siteChangeFindings, p, '', out));
  } else {
    s.push(`<p>${esc(renderSentence('no_site_changes', {}))}</p>`);
  }
  if (sel.beforeRecording) s.push(`<p>${esc(renderSentence('before_recording', {}))}</p>`);
  s.push('</section>');

  // 8. What we checked and what we couldn't
  s.push("<section id=\"checked\"><h2>What we checked and what we couldn't</h2>");
  let anyRest = false;
  for (const v of LABEL_ORDER) {
    const xs = sel.rest.get(v) ?? [];
    if (!xs.length) continue;
    anyRest = true;
    s.push(`<h3>${esc(REAL_LABEL[v])}</h3>${findingList(xs, p, '', out)}`);
  }
  if (sel.facts.length) {
    anyRest = true;
    s.push(`<h3>${esc(BADGE.EXTRACTED)} facts</h3>${findingList(sel.facts, p, '', out)}`);
  }
  if (!anyRest) s.push('<p class="muted">Everything we found is shown above.</p>');
  const d = out.diagnostics;
  const B = Object.entries(d.bootstrapB).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a';
  s.push('<details><summary>Show the maths for the whole report</summary><dl class="maths">' +
    `<dt>Click-rate curve strength (m)</dt><dd>${esc(fmtInt(out.curve.m))}</dd>` +
    `<dt>Curve fitted on</dt><dd>${esc(`${out.curve.fitWindow[0]} to ${out.curve.fitWindow[1]}`)}</dd>` +
    `<dt>Unstable curve segments</dt><dd>${esc(out.curve.unstable.join(', ') || 'none')}</dd>` +
    `<dt>Bootstrap replicates (B)</dt><dd>${esc(B)}</dd>` +
    `<dt>Searches named by Google</dt><dd>${esc(fmtAbsPct(d.namedClickShare))} of clicks</dd>` +
    `<dt>Days of history</dt><dd>${esc(fmtInt(d.historyDays))}</dd>` +
    `<dt>Days cut off at the row limit</dt><dd>${esc(d.truncatedDays.length ? d.truncatedDays.join(', ') : 'none')}</dd>` +
    `<dt>Revised days</dt><dd>${esc(fmtInt(d.revisions))}</dd>` +
    `<dt>Brand words</dt><dd>${esc(d.brandTokens.join(', ') || 'none')}</dd>` +
    `<dt>Inputs hash</dt><dd>${esc(out.inputsHash)}</dd>` +
    `</dl><p>${externalLink(METHODOLOGY_URL, 'How every number is worked out (methodology)')}</p></details>`);
  s.push('</section>');

  // 9. What gets smarter next
  s.push('<section id="next"><h2>What gets smarter next</h2><table class="ladder"><tbody>');
  for (const r of ladder(out, ctx)) s.push(`<tr><td>${esc(r.when)}</td><td>${esc(r.what)}</td><td>${esc(r.status)}</td></tr>`);
  s.push('</tbody></table></section>');

  // 10. Run ledger
  s.push('<section id="ledger"><h2>Run ledger</h2>');
  const run = ctx.run;
  if (run && run.phases.length) {
    s.push('<table><thead><tr><th>Step</th><th>Status</th><th class="num">Requests</th><th class="num">Rows</th><th class="num">Cost</th><th>Notes</th></tr></thead><tbody>');
    for (const ph of run.phases) {
      const req = Object.values(ph.requests).reduce((a, b) => a + b, 0);
      s.push(`<tr><td>${esc(phaseLabel(ph.name))}</td><td>${esc(statusWord(ph.status))}</td><td class="num">${esc(fmtInt(req))}</td>` +
        `<td class="num">${esc(fmtInt(ph.rows))}</td><td class="num">${esc(fmtMoney(ph.costUsd))}</td><td>${esc(ph.notes.join(' '))}</td></tr>`);
    }
    s.push(`</tbody></table><p>Cost this run: ${esc(fmtMoney(run.spendUsd))}.</p>`);
  } else {
    s.push('<p class="muted">This report was rebuilt from saved data, so no collection ran.</p>');
  }
  if (sel.freshness) s.push(`<p>${esc(sel.freshness)}</p>`);
  s.push(`<p class="muted">searchtrace ${esc(ctx.toolVersion)} · data through ${esc(out.dataThrough)}</p>`);
  s.push('</section></main>');
  s.push(`<footer><p>Made with searchtrace ${esc(ctx.toolVersion)}. Your data stays in your own folder. ` +
    `${externalLink(METHODOLOGY_URL, 'Methodology')}</p></footer>\n</body>\n</html>\n`);
  return s.join('\n');
}

export function renderReports(out: AnalysisOutput, ctx: ReportContext): { html: string; md: string; json: string } {
  return { html: renderHtml(out, ctx), md: renderMarkdown(out, ctx), json: renderFindingsJson(out, ctx) };
}
