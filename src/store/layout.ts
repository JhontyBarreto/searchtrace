// Every data-dir path (spec 4.1) and the resolveInside() guard. Owner: WP-A.
//
// Paths are built only here, and only from validated dates, enum names, months and run ids.
// URLs never become path segments.
import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StError } from '../core/errors.js';
import { RUN_ID_RE } from '../core/ids.js';
import { isIsoDate, utcMonth } from '../core/time.js';
import type { Instant, IsoDate, Layout, LedgerStream } from '../core/types.js';

const PER_RUN_KINDS = new Set(['inspect', 'crawl', 'serp', 'findings', 'google']);
const LEDGER_STREAMS = new Set<LedgerStream>(['runs', 'spend', 'inspect', 'events']);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function badPathPart(what: string, value: unknown): never {
  throw new StError('internal', `Refusing to build a data path from an invalid ${what}: ${JSON.stringify(value)}`);
}

function gscDay(day: IsoDate, revision?: number): string {
  if (!isIsoDate(day)) return badPathPart('day', day);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) return badPathPart('revision', revision);
  const suffix = revision !== undefined && revision > 1 ? `.r${revision}` : '';
  return `gsc/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}${suffix}.ndjson.gz`;
}

function perRun(kind: 'inspect' | 'crawl' | 'serp' | 'findings' | 'google', runId: string, at: Instant): string {
  if (!PER_RUN_KINDS.has(kind)) return badPathPart('partition kind', kind);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return badPathPart('run id', runId);
  let month: string;
  try {
    month = utcMonth(at);
  } catch {
    return badPathPart('instant', at);
  }
  return `${kind}/${month.slice(0, 4)}/${month.slice(5, 7)}/${runId}.ndjson.gz`;
}

function ledger(stream: LedgerStream, month: string): string {
  if (!LEDGER_STREAMS.has(stream)) return badPathPart('ledger stream', stream);
  if (typeof month !== 'string' || !MONTH_RE.test(month)) return badPathPart('month', month);
  return `ledger/${stream}/${month}.ndjson`;
}

export const layout: Layout = {
  config: 'config.json',
  meta: 'meta.json',
  gscDay,
  gscFresh: 'state/gsc-fresh.ndjson.gz',
  perRun,
  annotations: 'annotations.ndjson',
  ledger,
  reportHtml: 'reports/latest.html',
  reportMd: 'reports/latest.md',
  findingsJson: 'reports/findings.json',
  graph: 'graphify-out/graph.json',
  graphMeta: 'graphify-out/searchtrace.meta.json',
  index: 'state/index.sqlite',
  lock: 'state/lock',
  cacheDir: 'state/cache',
};

/** Parses a gsc day path back into its day and revision (1 when there is no .rN suffix), or null. */
export function parseGscDayPath(rel: string): { day: IsoDate; revision: number } | null {
  const m = /^gsc\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})(?:\.r(\d+))?\.ndjson\.gz$/.exec(rel);
  if (!m || !isIsoDate(m[3]) || m[3].slice(0, 4) !== m[1] || m[3].slice(5, 7) !== m[2]) return null;
  const revision = m[4] === undefined ? 1 : Number(m[4]);
  return revision >= 1 ? { day: m[3], revision } : null;
}

/**
 * Pure syntax check for a data-dir-relative path or list prefix (no file system access):
 * forward slashes only, not absolute, no '.' or '..' segments, no empty segments, no NUL.
 * A list prefix may be '' or end with '/'. Returns rel unchanged or throws StError('internal').
 */
export function checkRelPath(rel: string, o: { prefix?: boolean } = {}): string {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) return badPathPart('relative path', rel);
  if (o.prefix && rel === '') return rel;
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return badPathPart('relative path', rel);
  const parts = rel.split('/');
  if (o.prefix && parts[parts.length - 1] === '') parts.pop();
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return badPathPart('relative path', rel);
  return rel;
}

/**
 * Resolves rel under root and returns the absolute path. Throws StError('internal') when rel
 * is absolute, empty, holds a NUL or a backslash, escapes root, or when any existing component
 * below root (a parent folder or the target itself) is a symbolic link. Root itself may be a
 * link (macOS /tmp is one).
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\')) {
    return badPathPart('relative path', rel);
  }
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return badPathPart('relative path', rel);
  const base = resolve(root);
  const abs = resolve(base, rel);
  const back = relative(base, abs);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new StError('internal', `Refusing a path outside the data folder: ${JSON.stringify(rel)}`);
  }
  let cursor = base;
  for (const part of back.split(sep)) {
    cursor = join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      break; // the rest does not exist yet, so it cannot be a link
    }
    if (st.isSymbolicLink()) {
      throw new StError('internal', `Refusing to follow a symbolic link inside the data folder: ${JSON.stringify(rel)}`);
    }
  }
  return abs;
}
