// setup (--yes and the wizard), the Action template it writes (6.7, 6.8), and doctor (6.4.4).
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainWith as main } from '../../src/cli/main.js';
import type { CliDeps, Prompter } from '../../src/cli/prompt.js';
import { normalizePropertyInput, writeWorkflow } from '../../src/cli/commands/setup.js';
import { defaultConfig, loadConfig, writeConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { fixedClock } from '../../src/core/time.js';
import { fakeFetch } from '../helpers/fake-fetch.js';

// These tests write real files (with fsync) and open SQLite; give them room on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  sites: vi.fn(),
}));
vi.mock('../../src/sources/google/auth.js', () => ({ loadGoogleAuth: m.auth, listSites: m.sites }));
vi.mock('../../src/analyze/brand.js', () => ({ buildBrandMatcher: () => ({ tokens: ['example'], isBrand: () => false, suggestions: () => [] }) }));

const ROBOT = 'searchtrace@demo-project.iam.gserviceaccount.com';
let dir: string;
let data: string;
let key: string;

function capture(p: Partial<CliDeps> = {}) {
  let so = '';
  let se = '';
  const deps: Partial<CliDeps> = {
    env: { PATH: '' },
    stdout: { write: (s: string) => { so += s; }, isTTY: false },
    stderr: { write: (s: string) => { se += s; }, isTTY: false },
    stdinIsTTY: false,
    prompter: null,
    clock: fixedClock('2026-10-06T16:17:00Z'),
    cwd: dir,
    homedir: join(dir, 'home'),
    sleep: async () => undefined,
    nodeVersion: '22.17.1',
    ...p,
  };
  return { deps, stdout: () => so, stderr: () => se };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'st-setup-'));
  data = join(dir, 'searchtrace-data');
  key = join(dir, 'keys', 'robot.json');
  await mkdir(join(dir, 'keys'), { recursive: true });
  await writeFile(key, JSON.stringify({ type: 'service_account', client_email: ROBOT, private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }));
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ kind: 'service_account', principal: ROBOT, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'], headers: async () => ({ authorization: 'Bearer test-token-123456' }) });
  m.sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' }]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('setup --yes', () => {
  it('writes config, meta and the data .gitignore, pointing at the key without copying it', async () => {
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], c.deps)).toBe(0);
    const cfg = await loadConfig(data);
    expect(cfg.property).toBe('sc-domain:example.com');
    expect(cfg.auth.credentialsFile).toBe(key);
    expect(cfg.serp.provider).toBe('none');
    expect(JSON.parse(await readFile(join(data, 'meta.json'), 'utf8'))).toMatchObject({ schema: 1, property: 'sc-domain:example.com', createdAt: '2026-10-06T16:17:00Z' });
    expect(await readFile(join(data, '.gitignore'), 'utf8')).toBe('state/\n*.tmp-*\ngraphify-out/*\n!graphify-out/graph.json\n!graphify-out/searchtrace.meta.json\n');
    expect(c.stdout()).toContain('I can see sc-domain:example.com (siteFullUser).');
    expect(existsSync(join(dir, 'home', '.config', 'searchtrace'))).toBe(false);
  });

  it('merges flags into an existing config instead of replacing it', async () => {
    const base = defaultConfig('sc-domain:example.com');
    await writeConfig(data, { ...base, analysis: { ...base.analysis, windowDays: 21, brandTerms: ['acme'] } });
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--dataforseo', '--monthly-budget', '2'], c.deps)).toBe(0);
    const cfg = await loadConfig(data);
    expect(cfg.analysis.windowDays).toBe(21);
    expect(cfg.analysis.brandTerms).toEqual(['acme']);
    expect(cfg.serp).toMatchObject({ provider: 'dataforseo', monthlyBudgetUsd: 2, maxPerRunUsd: 0.3, loginEnv: 'DATAFORSEO_LOGIN' });
    expect(c.stdout()).toContain('Updated your settings');
  });

  it('turns a bare domain into the Domain property it finds', async () => {
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'example.com', '--credentials', key], c.deps)).toBe(0);
    expect((await loadConfig(data)).property).toBe('sc-domain:example.com');
    expect(c.stdout()).toContain('A "Domain" property covers http, https, www and subdomains. Using it.');
  });

  it('fails with the format-mismatch fix (exit 2) and the permission fix (exit 3)', async () => {
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'https://example.com/', '--credentials', key], c.deps)).toBe(2);
    expect(c.stderr()).toContain('You typed https://example.com/; your property is sc-domain:example.com.');
    expect(existsSync(join(data, 'config.json'))).toBe(false);
    m.sites.mockResolvedValueOnce([]);
    const p = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], p.deps)).toBe(3);
    expect(p.stderr()).toContain(`Add ${ROBOT} as a user on sc-domain:example.com in Search Console > Settings > Users and permissions.`);
  });

  it('refuses a key inside the data folder', async () => {
    await mkdir(data, { recursive: true });
    const inside = join(data, 'key.json');
    await writeFile(inside, '{}');
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', inside], c.deps)).toBe(2);
    expect(c.stderr()).toContain('The key file is inside the data folder');
  });

  it('saves the settings with a warning when Google cannot be reached', async () => {
    m.auth.mockRejectedValueOnce(new StError('reauth_required', 'Google wants you to sign in again.', 'Run gcloud auth application-default login'));
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com'], c.deps)).toBe(0);
    expect(c.stderr()).toContain("Couldn't check the property with Google yet: Google wants you to sign in again.");
    expect((await loadConfig(data)).property).toBe('sc-domain:example.com');
  });

  it('normalises property input', () => {
    expect(normalizePropertyInput('sc-domain:example.com')).toEqual({ property: 'sc-domain:example.com', guessed: false });
    expect(normalizePropertyInput('https://www.example.com/')).toEqual({ property: 'https://www.example.com/', guessed: false });
    expect(normalizePropertyInput('https://www.example.com')).toEqual({ property: 'https://www.example.com/', guessed: true });
    expect(normalizePropertyInput('www.Example.com')).toEqual({ property: 'sc-domain:example.com', guessed: true });
    expect(() => normalizePropertyInput('not a site')).toThrow(/not a Search Console property/);
  });
});

describe('the GitHub Action (6.7)', () => {
  it('is written next to the data folder, pinned to the exact version, with every guard', async () => {
    const c = capture();
    expect(await main(['setup', '--yes', '--github', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], c.deps)).toBe(0);
    const yml = await readFile(join(dir, '.github', 'workflows', 'searchtrace.yml'), 'utf8');
    expect(yml.split('\n')[0]).toBe('# Written by searchtrace 0.1.0. Runs daily and saves your search history to this PRIVATE repo.');
    expect(yml).toContain('run: npx -y searchtrace@0.1.0 run --ci --dir searchtrace-data');
    expect(yml).not.toContain('{{version}}');
    expect(yml).not.toMatch(/git add (-A|\.|--all)/);
    expect(yml).toContain('git add -- "$p"');
    expect(yml).toContain('concurrency:\n  group: searchtrace\n  cancel-in-progress: false');
    const steps = yml.split('\n      - ').slice(1);
    expect(steps[0]).toMatch(/^name: Refuse to run in a public repo/);
    expect(yml).toContain('--jq .private');
    // github.event never appears inside a run: block (it never appears at all).
    expect(yml).not.toContain('github.event');
    expect(c.stdout()).toContain('.github/workflows/searchtrace.yml');
  });

  it('substitutes a custom folder name and refuses to overwrite a foreign workflow', async () => {
    const custom = join(dir, 'seo-history');
    const path = await writeWorkflow(custom, '0.1.0');
    const yml = await readFile(path, 'utf8');
    expect(yml).toContain('--dir seo-history');
    expect(yml).toContain('cd seo-history');
    expect(yml).toContain('path: seo-history/reports/latest.html');
    expect(yml).not.toContain('searchtrace-data');
    await writeFile(path, 'name: something else\n');
    await expect(writeWorkflow(custom, '0.1.0')).rejects.toThrow(/wasn't written by searchtrace/);
    await expect(writeWorkflow(join(dir, 'bad name'), '0.1.0')).rejects.toThrow(/can't be used in a workflow file/);
  });
});

describe('setup wizard', () => {
  it('uses found credentials, picks the only site, and never runs without asking', async () => {
    const answers: Record<string, boolean | string> = {};
    const prompter: Prompter = {
      ask: vi.fn(async (q: string) => (q.includes('Pick 1, 2 or 3') ? '3' : '')),
      confirm: vi.fn(async (q: string) => {
        answers[q] = true;
        return q.startsWith('Try them?');
      }),
      close: () => undefined,
    };
    const c = capture({ prompter, stdinIsTTY: true, env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    expect(await main(['setup', '--dir', data], c.deps)).toBe(0);
    expect(c.stdout()).toContain(`I found Google credentials on this computer (service_account, ${key}).`);
    expect(c.stdout()).toContain('I can see 1 site: sc-domain:example.com');
    expect(Object.keys(answers)).toEqual(['Try them?', '  Turn on AI Overview checks?', 'Run it now?']);
    const cfg = await loadConfig(data);
    expect(cfg.property).toBe('sc-domain:example.com');
    expect(cfg.auth.credentialsFile).toBeUndefined();
    expect(c.stdout()).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('doctor', () => {
  async function fakeGraphify(withMcp: boolean): Promise<string> {
    const venv = join(dir, 'venv');
    const sp = join(venv, 'lib', 'python3.12', 'site-packages');
    await mkdir(join(sp, 'graphify'), { recursive: true });
    if (withMcp) await mkdir(join(sp, 'mcp'), { recursive: true });
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'graphify'), `#!${join(venv, 'bin', 'python')}\nprint("hi")\n`);
    await chmod(join(bin, 'graphify'), 0o755);
    return bin;
  }

  it('reports every check with a fix line, and warns about the read-write scope and the missing MCP extra', async () => {
    await writeConfig(data, { ...defaultConfig('sc-domain:example.com'), auth: { credentialsEnv: 'SEARCHTRACE_GOOGLE_KEY', credentialsFile: key } });
    m.auth.mockResolvedValueOnce({ kind: 'authorized_user', principal: 'user credential', scopes: ['https://www.googleapis.com/auth/webmasters'], headers: async () => ({}) });
    const ff = fakeFetch([{
      method: 'POST', url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      reply: { body: { inspectionResult: { indexStatusResult: { lastCrawlTime: '2026-10-04T23:22:42Z', coverageState: 'Submitted and indexed' } } } },
    }]);
    const bin = await fakeGraphify(false);
    const c = capture({ fetch: ff.fetch, env: { PATH: bin } });
    expect(await main(['doctor', '--dir', data], c.deps)).toBe(0);
    const out = c.stdout();
    expect(out).toContain('searchtrace doctor · ');
    expect(out).toContain('  ✓ Node 22.17.1 (needs 22.13 or newer)');
    expect(out).toContain('  ✓ Config valid (sc-domain:example.com)');
    expect(out).toContain(`  ✓ Google credential: authorized_user from ${key}`);
    expect(out).toContain('  ! This credential can change Search Console settings (webmasters scope). searchtrace only needs read access.');
    expect(out).toContain('  ✓ Search Console: can read sc-domain:example.com (siteFullUser)');
    expect(out).toContain('  ✓ URL Inspection: live check passed (https://example.com/ last crawled 4 Oct 2026)');
    expect(out).toContain('  ✓ Index checks used today: 1 of 200 (2,000 per property, shared with your other tools)');
    expect(out).toContain('  i AI Overview checks are off.');
    expect(out).toMatch(/ {2}✓ Folder writable · .* of history · no runs yet/);
    expect(out).toContain('  ✓ Key file is outside this folder and not in a git repo');
    expect(out).toContain('  ! graphify found but its MCP server is not installed. To ask your history in Claude:\n      uv tool install --force "graphifyy[mcp]"');
    expect(out).toContain(`-m graphify.serve "${join(data, 'graphify-out', 'graph.json')}"`);
    expect(out).toContain('  ✓ Brand words: example (suggested: none)');
    expect(ff.unmatched()).toEqual([]);
  });

  it('fails on an old Node, a missing config and a key inside the data folder', async () => {
    const c = capture({ nodeVersion: '20.11.0' });
    expect(await main(['doctor', '--dir', data, '--json'], c.deps)).toBe(2);
    const doc = JSON.parse(c.stdout());
    expect(doc.checks[0]).toEqual({
      status: 'fail', area: 'node', text: 'Node 20.11.0 is too old',
      fix: 'searchtrace needs Node 22.13 or newer (you have 20.11.0). Get it from nodejs.org.',
    });
    expect(doc.checks.find((x: { area: string }) => x.area === 'config').status).toBe('fail');

    await writeConfig(data, defaultConfig('sc-domain:example.com'));
    const inside = join(data, 'key.json');
    await writeFile(inside, '{}');
    await writeConfig(data, { ...defaultConfig('sc-domain:example.com'), auth: { credentialsEnv: 'X', credentialsFile: inside } });
    m.sites.mockResolvedValueOnce([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]);
    const k = capture();
    expect(await main(['doctor', '--dir', data], k.deps)).toBe(3);
    expect(k.stdout()).toContain('  ✗ The key file is inside the data folder, which you may commit\n    Move it to ~/.config/searchtrace/ and update auth.credentialsFile.');
    expect(k.stdout()).toContain('You typed sc-domain:example.com; your property is https://example.com/.');
  });
});
