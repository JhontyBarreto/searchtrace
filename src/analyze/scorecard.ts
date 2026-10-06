// Google update scorecard rows and findings (5.7). Owner: WP-B.
//
// One row per Google event. For each, clicks and impressions are compared over up to 28 days
// before the event began and the same number of days after it ended (periodCompare, 5.4), with
// seasonal day-of-week factors and an empirical standard error that avoids other update windows.
// Rows in a BH family (family 3) are decided again with their q-value and identification checks:
// another core or spam update within a week of this one (competing_events), and for impressions a
// reporting change overlapping the windows (measurement_event). Pure: no clock, no randomness.
import { findingId } from '../core/ids.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import type {
  EvidenceRef, Finding, GoogleEvent, GoogleEventKind, IdCheck, IsoDate, PeriodEffect, ScorecardInput, SiteChange, UpdateRow, Verdict,
} from '../core/types.js';
import { REAL_LABEL } from '../report/copy.js';
import { layout } from '../store/layout.js';
import { benjaminiHochberg, periodCompare, seasonalSeries } from './stats.js';
import { confidenceFor, decideVerdict } from './verdicts.js';

export const SCORECARD_VERSION = '1';
const MAX_WINDOW = 28;
const MIN_WINDOW = 7;
const OPEN_EVENT_DAYS = 14;
const COMPETING_PAD = 7;
const EXCLUDE_PAD = 7;
const FLOOR = { clicks: 30, impressions: 1000 } as const;
const DAY_MS = 86_400_000;
const TIER: Record<Verdict, number> = { signal: 1000, unclear: 100, underpowered: 10, noise: 1 };
const COMPETING_KINDS = new Set<GoogleEventKind>(['core', 'spam']);
const EXCLUDED_KINDS = new Set<GoogleEventKind>(['core', 'spam', 'data_anomaly']);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const intersects = (a: [IsoDate, IsoDate], b: [IsoDate, IsoDate]): boolean => a[0] <= b[1] && b[0] <= a[1];

/** Begin and end as PT dates; an event with no end is treated as lasting 14 days. */
export function eventDates(e: GoogleEvent): { b: IsoDate; e: IsoDate } {
  const b = ptDate(e.begin);
  const endAt = e.end ?? new Date(Date.parse(e.begin) + OPEN_EVENT_DAYS * DAY_MS).toISOString();
  const end = ptDate(endAt);
  return { b, e: end < b ? b : end };
}

function seenDates(c: SiteChange): IsoDate[] {
  const seen = c.touched.filter((t) => t.googleSeen !== null).map((t) => ptDate((t.googleSeen as { to: string }).to));
  return seen.length > 0 ? seen : [ptDate(c.deployed.to)];
}

interface Draft {
  ev: GoogleEvent;
  row: UpdateRow;
  L: number;
  competingIds: string[];
  measurement: GoogleEvent | null;
  seen: SiteChange[];
  /** Seasonal factor sums over the windows, for the absolute effect. */
  sums: { pre: number; post: number } | null;
}

function sumS(s: number[], start: IsoDate, w: [IsoDate, IsoDate]): number {
  let acc = 0;
  for (let k = diffDays(start, w[0]); k <= diffDays(start, w[1]); k++) acc += s[k] ?? 0;
  return acc;
}

function redecide(eff: PeriodEffect, checks: IdCheck[], q: number, L: number, i: ScorecardInput, phi: number): PeriodEffect {
  const v = decideVerdict({
    estimate: eff.tau,
    ci95: eff.ci95,
    floorsMet: eff.floorsMet,
    identification: checks,
    q,
    delta: i.delta,
    fdrQ: i.fdrQ,
    weeksObserved: L / 7,
    counts: { pre: eff.pre, post: eff.post, phi },
  });
  return { ...eff, real: v.verdict, reason: v.reason, power: v.power };
}

export function buildScorecard(i: ScorecardInput): { rows: UpdateRow[]; findings: Finding[] } {
  const n = Math.min(i.clicks.length, i.impressions.length);
  const clean = (x: number[]): number[] => x.slice(0, n).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const clicks = clean(i.clicks);
  const impressions = clean(i.impressions);
  const lastDay = addDays(i.start, n - 1);
  const D = n > 0 ? (i.dataThrough < lastDay ? i.dataThrough : lastDay) : addDays(i.start, -1);
  const dow = i.dow.length === 7 && i.dow.every((f) => f > 0) ? i.dow : [1, 1, 1, 1, 1, 1, 1];
  const s = n > 0 ? seasonalSeries(i.start, n, dow) : [];
  const phiC = i.phi.clicks > 0 ? i.phi.clicks : 1;
  const phiI = i.phi.impressions > 0 ? i.phi.impressions : 1;

  const events = [...i.events].sort((a, b) => cmp(a.begin, b.begin) || cmp(a.id, b.id));
  const dated = events.map((ev) => ({ ev, ...eventDates(ev) }));
  const exclude: [IsoDate, IsoDate][] = dated
    .filter((x) => EXCLUDED_KINDS.has(x.ev.kind))
    .map((x) => [addDays(x.b, -EXCLUDE_PAD), addDays(x.e, EXCLUDE_PAD)]);

  const drafts: Draft[] = dated.map(({ ev, b, e }) => {
    const competing = dated.filter(
      (o) => o.ev.id !== ev.id && COMPETING_KINDS.has(o.ev.kind) && intersects([o.b, o.e], [addDays(b, -COMPETING_PAD), addDays(e, COMPETING_PAD)]),
    );
    let status: UpdateRow['status'];
    let L = MAX_WINDOW;
    let checkAgainOn: IsoDate | null = null;
    if (ev.kind === 'discover') {
      status = 'skipped_discover';
    } else if (n === 0 || diffDays(i.start, b) < MAX_WINDOW) {
      status = 'before_history';
    } else {
      L = Math.min(MAX_WINDOW, diffDays(e, D));
      if (L < MIN_WINDOW) {
        status = 'too_recent';
        checkAgainOn = addDays(e, MIN_WINDOW);
      } else {
        status = L < MAX_WINDOW ? 'partial' : 'measured';
      }
    }
    const span = Math.max(L, 0);
    // A reporting change near the windows, including this event itself when it is one.
    const measurement =
      dated.find((o) => o.ev.kind === 'data_anomaly' && intersects([o.b, o.e], [addDays(b, -span), addDays(e, span)]))?.ev ?? null;
    const seen = i.siteChanges.filter((c) => seenDates(c).some((d) => d >= addDays(b, -MAX_WINDOW) && d <= e));

    let window: UpdateRow['window'] = null;
    let clickEff: PeriodEffect | null = null;
    let imprEff: PeriodEffect | null = null;
    let sums: Draft['sums'] = null;
    if (status === 'measured' || status === 'partial') {
      const pre: [IsoDate, IsoDate] = [addDays(b, -L), addDays(b, -1)];
      const post: [IsoDate, IsoDate] = [addDays(e, 1), addDays(e, L)];
      window = { pre, post };
      const base = { start: i.start, pre, post, s, exclude, delta: i.delta, fdrQ: i.fdrQ };
      clickEff = periodCompare({ ...base, values: clicks, phi: phiC, floor: FLOOR.clicks });
      imprEff = periodCompare({ ...base, values: impressions, phi: phiI, floor: FLOOR.impressions });
      sums = { pre: sumS(s, i.start, pre), post: sumS(s, i.start, post) };
    }
    const row: UpdateRow = {
      eventId: ev.id,
      title: ev.title,
      kind: ev.kind,
      begin: b,
      end: ev.end ? e : null,
      endEstimated: ev.end === null || ev.endEstimated,
      status,
      window,
      clicks: clickEff,
      impressions: imprEff,
      competing: competing.map((o) => o.ev.title),
      measurementOverlap: measurement !== null,
      siteChangesSeen: seen.length,
      checkAgainOn,
      findingId: findingId(['update_impact', 'site', ev.id]),
    };
    return { ev, row, L, competingIds: competing.map((o) => o.ev.id), measurement, seen, sums };
  });

  // BH family 3: every clicks and impressions row that was measured.
  const ps: number[] = [];
  for (const d of drafts) {
    if (d.row.clicks) ps.push(d.row.clicks.p);
    if (d.row.impressions) ps.push(d.row.impressions.p);
  }
  const qs = benjaminiHochberg(ps);
  let k = 0;
  const qOf = new Map<string, { clicks: number | null; impressions: number | null }>();
  for (const d of drafts) {
    const qc = d.row.clicks ? qs[k++] : null;
    const qi = d.row.impressions ? qs[k++] : null;
    qOf.set(d.ev.id, { clicks: qc, impressions: qi });
    const competingCheck: IdCheck[] = d.row.competing.length > 0
      ? [{ name: 'competing_events', passed: false, detail: [d.ev.title, ...d.row.competing].join(' and ') }]
      : [];
    if (d.row.clicks && qc !== null) d.row.clicks = redecide(d.row.clicks, competingCheck, qc, d.L, i, phiC);
    if (d.row.impressions && qi !== null) {
      const checks = d.measurement
        ? [...competingCheck, { name: 'measurement_event' as const, passed: false, detail: d.measurement.title.slice(0, 120) }]
        : competingCheck;
      d.row.impressions = redecide(d.row.impressions, checks, qi, d.L, i, phiI);
    }
  }

  const findings = drafts.map((d) => toFinding(d, i, D, qOf.get(d.ev.id) as { clicks: number | null; impressions: number | null }));
  findings.sort((a, b) => b.priority - a.priority || cmp(a.id, b.id));
  return { rows: drafts.map((d) => d.row), findings };
}

function toFinding(d: Draft, i: ScorecardInput, D: IsoDate, q: { clicks: number | null; impressions: number | null }): Finding {
  const row = d.row;
  const c = row.clicks;
  const measured = c !== null && row.window !== null;
  const real: Verdict = measured ? c.real : 'underpowered';
  const label = (eff: PeriodEffect | null): string => (eff ? REAL_LABEL[eff.real] : '');
  const end = row.end ?? eventDates(d.ev).e;
  const cf = measured && d.sums && d.sums.pre > 0 ? (c.pre * d.sums.post) / d.sums.pre : null;
  const absolute = measured && cf !== null ? c.post - cf : null;
  const absoluteCi95: [number, number] | null = measured && cf !== null ? [cf * c.ci95[0], cf * c.ci95[1]] : null;

  const evidence: EvidenceRef[] = [
    {
      type: 'google_event', confidence: 'EXTRACTED', partition: 'google/', key: { id: d.ev.id },
      summary: `${d.ev.title.slice(0, 120)}: ${row.begin} to ${end}${row.endEstimated ? ' (end estimated)' : ''}`,
    },
  ];
  if (measured && row.window) {
    evidence.push({
      type: 'gsc', confidence: 'EXTRACTED', partition: layout.gscDay(row.window.post[0]),
      summary: `Clicks ${c.pre} in the ${d.L} days before, ${c.post} in the ${d.L} days after`,
    });
    if (row.impressions) {
      evidence.push({
        type: 'statistic', confidence: confidenceFor(row.impressions.real, false), partition: layout.gscDay(row.window.post[0]),
        summary: `Impressions ${row.impressions.pre} before, ${row.impressions.post} after`,
      });
    }
  }

  const alternatives: Finding['alternatives'] = [];
  for (const title of row.competing) alternatives.push({ cause: 'google_update', ruledOut: false, key: 'update_overlaps', slots: { update: title } });
  if (d.measurement) alternatives.push({ cause: 'data_anomaly', ruledOut: false, key: 'measurement_event_overlaps', slots: { event: d.measurement.title } });
  if (i.siteChanges.length === 0) {
    alternatives.push({ cause: 'site_change', ruledOut: false, key: 'site_change_none_recorded', slots: {} });
  } else if (d.seen.length > 0) {
    const first = d.seen.map((x) => seenDates(x)[0]).sort()[0];
    alternatives.push({ cause: 'site_change', ruledOut: false, key: 'site_change_possible', slots: { n: d.seen.length, date: first } });
  }

  const cause: Finding['cause'] = d.ev.kind === 'outage' ? 'outage' : d.ev.kind === 'data_anomaly' ? 'data_anomaly' : 'google_update';
  const slots: Finding['slots'] = {
    update: d.ev.title,
    dates: `${row.begin} to ${end}`,
    clicks_pct: row.clicks ? row.clicks.tau : '',
    clicks_label: label(row.clicks),
    impr_pct: row.impressions ? row.impressions.tau : '',
    impr_label: label(row.impressions),
    status: row.status,
  };
  if (row.checkAgainOn) slots.check_date = row.checkAgainOn;

  const isGoogleRanking = d.ev.kind === 'core' || d.ev.kind === 'spam' || d.ev.kind === 'other_ranking';
  const absClicks = absolute === null ? 0 : Math.abs(absolute);
  return {
    id: row.findingId,
    kind: 'update_impact',
    unit: { level: 'site', key: 'site', label: 'Whole site' },
    metric: 'clicks',
    windows: row.window ? { baseline: row.window.pre, current: row.window.post } : null,
    date: row.begin,
    dateWindow: [row.begin, end],
    effect: {
      estimate: measured ? c.tau : null,
      ci95: measured ? c.ci95 : null,
      absolute,
      absoluteCi95,
      p: measured ? c.p : null,
      q: q.clicks,
    },
    real,
    reason: measured ? c.reason : 'floors',
    cause,
    causeConfidence: measured ? confidenceFor(real, false) : 'AMBIGUOUS',
    components: null,
    componentCi95: null,
    power: measured && c.power ? { ...c.power, perWeek: d.L > 0 ? (c.pre / d.L) * 7 : 0 } : null,
    template: 'update_row',
    slots,
    evidence,
    alternatives,
    falsifier:
      row.status === 'too_recent' && row.checkAgainOn
        ? { key: 'more_data', slots: { check_date: row.checkAgainOn } }
        : isGoogleRanking
          ? { key: 'next_update_recovery', slots: {} }
          : { key: 'reverts', slots: {} },
    verify: row.window ? { from: row.window.pre[0], to: row.window.post[1] > D ? D : row.window.post[1] } : null,
    related: { googleEvents: [d.ev.id, ...d.competingIds], siteChanges: d.seen.map((x) => x.id).sort(), findings: [] },
    analyzer: { name: 'scorecard', version: SCORECARD_VERSION },
    priority: TIER[real] * Math.max(1, absClicks) + 0.5,
  };
}
