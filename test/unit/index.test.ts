import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { DataStore, IndexDb, PartitionMeta } from '../../src/core/types.js';
import { openIndex } from '../../src/index/db.js';
import { layout } from '../../src/store/layout.js';
import { openStore } from '../../src/store/store.js';
import { FIXTURE_PROPERTY, FIXTURE_RUNS, fixtureFields, fixtureFinding, fixtureSealedRows, seedDataDir } from '../helpers/fixture-data.js';
import { memoryIndex } from '../helpers/memory-index.js';
import { memoryStore } from '../helpers/memory-store.js';

const HOME = 'https://example.com/';
const POST = 'https://example.com/blog/first-post';
const ALL = ['2026-01-01', '2026-12-31'] as const;

let dir: string;
let open: IndexDb[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'searchtrace-index-'));
});
afterEach(() => {
  for (const db of open) db.close();
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

async function index(path = ':memory:'): Promise<IndexDb> {
  const db = await openIndex(path);
  open.push(db);
  return db;
}

const metaFor = (day: string, revision: number): PartitionMeta => ({
  kind: 'gsc_day', schema: 1, property: FIXTURE_PROPERTY, toolVersion: '0.1.0', runId: 'r20261006t061700z-0b03',
  fetchedAt: '2026-10-06T06:17:00Z', day, revision, dataState: 'final',
});

describe.each([
  ['memory store', async (): Promise<DataStore> => memoryStore()],
  ['disk store', async (): Promise<DataStore> => openStore(dir, createSecretRegistry({ ci: false }))],
] as const)('openIndex(":memory:") + sync over a fixture data dir (%s)', (_name, makeStore) => {
  it('round-trips every row type', async () => {
    const store = await makeStore();
    const seeded = await seedDataDir(store);
    const db = await index();
    const res = await db.sync(store);
    // loaded: 6 sealed days + fresh + inspect + 2 crawl + serp + 2 google + 2 findings + annotations; skipped: revision 1 of 10-01
    expect(res).toEqual({ loaded: 16, skipped: 1, removed: 0 });

    expect(db.property()).toBe(FIXTURE_PROPERTY);
    expect(db.dataRange()).toEqual({ first: '2026-09-28', sealedThrough: '2026-10-03', provisionalThrough: '2026-10-05' });

    // t: one row per sealed day, zero-filled on the empty day, 10-01 from revision 2.
    expect(db.siteDaily(...ALL)).toEqual([
      { date: '2026-09-28', c: 3, i: 100, ps: 800 },
      { date: '2026-09-29', c: 6, i: 200, ps: 1600 },
      { date: '2026-09-30', c: 0, i: 0, ps: 0 },
      { date: '2026-10-01', c: 90, i: 3000, ps: 24000 },
      { date: '2026-10-02', c: 12, i: 400, ps: 3200 },
      { date: '2026-10-03', c: 15, i: 500, ps: 4000 },
    ]);
    expect(db.siteDaily('2026-09-29', '2026-09-30', { device: 'mobile' })).toEqual([
      { date: '2026-09-29', c: 2, i: 60, ps: 620 },
      { date: '2026-09-30', c: 0, i: 0, ps: 0 },
    ]);
    // Provisional rows only after the last sealed day (the 10-02 overlap is ignored).
    expect(db.siteDaily(...ALL, { provisional: true })).toEqual([
      { date: '2026-10-04', c: 1, i: 50, ps: 400 },
      { date: '2026-10-05', c: 0, i: 20, ps: 180 },
    ]);
    expect(db.siteDaily(...ALL, { provisional: true, device: 'desktop' })).toEqual([{ date: '2026-10-04', c: 1, i: 40, ps: 300 }]);

    const dev = db.siteDeviceDaily('2026-09-30', '2026-10-01');
    expect(dev).toEqual([
      { date: '2026-09-30', dv: 'desktop', c: 0, i: 0, ps: 0 },
      { date: '2026-09-30', dv: 'mobile', c: 0, i: 0, ps: 0 },
      { date: '2026-10-01', dv: 'desktop', c: 60, i: 2100, ps: 14700 },
      { date: '2026-10-01', dv: 'mobile', c: 30, i: 900, ps: 9300 },
    ]);
    expect(db.countryTotals('2026-09-28', '2026-09-29')).toEqual([
      { cc: 'gbr', c: 6, i: 180 },
      { cc: 'usa', c: 3, i: 120 },
    ]);

    expect(db.pageDaily('2026-09-28', '2026-09-28')).toEqual([
      { date: '2026-09-28', p: POST, c: 1, i: 45, ps: 540 },
      { date: '2026-09-28', p: HOME, c: 2, i: 60, ps: 300 },
    ].sort((a, b) => (a.p < b.p ? -1 : 1)));
    expect(db.pageDaily(...ALL, { pages: [POST] })).toHaveLength(5);
    expect(db.cells('2026-10-03', '2026-10-03')).toEqual([
      { date: '2026-10-03', q: 'example brand', p: HOME, dv: 'desktop', c: 5, i: 50, ps: 50 },
      { date: '2026-10-03', q: 'how to example', p: POST, dv: 'mobile', c: 0, i: 25, ps: 200 },
    ]);
    expect(db.cells(...ALL, { queries: ['example brand'], pages: [HOME] })).toHaveLength(5);
    expect(db.cells(...ALL, { queries: [] })).toEqual([]);

    expect(db.pages()).toEqual([
      { url: HOME, firstSeen: '2026-09-28', lastSeen: '2026-10-04' },
      { url: POST, firstSeen: '2026-09-28', lastSeen: '2026-10-04' },
      { url: 'https://example.com/new-page', firstSeen: '2026-10-04', lastSeen: '2026-10-04' },
    ]);

    expect(db.inspections()).toEqual(seeded.inspections);
    expect(db.inspections({ urls: [POST] })).toEqual([seeded.inspections[1]]);
    expect(db.inspections({ since: '2026-10-04T07:00:01Z' })).toEqual([seeded.inspections[1]]);

    // Delta snapshot replay: the 10-05 home record carries no fields but its hash resolves.
    const snaps = db.snapshots();
    expect(snaps).toHaveLength(5);
    expect(snaps.every((s) => !('fields' in s))).toBe(true);
    const fields = db.fieldsByHash();
    expect([...fields.keys()]).toEqual(['hash-a', 'hash-b', 'hash-c']);
    const homeLatest = db.snapshots({ urls: [HOME], since: '2026-10-05T00:00:00Z' });
    expect(homeLatest).toHaveLength(1);
    expect(fields.get(homeLatest[0].fieldsHash as string)).toEqual(fixtureFields('Home | Example', [POST]));
    expect(fields.get('hash-c')?.title).toBe('First post, updated | Example');

    expect(db.annotations().map((a) => a.id)).toEqual(['ann-1', 'ann-2']); // by date; the torn line is skipped
    expect(db.serp()).toEqual(seeded.serp);
    expect(db.serp({ since: '2026-10-06T00:00:00Z' })).toEqual([]);

    const events = db.googleEvents();
    expect(events.map((e) => [e.id, e.title])).toEqual([
      ['e-spam', 'Fake spam update'],
      ['e-core', 'Fake core update (complete)'],
    ]);

    const hist = db.findingsHistory();
    expect([...hist.keys()].sort()).toEqual(['fchangepoint0002', 'fheadline0000001', 'fnew000000000003']);
    // Reported on the PT date of each run (06:17Z is still the previous evening in California).
    expect(hist.get('fheadline0000001')).toMatchObject({ firstReported: '2026-10-03', lastReported: '2026-10-04' });
    expect(hist.get('fheadline0000001')?.last.unit.label).toBe('Whole site (updated)');
    expect(hist.get('fchangepoint0002')).toMatchObject({ firstReported: '2026-10-03', lastReported: '2026-10-03' });

    expect(db.truncatedDays()).toEqual(['2026-10-02']);
    expect(db.revisions()).toEqual([
      { day: '2026-09-28', revision: 1 }, { day: '2026-09-29', revision: 1 }, { day: '2026-09-30', revision: 1 },
      { day: '2026-10-01', revision: 2 }, { day: '2026-10-02', revision: 1 }, { day: '2026-10-03', revision: 1 },
    ]);

    const used = db.partitionsUsed();
    expect(used.map((u) => u.path)).toEqual([
      'annotations.ndjson',
      `crawl/2026/10/${FIXTURE_RUNS[0]}.ndjson.gz`,
      `crawl/2026/10/${FIXTURE_RUNS[1]}.ndjson.gz`,
      `google/2026/10/${FIXTURE_RUNS[0]}.ndjson.gz`,
      `google/2026/10/${FIXTURE_RUNS[1]}.ndjson.gz`,
      'gsc/2026/09/2026-09-28.ndjson.gz', 'gsc/2026/09/2026-09-29.ndjson.gz', 'gsc/2026/09/2026-09-30.ndjson.gz',
      'gsc/2026/10/2026-10-01.r2.ndjson.gz', 'gsc/2026/10/2026-10-02.ndjson.gz', 'gsc/2026/10/2026-10-03.ndjson.gz',
      `inspect/2026/10/${FIXTURE_RUNS[0]}.ndjson.gz`,
      `serp/2026/10/${FIXTURE_RUNS[1]}.ndjson.gz`,
    ]);
    expect(used.every((u) => /^[0-9a-f]{64}$/.test(u.sha256))).toBe(true);
  });

  it('is idempotent: a second sync reloads only the provisional tail (test 68)', async () => {
    const store = await makeStore();
    await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    const before = { daily: db.siteDaily(...ALL), cells: db.cells(...ALL), used: db.partitionsUsed(), hist: [...db.findingsHistory()] };
    expect(await db.sync(store)).toEqual({ loaded: 1, skipped: 16, removed: 0 });
    expect(db.siteDaily(...ALL)).toEqual(before.daily);
    expect(db.cells(...ALL)).toEqual(before.cells);
    expect(db.partitionsUsed()).toEqual(before.used);
    expect([...db.findingsHistory()]).toEqual(before.hist);
  });

  it('a new revision replaces its day; removing it falls back to the previous one (test 68)', async () => {
    const store = await makeStore();
    await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    const r2 = layout.gscDay('2026-10-03', 2);
    await store.writePartition(r2, metaFor('2026-10-03', 2), [{ s: 't', c: 7, i: 700, ps: 7000 }, { s: 'p', p: HOME, c: 7, i: 700, ps: 7000 }]);
    expect(await db.sync(store)).toMatchObject({ loaded: 2, removed: 0 });
    expect(db.siteDaily('2026-10-03', '2026-10-03')).toEqual([{ date: '2026-10-03', c: 7, i: 700, ps: 7000 }]);
    expect(db.cells('2026-10-03', '2026-10-03')).toEqual([]); // the revision has no named rows
    expect(db.pageDaily('2026-10-03', '2026-10-03')).toEqual([{ date: '2026-10-03', p: HOME, c: 7, i: 700, ps: 7000 }]);
    expect(db.revisions().find((r) => r.day === '2026-10-03')).toEqual({ day: '2026-10-03', revision: 2 });
    expect(db.partitionsUsed().map((u) => u.path)).toContain(r2);
    expect(db.partitionsUsed().map((u) => u.path)).not.toContain('gsc/2026/10/2026-10-03.ndjson.gz');

    await store.removeFile(r2);
    expect(await db.sync(store)).toMatchObject({ removed: 1 });
    expect(db.siteDaily('2026-10-03', '2026-10-03')).toEqual([{ date: '2026-10-03', c: 15, i: 500, ps: 4000 }]);
    expect(db.cells('2026-10-03', '2026-10-03')).toHaveLength(2);
  });

  it('reloads changed provisional data and drops it when the file goes (test 68)', async () => {
    const store = await makeStore();
    await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    await store.writePartition(layout.gscFresh, { ...metaFor('2026-10-06', 1), kind: 'gsc_fresh', day: undefined, revision: undefined }, [
      { s: 't', date: '2026-10-06', c: 4, i: 44, ps: 440 },
    ]);
    await db.sync(store);
    expect(db.siteDaily(...ALL, { provisional: true })).toEqual([{ date: '2026-10-06', c: 4, i: 44, ps: 440 }]);
    expect(db.dataRange().provisionalThrough).toBe('2026-10-06');
    await store.removeFile(layout.gscFresh);
    expect(await db.sync(store)).toMatchObject({ removed: 1 });
    expect(db.siteDaily(...ALL, { provisional: true })).toEqual([]);
    expect(db.dataRange().provisionalThrough).toBeNull();
  });

  it('removes rows of deleted partitions and replays findings again', async () => {
    const store = await makeStore();
    await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    await store.removeFile(layout.perRun('crawl', FIXTURE_RUNS[1], '2026-10-05T06:17:00Z'));
    await store.removeFile(layout.perRun('findings', FIXTURE_RUNS[1], '2026-10-05T06:17:00Z'));
    expect(await db.sync(store)).toMatchObject({ removed: 2 });
    expect(db.snapshots()).toHaveLength(2);
    const hist = db.findingsHistory();
    expect([...hist.keys()].sort()).toEqual(['fchangepoint0002', 'fheadline0000001']);
    expect(hist.get('fheadline0000001')?.lastReported).toBe('2026-10-03');

    // A findings partition with meta.day uses that day as the reporting day.
    const run3 = 'r20261006t161700z-0c04';
    await store.writePartition(
      layout.perRun('findings', run3, '2026-10-06T16:17:00Z'),
      { kind: 'findings', schema: 1, property: FIXTURE_PROPERTY, toolVersion: '0.1.0', runId: run3, fetchedAt: '2026-10-06T16:17:00Z', day: '2026-10-05' },
      [fixtureFinding('fchangepoint0002', 'signal')],
    );
    await db.sync(store);
    expect(db.findingsHistory().get('fchangepoint0002')).toMatchObject({ firstReported: '2026-10-03', lastReported: '2026-10-05' });
    expect(db.findingsHistory().get('fchangepoint0002')?.last.real).toBe('signal');
  });

  it('reloads annotations when the file changes', async () => {
    const store = await makeStore();
    await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    const text = (await store.readFile(layout.annotations)) ?? '';
    await store.writeFileAtomic(
      layout.annotations,
      `${text}\n${JSON.stringify({ id: 'ann-3', at: '2026-10-06T08:00:00Z', date: '2026-10-01', text: 'x', urls: [], field: 'annotation' })}\n`,
    );
    expect(await db.sync(store)).toMatchObject({ loaded: 2 });
    expect(db.annotations().map((a) => a.id)).toEqual(['ann-1', 'ann-2', 'ann-3']);
  });
});

describe('bulk loads', () => {
  it('loads many new days with the secondary indexes rebuilt afterwards, then stays incremental', async () => {
    const store = memoryStore();
    const days = Array.from({ length: 70 }, (_, k) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10));
    const rows = (c: number) => [
      { s: 't', c, i: 100, ps: 500 },
      { s: 'p', p: HOME, c, i: 100, ps: 500 },
      { s: 'qpd', q: 'plumber near me', p: HOME, dv: 'desktop', c, i: 60, ps: 300 },
    ];
    for (const day of days) await store.writePartition(layout.gscDay(day), metaFor(day, 1), rows(3));
    const path = join(dir, 'index.sqlite');
    const db = await index(path);
    const first = await db.sync(store);
    expect(first.loaded).toBe(70);
    expect(db.pageDaily(days[0], days[69], { pages: [HOME] })).toHaveLength(70);
    expect(db.cells(days[0], days[69], { queries: ['plumber near me'] })).toHaveLength(70);
    // The indexes dropped for the bulk load are back.
    const raw = new DatabaseSync(path);
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('gsc_p_pg', 'gsc_qpd_pg', 'gsc_qpd_q')").all() as { name: string }[]).map((r) => r.name).sort();
    raw.close();
    expect(names).toEqual(['gsc_p_pg', 'gsc_qpd_pg', 'gsc_qpd_q']);
    // A later revision of one day is loaded on its own and replaces that day.
    await store.writePartition(layout.gscDay(days[5], 2), metaFor(days[5], 2), rows(9));
    const second = await db.sync(store);
    expect(second.loaded).toBe(1);
    expect(db.pageDaily(days[5], days[5], { pages: [HOME] })[0].c).toBe(9);
    expect(db.siteDaily(days[0], days[69]).reduce((a, r) => a + r.c, 0)).toBe(69 * 3 + 9);
  });
});

describe('index file handling', () => {
  it('persists on disk, survives reopening, and needs no reload when nothing changed', async () => {
    const store = await openStore(join(dir, 'data'), createSecretRegistry({ ci: false }));
    await seedDataDir(store);
    const path = join(dir, 'data', layout.index);
    const a = await openIndex(path);
    await a.sync(store);
    const daily = a.siteDaily(...ALL);
    a.close();
    a.close(); // idempotent
    const b = await index(path);
    expect(b.siteDaily(...ALL)).toEqual(daily);
    expect(await b.sync(store)).toEqual({ loaded: 1, skipped: 16, removed: 0 });
  });

  it('rebuilds a corrupt index file', async () => {
    const store = await openStore(join(dir, 'data'), createSecretRegistry({ ci: false }));
    await seedDataDir(store);
    const path = join(dir, 'index.sqlite');
    writeFileSync(path, 'this is not a database, it is a sandwich');
    const db = await index(path);
    expect(db.dataRange().first).toBeNull();
    await db.sync(store);
    expect(db.dataRange().first).toBe('2026-09-28');
  });

  it('drops and rebuilds when the schema version differs (migration by rebuild)', async () => {
    const store = await openStore(join(dir, 'data'), createSecretRegistry({ ci: false }));
    await seedDataDir(store);
    const path = join(dir, 'index.sqlite');
    const a = await openIndex(path);
    await a.sync(store);
    a.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 999; CREATE TABLE leftover(x)');
    raw.close();
    const b = await index(path);
    expect(b.siteDaily(...ALL)).toEqual([]);
    expect(await b.sync(store)).toEqual({ loaded: 16, skipped: 1, removed: 0 });
    expect(b.siteDaily(...ALL)).toHaveLength(6);
  });
});

describe('memoryIndex follows the same conventions as the real index', () => {
  it('gives the same answers on the fixture', async () => {
    const store = memoryStore();
    const seeded = await seedDataDir(store);
    const db = await index();
    await db.sync(store);
    const sealed = fixtureSealedRows();
    const mem = memoryIndex({
      property: FIXTURE_PROPERTY,
      t: sealed.t,
      p: sealed.p,
      qpd: sealed.qpd,
      freshT: [{ date: '2026-10-02', c: 99, i: 999, ps: 9990 }, { date: '2026-10-04', c: 1, i: 50, ps: 400 }, { date: '2026-10-05', c: 0, i: 20, ps: 180 }],
      inspections: seeded.inspections,
      snapshots: seeded.snapshots,
      serp: seeded.serp,
      events: seeded.events,
      annotations: seeded.annotations,
      findings: seeded.findings,
      truncatedDays: ['2026-10-02'],
      revisions: [{ day: '2026-10-01', revision: 2 }],
    });
    expect(mem.siteDaily(...ALL)).toEqual(db.siteDaily(...ALL));
    expect(mem.siteDaily(...ALL, { provisional: true })).toEqual(db.siteDaily(...ALL, { provisional: true }));
    expect(mem.dataRange()).toEqual(db.dataRange());
    expect(mem.pageDaily(...ALL)).toEqual(db.pageDaily(...ALL));
    expect(mem.cells(...ALL)).toEqual(db.cells(...ALL));
    expect(mem.cells(...ALL, { pages: [POST] })).toEqual(db.cells(...ALL, { pages: [POST] }));
    expect(mem.pages()).toEqual(db.pages());
    expect(mem.inspections()).toEqual(db.inspections());
    expect(mem.snapshots()).toEqual(db.snapshots());
    expect(mem.fieldsByHash()).toEqual(db.fieldsByHash());
    expect(mem.annotations()).toEqual(db.annotations());
    expect(mem.serp()).toEqual(db.serp());
    expect(mem.googleEvents()).toEqual(db.googleEvents());
    expect(mem.findingsHistory()).toEqual(db.findingsHistory());
    expect(mem.truncatedDays()).toEqual(db.truncatedDays());
    expect(mem.revisions()).toEqual(db.revisions());
    expect(mem.property()).toEqual(db.property());
    const again = memoryIndex({ t: sealed.t });
    expect(again.partitionsUsed()).toEqual(memoryIndex({ t: sealed.t }).partitionsUsed());
    expect(again.partitionsUsed()).not.toEqual(memoryIndex({ t: sealed.t.slice(1) }).partitionsUsed());
  });
});
