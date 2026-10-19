// Terminal evidence chain for `searchtrace why` (6.4.3). Owner: WP-F.
//
// Matching rules: no target shows the headline; a finding id shows that finding; a target
// starting with "/" or "http" matches pages by path (exact first, then suffix); an ISO date
// matches findings whose date, date window or windows contain it, plus Google events that day;
// anything else matches searches, case-insensitively. Nothing matched prints the 5 closest labels.
// Untrusted text (queries, titles, notes) has control characters removed so it cannot drive the terminal.
import { styleText } from 'node:util';
import { addDays, diffDays } from '../core/time.js';
import { normalizeUrl, pathOf } from '../core/url.js';
import type { AnalysisOutput, Finding, UpdateRow } from '../core/types.js';
import {
  BADGE, CAUSE_LABEL, answerSentences, findingAlternatives, findingFalsifier, findingSentence, headlineFinding, realLabel, remainderNote,
  renderSentence, shownGroups, unitDisplay, whyText,
} from './copy.js';
import { eventName, fmtDate, fmtSignedInt } from './format.js';
import { verifyLink } from './gsc-links.js';
import { reconciledFor, reconciledSentence } from './html.js';

const WIDTH = 100;
const FINDING_ID_RE = /^f[a-z2-7]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface WhyMatch {
  kind: 'headline' | 'finding' | 'page' | 'template' | 'date' | 'query' | 'none';
  findings: Finding[];
  events: UpdateRow[];
  suggestions: string[];
}

/** Removes terminal control characters (ESC, CR, BEL and friends) from untrusted text. */
export function cleanTerminal(s: string): string {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '?');
}

const byPriority = (a: Finding, b: Finding): number => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function safePath(u: string): string | null {
  try {
    return pathOf(normalizeUrl(u));
  } catch {
    return null;
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function eventEnd(r: UpdateRow): string {
  return r.end ?? addDays(r.begin, 14);
}

function closest(out: AnalysisOutput, target: string): string[] {
  const t = target.toLowerCase();
  const labels = new Set<string>();
  for (const f of out.findings) labels.add(f.unit.label);
  for (const r of out.scorecard) labels.add(r.title);
  return [...labels]
    .map((l) => ({ l, d: levenshtein(t, l.toLowerCase().slice(0, Math.max(t.length + 8, 12))) }))
    .sort((a, b) => a.d - b.d || (a.l < b.l ? -1 : a.l > b.l ? 1 : 0))
    .slice(0, 5)
    .map((x) => x.l);
}

/** Finds what a `why` target refers to. */
export function matchWhy(out: AnalysisOutput, target: string | null): WhyMatch {
  const sorted = [...out.findings].sort(byPriority);
  const t = (target ?? '').trim();
  const none = (): WhyMatch => ({ kind: 'none', findings: [], events: [], suggestions: closest(out, t) });
  if (t === '') {
    const h = headlineFinding(out);
    return { kind: 'headline', findings: h ? [h] : [], events: [], suggestions: [] };
  }
  if (FINDING_ID_RE.test(t)) {
    const f = out.findings.find((x) => x.id === t);
    return f ? { kind: 'finding', findings: [f], events: [], suggestions: [] } : none();
  }
  // A section of the site, by its template key: "/blog/*" (also "/blog/" and "/blog").
  if (t.startsWith('/')) {
    const bare = (k: string): string => k.replace(/\/?\*$/, '');
    const tpl = sorted.filter((f) => f.unit.level === 'template' && (f.unit.key === t || bare(f.unit.key) === t.replace(/\/$/, '')));
    // Lead with the section's own explanation (its waterfall), then site-change impacts, then the rest.
    const rank = (f: Finding): number => (f.kind === 'waterfall' ? 0 : f.kind === 'site_change_impact' ? 1 : 2);
    tpl.sort((a, b) => rank(a) - rank(b));
    if (tpl.length && t !== '/') return { kind: 'template', findings: tpl, events: [], suggestions: [] };
  }
  if (t.startsWith('/') || /^https?:\/\//i.test(t)) {
    const isUrl = /^https?:\/\//i.test(t);
    const wantUrl = isUrl ? (() => { try { return normalizeUrl(t); } catch { return null; } })() : null;
    const wantPath = isUrl ? safePath(t) : t;
    if (wantPath === null) return none();
    const pageKeys = new Set(sorted.filter((f) => f.unit.level === 'page').map((f) => f.unit.key));
    const keys = [...pageKeys];
    let hit = keys.filter((k) => (wantUrl ? k === wantUrl : safePath(k) === wantPath));
    if (!hit.length) hit = keys.filter((k) => (safePath(k) ?? '').endsWith(wantPath) && wantPath !== '/');
    if (!hit.length) return none();
    const set = new Set(hit);
    // Like a section: lead with the page's own 28-day explanation (its waterfall), then the rest.
    const rank = (f: Finding): number => (f.kind === 'waterfall' ? 0 : f.kind === 'site_change_impact' ? 1 : 2);
    const findings = sorted
      .filter((f) => set.has(f.unit.key) || (f.verify?.page !== undefined && set.has(f.verify.page)))
      .sort((a, b) => rank(a) - rank(b) || byPriority(a, b));
    return { kind: 'page', findings, events: [], suggestions: [] };
  }
  if (ISO_RE.test(t)) {
    const inside = (w: [string, string] | null | undefined): boolean => !!w && w[0] <= t && t <= w[1];
    const exact = sorted.filter((f) => f.date === t || inside(f.dateWindow));
    const windowed = sorted.filter((f) => !exact.includes(f) && f.windows && (inside(f.windows.baseline) || inside(f.windows.current)));
    const events = out.scorecard.filter((r) => r.begin <= t && t <= eventEnd(r));
    if (!exact.length && !windowed.length && !events.length) return none();
    return { kind: 'date', findings: [...exact, ...windowed], events, suggestions: [] };
  }
  const q = t.replace(/^["']|["']$/g, '').toLowerCase();
  const queryOf = (f: Finding): string => (f.unit.level === 'query' ? f.unit.key : typeof f.slots.query === 'string' ? f.slots.query : '').toLowerCase();
  const exact = sorted.filter((f) => queryOf(f) === q);
  const partial = sorted.filter((f) => !exact.includes(f) && queryOf(f) !== '' && queryOf(f).includes(q));
  const findings = [...exact, ...partial];
  return findings.length ? { kind: 'query', findings, events: [], suggestions: [] } : none();
}

function wrap(text: string, indent: string, width = WIDTH): string[] {
  const words = cleanTerminal(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

function period(f: Finding): string {
  if (f.windows) {
    const L = diffDays(f.windows.current[0], f.windows.current[1]) + 1;
    return `last ${L} days vs the ${L} before`;
  }
  if (f.dateWindow && f.date) {
    return f.dateWindow[0] === f.dateWindow[1]
      ? `around ${fmtDate(f.date)}`
      : `around ${fmtDate(f.date)} (likely ${fmtDate(f.dateWindow[0])} to ${fmtDate(f.dateWindow[1])})`;
  }
  if (f.date) return `on ${fmtDate(f.date)}`;
  return 'latest data';
}

function rangeText(ci: [number, number] | null): string {
  return ci ? `(${fmtSignedInt(ci[0])} to ${fmtSignedInt(ci[1])})` : '';
}

interface Paint { bold(s: string): string; dim(s: string): string }

/** "Real change · Why: Your change (Estimated)", with the Why part only when there is a cause to name. */
function labelText(f: Finding): string {
  if (f.reason === 'fact') return BADGE.EXTRACTED;
  const why = whyText(f);
  return `${realLabel(f)}${why ? ` · ${why}` : ''}`;
}

function evidenceChain(out: AnalysisOutput, f: Finding, paint: Paint, o: { headline: boolean }): string[] {
  const lines: string[] = [];
  const header = o.headline ? `${out.property} · ${period(f)}` : `${unitDisplay(f.unit)} · ${period(f)}`;
  lines.push(paint.bold(cleanTerminal(header)), '');
  // A 28-day comparison that dilutes a real step inside the window leads with the step, never "Nothing to act on".
  const cp = o.headline ? null : reconciledFor(f, out);
  lines.push(`  ${paint.bold(labelText(cp ?? f))}`);
  if (o.headline) {
    const a = answerSentences(out);
    lines.push(...wrap(a.sentence, '  '));
    if (a.verdict) lines.push(...wrap(a.verdict, '  '));
  } else {
    lines.push(...wrap(cp ? reconciledSentence(f, cp, out) : findingSentence(f), '  '));
  }

  const scope = o.headline ? out.scopes.find((s) => s.unit.level === 'site') : null;
  const bars = scope ? scope.bars : f.components;
  const ci = scope ? scope.ci95 : f.componentCi95;
  if (bars) {
    lines.push('', '  Where the clicks went (estimated, 95% range)');
    for (const g of shownGroups(bars, ci as Record<string, [number, number]> | null)) {
      lines.push(`    ${g.label.padEnd(32)}${fmtSignedInt(g.value).padStart(6)}    ${rangeText(g.ci)}`.trimEnd());
    }
    // The total's range is the "is it real?" one, the same as the answer's.
    const total = o.headline && scope ? scope.deltaClicks : f.effect.absolute;
    if (total !== null) lines.push(`    ${'Total'.padEnd(32)}${fmtSignedInt(total).padStart(6)}    ${rangeText(f.effect.absoluteCi95)}`.trimEnd());
    if (['site', 'template', 'page'].includes(f.unit.level)) lines.push(...wrap(remainderNote(1 - out.diagnostics.namedClickShare), '    '));
  }

  // The terminal shows what was measured; statistics and file paths live in --json and "Show the maths".
  const evidence = f.evidence.filter((e) => e.type !== 'statistic');
  if (evidence.length) {
    lines.push('', '  Evidence');
    for (const e of evidence.slice(0, 8)) {
      const head = `    ${BADGE[e.confidence].padEnd(10)} `;
      const body = wrap(e.summary, ' '.repeat(head.length));
      if (body.length) body[0] = head + body[0].trimStart();
      lines.push(...body);
    }
  }
  const alts = findingAlternatives(f);
  if (alts.length) {
    lines.push('', '  Other explanations');
    for (const a of alts) lines.push(...wrap(a.text, '    '));
  }
  lines.push('');
  lines.push(...wrap(findingFalsifier(f), '  '));
  const v = verifyLink(out.property, f, out.diagnostics.brandTokens);
  if (v) {
    lines.push(`  Check it yourself: ${v.url}`);
    if (v.note) lines.push(...wrap(`(${v.note})`, '  '));
  }
  return lines;
}

function shortLine(f: Finding, paint: Paint): string[] {
  return [
    `  ${paint.bold(labelText(f))}  ${cleanTerminal(unitDisplay(f.unit))}`,
    ...wrap(findingSentence(f), '    '),
  ];
}

function eventLines(r: UpdateRow): string[] {
  const kind = r.kind === 'data_anomaly' ? CAUSE_LABEL.data_anomaly : r.kind === 'outage' ? CAUSE_LABEL.outage : 'Google update';
  const span = r.end === r.begin ? fmtDate(r.begin) : `${fmtDate(r.begin)} to ${r.end ? fmtDate(r.end) : 'ongoing'}`;
  const lines = [cleanTerminal(`  ${eventName(r.title)} (${kind}, ${span})`)];
  if (r.kind === 'data_anomaly') {
    lines.push(...wrap(renderSentence('reporting_artefact', { metric: 'impressions and average position', date: r.begin, event: r.title }), '    '));
  }
  return lines;
}

export function renderWhy(out: AnalysisOutput, target: string | null, o: { color: boolean }): string {
  const paint: Paint = o.color
    ? { bold: (s) => styleText('bold', s, { validateStream: false }), dim: (s) => styleText('dim', s, { validateStream: false }) }
    : { bold: (s) => s, dim: (s) => s };
  const m = matchWhy(out, target);
  const lines: string[] = [];
  switch (m.kind) {
    case 'none': {
      lines.push(cleanTerminal(`Nothing matched "${target ?? ''}".`));
      if (m.suggestions.length) {
        lines.push('Closest:');
        for (const s of m.suggestions) lines.push(cleanTerminal(`  ${s}`));
      }
      lines.push('', 'Try a page path like /pricing, a search in quotes, a date like 2026-09-14, or a finding id.');
      break;
    }
    case 'headline': {
      const f = m.findings[0];
      if (!f) {
        const a = answerSentences(out);
        lines.push(...wrap(a.sentence, ''));
        break;
      }
      lines.push(...evidenceChain(out, f, paint, { headline: true }));
      break;
    }
    case 'finding':
    case 'page':
    case 'template':
    case 'query': {
      const [first, ...rest] = m.findings;
      // The same sentence twice (a section and its site change) adds nothing: show it once. A change
      // point folded into the lead's own story is not repeated either.
      const folded = reconciledFor(first, out);
      const shown = new Set([findingSentence(first), ...(folded ? [findingSentence(folded)] : [])]);
      const others = rest.filter((f) => f.id !== folded?.id && !shown.has(findingSentence(f)) && shown.add(findingSentence(f)));
      lines.push(...evidenceChain(out, first, paint, { headline: first.kind === 'headline' }));
      if (others.length) {
        const about = m.kind === 'query' ? 'Also about this search' : m.kind === 'template' ? 'Also about this section' : 'Also about this page';
        lines.push('', paint.bold(about));
        for (const f of others.slice(0, 5)) lines.push(...shortLine(f, paint));
        if (others.length > 5) lines.push(`  and ${others.length - 5} more (add --json to see them all)`);
      }
      break;
    }
    case 'date': {
      const day = target ?? '';
      lines.push(paint.bold(cleanTerminal(`${out.property} · ${fmtDate(day)}`)), '');
      if (m.events.length) {
        lines.push(paint.bold('Google events around then'));
        for (const r of m.events) lines.push(...eventLines(r));
        lines.push('');
      }
      if (m.findings.length) {
        lines.push(paint.bold('Findings that cover this date'));
        for (const f of m.findings.slice(0, 8)) lines.push(...shortLine(f, paint));
        if (m.findings.length > 8) lines.push(`  and ${m.findings.length - 8} more (add --json to see them all)`);
      }
      break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
