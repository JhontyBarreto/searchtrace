// findings.json serialisation: sorted keys, 4-decimal rounding, no run id or wall clock (6.6). Owner: WP-F.
//
// The same AnalysisOutput always gives the same bytes (D24), so re-running on unchanged data
// leaves git with nothing to commit. Nothing from the run (ids, times, request counts) goes in.
import type { AnalysisOutput, Finding, ReportContext, SiteChange } from '../core/types.js';
import { gscLink } from './gsc-links.js';
import { BADGE, CAUSE_LABEL, REAL_LABEL, answerSentences, findingAlternatives, findingFalsifier, findingSentence, headlineFinding } from './copy.js';

/** Rounds to 4 decimals; -0 becomes 0; non-finite numbers become null (JSON has no Infinity). */
export function round4(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const r = Math.round(x * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}

/** Plain JSON data with object keys sorted at every level and numbers rounded to 4 decimals. */
export function stableValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return round4(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : stableValue(x)));
  if (v instanceof Map) return stableValue(Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), x])));
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const x = obj[k];
      if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
      out[k] = stableValue(x);
    }
    return out;
  }
  return null;
}

/** Byte-stable JSON text: sorted keys, 4-decimal numbers, two-space indent, trailing newline. */
export function stableStringify(v: unknown, indent = 2): string {
  return `${JSON.stringify(stableValue(v), null, indent)}\n`;
}

/** Compact canonical form, used to compare findings across runs. */
export function canonicalString(v: unknown): string {
  return JSON.stringify(stableValue(v));
}

/** One finding in the findings.json shape (6.6). */
export function findingToJson(f: Finding, property: string): Record<string, unknown> {
  const power = f.power
    ? { mde: f.power.mde, weeks_needed: f.power.weeksNeeded, not_measurable: f.power.notMeasurable, per_week: f.power.perWeek }
    : null;
  return {
    id: f.id,
    kind: f.kind,
    unit: { level: f.unit.level, key: f.unit.key, label: f.unit.label, ...(f.unit.device ? { device: f.unit.device } : {}) },
    metric: f.metric,
    windows: f.windows,
    date: f.date,
    date_window: f.dateWindow,
    real: f.real,
    real_label: REAL_LABEL[f.real],
    reason: f.reason,
    cause: f.cause,
    cause_label: f.cause ? CAUSE_LABEL[f.cause] : null,
    confidence: f.causeConfidence,
    badge: BADGE[f.causeConfidence],
    template: f.template,
    sentence: findingSentence(f),
    effect: {
      estimate: f.effect.estimate,
      ci95: f.effect.ci95,
      absolute: f.effect.absolute,
      absolute_ci95: f.effect.absoluteCi95,
      p: f.effect.p,
      q: f.effect.q,
    },
    components: f.components,
    component_ci95: f.componentCi95,
    power,
    evidence: f.evidence.map((e) => ({
      type: e.type, confidence: e.confidence, partition: e.partition, summary: e.summary, ...(e.key ? { key: e.key } : {}),
    })),
    alternatives: findingAlternatives(f).map((a) => ({ cause: a.cause, ruled_out: a.ruledOut, text: a.text })),
    falsifier: findingFalsifier(f),
    verify_url: f.verify ? gscLink(property, f.verify) : null,
    related: { google_events: f.related.googleEvents, site_changes: f.related.siteChanges, findings: f.related.findings },
    analyzer: f.analyzer,
    priority: f.priority,
  };
}

const MAX_TOUCHED_IN_JSON = 50;

function siteChangeSummary(c: SiteChange): Record<string, unknown> {
  const seen = c.touched.filter((t) => t.googleSeen !== null);
  return {
    id: c.id,
    source: c.source,
    field: c.field,
    cls: c.cls,
    templateKey: c.templateKey,
    signature: c.signature,
    deployed: c.deployed,
    text: c.text,
    touchedCount: c.touched.length,
    seenCount: seen.length,
    touched: c.touched.slice(0, MAX_TOUCHED_IN_JSON),
  };
}

export function renderFindingsJson(out: AnalysisOutput, ctx: ReportContext): string {
  const head = headlineFinding(out);
  const answer = answerSentences(out);
  const real = head?.real ?? out.headline.clicks.real;
  const doc = {
    schema_version: 1,
    generator: 'searchtrace',
    tool_version: ctx.toolVersion,
    demo: ctx.demo ? true : undefined,
    property: out.property,
    site_domain: out.siteDomain,
    data_through: out.dataThrough,
    windows: { baseline: out.windows.baseline, current: out.windows.current },
    inputs_hash: out.inputsHash,
    headline: {
      finding_id: out.headline.findingId,
      sentence: answer.sentence,
      verdict_sentence: answer.verdict,
      real,
      real_label: REAL_LABEL[real],
      boring: out.headline.boring,
      clicks: out.headline.clicks,
      impressions: out.headline.impressions,
    },
    findings: out.findings.map((f) => findingToJson(f, out.property)),
    scorecard: out.scorecard,
    change_points: out.changePoints,
    site_changes: out.siteChanges.map(siteChangeSummary),
    site_change_impacts: out.siteChangeImpacts,
    aio: out.aio ? { facts: out.aio.facts, estimates: out.aio.estimates } : { facts: [], estimates: [] },
    curve: { m: out.curve.m, unstable: out.curve.unstable, fit_window: out.curve.fitWindow },
    diagnostics: out.diagnostics,
  };
  return stableStringify(doc);
}
