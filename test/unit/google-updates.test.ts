// Spec 5.13 test 52: incidents.json fixture plus seed merge, latest `modified` wins, classification. Owner: WP-B.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { GoogleEvent, Logger, RunContext, RunFlags } from '../../src/core/types.js';
import {
  INCIDENTS_URL, classifyIncident, kindFor, loadSeedEvents, measurementEvents, mergeEvents, updatesCollector, updatesTuning,
} from '../../src/sources/google/updates.js';
import { fakeFetch, fixedClock, memoryIndex, memoryStore, type MemoryStore } from '../helpers/index.js';

const INCIDENTS: unknown[] = JSON.parse(readFileSync(new URL('../fixtures/google-incidents.json', import.meta.url), 'utf8'));
updatesTuning.retryBaseMs = 1;

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {}, progress() {} };

function ctxFor(store: MemoryStore, fetch: typeof globalThis.fetch, o: { offline?: boolean; runId?: string; at?: string } = {}): RunContext {
  const at = o.at ?? '2026-10-06T13:00:00Z';
  const flags: RunFlags = {
    dryRun: false, offline: o.offline ?? false, noPaid: true, ci: false, yes: true, interactive: false, budgetUsd: null, waitMinutes: 0,
    credentials: null, forceGraph: false,
  };
  return {
    runId: o.runId ?? 'r20261006t130000z-0001', startedAt: at, toolVersion: '0.1.0', config: defaultConfig('sc-domain:example.com'), store,
    index: Object.assign(memoryIndex({}), { sync: async () => ({ loaded: 0, skipped: 0, removed: 0 }), close() {} }),
    clock: fixedClock(at), fetch, log: silent, secrets: createSecretRegistry({ ci: false }), signal: new AbortController().signal, flags,
    google: null, env: {},
  };
}

async function storedEvents(store: MemoryStore): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  for (const f of await store.list('google/')) out.push(...(await store.readPartition<GoogleEvent>(f.path)).rows);
  return out;
}

describe('classification', () => {
  it('follows the table in 4.6', () => {
    expect(kindFor('Ranking', 'March 2026 core update')).toBe('core');
    expect(kindFor('Ranking', 'August 2026 spam update')).toBe('spam');
    expect(kindFor('Ranking', 'February 2026 Discover update')).toBe('discover');
    expect(kindFor('Ranking', 'Reviews update')).toBe('other_ranking');
    expect(kindFor('Serving', 'Serving is experiencing an ongoing issue')).toBe('outage');
    expect(kindFor('Indexing', 'Indexing issue')).toBe('outage');
    expect(kindFor('Crawling', 'Crawling issue')).toBe('outage');
  });

  it('classifies every incident in the fixture, converts times to UTC Z and handles the open one', () => {
    const events = INCIDENTS.map(classifyIncident);
    expect(events.every((e) => e !== null)).toBe(true);
    const byTitle = new Map(events.map((e) => [(e as GoogleEvent).title, e as GoogleEvent]));
    const sept = byTitle.get('September 2026 spam update') as GoogleEvent;
    expect(sept).toMatchObject({ id: 'XhUDXP7A67iHCD2kmbVu', source: 'incidents', service: 'Ranking', kind: 'spam', begin: '2026-09-24T16:15:00Z', end: null, endEstimated: true });
    expect(sept.url).toBe('https://status.search.google.com/incidents/XhUDXP7A67iHCD2kmbVu');
    expect(sept.modified).toBe('2026-09-24T16:15:47Z');
    expect(byTitle.get('May 2026 core update')).toMatchObject({ kind: 'core', end: '2026-06-02T12:40:00Z', endEstimated: false });
    expect(byTitle.get('February 2026 Discover update')?.kind).toBe('discover');
    expect(byTitle.get('Serving was experiencing an issue')?.kind).toBe('outage');
  });

  it('rejects malformed incidents', () => {
    expect(classifyIncident(null)).toBeNull();
    expect(classifyIncident([])).toBeNull();
    expect(classifyIncident({ id: 'x', service_name: 'Ranking', external_desc: 'y' })).toBeNull();
    expect(classifyIncident({ id: '../../etc', begin: '2026-01-01T00:00:00Z', service_name: 'Ranking', external_desc: 'y' })).toBeNull();
    expect(classifyIncident({ id: 'abc', begin: 'not a date', service_name: 'Ranking', external_desc: 'y' })).toBeNull();
  });
});

describe('seed', () => {
  it('loads 58 incidents plus the curated num=100 reporting change', () => {
    const seed = loadSeedEvents();
    expect(seed.filter((e) => e.source === 'seed')).toHaveLength(58);
    const curated = seed.filter((e) => e.source === 'curated');
    expect(curated).toHaveLength(1);
    expect(curated[0]).toMatchObject({ id: 'curated-num100-2025-09', kind: 'data_anomaly', service: 'Reporting', endEstimated: true, url: null });
    expect(measurementEvents(seed).map((e) => e.id)).toEqual(['curated-num100-2025-09']);
    // Sorted by begin, then id.
    const begins = seed.map((e) => e.begin);
    expect([...begins].sort()).toEqual(begins);
    // Callers get copies.
    seed[0].title = 'changed';
    expect(loadSeedEvents()[0].title).not.toBe('changed');
  });

  it('agrees with the live feed on the 10 incidents both hold (0.2 F9)', () => {
    const seed = new Map(loadSeedEvents().map((e) => [e.id, e]));
    const live = INCIDENTS.map(classifyIncident) as GoogleEvent[];
    expect(live).toHaveLength(10);
    for (const e of live) {
      const s = seed.get(e.id) as GoogleEvent;
      expect(s, e.title).toBeDefined();
      expect([s.begin, s.end, s.kind, s.service]).toEqual([e.begin, e.end, e.kind, e.service]);
    }
  });

  it('merge keeps the latest modified per id, null counting as oldest', () => {
    const a: GoogleEvent = { id: 'x', source: 'seed', service: 'Ranking', kind: 'core', title: 'old', begin: '2026-01-01T00:00:00Z', end: null, endEstimated: true, url: null, modified: null };
    const b: GoogleEvent = { ...a, source: 'incidents', title: 'live v1', modified: '2026-01-02T00:00:00Z' };
    const c: GoogleEvent = { ...a, source: 'incidents', title: 'live v2', end: '2026-01-10T00:00:00Z', modified: '2026-01-05T00:00:00Z' };
    expect(mergeEvents([c], [a], [b]).map((e) => e.title)).toEqual(['live v2']);
    expect(mergeEvents([a], [b]).map((e) => e.title)).toEqual(['live v1']);
    expect(mergeEvents([b], [a]).map((e) => e.title)).toEqual(['live v1']);
  });
});

describe('updatesCollector', () => {
  it('first run stores seed plus live; a re-run stores nothing; a modified incident is stored once', async () => {
    const store = memoryStore();
    let feed: unknown[] = INCIDENTS;
    const ff = fakeFetch([{ method: 'GET', url: INCIDENTS_URL, reply: () => ({ body: feed }) }]);

    const c1 = ctxFor(store, ff.fetch);
    const r1 = await updatesCollector.execute(await updatesCollector.plan(c1), c1);
    expect(r1.status).toBe('ok');
    expect(r1.requests).toEqual({ 'google.incidents': 1 });
    expect(r1.partitions).toEqual(['google/2026/10/r20261006t130000z-0001.ndjson.gz']);
    expect(r1.notes[0]).toBe('59 known, 59 new');
    const stored = await storedEvents(store);
    expect(stored).toHaveLength(59);
    // The live version wins for the 10 overlapping incidents (it carries `modified`).
    expect(stored.filter((e) => e.source === 'incidents')).toHaveLength(10);
    expect(stored.find((e) => e.id === 'curated-num100-2025-09')?.kind).toBe('data_anomaly');
    const meta = (await store.readPartition('google/2026/10/r20261006t130000z-0001.ndjson.gz')).meta;
    expect(meta).toMatchObject({ kind: 'google_events', schema: 1, property: 'sc-domain:example.com', runId: 'r20261006t130000z-0001' });

    const c2 = ctxFor(store, ff.fetch, { runId: 'r20261007t130000z-0002', at: '2026-10-07T13:00:00Z' });
    const r2 = await updatesCollector.execute(await updatesCollector.plan(c2), c2);
    expect(r2.notes[0]).toBe('59 known, 0 new');
    expect(r2.partitions).toEqual([]);

    // Google closes the September spam update.
    feed = INCIDENTS.map((x) => {
      const r = x as Record<string, unknown>;
      return r.id === 'XhUDXP7A67iHCD2kmbVu' ? { ...r, end: '2026-10-08T12:00:00+00:00', modified: '2026-10-08T12:30:00+00:00' } : r;
    });
    const c3 = ctxFor(store, ff.fetch, { runId: 'r20261009t130000z-0003', at: '2026-10-09T13:00:00Z' });
    const r3 = await updatesCollector.execute(await updatesCollector.plan(c3), c3);
    expect(r3.notes[0]).toBe('59 known, 1 new');
    const fresh = (await store.readPartition<GoogleEvent>(r3.partitions[0])).rows;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ id: 'XhUDXP7A67iHCD2kmbVu', end: '2026-10-08T12:00:00Z', endEstimated: false });

    // If the feed later drops an old incident, the stored live copy still wins over the seed.
    feed = [];
    const c4 = ctxFor(store, ff.fetch, { runId: 'r20261010t130000z-0004', at: '2026-10-10T13:00:00Z' });
    const r4 = await updatesCollector.execute(await updatesCollector.plan(c4), c4);
    expect(r4.notes[0]).toBe('59 known, 0 new');
  });

  it('offline: nothing is fetched, the seed is stored once, the phase is skipped', async () => {
    const store = memoryStore();
    const ff = fakeFetch([]);
    const c = ctxFor(store, ff.fetch, { offline: true });
    const p = await updatesCollector.plan(c);
    expect(p.skip).toBeNull();
    expect(p.estRequests).toBe(0);
    const r = await updatesCollector.execute(p, c);
    expect(ff.calls).toHaveLength(0);
    expect(r.status).toBe('skipped');
    expect(r.notes[0]).toBe('59 known, 59 new');
    expect(await storedEvents(store)).toHaveLength(59);
    const again = await updatesCollector.execute(p, ctxFor(store, ff.fetch, { offline: true, runId: 'r20261006t140000z-0002' }));
    expect(again.partitions).toEqual([]);
  });

  it('a feed failure uses the seed and marks the phase partial', async () => {
    const store = memoryStore();
    const ff = fakeFetch([{ method: 'GET', url: INCIDENTS_URL, reply: { status: 503, body: 'down' } }]);
    const c = ctxFor(store, ff.fetch);
    const r = await updatesCollector.execute(await updatesCollector.plan(c), c);
    expect(ff.callsTo(INCIDENTS_URL)).toHaveLength(2); // 2 attempts (4.7)
    expect(r.status).toBe('partial');
    expect(r.errors).toHaveLength(1);
    expect(r.notes.join(' ')).toContain('bundled list');
    expect(await storedEvents(store)).toHaveLength(59);
  });

  it('a feed that is not a list is a failure, not a crash', async () => {
    const store = memoryStore();
    const ff = fakeFetch([{ method: 'GET', url: INCIDENTS_URL, reply: { body: { unexpected: true } } }]);
    const c = ctxFor(store, ff.fetch);
    const r = await updatesCollector.execute(await updatesCollector.plan(c), c);
    expect(r.status).toBe('partial');
  });
});
