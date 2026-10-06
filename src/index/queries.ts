// IndexReader implementation: typed queries so analyzers never write SQL. Owner: WP-A (internal to the index).
//
// Conventions shared with test/helpers/memory-index.ts:
// - siteDaily and siteDeviceDaily return one row per SEALED day in range (per device for the
//   latter), with zeros on days Search Console reported nothing, so series are contiguous.
//   With { provisional: true } siteDaily returns only provisional days after the last sealed day.
// - pageDaily and cells are sparse (only stored rows).
// - Positions are never averaged here: callers get ps and i and divide.
// - Every list comes back in a fixed order, so analysis is deterministic.
import { ptDate } from '../core/time.js';
import type {
  Annotation,
  Cell,
  DayTotal,
  Device,
  Finding,
  GoogleEvent,
  IndexReader,
  Instant,
  InspectionRecord,
  IsoDate,
  PageDay,
  PageFields,
  SerpObservation,
  SnapshotRecord,
} from '../core/types.js';
import type { SqlDb } from './db.js';

const DEVICES: Device[] = ['desktop', 'mobile'];

type Row = Record<string, unknown>;

const num = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'bigint' ? Number(x) : Number(x ?? 0));
const json = <T>(x: unknown): T => JSON.parse(String(x)) as T;

/** Adds `AND <col> IN (list)` via json_each, so long lists never hit the bound-parameter limit. */
function inList(col: string, list: string[] | undefined, params: unknown[]): string {
  if (!list) return '';
  params.push(JSON.stringify(list));
  return ` AND ${col} IN (SELECT value FROM json_each(?))`;
}

export function createIndexReader(db: SqlDb): IndexReader {
  const all = (sql: string, params: unknown[] = []): Row[] =>
    db.prepare(sql).all(...(params as (string | number | null)[])) as Row[];
  const one = (sql: string, params: unknown[] = []): Row | undefined =>
    db.prepare(sql).get(...(params as (string | number | null)[])) as Row | undefined;

  const sealedDays = (from: IsoDate, to: IsoDate): IsoDate[] =>
    all("SELECT day FROM partitions WHERE kind = 'gsc_day' AND active = 1 AND day BETWEEN ? AND ? ORDER BY day", [from, to]).map(
      (r) => String(r.day),
    );

  const sealedThrough = (): IsoDate | null => {
    const r = one("SELECT MAX(day) AS d FROM partitions WHERE kind = 'gsc_day' AND active = 1");
    return r?.d ? String(r.d) : null;
  };

  const reader: IndexReader = {
    property() {
      const r = one("SELECT value FROM info WHERE key = 'property'");
      return r?.value ? String(r.value) : null;
    },

    dataRange() {
      const r = one("SELECT MIN(day) AS first, MAX(day) AS last FROM partitions WHERE kind = 'gsc_day' AND active = 1");
      const first = r?.first ? String(r.first) : null;
      const last = r?.last ? String(r.last) : null;
      const f = one('SELECT MAX(date) AS d FROM (SELECT date FROM fresh_t UNION ALL SELECT date FROM fresh_td)');
      const fresh = f?.d ? String(f.d) : null;
      return { first, sealedThrough: last, provisionalThrough: fresh && (!last || fresh > last) ? fresh : null };
    },

    siteDaily(from, to, o) {
      if (o?.provisional) {
        const last = sealedThrough();
        const params: unknown[] = [from, to, last ?? ''];
        const sql = o.device
          ? 'SELECT date, SUM(c) AS c, SUM(i) AS i, SUM(ps) AS ps FROM fresh_td WHERE date BETWEEN ? AND ? AND date > ? AND dv = ? GROUP BY date ORDER BY date'
          : 'SELECT date, SUM(c) AS c, SUM(i) AS i, SUM(ps) AS ps FROM fresh_t WHERE date BETWEEN ? AND ? AND date > ? GROUP BY date ORDER BY date';
        if (o.device) params.push(o.device);
        return all(sql, params).map((r) => ({ date: String(r.date), c: num(r.c), i: num(r.i), ps: num(r.ps) }));
      }
      const params: unknown[] = [from, to];
      const sql = o?.device
        ? 'SELECT date, SUM(c) AS c, SUM(i) AS i, SUM(ps) AS ps FROM gsc_td WHERE date BETWEEN ? AND ? AND dv = ? GROUP BY date'
        : 'SELECT date, SUM(c) AS c, SUM(i) AS i, SUM(ps) AS ps FROM gsc_t WHERE date BETWEEN ? AND ? GROUP BY date';
      if (o?.device) params.push(o.device);
      const byDate = new Map(all(sql, params).map((r) => [String(r.date), r]));
      return sealedDays(from, to).map((date): DayTotal => {
        const r = byDate.get(date);
        return { date, c: r ? num(r.c) : 0, i: r ? num(r.i) : 0, ps: r ? num(r.ps) : 0 };
      });
    },

    siteDeviceDaily(from, to) {
      const rows = all(
        'SELECT date, dv, SUM(c) AS c, SUM(i) AS i, SUM(ps) AS ps FROM gsc_td WHERE date BETWEEN ? AND ? GROUP BY date, dv',
        [from, to],
      );
      const key = (d: string, dv: string): string => `${d}|${dv}`;
      const byKey = new Map(rows.map((r) => [key(String(r.date), String(r.dv)), r]));
      return sealedDays(from, to).flatMap((date) =>
        DEVICES.map((dv) => {
          const r = byKey.get(key(date, dv));
          return { date, dv, c: r ? num(r.c) : 0, i: r ? num(r.i) : 0, ps: r ? num(r.ps) : 0 };
        }),
      );
    },

    countryTotals(from, to) {
      return all(
        'SELECT cc, SUM(c) AS c, SUM(i) AS i FROM gsc_tc WHERE date BETWEEN ? AND ? GROUP BY cc ORDER BY SUM(i) DESC, SUM(c) DESC, cc',
        [from, to],
      ).map((r) => ({ cc: String(r.cc), c: num(r.c), i: num(r.i) }));
    },

    pageDaily(from, to, o) {
      const params: unknown[] = [from, to];
      const filter = inList('pg.url', o?.pages, params);
      return all(
        `SELECT t.date AS date, pg.url AS p, t.c AS c, t.i AS i, t.ps AS ps FROM gsc_p t JOIN pg ON pg.id = t.pg
         WHERE t.date BETWEEN ? AND ?${filter} ORDER BY t.date, pg.url, t.rowid`,
        params,
      ).map((r): PageDay => ({ date: String(r.date), p: String(r.p), c: num(r.c), i: num(r.i), ps: num(r.ps) }));
    },

    cells(from, to, o) {
      const params: unknown[] = [from, to];
      const filter = inList('pg.url', o?.pages, params) + inList('q.text', o?.queries, params);
      return all(
        `SELECT t.date AS date, q.text AS q, pg.url AS p, t.dv AS dv, t.c AS c, t.i AS i, t.ps AS ps
         FROM gsc_qpd t JOIN q ON q.id = t.q JOIN pg ON pg.id = t.pg
         WHERE t.date BETWEEN ? AND ?${filter} ORDER BY t.date, q.text, pg.url, t.dv, t.rowid`,
        params,
      ).map((r): Cell => ({
        date: String(r.date), q: String(r.q), p: String(r.p), dv: r.dv as Device, c: num(r.c), i: num(r.i), ps: num(r.ps),
      }));
    },

    pages() {
      const seen = new Map<string, { firstSeen: IsoDate; lastSeen: IsoDate }>();
      const note = (url: string, first: IsoDate, last: IsoDate): void => {
        const prev = seen.get(url);
        seen.set(url, {
          firstSeen: prev && prev.firstSeen < first ? prev.firstSeen : first,
          lastSeen: prev && prev.lastSeen > last ? prev.lastSeen : last,
        });
      };
      for (const r of all('SELECT pg.url AS url, MIN(t.date) AS f, MAX(t.date) AS l FROM gsc_p t JOIN pg ON pg.id = t.pg GROUP BY pg.url')) {
        note(String(r.url), String(r.f), String(r.l));
      }
      for (const r of all('SELECT url, MIN(fetched_at) AS f, MAX(fetched_at) AS l FROM snapshot GROUP BY url')) {
        try {
          note(String(r.url), ptDate(String(r.f)), ptDate(String(r.l)));
        } catch {
          // a record with an unreadable time is skipped here; snapshots() still returns it
        }
      }
      return [...seen.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([url, v]) => ({ url, ...v }));
    },

    inspections(o) {
      const params: unknown[] = [];
      let where = 'WHERE 1 = 1';
      where += inList('url', o?.urls, params);
      if (o?.since) {
        where += ' AND inspected_at >= ?';
        params.push(o.since);
      }
      return all(`SELECT json FROM inspection ${where} ORDER BY inspected_at, url, src, rowid`, params).map((r) =>
        json<InspectionRecord>(r.json),
      );
    },

    snapshots(o) {
      const params: unknown[] = [];
      let where = 'WHERE 1 = 1';
      where += inList('url', o?.urls, params);
      if (o?.since) {
        where += ' AND fetched_at >= ?';
        params.push(o.since);
      }
      return all(`SELECT json_meta FROM snapshot ${where} ORDER BY fetched_at, url, src, rowid`, params).map((r) =>
        json<SnapshotRecord>(r.json_meta),
      );
    },

    fieldsByHash() {
      return new Map(all('SELECT hash, json FROM fields ORDER BY hash').map((r) => [String(r.hash), json<PageFields>(r.json)]));
    },

    annotations() {
      return all('SELECT json FROM annotation ORDER BY date, id').map((r) => json<Annotation>(r.json));
    },

    serp(o) {
      const params: unknown[] = [];
      let where = '';
      if (o?.since) {
        where = 'WHERE observed_at >= ?';
        params.push(o.since as Instant);
      }
      return all(`SELECT json FROM serp ${where} ORDER BY observed_at, task_id`, params).map((r) => json<SerpObservation>(r.json));
    },

    googleEvents() {
      // The latest `modified` wins per id; on a tie, the later partition (path order) wins.
      const latest = new Map<string, { modified: string; ev: GoogleEvent }>();
      for (const r of all('SELECT id, modified, json FROM gevent ORDER BY src, rowid')) {
        const id = String(r.id);
        const modified = r.modified ? String(r.modified) : '';
        const prev = latest.get(id);
        if (!prev || modified >= prev.modified) latest.set(id, { modified, ev: json<GoogleEvent>(r.json) });
      }
      return [...latest.values()]
        .map((x) => x.ev)
        .sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    findingsHistory() {
      return new Map(
        all('SELECT id, first_reported, last_reported, json FROM finding_hist ORDER BY id').map((r) => [
          String(r.id),
          { firstReported: String(r.first_reported), lastReported: String(r.last_reported), last: json<Finding>(r.json) },
        ]),
      );
    },

    truncatedDays() {
      return all("SELECT day FROM partitions WHERE kind = 'gsc_day' AND active = 1 AND truncated = 1 ORDER BY day").map((r) =>
        String(r.day),
      );
    },

    revisions() {
      return all("SELECT day, revision FROM partitions WHERE kind = 'gsc_day' AND active = 1 ORDER BY day").map((r) => ({
        day: String(r.day),
        revision: num(r.revision) || 1,
      }));
    },

    partitionsUsed() {
      // Left out: the provisional tail (it changes every run and analysis never uses it) and the
      // findings partitions (analysis writes them, so hashing them would feed each run's output
      // into the next run's seed and re-runs would never settle).
      return all("SELECT path, sha256 FROM partitions WHERE active = 1 AND kind NOT IN ('gsc_fresh', 'findings') ORDER BY path").map((r) => ({
        path: String(r.path),
        sha256: String(r.sha256),
      }));
    },
  };
  return reader;
}
