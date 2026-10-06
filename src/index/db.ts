// The only importer of node:sqlite: open, WAL, schema, migrations by rebuild. Owner: WP-A.
//
// The index is disposable: everything in it is derived from the partitions in the data
// folder. A schema change bumps SCHEMA_VERSION, which drops every table and lets the next
// sync reload from scratch. A corrupt index file is deleted and rebuilt the same way.
// bin.ts drops the SQLite ExperimentalWarning before this module is first imported.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IndexDb } from '../core/types.js';
import { createIndexReader } from './queries.js';
import { syncIndex } from './sync.js';

/** The open database handle, passed by type to sync.ts and queries.ts so only this file names node:sqlite. */
export type SqlDb = DatabaseSync;

/**
 * Secondary indexes on the big GSC tables. A large first load drops them, inserts, then builds them
 * again in one pass, which is several times faster than keeping them up to date row by row.
 */
export const BULK_INDEXES: { name: string; ddl: string }[] = [
  { name: 'gsc_p_pg', ddl: 'CREATE INDEX IF NOT EXISTS gsc_p_pg ON gsc_p(pg, date)' },
  { name: 'gsc_qpd_pg', ddl: 'CREATE INDEX IF NOT EXISTS gsc_qpd_pg ON gsc_qpd(pg, date)' },
  { name: 'gsc_qpd_q', ddl: 'CREATE INDEX IF NOT EXISTS gsc_qpd_q ON gsc_qpd(q, date)' },
];

/** Bump on any schema change: the index is dropped and rebuilt from the partitions. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE partitions(
  path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, kind TEXT NOT NULL, day TEXT, revision INTEGER,
  active INTEGER NOT NULL DEFAULT 1, truncated INTEGER NOT NULL DEFAULT 0, fetched_at TEXT, loaded_at TEXT NOT NULL
);
CREATE INDEX partitions_kind ON partitions(kind, day);
CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE q(id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE);
CREATE TABLE pg(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE);
CREATE TABLE gsc_t(date TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE gsc_td(date TEXT NOT NULL, dv TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE gsc_tc(date TEXT NOT NULL, cc TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE gsc_p(date TEXT NOT NULL, pg INTEGER NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE gsc_qpd(date TEXT NOT NULL, q INTEGER NOT NULL, pg INTEGER NOT NULL, dv TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE INDEX gsc_t_date ON gsc_t(date);
CREATE INDEX gsc_td_date ON gsc_td(date);
CREATE INDEX gsc_tc_date ON gsc_tc(date);
CREATE INDEX gsc_p_date ON gsc_p(date);
CREATE INDEX gsc_p_pg ON gsc_p(pg, date);
CREATE INDEX gsc_qpd_date ON gsc_qpd(date);
CREATE INDEX gsc_qpd_pg ON gsc_qpd(pg, date);
CREATE INDEX gsc_qpd_q ON gsc_qpd(q, date);
CREATE TABLE fresh_t(date TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE fresh_td(date TEXT NOT NULL, dv TEXT NOT NULL, c INTEGER NOT NULL, i INTEGER NOT NULL, ps REAL NOT NULL);
CREATE TABLE inspection(src TEXT NOT NULL, url TEXT NOT NULL, inspected_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX inspection_src ON inspection(src);
CREATE INDEX inspection_url ON inspection(url, inspected_at);
CREATE TABLE snapshot(
  src TEXT NOT NULL, url TEXT NOT NULL, fetched_at TEXT NOT NULL, outcome TEXT NOT NULL, status INTEGER,
  final_url TEXT, fields_hash TEXT, json_meta TEXT NOT NULL
);
CREATE INDEX snapshot_src ON snapshot(src);
CREATE INDEX snapshot_url ON snapshot(url, fetched_at);
CREATE TABLE fields(hash TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE serp(src TEXT NOT NULL, intent_key TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, observed_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX serp_src ON serp(src);
CREATE TABLE gevent(src TEXT NOT NULL, id TEXT NOT NULL, modified TEXT, begin_at TEXT, json TEXT NOT NULL);
CREATE INDEX gevent_src ON gevent(src);
CREATE TABLE annotation(id TEXT PRIMARY KEY, date TEXT, json TEXT NOT NULL);
CREATE TABLE finding_hist(id TEXT PRIMARY KEY, first_reported TEXT NOT NULL, last_reported TEXT NOT NULL, json TEXT NOT NULL);
`;

function userVersion(db: SqlDb): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Drops every table and index, then creates the current schema. */
function rebuild(db: SqlDb): void {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string }[];
  db.exec('BEGIN');
  try {
    for (const o of objects.filter((x) => x.type === 'table')) db.exec(`DROP TABLE IF EXISTS "${o.name.replace(/"/g, '""')}"`);
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function openRaw(path: string): SqlDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  if (userVersion(db) !== SCHEMA_VERSION) rebuild(db);
  return db;
}

/** ':memory:' allowed. A corrupt or unreadable index file is deleted and rebuilt. */
export async function openIndex(path: string): Promise<IndexDb> {
  let db: SqlDb;
  try {
    db = openRaw(path);
  } catch (e) {
    if (path === ':memory:') throw e;
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
    db = openRaw(path);
  }
  const reader = createIndexReader(db);
  let closed = false;
  return {
    ...reader,
    sync: (store) => syncIndex(db, store),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
