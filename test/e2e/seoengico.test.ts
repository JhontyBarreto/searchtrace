// Real-property end-to-end run (spec 10.3). Opt-in only: it talks to Google and your site.
//
//   SEARCHTRACE_E2E=1 \
//   SEARCHTRACE_E2E_PROPERTY=sc-domain:example.com \
//   SEARCHTRACE_E2E_CREDENTIALS=/path/to/read-only-credential.json \
//   [SEARCHTRACE_E2E_DIR=/path/outside/the/repo] \
//   [SEARCHTRACE_E2E_PAID=1 DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=...] \
//   npm run test:e2e -- test/e2e/seoengico.test.ts
//
// Paths and the property come only from these variables. The data folder must live outside the
// repo, and the credential is read in place, never copied. Nothing here is committed.
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mainWith as main } from '../../src/cli/main.js';
import type { CliDeps } from '../../src/cli/prompt.js';

const env = process.env;
const enabled = env.SEARCHTRACE_E2E === '1' && !!env.SEARCHTRACE_E2E_PROPERTY && !!env.SEARCHTRACE_E2E_CREDENTIALS;
const paid = enabled && env.SEARCHTRACE_E2E_PAID === '1' && !!env.DATAFORSEO_LOGIN && !!env.DATAFORSEO_PASSWORD;
const PROPERTY = env.SEARCHTRACE_E2E_PROPERTY ?? '';
const CRED = env.SEARCHTRACE_E2E_CREDENTIALS ?? '';

function io(): { deps: Partial<CliDeps>; out: () => string; err: () => string } {
  let o = '';
  let e = '';
  return {
    deps: {
      env: process.env,
      stdout: { write: (s: string) => { o += s; }, isTTY: false },
      stderr: { write: (s: string) => { e += s; }, isTTY: false },
      stdinIsTTY: false,
      prompter: null,
    },
    out: () => o,
    err: () => e,
  };
}

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const c = io();
  const code = await main(args, c.deps);
  return { code, out: c.out(), err: c.err() };
}

function outsideRepo(dir: string): boolean {
  const rel = relative(resolve(process.cwd()), resolve(dir));
  return rel.startsWith('..') || isAbsolute(rel);
}

describe.skipIf(!enabled)('real property end to end (opt-in)', () => {
  let dir = '';

  it('step 1: setup --yes and doctor', async () => {
    dir = env.SEARCHTRACE_E2E_DIR ? resolve(env.SEARCHTRACE_E2E_DIR) : await mkdtemp(join(tmpdir(), 'st-e2e-'));
    expect(outsideRepo(dir), 'the e2e data folder must be outside the repo').toBe(true);
    const s = await cli(['setup', '--yes', '--dir', dir, '--property', PROPERTY, '--credentials', CRED]);
    expect(s.code, s.err).toBe(0);
    const d = await cli(['doctor', '--dir', dir, '--json']);
    const checks = JSON.parse(d.out).checks as { status: string; text: string }[];
    expect(checks.filter((c) => c.status === 'fail'), d.out).toEqual([]);
    expect(checks.some((c) => c.text.startsWith('URL Inspection: live check passed'))).toBe(true);
  });

  it('step 2: dry run writes no data partitions', async () => {
    const r = await cli(['run', '--dry-run', '--no-paid', '--dir', dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Plan for ${PROPERTY} (nothing will be fetched)`);
    const top = (await readdir(dir)).sort();
    for (const name of top) expect(['.gitignore', 'config.json', 'ledger', 'meta.json', 'state']).toContain(name);
  });

  it('step 3: first real run (free sources)', async () => {
    const r = await cli(['run', '--no-paid', '--dir', dir, '--json']);
    const s = JSON.parse(r.out);
    expect(s.exit, r.err).toBe('ok');
    const doc = JSON.parse(await readFile(join(dir, 'reports', 'findings.json'), 'utf8'));
    const rec = doc.diagnostics.reconciliation;
    expect(Math.abs(rec.byPageClicks - rec.byPropertyClicks)).toBeLessThanOrEqual(Math.max(1, rec.byPropertyClicks * 0.01));
    expect(doc.diagnostics.namedClickShare).toBeGreaterThan(0);
    expect(doc.diagnostics.namedClickShare).toBeLessThan(1);
    expect(doc.headline.real_label).toBeTruthy();
    expect(doc.scorecard.length).toBeGreaterThan(0);
    const html = await readFile(join(dir, 'reports', 'latest.html'), 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(Buffer.byteLength(html)).toBeLessThan(300_000);
  });

  it('step 4: an idempotent re-run makes almost no Search Console requests and skips the crawl', async () => {
    const r = await cli(['run', '--no-paid', '--dir', dir, '--json']);
    const s = JSON.parse(r.out);
    const gsc = s.phases.find((p: { name: string }) => p.name === 'gsc');
    const total = Object.values(gsc.requests as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3);
    expect(s.phases.find((p: { name: string }) => p.name === 'crawl').status).toBe('skipped');
  });

  it.skipIf(!paid)('steps 5 and 6: AI Overview census within budget, then no re-posting', async () => {
    const s = await cli(['setup', '--yes', '--dir', dir, '--property', PROPERTY, '--credentials', CRED, '--dataforseo', '--monthly-budget', '1', '--max-per-run', '0.30']);
    expect(s.code, s.err).toBe(0);
    const r = JSON.parse((await cli(['run', '--dir', dir, '--wait', '20', '--json'])).out);
    expect(r.spendUsd).toBeLessThanOrEqual(0.3);
    const again = JSON.parse((await cli(['run', '--dir', dir, '--json'])).out);
    const post = again.phases.find((p: { name: string }) => p.name === 'serp_post');
    expect(post.costUsd).toBe(0);
  }, 1_800_000);

  it('step 7: rebuilding the index offline gives byte-identical findings.json', async () => {
    const before = await readFile(join(dir, 'reports', 'findings.json'), 'utf8');
    const copy = join(tmpdir(), `st-e2e-findings-${Date.now()}.json`);
    await cp(join(dir, 'reports', 'findings.json'), copy);
    await rm(join(dir, 'state'), { recursive: true, force: true });
    const r = await cli(['run', '--offline', '--dir', dir]);
    expect(r.code, r.err).toBe(0);
    expect(await readFile(join(dir, 'reports', 'findings.json'), 'utf8')).toBe(before);
    await rm(copy, { force: true });
  });

  it('step 8: why, note and an offline re-run', async () => {
    for (const target of [[], ['/'], ['2025-09-12']]) {
      const w = await cli(['why', ...target, '--dir', dir]);
      expect(w.code, w.err).toBe(0);
      expect(w.out.length).toBeGreaterThan(0);
    }
    const n = await cli(['note', 'Test note: blog title template', '--date', '2026-09-01', '--urls', '/', '--dir', dir]);
    expect(n.code, n.err).toBe(0);
    const r = await cli(['run', '--offline', '--dir', dir]);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'reports', 'findings.json'), 'utf8'));
    expect(doc.site_changes.some((c: { source: string }) => c.source === 'annotation')).toBe(true);
  });
});
