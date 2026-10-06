import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { DataStore, PartitionMeta } from '../../src/core/types.js';
import { checkRelPath, layout, parseGscDayPath, resolveInside } from '../../src/store/layout.js';
import { parseLedgerText } from '../../src/store/ledger.js';
import { parseJsonSafe } from '../../src/store/ndjson.js';
import { openStore, sweepTmpFiles } from '../../src/store/store.js';
import { memoryStore } from '../helpers/memory-store.js';

const RUN = 'r20261006t061700z-3f2a';
const meta = (over: Partial<PartitionMeta> = {}): PartitionMeta => ({
  kind: 'gsc_day', schema: 1, property: 'sc-domain:example.com', toolVersion: '0.1.0', runId: RUN,
  fetchedAt: '2026-10-06T06:17:00Z', day: '2026-10-03', revision: 1, dataState: 'final', ...over,
});
const rows = [{ s: 't', c: 6, i: 531, ps: 5310 }, { s: 'td', dv: 'desktop', c: 5, i: 400, ps: 3600 }];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'searchtrace-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('layout', () => {
  it('builds every 4.1 path from validated parts', () => {
    expect(layout.gscDay('2026-10-03')).toBe('gsc/2026/10/2026-10-03.ndjson.gz');
    expect(layout.gscDay('2026-10-03', 1)).toBe('gsc/2026/10/2026-10-03.ndjson.gz');
    expect(layout.gscDay('2026-10-03', 2)).toBe('gsc/2026/10/2026-10-03.r2.ndjson.gz');
    expect(layout.perRun('crawl', RUN, '2026-10-06T06:17:00Z')).toBe(`crawl/2026/10/${RUN}.ndjson.gz`);
    expect(layout.perRun('google', RUN, '2026-10-31T23:59:59Z')).toBe(`google/2026/10/${RUN}.ndjson.gz`);
    expect(layout.ledger('spend', '2026-10')).toBe('ledger/spend/2026-10.ndjson');
    expect(parseGscDayPath('gsc/2026/10/2026-10-03.r3.ndjson.gz')).toEqual({ day: '2026-10-03', revision: 3 });
    expect(parseGscDayPath('gsc/2026/10/2026-10-03.ndjson.gz')).toEqual({ day: '2026-10-03', revision: 1 });
    expect(parseGscDayPath('gsc/2026/11/2026-10-03.ndjson.gz')).toBeNull();
  });

  it('refuses invalid parts, so URLs and user text never become paths', () => {
    expect(() => layout.gscDay('2026-02-30')).toThrow(StError);
    expect(() => layout.gscDay('../../etc')).toThrow(StError);
    expect(() => layout.gscDay('2026-10-03', 0)).toThrow(StError);
    expect(() => layout.perRun('crawl', 'https://evil.example/', '2026-10-06T06:17:00Z')).toThrow(StError);
    expect(() => layout.perRun('crawl' as 'crawl', '../x', '2026-10-06T06:17:00Z')).toThrow(StError);
    expect(() => layout.perRun('etc' as 'crawl', RUN, '2026-10-06T06:17:00Z')).toThrow(StError);
    expect(() => layout.ledger('runs', '2026-13')).toThrow(StError);
    expect(() => layout.ledger('nope' as 'runs', '2026-10')).toThrow(StError);
  });

  it('resolveInside blocks escapes, absolute paths and symlinked parents', () => {
    expect(resolveInside(dir, 'gsc/2026/10/x.ndjson.gz')).toBe(join(dir, 'gsc', '2026', '10', 'x.ndjson.gz'));
    for (const bad of ['../outside', 'a/../../outside', '/etc/passwd', 'C:/x', '', 'a\\b', 'a\0b', '.']) {
      expect(() => resolveInside(dir, bad)).toThrow(StError);
    }
    const outside = mkdtempSync(join(tmpdir(), 'searchtrace-outside-'));
    try {
      let linked = true;
      try {
        symlinkSync(outside, join(dir, 'gsc'), 'dir');
      } catch {
        linked = false; // no symlink permission (some Windows set-ups)
      }
      if (linked) {
        expect(() => resolveInside(dir, 'gsc/2026/x')).toThrow(/symbolic link/);
        expect(() => resolveInside(dir, 'gsc')).toThrow(/symbolic link/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('checkRelPath accepts list prefixes and rejects dot segments', () => {
    expect(checkRelPath('', { prefix: true })).toBe('');
    expect(checkRelPath('gsc/', { prefix: true })).toBe('gsc/');
    expect(checkRelPath('gsc/2026/10/2026-10-0', { prefix: true })).toBe('gsc/2026/10/2026-10-0');
    expect(() => checkRelPath('gsc/')).toThrow(StError);
    expect(() => checkRelPath('a/./b')).toThrow(StError);
    expect(() => checkRelPath('a//b')).toThrow(StError);
  });
});

describe.each([
  ['disk', async (): Promise<DataStore> => openStore(dir, createSecretRegistry({ ci: false }))],
  ['memory', async (): Promise<DataStore> => memoryStore()],
] as const)('DataStore semantics (%s, test 66)', (_name, open) => {
  it('writes gzip NDJSON with a leading _meta line and reads it back', async () => {
    const store = await open();
    const rel = layout.gscDay('2026-10-03');
    const res = await store.writePartition(rel, meta(), rows);
    expect(res.rows).toBe(2);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.exists(rel)).toBe(true);
    const back = await store.readPartition(rel);
    expect(back.meta).toEqual(meta());
    expect(back.rows).toEqual(rows);
    expect(await store.list('gsc/')).toEqual([{ path: rel, size: expect.any(Number) }]);
  });

  it('enforces immutability: identical content is a no-op, different content throws, gsc-fresh may change', async () => {
    const store = await open();
    const rel = layout.gscDay('2026-10-03');
    const first = await store.writePartition(rel, meta(), rows);
    const again = await store.writePartition(rel, meta(), rows);
    expect(again.sha256).toBe(first.sha256);
    await expect(store.writePartition(rel, meta(), [rows[0]])).rejects.toThrow(/already exists with different content/);
    await store.writePartition(layout.gscFresh, meta({ kind: 'gsc_fresh' }), [rows[0]]);
    await store.writePartition(layout.gscFresh, meta({ kind: 'gsc_fresh' }), rows);
    expect((await store.readPartition(layout.gscFresh)).rows).toHaveLength(2);
    await expect(store.writePartition('gsc/2026/10/x.json', meta(), rows)).rejects.toThrow(StError);
  });

  it('refuses a row that contains a registered secret and writes nothing', async () => {
    const secrets = createSecretRegistry({ ci: false });
    secrets.add('fake-secret-value-0123456789');
    const store = _name === 'disk' ? await openStore(dir, secrets) : memoryStore({ secrets });
    const rel = layout.perRun('findings', RUN, '2026-10-06T06:17:00Z');
    await expect(store.writePartition(rel, meta({ kind: 'findings' }), [{ note: 'x fake-secret-value-0123456789' }])).rejects.toThrow(StError);
    expect(await store.exists(rel)).toBe(false);
    await expect(store.append('runs', { at: '2026-10-06T06:17:00Z', leak: 'fake-secret-value-0123456789' })).rejects.toThrow(StError);
    await expect(store.writeFileAtomic('reports/latest.md', 'fake-secret-value-0123456789')).rejects.toThrow(StError);
  });

  it('leaves no partial file when writing fails midway (a crash while serialising)', async () => {
    const store = await open();
    const rel = layout.gscDay('2026-10-04');
    function* boom(): Generator<object> {
      yield rows[0];
      throw new Error('process killed');
    }
    await expect(store.writePartition(rel, meta({ day: '2026-10-04' }), boom())).rejects.toThrow('process killed');
    expect(await store.exists(rel)).toBe(false);
    expect(await store.list('')).toEqual([]);
  });

  it('appends ledger lines by UTC month of rec.at and skips a torn line', async () => {
    const store = await open();
    await store.append('runs', { runId: RUN, event: 'start', at: '2026-10-31T23:59:00Z' });
    await store.append('runs', { runId: RUN, event: 'end', at: '2026-11-01T00:01:00Z' });
    expect((await store.list('ledger/runs/')).map((f) => f.path)).toEqual(['ledger/runs/2026-10.ndjson', 'ledger/runs/2026-11.ndjson']);
    // Simulate a crash mid-append: a half line with no newline.
    if (_name === 'disk') appendFileSync(join(dir, 'ledger', 'runs', '2026-11.ndjson'), '{"runId":"r2026');
    else {
      const files = (store as ReturnType<typeof memoryStore>).files;
      const old = files.get('ledger/runs/2026-11.ndjson') as Uint8Array;
      files.set('ledger/runs/2026-11.ndjson', new Uint8Array(Buffer.concat([old, Buffer.from('{"runId":"r2026')])));
    }
    await store.append('runs', { runId: 'r2', event: 'start', at: '2026-11-02T00:00:00Z' });
    const recs = await store.readLedger<{ event: string }>('runs');
    expect(recs.map((r) => r.event)).toEqual(['start', 'end', 'start']);
    const text = await store.readFile('ledger/runs/2026-11.ndjson');
    expect(text).toBe('{"runId":"r20261006t061700z-3f2a","event":"end","at":"2026-11-01T00:01:00Z"}\n{"runId":"r2026\n{"runId":"r2","event":"start","at":"2026-11-02T00:00:00Z"}\n');
  });

  it('writes, reads and removes plain files atomically', async () => {
    const store = await open();
    expect(await store.readFile('reports/latest.md')).toBeNull();
    await store.writeFileAtomic('reports/latest.md', '# Report\n');
    await store.writeFileAtomic('reports/latest.md', '# Report v2\n');
    expect(await store.readFile('reports/latest.md')).toBe('# Report v2\n');
    await store.writeFileAtomic('graphify-out/graph.json', new Uint8Array(Buffer.from('{}')));
    expect(await store.readFile('graphify-out/graph.json')).toBe('{}');
    await store.removeFile('reports/latest.md');
    await store.removeFile('reports/latest.md');
    expect(await store.exists('reports/latest.md')).toBe(false);
  });

  it('lists files under a prefix, sorted by path', async () => {
    const store = await open();
    for (const d of ['2026-10-03', '2026-09-30', '2026-10-01']) await store.writePartition(layout.gscDay(d), meta({ day: d }), rows);
    await store.writePartition(layout.gscDay('2026-10-01', 2), meta({ day: '2026-10-01', revision: 2 }), rows);
    await store.writeFileAtomic('config.json', '{}');
    expect((await store.list('gsc/')).map((f) => f.path)).toEqual([
      'gsc/2026/09/2026-09-30.ndjson.gz', 'gsc/2026/10/2026-10-01.ndjson.gz', 'gsc/2026/10/2026-10-01.r2.ndjson.gz',
      'gsc/2026/10/2026-10-03.ndjson.gz',
    ]);
    expect((await store.list('gsc/2026/10/2026-10-0')).length).toBe(3);
    expect((await store.list('')).map((f) => f.path)[0]).toBe('config.json');
    await expect(store.list('../')).rejects.toThrow(StError);
    await expect(store.readFile('../escape')).rejects.toThrow(StError);
  });
});

describe('disk store specifics', () => {
  it('produces byte-identical partitions to the memory store (same codec, pinned gzip header)', async () => {
    const disk = await openStore(dir, createSecretRegistry({ ci: false }));
    const mem = memoryStore();
    const rel = layout.gscDay('2026-10-03');
    const a = await disk.writePartition(rel, meta(), rows);
    const b = await mem.writePartition(rel, meta(), rows);
    expect(a.sha256).toBe(b.sha256);
    const raw = readFileSync(join(dir, 'gsc', '2026', '10', '2026-10-03.ndjson.gz'));
    expect(raw[9]).toBe(3);
    const text = gunzipSync(raw).toString('utf8');
    expect(text.split('\n')[0]).toBe(JSON.stringify({ _meta: meta() }));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('sweeps tmp files older than an hour on open and keeps young ones (a crash between write and rename)', async () => {
    mkdirSync(join(dir, 'gsc', '2026', '10'), { recursive: true });
    const old = join(dir, 'gsc', '2026', '10', '2026-10-03.ndjson.gz.tmp-123-abcd');
    const young = join(dir, 'gsc', '2026', '10', '2026-10-04.ndjson.gz.tmp-123-ef01');
    writeFileSync(old, 'half');
    writeFileSync(young, 'half');
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(await store.list('gsc/')).toEqual([]); // tmp files are never listed
    expect(await store.exists('gsc/2026/10/2026-10-03.ndjson.gz')).toBe(false);
    expect(await sweepTmpFiles(dir, Date.now() + 2 * 3_600_000)).toBe(1);
  });

  it('never leaves tmp files behind after successful writes', async () => {
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    await store.writePartition(layout.gscDay('2026-10-03'), meta(), rows);
    await store.writeFileAtomic('reports/latest.html', '<p>x</p>');
    const all: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : all.push(e.name));
    };
    walk(dir);
    expect(all.filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('a corrupt partition fails loudly with the path in the message', async () => {
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    mkdirSync(join(dir, 'gsc', '2026', '10'), { recursive: true });
    writeFileSync(join(dir, 'gsc', '2026', '10', '2026-10-05.ndjson.gz'), 'not gzip');
    await expect(store.readPartition('gsc/2026/10/2026-10-05.ndjson.gz')).rejects.toThrow(/not valid gzip/);
  });
});

describe('parsers', () => {
  it('parseLedgerText skips torn and non-object lines', () => {
    expect(parseLedgerText('{"a":1}\n{"a":\n[1]\n\n{"a":2}\n{"a":3')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('parseJsonSafe drops __proto__ keys', () => {
    const v = parseJsonSafe('{"__proto__":{"polluted":true},"a":{"__proto__":{"x":1},"b":2}}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(v, '__proto__')).toBe(false);
    expect(v).toEqual({ a: { b: 2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
