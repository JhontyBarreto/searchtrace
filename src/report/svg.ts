// Inline SVG: timeline with bands and markers, waterfall bars with whiskers, sparkline (6.5). Owner: WP-F.
//
// Charts are plain inline SVG (no script, no external fonts or images) styled by CSS classes
// defined in html.ts, so dark mode and print work. Every label passes through esc().
import { addDays, diffDays, ptDate } from '../core/time.js';
import type { AnalysisOutput, DayTotal, GoogleEventKind, IsoDate, ScopeDecomposition } from '../core/types.js';
import { CAUSE_LABEL, shownGroups } from './copy.js';
import { esc } from './escape.js';
import { eventName, fmtDate, fmtInt, fmtPct, fmtSignedInt } from './format.js';

/** Fixed-precision coordinates keep the output byte-stable and small. */
const n1 = (x: number): string => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '') : '0');

export function sparklineSvg(values: number[], o?: { width?: number; height?: number; label?: string }): string {
  const width = o?.width ?? 160;
  const height = o?.height ?? 32;
  const label = o?.label ?? 'Trend';
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return '';
  const max = Math.max(...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const step = width / (vals.length - 1);
  const pts = vals.map((v, i) => `${n1(i * step)},${n1(height - 2 - ((v - min) / span) * (height - 4))}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">` +
    `<polyline class="spark-line" fill="none" points="${pts}"/></svg>`;
}

/** Weekly click totals for the answer's chart: enough weeks to cover both compared windows, ending at the current window's last day. */
export function answerWeeks(out: AnalysisOutput): { end: IsoDate; weeks: { end: IsoDate; clicks: number }[] } {
  const end = out.windows.current[1];
  const L = diffDays(out.windows.current[0], end) + 1;
  const n = Math.max(16, Math.ceil((2 * L) / 7) + 4);
  const byDay = new Map(out.timeline.sealed.map((d) => [d.date, d.c]));
  const first = out.timeline.sealed[0]?.date ?? end;
  const weeks: { end: IsoDate; clicks: number }[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const we = addDays(end, -7 * k);
    const ws = addDays(we, -6);
    if (ws < first) continue;
    let sum = 0;
    for (let d = ws; d <= we; d = addDays(d, 1)) sum += byDay.get(d) ?? 0;
    weeks.push({ end: we, clicks: sum });
  }
  return { end, weeks };
}

/**
 * The answer's chart (6.5): weekly clicks with the two compared periods shaded from their real
 * dates, each period's weekly average drawn across it, and the first and last points and the 0
 * baseline labelled. The y axis starts at 0, like the timeline, so a change the report calls
 * wobble never looks like a collapse. Returns the SVG and the one-sentence description that
 * labels it (for a figcaption and aria-labelledby).
 */
export function answerChart(out: AnalysisOutput, id = 'answer-chart'): { svg: string; caption: string } | null {
  const { end, weeks } = answerWeeks(out);
  if (weeks.length < 2) return null;
  const W = 360;
  const H = 80;
  const LX = 34;
  const RX = 40;
  const T = 12;
  const B = 16;
  const start = addDays(weeks[0].end, -6);
  const span = Math.max(1, diffDays(start, end));
  const x = (d: IsoDate): number => LX + (Math.max(0, Math.min(span, diffDays(start, d))) / span) * (W - LX - RX);
  const max = Math.max(1, ...weeks.map((w) => w.clicks));
  const y = (v: number): number => T + (H - T - B) * (1 - v / max);
  const L = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  const perWeek = (total: number): number => total / (L / 7);
  const parts: string[] = [`<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${esc(id)}">`];
  for (const [w, cls, avg] of [[out.windows.baseline, 'spark-base', perWeek(out.headline.clicks.pre)], [out.windows.current, 'spark-cur', perWeek(out.headline.clicks.post)]] as const) {
    const x1 = x(addDays(w[0], -1));
    const x2 = x(w[1]);
    parts.push(`<rect class="${cls}" x="${n1(x1)}" y="${T - 4}" width="${n1(Math.max(1, x2 - x1))}" height="${H - T - B + 4}"/>`);
    if (Number.isFinite(avg)) parts.push(`<line class="spark-avg" x1="${n1(x1)}" y1="${n1(y(avg))}" x2="${n1(x2)}" y2="${n1(y(avg))}"/>`);
  }
  parts.push(`<line class="axis" x1="${LX}" y1="${n1(y(0))}" x2="${W - RX}" y2="${n1(y(0))}"/>`);
  parts.push(`<text class="axis-label" x="${LX - 4}" y="${n1(y(0) + 3)}" text-anchor="end">0</text>`);
  const pts = weeks.map((w) => `${n1(x(w.end))},${n1(y(w.clicks))}`).join(' ');
  parts.push(`<polyline class="spark-line" fill="none" points="${pts}"/>`);
  const a = weeks[0];
  const z = weeks[weeks.length - 1];
  parts.push(`<text class="axis-label" x="${LX - 4}" y="${n1(y(a.clicks) + 3)}" text-anchor="end">${esc(fmtInt(a.clicks))}</text>`);
  parts.push(`<text class="axis-label" x="${W - RX + 4}" y="${n1(y(z.clicks) + 3)}">${esc(fmtInt(z.clicks))}</text>`);
  parts.push(`<text class="axis-label" x="${LX}" y="${H - 3}">${esc(fmtDate(a.end))}</text>`);
  parts.push(`<text class="axis-label" x="${W - RX}" y="${H - 3}" text-anchor="end">${esc(fmtDate(z.end))}</text>`);
  parts.push('</svg>');
  const caption = `Weekly clicks for the ${weeks.length} weeks to ${fmtDate(end)}. Shaded: the two ${L}-day periods compared above, ` +
    `averaging ${fmtInt(perWeek(out.headline.clicks.pre))} a week, then ${fmtInt(perWeek(out.headline.clicks.post))}.`;
  return { svg: parts.join(''), caption };
}

/** Trailing 7-day mean of a daily series (shorter at the start). */
function rolling7(values: number[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= 7) sum -= values[i - 7];
    out.push(sum / Math.min(i + 1, 7));
  }
  return out;
}

const BAND_CLASS: Partial<Record<GoogleEventKind, string>> = {
  core: 'band-core',
  spam: 'band-spam',
  outage: 'band-outage',
  data_anomaly: 'band-report',
};
const BAND_NAME: Partial<Record<GoogleEventKind, string>> = {
  core: 'Core update',
  spam: 'Spam update',
  outage: 'Google outage',
  data_anomaly: CAUSE_LABEL.data_anomaly,
};

/** Which kinds of mark a timeline actually drew, so its legend lists only those. */
export interface TimelineDrawn { bands: Set<string>; changes: boolean; siteChanges: boolean; provisional: boolean }

/** 16+ months of daily clicks and impressions as two small multiples, with events and markers. */
export function timelineSvg(out: AnalysisOutput): string {
  return timelineChart(out).svg;
}

/** The timeline and what it drew. */
export function timelineChart(out: AnalysisOutput): { svg: string; drawn: TimelineDrawn } {
  const drawn: TimelineDrawn = { bands: new Set(), changes: false, siteChanges: false, provisional: false };
  const sealed = out.timeline.sealed;
  const provisional = out.timeline.provisional;
  if (sealed.length < 2) return { svg: '', drawn };
  const W = 960;
  const PH = 120;
  const GAP = 34;
  const L = 56;
  const R = 12;
  const T = 18;
  const H = T + PH * 2 + GAP + 34;
  const first = sealed[0].date;
  const last = (provisional.length ? provisional[provisional.length - 1] : sealed[sealed.length - 1]).date;
  const span = Math.max(1, diffDays(first, last));
  const x = (d: IsoDate): number => L + (diffDays(first, d) / span) * (W - L - R);
  const inRange = (d: IsoDate): boolean => d >= first && d <= last;
  const clamp = (d: IsoDate): IsoDate => (d < first ? first : d > last ? last : d);

  const parts: string[] = [];
  parts.push(`<svg class="timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily clicks and impressions over time, with Google updates and detected changes">`);
  parts.push('<defs>' +
    '<pattern id="pat-spam" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" class="pat-fill"/></pattern>' +
    '<pattern id="pat-outage" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.2" class="pat-fill"/></pattern>' +
    '<pattern id="pat-report" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 0L6 6M6 0L0 6" class="pat-stroke"/></pattern>' +
    '</defs>');

  const panels: { key: 'c' | 'i'; title: string; metric: 'clicks' | 'impressions'; top: number }[] = [
    { key: 'c', title: 'Clicks (7-day average)', metric: 'clicks', top: T },
    { key: 'i', title: 'Impressions (7-day average)', metric: 'impressions', top: T + PH + GAP },
  ];

  const labels: [number, number][] = [];
  for (const panel of panels) {
    const sealedVals = rolling7(sealed.map((d: DayTotal) => d[panel.key]));
    const allRaw = [...sealed, ...provisional].map((d) => d[panel.key]);
    const allVals = rolling7(allRaw);
    const max = Math.max(1, ...allVals);
    const y = (v: number): number => panel.top + PH - (v / max) * (PH - 6);
    parts.push(`<g class="panel"><text class="axis-title" x="${L}" y="${panel.top - 5}">${esc(panel.title)}</text>`);
    parts.push(`<line class="axis" x1="${L}" y1="${n1(panel.top + PH)}" x2="${W - R}" y2="${n1(panel.top + PH)}"/>`);
    parts.push(`<text class="axis-label" x="${L - 6}" y="${n1(panel.top + 8)}" text-anchor="end">${esc(fmtInt(max))}</text>`);
    parts.push(`<text class="axis-label" x="${L - 6}" y="${n1(panel.top + PH)}" text-anchor="end">0</text>`);

    // Google update bands.
    for (const row of out.scorecard) {
      const cls = BAND_CLASS[row.kind];
      if (!cls) continue;
      const end = row.end ?? row.begin;
      if (end < first || row.begin > last) continue;
      const x1 = x(clamp(row.begin));
      const x2 = Math.max(x1 + 2, x(clamp(end)));
      const span = row.end === row.begin ? fmtDate(row.begin) : `${fmtDate(row.begin)} to ${row.end ? fmtDate(row.end) : 'ongoing'}`;
      const what = `${row.title} (${span}${row.endEstimated ? ', end estimated' : ''})`;
      parts.push(`<rect class="band ${cls}" x="${n1(x1)}" y="${panel.top}" width="${n1(x2 - x1)}" height="${PH}"><title>${esc(what)}</title></rect>`);
      drawn.bands.add(cls);
      // On the clicks panel, name the updates the scorecard calls a real change, where there is room.
      const f = panel.key === 'c' ? out.findings.find((x2f) => x2f.id === row.findingId) : undefined;
      if (f && f.real === 'signal' && row.clicks) {
        const label = `${eventName(row.title).replace(/^(January|February|March|April|June|July|August|September|October|November|December)\b/, (m) => m.slice(0, 3))}, ${fmtPct(row.clicks.tau)}`;
        const half = label.length * 3.1;
        const lx = Math.min(W - R - half, Math.max(L + half, x1));
        if (!labels.some(([a, b]) => lx - half < b && lx + half > a)) {
          labels.push([lx - half, lx + half]);
          parts.push(`<text class="band-label" x="${n1(lx)}" y="${panel.top + 10}" text-anchor="middle">${esc(label)}</text>`);
        }
      }
    }

    // Change-point windows and markers for the whole-site series of this metric (all devices: the
    // panel plots the total). Changes judged normal wobble or too thin to call are not drawn.
    for (const cp of out.changePoints) {
      if (cp.unit.level !== 'site' || cp.unit.device || cp.metric !== panel.metric || !inRange(cp.date)) continue;
      const f = out.findings.find((x) => x.kind === 'change_point' && x.slots?.date === cp.date &&
        x.evidence.some((e) => (e.key as Record<string, unknown> | undefined)?.series === cp.seriesId));
      // Ordinary wobble and thin changes are not drawn; a real but small change is.
      if (f && ((f.real === 'noise' && f.reason !== 'noise_small') || f.real === 'underpowered')) continue;
      drawn.changes = true;
      const wx1 = x(clamp(cp.dateWindow[0]));
      const wx2 = Math.max(wx1 + 1, x(clamp(cp.dateWindow[1])));
      const likely = cp.dateWindow[0] === cp.dateWindow[1] ? '' : ` (likely ${fmtDate(cp.dateWindow[0])} to ${fmtDate(cp.dateWindow[1])})`;
      const label = `Change detected around ${fmtDate(cp.date)}${likely}`;
      parts.push(`<rect class="cp-window" x="${n1(wx1)}" y="${panel.top}" width="${n1(wx2 - wx1)}" height="${PH}"><title>${esc(label)}</title></rect>`);
      parts.push(`<line class="cp-line" x1="${n1(x(cp.date))}" y1="${panel.top}" x2="${n1(x(cp.date))}" y2="${panel.top + PH}"/>`);
    }

    const line = sealedVals.map((v, i) => `${n1(x(sealed[i].date))},${n1(y(v))}`).join(' ');
    parts.push(`<polyline class="series series-${panel.key}" fill="none" points="${line}"/>`);
    if (provisional.length) {
      drawn.provisional = true;
      // Two or three days are a few pixels wide: shade them so the tail can be seen at all.
      const px1 = x(provisional[0].date);
      const px2 = Math.max(px1 + 8, x(provisional[provisional.length - 1].date));
      parts.push(`<rect class="prov-band" x="${n1(Math.min(px1, W - R - 8))}" y="${panel.top}" width="${n1(px2 - px1)}" height="${PH}"/>`);
      const tail = allVals.slice(sealed.length - 1).map((v, i) => {
        const d = i === 0 ? sealed[sealed.length - 1].date : provisional[i - 1].date;
        return `${n1(x(d))},${n1(y(v))}`;
      });
      parts.push(`<polyline class="series series-${panel.key} provisional" fill="none" points="${tail.join(' ')}"><title>Not final yet: Google is still finalising these days</title></polyline>`);
    }
    parts.push('</g>');
  }

  // Site-change markers under the second panel.
  const markerY = T + PH * 2 + GAP + 4;
  for (const c of out.siteChanges) {
    let d: IsoDate;
    try {
      d = ptDate(c.deployed.to);
    } catch {
      continue;
    }
    if (!inRange(d)) continue;
    const cx = x(d);
    const label = `${c.source === 'annotation' ? 'Your note' : 'Site change'}: ${c.field} on ${c.touched.length} page${c.touched.length === 1 ? '' : 's'} (${fmtDate(d)})`;
    parts.push(`<path class="sc-marker" d="M${n1(cx)} ${markerY}l5 8h-10z"><title>${esc(label)}</title></path>`);
    drawn.siteChanges = true;
  }

  // Month ticks along the bottom.
  const tickY = H - 6;
  let lastLabelX = -Infinity;
  for (let d = first; d <= last; ) {
    const [yy, mm] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
    const monthStart = `${yy}-${String(mm).padStart(2, '0')}-01`;
    if (monthStart >= first) {
      const tx = x(monthStart);
      const text = fmtDate(monthStart).replace(/^1 /, '');
      // A label centred near the right edge would be clipped ("Oct 202"): skip it instead.
      if (tx - lastLabelX > 60 && tx + text.length * 3.1 <= W) {
        parts.push(`<text class="axis-label" x="${n1(tx)}" y="${tickY}" text-anchor="middle">${esc(text)}</text>`);
        lastLabelX = tx;
      }
    }
    const next = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    d = next;
  }
  parts.push('</svg>');
  return { svg: parts.join(''), drawn };
}

/** Legend for the timeline's band patterns and markers (HTML): only what the chart drew, or everything without `drawn`. */
export function timelineLegend(drawn?: TimelineDrawn): string {
  const has = (cls: string): boolean => !drawn || drawn.bands.has(cls);
  const item = (cls: string, text: string): string =>
    `<span class="legend-item"><svg width="14" height="10" aria-hidden="true"><rect class="band ${cls}" width="14" height="10"/></svg>${esc(text)}</span>`;
  const items = [
    has('band-core') ? item('band-core', BAND_NAME.core ?? '') : '',
    has('band-spam') ? item('band-spam', BAND_NAME.spam ?? '') : '',
    has('band-outage') ? item('band-outage', BAND_NAME.outage ?? '') : '',
    has('band-report') ? item('band-report', BAND_NAME.data_anomaly ?? '') : '',
    !drawn || drawn.changes ? item('cp-window', 'Detected change (likely dates)') : '',
    !drawn || drawn.siteChanges
      ? '<span class="legend-item"><svg width="14" height="10" aria-hidden="true"><path class="sc-marker" d="M7 1l5 8h-10z"/></svg>Change on your site</span>' : '',
    !drawn || drawn.provisional
      ? '<span class="legend-item"><svg width="14" height="10" aria-hidden="true"><rect class="prov-band" width="14" height="10"/></svg>Not final yet</span>' : '',
  ].join('');
  return items ? `<p class="legend">${items}</p>` : '';
}

/**
 * Horizontal bars for the waterfall display groups, with 95% whiskers when known. Structural
 * zeros are left out. The total's whisker is the "is it real?" range (`totalCi`, the headline's
 * for the whole site) when given, so the chart and the table agree.
 */
export function waterfallSvg(scope: ScopeDecomposition, o: { totalCi?: [number, number] | null } = {}): string {
  const rows = shownGroups(scope.bars, scope.ci95);
  const total = { label: 'Total change', value: scope.deltaClicks, ci: o.totalCi !== undefined ? o.totalCi : scope.ci95?.total ?? null };
  const all = [...rows, { group: 'total', ...total }];
  const W = 640;
  const LW = 230;
  const VW = 70;
  const RH = 26;
  const H = all.length * RH + 10;
  const extent = Math.max(1, ...all.flatMap((r) => [Math.abs(r.value), ...(r.ci ? r.ci.map((v) => Math.abs(v)) : [])]));
  const mid = LW + (W - LW - VW) / 2;
  const half = (W - LW - VW) / 2 - 6;
  const sx = (v: number): number => mid + (v / extent) * half;
  const parts: string[] = [];
  parts.push(`<svg class="waterfall" viewBox="0 0 ${W} ${H}" role="img" aria-label="Where the clicks went, estimated, with 95% ranges">`);
  parts.push(`<line class="axis" x1="${n1(mid)}" y1="2" x2="${n1(mid)}" y2="${H - 4}"/>`);
  all.forEach((r, i) => {
    const yTop = 5 + i * RH;
    const yMid = yTop + RH / 2 - 2;
    const isTotal = r.group === 'total';
    const x1 = Math.min(sx(0), sx(r.value));
    const w = Math.max(1, Math.abs(sx(r.value) - sx(0)));
    const sign = r.value < 0 ? 'neg' : 'pos';
    parts.push(`<text class="bar-label${isTotal ? ' total' : ''}" x="${LW - 8}" y="${n1(yMid + 4)}" text-anchor="end">${esc(r.label)}</text>`);
    parts.push(`<rect class="bar ${sign}${isTotal ? ' total' : ''}" x="${n1(x1)}" y="${n1(yTop + 3)}" width="${n1(w)}" height="${RH - 10}"/>`);
    if (r.ci) {
      const [lo, hi] = r.ci;
      parts.push(`<path class="whisker" d="M${n1(sx(lo))} ${n1(yMid)}H${n1(sx(hi))}M${n1(sx(lo))} ${n1(yMid - 5)}v10M${n1(sx(hi))} ${n1(yMid - 5)}v10"/>`);
    }
    parts.push(`<text class="bar-value" x="${W - 4}" y="${n1(yMid + 4)}" text-anchor="end">${esc(fmtSignedInt(r.value))}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}
