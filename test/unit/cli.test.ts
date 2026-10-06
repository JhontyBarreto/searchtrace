// Test 73: exit codes per error class, --ci never prompts, NO_COLOR honoured, --json output parses.
// Also the run, why, note and demo commands and the 6.4.1 / 6.4.2 terminal layouts.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainWith as main } from '../../src/cli/main.js';
import type { CliDeps, Prompter } from '../../src/cli/prompt.js';
import { formatPlan, formatRunSummary } from '../../src/cli/commands/run.js';
import { resolveNoteUrls } from '../../src/cli/commands/note.js';
import { defaultConfig, writeConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { fixedClock } from '../../src/core/time.js';
import { renderFindingsJson } from '../../src/report/json.js';
import { openStore } from '../../src/store/store.js';
import { seedDataDir } from '../helpers/fixture-data.js';
import { makeAnalysisOutput, makeReportContext, makeRunSummary } from './report-fixture.js';

// These tests write real files (with fsync) and open SQLite; give them room on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const m = vi.hoisted(() => {
  const ok = (name: string, extra: Record<string, unknown> = {}) => ({
    name, status: 'ok', startedAt: '2026-10-06T06:17:00Z', endedAt: '2026-10-06T06:17:01Z', requests: {}, rows: 0, costUsd: 0,
    partitions: [], notes: [], errors: [], ...extra,
  });
  const collector = (name: string, note: string) => ({
    name,
    plan: vi.fn(async () => ({ lines: [{ group: 'free', label: name, detail: 'planned' }], estRequests: 1, estUsd: 0, payload: { pendingTaskIds: [] }, skip: null })),
    execute: vi.fn(async () => ok(name, { notes: [note] })),
  });
  return {
    analysis: vi.fn(),
    updates: collector('updates', '58 known, 0 new'),
    gsc: collector('gsc', '490 days stored (490 new)'),
    crawl: collector('crawl', '203 pages saved'),
    inspect: collector('inspect', '200 of your 2,000 daily checks used'),
    serpCollect: collector('serp_collect', 'nothing pending'),
    addAnnotation: vi.fn(async (_s: unknown, a: Record<string, unknown>) => ({ ...a, id: 'ann', at: '2026-10-06T06:17:00Z' })),
    fixture: vi.fn(),
  };
});

vi.mock('../../src/analyze/index.js', () => ({ runAnalysis: m.analysis }));
vi.mock('../../src/sources/google/updates.js', () => ({ updatesCollector: m.updates, loadSeedEvents: () => [] }));
vi.mock('../../src/sources/google/gsc.js', () => ({ gscCollector: m.gsc }));
vi.mock('../../src/sources/crawl/crawl.js', () => ({ crawlCollector: m.crawl }));
vi.mock('../../src/sources/crawl/diff.js', () => ({ deriveSiteChanges: () => [] }));
vi.mock('../../src/sources/google/inspection.js', () => ({ inspectionCollector: m.inspect }));
vi.mock('../../src/sources/dataforseo/serp.js', () => ({ serpCollectCollector: m.serpCollect, serpPoster: { plan: vi.fn(), execute: vi.fn() } }));
vi.mock('../../src/sources/google/auth.js', () => ({
  loadGoogleAuth: vi.fn(async () => ({ kind: 'service_account', principal: 'robot@x', scopes: [], headers: async () => ({}) })),
  listSites: vi.fn(async () => []),
}));
vi.mock('../../src/sources/annotations.js', () => ({ addAnnotation: m.addAnnotation }));
vi.mock('../../src/graph/build.js', () => ({ buildGraph: () => ({ directed: false, multigraph: false, graph: {}, nodes: [], links: [] }) }));
vi.mock('../../src/graph/write.js', () => ({ writeGraph: async () => ({ nodes: 1912, links: 3000, path: 'graphify-out/graph.json' }) }));
vi.mock('../../src/demo/fixture.js', () => ({ writeDemoFixture: m.fixture }));

interface Captured { deps: Partial<CliDeps>; stdout: () => string; stderr: () => string }

function capture(p: Partial<CliDeps> = {}, o: { tty?: boolean } = {}): Captured {
  let so = '';
  let se = '';
  return {
    deps: {
      env: {},
      stdout: { write: (s: string) => { so += s; }, isTTY: o.tty ?? false },
      stderr: { write: (s: string) => { se += s; }, isTTY: false },
      stdinIsTTY: false,
      prompter: null,
      clock: fixedClock('2026-10-06T06:17:00Z'),
      cwd: dir,
      homedir: dir,
      sleep: async () => undefined,
      ...p,
    },
    stdout: () => so,
    stderr: () => se,
  };
}

let dir: string;
let data: string;

async function seeded(): Promise<void> {
  await writeConfig(data, defaultConfig('sc-domain:example.com'));
  await seedDataDir(await openStore(data, createSecretRegistry({ ci: false })));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'st-cli-'));
  data = join(dir, 'searchtrace-data');
  vi.clearAllMocks();
  m.analysis.mockImplementation(() => makeAnalysisOutput());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('main', () => {
  it('prints the version and help', async () => {
    const c = capture();
    expect(await main(['--version'], c.deps)).toBe(0);
    expect(c.stdout()).toBe('0.1.0\n');
    const h = capture();
    expect(await main(['--help'], h.deps)).toBe(0);
    expect(h.stdout()).toContain('searchtrace why [TARGET]');
  });

  it('exits 2 for an unknown command or a bad flag, with a fix line', async () => {
    const c = capture();
    expect(await main(['frobnicate'], c.deps)).toBe(2);
    expect(c.stderr()).toContain('"frobnicate" is not a searchtrace command.');
    const f = capture();
    expect(await main(['run', '--bogus'], f.deps)).toBe(2);
    expect(f.stderr()).toContain('--bogus');
    expect(f.stderr()).toContain('Run `searchtrace run --help` to see the flags.');
    const b = capture();
    expect(await main(['run', '--budget', 'lots'], b.deps)).toBe(2);
  });

  it('exits 2 when there is no config, with the setup fix', async () => {
    const c = capture();
    expect(await main(['run'], c.deps)).toBe(2);
    expect(c.stderr()).toContain('No config.json');
    expect(c.stderr()).toContain('npx searchtrace setup');
  });

  it('routes a bare command to setup without a config and to run with one', async () => {
    const c = capture();
    expect(await main([], c.deps)).toBe(2);
    expect(c.stderr()).toContain('Tell setup which Search Console property to use.');
    await seeded();
    const r = capture();
    expect(await main(['--offline'], r.deps)).toBe(0);
    expect(r.stdout()).toContain('The answer');
  });

  it('--ci never prompts', async () => {
    const prompter: Prompter = {
      ask: vi.fn(async () => { throw new Error('prompted'); }),
      confirm: vi.fn(async () => { throw new Error('prompted'); }),
      close: () => undefined,
    };
    const c = capture({ prompter, stdinIsTTY: true });
    expect(await main(['setup', '--ci'], c.deps)).toBe(2);
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
    await seeded();
    const r = capture({ prompter, stdinIsTTY: true });
    expect(await main(['run', '--ci', '--offline'], r.deps)).toBe(0);
    expect(prompter.confirm).not.toHaveBeenCalled();
  });
});

describe('run', () => {
  it('--json prints only a parseable RunSummary on stdout', async () => {
    await seeded();
    const c = capture();
    expect(await main(['run', '--offline', '--json'], c.deps)).toBe(0);
    const s = JSON.parse(c.stdout());
    expect(s.exit).toBe('ok');
    expect(s.phases.map((p: { name: string }) => p.name)).toContain('analyze');
    expect(s.reportPath).toBe(join(data, 'reports', 'latest.html'));
  });

  it('maps exit codes per error class', async () => {
    await seeded();
    m.gsc.plan.mockRejectedValueOnce(new StError('permission', 'no access', 'Add robot@x as a user.'));
    const auth = capture();
    expect(await main(['run'], auth.deps)).toBe(3);
    expect(auth.stdout()).toContain('! Search Console: no access Add robot@x as a user.');

    m.crawl.execute.mockRejectedValueOnce(new Error('boom'));
    const partial = capture();
    expect(await main(['run'], partial.deps)).toBe(4);
    expect(partial.stdout()).toContain("Some steps didn't finish. The report uses everything collected so far.");

    const store = await openStore(data, createSecretRegistry({ ci: false }));
    await store.writeFileAtomic('state/lock', JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), runId: 'r20261006t000000z-0000', startedAt: '2026-10-06T06:00:00Z' }));
    const locked = capture();
    expect(await main(['run', '--offline'], locked.deps)).toBe(1);
    expect(locked.stderr()).toContain('Another searchtrace run is in progress');
  });

  it('prints the 6.4.1 layout', async () => {
    await seeded();
    const c = capture();
    expect(await main(['run'], c.deps)).toBe(0);
    const out = c.stdout();
    const lines = out.split('\n');
    expect(lines[0]).toBe('searchtrace 0.1.0 · sc-domain:example.com');
    // 06:17 UTC on 6 Oct is still 5 Oct in Pacific Time, so 4 and 5 Oct are the unfinished days.
    expect(lines[1]).toBe("Data runs to 3 Oct 2026 (Pacific Time). The last 2 days are still being finalised by Google, so they're left out.");
    expect(out).toContain('\nCollecting\n  Google updates        58 known, 0 new\n  Search Console        490 days stored (490 new)\n');
    expect(out).toContain('  AI Overview checks    off · add a DataForSEO login to turn on');
    expect(out).toContain('\nThe answer\n  In the last 28 days Google sent you 80 clicks, 9 fewer than the 28 days before (-10%).');
    expect(out).toContain('Also worth knowing\n  · Real change:');
    expect(out).toMatch(/Report {3}file:\/\/.*\/reports\/latest\.html/);
    expect(out).toContain('Why      npx searchtrace why\n');
    expect(out).toContain('Graph    searchtrace-data/graphify-out/graph.json (1,912 nodes) · ask it in Claude: see docs/GRAPHIFY.md');
  });

  it('prints the 6.4.2 dry-run plan', async () => {
    await writeConfig(data, defaultConfig('sc-domain:example.com'));
    const c = capture();
    expect(await main(['run', '--dry-run'], c.deps)).toBe(0);
    expect(c.stdout()).toContain('Plan for sc-domain:example.com (nothing will be fetched)\n\nFree (Google and your site)\n  gsc                   planned');
    expect(c.stdout()).toContain('Run it for real: npx searchtrace run');
  });
});

describe('terminal layouts', () => {
  it('formats the plan', () => {
    const cfg = defaultConfig('sc-domain:seoengico.com');
    const text = formatPlan('sc-domain:seoengico.com', [
      { group: 'free', label: 'Search Console data', detail: '2 days to seal, last 4 days refreshed, about 8 requests' },
      { group: 'free', label: 'Google update feed', detail: '1 request' },
      { group: 'paid', label: 'AI Overview checks', detail: '206 searches x 1 device = 206 checks x $0.0012 = $0.25 (worst case)' },
    ], { ...cfg, serp: { provider: 'dataforseo', loginEnv: 'L', passwordEnv: 'P', monthlyBudgetUsd: 1, maxPerRunUsd: 0.3, costPerCheckUsd: 0.0012 } }, false);
    expect(text).toBe([
      'Plan for sc-domain:seoengico.com (nothing will be fetched)', '',
      'Free (Google and your site)',
      '  Search Console data   2 days to seal, last 4 days refreshed, about 8 requests',
      '  Google update feed    1 request', '',
      'Paid (DataForSEO, standard queue)',
      '  AI Overview checks    206 searches x 1 device = 206 checks x $0.0012 = $0.25 (worst case)', '',
      'Run it for real: npx searchtrace run', '',
    ].join('\n'));
  });

  it('formats the run summary from findings.json', () => {
    const findings = JSON.parse(renderFindingsJson(makeAnalysisOutput(), makeReportContext()));
    const s = makeRunSummary({ reportPath: '/data/searchtrace-data/reports/latest.html', graphPath: '/data/searchtrace-data/graphify-out/graph.json' });
    s.phases.push({ ...s.phases[0], name: 'graph', rows: 1912, notes: [] });
    const text = formatRunSummary(s, { property: 'sc-domain:example.com', config: defaultConfig('sc-domain:example.com'), today: '2026-10-06', dir: '/data/searchtrace-data', cwd: '/data', findings });
    expect(text).toContain('  Search Console        490 days stored (490 new) · 1,031 requests');
    expect(text).toContain("  Not enough data to tell yet. With about 20 clicks a week, only a change of roughly 45% or more");
    expect(text).toContain('  · Real change: impressions on /blog/* dropped by 18% around 12 Sep 2026');
    expect(text).toContain('  · Google hides the exact searches behind 81% of your clicks. Page-level numbers include\n    everything.');
    expect(text).toContain('Graph    searchtrace-data/graphify-out/graph.json (1,912 nodes)');
  });
});

describe('why', () => {
  it('honours NO_COLOR and --json', async () => {
    await seeded();
    const color = capture({}, { tty: true });
    expect(await main(['why'], color.deps)).toBe(0);
    expect(color.stdout()).toContain('\u001b[');
    const plain = capture({ env: { NO_COLOR: '1' } }, { tty: true });
    expect(await main(['why'], plain.deps)).toBe(0);
    expect(plain.stdout()).not.toContain('\u001b[');
    expect(plain.stdout()).toContain('Not enough data yet · Why: Unclear · Possible');
    const json = capture();
    expect(await main(['explain', '/blog/slow-drains', '--json'], json.deps)).toBe(0);
    const doc = JSON.parse(json.stdout());
    expect(doc.match).toBe('page');
    expect(doc.findings[0].unit.label).toBe('/blog/slow-drains');
  });
});

describe('note', () => {
  it('resolves globs, lists and full URLs against the property', () => {
    const known = ['https://example.com/', 'https://example.com/blog/a', 'https://example.com/blog/b', 'https://example.com/pricing'];
    const o = { property: 'sc-domain:example.com', origin: 'https://example.com/', known };
    expect(resolveNoteUrls('/blog/*', o)).toEqual(['https://example.com/blog/a', 'https://example.com/blog/b']);
    expect(resolveNoteUrls('/pricing, https://www.example.com/new', o)).toEqual(['https://example.com/pricing', 'https://www.example.com/new']);
    expect(() => resolveNoteUrls('https://evil.example/x', o)).toThrow(/not part of sc-domain:example.com/);
    expect(() => resolveNoteUrls('/nothing/*', o)).toThrow(/No known pages match/);
  });

  it('records a note and confirms it', async () => {
    await seeded();
    const c = capture();
    expect(await main(['note', 'New title template on blog posts', '--date', '2026-09-09', '--urls', '/blog/*'], c.deps)).toBe(0);
    expect(m.addAnnotation).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-09-09', text: 'New title template on blog posts', urls: ['https://example.com/blog/first-post'], field: 'annotation',
    }, expect.anything());
    expect(c.stdout()).toBe('Noted for 9 Sep 2026: "New title template on blog posts" (1 page). The next run will test it against pages you didn\'t change.\n');
    const bad = capture();
    expect(await main(['note', 'x', '--date', '9/9/2026', '--urls', '/'], bad.deps)).toBe(2);
    expect(bad.stderr()).toContain('--date YYYY-MM-DD');
  });
});

describe('demo', () => {
  it('builds the made-up site offline and prints the report link', async () => {
    m.fixture.mockImplementation(async (store) => {
      await seedDataDir(store);
      return { property: 'sc-domain:example.com', dataThrough: '2026-10-03', expect: [] };
    });
    const out = join(dir, 'demo');
    const c = capture();
    expect(await main(['demo', '--out', out], c.deps)).toBe(0);
    expect(c.stdout()).toContain('Building a demo site (Pipewell Plumbing, made up) with 16 months of history...');
    expect(c.stdout()).toMatch(/Report: file:\/\/.*\/demo\/reports\/latest\.html/);
    const html = await readFile(join(out, 'reports', 'latest.html'), 'utf8');
    expect(html).toContain('made-up site');
    expect(JSON.parse(await readFile(join(out, 'truth.json'), 'utf8')).dataThrough).toBe('2026-10-03');

    await writeFile(join(dir, 'busy'), 'x');
    const again = capture();
    expect(await main(['demo', '--out', dir], again.deps)).toBe(2);
  });
});
