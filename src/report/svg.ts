// Inline SVG: timeline with bands and markers, waterfall bars with whiskers, sparkline (6.5). Owner: WP-F.
//
// Charts are plain inline SVG (no script, no external fonts or images) styled by CSS classes
// defined in html.ts, so dark mode and print work. Every label passes through esc().
import { diffDays, ptDate } from '../core/time.js';
import type { AnalysisOutput, DayTotal, GoogleEventKind, IsoDate, ScopeDecomposition } from '../core/types.js';
import { CAUSE_LABEL, displayGroups } from './copy.js';
import { esc } from './escape.js';
import { fmtDate, fmtInt, fmtSignedInt } from './format.js';

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

/** 16+ months of daily clicks and impressions as two small multiples, with events and markers. */
export function timelineSvg(out: AnalysisOutput): string {
  const sealed = out.timeline.sealed;
  const provisional = out.timeline.provisional;
  if (sealed.length < 2) return '';
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
      const what = `${row.title} (${fmtDate(row.begin)} to ${row.end ? fmtDate(row.end) : 'ongoing'}${row.endEstimated ? ', end estimated' : ''})`;
      parts.push(`<rect class="band ${cls}" x="${n1(x1)}" y="${panel.top}" width="${n1(x2 - x1)}" height="${PH}"><title>${esc(what)}</title></rect>`);
    }

    // Change-point windows and markers for site-level series of this metric.
    for (const cp of out.changePoints) {
      if (cp.unit.level !== 'site' || cp.metric !== panel.metric || !inRange(cp.date)) continue;
      const wx1 = x(clamp(cp.dateWindow[0]));
      const wx2 = Math.max(wx1 + 1, x(clamp(cp.dateWindow[1])));
      const label = `Change detected around ${fmtDate(cp.date)} (likely ${fmtDate(cp.dateWindow[0])} to ${fmtDate(cp.dateWindow[1])})`;
      parts.push(`<rect class="cp-window" x="${n1(wx1)}" y="${panel.top}" width="${n1(wx2 - wx1)}" height="${PH}"><title>${esc(label)}</title></rect>`);
      parts.push(`<line class="cp-line" x1="${n1(x(cp.date))}" y1="${panel.top}" x2="${n1(x(cp.date))}" y2="${panel.top + PH}"/>`);
    }

    const line = sealedVals.map((v, i) => `${n1(x(sealed[i].date))},${n1(y(v))}`).join(' ');
    parts.push(`<polyline class="series series-${panel.key}" fill="none" points="${line}"/>`);
    if (provisional.length) {
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
  }

  // Month ticks along the bottom.
  const tickY = H - 6;
  let lastLabelX = -Infinity;
  for (let d = first; d <= last; ) {
    const [yy, mm] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
    const monthStart = `${yy}-${String(mm).padStart(2, '0')}-01`;
    if (monthStart >= first) {
      const tx = x(monthStart);
      if (tx - lastLabelX > 60) {
        parts.push(`<text class="axis-label" x="${n1(tx)}" y="${tickY}" text-anchor="middle">${esc(fmtDate(monthStart).replace(/^1 /, ''))}</text>`);
        lastLabelX = tx;
      }
    }
    const next = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    d = next;
  }
  parts.push('</svg>');
  return parts.join('');
}

/** Legend for the timeline's band patterns and markers (HTML). */
export function timelineLegend(): string {
  const item = (cls: string, text: string): string =>
    `<span class="legend-item"><svg width="14" height="10" aria-hidden="true"><rect class="band ${cls}" width="14" height="10"/></svg>${esc(text)}</span>`;
  return `<p class="legend">${item('band-core', BAND_NAME.core ?? '')}${item('band-spam', BAND_NAME.spam ?? '')}` +
    `${item('band-outage', BAND_NAME.outage ?? '')}${item('band-report', BAND_NAME.data_anomaly ?? '')}` +
    `${item('cp-window', 'Detected change (likely dates)')}` +
    '<span class="legend-item"><svg width="14" height="10" aria-hidden="true"><path class="sc-marker" d="M7 1l5 8h-10z"/></svg>Change on your site</span>' +
    '<span class="legend-item"><svg width="18" height="10" aria-hidden="true"><line class="series provisional" x1="0" y1="5" x2="18" y2="5"/></svg>Not final yet</span></p>';
}

/** Horizontal bars for the waterfall display groups, with 95% whiskers when known. */
export function waterfallSvg(scope: ScopeDecomposition): string {
  const rows = displayGroups(scope.bars, scope.ci95 as Record<string, [number, number]> | null);
  const total = { label: 'Total change', value: scope.deltaClicks, ci: scope.ci95?.total ?? null };
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
