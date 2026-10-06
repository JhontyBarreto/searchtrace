// WP-D: the graphify export (spec 7, test 64): a validator equivalent to graphify's, unique
// unordered pairs, ids safe against graphify's stem re-keying, community carried forward, a
// foreign graph refused, byte-stable output, and the inclusion and temporal rules of 7.2 and 7.3.
import { describe, expect, it } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { nodeId } from '../../src/core/ids.js';
import type { GEdge, GNode, GraphDoc } from '../../src/core/types.js';
import { buildGraph } from '../../src/graph/build.js';
import { carryForward, isOurGraph } from '../../src/graph/merge.js';
import { NODE_ID_PATTERN, NODE_KINDS, SOURCE_FILE_PATTERN, fmtDay, overlapDays, partitionAfter, partitionHolding, indexPartitions, runTimeOf } from '../../src/graph/model.js';
import {
  assertGraphifySafe, graphifyStemForms, makeId, rekeyedByGraphify, serializeGraph, validateGraph, writeGraph,
} from '../../src/graph/write.js';
import { layout } from '../../src/store/layout.js';
import { memoryStore } from '../helpers/index.js';
import { D, graphFixture, PROPERTY } from './graph-fixture.js';

const byKind = (doc: GraphDoc, kind: string): GNode[] => doc.nodes.filter((n) => n.kind === kind);
const nodeBy = (doc: GraphDoc, kind: Parameters<typeof nodeId>[0], key: string): GNode | undefined => doc.nodes.find((n) => n.id === nodeId(kind, key));
const linkBetween = (doc: GraphDoc, a: string, b: string): GEdge | undefined =>
  doc.links.find((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));

describe('graphify id rules', () => {
  it('makeId matches graphify (casefold, NFKC, non-word runs to one underscore, trimmed)', () => {
    expect(makeId('docs/v1/api/README')).toBe('docs_v1_api_readme');
    expect(makeId('__Hello--World__')).toBe('hello_world');
    expect(makeId('gsc/2026/10/2026-10-03.ndjson')).toBe('gsc_2026_10_2026_10_03_ndjson');
    expect(makeId('Ｆｕｌｌ')).toBe('full');
    expect(makeId('café crème')).toBe('café_crème');
  });

  it('derives the three stem forms like pathlib', () => {
    expect(graphifyStemForms('gsc/2026/10/2026-10-03.ndjson.gz')).toEqual([
      'gsc_2026_10_2026_10_03_ndjson', '10_2026_10_03_ndjson', '2026_10_03_ndjson',
    ]);
    expect(graphifyStemForms('config.json')).toEqual(['config']);
    expect(graphifyStemForms('annotations.ndjson')).toEqual(['annotations']);
    expect(graphifyStemForms('serp/2026/09/')).toEqual(['serp_2026_09', '2026_09', '09']);
  });

  it('no source file searchtrace uses has a stem equal to a node-kind prefix', () => {
    const files = [
      'config.json', 'annotations.ndjson', 'gsc/2026/10/2026-10-03.ndjson.gz', 'gsc/2026/10/2026-10-03.r2.ndjson.gz',
      ...['google', 'crawl', 'inspect', 'serp', 'findings'].flatMap((k) => [`${k}/2026/10/r20261006t061700z-3f2a.ndjson.gz`, `${k}/2026/10/`]),
    ];
    for (const f of files) {
      expect(SOURCE_FILE_PATTERN.test(f), f).toBe(true);
      for (const form of graphifyStemForms(f)) {
        for (const kind of NODE_KINDS) {
          expect(form === kind || `${kind}_`.startsWith(`${form}_`) || form.startsWith(`${kind}_`), `${f} -> ${form} vs ${kind}`).toBe(false);
        }
      }
    }
    expect(rekeyedByGraphify('config_abc', 'config.json')).toBe(true);
    expect(rekeyedByGraphify('page_abcdefghijkl', 'config.json')).toBe(false);
  });
});

describe('validator (graphify validate_extraction equivalent)', () => {
  it('accepts a built graph and reports planted errors', () => {
    const doc = buildGraph(graphFixture().input);
    expect(validateGraph(doc)).toEqual([]);
    const bad = {
      nodes: [{ id: 'a', label: 'A', file_type: 'video', source_file: 'x' }, { id: 'b', label: 'B', source_file: 'x' }],
      links: [{ source: 'a', target: 'zzz', relation: 'r', confidence: 'MAYBE', source_file: 'x' }, { source: 'a', target: 'b', confidence: 'EXTRACTED' }],
    };
    const errs = validateGraph(bad);
    expect(errs.some((e) => e.includes("invalid file_type 'video'"))).toBe(true);
    expect(errs.some((e) => e.includes("missing required field 'file_type'"))).toBe(true);
    expect(errs.some((e) => e.includes("does not match any node id"))).toBe(true);
    expect(errs.some((e) => e.includes("invalid confidence 'MAYBE'"))).toBe(true);
    expect(errs.some((e) => e.includes("missing required field 'relation'"))).toBe(true);
    expect(validateGraph([])).toEqual(['Extraction must be a JSON object']);
    expect(validateGraph({ nodes: [] })).toEqual(["Missing required key 'edges'"]);
  });

  it('assertGraphifySafe catches duplicate pairs, self loops and re-keyable ids', () => {
    const n = (id: string, sf = 'config.json'): GNode => ({ id, label: id, file_type: 'concept', source_file: sf, kind: 'site' });
    const e = (s: string, t: string, relation: string): GEdge => ({ source: s, target: t, relation, confidence: 'EXTRACTED', source_file: 'config.json', weight: 1 });
    const base: GraphDoc = { directed: false, multigraph: false, graph: {}, nodes: [n('site_aaaaaaaaaaaa'), n('page_bbbbbbbbbbbb')], links: [] };
    expect(() => assertGraphifySafe(base)).not.toThrow();
    expect(() => assertGraphifySafe({ ...base, links: [e('site_aaaaaaaaaaaa', 'page_bbbbbbbbbbbb', 'a'), e('page_bbbbbbbbbbbb', 'site_aaaaaaaaaaaa', 'b')] })).toThrow(/more than one link/);
    expect(() => assertGraphifySafe({ ...base, links: [e('site_aaaaaaaaaaaa', 'site_aaaaaaaaaaaa', 'a')] })).toThrow(/self loop/);
    expect(() => assertGraphifySafe({ ...base, nodes: [...base.nodes, n('config_x')] })).toThrow(/re-keyed/);
  });
});

describe('buildGraph', () => {
  const fx = graphFixture();
  const doc = buildGraph(fx.input);

  it('builds every node kind with our id shape and allowed source files', () => {
    const kinds = new Set(doc.nodes.map((x) => x.kind));
    for (const k of ['site', 'page', 'query', 'tpl', 'dom', 'sitechg', 'gupd', 'finding', 'idx', 'cause']) expect(kinds.has(k as GNode['kind']), k).toBe(true);
    for (const x of doc.nodes) {
      expect(x.id, x.id).toMatch(NODE_ID_PATTERN);
      expect(SOURCE_FILE_PATTERN.test(x.source_file), `${x.id} ${x.source_file}`).toBe(true);
      expect(rekeyedByGraphify(x.id, x.source_file)).toBe(false);
    }
    expect(() => assertGraphifySafe(doc)).not.toThrow();
  });

  it('has exactly one link per unordered pair, with the winner by precedence and the loser under also', () => {
    const keys = doc.links.map((l) => [l.source, l.target].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(doc.links.every((l) => l.source < l.target)).toBe(true);
    const impact = nodeBy(doc, 'finding', 'fsiteimpact00001') as GNode;
    const change = byKind(doc, 'sitechg').find((x) => x.field === 'title') as GNode;
    const l = linkBetween(doc, impact.id, change.id) as GEdge;
    expect(l.relation).toBe('measures');
    expect(l.confidence).toBe('INFERRED');
    expect(l.tau).toBe(-0.3);
    // The page finding both coincides with the change and the update; about wins on its own pair.
    const pageFinding = nodeBy(doc, 'finding', 'fpagewaterfall01') as GNode;
    const coincide = linkBetween(doc, pageFinding.id, change.id) as GEdge;
    expect(coincide.relation).toBe('coincides_with');
    expect(coincide.confidence).toBe('INFERRED');
    expect(typeof coincide.overlap_days).toBe('number');
  });

  it('labels: page path, site, site change, Google update, cause, and finding labels capped at 120', () => {
    expect(nodeBy(doc, 'page', 'https://example.com/')?.label).toBe('/');
    expect(nodeBy(doc, 'page', 'https://example.com/blog/fix-a-leak')?.label).toBe('/blog/fix-a-leak');
    expect(nodeBy(doc, 'site', 'example.com')?.label).toBe('example.com (whole site)');
    expect(byKind(doc, 'sitechg').map((x) => x.label).sort()).toEqual([
      'Noted: Rewrote the about page <script>alert(1)</script> (1 Aug 2026)',
      'Title changed on 2 /blog/* pages (10 Sep 2026)',
    ]);
    expect(nodeBy(doc, 'cause', 'site_change')?.label).toBe('Your change');
    const long = buildGraph(graphFixture({ renderLabel: () => 'word '.repeat(60) }).input);
    for (const f of byKind(long, 'finding')) expect(f.label.length).toBeLessThanOrEqual(120);
    const broken = buildGraph(graphFixture({ renderLabel: () => { throw new Error('not yet'); } }).input);
    expect(nodeBy(broken, 'finding', 'fheadline0000001')?.label).toBe('headline: Whole site');
  });

  it('includes current findings and recent past signals only', () => {
    const ids = byKind(doc, 'finding').map((x) => x.finding_id);
    expect(ids).toContain('fpastsignal00001');
    expect(ids).not.toContain('fpastnoise000001');
    expect(ids).not.toContain('fancient00000001');
    const past = nodeBy(doc, 'finding', 'fpastsignal00001') as GNode;
    expect(past).toMatchObject({ current: false, first_reported: '2026-07-01', last_reported: '2026-07-01', real_label: 'Real change' });
    const head = nodeBy(doc, 'finding', 'fheadline0000001') as GNode;
    expect(head).toMatchObject({ current: true, first_reported: '2026-09-01', last_reported: D, source_file: 'findings/2026/09/' });
  });

  it('includes queries by impressions plus every query a finding or a check refers to', () => {
    const small = buildGraph(graphFixture({ maxQueries: 1 }).input);
    const qs = byKind(small, 'query').map((x) => x.label).sort();
    expect(qs).toContain('emergency plumber'); // a finding is about it
    expect(qs).toContain('never seen query');
    expect(qs).toContain('how to fix a leak'); // checked for AI Overviews
    expect(qs).toContain('boiler noise'); // the top one by impressions (ties broken by text)
    expect(qs).not.toContain('bleed a radiator');
    expect(qs).not.toContain('ranking');
    expect(nodeBy(small, 'query', 'never seen query')).toMatchObject({ source_file: 'config.json', first_seen: null });
    expect(nodeBy(doc, 'query', 'example plumbing')?.brand).toBe(true);
    expect(nodeBy(doc, 'query', 'leak repair')?.brand).toBe(false);
    expect(nodeBy(doc, 'query', 'how to fix a leak')).toMatchObject({ aio_present_share: 1, aio_cites_us: true });
    expect(nodeBy(doc, 'query', 'leak repair')).toMatchObject({ aio_present_share: 1, aio_cites_us: false });
  });

  it('carries temporal attributes on ranks_for edges', () => {
    const page = nodeBy(doc, 'page', 'https://example.com/blog/radiator-bleed') as GNode;
    const q = nodeBy(doc, 'query', 'bleed a radiator') as GNode;
    const l = linkBetween(doc, page.id, q.id) as GEdge;
    expect(l.relation).toBe('ranks_for');
    expect(l.valid_to).toBe(l.last_seen); // not seen in the current window
    expect(l.impr_28d).toBe(0);
    expect(l.weight).toBe(0.01);
    expect(l.observations).toBe(43);
    const live = linkBetween(doc, (nodeBy(doc, 'page', 'https://example.com/blog/fix-a-leak') as GNode).id, (nodeBy(doc, 'query', 'how to fix a leak') as GNode).id) as GEdge;
    expect(live.valid_to).toBeNull();
    expect(live.weight).toBeCloseTo(Math.log1p(70), 9);
    expect(live.source_file).toBe(`gsc/2026/10/2026-10-02.ndjson.gz`); // the last day it had impressions
  });

  it('tracks index state history and links between pages', () => {
    const home = nodeBy(doc, 'page', 'https://example.com/') as GNode;
    expect(home.index_state).toBe('Submitted and indexed');
    expect(home.last_crawl).toBe('2026-09-19T01:00:00Z');
    const indexed = nodeBy(doc, 'idx', 'Submitted and indexed') as GNode;
    const notIndexed = nodeBy(doc, 'idx', 'Crawled - currently not indexed') as GNode;
    const now = linkBetween(doc, home.id, indexed.id) as GEdge;
    const before = linkBetween(doc, home.id, notIndexed.id) as GEdge;
    expect(now).toMatchObject({ relation: 'in_state', valid_from: '2026-09-01', valid_to: null, weight: 0.1 });
    expect(before).toMatchObject({ valid_from: '2026-09-12', valid_to: '2026-09-20' });
    expect((now.history as unknown[]).length).toBe(3);
    expect(now.source_file).toBe('inspect/2026/09/r20260920t115900z-0a0b.ndjson.gz');
    const radiator = nodeBy(doc, 'page', 'https://example.com/blog/radiator-bleed') as GNode;
    const link = linkBetween(doc, home.id, radiator.id) as GEdge;
    expect(link).toMatchObject({ relation: 'links_to', first_seen: '2026-09-10', last_seen: '2026-09-10' });
  });

  it('competing domains strip www., exclude us and count AI Overview citations', () => {
    const semrush = nodeBy(doc, 'dom', 'semrush.com') as GNode;
    expect(semrush).toMatchObject({ aio_citations: 4, checks: 6, organic_outranks: 6 });
    expect(nodeBy(doc, 'dom', 'example.com')).toBeUndefined();
    expect(semrush.source_file).toBe('serp/2026/09/r20260923t061700z-0a0b.ndjson.gz');
  });

  it('keeps Google updates that overlap the data range or are referenced', () => {
    const titles = byKind(doc, 'gupd').map((x) => x.label).sort();
    expect(titles).toEqual(['November 2021 core update', 'October 2026 spam update', 'September 2026 core update']);
    expect(nodeBy(doc, 'gupd', 'core-sep-2026')?.source_file).toBe('google/2026/10/r20261002t061700z-0a0b.ndjson.gz');
    const noRef = buildGraph({ ...graphFixture().input, analysis: { ...fx.input.analysis, findings: [] } });
    expect(byKind(noRef, 'gupd').map((x) => x.label)).not.toContain('November 2021 core update');
  });

  it('pages: GSC first-seen partition, crawl partition when never in GSC, revisions respected', () => {
    expect(nodeBy(doc, 'page', 'https://example.com/crawled-only')?.source_file).toBe('crawl/2026/09/r20260910t095900z-0a0b.ndjson.gz');
    expect(nodeBy(doc, 'page', 'https://example.com/')?.source_file).toBe('gsc/2026/06/2026-06-06.ndjson.gz');
    const ix = indexPartitions(fx.partitions);
    expect(ix.gsc.get('2026-09-20')).toBe('gsc/2026/09/2026-09-20.r2.ndjson.gz');
  });

  it('is deterministic and carries communities from the previous graph only', () => {
    const again = buildGraph(graphFixture().input);
    expect(serializeGraph(again)).toBe(serializeGraph(doc));
    const prev: GraphDoc = {
      ...doc,
      nodes: doc.nodes.map((x, k) => ({ ...x, community: k % 3, community_name: `C${k % 3}`, norm_label: 'x', clicks_28d: 999 })),
    };
    const next = buildGraph({ ...graphFixture().input, previous: prev });
    for (const x of next.nodes) {
      const p = prev.nodes.find((y) => y.id === x.id) as GNode;
      expect(x.community).toBe(p.community);
      expect(x.community_name).toBe(p.community_name);
      expect(x.norm_label).toBeUndefined();
      if (x.kind === 'site') expect(x.clicks_28d).not.toBe(999);
    }
  });
});

describe('writeGraph', () => {
  it('writes byte-stable output plus the sidecar', async () => {
    const store = memoryStore();
    const doc = buildGraph(graphFixture().input);
    const res = await writeGraph(store, doc, { property: PROPERTY, force: false });
    expect(res).toEqual({ nodes: doc.nodes.length, links: doc.links.length, path: layout.graph });
    const text = (await store.readFile(layout.graph)) as string;
    const shuffled: GraphDoc = { ...doc, nodes: [...doc.nodes].reverse(), links: [...doc.links].reverse().map((l) => ({ ...l, source: l.target, target: l.source })) };
    const store2 = memoryStore();
    await writeGraph(store2, shuffled, { property: PROPERTY, force: false });
    expect(await store2.readFile(layout.graph)).toBe(text);
    const parsed = JSON.parse(text) as GraphDoc;
    expect(parsed.directed).toBe(false);
    expect(parsed.multigraph).toBe(false);
    expect(parsed.graph).toEqual({ data_through: D, generator: 'searchtrace', property: PROPERTY, tool_version: '0.1.0' });
    expect(text).not.toMatch(/\d\.\d{5,}/); // 4 decimals at most
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // no wall-clock stamps
    const sidecar = JSON.parse((await store.readFile(layout.graphMeta)) as string);
    expect(sidecar).toEqual({ dataThrough: D, generator: 'searchtrace', links: doc.links.length, nodes: doc.nodes.length, property: PROPERTY, schema: 1, toolVersion: '0.1.0' });
  });

  it('keeps graphify communities after cluster-only resets the graph object, and nothing else', async () => {
    const store = memoryStore();
    const doc = buildGraph(graphFixture().input);
    await writeGraph(store, doc, { property: PROPERTY, force: false });
    const first = (await store.readFile(layout.graph)) as string;
    // What graphify cluster-only does: adds community fields, norm_label, confidence_score, hyperedges; graph -> {}.
    const g = JSON.parse(first) as GraphDoc & { hyperedges: unknown[] };
    g.graph = {};
    g.hyperedges = [];
    g.nodes = g.nodes.map((x, k) => ({ ...x, community: k % 4, community_name: `Community ${k % 4}`, norm_label: String(x.label).toLowerCase() }));
    g.links = g.links.map((l) => ({ ...l, confidence_score: 1 }));
    await store.writeFileAtomic(layout.graph, JSON.stringify(g, null, 2));
    await writeGraph(store, buildGraph(graphFixture().input), { property: PROPERTY, force: false });
    const second = (await store.readFile(layout.graph)) as string;
    const out = JSON.parse(second) as GraphDoc;
    expect(out.nodes.every((x, k) => typeof x.community === 'number' && x.community_name === `Community ${x.community}` && k >= 0)).toBe(true);
    expect(second).not.toContain('norm_label');
    expect(second).not.toContain('confidence_score');
    expect(second).not.toContain('hyperedges');
    const strip = (t: string): string => t.replace(/"community":\d+,"community_name":"Community \d+",/g, '');
    expect(strip(second)).toBe(first);
  });

  it('refuses a foreign graph unless forced, and then drops its communities', async () => {
    const store = memoryStore();
    const foreign = { directed: false, multigraph: false, graph: {}, nodes: [{ id: 'auth_service', label: 'AuthService', file_type: 'code', source_file: 'src/auth.ts', community: 3 }], links: [] };
    await store.writeFileAtomic(layout.graph, JSON.stringify(foreign));
    const doc = buildGraph(graphFixture().input);
    const err = await writeGraph(store, doc, { property: PROPERTY, force: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StError);
    expect((err as StError).code).toBe('graph_not_ours');
    expect((err as StError).fix).toMatch(/--force-graph/);
    expect(JSON.parse((await store.readFile(layout.graph)) as string)).toEqual(foreign); // untouched
    await writeGraph(store, doc, { property: PROPERTY, force: true });
    const out = JSON.parse((await store.readFile(layout.graph)) as string) as GraphDoc;
    expect(out.nodes.some((x) => x.id === 'auth_service')).toBe(false);
    expect(out.nodes.every((x) => x.community === undefined)).toBe(true);
    // An unparseable graph.json is foreign too.
    const s2 = memoryStore();
    await s2.writeFileAtomic(layout.graph, '{ not json');
    expect(((await writeGraph(s2, doc, { property: PROPERTY, force: false }).catch((e: unknown) => e)) as StError).code).toBe('graph_not_ours');
  });

  it('recognises our graph by the sidecar or by the id shape', () => {
    const doc = buildGraph(graphFixture().input);
    expect(isOurGraph(doc, null, PROPERTY)).toBe(true);
    const odd: GraphDoc = { ...doc, nodes: [...doc.nodes, { id: 'x', label: 'x', file_type: 'concept', source_file: 'config.json', kind: 'site' }] };
    expect(isOurGraph(odd, null, PROPERTY)).toBe(false);
    expect(isOurGraph(odd, { generator: 'searchtrace', property: PROPERTY }, PROPERTY)).toBe(true);
    expect(isOurGraph(odd, { generator: 'searchtrace', property: 'sc-domain:other.com' }, PROPERTY)).toBe(false);
    expect(carryForward(doc, null)).toBe(doc);
  });
});

describe('model helpers', () => {
  it('maps records to the partitions that hold them', () => {
    const ix = indexPartitions([
      'crawl/2026/09/r20260908t095900z-0a0b.ndjson.gz', 'crawl/2026/09/r20260910t095900z-0a0b.ndjson.gz',
      'serp/2026/09/r20260923t061700z-0a0b.ndjson.gz', 'serp/2026/09/r20260930t061700z-0a0b.ndjson.gz',
    ]);
    expect(partitionHolding(ix, 'crawl', '2026-09-09T00:00:00Z')).toBe('crawl/2026/09/r20260908t095900z-0a0b.ndjson.gz');
    expect(partitionHolding(ix, 'crawl', '2026-09-11T00:00:00Z')).toBe('crawl/2026/09/r20260910t095900z-0a0b.ndjson.gz');
    expect(partitionAfter(ix, 'serp', '2026-09-24T00:00:00Z')).toBe('serp/2026/09/r20260930t061700z-0a0b.ndjson.gz');
    expect(partitionAfter(ix, 'serp', '2026-10-24T00:00:00Z')).toBe('serp/2026/09/r20260930t061700z-0a0b.ndjson.gz');
    expect(partitionHolding(ix, 'inspect', '2026-09-24T00:00:00Z')).toBe('inspect/2026/09/');
    expect(runTimeOf('crawl/2026/09/r20260908t095900z-0a0b.ndjson.gz')).toBe(Date.UTC(2026, 8, 8, 9, 59, 0));
    expect(runTimeOf('nope')).toBeNull();
  });

  it('formats days and counts overlaps', () => {
    expect(fmtDay('2026-09-09')).toBe('9 Sep 2026');
    expect(overlapDays(['2026-09-01', '2026-09-10'], ['2026-09-08', '2026-09-20'])).toBe(3);
    expect(overlapDays(['2026-09-01', '2026-09-10'], ['2026-09-11', '2026-09-20'])).toBe(0);
  });
});
