// Test 74: the demo fixture's planted story is recovered end to end, offline (spec 6.9, 10.2). Owner: WP-E.
//
// Part 1 runs the analysis over a real SQLite index built from the fixture and checks every
// truth.json expectation against the structured output. Part 2 runs the whole offline pipeline in a
// temporary folder (as `searchtrace demo` does) and checks the same story in reports/findings.json,
// plus the report's size and safety. Every expectation is its own test, so a failure names the part
// of the story that was not recovered.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, writeConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { clusterTemplates } from '../../src/core/templates.js';
import { addDays, fixedClock, ptDayStart } from '../../src/core/time.js';
import type { AnalysisOutput, Finding, SiteChange } from '../../src/core/types.js';
import { runAnalysisDetailed } from '../../src/analyze/index.js';
import { DEMO_PROPERTY, demoTruth, writeDemoFixture, type DemoExpectation } from '../../src/demo/fixture.js';
import { openIndex } from '../../src/index/db.js';
import { runPipeline } from '../../src/pipeline/run.js';
import { deriveSiteChanges } from '../../src/sources/crawl/diff.js';
import { layout } from '../../src/store/layout.js';
import { openStore } from '../../src/store/store.js';
import { memoryStore } from '../helpers/index.js';

const { expectations } = demoTruth();

/** The fields of a finding the truth checks need, from a Finding or a findings.json entry. */
interface Seen { kind: string; unitKey: string; real: string; cause: string | null; estimate: number | null; mde: number | null; events: string[] }

const fromFinding = (f: Finding): Seen => ({
  kind: f.kind, unitKey: f.unit.key, real: f.real, cause: f.cause, estimate: f.effect.estimate, mde: f.power?.mde ?? null, events: f.related.googleEvents,
});

function fromJson(f: Record<string, unknown>): Seen {
  const unit = f.unit as { key: string };
  const effect = (f.effect ?? {}) as { estimate?: number | null };
  const power = f.power as { mde?: number } | null;
  const related = (f.related ?? {}) as { google_events?: string[] };
  return {
    kind: String(f.kind), unitKey: unit.key, real: String(f.real), cause: (f.cause as string | null) ?? null, estimate: effect.estimate ?? null,
    mde: power?.mde ?? null, events: related.google_events ?? [],
  };
}

/** The findings that answer one expectation, and what is wrong with each (empty when one matches). */
function check(e: DemoExpectation, seen: Seen[]): { matched: Seen | null; candidates: Seen[] } {
  const candidates = seen.filter((f) => {
    if (f.kind !== e.kind) return false;
    if (e.eventId) return f.events[0] === e.eventId;
    if (e.kind === 'aio_effect') return e.estimator ? f.unitKey.includes(e.estimator) || f.unitKey === e.unitKey : true;
    if (e.kind === 'site_change_impact') return true;
    return f.unitKey === e.unitKey;
  });
  const ok = (f: Seen): boolean => {
    const reals = e.realAnyOf ?? [e.real];
    if (!reals.includes(f.real as never)) return false;
    if (e.cause !== null && f.cause !== e.cause) return false;
    if (e.tauRange && (f.estimate === null || f.estimate < e.tauRange[0] || f.estimate > e.tauRange[1])) return false;
    if (e.needsMde && !(f.mde !== null && f.mde > 0)) return false;
    return true;
  };
  return { matched: candidates.find(ok) ?? null, candidates };
}

const describeCandidates = (c: Seen[]): string =>
  c.length === 0 ? 'no finding of that kind and unit' : c.map((f) => `${f.unitKey}: ${f.real}, cause ${f.cause}, estimate ${f.estimate}`).join('; ');

describe('demo: analysis over the real index', () => {
  let out: AnalysisOutput;
  let skipped: string[];
  let siteChanges: SiteChange[] = [];

  beforeAll(async () => {
    const store = memoryStore();
    const truth = await writeDemoFixture(store);
    const db = await openIndex(':memory:');
    await db.sync(store);
    try {
      siteChanges = deriveSiteChanges({
        snapshots: db.snapshots(), fieldsByHash: db.fieldsByHash(), annotations: db.annotations(), inspections: db.inspections(),
        templates: clusterTemplates(db.pages().map((p) => p.url)),
      });
    } catch (e) {
      if (!(e instanceof StError && e.code === 'not_implemented')) throw e;
    }
    const r = runAnalysisDetailed({
      property: truth.property, siteDomain: 'pipewell-plumbing.example', dataThrough: truth.dataThrough, db, config: defaultConfig(truth.property),
      siteChanges, siteName: 'Pipewell Plumbing',
    });
    out = r.output;
    skipped = r.skipped;
    db.close();
  }, 180_000);

  it('runs every analyzer (none left as a stub)', () => {
    expect(skipped).toEqual([]);
  });

  it('finds the title change on the blog as one site change touching 40 pages', () => {
    expect(siteChanges.length).toBe(1);
    expect(siteChanges[0]).toMatchObject({ field: 'title', templateKey: '/blog/*' });
    expect(siteChanges[0].touched.length).toBe(40);
  });

  for (const e of expectations) {
    it(`recovers: ${e.note}`, () => {
      const { matched, candidates } = check(e, out.findings.map(fromFinding));
      expect(matched, describeCandidates(candidates)).not.toBeNull();
      if (e.kind === 'update_impact') {
        const row = out.scorecard.find((r) => r.eventId === e.eventId);
        expect(row?.clicks?.real).toBe(e.real);
        if (e.failedCheck === 'competing_events') expect(row?.competing.length).toBeGreaterThan(0);
        if (e.real === 'signal') expect(row?.clicks?.tau).toBeLessThan(0);
      }
      if (e.kind === 'aio_effect') {
        const did = out.aio?.estimates.find((x) => x.estimator === e.estimator);
        expect(did?.real).toBe(e.real);
        expect(did?.tau).toBeGreaterThanOrEqual(e.tauRange![0]);
        expect(did?.tau).toBeLessThanOrEqual(e.tauRange![1]);
      }
      if (e.kind === 'site_change_impact') {
        const impact = out.siteChangeImpacts.find((x) => x.synthesis === e.synthesis);
        expect(impact, JSON.stringify(out.siteChangeImpacts)).toBeDefined();
        expect(impact?.tau).toBeGreaterThanOrEqual(e.tauRange![0]);
        expect(impact?.tau).toBeLessThanOrEqual(e.tauRange![1]);
      }
    });
  }

  it('keeps the waterfall invariant for every scope and reconciles page and property clicks', () => {
    for (const s of out.scopes) {
      const sum = Object.values(s.bars).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - s.deltaClicks)).toBeLessThan(1e-6);
    }
    expect(out.diagnostics.reconciliation.byPageClicks).toBeGreaterThan(0);
    expect(Math.abs(out.diagnostics.reconciliation.byPageClicks / out.diagnostics.reconciliation.byPropertyClicks - 1)).toBeLessThan(0.01);
    expect(out.diagnostics.namedClickShare).toBeGreaterThan(0.6);
    expect(out.diagnostics.namedClickShare).toBeLessThan(0.8);
  });
});

describe('demo: offline pipeline', () => {
  let dir = '';
  let pipelineReady = true;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'searchtrace-demo-e2e-'));
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    const truth = await writeDemoFixture(store);
    const cfg = defaultConfig(truth.property);
    await writeConfig(dir, { ...cfg, crawl: { ...cfg.crawl, enabled: false }, inspection: { ...cfg.inspection, enabled: false } });
    const runAt = ptDayStart(addDays(truth.dataThrough, 3));
    await store.writeFileAtomic(layout.meta, `${JSON.stringify({ schema: 1, property: truth.property, createdAt: runAt, toolVersion: '0.1.0', demo: true })}\n`);
    try {
      await runPipeline({
        dir, demo: true, clock: fixedClock(runAt), env: {},
        flags: { dryRun: false, offline: true, noPaid: true, ci: false, yes: true, interactive: false, budgetUsd: 0, waitMinutes: 0, credentials: null, forceGraph: false },
      });
    } catch (e) {
      if (e instanceof StError && e.code === 'not_implemented') pipelineReady = false;
      else throw e;
    }
  }, 240_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes a findings.json that tells the planted story', async (ctx) => {
    if (!pipelineReady) ctx.skip();
    const doc = JSON.parse(await readFile(join(dir, layout.findingsJson), 'utf8')) as { property: string; data_through: string; findings: Record<string, unknown>[] };
    expect(doc.property).toBe(DEMO_PROPERTY);
    expect(doc.data_through).toBe('2026-10-03');
    const seen = doc.findings.map(fromJson);
    const missed = expectations
      .map((e) => ({ e, r: check(e, seen) }))
      .filter((x) => !x.r.matched)
      .map((x) => `${x.e.note} (${describeCandidates(x.r.candidates)})`);
    expect(missed).toEqual([]);
  });

  it('writes a self-contained HTML report under 300 KB with no scripts', async (ctx) => {
    if (!pipelineReady) ctx.skip();
    const path = join(dir, layout.reportHtml);
    expect((await stat(path)).size).toBeLessThan(300_000);
    const html = await readFile(path, 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="http|href="http[^"]*\.css/);
  });
});
