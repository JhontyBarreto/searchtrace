// setup (--yes and the wizard), the Action template it writes (6.7, 6.8), and doctor (6.4.4).
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainWith as main } from '../../src/cli/main.js';
import type { CliDeps, Prompter } from '../../src/cli/prompt.js';
import { normalizePropertyInput, repoReady, writeWorkflow } from '../../src/cli/commands/setup.js';
import { scrubForSharing } from '../../src/cli/commands/doctor.js';
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
vi.mock('../../src/sources/google/auth.js', async (orig) => ({ ...(await orig<typeof import('../../src/sources/google/auth.js')>()), loadGoogleAuth: m.auth, listSites: m.sites }));
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
  const SHA = 'a'.repeat(40);
  const pins = (yml: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const x of yml.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@(\S+)/g)) m.set(x[1], x[2]);
    return m;
  };

  it('is written next to the data folder, builds searchtrace from GitHub at a fixed commit, and splits secrets from the push token', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    const c = capture();
    expect(await main(['setup', '--yes', '--github', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], c.deps)).toBe(0);
    const yml = await readFile(join(dir, '.github', 'workflows', 'searchtrace.yml'), 'utf8');
    expect(yml.split('\n')[0]).toBe('# Written by searchtrace 0.1.0. Runs daily and saves your search history to this PRIVATE repo.');
    // Never the npm registry name: the tool is checked out from GitHub and built from its lockfile.
    expect(yml).not.toMatch(new RegExp('npx\\s+(-y\\s+)?' + 'searchtrace'));
    expect(yml).toContain('repository: JhontyBarreto/searchtrace');
    // Running from src/ there is no build-info.json, so the version tag is the fallback pin.
    expect(yml).toContain('ref: "v0.1.0"');
    expect(yml).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(yml).toContain('run: node .searchtrace-tool/dist/bin.js run --ci --dir searchtrace-data');
    expect(yml).not.toMatch(/\{\{(version|ref)\}\}/);
    expect(yml).not.toMatch(/git add (-A|\.|--all)/);
    expect(yml).toContain('git add -- "$p"');
    expect(yml).toContain('concurrency:\n  group: searchtrace\n  cancel-in-progress: false');
    // Three jobs: the guard, a read-only job with the secrets, and a write job with no secrets.
    expect(yml).toContain('permissions: {}');
    const job = (name: string): string => {
      const at = yml.indexOf(`\n  ${name}:\n`);
      const next = yml.slice(at + 3).search(/\n {2}[a-z]+:\n/);
      return next < 0 ? yml.slice(at) : yml.slice(at, at + 3 + next);
    };
    expect(job('guard')).toContain('name: Refuse to run in a public repo');
    expect(job('guard')).toContain('--jq .private');
    expect(job('collect')).toContain('needs: guard');
    expect(job('collect')).toContain('contents: read');
    expect(job('collect')).not.toContain('contents: write');
    expect(job('collect')).toContain('SEARCHTRACE_GOOGLE_KEY');
    expect(job('collect').match(/persist-credentials: false/g)).toHaveLength(2);
    expect(job('save')).toContain('contents: write');
    expect(job('save')).not.toContain('secrets.');
    expect(job('save')).not.toMatch(/\bnpm\b|\bnpx\b|\bnode\b/);
    // Gated on the run job, so nothing after a failed guard ever runs.
    expect(job('save')).toContain("if: always() && needs.collect.result != 'skipped'");
    // Every run starts from the branch tip, not the commit it was queued on, and the save job commits
    // on top of the commit the run started from, then rebases onto the tip (a note pushed meanwhile survives).
    expect(job('collect')).toContain('ref: ${{ github.ref }}');
    expect(job('save')).toContain('ref: ${{ needs.collect.outputs.base || github.ref }}');
    expect(job('save')).toContain('git rebase --quiet FETCH_HEAD');
    // A conflicting save never wedges: abort the rebase, then park the data on its own branch.
    expect(job('save')).toContain('git rebase --abort || true');
    expect(job('save')).toContain('searchtrace-unsaved-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT');
    // Commits are made as GitHub's own Actions bot, an account nobody can register.
    expect(yml).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(yml).not.toContain('searchtrace@users.noreply');
    // Every action pinned to a full commit SHA.
    for (const line of yml.split('\n').filter((l) => /uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
    // github.event never appears inside a run: block (it never appears at all).
    expect(yml).not.toContain('github.event');
    expect(c.stdout()).toContain('.github/workflows/searchtrace.yml');
    // The package ships without docs/, so the pointer is a full URL.
    expect(c.stdout()).toContain('See https://github.com/JhontyBarreto/searchtrace/blob/main/docs/GITHUB-ACTION.md.');
    expect(c.stdout()).not.toContain('See docs/');
    expect(await readFile(join(data, '.gitattributes'), 'utf8')).toBe('ledger/** merge=union\nannotations.ndjson merge=union\n');
  });

  it('pins the exact commit a build knows, and the same action SHAs as this repo\'s CI', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    const yml = await readFile(await writeWorkflow(data, '0.1.0', { commit: SHA }), 'utf8');
    expect(yml).toContain(`ref: "${SHA}"`);
    await expect(writeWorkflow(data, '0.1.0', { commit: 'v0.1.0; rm -rf /' })).rejects.toThrow(/Unexpected commit/);
    const ci = await readFile(join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const ours = pins(yml);
    const theirs = pins(ci);
    expect(theirs.size).toBeGreaterThan(0);
    for (const [action, sha] of theirs) if (ours.has(action)) expect(`${action}@${ours.get(action)}`).toBe(`${action}@${sha}`);
  });

  it('substitutes a custom folder name and refuses to overwrite a foreign workflow', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    const custom = join(dir, 'seo-history');
    const path = await writeWorkflow(custom, '0.1.0');
    const yml = await readFile(path, 'utf8');
    expect(yml).toContain('--dir seo-history');
    expect(yml).toContain('cd seo-history');
    expect(yml).toContain('path: seo-history/reports/latest.html');
    expect(yml).toContain('-- seo-history >');
    expect(yml).not.toContain('searchtrace-data');
    await writeFile(path, 'name: something else\n');
    await expect(writeWorkflow(custom, '0.1.0')).rejects.toThrow(/wasn't written by searchtrace/);
    await expect(writeWorkflow(join(dir, 'bad name'), '0.1.0')).rejects.toThrow(/can't be used in a workflow file/);
  });

  it('refuses --github when the data folder is not at the top of a git repo, before writing anything', async () => {
    expect(repoReady(data)).toBe(false);
    const c = capture();
    expect(await main(['setup', '--yes', '--github', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], c.deps)).toBe(2);
    expect(c.stderr()).toContain("isn't the top of a git repo");
    expect(c.stderr()).toContain('Create a private repo on GitHub, clone it');
    expect(existsSync(join(data, 'config.json'))).toBe(false);
    expect(existsSync(join(dir, '.github'))).toBe(false);
    // Deeper inside a repo is no better: GitHub only reads workflows at the root.
    await mkdir(join(dir, '.git'), { recursive: true });
    expect(repoReady(join(dir, 'sub', 'searchtrace-data'))).toBe(false);
    expect(repoReady(data)).toBe(true);
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
    expect(c.stdout()).toContain(`I found a robot account key on this computer (${key}).`);
    expect(c.stdout()).toContain('I can see 1 site: sc-domain:example.com');
    expect(Object.keys(answers)).toEqual(['Try them?', '  Turn on AI Overview checks?', 'Run it now?']);
    const cfg = await loadConfig(data);
    expect(cfg.property).toBe('sc-domain:example.com');
    expect(cfg.auth.credentialsFile).toBeUndefined();
    expect(c.stdout()).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('setup wizard, for people who are not developers', () => {
  type Asked = { q: string; d?: string | boolean };
  function scripted(answers: [RegExp, string | boolean][]): { prompter: Prompter; asked: Asked[] } {
    const asked: Asked[] = [];
    const pick = (q: string): string | boolean | undefined => answers.find(([re]) => re.test(q))?.[1];
    return {
      asked,
      prompter: {
        ask: vi.fn(async (q: string, o?: { defaultValue?: string }) => {
          asked.push({ q, d: o?.defaultValue });
          const a = pick(q);
          return typeof a === 'string' ? a : o?.defaultValue ?? '';
        }),
        confirm: vi.fn(async (q: string, d: boolean) => {
          asked.push({ q, d });
          const a = pick(q);
          return typeof a === 'boolean' ? a : d;
        }),
        close: () => undefined,
      },
    };
  }

  it('names a gcloud sign-in in plain words, says it cannot read Search Console, and falls into the menu on a scope error', async () => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.config', 'gcloud'), { recursive: true });
    await writeFile(join(home, '.config', 'gcloud', 'application_default_credentials.json'), JSON.stringify({
      type: 'authorized_user', client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com', client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty', refresh_token: '1//refresh-token-abc',
    }));
    m.auth.mockRejectedValueOnce(new StError('auth', 'This credential (user credential) was not granted Search Console access (list properties).', 'Use a robot account.'));
    const s1 = scripted([[/^Try them\?/, true], [/^Pick 1, 2 or 3/, '2']]);
    const c = capture({ prompter: s1.prompter, stdinIsTTY: true });
    expect(await main(['setup', '--dir', data], c.deps)).toBe(3);
    const out = c.stdout();
    expect(out).toContain('I found a Google sign-in from gcloud on this computer (~/.config/gcloud/application_default_credentials.json).');
    expect(out).toContain("It's gcloud's own sign-in, which Google never lets read Search Console");
    // gcloud's default sign-in is offered with No as the default.
    expect(s1.asked.find((a) => a.q.startsWith('Try them?'))?.d).toBe(false);
    // The scope error is shown, then the menu, not a dead end.
    expect(out).toContain("That didn't work: This credential (user credential) was not granted Search Console access");
    expect(s1.asked.some((a) => a.q.startsWith('Pick 1, 2 or 3'))).toBe(true);
    expect(out).toContain('--client-id-file=<your OAuth client json>');
    expect(existsSync(join(data, 'config.json'))).toBe(false);
  });

  it('defaults "Keep it running?" to Not now outside a git repo, and never writes a workflow there', async () => {
    const s1 = scripted([[/^Try them\?/, true], [/^ {2}Pick 1, 2 or 3/, '1'], [/^Run it now\?/, false]]);
    const c = capture({ prompter: s1.prompter, stdinIsTTY: true, env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    expect(await main(['setup', '--dir', data], c.deps)).toBe(0);
    expect(s1.asked.find((a) => a.q.startsWith('  Pick 1, 2 or 3'))?.d).toBe('3');
    expect(c.stdout()).toContain('1. GitHub Actions (for developers: needs a private GitHub repo and a robot key)');
    expect(c.stdout()).toContain("isn't the top of a git repo, so GitHub would never see the workflow. Nothing was written for it.");
    expect(existsSync(join(dir, '.github'))).toBe(false);
    // Inside a repo with a robot key, GitHub Actions is the default again.
    await mkdir(join(dir, '.git'), { recursive: true });
    const s2 = scripted([[/Set it up again\?/, true], [/^Try them\?/, true], [/^Run it now\?/, false]]);
    const d = capture({ prompter: s2.prompter, stdinIsTTY: true, env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    expect(await main(['setup', '--dir', data], d.deps)).toBe(0);
    expect(s2.asked.find((a) => a.q.startsWith('  Pick 1, 2 or 3'))?.d).toBe('1');
    expect(existsSync(join(dir, '.github', 'workflows', 'searchtrace.yml'))).toBe(true);
    // The cost of getting started is in the AI Overview pitch.
    expect(d.stdout()).toContain('smallest top-up is $50');
    expect(d.stdout()).toContain('Each qualifying search is checked once a week');
    expect(d.stdout()).not.toContain('usually cents a month');
    expect(d.stdout()).toContain(`add the secret SEARCHTRACE_GOOGLE_KEY with the contents of ${key}.`);
  });

  it('refuses GitHub Actions for a personal sign-in', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    m.auth.mockResolvedValueOnce({ kind: 'authorized_user', principal: 'me@example.com', scopes: [], headers: async () => ({}) });
    const s1 = scripted([[/^Try them\?/, true], [/^ {2}Pick 1, 2 or 3/, '1'], [/^Run it now\?/, false]]);
    const c = capture({ prompter: s1.prompter, stdinIsTTY: true, env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    expect(await main(['setup', '--dir', data], c.deps)).toBe(0);
    expect(s1.asked.find((a) => a.q.startsWith('  Pick 1, 2 or 3'))?.d).toBe('3');
    expect(c.stdout()).toContain('GitHub Actions needs a robot account key, not a personal Google sign-in.');
    expect(existsSync(join(dir, '.github'))).toBe(false);
  });

  it('prints a cron line with absolute paths and a log, never npx', async () => {
    const s1 = scripted([[/^Try them\?/, true], [/^ {2}Pick 1, 2 or 3/, '2'], [/^Run it now\?/, false]]);
    const c = capture({ prompter: s1.prompter, stdinIsTTY: true, env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    expect(await main(['setup', '--dir', data], c.deps)).toBe(0);
    const line = c.stdout().split('\n').find((l) => l.includes('17 6 * * *')) ?? '';
    expect(line).toContain(`"${process.execPath}" "`);
    expect(line).toContain(`run --dir "${data}" --quiet >> "${join(data, 'state', 'cron.log')}" 2>&1`);
    expect(line).not.toMatch(/\bnpx\b/);
    expect(existsSync(join(data, 'state'))).toBe(true);
  });

  it('copies a robot key and only offers to delete the original by default when it sits in Downloads', async () => {
    for (const [folder, wantDefault] of [['Documents', false], ['Downloads', true]] as const) {
      const home = join(dir, 'home');
      const src = join(home, folder, 'robot.json');
      await mkdir(join(home, folder), { recursive: true });
      await writeFile(src, JSON.stringify({ type: 'service_account', client_email: ROBOT, private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }));
      const s1 = scripted([[/Set it up again\?/, true], [/^Try them\?/, false], [/^Pick 1, 2 or 3/, '1'], [/Paste the path/, src], [/Delete the original/, false], [/^Run it now\?/, false]]);
      const c = capture({ prompter: s1.prompter, stdinIsTTY: true });
      expect(await main(['setup', '--dir', data], c.deps)).toBe(0);
      const del = s1.asked.find((a) => a.q.includes('Delete the original'));
      expect(del?.q).toBe(`  Delete the original at ~/${folder}/robot.json? The copy above is the one searchtrace uses.`);
      expect(del?.d).toBe(wantDefault);
      // config.json holds a home-relative path, so committing it doesn't publish the username.
      expect((await loadConfig(data)).auth.credentialsFile).toBe('~/.config/searchtrace/google-key.json');
    }
  });
});

describe('setup --yes paths', () => {
  it('stores a key under home as ~/..., so a committed config.json carries no username', async () => {
    const home = join(dir, 'home');
    const k = join(home, 'keys', 'robot.json');
    await mkdir(join(home, 'keys'), { recursive: true });
    await writeFile(k, await readFile(key, 'utf8'));
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', '~/keys/robot.json'], c.deps)).toBe(0);
    expect((await loadConfig(data)).auth.credentialsFile).toBe('~/keys/robot.json');
    // A key outside home keeps its full path, with a note.
    const d = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--credentials', key], d.deps)).toBe(0);
    expect((await loadConfig(data)).auth.credentialsFile).toBe(key);
    expect(d.stdout()).toContain(`Note: config.json will hold the full path ${key}.`);
  });

  it('warns about a Restricted user during setup, with the opt-out', async () => {
    m.sites.mockResolvedValueOnce([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' }]);
    const c = capture();
    expect(await main(['setup', '--yes', '--dir', data, '--property', 'sc-domain:example.com', '--credentials', key], c.deps)).toBe(0);
    expect(c.stdout()).toContain('Warning: this is a Restricted user.');
    expect(c.stdout()).toContain('"inspection": {"enabled": false}');
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
    expect(out).toContain("  ✓ Index checks used today: 1 of searchtrace's 200 (Google allows 2,000 a day per property, shared with your other tools)");
    expect(out).toContain('  i AI Overview checks are off.');
    // The cost of getting started is said up front, not just the per-check price.
    expect(out).toContain('$1 free to try, then a $50 minimum top-up that never expires');
    expect(out).toContain('Run `searchtrace setup --dataforseo`');
    expect(out).toMatch(/ {2}✓ Folder writable · .* of history · no runs yet/);
    expect(out).toContain('  ✓ Key file is outside this folder and not in a git repo');
    // An optional extra is information, not a warning.
    expect(out).toContain('  i Optional: graphify is installed but not its MCP server. To ask your history in Claude, run:\n      uv tool install --force "graphifyy[mcp]"\n      (or: pipx install --force "graphifyy[mcp]")');
    expect(out).toContain(`-m graphify.serve "${join(data, 'graphify-out', 'graph.json')}"`);
    // Before the first run there is nothing to suggest from yet, so it doesn't claim "none".
    expect(out).toContain('  ✓ Brand words: example (more suggestions after the first run)');
    expect(ff.unmatched()).toEqual([]);
  });

  it('warns about a key file in a git repo unless that repo ignores it', async () => {
    const repo = join(dir, 'tools');
    const repoKey = join(repo, 'creds', 'token.json');
    await mkdir(join(repo, '.git', 'info'), { recursive: true });
    await mkdir(join(repo, 'creds'), { recursive: true });
    await writeFile(repoKey, '{}');
    await writeConfig(data, { ...defaultConfig('sc-domain:example.com'), auth: { credentialsEnv: 'X', credentialsFile: repoKey }, inspection: { ...defaultConfig('sc-domain:example.com').inspection, enabled: false } });
    const tracked = capture();
    await main(['doctor', '--dir', data], tracked.deps);
    expect(tracked.stdout()).toContain('  ! The key file is inside a git repository, where it could be committed by mistake');

    await writeFile(join(repo, '.gitignore'), '# secrets\n*.log\ntoken.json\n');
    const ignored = capture();
    await main(['doctor', '--dir', data], ignored.deps);
    expect(ignored.stdout()).toContain('  ✓ Key file is outside this folder, and the git repo it sits in ignores it (.gitignore)');

    // A later '!' rule re-includes it, so the warning comes back.
    await writeFile(join(repo, 'creds', '.gitignore'), '!token.json\n');
    const reincluded = capture();
    await main(['doctor', '--dir', data], reincluded.deps);
    expect(reincluded.stdout()).toContain('  ! The key file is inside a git repository');

    // A folder rule covers the file too.
    await rm(join(repo, 'creds', '.gitignore'));
    await writeFile(join(repo, '.gitignore'), 'creds/\n');
    const folder = capture();
    await main(['doctor', '--dir', data], folder.deps);
    expect(folder.stdout()).toContain('ignores it (.gitignore)');
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
  it('accepts --credentials, as its own fix line says', async () => {
    await writeConfig(data, { ...defaultConfig('sc-domain:example.com'), inspection: { ...defaultConfig('sc-domain:example.com').inspection, enabled: false } });
    const c = capture();
    expect(await main(['doctor', '--dir', data, '--credentials', key], c.deps)).toBe(0);
    expect(c.stdout()).toContain(`Google credential: service_account from ${key}`);
    expect(m.auth.mock.calls.at(-1)?.[0]).toMatchObject({ credentialsOverride: key });
    const missing = capture();
    m.auth.mockRejectedValueOnce(new StError('auth', 'The credential file passed with --credentials does not exist: nope.json', 'Run `searchtrace setup`, or pass --credentials <file>.'));
    expect(await main(['doctor', '--dir', data, '--credentials', 'nope.json'], missing.deps)).toBe(3);
    expect(missing.stderr()).not.toContain("Unknown option '--credentials'");
  });

  it('does not warn about a ~ key path that sits outside the git repo it is run from', async () => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.config', 'searchtrace'), { recursive: true });
    await writeFile(join(home, '.config', 'searchtrace', 'google-key.json'), '{}');
    // The Action-repo case: doctor run from inside a clone, with the key in ~/.config outside it.
    const repo = join(dir, 'repo');
    const repoData = join(repo, 'searchtrace-data');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeConfig(repoData, { ...defaultConfig('sc-domain:example.com'), auth: { credentialsEnv: 'X', credentialsFile: '~/.config/searchtrace/google-key.json' }, inspection: { ...defaultConfig('sc-domain:example.com').inspection, enabled: false } });
    const c = capture({ cwd: repo });
    await main(['doctor', '--dir', repoData], c.deps);
    expect(c.stdout()).not.toContain('inside a git repository');
    expect(c.stdout()).toContain('Key file is outside this folder');
  });

  it('--share hides the property, robot, folders and balance, but keeps the property type readable', async () => {
    const robot = 'searchtrace@acme-seo-4471.iam.gserviceaccount.com';
    await writeConfig(data, { ...defaultConfig('sc-domain:secretclient-lawfirm.com'), inspection: { ...defaultConfig('sc-domain:secretclient-lawfirm.com').inspection, enabled: false } });
    m.auth.mockResolvedValueOnce({ kind: 'service_account', principal: robot, scopes: [], headers: async () => ({}) });
    m.sites.mockResolvedValueOnce([]);
    const c = capture({ env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    await main(['doctor', '--dir', data, '--share', '--json'], c.deps);
    const out = c.stdout();
    for (const leak of ['secretclient-lawfirm', 'secretclientlawfirm', robot, 'acme-seo-4471', data, join(dir, 'home')]) expect(out).not.toContain(leak);
    expect(out).toContain('sc-domain:example.com');
    expect(out).toContain('<robot>@<project>.iam.gserviceaccount.com');
    expect(out).toContain('<data folder>');
    expect(JSON.parse(out).version).toBe('0.1.0');
    // Plain --json is unchanged for scripts.
    const plain = capture({ env: { PATH: '', GOOGLE_APPLICATION_CREDENTIALS: key } });
    m.auth.mockResolvedValueOnce({ kind: 'service_account', principal: robot, scopes: [], headers: async () => ({}) });
    await main(['doctor', '--dir', data, '--json'], plain.deps);
    expect(plain.stdout()).toContain('secretclient-lawfirm.com');
  });

  it('scrubs longest values first, in one pass', () => {
    const text = 'robot@proj-1.iam.gserviceaccount.com can\'t see sc-domain:pipewell-plumbing.example (https://www.pipewell-plumbing.example/) in /home/me/data; brand pipewell';
    const out = scrubForSharing(text, {
      dir: '/home/me/data', home: '/home/me',
      run: { checks: [], config: defaultConfig('sc-domain:pipewell-plumbing.example'), principal: 'robot@proj-1.iam.gserviceaccount.com', brandWords: ['pipewell'] },
    });
    expect(out).toBe("<robot>@<project>.iam.gserviceaccount.com can't see sc-domain:example.com (https://www.example.com/) in <data folder>; brand <brand>");
  });
});

