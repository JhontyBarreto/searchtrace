// Demo fixture: deterministic, complete, and planted as spec 6.9 describes. Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import type { InspectionRecord, PageDay, SerpObservation, SnapshotRecord } from '../../src/core/types.js';
import {
  DEMO_DATA_THROUGH, DEMO_ORIGIN, DEMO_PROPERTY, DEMO_START, DEMO_THIN_PAGE, demoTruth, writeDemoFixture,
} from '../../src/demo/fixture.js';
import { layout } from '../../src/store/layout.js';
import { memoryStore, type MemoryStore } from '../helpers/index.js';

type Row = { s: string; [k: string]: unknown };

describe('writeDemoFixture', () => {
  let store: MemoryStore;
  let truth: Awaited<ReturnType<typeof writeDemoFixture>>;

  it('writes the same bytes every time', async () => {
    store = memoryStore();
    truth = await writeDemoFixture(store);
    const again = memoryStore();
    await writeDemoFixture(again);
    expect([...again.files.keys()].sort()).toEqual([...store.files.keys()].sort());
    for (const [path, bytes] of store.files) expect(Buffer.compare(Buffer.from(bytes), Buffer.from(again.files.get(path)!))).toBe(0);
  }, 60_000);

  it('writes 490 sealed days, the provisional tail, crawls, inspections, SERP checks, events and truth.json', async () => {
    const days = await store.list('gsc/');
    expect(days.length).toBe(490);
    expect(days[0].path).toBe(layout.gscDay(DEMO_START));
    expect(days[days.length - 1].path).toBe(layout.gscDay(DEMO_DATA_THROUGH));
    expect(DEMO_START).toBe('2025-06-01');
    expect(await store.exists(layout.gscFresh)).toBe(true);
    expect((await store.list('crawl/')).length).toBe(2);
    expect((await store.list('inspect/')).length).toBe(2);
    expect((await store.list('serp/')).length).toBe(3);
    expect((await store.list('google/')).length).toBe(1);
    expect(JSON.parse((await store.readFile('truth.json')) ?? 'null')).toEqual(truth);
    expect(truth).toEqual(demoTruth().truth);
    expect(truth.property).toBe(DEMO_PROPERTY);
    expect(truth.dataThrough).toBe('2026-10-03');
    expect(truth.expect.map((e) => e.kind)).toEqual(['update_impact', 'update_impact', 'site_change_impact', 'waterfall', 'aio_effect', 'waterfall', 'waterfall']);
  });

  it('keeps each day consistent: device totals add up to the property total, pages carry all clicks', async () => {
    const { meta, rows } = await store.readPartition<Row>(layout.gscDay('2026-09-15'));
    expect(meta).toMatchObject({ kind: 'gsc_day', property: DEMO_PROPERTY, day: '2026-09-15', revision: 1, dataState: 'final' });
    const sum = (s: string, k: string): number => rows.filter((r) => r.s === s).reduce((a, r) => a + Number(r[k]), 0);
    expect(sum('td', 'c')).toBe(sum('t', 'c'));
    expect(sum('tc', 'c')).toBe(sum('t', 'c'));
    expect(sum('p', 'c')).toBeGreaterThanOrEqual(sum('t', 'c') - 2);
    expect(sum('p', 'c')).toBeLessThanOrEqual(sum('t', 'c') + 2);
    expect(sum('qpd', 'c')).toBeLessThan(sum('p', 'c'));
    const pages = new Set(rows.filter((r) => r.s === 'p').map((r) => String(r.p)));
    expect(pages.size).toBeGreaterThan(100);
    expect([...pages].filter((p) => p.startsWith(`${DEMO_ORIGIN}services/`)).length).toBe(12);
    expect([...pages].filter((p) => p.startsWith(`${DEMO_ORIGIN}areas/`)).length).toBe(15);
    expect([...pages].filter((p) => p.startsWith(`${DEMO_ORIGIN}blog/`)).length).toBeGreaterThan(80);
    expect(meta.slices?.qpd?.rows).toBe(rows.filter((r) => r.s === 'qpd').length);
  });

  it('plants the title change, the recrawls and the AI Overview checks', async () => {
    const [kf, delta] = await store.list('crawl/');
    const keyframe = await store.readPartition<SnapshotRecord>(kf.path);
    const second = await store.readPartition<SnapshotRecord>(delta.path);
    expect(keyframe.meta.keyframe).toBe(true);
    expect(keyframe.rows.every((r) => r.outcome === 'ok' && r.fields && r.fetchedAt.startsWith('2026-09-08'))).toBe(true);
    const changed = second.rows.filter((r) => r.outcome === 'ok');
    expect(changed.length).toBe(40);
    expect(changed.every((r) => r.url.startsWith(`${DEMO_ORIGIN}blog/`) && r.fields?.title?.endsWith(' - Pipewell Plumbing'))).toBe(true);
    expect(second.rows.filter((r) => r.outcome === 'not_modified').every((r) => !r.fields && r.fieldsHash)).toBe(true);

    const insp = await store.readPartition<InspectionRecord>((await store.list('inspect/'))[1].path);
    const recrawled = insp.rows.filter((r) => r.reason === 'post_change');
    expect(recrawled.length).toBe(40);
    expect(new Set(recrawled.map((r) => r.lastCrawlTime?.slice(0, 10)))).toEqual(new Set(['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']));

    const serp: SerpObservation[] = [];
    for (const f of await store.list('serp/')) serp.push(...(await store.readPartition<SerpObservation>(f.path)).rows);
    expect(serp.length).toBe(600);
    const queries = new Set(serp.map((o) => `${o.keyword}|${o.device}`));
    expect(queries.size).toBe(100);
    const withAio = new Set(serp.filter((o) => o.aio).map((o) => o.keyword));
    const citing = new Set(serp.filter((o) => o.aio?.citesUs).map((o) => o.keyword));
    expect(withAio.size).toBe(40);
    expect(citing.size).toBe(10);
    expect(serp.every((o) => o.observedAt.slice(0, 10) <= DEMO_DATA_THROUGH && o.observedAt.slice(0, 10) >= '2026-09-14')).toBe(true);
  });

  it('puts the thin page among the top 25 pages by click change, under the 30-click floor', async () => {
    const totals = new Map<string, { b: number; c: number; ib: number }>();
    for (let k = 0; k < 56; k++) {
      const day = addDays(DEMO_DATA_THROUGH, -k);
      const { rows } = await store.readPartition<Row>(layout.gscDay(day));
      for (const r of rows.filter((x) => x.s === 'p') as unknown as (PageDay & { s: string })[]) {
        const t = totals.get(r.p) ?? { b: 0, c: 0, ib: 0 };
        if (k >= 28) {
          t.b += r.c;
          t.ib += r.i;
        } else t.c += r.c;
        totals.set(r.p, t);
      }
    }
    const thin = totals.get(DEMO_THIN_PAGE)!;
    expect(thin).toMatchObject({ b: 29, c: 17 });
    expect(thin.ib).toBeLessThan(1000);
    const ranked = [...totals.entries()].sort((a, b) => Math.abs(b[1].c - b[1].b) - Math.abs(a[1].c - a[1].b));
    const rank = ranked.findIndex(([p]) => p === DEMO_THIN_PAGE) + 1;
    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(22);
  }, 30_000);
});
