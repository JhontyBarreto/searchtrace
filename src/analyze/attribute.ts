// Synthesis: headline, cause per scope, template choice, alternatives, falsifiers, priorities (5.12). Owner: WP-E.
//
// Slots convention (E fills, F renders with report/format.ts):
//   - numbers stay raw: percentages are signed fractions (pct -0.12 means -12%), clicks are counts,
//     positions are positions, click rates are fractions, money is USD;
//   - dates are IsoDate strings; direction is 'down' | 'up'; level is 'high' | 'medium' | 'low';
//   - enum slots carry the enum value for F to map, never English: `check` holds the failed
//     IdCheckName (F builds reason_text), `impr_real` the impressions Verdict (F builds impr_sentence),
//     `yoy` plus `pct` (F builds yoy_sentence), mixed `a` / `b` a Cause (or an update title);
//   - a slot whose value is unknown is left out (freq when there are under 8 historical window pairs).
import { addDays, diffDays, ptDate } from '../core/time.js';
import { findingId } from '../core/ids.js';
import { pathOf } from '../core/url.js';
import type {
  AltKey, AnalysisUnit, AnalysisWindows, Bars, Cause, ChangePoint, Confidence, EvidenceRef, FalsifierKey, Finding, GoogleEvent,
  IdCheck, IdCheckName, IsoDate, PeriodEffect, PowerInfo, ScopeDecomposition, SiteChange, SiteChangeImpact, TemplateId, Verdict,
  VerdictReason,
} from '../core/types.js';
import { GROUPS, type Group } from './waterfall.js';
import { windowsOverlap } from './windows.js';

export const ANALYZER = { name: 'attribute', version: '1' } as const;

// ---------------------------------------------------------------------------
// Priority and ordering
// ---------------------------------------------------------------------------

const TIER: Record<Verdict, number> = { signal: 1000, unclear: 100, underpowered: 10, noise: 1 };
const FACT_TIER = 5;

/** Priority rule from 5.12: headline 1e9, otherwise tier x max(1, |absolute clicks|), plus 0.5 for update_impact. */
export function findingPriority(f: Finding): number {
  if (f.kind === 'headline') return 1e9;
  const tier = f.reason === 'fact' || f.causeConfidence === 'EXTRACTED' ? FACT_TIER : TIER[f.real] ?? 1;
  const abs = f.metric === 'clicks' && f.effect.absolute !== null && Number.isFinite(f.effect.absolute) ? Math.abs(f.effect.absolute) : 0;
  return tier * Math.max(1, abs) + (f.kind === 'update_impact' ? 0.5 : 0);
}

/** Priority descending, then id ascending. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface SynthesisContext {
  dataThrough: IsoDate;
  windows: AnalysisWindows;
  windowDays: number;
  events: GoogleEvent[];
  changePoints: ChangePoint[];
  siteChanges: SiteChange[];
  siteChangeImpacts: SiteChangeImpact[];
  /** Ids of findings by site change id, for related links. */
  impactFindingIds: Map<string, string>;
  /** The AIO DiD estimate is a signal. */
  aioDidSignal: boolean;
  aioDid: { tau: number | null; ci95: [number, number] | null } | null;
  /** Earliest crawl snapshot, or null when the site has never been snapshotted. */
  firstSnapshot: IsoDate | null;
  /** Data-dir path of the newest sealed GSC day, for evidence. */
  gscPartition: string;
  costPerCheck: number;
}

/** Everything the synthesis needs about one scope (index.ts fills it). */
export interface ScopeFacts {
  unit: AnalysisUnit;
  decomposition: ScopeDecomposition;
  groupCi: Record<Group, [number, number]> | null;
  pages: Set<string>;
  baseImpressions: number;
  curImpressions: number;
  /** Named units only: impression-weighted positions and click rates per window. */
  pb: number | null;
  pc: number | null;
  ctrB: number | null;
  ctrC: number | null;
  /** Distinct searches whose average position moved in the direction of the change (by at least 0.5). */
  movedSearches: number;
  /** Share of the scope's negative samePos held by queries with SERP checks, and by uncited AI Overview queries. */
  checkedShare: number;
  aioUncitedShare: number;
  /** Queries with at least one SERP check, and of those how many showed an AI Overview. */
  checkedQueries: number;
  aioQueries: number;
  /** SERP candidates in this scope, for the "we haven't checked" cost line. */
  candidates: number;
  /** Units carry a fallback flag (k_fallback) or a curve_unstable share. */
  kFallback: boolean;
  unstableShare: number;
  topSegment: string;
  /** Last year's impression change over the seasonal windows, when known. */
  yoy: number | null;
  /** p (bootstrap) and q (BH family 2; for the site the headline's own p). */
  p: number | null;
  q: number | null;
  floorsMet: boolean;
  delta: number;
  phi: number;
  /** Impressions change and verdict for the "impressions, which have far more data" sentence. */
  impressions: { tau: number; real: Verdict } | null;
}

export interface CauseResult {
  cause: Cause;
  template: TemplateId;
  groups: Group[];
  ambiguous: boolean;
  slots: Record<string, string | number>;
  related: { siteChanges: string[]; findings: string[] };
  impact: SiteChangeImpact | null;
  /** The cause relies on click-rate bars (rank or samePos), so curve stability matters. */
  usesCurve: boolean;
}

const direction = (delta: number): 'down' | 'up' => (delta < 0 ? 'down' : 'up');
const excludesZero = (ci: [number, number] | undefined | null): boolean => !!ci && (ci[0] > 0 || ci[1] < 0);
const eventEnd = (e: GoogleEvent): IsoDate => ptDate(e.end ?? new Date(Date.parse(e.begin) + 14 * 86_400_000).toISOString());
const eventSpan = (e: GoogleEvent): [IsoDate, IsoDate] => [ptDate(e.begin), eventEnd(e)];
const isUpdate = (e: GoogleEvent): boolean => e.kind === 'core' || e.kind === 'spam';

/** Events of the given kinds whose PT span overlaps w, latest first. */
export function eventsOverlapping(events: GoogleEvent[], w: [IsoDate, IsoDate], kinds: GoogleEvent['kind'][]): GoogleEvent[] {
  return events
    .filter((e) => kinds.includes(e.kind) && windowsOverlap(eventSpan(e), w))
    .sort((a, b) => (a.begin < b.begin ? 1 : a.begin > b.begin ? -1 : a.id < b.id ? -1 : 1));
}

function analysisSpan(ctx: SynthesisContext): [IsoDate, IsoDate] {
  return [ctx.windows.baseline[0], ctx.dataThrough];
}

/** PT day Google first saw the change on a URL (d_u), or the annotation date + 3 (5.10). */
function seenDays(change: SiteChange): IsoDate[] {
  const out: IsoDate[] = [];
  for (const t of change.touched) {
    if (t.googleSeen) out.push(ptDate(t.googleSeen.to));
    else if (change.source === 'annotation') out.push(addDays(ptDate(change.deployed.from), 3));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Cause for a scope (5.12)
// ---------------------------------------------------------------------------

/** S: groups whose CI excludes 0, with the sign of the change and at least a quarter of it. */
export function significantGroups(d: ScopeDecomposition, groupCi: Record<Group, [number, number]> | null): Group[] {
  if (!groupCi || d.deltaClicks === 0) return [];
  const g = groupValues(d.bars);
  const sign = Math.sign(d.deltaClicks);
  return GROUPS.filter((k) => excludesZero(groupCi[k]) && Math.sign(g[k]) === sign && Math.abs(g[k]) >= 0.25 * Math.abs(d.deltaClicks));
}

function groupValues(b: Bars): Record<Group, number> {
  return { demand: b.demand, ranking: b.rank + b.visibility, samePos: b.samePos, aioCitation: b.aioCitation, churn: b.appeared + b.disappeared };
}

const GROUP_CAUSE: Record<Group, Cause> = { demand: 'demand', ranking: 'rank', samePos: 'ctr_serp', aioCitation: 'ai_overview', churn: 'unknown' };

export function causeForScope(s: ScopeFacts, ctx: SynthesisContext): CauseResult {
  const d = s.decomposition;
  const groups = significantGroups(d, s.groupCi);
  const g = groupValues(d.bars);
  const dir = direction(d.deltaClicks);
  const out: CauseResult = { cause: 'unknown', template: 'cause_unknown', groups, ambiguous: false, slots: {}, related: { siteChanges: [], findings: [] }, impact: null, usesCurve: false };
  const changeDate = latestChangePoint(s, ctx)?.date ?? ctx.windows.current[0];

  if (groups.length === 0 || (groups.length === 1 && groups[0] === 'churn')) {
    out.slots = { date: changeDate, top_segment: s.topSegment };
  } else if (groups.length >= 2) {
    const [a, b] = [...groups].sort((x, y) => Math.abs(g[y]) - Math.abs(g[x]) || (x < y ? -1 : 1));
    out.cause = 'mixed';
    out.template = 'mixed';
    out.slots = { a: GROUP_CAUSE[a], b: GROUP_CAUSE[b], x: d.deltaClicks !== 0 ? (g[a] + g[b]) / d.deltaClicks : 0 };
    out.usesCurve = [a, b].some((k) => k === 'ranking' || k === 'samePos');
  } else if (groups[0] === 'demand') {
    out.cause = 'demand';
    out.template = 'demand';
    out.slots = { pct: s.baseImpressions > 0 ? s.curImpressions / s.baseImpressions - 1 : 0, share: d.deltaClicks !== 0 ? g.demand / d.deltaClicks : 0, direction: dir };
  } else if (groups[0] === 'ranking') {
    const ci = s.groupCi?.ranking ?? [g.ranking, g.ranking];
    out.cause = 'rank';
    out.template = 'ranking';
    out.usesCurve = true;
    out.slots = { pb: s.pb ?? 0, pc: s.pc ?? 0, n: s.movedSearches, lo: Math.min(Math.abs(ci[0]), Math.abs(ci[1])), hi: Math.max(Math.abs(ci[0]), Math.abs(ci[1])), direction: dir };
  } else if (groups[0] === 'samePos') {
    out.usesCurve = true;
    if (ctx.aioDidSignal && s.aioUncitedShare >= 0.5) {
      out.cause = 'ai_overview';
      out.template = 'aio_not_cited';
      out.slots = { x: ctx.aioDid?.tau ?? 0, lo: ctx.aioDid?.ci95?.[0] ?? 0, hi: ctx.aioDid?.ci95?.[1] ?? 0 };
    } else if (s.checkedShare >= 0.5) {
      out.cause = 'ctr_serp';
      out.template = 'same_spot_checked';
      out.slots = { cb: s.ctrB ?? 0, cc: s.ctrC ?? 0, n: s.aioQueries };
    } else {
      out.cause = 'ctr_serp';
      out.template = 'same_spot_unchecked';
      out.slots = { cb: s.ctrB ?? 0, cc: s.ctrC ?? 0, n: s.candidates, cost: s.candidates * ctx.costPerCheck };
    }
  } else {
    out.cause = 'ai_overview';
    out.template = 'aio_flattening';
    out.ambiguous = true;
    out.usesCurve = true;
    out.slots = { pc: s.pc ?? 0 };
  }

  // Override a: a site change in scope whose post window overlaps the current window.
  const impact = siteChangeInScope(s, ctx, ['site_change', 'both']);
  if (impact) {
    const change = ctx.siteChanges.find((c) => c.id === impact.siteChangeId) as SiteChange;
    out.impact = impact;
    out.related.siteChanges.push(change.id);
    const fid = ctx.impactFindingIds.get(change.id);
    if (fid) out.related.findings.push(fid);
    out.ambiguous = out.ambiguous || impact.controlFallback || change.source === 'annotation';
    if (impact.synthesis === 'site_change') {
      out.cause = 'site_change';
      out.template = 'real_site_change';
      out.slots = siteChangeSlots(s, change, impact, dir);
    } else {
      const days = seenDays(change);
      const upd = eventsOverlapping(ctx.events, [days[0] ?? ptDate(change.deployed.to), ctx.dataThrough], ['core', 'spam'])[0];
      out.cause = 'mixed';
      out.template = 'mixed';
      out.slots = { a: 'site_change', b: upd?.title ?? 'google_update', x: 1 };
    }
    return out;
  }
  // Override b: a change point on this scope near the current window that overlaps a core or spam update.
  const cp = ctx.changePoints
    .filter((c) => sameUnit(c.unit, s.unit) && c.date >= addDays(ctx.windows.current[0], -14) && c.date <= ctx.dataThrough)
    .find((c) => c.overlaps.some((o) => o.kind === 'core' || o.kind === 'spam'));
  if (cp) {
    const ov = cp.overlaps.find((o) => o.kind === 'core' || o.kind === 'spam') as ChangePoint['overlaps'][number];
    const ev = ctx.events.find((e) => e.id === ov.eventId);
    const nDays = ev ? Math.max(0, diffDays(ptDate(ev.begin), cp.date)) : 0;
    const google = siteChangeInScope(s, ctx, ['google']);
    out.cause = 'google_update';
    out.usesCurve = false;
    if (google) {
      const change = ctx.siteChanges.find((c) => c.id === google.siteChangeId);
      out.template = 'real_google';
      out.slots = { date: cp.date, n_days: nDays, update: ov.title, touched: treatedChange(google), untouched: google.controlChange ?? 0, level: 'low', direction: dir };
      if (change) out.related.siteChanges.push(change.id);
      out.impact = google;
    } else {
      out.template = 'real_google_no_changes';
      out.slots = { date: cp.date, n_days: nDays, update: ov.title, level: 'low', direction: dir };
    }
  }
  return out;
}

function sameUnit(a: AnalysisUnit, b: AnalysisUnit): boolean {
  return a.level === b.level && a.key === b.key && (a.device ?? null) === (b.device ?? null);
}

function latestChangePoint(s: ScopeFacts, ctx: SynthesisContext): ChangePoint | null {
  const cps = ctx.changePoints.filter((c) => sameUnit(c.unit, s.unit) && c.date >= ctx.windows.baseline[0] && c.date <= ctx.dataThrough);
  return cps.sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
}

/** Treated pages' own change: (1 + tau)(1 + control change) - 1. */
function treatedChange(i: SiteChangeImpact): number {
  return (1 + (i.tau ?? 0)) * (1 + (i.controlChange ?? 0)) - 1;
}

function siteChangeInScope(s: ScopeFacts, ctx: SynthesisContext, kinds: SiteChangeImpact['synthesis'][]): SiteChangeImpact | null {
  const [cur0, cur1] = ctx.windows.current;
  const hits = ctx.siteChangeImpacts.filter((imp) => {
    if (!kinds.includes(imp.synthesis)) return false;
    const change = ctx.siteChanges.find((c) => c.id === imp.siteChangeId);
    if (!change || !change.touched.some((t) => s.pages.has(t.url))) return false;
    return seenDays(change).some((d) => addDays(d, 3) <= cur1 && addDays(d, 30) >= cur0);
  });
  return hits.sort((a, b) => Math.abs(b.tau ?? 0) - Math.abs(a.tau ?? 0) || (a.siteChangeId < b.siteChangeId ? -1 : 1))[0] ?? null;
}

function siteChangeSlots(s: ScopeFacts, change: SiteChange, impact: SiteChangeImpact, dir: 'down' | 'up'): Record<string, string | number> {
  const touched = change.touched.filter((t) => s.pages.has(t.url));
  const seen = touched.filter((t) => t.googleSeen);
  const from = seen.map((t) => ptDate((t.googleSeen as NonNullable<typeof t.googleSeen>).from)).sort();
  const to = seen.map((t) => ptDate((t.googleSeen as NonNullable<typeof t.googleSeen>).to)).sort();
  return {
    k: touched.length,
    n: Math.max(touched.length, s.pages.size),
    change_date: ptDate(change.deployed.to),
    summary: change.text ?? change.field,
    d1: from[0] ?? ptDate(change.deployed.to),
    d2: to[to.length - 1] ?? ptDate(change.deployed.to),
    ctrl: impact.controlChange ?? 0,
    level: 'low',
    direction: dir,
  };
}

// ---------------------------------------------------------------------------
// Verdict wording, alternatives, falsifiers
// ---------------------------------------------------------------------------

/** {level} per 6.3: high = signal with an INFERRED cause; medium = signal but AMBIGUOUS or a fallback; low otherwise. */
export function levelFor(real: Verdict, confidence: Confidence): 'high' | 'medium' | 'low' {
  if (real !== 'signal') return 'low';
  return confidence === 'INFERRED' ? 'high' : 'medium';
}

export function checkDate(ctx: SynthesisContext, power: PowerInfo | null): IsoDate {
  const weeks = power && !power.notMeasurable && power.weeksNeeded !== null ? Math.max(1, Math.ceil(power.weeksNeeded)) : 4;
  return addDays(ctx.dataThrough, 7 * weeks);
}

export function falsifierFor(real: Verdict, cause: Cause | null, ctx: SynthesisContext, power: PowerInfo | null): Finding['falsifier'] {
  if (real === 'underpowered' || real === 'unclear') return { key: 'more_data', slots: { check_date: checkDate(ctx, power) } };
  if (real === 'noise') return { key: 'reverts', slots: {} };
  const map: Partial<Record<Cause, FalsifierKey>> = {
    site_change: 'revert_and_recrawl', google_update: 'next_update_recovery', demand: 'impressions_recover', ai_overview: 'aio_disappears',
    ctr_serp: 'aio_disappears', rank: 'position_recovers',
  };
  return { key: (cause && map[cause]) || 'record_changes', slots: {} };
}

type Alt = Finding['alternatives'][number];

export function alternativesFor(s: ScopeFacts, cause: Cause | null, ctx: SynthesisContext): Alt[] {
  const out: Alt[] = [];
  const d = s.decomposition;
  const g = groupValues(d.bars);
  const quarter = 0.25 * Math.abs(d.deltaClicks);
  const imprPct = s.baseImpressions > 0 ? s.curImpressions / s.baseImpressions - 1 : 0;
  const ruledOut = (k: Group): boolean => !!s.groupCi && !excludesZero(s.groupCi[k]) && Math.abs(g[k]) < quarter;
  out.push({ cause: 'demand', ruledOut: ruledOut('demand'), key: ruledOut('demand') ? 'demand_ruled_out' : 'demand_possible', slots: { impr_pct: imprPct } });
  out.push({ cause: 'rank', ruledOut: ruledOut('ranking'), key: ruledOut('ranking') ? 'rank_ruled_out' : 'rank_possible', slots: { pb: s.pb ?? 0, pc: s.pc ?? 0 } });

  const span = analysisSpan(ctx);
  const google = siteChangeInScope(s, ctx, ['google']);
  const inScope = ctx.siteChanges.filter((c) => c.touched.some((t) => s.pages.has(t.url)) && ptDate(c.deployed.to) >= addDays(span[0], -28));
  if (google) out.push({ cause: 'site_change', ruledOut: true, key: 'site_change_controls_fell_too', slots: { ctrl: google.controlChange ?? 0 } });
  else if (inScope.length > 0) {
    const latest = [...inScope].sort((a, b) => (a.deployed.to < b.deployed.to ? 1 : -1))[0];
    out.push({ cause: 'site_change', ruledOut: false, key: 'site_change_possible', slots: { n: latest.touched.filter((t) => s.pages.has(t.url)).length, date: ptDate(latest.deployed.to) } });
  } else if (!ctx.firstSnapshot || ctx.firstSnapshot > ctx.windows.current[0]) {
    out.push({ cause: 'site_change', ruledOut: false, key: 'site_change_none_recorded', slots: {} });
  }

  const upd = eventsOverlapping(ctx.events, span, ['core', 'spam', 'other_ranking'])[0];
  if (upd) out.push({ cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: upd.title } });
  else out.push({ cause: 'google_update', ruledOut: true, key: 'update_no_overlap', slots: {} });

  if (ctx.windows.seasonal && s.yoy !== null) {
    const same = Math.sign(s.yoy) === Math.sign(imprPct) && Math.abs(s.yoy) >= 0.5 * Math.abs(imprPct) && Math.abs(imprPct) > 0;
    out.push(same
      ? { cause: 'seasonal', ruledOut: false, key: 'seasonal_same_last_year', slots: { yoy: s.yoy } }
      : { cause: 'seasonal', ruledOut: true, key: 'seasonal_not_last_year', slots: {} });
  }
  if (s.checkedQueries === 0) out.push({ cause: 'ai_overview', ruledOut: false, key: 'aio_not_checked', slots: {} });
  else if (!ctx.aioDidSignal) out.push({ cause: 'ai_overview', ruledOut: true, key: 'aio_no_signal', slots: {} });

  for (const e of eventsOverlapping(ctx.events, span, ['data_anomaly']).slice(0, 1)) {
    out.push({ cause: 'data_anomaly', ruledOut: false, key: 'measurement_event_overlaps', slots: { event: e.title } });
  }
  for (const e of eventsOverlapping(ctx.events, span, ['outage']).slice(0, 1)) {
    out.push({ cause: 'outage', ruledOut: false, key: 'outage_overlaps', slots: { event: e.title } });
  }
  // 5.12 step 5: nothing was being recorded back then.
  if (cause && ['unknown', 'google_update', 'mixed'].includes(cause) && (!ctx.firstSnapshot || ctx.firstSnapshot > ctx.windows.current[0])) {
    if (!out.some((a) => a.key === 'site_change_none_recorded')) out.push({ cause: 'site_change', ruledOut: false, key: 'site_change_none_recorded', slots: {} });
  }
  return out.filter((a) => a.cause !== cause);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface ScopeVerdict {
  real: Verdict;
  reason: VerdictReason;
  power: PowerInfo | null;
  failed: IdCheck[];
  estimate: number | null;
  ci95: [number, number] | null;
  freq: number | null;
}

/** Second-sentence template and its slots from the verdict (5.12): signal shows the cause template. */
function verdictTemplate(
  v: ScopeVerdict,
  cause: CauseResult,
  s: ScopeFacts,
  ctx: SynthesisContext,
  confidence: Confidence,
): { template: TemplateId; slots: Record<string, string | number> } {
  const delta = s.decomposition.deltaClicks;
  const pct = v.estimate ?? (s.decomposition.baseClicks > 0 ? delta / s.decomposition.baseClicks : 0);
  if (v.real === 'signal') {
    const slots = { ...cause.slots };
    if ('level' in slots) slots.level = levelFor(v.real, confidence);
    return { template: cause.template, slots };
  }
  if (v.real === 'noise') return { template: 'noise', slots: v.freq !== null ? { pct, freq: v.freq } : { pct } };
  if (v.real === 'underpowered') {
    const slots: Record<string, string | number> = {
      cpw: s.decomposition.baseClicks / (ctx.windowDays / 7),
      mde: v.power?.mde ?? 1,
      weeks: ctx.windowDays / 7,
      pct,
      not_measurable: v.power?.notMeasurable ? 1 : 0,
    };
    if (s.impressions) {
      slots.impr_pct = s.impressions.tau;
      slots.impr_real = s.impressions.real;
    }
    return { template: 'not_enough_data', slots };
  }
  const check: IdCheckName = v.failed[0]?.name ?? 'coverage';
  return { template: 'cant_separate', slots: { date: latestChangePoint(s, ctx)?.date ?? ctx.windows.current[0], check } };
}

function evidenceFor(s: ScopeFacts, ctx: SynthesisContext, B: number | null): EvidenceRef[] {
  const d = s.decomposition;
  const pos = s.pb !== null && s.pc !== null ? `, position ${s.pb.toFixed(1)} -> ${s.pc.toFixed(1)}` : '';
  const ev: EvidenceRef[] = [{
    type: 'gsc',
    confidence: 'EXTRACTED',
    partition: ctx.gscPartition,
    key: { from: ctx.windows.baseline[0], to: ctx.dataThrough },
    summary: `Search Console: ${round(d.baseClicks)} -> ${round(d.curClicks)} clicks, ${round(s.baseImpressions)} -> ${round(s.curImpressions)} impressions${pos}`,
  }];
  if (d.ci95?.total && B) {
    ev.push({
      type: 'statistic',
      confidence: 'INFERRED',
      partition: ctx.gscPartition,
      summary: `Click waterfall over ${d.units} units, ${B} bootstrap replicates: ${round(d.ci95.total[0])} to ${round(d.ci95.total[1])} clicks`,
    });
  }
  return ev;
}

const round = (x: number): number => Math.round(x);

function relatedFor(s: ScopeFacts, ctx: SynthesisContext, cause: CauseResult, cpFindingIds: Map<string, string>): Finding['related'] {
  const span = analysisSpan(ctx);
  const googleEvents = eventsOverlapping(ctx.events, span, ['core', 'spam', 'other_ranking', 'outage', 'data_anomaly']).map((e) => e.id).sort();
  const siteChanges = new Set(cause.related.siteChanges);
  for (const c of ctx.siteChanges) {
    if (c.touched.some((t) => s.pages.has(t.url)) && ptDate(c.deployed.to) >= addDays(span[0], -28)) siteChanges.add(c.id);
  }
  const findings = new Set(cause.related.findings);
  for (const cp of ctx.changePoints) {
    if (sameUnit(cp.unit, s.unit) && cp.date >= span[0]) {
      const id = cpFindingIds.get(`${cp.seriesId}|${cp.date}`);
      if (id) findings.add(id);
    }
  }
  return { googleEvents, siteChanges: [...siteChanges].sort(), findings: [...findings].sort() };
}

export interface BuiltScopeFinding { finding: Finding; cause: CauseResult }

/** A waterfall finding for one scope (template, page or query), or the site scope's part of the headline. */
export function scopeFinding(
  s: ScopeFacts,
  v: ScopeVerdict,
  cause: CauseResult,
  ctx: SynthesisContext,
  o: { kind: Finding['kind']; id: string; B: number | null; cpFindingIds: Map<string, string>; measurementCap: boolean },
): Finding {
  const d = s.decomposition;
  let real = v.real;
  let reason = v.reason;
  let fallback = s.kFallback || cause.ambiguous;
  if (cause.impact?.controlFallback) fallback = true;
  let confidence: Confidence = real === 'signal' && cause.cause !== 'unknown' && cause.cause !== 'mixed' && !fallback ? 'INFERRED' : 'AMBIGUOUS';
  let { template, slots } = verdictTemplate(v, cause, s, ctx, confidence);
  // Override c: a reporting change touching the windows caps demand and rank causes at unclear.
  if (o.measurementCap && (cause.cause === 'demand' || cause.cause === 'rank')) {
    const ev = eventsOverlapping(ctx.events, analysisSpan(ctx), ['data_anomaly'])[0];
    real = 'unclear';
    reason = 'identification';
    confidence = 'AMBIGUOUS';
    template = 'reporting_artefact';
    slots = { metric: 'clicks', date: ev ? ptDate(ev.begin) : ctx.windows.current[0], event: ev?.title ?? '' };
  }
  // Override d: demand with seasonal windows gets last year's change (F words it from yoy and pct).
  if (cause.cause === 'demand' && template === 'demand' && ctx.windows.seasonal && s.yoy !== null) slots = { ...slots, yoy: s.yoy };
  const power = v.power ? { ...v.power, perWeek: d.baseClicks / (ctx.windowDays / 7) } : null;
  const componentCi95: Finding['componentCi95'] = d.ci95
    ? Object.fromEntries(Object.entries(d.ci95).filter(([k]) => k !== 'total')) as Finding['componentCi95']
    : null;
  const finding: Finding = {
    id: o.id,
    kind: o.kind,
    unit: s.unit,
    metric: 'clicks',
    windows: { baseline: ctx.windows.baseline, current: ctx.windows.current },
    date: null,
    dateWindow: null,
    effect: {
      estimate: v.estimate,
      ci95: v.ci95,
      absolute: d.deltaClicks,
      absoluteCi95: d.ci95?.total ?? null,
      p: s.p,
      q: s.q,
    },
    real,
    reason,
    cause: cause.cause,
    causeConfidence: confidence,
    components: { ...d.bars },
    componentCi95,
    power,
    template,
    slots,
    evidence: evidenceFor(s, ctx, o.B),
    alternatives: alternativesFor(s, cause.cause, ctx),
    falsifier: falsifierFor(real, cause.cause, ctx, v.power),
    verify: {
      ...(s.unit.level === 'page' ? { page: s.unit.key } : {}),
      ...(s.unit.level === 'query' ? { query: s.unit.key } : {}),
      from: ctx.windows.baseline[0],
      to: ctx.dataThrough,
    },
    related: relatedFor(s, ctx, cause, o.cpFindingIds),
    analyzer: { ...ANALYZER },
    priority: 0,
  };
  finding.priority = findingPriority(finding);
  return finding;
}

/** The headline finding (5.12): the site scope, with the headline sentence slots added. */
export function headlineFinding(
  site: ScopeFacts,
  clicks: PeriodEffect,
  impressions: PeriodEffect,
  cause: CauseResult,
  ctx: SynthesisContext,
  o: { B: number | null; cpFindingIds: Map<string, string>; measurementCap: boolean },
): Finding {
  const v: ScopeVerdict = { real: clicks.real, reason: clicks.reason, power: clicks.power, failed: [], estimate: clicks.tau, ci95: clicks.ci95, freq: clicks.freq };
  const id = findingId(['headline', 'site', ctx.windows.baseline[0], ctx.dataThrough]);
  const f = scopeFinding({ ...site, p: clicks.p, q: clicks.p }, v, cause, ctx, { ...o, kind: 'headline', id });
  const delta = clicks.post - clicks.pre;
  f.slots = { days: ctx.windowDays, clicks: clicks.post, abs: Math.abs(delta), pct: clicks.tau, direction: direction(delta), ...f.slots };
  f.effect = { estimate: clicks.tau, ci95: clicks.ci95, absolute: delta, absoluteCi95: site.decomposition.ci95?.total ?? null, p: clicks.p, q: clicks.p };
  f.priority = findingPriority(f);
  return f;
}

/** A fact-style notice (coverage, freshness, no_site_changes). */
export function noticeFinding(template: TemplateId, slots: Record<string, string | number>, ctx: SynthesisContext, evidence: EvidenceRef[] = []): Finding {
  const f: Finding = {
    id: findingId(['notice', template, ctx.dataThrough]),
    kind: 'notice',
    unit: { level: 'site', key: 'site', label: 'Whole site' },
    metric: 'clicks',
    windows: { baseline: ctx.windows.baseline, current: ctx.windows.current },
    date: ctx.dataThrough,
    dateWindow: null,
    effect: { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null },
    real: 'noise',
    reason: 'fact',
    cause: null,
    causeConfidence: 'EXTRACTED',
    components: null,
    componentCi95: null,
    power: null,
    template,
    slots,
    evidence,
    alternatives: [],
    falsifier: { key: 'record_changes', slots: {} },
    verify: null,
    related: { googleEvents: [], siteChanges: [], findings: [] },
    analyzer: { ...ANALYZER },
    priority: 0,
  };
  f.priority = findingPriority(f);
  return f;
}

export const LABEL_SITE = 'Whole site';
export const unitLabel = (level: AnalysisUnit['level'], key: string): string =>
  level === 'site' ? LABEL_SITE : level === 'page' ? pathOf(key) : key;
