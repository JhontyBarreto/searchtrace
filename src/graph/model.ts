// Graph node kinds, relations, precedence, file_type and confidence mapping (7.2, 7.3). Owner: WP-D.
// Also the small pure helpers the builder shares: partition-path lookups, dates, labels.
import { addDays, diffDays, ptDate } from '../core/time.js';
import type { ChangeField, FileType, Instant, IsoDate, NodeKind } from '../core/types.js';
import { layout, parseGscDayPath } from '../store/layout.js';

export const NODE_KINDS: readonly NodeKind[] = Object.freeze([
  'site', 'page', 'query', 'tpl', 'dom', 'sitechg', 'gupd', 'finding', 'idx', 'cause',
] as const);

export const FILE_TYPE_OF: Readonly<Record<NodeKind, FileType>> = Object.freeze({
  site: 'concept',
  page: 'document',
  query: 'concept',
  tpl: 'concept',
  dom: 'concept',
  sitechg: 'rationale',
  gupd: 'rationale',
  finding: 'rationale',
  idx: 'concept',
  cause: 'concept',
});

export type Relation =
  | 'about' | 'measures' | 'attributed_to' | 'coincides_with' | 'touched' | 'ranks_for'
  | 'competes_with' | 'in_state' | 'instance_of' | 'part_of' | 'links_to';

/** Highest first: when two relations share a pair, the earlier one wins (7.3). */
export const RELATION_PRECEDENCE: readonly Relation[] = Object.freeze([
  'about', 'measures', 'attributed_to', 'coincides_with', 'touched', 'ranks_for',
  'competes_with', 'in_state', 'instance_of', 'part_of', 'links_to',
] as const);

export function precedenceOf(r: string): number {
  const k = RELATION_PRECEDENCE.indexOf(r as Relation);
  return k < 0 ? RELATION_PRECEDENCE.length : k;
}

/** Every node id searchtrace writes matches this (7.1 ownership rule). */
export const NODE_ID_PATTERN = /^(site|page|query|tpl|dom|sitechg|gupd|finding|idx|cause)_[a-z2-7]{12}$/;

export const VALID_FILE_TYPES: ReadonlySet<string> = new Set(['code', 'document', 'paper', 'image', 'rationale', 'concept']);
export const VALID_CONFIDENCES: ReadonlySet<string> = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

/** Allowed node source files: config.json, annotations.ndjson, a dated partition, or a dated month folder. */
export const SOURCE_FILE_PATTERN =
  /^(config\.json|annotations\.ndjson|gsc\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}(\.r\d+)?\.ndjson\.gz|(google|crawl|inspect|serp|findings)\/\d{4}\/\d{2}\/(r\d{8}t\d{6}z-[0-9a-f]{4}\.ndjson\.gz)?)$/;

export const CONFIG_FILE = layout.config;
export const ANNOTATIONS_FILE = layout.annotations;

// ---------- partition paths ----------

const PER_RUN_RE = /^(google|crawl|inspect|serp|findings)\/(\d{4})\/(\d{2})\/r(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})z-[0-9a-f]{4}\.ndjson\.gz$/;

export type PerRunKind = 'google' | 'crawl' | 'inspect' | 'serp' | 'findings';

/** Run start (UTC ms) encoded in a per-run partition name, or null. */
export function runTimeOf(path: string): number | null {
  const m = PER_RUN_RE.exec(path);
  if (!m) return null;
  return Date.UTC(+m[4], +m[5] - 1, +m[6], +m[7], +m[8], +m[9]);
}

/** Per-run partitions of one kind with their run times, oldest first. */
export interface PartitionIndex {
  gsc: Map<IsoDate, string>;
  perRun: Record<PerRunKind, { path: string; at: number }[]>;
}

export function indexPartitions(paths: string[]): PartitionIndex {
  const gsc = new Map<IsoDate, { path: string; rev: number }>();
  const perRun: PartitionIndex['perRun'] = { google: [], crawl: [], inspect: [], serp: [], findings: [] };
  for (const p of paths) {
    const day = parseGscDayPath(p);
    if (day) {
      const prev = gsc.get(day.day);
      if (!prev || day.revision > prev.rev) gsc.set(day.day, { path: p, rev: day.revision });
      continue;
    }
    const at = runTimeOf(p);
    const m = PER_RUN_RE.exec(p);
    if (at !== null && m) perRun[m[1] as PerRunKind].push({ path: p, at });
  }
  for (const k of Object.keys(perRun) as PerRunKind[]) perRun[k].sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : 1));
  return { gsc: new Map([...gsc.entries()].map(([d, v]) => [d, v.path])), perRun };
}

/** The sealed day file for a PT day (highest revision seen), or its first-revision name. */
export function gscPathFor(ix: PartitionIndex, day: IsoDate): string {
  return ix.gsc.get(day) ?? layout.gscDay(day);
}

/** UTC month folder for a time, e.g. 'serp/2026/10/'. */
export function monthFolder(kind: PerRunKind, at: Instant | number): string {
  const iso = new Date(typeof at === 'number' ? at : Date.parse(at)).toISOString();
  return `${kind}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/`;
}

/** Records written during a run (crawl, inspect): the latest partition whose run started at or before `at`. */
export function partitionHolding(ix: PartitionIndex, kind: PerRunKind, at: Instant): string {
  const t = Date.parse(at);
  const list = ix.perRun[kind];
  let hit: string | null = null;
  for (const p of list) if (p.at <= t) hit = p.path;
  return hit ?? list[0]?.path ?? monthFolder(kind, Number.isNaN(t) ? 0 : t);
}

/**
 * Records stored after they happened (SERP results, Google events): the first partition whose
 * run started at or after `at` (with a small allowance for clock skew), else the latest one.
 */
export function partitionAfter(ix: PartitionIndex, kind: PerRunKind, at: Instant, skewMs = 60_000): string {
  const t = Date.parse(at);
  const list = ix.perRun[kind];
  const hit = list.find((p) => p.at >= t - skewMs);
  return hit?.path ?? list[list.length - 1]?.path ?? monthFolder(kind, Number.isNaN(t) ? 0 : t);
}

// ---------- dates and labels ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-09' -> '9 Sep 2026'. */
export function fmtDay(d: IsoDate): string {
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** Overlapping days between two inclusive date ranges (0 when apart). */
export function overlapDays(a: [IsoDate, IsoDate], b: [IsoDate, IsoDate]): number {
  const lo = a[0] > b[0] ? a[0] : b[0];
  const hi = a[1] < b[1] ? a[1] : b[1];
  return lo > hi ? 0 : diffDays(lo, hi) + 1;
}

/** The PT range of a Google event; an open event runs 14 days. */
export function eventRange(begin: Instant, end: Instant | null): [IsoDate, IsoDate] {
  const b = ptDate(begin);
  return [b, end ? ptDate(end) : addDays(b, 14)];
}

export const FIELD_LABEL: Readonly<Record<ChangeField, string>> = Object.freeze({
  title: 'Title',
  metaDescription: 'Meta description',
  metaRobots: 'Robots meta tag',
  xRobotsTag: 'X-Robots-Tag header',
  canonical: 'Canonical',
  h1: 'H1',
  jsonLdTypes: 'Structured data',
  internalLinks: 'Internal links',
  body: 'Page content',
  status: 'Status code',
  annotation: 'Noted change',
});

/** Cut to n characters on a word boundary where possible, ending with '...'. */
export function truncate(s: string, n: number): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export function stripWww(domain: string): string {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, '');
  return d.startsWith('www.') ? d.slice(4) : d;
}
