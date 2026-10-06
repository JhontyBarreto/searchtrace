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
  BADGE, CAUSE_LABEL, REAL_LABEL, REMAINDER_LABEL, answerSentences, displayGroups, findingAlternatives, findingFalsifier,
  findingSentence, headlineFinding, renderSentence,
} from './copy.js';
import { fmtDate, fmtSignedInt } from './format.js';
import { gscLink } from './gsc-links.js';

const WIDTH = 100;
const FINDING_ID_RE = /^f[a-z2-7]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface WhyMatch {
  kind: 'headline' | 'finding' | 'page' | 'date' | 'query' | 'none';
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
    const findings = sorted.filter((f) => set.has(f.unit.key) || (f.verify?.page !== undefined && set.has(f.verify.page)));
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
  if (f.dateWindow && f.date) return `around ${fmtDate(f.date)} (likely ${fmtDate(f.dateWindow[0])} to ${fmtDate(f.dateWindow[1])})`;
  if (f.date) return `on ${fmtDate(f.date)}`;
  return 'latest data';
}

function rangeText(ci: [number, number] | null): string {
  return ci ? `(${fmtSignedInt(ci[0])} to ${fmtSignedInt(ci[1])})` : '';
}

interface Paint { bold(s: string): string; dim(s: string): string }

function evidenceChain(out: AnalysisOutput, f: Finding, paint: Paint, o: { headline: boolean }): string[] {
  const lines: string[] = [];
  const header = o.headline ? `${out.property} · ${period(f)}` : `${f.unit.label} · ${period(f)}`;
  lines.push(paint.bold(cleanTerminal(header)), '');
  lines.push(`  ${paint.bold(REAL_LABEL[f.real])} · Why: ${CAUSE_LABEL[f.cause ?? 'unknown']} · ${BADGE[f.causeConfidence]}`);
  if (o.headline) {
    const a = answerSentences(out);
    lines.push(...wrap(a.sentence, '  '));
    if (a.verdict) lines.push(...wrap(a.verdict, '  '));
  } else {
    lines.push(...wrap(findingSentence(f), '  '));
  }

  const scope = o.headline ? out.scopes.find((s) => s.unit.level === 'site') : null;
  const bars = scope ? scope.bars : f.components;
  const ci = scope ? scope.ci95 : f.componentCi95;
  if (bars) {
    lines.push('', '  Where the clicks went (estimated, 95% range)');
    for (const g of displayGroups(bars, ci as Record<string, [number, number]> | null)) {
      if ((g.group === 'aioCitation' || g.group === 'churn') && g.value === 0 && !g.ci) continue;
      lines.push(`    ${g.label.padEnd(32)}${fmtSignedInt(g.value).padStart(6)}    ${rangeText(g.ci)}`.trimEnd());
    }
    if (['site', 'template', 'page'].includes(f.unit.level)) {
      const [name, rest] = REMAINDER_LABEL.split(' (');
      lines.push(`    ${name.padEnd(32)}${' '.repeat(6)}    (${rest}`);
    }
  }

  if (f.evidence.length) {
    lines.push('', '  Evidence');
    for (const e of f.evidence.slice(0, 8)) {
      lines.push(cleanTerminal(`    ${BADGE[e.confidence].padEnd(10)} ${e.summary}   ${e.partition}`));
    }
  }
  const alts = findingAlternatives(f);
  if (alts.length) {
    lines.push('', '  Other explanations');
    for (const a of alts) lines.push(...wrap(a.text, '    '));
  }
  lines.push('');
  lines.push(...wrap(findingFalsifier(f), '  '));
  if (f.verify) lines.push(`  Check it yourself: ${gscLink(out.property, f.verify)}`);
  return lines;
}

function shortLine(f: Finding, paint: Paint): string[] {
  const label = f.reason === 'fact' ? BADGE.EXTRACTED : `${REAL_LABEL[f.real]} · ${BADGE[f.causeConfidence]}`;
  return [
    `  ${paint.bold(label)}  ${cleanTerminal(f.unit.label)}`,
    ...wrap(findingSentence(f), '    '),
  ];
}

function eventLines(r: UpdateRow): string[] {
  const kind = r.kind === 'data_anomaly' ? CAUSE_LABEL.data_anomaly : r.kind === 'outage' ? CAUSE_LABEL.outage : 'Google update';
  const lines = [cleanTerminal(`  ${r.title} (${kind}, ${fmtDate(r.begin)} to ${r.end ? fmtDate(r.end) : 'ongoing'})`)];
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
    case 'query': {
      const [first, ...others] = m.findings;
      lines.push(...evidenceChain(out, first, paint, { headline: first.kind === 'headline' }));
      if (others.length) {
        lines.push('', paint.bold(m.kind === 'query' ? 'Also about this search' : 'Also about this page'));
        for (const f of others.slice(0, 5)) lines.push(...shortLine(f, paint));
        if (others.length > 5) lines.push(`  and ${others.length - 5} more (searchtrace why --json)`);
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
        if (m.findings.length > 8) lines.push(`  and ${m.findings.length - 8} more (searchtrace why ${day} --json)`);
      }
      break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
