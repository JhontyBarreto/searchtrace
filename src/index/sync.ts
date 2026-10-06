// Incremental partition load (sha256-tracked), snapshot delta replay, fresh reload. Owner: WP-A (internal to the index).
//
// Each sync lists the partitions in the store, hashes every file and loads only what is new
// or changed. Rules (spec 3.3):
// - gsc_day: per day only the highest revision is active; a new revision deletes that day's
//   rows and reloads them. Lower revisions are recorded as inactive.
// - gsc_fresh (state/gsc-fresh.ndjson.gz) is deleted and reloaded on every sync.
// - crawl: records that carry `fields` fill the fields table; records without them point at a
//   hash an earlier record carried (delta snapshots).
// - findings: finding_hist is rebuilt by replaying every findings partition in path order
//   whenever any of them changes.
// - annotations.ndjson is tracked like a partition and reloaded whole when it changes.
// Files that disappear have their rows removed.
import { StError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';
import { isIsoDate, ptDate, toInstant } from '../core/time.js';
import type {
  Annotation,
  DataStore,
  Finding,
  GoogleEvent,
  InspectionRecord,
  PartitionMeta,
  SerpObservation,
  SnapshotRecord,
} from '../core/types.js';
import { layout, parseGscDayPath } from '../store/layout.js';
import { parseLedgerText } from '../store/ledger.js';
import { decodeNdjsonGz, parseJsonSafe } from '../store/ndjson.js';
import { isLocalDataStore } from '../store/store.js';
import type { SqlDb } from './db.js';

export interface SyncResult {
  loaded: number;
  skipped: number;
  removed: number;
}

type Kind = 'gsc_day' | 'gsc_fresh' | 'inspect' | 'crawl' | 'serp' | 'google_events' | 'findings' | 'annotations';

const PER_RUN_PREFIX: Record<string, Kind> = {
  'inspect/': 'inspect',
  'crawl/': 'crawl',
  'serp/': 'serp',
  'google/': 'google_events',
  'findings/': 'findings',
};
/** Tables holding rows of per-run partitions, cleared by src when a file changes or disappears. */
const SRC_TABLES: Partial<Record<Kind, string[]>> = {
  inspect: ['inspection'],
  crawl: ['snapshot'],
  serp: ['serp'],
  google_events: ['gevent'],
  findings: [],
};
const GSC_TABLES = ['gsc_t', 'gsc_td', 'gsc_tc', 'gsc_p', 'gsc_qpd'];

interface KnownRow {
  path: string;
  sha256: string;
  kind: string;
  day: string | null;
  active: number;
}

interface FileRef {
  path: string;
  kind: Kind;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === 'string' && x !== '';
/** GSC TABLET is summed into mobile at ingest (D22); be forgiving if a raw device name slips through. */
function device(x: unknown): 'desktop' | 'mobile' | null {
  if (typeof x !== 'string') return null;
  const v = x.toLowerCase();
  if (v === 'desktop') return 'desktop';
  if (v === 'mobile' || v === 'tablet') return 'mobile';
  return null;
}

function tx<T>(db: SqlDb, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function corrupt(path: string, e: unknown): StError {
  const why = e instanceof Error ? e.message : String(e);
  return new StError('internal', `Could not read ${path}: ${why}`, `Delete ${path} or restore it from git, then run again.`);
}

async function listFiles(store: DataStore): Promise<FileRef[]> {
  const out: FileRef[] = [];
  for (const f of await store.list('gsc/')) if (parseGscDayPath(f.path)) out.push({ path: f.path, kind: 'gsc_day' });
  for (const [prefix, kind] of Object.entries(PER_RUN_PREFIX)) {
    for (const f of await store.list(prefix)) if (f.path.endsWith('.ndjson.gz')) out.push({ path: f.path, kind });
  }
  if (await store.exists(layout.gscFresh)) out.push({ path: layout.gscFresh, kind: 'gsc_fresh' });
  if (await store.exists(layout.annotations)) out.push({ path: layout.annotations, kind: 'annotations' });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Bytes (for the sha256) and a decoder. Foreign DataStores without readBytes hash the decoded content instead. */
async function readFileRef(store: DataStore, ref: FileRef): Promise<{ sha256: string; bytes: Uint8Array | null; text: string | null }> {
  if (ref.kind === 'annotations') {
    const text = (await store.readFile(ref.path)) ?? '';
    return { sha256: sha256Hex(text), bytes: null, text };
  }
  if (isLocalDataStore(store)) {
    const bytes = await store.readBytes(ref.path);
    if (!bytes) throw corrupt(ref.path, new Error('the file disappeared during sync'));
    return { sha256: sha256Hex(bytes), bytes, text: null };
  }
  const { meta, rows } = await store.readPartition(ref.path);
  return { sha256: sha256Hex(JSON.stringify({ meta, rows })), bytes: null, text: null };
}

async function decode<T>(store: DataStore, ref: FileRef, bytes: Uint8Array | null): Promise<{ meta: PartitionMeta; rows: T[] }> {
  try {
    return bytes ? await decodeNdjsonGz<T>(bytes) : await store.readPartition<T>(ref.path);
  } catch (e) {
    throw corrupt(ref.path, e);
  }
}

class Interner {
  private q: Map<string, number> | null = null;
  private pg: Map<string, number> | null = null;

  constructor(private readonly db: SqlDb) {}

  private load(table: 'q' | 'pg'): Map<string, number> {
    const col = table === 'q' ? 'text' : 'url';
    const rows = this.db.prepare(`SELECT id, ${col} AS v FROM ${table}`).all() as { id: number; v: string }[];
    return new Map(rows.map((r) => [r.v, Number(r.id)]));
  }

  query(text: string): number {
    this.q ??= this.load('q');
    return this.intern(this.q, 'INSERT INTO q(text) VALUES (?)', text);
  }

  page(url: string): number {
    this.pg ??= this.load('pg');
    return this.intern(this.pg, 'INSERT INTO pg(url) VALUES (?)', url);
  }

  private intern(map: Map<string, number>, sql: string, value: string): number {
    const hit = map.get(value);
    if (hit !== undefined) return hit;
    const id = Number(this.db.prepare(sql).run(value).lastInsertRowid);
    map.set(value, id);
    return id;
  }
}

function upsertPartition(
  db: SqlDb,
  p: { path: string; sha256: string; kind: Kind; day?: string | null; revision?: number | null; active: boolean; truncated?: boolean; fetchedAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO partitions(path, sha256, kind, day, revision, active, truncated, fetched_at, loaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, kind = excluded.kind, day = excluded.day,
       revision = excluded.revision, active = excluded.active, truncated = excluded.truncated,
       fetched_at = excluded.fetched_at, loaded_at = excluded.loaded_at`,
  ).run(
    p.path, p.sha256, p.kind, p.day ?? null, p.revision ?? null, p.active ? 1 : 0, p.truncated ? 1 : 0,
    p.fetchedAt ?? null, toInstant(new Date()),
  );
}

function setProperty(db: SqlDb, property: unknown, force: boolean): void {
  if (!str(property)) return;
  if (force) db.prepare("INSERT INTO info(key, value) VALUES ('property', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(property);
  else db.prepare("INSERT OR IGNORE INTO info(key, value) VALUES ('property', ?)").run(property);
}

// ---------- loaders (run inside a transaction) ----------

function insertGscRows(db: SqlDb, interner: Interner, date: string, rows: unknown[]): void {
  const insT = db.prepare('INSERT INTO gsc_t(date, c, i, ps) VALUES (?, ?, ?, ?)');
  const insTd = db.prepare('INSERT INTO gsc_td(date, dv, c, i, ps) VALUES (?, ?, ?, ?, ?)');
  const insTc = db.prepare('INSERT INTO gsc_tc(date, cc, c, i, ps) VALUES (?, ?, ?, ?, ?)');
  const insP = db.prepare('INSERT INTO gsc_p(date, pg, c, i, ps) VALUES (?, ?, ?, ?, ?)');
  const insQpd = db.prepare('INSERT INTO gsc_qpd(date, q, pg, dv, c, i, ps) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (!finite(r.c) || !finite(r.i) || !finite(r.ps)) continue;
    switch (r.s) {
      case 't':
        insT.run(date, r.c, r.i, r.ps);
        break;
      case 'td': {
        const dv = device(r.dv);
        if (dv) insTd.run(date, dv, r.c, r.i, r.ps);
        break;
      }
      case 'tc':
        if (str(r.cc)) insTc.run(date, r.cc.toLowerCase(), r.c, r.i, r.ps);
        break;
      case 'p':
        if (str(r.p)) insP.run(date, interner.page(r.p), r.c, r.i, r.ps);
        break;
      case 'qpd': {
        const dv = device(r.dv);
        if (str(r.p) && typeof r.q === 'string' && dv) insQpd.run(date, interner.query(r.q), interner.page(r.p), dv, r.c, r.i, r.ps);
        break;
      }
      default:
        break;
    }
  }
}

function deleteGscDay(db: SqlDb, day: string): void {
  for (const t of GSC_TABLES) db.prepare(`DELETE FROM ${t} WHERE date = ?`).run(day);
}

function loadFresh(db: SqlDb, rows: unknown[]): void {
  db.exec('DELETE FROM fresh_t; DELETE FROM fresh_td;');
  const insT = db.prepare('INSERT INTO fresh_t(date, c, i, ps) VALUES (?, ?, ?, ?)');
  const insTd = db.prepare('INSERT INTO fresh_td(date, dv, c, i, ps) VALUES (?, ?, ?, ?, ?)');
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    // Fresh rows span several days, so each carries its own date (`date`, or `d` as a short form).
    const date = typeof r.date === 'string' ? r.date : r.d;
    if (typeof date !== 'string' || !isIsoDate(date) || !finite(r.c) || !finite(r.i) || !finite(r.ps)) continue;
    if (r.s === 't') insT.run(date, r.c, r.i, r.ps);
    else if (r.s === 'td') {
      const dv = device(r.dv);
      if (dv) insTd.run(date, dv, r.c, r.i, r.ps);
    }
  }
}

function loadPerRun(db: SqlDb, kind: Kind, src: string, rows: unknown[]): void {
  if (kind === 'inspect') {
    const ins = db.prepare('INSERT INTO inspection(src, url, inspected_at, json) VALUES (?, ?, ?, ?)');
    for (const raw of rows) {
      const r = raw as InspectionRecord;
      if (str(r.url) && str(r.inspectedAt)) ins.run(src, r.url, r.inspectedAt, JSON.stringify(r));
    }
  } else if (kind === 'crawl') {
    const ins = db.prepare(
      'INSERT INTO snapshot(src, url, fetched_at, outcome, status, final_url, fields_hash, json_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insFields = db.prepare('INSERT OR IGNORE INTO fields(hash, json) VALUES (?, ?)');
    for (const raw of rows) {
      const r = raw as SnapshotRecord;
      if (!str(r.url) || !str(r.fetchedAt) || !str(r.outcome)) continue;
      const { fields, ...rest } = r;
      const hash = str(r.fieldsHash) ? r.fieldsHash : null;
      if (hash && fields && typeof fields === 'object') insFields.run(hash, JSON.stringify(fields));
      ins.run(src, r.url, r.fetchedAt, r.outcome, finite(r.status) ? r.status : null, r.finalUrl ?? null, hash, JSON.stringify(rest));
    }
  } else if (kind === 'serp') {
    const ins = db.prepare(
      'INSERT INTO serp(src, intent_key, task_id, observed_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET src = excluded.src, intent_key = excluded.intent_key, observed_at = excluded.observed_at, json = excluded.json',
    );
    for (const raw of rows) {
      const r = raw as SerpObservation;
      if (str(r.intentKey) && str(r.taskId) && str(r.observedAt)) ins.run(src, r.intentKey, r.taskId, r.observedAt, JSON.stringify(r));
    }
  } else if (kind === 'google_events') {
    const ins = db.prepare('INSERT INTO gevent(src, id, modified, begin_at, json) VALUES (?, ?, ?, ?, ?)');
    for (const raw of rows) {
      const r = raw as GoogleEvent;
      if (str(r.id)) ins.run(src, r.id, str(r.modified) ? r.modified : null, str(r.begin) ? r.begin : null, JSON.stringify(r));
    }
  }
}

function deleteBySrc(db: SqlDb, kind: Kind, src: string): void {
  for (const t of SRC_TABLES[kind] ?? []) db.prepare(`DELETE FROM ${t} WHERE src = ?`).run(src);
}

function loadAnnotations(db: SqlDb, text: string): void {
  db.exec('DELETE FROM annotation');
  const ins = db.prepare(
    'INSERT INTO annotation(id, date, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, json = excluded.json',
  );
  for (const a of parseLedgerText<Annotation>(text)) {
    if (str(a.id)) ins.run(a.id, typeof a.date === 'string' ? a.date : null, JSON.stringify(a));
  }
}

/** The day a findings partition reports for: meta.day when set, else the PT date of meta.fetchedAt. */
function reportedOn(meta: PartitionMeta): string | null {
  if (typeof meta.day === 'string' && isIsoDate(meta.day)) return meta.day;
  try {
    return ptDate(meta.fetchedAt);
  } catch {
    return null;
  }
}

async function rebuildFindingHistory(db: SqlDb, store: DataStore, files: FileRef[], cache: Map<string, Uint8Array | null>): Promise<void> {
  const hist = new Map<string, { first: string; last: string; finding: Finding }>();
  for (const ref of files) {
    const { meta, rows } = await decode<Finding>(store, ref, cache.get(ref.path) ?? (isLocalDataStore(store) ? await store.readBytes(ref.path) : null));
    const day = reportedOn(meta);
    if (!day) continue;
    for (const f of rows) {
      if (!str(f.id)) continue;
      const prev = hist.get(f.id);
      hist.set(f.id, { first: prev ? (prev.first < day ? prev.first : day) : day, last: prev && prev.last > day ? prev.last : day, finding: f });
    }
  }
  tx(db, () => {
    db.exec('DELETE FROM finding_hist');
    const ins = db.prepare('INSERT INTO finding_hist(id, first_reported, last_reported, json) VALUES (?, ?, ?, ?)');
    for (const [id, h] of hist) ins.run(id, h.first, h.last, JSON.stringify(h.finding));
  });
}

// ---------- sync ----------

export async function syncIndex(db: SqlDb, store: DataStore): Promise<SyncResult> {
  const result: SyncResult = { loaded: 0, skipped: 0, removed: 0 };
  const interner = new Interner(db);
  const files = await listFiles(store);
  const onDisk = new Set(files.map((f) => f.path));
  const known = new Map(
    (db.prepare('SELECT path, sha256, kind, day, active FROM partitions').all() as unknown as KnownRow[]).map((r) => [r.path, r]),
  );

  // The property comes from meta.json when present, else from the partitions.
  const metaText = await store.readFile(layout.meta);
  if (metaText) {
    try {
      setProperty(db, (parseJsonSafe(metaText) as { property?: unknown } | null)?.property, true);
    } catch {
      // a broken meta.json is doctor's business, not the index's
    }
  }

  // 1. Files that disappeared.
  let findingsRemoved = 0;
  for (const row of known.values()) {
    if (onDisk.has(row.path)) continue;
    if (row.kind === 'findings') findingsRemoved++;
    tx(db, () => {
      if (row.kind === 'gsc_day' && row.active === 1 && row.day) deleteGscDay(db, row.day);
      else if (row.kind === 'gsc_fresh') db.exec('DELETE FROM fresh_t; DELETE FROM fresh_td;');
      else if (row.kind === 'annotations') db.exec('DELETE FROM annotation');
      else deleteBySrc(db, row.kind as Kind, row.path);
      db.prepare('DELETE FROM partitions WHERE path = ?').run(row.path);
    });
    known.delete(row.path);
    result.removed++;
  }

  // 2. Sealed days: the highest revision per day is the active one.
  const days = new Map<string, { ref: FileRef; revision: number }[]>();
  for (const ref of files.filter((f) => f.kind === 'gsc_day')) {
    const parsed = parseGscDayPath(ref.path);
    if (!parsed) continue;
    const list = days.get(parsed.day) ?? [];
    list.push({ ref, revision: parsed.revision });
    days.set(parsed.day, list);
  }
  const activeByDay = new Map<string, KnownRow>();
  for (const row of known.values()) if (row.kind === 'gsc_day' && row.active === 1 && row.day) activeByDay.set(row.day, row);

  for (const [day, list] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    list.sort((a, b) => a.revision - b.revision);
    const top = list[list.length - 1];
    const current = activeByDay.get(day);
    const read = await readFileRef(store, top.ref);
    if (current && current.path === top.ref.path && current.sha256 === read.sha256) {
      result.skipped++;
    } else {
      const { meta, rows } = await decode(store, top.ref, read.bytes);
      const truncated = Object.values(meta.slices ?? {}).some((s) => s?.truncated === true);
      tx(db, () => {
        deleteGscDay(db, day);
        insertGscRows(db, interner, day, rows);
        db.prepare("UPDATE partitions SET active = 0 WHERE kind = 'gsc_day' AND day = ?").run(day);
        upsertPartition(db, { path: top.ref.path, sha256: read.sha256, kind: 'gsc_day', day, revision: top.revision, active: true, truncated, fetchedAt: meta.fetchedAt });
        setProperty(db, meta.property, false);
      });
      result.loaded++;
    }
    for (const lower of list.slice(0, -1)) {
      const k = known.get(lower.ref.path);
      if (!k || k.active !== 0) {
        const r = await readFileRef(store, lower.ref);
        upsertPartition(db, { path: lower.ref.path, sha256: r.sha256, kind: 'gsc_day', day, revision: lower.revision, active: false });
      }
      result.skipped++;
    }
  }

  // 3. The provisional tail: always reloaded.
  const fresh = files.find((f) => f.kind === 'gsc_fresh');
  if (fresh) {
    const read = await readFileRef(store, fresh);
    const { meta, rows } = await decode(store, fresh, read.bytes);
    tx(db, () => {
      loadFresh(db, rows);
      upsertPartition(db, { path: fresh.path, sha256: read.sha256, kind: 'gsc_fresh', active: true, fetchedAt: meta.fetchedAt });
    });
    result.loaded++;
  }

  // 4. Per-run partitions (inspect, crawl, serp, google, findings), in path order.
  const bytesCache = new Map<string, Uint8Array | null>();
  let findingsChanged = false;
  for (const ref of files.filter((f) => SRC_TABLES[f.kind] !== undefined)) {
    const read = await readFileRef(store, ref);
    const k = known.get(ref.path);
    if (k && k.sha256 === read.sha256) {
      result.skipped++;
      continue;
    }
    if (ref.kind === 'findings') {
      findingsChanged = true;
      bytesCache.set(ref.path, read.bytes);
      const { meta } = await decode(store, ref, read.bytes);
      tx(db, () => upsertPartition(db, { path: ref.path, sha256: read.sha256, kind: ref.kind, day: reportedOn(meta), active: true, fetchedAt: meta.fetchedAt }));
      result.loaded++;
      continue;
    }
    const { meta, rows } = await decode(store, ref, read.bytes);
    tx(db, () => {
      if (k) deleteBySrc(db, ref.kind, ref.path);
      loadPerRun(db, ref.kind, ref.path, rows);
      upsertPartition(db, { path: ref.path, sha256: read.sha256, kind: ref.kind, active: true, fetchedAt: meta.fetchedAt });
      setProperty(db, meta.property, false);
    });
    result.loaded++;
  }
  if (findingsChanged || findingsRemoved > 0) {
    await rebuildFindingHistory(db, store, files.filter((f) => f.kind === 'findings'), bytesCache);
  }

  // 5. Annotations (one append-only file).
  const ann = files.find((f) => f.kind === 'annotations');
  if (ann) {
    const read = await readFileRef(store, ann);
    const k = known.get(ann.path);
    if (k && k.sha256 === read.sha256) {
      result.skipped++;
    } else {
      tx(db, () => {
        loadAnnotations(db, read.text ?? '');
        upsertPartition(db, { path: ann.path, sha256: read.sha256, kind: 'annotations', active: true });
      });
      result.loaded++;
    }
  }

  return result;
}
