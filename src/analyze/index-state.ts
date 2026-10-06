// Index-state transition findings, EXTRACTED facts (5.10). Owner: WP-C.
//
// Between consecutive inspections of one URL, any change in coverageState, indexingState,
// robotsTxtState, or whether Google's canonical agrees with the page's own canonical becomes
// one finding: kind index_transition, template index_change, cause index_state, EXTRACTED.
// The finding describes the most telling field that changed (coverage first). Pure and
// deterministic: no clock, no randomness.
import { findingId } from '../core/ids.js';
import { ptDate } from '../core/time.js';
import type { Finding, InspectionRecord, IsoDate } from '../core/types.js';
import { normalizeUrl, pathOf } from '../core/url.js';

export const INDEX_STATE_ANALYZER = { name: 'index-state', version: '1' };
const FACT_PRIORITY = 5;

type StateField = 'coverageState' | 'indexingState' | 'robotsTxtState' | 'canonical';

const FIELD_LABEL: Record<StateField, string> = {
  coverageState: 'coverage',
  indexingState: 'indexing',
  robotsTxtState: 'robots.txt',
  canonical: 'canonical',
};

function safeNormalize(u: string): string {
  try {
    return normalizeUrl(u);
  } catch {
    return u;
  }
}

/** Whether Google's chosen canonical matches the page's own (or the page itself when it declares none). Null when unknown. */
export function canonicalAgrees(r: InspectionRecord): boolean | null {
  if (!r.googleCanonical) return null;
  const own = r.userCanonical ?? r.url;
  return safeNormalize(r.googleCanonical) === safeNormalize(own);
}

function canonicalText(r: InspectionRecord): string {
  const agrees = canonicalAgrees(r);
  if (agrees === null) return 'unknown';
  return agrees ? 'Google uses your canonical' : `Google picked another canonical (${r.googleCanonical})`;
}

function stateOf(r: InspectionRecord, f: StateField): string | null {
  if (f === 'canonical') {
    const a = canonicalAgrees(r);
    return a === null ? null : a ? 'agrees' : `differs:${safeNormalize(r.googleCanonical ?? '')}`;
  }
  const v = r[f];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function display(r: InspectionRecord, f: StateField): string {
  if (f === 'canonical') return canonicalText(r);
  return stateOf(r, f) ?? 'unknown';
}

/** The fields that changed between two inspections. A field missing on either side says nothing, so it does not count. */
export function changedFields(a: InspectionRecord, b: InspectionRecord): StateField[] {
  const fields: StateField[] = ['coverageState', 'indexingState', 'robotsTxtState', 'canonical'];
  return fields.filter((f) => {
    const x = stateOf(a, f);
    const y = stateOf(b, f);
    return x !== null && y !== null && x !== y;
  });
}

function evidencePartition(at: string): string {
  // Inspections live in inspect/YYYY/MM/<runId>.ndjson.gz; the run id is not kept on the record.
  return `inspect/${at.slice(0, 4)}/${at.slice(5, 7)}/`;
}

export function analyzeIndexStates(i: { inspections: InspectionRecord[]; dataThrough: IsoDate }): Finding[] {
  const byUrl = new Map<string, InspectionRecord[]>();
  for (const r of i.inspections) {
    if (!r || typeof r.url !== 'string' || !Number.isFinite(Date.parse(r.inspectedAt))) continue;
    const u = safeNormalize(r.url);
    const list = byUrl.get(u) ?? [];
    list.push({ ...r, url: u });
    byUrl.set(u, list);
  }
  const out: Finding[] = [];
  for (const [url, list] of byUrl) {
    list.sort((a, b) => Date.parse(a.inspectedAt) - Date.parse(b.inspectedAt));
    for (let k = 1; k < list.length; k++) {
      const prev = list[k - 1];
      const cur = list[k];
      const changed = changedFields(prev, cur);
      if (changed.length === 0) continue;
      const main = changed[0];
      const before = display(prev, main);
      const after = display(cur, main);
      const date = ptDate(cur.inspectedAt);
      const from = ptDate(prev.inspectedAt);
      const summary = changed.map((f) => `${FIELD_LABEL[f]}: ${display(prev, f)} to ${display(cur, f)}`).join('; ');
      out.push({
        id: findingId(['index_transition', url, date, changed.map((f) => `${f}=${stateOf(cur, f) ?? ''}`).join(',')]),
        kind: 'index_transition',
        unit: { level: 'page', key: url, label: pathOf(url) },
        metric: 'index_state',
        windows: null,
        date,
        dateWindow: [from, date],
        effect: { estimate: null, ci95: null, absolute: null, absoluteCi95: null, p: null, q: null },
        real: 'signal',
        reason: 'fact',
        cause: 'index_state',
        causeConfidence: 'EXTRACTED',
        components: null,
        componentCi95: null,
        power: null,
        template: 'index_change',
        slots: { url, before, after, date, field: FIELD_LABEL[main] },
        evidence: [
          {
            type: 'inspection',
            confidence: 'EXTRACTED',
            partition: evidencePartition(cur.inspectedAt),
            key: { url, inspectedAt: cur.inspectedAt, previousInspectedAt: prev.inspectedAt },
            summary,
          },
        ],
        alternatives: [],
        falsifier: { key: 'reverts', slots: {} },
        verify: { page: url, from, to: date },
        related: { googleEvents: [], siteChanges: [], findings: [] },
        analyzer: { ...INDEX_STATE_ANALYZER },
        priority: FACT_PRIORITY,
      });
    }
  }
  return out.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
