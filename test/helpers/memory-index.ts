// IndexReader built from plain arrays, for analyzer tests. Owner: WP-A.
//
// Follows the same conventions as src/index/queries.ts:
// - Sealed days are every day from the earliest to the latest date found in t, td, tc, p and
//   qpd (sealed day files are contiguous in real data). siteDaily and siteDeviceDaily return
//   one row per sealed day in range, zero-filled. { provisional: true } returns only freshT /
//   freshTd days after the last sealed day.
// - pageDaily and cells are sparse and sorted (date, then page; date, query, page, device).
// - revisions() lists every sealed day with the revision in use (1 unless `revisions` says otherwise).
// - partitionsUsed() defaults to one synthetic entry per non-empty input, hashed from its content.
import { sha256Hex } from '../../src/core/ids.js';
import { addDays, dateRange, ptDate } from '../../src/core/time.js';
import type {
  Annotation,
  Cell,
  DayTotal,
  Device,
  Finding,
  GoogleEvent,
  IndexReader,
  InspectionRecord,
  IsoDate,
  PageDay,
  PageFields,
  SerpObservation,
  SnapshotRecord,
} from '../../src/core/types.js';

export interface MemoryIndexInput {
  property?: string | null;
  /** Sealed (date) byProperty totals. */
  t?: DayTotal[];
  /** Sealed (date, device) byProperty totals. */
  td?: { date: IsoDate; dv: Device; c: number; i: number; ps: number }[];
  /** Sealed (date, country) byProperty totals. */
  tc?: { date: IsoDate; cc: string; c: number; i: number; ps: number }[];
  /** Sealed (date, page) byPage totals. */
  p?: PageDay[];
  /** Sealed (date, query, page, device) named cells. */
  qpd?: Cell[];
  /** Provisional tail (dates after the last sealed day). */
  freshT?: DayTotal[];
  freshTd?: { date: IsoDate; dv: Device; c: number; i: number; ps: number }[];
  inspections?: InspectionRecord[];
  /** Records may carry fields; those populate fieldsByHash too. */
  snapshots?: SnapshotRecord[];
  fields?: Map<string, PageFields> | Record<string, PageFields>;
  serp?: SerpObservation[];
  events?: GoogleEvent[];
  annotations?: Annotation[];
  /** Findings partitions in order, replayed into findingsHistory. */
  findings?: { reportedOn: IsoDate; findings: Finding[] }[];
  truncatedDays?: IsoDate[];
  revisions?: { day: IsoDate; revision: number }[];
  /** Defaults to one synthetic entry per input kind so inputsHash is stable. */
  partitions?: { path: string; sha256: string }[];
  /** Overrides the sealed day range [from, to] (inclusive) that zero-filling uses. */
  sealedRange?: [IsoDate, IsoDate];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const inRange = (d: IsoDate, from: IsoDate, to: IsoDate): boolean => d >= from && d <= to;
const DEVICES: Device[] = ['desktop', 'mobile'];

function sumBy<T extends { c: number; i: number; ps: number }>(rows: T[], key: (r: T) => string): Map<string, { c: number; i: number; ps: number }> {
  const out = new Map<string, { c: number; i: number; ps: number }>();
  for (const r of rows) {
    const k = key(r);
    const prev = out.get(k) ?? { c: 0, i: 0, ps: 0 };
    out.set(k, { c: prev.c + r.c, i: prev.i + r.i, ps: prev.ps + r.ps });
  }
  return out;
}

export function memoryIndex(i: MemoryIndexInput): IndexReader {
  const t = i.t ?? [];
  const td = i.td ?? [];
  const tc = i.tc ?? [];
  const p = i.p ?? [];
  const qpd = i.qpd ?? [];
  const freshT = i.freshT ?? [];
  const freshTd = i.freshTd ?? [];
  const snapshots = i.snapshots ?? [];

  const sealedDates = [...t, ...td, ...tc, ...p, ...qpd].map((r) => r.date).sort(cmp);
  const sealedFrom = i.sealedRange?.[0] ?? sealedDates[0] ?? null;
  const sealedTo = i.sealedRange?.[1] ?? sealedDates[sealedDates.length - 1] ?? null;
  const sealedIn = (from: IsoDate, to: IsoDate): IsoDate[] => {
    if (!sealedFrom || !sealedTo) return [];
    const lo = from > sealedFrom ? from : sealedFrom;
    const hi = to < sealedTo ? to : sealedTo;
    return lo <= hi ? dateRange(lo, hi) : [];
  };

  const fields = new Map<string, PageFields>(
    i.fields instanceof Map ? i.fields : Object.entries(i.fields ?? {}),
  );
  for (const s of snapshots) if (s.fieldsHash && s.fields && !fields.has(s.fieldsHash)) fields.set(s.fieldsHash, s.fields);

  const partitions =
    i.partitions ??
    (Object.entries(i) as [string, unknown][])
      .filter(([k, v]) => k !== 'partitions' && k !== 'property' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => ({
        path: `memory/${k}`,
        sha256: sha256Hex(JSON.stringify(v instanceof Map ? [...v.entries()] : v)),
      }))
      .sort((a, b) => cmp(a.path, b.path));

  return {
    property: () => i.property ?? null,

    dataRange() {
      const fresh = [...freshT, ...freshTd].map((r) => r.date).sort(cmp);
      const lastFresh = fresh[fresh.length - 1] ?? null;
      return {
        first: sealedFrom,
        sealedThrough: sealedTo,
        provisionalThrough: lastFresh && (!sealedTo || lastFresh > sealedTo) ? lastFresh : null,
      };
    },

    siteDaily(from, to, o) {
      if (o?.provisional) {
        const src = o.device ? freshTd.filter((r) => r.dv === o.device) : freshT;
        const after = sealedTo ?? '';
        const sums = sumBy(src.filter((r) => inRange(r.date, from, to) && r.date > after), (r) => r.date);
        return [...sums.entries()].sort(([a], [b]) => cmp(a, b)).map(([date, v]) => ({ date, ...v }));
      }
      const src = o?.device ? td.filter((r) => r.dv === o.device) : t;
      const sums = sumBy(src, (r) => r.date);
      return sealedIn(from, to).map((date): DayTotal => ({ date, ...(sums.get(date) ?? { c: 0, i: 0, ps: 0 }) }));
    },

    siteDeviceDaily(from, to) {
      const sums = sumBy(td, (r) => `${r.date}|${r.dv}`);
      return sealedIn(from, to).flatMap((date) =>
        DEVICES.map((dv) => ({ date, dv, ...(sums.get(`${date}|${dv}`) ?? { c: 0, i: 0, ps: 0 }) })),
      );
    },

    countryTotals(from, to) {
      const sums = sumBy(tc.filter((r) => inRange(r.date, from, to)), (r) => r.cc);
      return [...sums.entries()]
        .map(([cc, v]) => ({ cc, c: v.c, i: v.i }))
        .sort((a, b) => b.i - a.i || b.c - a.c || cmp(a.cc, b.cc));
    },

    pageDaily(from, to, o) {
      const pages = o?.pages ? new Set(o.pages) : null;
      return p
        .filter((r) => inRange(r.date, from, to) && (!pages || pages.has(r.p)))
        .map((r) => ({ ...r }))
        .sort((a, b) => cmp(a.date, b.date) || cmp(a.p, b.p));
    },

    cells(from, to, o) {
      const pages = o?.pages ? new Set(o.pages) : null;
      const queries = o?.queries ? new Set(o.queries) : null;
      return qpd
        .filter((r) => inRange(r.date, from, to) && (!pages || pages.has(r.p)) && (!queries || queries.has(r.q)))
        .map((r) => ({ ...r }))
        .sort((a, b) => cmp(a.date, b.date) || cmp(a.q, b.q) || cmp(a.p, b.p) || cmp(a.dv, b.dv));
    },

    pages() {
      const seen = new Map<string, { firstSeen: IsoDate; lastSeen: IsoDate }>();
      const note = (url: string, d: IsoDate): void => {
        const prev = seen.get(url);
        seen.set(url, {
          firstSeen: prev && prev.firstSeen < d ? prev.firstSeen : d,
          lastSeen: prev && prev.lastSeen > d ? prev.lastSeen : d,
        });
      };
      for (const r of p) note(r.p, r.date);
      for (const s of snapshots) note(s.url, ptDate(s.fetchedAt));
      return [...seen.entries()].sort(([a], [b]) => cmp(a, b)).map(([url, v]) => ({ url, ...v }));
    },

    inspections(o) {
      const urls = o?.urls ? new Set(o.urls) : null;
      return (i.inspections ?? [])
        .filter((r) => (!urls || urls.has(r.url)) && (!o?.since || r.inspectedAt >= o.since))
        .map((r) => structuredClone(r))
        .sort((a, b) => cmp(a.inspectedAt, b.inspectedAt) || cmp(a.url, b.url));
    },

    snapshots(o) {
      const urls = o?.urls ? new Set(o.urls) : null;
      return snapshots
        .filter((r) => (!urls || urls.has(r.url)) && (!o?.since || r.fetchedAt >= o.since))
        .map(({ fields: _omit, ...rest }) => structuredClone(rest) as SnapshotRecord)
        .sort((a, b) => cmp(a.fetchedAt, b.fetchedAt) || cmp(a.url, b.url));
    },

    fieldsByHash: () => new Map([...fields.entries()].sort(([a], [b]) => cmp(a, b)).map(([k, v]) => [k, structuredClone(v)])),

    annotations: () =>
      (i.annotations ?? []).map((a) => structuredClone(a)).sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id)),

    serp(o) {
      return (i.serp ?? [])
        .filter((r) => !o?.since || r.observedAt >= o.since)
        .map((r) => structuredClone(r))
        .sort((a, b) => cmp(a.observedAt, b.observedAt) || cmp(a.taskId, b.taskId));
    },

    googleEvents() {
      const latest = new Map<string, GoogleEvent>();
      for (const ev of i.events ?? []) {
        const prev = latest.get(ev.id);
        if (!prev || (ev.modified ?? '') >= (prev.modified ?? '')) latest.set(ev.id, ev);
      }
      return [...latest.values()].map((e) => structuredClone(e)).sort((a, b) => cmp(a.begin, b.begin) || cmp(a.id, b.id));
    },

    findingsHistory() {
      const hist = new Map<string, { firstReported: IsoDate; lastReported: IsoDate; last: Finding }>();
      for (const part of i.findings ?? []) {
        for (const f of part.findings) {
          const prev = hist.get(f.id);
          hist.set(f.id, {
            firstReported: prev && prev.firstReported < part.reportedOn ? prev.firstReported : part.reportedOn,
            lastReported: prev && prev.lastReported > part.reportedOn ? prev.lastReported : part.reportedOn,
            last: structuredClone(f),
          });
        }
      }
      return new Map([...hist.entries()].sort(([a], [b]) => cmp(a, b)));
    },

    truncatedDays: () => [...(i.truncatedDays ?? [])].sort(cmp),

    revisions() {
      const given = new Map((i.revisions ?? []).map((r) => [r.day, r.revision]));
      const days = new Set([...sealedIn(sealedFrom ?? '0000-01-01', sealedTo ?? '0000-01-01'), ...given.keys()]);
      return [...days].sort(cmp).map((day) => ({ day, revision: given.get(day) ?? 1 }));
    },

    partitionsUsed: () => partitions.map((x) => ({ ...x })),
  };
}

/** Convenience: n contiguous days of site totals from start, for quick fixtures. */
export function dayTotals(start: IsoDate, clicks: number[], impressions: number[], position = 10): DayTotal[] {
  return clicks.map((c, k) => ({ date: addDays(start, k), c, i: impressions[k] ?? 0, ps: (impressions[k] ?? 0) * position }));
}
