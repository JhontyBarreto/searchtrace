// Pipeline orchestration (4.9): phase order and skip rules, failure boundaries, exit codes (D18),
// dry run, findings partition only on change, step summary, the --wait loop. Other packages'
// modules are mocked so this runs against WP-A's real store and index before B to E land.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, writeConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { fixedClock } from '../../src/core/time.js';
import type { GoogleEvent, PhaseResult, RunFlags, RunContext } from '../../src/core/types.js';
import { exitFor, mergeCollectPolls, runPipelineWith as runPipeline, withSeedEvents } from '../../src/pipeline/run.js';
import { openStore } from '../../src/store/store.js';
import { seedDataDir } from '../helpers/fixture-data.js';
import { memoryIndex } from '../helpers/memory-index.js';
import { makeAnalysisOutput } from './report-fixture.js';

// These tests write real files (with fsync) and open SQLite; give them room on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const m = vi.hoisted(() => {
  const ok = (name: string, extra: Record<string, unknown> = {}) => ({
    name, status: 'ok', startedAt: '2026-10-06T06:17:00Z', endedAt: '2026-10-06T06:17:01Z', requests: {}, rows: 0, costUsd: 0,
    partitions: [], notes: [], errors: [], ...extra,
  });
  const collector = (name: string) => ({
    name,
    plan: vi.fn(async () => ({ lines: [{ group: 'free', label: name, detail: `${name} plan` }], estRequests: 1, estUsd: 0, payload: { pendingTaskIds: [] as string[] }, skip: null })),
    execute: vi.fn(async () => ok(name, { notes: [`${name} done`], requests: { [`${name}.call`]: 2 } })),
  });
  return {
    ok,
    analysis: vi.fn(),
    seed: vi.fn((): unknown[] => []),
    updates: collector('updates'),
    gsc: collector('gsc'),
    crawl: collector('crawl'),
    inspect: collector('inspect'),
    serpCollect: collector('serp_collect'),
    serpPoster: {
      plan: vi.fn(async () => ({ lines: [{ group: 'paid', label: 'AI Overview checks', detail: '3 checks' }], estRequests: 1, estUsd: 0.004, payload: {}, skip: null })),
      execute: vi.fn(async () => ok('serp_post', { costUsd: 0.0036, requests: { 'dfs.task_post': 1 } })),
    },
    auth: vi.fn(async () => ({ kind: 'service_account', principal: 'robot@example.iam.gserviceaccount.com', scopes: [], headers: async () => ({}) })),
    buildGraph: vi.fn(() => ({ directed: false, multigraph: false, graph: {}, nodes: [], links: [] })),
    writeGraph: vi.fn(async () => ({ nodes: 12, links: 20, path: 'graphify-out/graph.json' })),
  };
});

vi.mock('../../src/analyze/index.js', () => ({ runAnalysis: m.analysis }));
vi.mock('../../src/sources/google/updates.js', () => ({ updatesCollector: m.updates, loadSeedEvents: m.seed }));
vi.mock('../../src/sources/google/gsc.js', () => ({ gscCollector: m.gsc }));
vi.mock('../../src/sources/crawl/crawl.js', () => ({ crawlCollector: m.crawl }));
vi.mock('../../src/sources/crawl/diff.js', () => ({ deriveSiteChanges: () => [] }));
vi.mock('../../src/sources/google/inspection.js', () => ({ inspectionCollector: m.inspect }));
vi.mock('../../src/sources/dataforseo/serp.js', () => ({ serpCollectCollector: m.serpCollect, serpPoster: m.serpPoster }));
vi.mock('../../src/sources/google/auth.js', () => ({ loadGoogleAuth: m.auth, listSites: vi.fn() }));
vi.mock('../../src/graph/build.js', () => ({ buildGraph: m.buildGraph }));
vi.mock('../../src/graph/write.js', () => ({ writeGraph: m.writeGraph }));

const CLOCK = fixedClock('2026-10-06T06:17:00Z');

function flags(p: Partial<RunFlags> = {}): RunFlags {
  return {
    dryRun: false, offline: false, noPaid: false, ci: false, yes: true, interactive: false, budgetUsd: null, waitMinutes: 0,
    credentials: null, forceGraph: false, ...p,
  };
}

let dir: string;

async function seeded(cfg = defaultConfig('sc-domain:example.com')): Promise<void> {
  await writeConfig(dir, cfg);
  const store = await openStore(dir, createSecretRegistry({ ci: false }));
  await seedDataDir(store);
}

async function files(prefix = ''): Promise<string[]> {
  const store = await openStore(dir, createSecretRegistry({ ci: false }));
  return (await store.list(prefix)).map((f) => f.path);
}

const run = (p: Partial<RunFlags> = {}, extra: Record<string, unknown> = {}) =>
  runPipeline({ dir, flags: flags(p), clock: CLOCK, env: {}, quiet: true, ...extra });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'st-pipeline-'));
  vi.clearAllMocks();
  m.analysis.mockImplementation(() => makeAnalysisOutput());
  m.seed.mockImplementation(() => []);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runPipeline', () => {
  it('runs every phase in order offline, writes reports and graph, and exits ok', async () => {
    await seeded();
    const s = await run({ offline: true });
    // The updates collector runs even offline (its own plan decides): it fetches nothing then, but
    // stores the bundled list once so the index and graph see Google's updates (4.9 note, WP-B).
    expect(s.phases.map((p) => `${p.name}:${p.status}`)).toEqual([
      'lock:ok', 'updates:ok', 'gsc:skipped', 'index:ok', 'crawl:skipped', 'inspect:skipped', 'serp_collect:skipped',
      'analyze:ok', 'serp_post:skipped', 'report:ok', 'graph:ok',
    ]);
    expect(m.updates.execute).toHaveBeenCalledTimes(1);
    expect(s.exit).toBe('ok');
    expect(s.dataThrough).toBe('2026-10-03');
    expect(s.headline).toContain('In the last 28 days');
    expect(s.reportPath).toBe(join(dir, 'reports', 'latest.html'));
    const all = await files();
    expect(all).toEqual(expect.arrayContaining(['reports/latest.html', 'reports/latest.md', 'reports/findings.json']));
    expect(all.filter((f) => f.startsWith('findings/2026/10/r20261006t061700z'))).toHaveLength(1);
    expect(all).not.toContain('state/lock');
    expect(m.gsc.plan).not.toHaveBeenCalled();
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    const runs = await store.readLedger<{ event: string; exit?: string }>('runs');
    expect(runs.map((r) => r.event)).toEqual(['start', 'end']);
    expect(runs[1].exit).toBe('ok');
    const input = (m.buildGraph.mock.calls[0] as unknown as [{ renderLabel: (f: unknown) => string }])[0];
    const label = input.renderLabel(makeAnalysisOutput().findings[0]);
    expect(label.length).toBeLessThanOrEqual(120);
  });

  it('is idempotent offline: same findings.json bytes, no second findings partition', async () => {
    await seeded();
    await run({ offline: true });
    const a = await readFile(join(dir, 'reports', 'findings.json'), 'utf8');
    const s2 = await runPipeline({ dir, flags: flags({ offline: true }), clock: fixedClock('2026-10-07T06:17:00Z'), env: {}, quiet: true });
    const b = await readFile(join(dir, 'reports', 'findings.json'), 'utf8');
    expect(b).toBe(a);
    expect(s2.phases.find((p) => p.name === 'analyze')?.notes).toContain('Findings unchanged since the last run.');
    expect((await files('findings/2026/10/')).filter((f) => /r2026100[67]/.test(f))).toHaveLength(1);
  });

  it('runs the online collectors, and an auth failure in one phase gives exit 3 with the report still written', async () => {
    await seeded();
    m.gsc.plan.mockRejectedValueOnce(new StError('permission', 'robot@x cannot read sc-domain:example.com', 'Add robot@x as a user.'));
    const s = await run();
    const gsc = s.phases.find((p) => p.name === 'gsc') as PhaseResult;
    expect(gsc.status).toBe('failed');
    expect(gsc.errors[0].code).toBe('permission');
    expect(gsc.notes).toEqual(['Add robot@x as a user.']);
    expect(m.updates.execute).toHaveBeenCalled();
    expect(m.crawl.execute).toHaveBeenCalled();
    expect(m.inspect.execute).toHaveBeenCalled();
    expect(s.phases.find((p) => p.name === 'report')?.status).toBe('ok');
    expect(s.exit).toBe('auth');
  });

  it('gives exit 3 when no credential loads, without calling the GSC collector', async () => {
    await seeded();
    m.auth.mockRejectedValueOnce(new StError('reauth_required', 'Google wants you to sign in again.', 'Run gcloud ...'));
    const s = await run();
    expect(m.gsc.plan).not.toHaveBeenCalled();
    expect(s.phases.find((p) => p.name === 'gsc')?.errors[0].code).toBe('reauth_required');
    expect(s.exit).toBe('auth');
  });

  it('gives exit 4 when a phase fails for another reason, and later phases still run', async () => {
    await seeded();
    m.crawl.execute.mockRejectedValueOnce(new Error('boom'));
    const s = await run();
    expect(s.phases.find((p) => p.name === 'crawl')?.errors[0]).toEqual({ code: 'internal', message: 'Unexpected problem: boom' });
    expect(s.phases.find((p) => p.name === 'graph')?.status).toBe('ok');
    expect(s.exit).toBe('partial');
  });

  it('skips report and graph when analysis fails, and exits partial', async () => {
    await seeded();
    m.analysis.mockImplementationOnce(() => {
      throw new StError('not_implemented', 'runAnalysis is not implemented yet.');
    });
    const s = await run({ offline: true });
    expect(s.phases.find((p) => p.name === 'analyze')?.status).toBe('failed');
    expect(s.phases.find((p) => p.name === 'report')?.status).toBe('skipped');
    expect(s.reportPath).toBeNull();
    expect(s.exit).toBe('partial');
  });

  it('skips analysis with no sealed days', async () => {
    await writeConfig(dir, defaultConfig('sc-domain:example.com'));
    const s = await run({ offline: true });
    expect(s.phases.find((p) => p.name === 'analyze')?.status).toBe('skipped');
    expect(s.exit).toBe('ok');
    expect(m.analysis).not.toHaveBeenCalled();
  });

  it('refuses data for another property', async () => {
    await seeded(defaultConfig('sc-domain:other.example'));
    const s = await run({ offline: true });
    expect(s.phases.find((p) => p.name === 'analyze')?.errors[0].code).toBe('config');
    expect(s.exit).toBe('config');
  });

  it('dry run plans every collector and writes nothing but a ledger line', async () => {
    const cfg = defaultConfig('sc-domain:example.com');
    await writeConfig(dir, { ...cfg, serp: { provider: 'dataforseo', loginEnv: 'L', passwordEnv: 'P', monthlyBudgetUsd: 1, maxPerRunUsd: 0.3, costPerCheckUsd: 0.0012 } });
    const s = await run({ dryRun: true });
    expect(s.plan?.map((l) => l.label)).toEqual(['gsc', 'updates', 'crawl', 'inspect', 'serp_collect', 'AI Overview checks']);
    expect(m.gsc.execute).not.toHaveBeenCalled();
    expect(m.serpPoster.execute).not.toHaveBeenCalled();
    const all = (await files()).filter((f) => !f.startsWith('state/'));
    expect(all).toEqual(['config.json', 'ledger/runs/2026-10.ndjson']);
    expect(s.exit).toBe('ok');
  });

  it('posts paid checks only when allowed, and --wait polls then re-runs analysis, report and graph', async () => {
    await seeded();
    const cfg = defaultConfig('sc-domain:example.com');
    await writeConfig(dir, { ...cfg, serp: { provider: 'dataforseo', loginEnv: 'L', passwordEnv: 'P', monthlyBudgetUsd: 1, maxPerRunUsd: 0.3, costPerCheckUsd: 0.0012 } });
    const noPaid = await run({ noPaid: true });
    expect(noPaid.phases.find((p) => p.name === 'serp_post')?.status).toBe('skipped');
    expect(m.serpPoster.execute).not.toHaveBeenCalled();

    const sleep = vi.fn(async () => undefined);
    m.serpCollect.plan
      .mockResolvedValueOnce({ lines: [], estRequests: 0, estUsd: 0, payload: { pendingTaskIds: [] }, skip: null })
      .mockResolvedValueOnce({ lines: [], estRequests: 1, estUsd: 0, payload: { pendingTaskIds: ['t1'] }, skip: null })
      .mockResolvedValueOnce({ lines: [], estRequests: 0, estUsd: 0, payload: { pendingTaskIds: [] }, skip: null });
    const collectsBefore = m.serpCollect.execute.mock.calls.length;
    const s = await run({ waitMinutes: 2 }, { sleep });
    expect(m.serpPoster.execute).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(s.spendUsd).toBeCloseTo(0.0036);
    // One row per step: the poll folds into "AI Overview results", and the refreshed analysis,
    // report and graph replace the first ones (a 20-minute wait used to add 40 rows).
    expect(m.serpCollect.execute.mock.calls.length - collectsBefore).toBe(2);
    for (const name of ['serp_collect', 'analyze', 'report', 'graph']) expect(s.phases.filter((p) => p.name === name)).toHaveLength(1);
    expect(s.phases.find((p) => p.name === 'serp_collect')?.notes).toContain('Collected 0 AI Overview checks while waiting.');
  });

  it('merges --wait polls into one step that says what is still outstanding', () => {
    const at = '2026-10-06T16:17:00Z';
    const ph = (rows: number, notes: string[], req: Record<string, number>, status: 'ok' | 'partial' = 'ok') => ({
      name: 'serp_collect' as const, status, startedAt: at, endedAt: at, requests: req, rows, costUsd: 0, partitions: rows ? [`serp/2026/10/p${rows}.ndjson.gz`] : [], notes, errors: [],
    });
    const merged = mergeCollectPolls(ph(0, [], { 'dataforseo.id_list': 1 }), [
      ph(48, ['Collected 48 AI Overview checks.', '117 checks are still being processed by DataForSEO and will be collected next run.'], { 'dataforseo.tasks_ready': 1, 'dataforseo.task_get': 48 }),
      ph(37, ['Collected 37 AI Overview checks.', '1 check could not be read this time; they will be tried again next run.'], { 'dataforseo.tasks_ready': 1, 'dataforseo.task_get': 38 }, 'partial'),
      ph(0, ['1 check is still being processed by DataForSEO and will be collected next run.'], { 'dataforseo.tasks_ready': 1 }),
    ]);
    expect(merged.requests).toEqual({ 'dataforseo.id_list': 1, 'dataforseo.tasks_ready': 3, 'dataforseo.task_get': 86 });
    expect(merged.rows).toBe(85);
    expect(merged.partitions).toHaveLength(2);
    expect(merged.status).toBe('partial');
    expect(merged.notes).toEqual(['Collected 85 AI Overview checks while waiting.', '1 check is still being processed by DataForSEO and will be collected next run.']);
  });

  it('writes the step summary in CI', async () => {
    await seeded();
    const summary = join(dir, '..', `${dir.split('/').pop()}-summary.md`);
    await writeFile(summary, '');
    await runPipeline({ dir, flags: flags({ offline: true, ci: true }), clock: CLOCK, env: { GITHUB_STEP_SUMMARY: summary }, quiet: true });
    const text = await readFile(summary, 'utf8');
    expect(text).toContain('## The answer');
    await rm(summary, { force: true });
  });

  it('refuses a held lock before anything runs', async () => {
    await seeded();
    const store = await openStore(dir, createSecretRegistry({ ci: false }));
    await store.writeFileAtomic('state/lock', JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), runId: 'r20261006t000000z-0000', startedAt: '2026-10-06T06:00:00Z' }));
    await expect(run({ offline: true })).rejects.toMatchObject({ code: 'lock_held' });
    expect((await readdir(dir)).includes('reports')).toBe(false);
  });
});

describe('exitFor', () => {
  const ph = (status: PhaseResult['status'], code?: string): PhaseResult => ({
    name: 'gsc', status, startedAt: '', endedAt: '', requests: {}, rows: 0, costUsd: 0, partitions: [], notes: [],
    errors: code ? [{ code, message: 'x' }] : [],
  });
  it('maps phase errors to D18 exit names', () => {
    expect(exitFor([ph('ok'), ph('partial'), ph('skipped')])).toBe('ok');
    expect(exitFor([ph('failed', 'budget')])).toBe('ok');
    expect(exitFor([ph('failed', 'quota')])).toBe('partial');
    expect(exitFor([ph('failed', 'internal')])).toBe('partial');
    expect(exitFor([ph('failed', 'graph_not_ours')])).toBe('config');
    expect(exitFor([ph('failed', 'internal'), ph('failed', 'permission'), ph('failed', 'config')])).toBe('auth');
  });

  it('treats a deferred phase (URL Inspection quota reached for the day) as a warning, not exit 4', () => {
    expect(exitFor([ph('ok'), { ...ph('deferred', 'quota'), name: 'inspect' }])).toBe('ok');
  });
});

describe('withSeedEvents', () => {
  it('merges the bundled seed into stored events, latest modified wins', () => {
    const ev = (id: string, modified: string | null, title: string): GoogleEvent => ({
      id, source: 'seed', service: 'Ranking', kind: 'core', title, begin: '2025-12-11T00:00:00Z', end: null, endEstimated: true, url: null, modified,
    });
    m.seed.mockImplementation(() => [ev('a', '2025-12-01T00:00:00Z', 'seed a'), ev('b', null, 'seed b')]);
    const db = memoryIndex({ events: [ev('a', '2026-01-01T00:00:00Z', 'stored a')] });
    const merged = withSeedEvents(db).googleEvents();
    expect(merged.map((e) => e.title).sort()).toEqual(['seed b', 'stored a']);
    expect(withSeedEvents(db).property()).toBe(db.property());
  });
});

export type { RunContext };
