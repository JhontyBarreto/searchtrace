// deriveSiteChanges: field diffs, blast-radius grouping, googleSeen intervals (4.4, 4.3). Owner: WP-C.
//
// Pure. Only consecutive ok/not_modified snapshots of one URL are diffed (a blocked, timed out
// or failed fetch says nothing about the page). Each changed field gets a signature
// field:shape:template, where shape keeps only the part that changed with digit runs as '#',
// so the same edit across a template ("Post 1 | Brand" -> "Post 1 - Brand" on 40 pages) is one
// SiteChange with 40 touched URLs. Snapshots are grouped into crawl sessions (fetches with
// gaps under 30 minutes) and a change is keyed by (signature, the session it was seen in).
//
// googleSeen for a touched URL u with t1 = deployed.to (4.3): hi = the first observed
// lastCrawlTime >= t1. lo = t1, raised to the inspectedAt of any inspection between t1 and hi
// that still showed a lastCrawlTime before t1 (Google had not been back yet at that moment).
// Without a lastCrawlTime >= t1, googleSeen is null: Google has not seen the change yet.
import { nodeId } from '../../core/ids.js';
import { addDays, ptDayStart } from '../../core/time.js';
import type {
  Annotation,
  ChangeClass,
  ChangeField,
  InspectionRecord,
  Interval,
  PageFields,
  SiteChange,
  SnapshotRecord,
  TouchedUrl,
} from '../../core/types.js';
import { normalizeUrl, pathOf } from '../../core/url.js';
import { SUBSTANTIVE_DISTANCE, hammingDistance } from './simhash.js';

/** Fetches further apart than this belong to different crawl runs (runs are >= 1 hour apart). */
export const SESSION_GAP_MS = 30 * 60_000;
/** Template key for URLs the template map does not know (matches core/templates.ts). */
const FALLBACK_TEMPLATE = 'other pages';
const MAX_SHAPE = 200;
const MAX_LIST_SHOWN = 10;

const CLASS_OF: Record<ChangeField, ChangeClass> = {
  title: 'snippet',
  metaDescription: 'snippet',
  h1: 'content',
  body: 'content',
  jsonLdTypes: 'content',
  internalLinks: 'content',
  annotation: 'content',
  metaRobots: 'technical',
  xRobotsTag: 'technical',
  canonical: 'technical',
  status: 'technical',
};

export function classOf(field: ChangeField): ChangeClass {
  return CLASS_OF[field] ?? 'content';
}

function safeNormalize(u: string): string {
  try {
    return normalizeUrl(u);
  } catch {
    return u;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const mask = (s: string): string => s.replace(/\d+/g, '#');
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * The changed part of before -> after, with digit runs as '#'. Common prefix and suffix are
 * dropped, widened so a digit run is never split ("2025" -> "2026" stays whole).
 */
export function diffShape(before: string | null, after: string | null): string {
  if (before === null || after === null) {
    return `${before === null ? '(none)' : mask(before)}->${after === null ? '(none)' : mask(after)}`.slice(0, MAX_SHAPE);
  }
  const n = Math.min(before.length, after.length);
  let p = 0;
  while (p < n && before[p] === after[p]) p++;
  while (p > 0 && isDigit(before[p - 1]) && (isDigit(before[p]) || isDigit(after[p]))) p--;
  let s = 0;
  while (s < n - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  while (s > 0 && isDigit(before[before.length - s]) && (isDigit(before[before.length - 1 - s]) || isDigit(after[after.length - 1 - s]))) s--;
  const b = before.slice(p, before.length - s);
  const a = after.slice(p, after.length - s);
  return `${mask(b)}->${mask(a)}`.slice(0, MAX_SHAPE);
}

function listText(items: string[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_LIST_SHOWN).join(' ');
  return items.length > MAX_LIST_SHOWN ? `${shown} and ${items.length - MAX_LIST_SHOWN} more` : shown;
}

/** HTTP status class of a snapshot; a request that was redirected counts as 3xx. */
function statusClass(s: SnapshotRecord, previous: string | null): string | null {
  if (s.redirects.length > 0) return '3xx';
  if (s.outcome === 'not_modified' || s.status === 304) return previous;
  return s.status === null ? previous : `${Math.floor(s.status / 100)}xx`;
}

interface RawDiff {
  url: string;
  field: ChangeField;
  before: string | null;
  after: string | null;
  shape: string;
  prevAt: number;
  curAt: number;
  session: number;
}

const joinOrNull = (xs: string[], sep: string): string | null => (xs.length ? xs.join(sep) : null);

/** Field-by-field diff of two field sets. Unchanged fields produce nothing. */
export function diffFields(a: PageFields, b: PageFields): { field: ChangeField; before: string | null; after: string | null; shape: string }[] {
  const out: { field: ChangeField; before: string | null; after: string | null; shape: string }[] = [];
  const scalar = (field: ChangeField, x: string | null, y: string | null): void => {
    if (x !== y) out.push({ field, before: x, after: y, shape: diffShape(x, y) });
  };
  scalar('title', a.title, b.title);
  scalar('metaDescription', a.metaDescription, b.metaDescription);
  scalar('metaRobots', a.metaRobots, b.metaRobots);
  scalar('xRobotsTag', a.xRobotsTag, b.xRobotsTag);
  scalar('canonical', a.canonical, b.canonical);
  scalar('h1', joinOrNull(a.h1, ' | '), joinOrNull(b.h1, ' | '));
  scalar('jsonLdTypes', joinOrNull(a.jsonLdTypes, ', '), joinOrNull(b.jsonLdTypes, ', '));
  const before = new Set(a.internalLinks);
  const after = new Set(b.internalLinks);
  const added = b.internalLinks.filter((u) => !before.has(u)).map(pathOf).sort();
  const removed = a.internalLinks.filter((u) => !after.has(u)).map(pathOf).sort();
  if (added.length || removed.length) {
    out.push({
      field: 'internalLinks',
      before: listText(removed),
      after: listText(added),
      shape: mask(`+${added.slice(0, 20).join(' ')}|-${removed.slice(0, 20).join(' ')}`).slice(0, MAX_SHAPE),
    });
  }
  if (hammingDistance(a.simhash, b.simhash) > SUBSTANTIVE_DISTANCE) {
    out.push({ field: 'body', before: `${a.wordCount} words`, after: `${b.wordCount} words`, shape: 'rewrite' });
  }
  return out;
}

/** Session index per fetchedAt instant: sorted fetch times split wherever the gap exceeds SESSION_GAP_MS. */
function sessionsOf(snapshots: SnapshotRecord[]): Map<string, number> {
  const times = [...new Set(snapshots.map((s) => s.fetchedAt))]
    .map((t) => ({ t, ms: Date.parse(t) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  const out = new Map<string, number>();
  let session = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const { t, ms } of times) {
    if (ms - last > SESSION_GAP_MS && out.size > 0) session++;
    out.set(t, session);
    last = ms;
  }
  return out;
}

function inspectionsByUrl(inspections: InspectionRecord[]): Map<string, { inspectedAt: number; lastCrawl: number | null }[]> {
  const out = new Map<string, { inspectedAt: number; lastCrawl: number | null }[]>();
  for (const r of inspections) {
    const inspectedAt = Date.parse(r.inspectedAt);
    if (!Number.isFinite(inspectedAt)) continue;
    const lc = r.lastCrawlTime ? Date.parse(r.lastCrawlTime) : NaN;
    const key = safeNormalize(r.url);
    const list = out.get(key) ?? [];
    list.push({ inspectedAt, lastCrawl: Number.isFinite(lc) ? lc : null });
    out.set(key, list);
  }
  return out;
}

/** When Google first saw a change deployed by t1 on url (4.3), or null when it has not recrawled since. */
export function googleSeenFor(
  url: string,
  t1: string,
  byUrl: Map<string, { inspectedAt: number; lastCrawl: number | null }[]>,
): Interval | null {
  const t1ms = Date.parse(t1);
  const list = byUrl.get(url) ?? [];
  let hi: number | null = null;
  for (const r of list) if (r.lastCrawl !== null && r.lastCrawl >= t1ms && (hi === null || r.lastCrawl < hi)) hi = r.lastCrawl;
  if (hi === null) return null;
  let lo = t1ms;
  for (const r of list) {
    if (r.lastCrawl !== null && r.lastCrawl < t1ms && r.inspectedAt > lo && r.inspectedAt <= hi) lo = r.inspectedAt;
  }
  return { from: iso(lo), to: iso(hi), precision: 'bounded' };
}

function templateOf(url: string, templates: Map<string, string>): string {
  return templates.get(url) ?? FALLBACK_TEMPLATE;
}

function annotationChange(
  a: Annotation,
  templates: Map<string, string>,
  byUrl: Map<string, { inspectedAt: number; lastCrawl: number | null }[]>,
): SiteChange {
  const urls = [...new Set(a.urls.map(safeNormalize))].sort();
  const counts = new Map<string, number>();
  for (const u of urls) counts.set(templateOf(u, templates), (counts.get(templateOf(u, templates)) ?? 0) + 1);
  const templateKey =
    [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))[0]?.[0] ?? 'site';
  const deployed: Interval = { from: ptDayStart(a.date), to: ptDayStart(addDays(a.date, 1)), precision: 'unknown' };
  const signature = `${a.field}:note ${a.id}:${templateKey}`;
  return {
    id: nodeId('sitechg', signature + deployed.to),
    source: 'annotation',
    field: a.field,
    cls: classOf(a.field),
    templateKey,
    signature,
    deployed,
    touched: urls.map((url): TouchedUrl => ({ url, before: null, after: null, googleSeen: googleSeenFor(url, deployed.to, byUrl) })),
    text: a.text,
  };
}

export function deriveSiteChanges(i: {
  snapshots: SnapshotRecord[];
  fieldsByHash: Map<string, PageFields>;
  annotations: Annotation[];
  inspections: InspectionRecord[];
  templates: Map<string, string>;
}): SiteChange[] {
  const session = sessionsOf(i.snapshots);
  const byUrl = inspectionsByUrl(i.inspections);

  // Consecutive ok / not_modified snapshots per URL.
  const perUrl = new Map<string, SnapshotRecord[]>();
  for (const s of i.snapshots) {
    if ((s.outcome !== 'ok' && s.outcome !== 'not_modified') || !s.fieldsHash) continue;
    if (!Number.isFinite(Date.parse(s.fetchedAt))) continue;
    const key = safeNormalize(s.url);
    const list = perUrl.get(key) ?? [];
    list.push(s);
    perUrl.set(key, list);
  }

  const diffs: RawDiff[] = [];
  for (const [url, list] of perUrl) {
    list.sort((x, y) => Date.parse(x.fetchedAt) - Date.parse(y.fetchedAt));
    let prevClass: string | null = null;
    for (let k = 0; k < list.length; k++) {
      const cur = list[k];
      const curClass = statusClass(cur, prevClass);
      if (k > 0) {
        const prev = list[k - 1];
        const base = { url, prevAt: Date.parse(prev.fetchedAt), curAt: Date.parse(cur.fetchedAt), session: session.get(cur.fetchedAt) ?? 0 };
        if (prev.fieldsHash !== cur.fieldsHash) {
          const a = i.fieldsByHash.get(prev.fieldsHash ?? '');
          const b = i.fieldsByHash.get(cur.fieldsHash ?? '');
          if (a && b) for (const d of diffFields(a, b)) diffs.push({ ...base, ...d });
        }
        if (prevClass !== null && curClass !== null && prevClass !== curClass) {
          diffs.push({ ...base, field: 'status', before: prevClass, after: curClass, shape: `${prevClass}->${curClass}` });
        }
      }
      prevClass = curClass;
    }
  }

  // Group by (signature, session the change was seen in).
  const groups = new Map<string, { signature: string; field: ChangeField; templateKey: string; diffs: RawDiff[] }>();
  for (const d of diffs) {
    const templateKey = templateOf(d.url, i.templates);
    const signature = `${d.field}:${d.shape}:${templateKey}`;
    const key = `${signature}\u0000${d.session}`;
    const g = groups.get(key) ?? { signature, field: d.field, templateKey, diffs: [] };
    g.diffs.push(d);
    groups.set(key, g);
  }

  const out: SiteChange[] = [];
  for (const g of groups.values()) {
    const deployed: Interval = {
      from: iso(Math.min(...g.diffs.map((d) => d.prevAt))),
      to: iso(Math.max(...g.diffs.map((d) => d.curAt))),
      precision: 'bounded',
    };
    const touched = new Map<string, TouchedUrl>();
    for (const d of g.diffs) {
      if (touched.has(d.url)) continue;
      touched.set(d.url, { url: d.url, before: d.before, after: d.after, googleSeen: googleSeenFor(d.url, deployed.to, byUrl) });
    }
    out.push({
      id: nodeId('sitechg', g.signature + deployed.to),
      source: 'snapshot',
      field: g.field,
      cls: classOf(g.field),
      templateKey: g.templateKey,
      signature: g.signature,
      deployed,
      touched: [...touched.values()].sort((x, y) => (x.url < y.url ? -1 : x.url > y.url ? 1 : 0)),
      text: null,
    });
  }
  for (const a of i.annotations) {
    if (!a || typeof a.date !== 'string') continue;
    try {
      out.push(annotationChange(a, i.templates, byUrl));
    } catch {
      // an annotation with an impossible date is skipped rather than breaking the run
    }
  }
  return out.sort((x, y) => Date.parse(x.deployed.to) - Date.parse(y.deployed.to) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
