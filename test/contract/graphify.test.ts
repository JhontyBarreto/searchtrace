// WP-D contract test against the real graphify (spec 7.6, test 65). Runs only when `graphify`
// is on PATH; its Python is read from the executable's shebang. child_process is allowed here
// (test/ only; src/ never spawns anything).
//   1. Write a graph, run graphify's own validate_extraction on it: no errors.
//   2. graphify cluster-only <dir> --no-viz --no-label: exit 0, same node id set, our attributes kept.
//   3. Write again from the same index: every community is kept, and the bytes equal step 1
//      apart from community and community_name.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { isStError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { DataStore, GEdge, GNode, GraphDoc, GraphInput } from '../../src/core/types.js';
import { siteDomainOf } from '../../src/core/url.js';
import { runAnalysis } from '../../src/analyze/index.js';
import { writeDemoFixture } from '../../src/demo/fixture.js';
import { buildGraph } from '../../src/graph/build.js';
import { writeGraph } from '../../src/graph/write.js';
import { openIndex } from '../../src/index/db.js';
import { layout } from '../../src/store/layout.js';
import { openStore } from '../../src/store/store.js';
import { memoryStore } from '../helpers/index.js';
import { graphFixture, PROPERTY } from '../unit/graph-fixture.js';

function findGraphify(): { bin: string; python: string[] } | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
    if (!existsSync(bin)) continue;
    let firstLine = '';
    try {
      firstLine = readFileSync(bin, 'utf8').split('\n', 1)[0] ?? '';
    } catch {
      continue;
    }
    if (!firstLine.startsWith('#!')) continue;
    return { bin, python: firstLine.slice(2).trim().split(/\s+/) };
  }
  return null;
}

const graphify = findGraphify();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'searchtrace-graphify-'));
  dirs.push(d);
  return d;
}

function validateWithGraphify(graphPath: string): string[] {
  const g = graphify as NonNullable<typeof graphify>;
  const code = 'import json,sys\nfrom graphify.validate import validate_extraction as v\nprint(json.dumps(v(json.load(open(sys.argv[1], encoding="utf-8")))))';
  const r = spawnSync(g.python[0], [...g.python.slice(1), '-c', code, graphPath], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`graphify validator failed to run: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as string[];
}

function clusterOnly(dir: string): void {
  const g = graphify as NonNullable<typeof graphify>;
  const r = spawnSync(g.bin, ['cluster-only', dir, '--no-viz', '--no-label'], { encoding: 'utf8', cwd: dir, timeout: 120_000 });
  expect(r.status, `graphify cluster-only failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
}

const strip = (t: string): string => t.replace(/"community":(\d+|null),("community_name":"[^"]*",)?/g, '');

async function roundTrip(store: DataStore, dir: string, input: GraphInput, property: string): Promise<void> {
  // 1. write and validate with graphify's own validator
  await writeGraph(store, buildGraph(input), { property, force: false });
  const graphPath = join(dir, layout.graph);
  const first = readFileSync(graphPath, 'utf8');
  expect(validateWithGraphify(graphPath)).toEqual([]);
  const before = JSON.parse(first) as GraphDoc;
  const ids = before.nodes.map((n) => n.id).sort();

  // 2. cluster-only keeps the id set and our attributes, and adds communities
  clusterOnly(dir);
  const clustered = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphDoc;
  expect(clustered.nodes.map((n) => n.id).sort()).toEqual(ids);
  expect(clustered.links.length).toBe(before.links.length);
  expect(clustered.graph).toEqual({}); // graphify resets it (0.2 F10); the sidecar keeps ownership
  const byId = new Map(clustered.nodes.map((n) => [n.id, n]));
  for (const n of before.nodes) {
    const c = byId.get(n.id) as GNode;
    expect(c.kind).toBe(n.kind);
    if (n.first_seen !== undefined) expect(c.first_seen).toEqual(n.first_seen);
  }
  const withHistory = clustered.links.filter((l: GEdge) => l.relation === 'in_state');
  if (before.links.some((l) => l.relation === 'in_state')) expect(withHistory.every((l) => Array.isArray(l.history))).toBe(true);
  const communities = clustered.nodes.filter((n) => typeof n.community === 'number');
  expect(communities.length).toBeGreaterThan(0);

  // 3. our next write keeps every community and is otherwise byte-identical to step 1
  await writeGraph(store, buildGraph(input), { property, force: false });
  const third = readFileSync(graphPath, 'utf8');
  const after = JSON.parse(third) as GraphDoc;
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  for (const n of clustered.nodes) {
    if (typeof n.community !== 'number') continue;
    expect(afterById.get(n.id)?.community, n.id).toBe(n.community);
    if (typeof n.community_name === 'string') expect(afterById.get(n.id)?.community_name).toBe(n.community_name);
  }
  expect(strip(third)).toBe(first);
  expect(validateWithGraphify(graphPath)).toEqual([]);
  const sidecar = JSON.parse(readFileSync(join(dir, layout.graphMeta), 'utf8')) as { generator: string; property: string };
  expect(sidecar).toMatchObject({ generator: 'searchtrace', property });
}

describe.skipIf(!graphify)('graphify contract (test 65)', () => {
  it('a synthetic site round-trips through validate_extraction and cluster-only', async () => {
    const dir = tempDataDir();
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    await roundTrip(store, dir, graphFixture().input, PROPERTY);
  }, 180_000);

  it('the demo fixture round-trips too (once the demo and analysis packages have landed)', async (ctx) => {
    // The fixture and index live in memory (hundreds of fsynced day files are slow); only the graph goes to disk.
    const dir = tempDataDir();
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    const fixtureStore = memoryStore();
    let truth: Awaited<ReturnType<typeof writeDemoFixture>>;
    try {
      truth = await writeDemoFixture(fixtureStore);
    } catch (e) {
      if (isStError(e) && e.code === 'not_implemented') return ctx.skip();
      throw e;
    }
    const db = await openIndex(':memory:');
    try {
      await db.sync(fixtureStore);
      const through = db.dataRange().sealedThrough ?? truth.dataThrough;
      // The graph doesn't depend on bootstrap precision; the minimum B keeps this test quick.
      const config = ConfigSchema.parse({ version: 1, property: truth.property, analysis: { bootstrap: { waterfall: 100, aio: 100, did: 100 } } });
      let analysis;
      try {
        analysis = runAnalysis({ property: truth.property, siteDomain: siteDomainOf(truth.property), dataThrough: through, db, config, siteChanges: [], siteName: null });
      } catch (e) {
        if (isStError(e) && e.code === 'not_implemented') return ctx.skip();
        throw e;
      }
      const input: GraphInput = {
        property: truth.property, siteDomain: siteDomainOf(truth.property), dataThrough: through, db, analysis, previous: null,
        maxQueries: config.graph.maxQueries, renderLabel: (f) => `${f.kind}: ${f.unit.label}`,
      };
      await roundTrip(store, dir, input, truth.property);
    } finally {
      db.close();
    }
  }, 300_000);
});

describe.runIf(!graphify)('graphify contract (skipped)', () => {
  it.skip('graphify is not on PATH; install graphifyy to run the contract test', () => undefined);
});
