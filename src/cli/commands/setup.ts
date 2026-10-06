// Setup wizard and non-interactive `setup --yes` (6.8). Owner: WP-F.
//
// The wizard only runs on a terminal. `setup --yes --property P [--credentials F] [--dataforseo
// --monthly-budget X --max-per-run Y] [--github]` does the same without prompts, and on an
// existing config merges the flags into it instead of replacing it. URLs are printed, never
// opened (searchtrace never starts other programs). A key is copied only in the wizard's robot path, to
// ~/.config/searchtrace/ with mode 0600, and never into the data folder or a git repo.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigSchema, defaultConfig, loadConfig, writeConfig } from '../../core/config.js';
import { ExitCode, StError } from '../../core/errors.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { siteDomainOf } from '../../core/url.js';
import type { Config, GoogleAuth, SecretRegistry } from '../../core/types.js';
import { toolVersion, instantOf } from '../../pipeline/context.js';
import { listSites, loadGoogleAuth } from '../../sources/google/auth.js';
import { layout } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { credentialSource } from './doctor.js';
import { demoCommand } from './demo.js';
import { runCommand } from './run.js';
import { out, parseFlags, printError, requirePrompter, resolveDeps, resolveDir, type CliDeps, type Prompter } from '../prompt.js';

// Built by concatenation so the repo lint rule about the console global never trips on a URL.
const CLOUD = `https://${'console'}.cloud.google.com`;
const PROPERTY_RE = /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+\/)$/;
const FOLDER_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DATA_GITIGNORE = 'state/\n*.tmp-*\ngraphify-out/*\n!graphify-out/graph.json\n!graphify-out/searchtrace.meta.json\n';
const WORKFLOW_MARK = '# Written by searchtrace';
const REAUTH_HELP = 'gcloud auth application-default login --client-id-file=<your OAuth client json> \\\n' +
  '    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform';

const SETUP_OPTIONS = {
  dir: { type: 'string' },
  property: { type: 'string' },
  credentials: { type: 'string' },
  dataforseo: { type: 'boolean' },
  'monthly-budget': { type: 'string' },
  'max-per-run': { type: 'string' },
  github: { type: 'boolean' },
  yes: { type: 'boolean' },
  ci: { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parseFlags<typeof SETUP_OPTIONS>>['values'];

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** "seoengico.com", "https://x.com" or a real property name, as a property name. */
export function normalizePropertyInput(input: string): { property: string; guessed: boolean } {
  const t = input.trim();
  if (PROPERTY_RE.test(t)) return { property: t, guessed: false };
  if (/^https?:\/\/[^\s/]+$/i.test(t)) return { property: `${t.toLowerCase()}/`, guessed: true };
  const domain = t.replace(/^sc-domain:/i, '').replace(/^www\./i, '').toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { property: `sc-domain:${domain}`, guessed: true };
  throw new StError('config', `"${input}" is not a Search Console property name.`,
    'Use sc-domain:example.com for a Domain property, or the full URL with a trailing slash (https://www.example.com/) for a URL-prefix property.');
}

function money(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new StError('config', `--${name} must be a dollar amount from 0 to 100 (got "${v}").`, `For example: --${name} 1`);
  return n;
}

/** Writes .github/workflows/searchtrace.yml next to the data folder, pinned to this exact version (6.7). */
export async function writeWorkflow(dir: string, version: string): Promise<string> {
  const folder = basename(dir);
  if (!FOLDER_RE.test(folder)) {
    throw new StError('config', `The data folder name "${folder}" can't be used in a workflow file.`, 'Use a folder name with only letters, digits, dots, dashes and underscores.');
  }
  if (!VERSION_RE.test(version)) throw new StError('internal', `Unexpected version "${version}".`);
  let text = readFileSync(new URL('../../../assets/workflow.yml.tmpl', import.meta.url), 'utf8').split('{{version}}').join(version);
  if (folder !== 'searchtrace-data') {
    text = text.split('--dir searchtrace-data').join(`--dir ${folder}`).split('cd searchtrace-data').join(`cd ${folder}`)
      .split('path: searchtrace-data/').join(`path: ${folder}/`);
  }
  const target = join(dirname(resolve(dir)), '.github', 'workflows', 'searchtrace.yml');
  if (existsSync(target)) {
    const current = await readFile(target, 'utf8');
    if (!current.startsWith(WORKFLOW_MARK)) {
      throw new StError('config', `${target} already exists and wasn't written by searchtrace.`, 'Move it away or delete it, then run setup --github again.');
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return target;
}

/** meta.json and the data folder's .gitignore, written once. */
async function ensureDataFolder(dir: string, config: Config, deps: CliDeps, secrets: SecretRegistry): Promise<void> {
  const store = await openStore(dir, secrets);
  if (!(await store.exists(layout.meta))) {
    const meta = { schema: 1, property: config.property, createdAt: instantOf(deps.clock.now()), toolVersion: toolVersion() };
    await store.writeFileAtomic(layout.meta, `${JSON.stringify(meta, null, 2)}\n`);
  }
  if (!(await store.exists('.gitignore'))) await store.writeFileAtomic('.gitignore', DATA_GITIGNORE);
}

function checkKeyPath(path: string, dir: string, deps: CliDeps): string {
  const abs = resolve(deps.cwd, expandHome(path, deps.homedir));
  if (!existsSync(abs)) throw new StError('config', `Can't find the key file ${abs}.`, 'Check the path, or run `npx searchtrace setup` without --credentials to be walked through it.');
  if (isInside(abs, dir)) {
    throw new StError('config', 'The key file is inside the data folder, which you may commit.', 'Move it to ~/.config/searchtrace/ and point --credentials at the new place.');
  }
  return abs;
}

function serpFrom(v: Values, base: Config): Config['serp'] {
  const monthly = money(v['monthly-budget'], 'monthly-budget');
  const perRun = money(v['max-per-run'], 'max-per-run');
  const current = base.serp;
  if (!v.dataforseo && current.provider !== 'dataforseo') return current;
  const prev = current.provider === 'dataforseo' ? current : null;
  return {
    provider: 'dataforseo',
    loginEnv: prev?.loginEnv ?? 'DATAFORSEO_LOGIN',
    passwordEnv: prev?.passwordEnv ?? 'DATAFORSEO_PASSWORD',
    monthlyBudgetUsd: monthly ?? prev?.monthlyBudgetUsd ?? 1,
    maxPerRunUsd: perRun ?? prev?.maxPerRunUsd ?? 0.3,
    costPerCheckUsd: prev?.costPerCheckUsd ?? 0.0012,
    ...(prev?.locationCode !== undefined ? { locationCode: prev.locationCode } : {}),
    ...(prev?.languageCode !== undefined ? { languageCode: prev.languageCode } : {}),
  };
}

/** Checks the property against sites.list. Returns the property to use, or throws with the right fix. */
async function confirmProperty(auth: GoogleAuth, wanted: { property: string; guessed: boolean }, deps: CliDeps): Promise<{ property: string; permission: string; note: string | null }> {
  const sites = await listSites(auth, deps.fetch);
  const domainNote = 'A "Domain" property covers http, https, www and subdomains. Using it.';
  const exact = sites.find((s) => s.siteUrl === wanted.property);
  if (exact) {
    const note = wanted.guessed && exact.siteUrl.startsWith('sc-domain:') ? domainNote : null;
    return { property: exact.siteUrl, permission: exact.permissionLevel, note };
  }
  const domain = siteDomainOf(wanted.property);
  const same = sites.filter((s) => siteDomainOf(s.siteUrl) === domain).sort((a, b) => (a.siteUrl.startsWith('sc-domain:') ? -1 : b.siteUrl.startsWith('sc-domain:') ? 1 : 0));
  if (same.length && wanted.guessed) {
    const pick = same[0];
    const note = pick.siteUrl.startsWith('sc-domain:') ? domainNote : null;
    return { property: pick.siteUrl, permission: pick.permissionLevel, note };
  }
  if (same.length) {
    throw new StError('config', `${wanted.property} is not one of the properties ${auth.principal} can see.`, `You typed ${wanted.property}; your property is ${same[0].siteUrl}.`);
  }
  throw new StError('permission', `${auth.principal} can't see ${wanted.property} in Search Console.`,
    `Add ${auth.principal} as a user on ${wanted.property} in Search Console > Settings > Users and permissions.`);
}

function nextSteps(deps: CliDeps, dir: string, github: string | null): void {
  const dirArg = dir === join(deps.cwd, 'searchtrace-data') ? '' : ` --dir ${relative(deps.cwd, dir) || '.'}`;
  if (github) {
    out(deps, `Wrote ${relative(deps.cwd, github) || github}.`);
    out(deps, 'Next: make the repo private, add the secret SEARCHTRACE_GOOGLE_KEY (paste the key JSON), commit config.json and the workflow, then click "Run workflow". See docs/GITHUB-ACTION.md.');
  }
  out(deps, `Check everything with: npx searchtrace doctor${dirArg}`);
  out(deps, `Run it with:           npx searchtrace run${dirArg}`);
}

async function setupYes(v: Values, deps: CliDeps, secrets: SecretRegistry): Promise<number> {
  const dir = resolveDir(v.dir, deps);
  const existing = existsSync(join(dir, layout.config)) ? await loadConfig(dir) : null;
  const input = v.property ?? existing?.property;
  if (!input) {
    throw new StError('config', 'Tell setup which Search Console property to use.', 'For example: npx searchtrace setup --yes --property sc-domain:example.com --credentials key.json');
  }
  const wanted = normalizePropertyInput(input);
  const keyPath = v.credentials ? checkKeyPath(v.credentials, dir, deps) : undefined;
  const base = existing ?? defaultConfig(wanted.property);
  let config: Config = {
    ...base,
    property: wanted.property,
    auth: { ...base.auth, ...(keyPath ? { credentialsFile: keyPath } : {}) },
    serp: serpFrom(v, base),
  };
  try {
    const auth = await loadGoogleAuth({ config, env: deps.env, fetch: deps.fetch, secrets, ...(keyPath ? { credentialsOverride: keyPath } : {}) });
    const ok = await confirmProperty(auth, wanted, deps);
    config = { ...config, property: ok.property };
    out(deps, `I can see ${ok.property} (${ok.permission}).`);
    if (ok.note) out(deps, ok.note);
    if (wanted.guessed && ok.property !== input) out(deps, `You typed ${input}; your property is ${ok.property}.`);
  } catch (e) {
    if (e instanceof StError && (e.code === 'config' || e.code === 'permission')) throw e;
    const err = e instanceof StError ? e : null;
    deps.stderr.write(`Couldn't check the property with Google yet: ${secrets.redact(err?.message ?? (e as Error)?.message ?? String(e))}\n`);
    if (err?.fix) deps.stderr.write(`${secrets.redact(err.fix)}\n`);
    deps.stderr.write('Saving the settings anyway. Run `npx searchtrace doctor` once access works.\n');
  }
  config = ConfigSchema.parse(config);
  await writeConfig(dir, config);
  await ensureDataFolder(dir, config, deps, secrets);
  out(deps, `${existing ? 'Updated' : 'Saved'} your settings in ${join(dir, layout.config)}.`);
  const github = v.github ? await writeWorkflow(dir, toolVersion()) : null;
  nextSteps(deps, dir, github);
  return ExitCode.OK;
}

// ---------- the wizard ----------

const ROBOT_STEPS = {
  one: ['Step 1 of 4. Create a free Google Cloud project (no card needed)',
    `  Open ${CLOUD}/projectcreate`,
    '  Name it "searchtrace", click Create, then press Enter here.', '',
    '  Using a company Google Workspace account? If step 3 says "Service account key creation is',
    '  disabled", do steps 1 to 3 signed in with a personal Gmail instead. The robot still gets',
    '  access to your site in step 4.'],
  two: ['Step 2 of 4. Turn on the Search Console API',
    `  Open ${CLOUD}/apis/library/searchconsole.googleapis.com`,
    '  Check the project at the top says "searchtrace", click Enable, then press Enter.'],
  three: ['Step 3 of 4. Create the robot and download its key',
    `  Open ${CLOUD}/iam-admin/serviceaccounts`,
    '  Create service account > name it searchtrace > Done (skip the roles).',
    '  Click it > Keys > Add key > Create new key > JSON > Create.',
    '  Treat the downloaded file like a password.', ''],
};

async function robotKey(p: Prompter, deps: CliDeps, secrets: SecretRegistry, dir: string): Promise<{ path: string; email: string }> {
  out(deps, ROBOT_STEPS.one.join('\n'));
  await p.ask('');
  out(deps, ROBOT_STEPS.two.join('\n'));
  await p.ask('');
  out(deps, ROBOT_STEPS.three.join('\n'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await p.ask('  Paste the path to the downloaded file (or drag it into this window):\n  >')).trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
    const src = resolve(deps.cwd, expandHome(raw, deps.homedir));
    let key: { type?: string; client_email?: string; private_key?: string };
    try {
      key = JSON.parse(await readFile(src, 'utf8'));
    } catch {
      out(deps, "  I couldn't read a JSON key at that path. Try again.");
      continue;
    }
    secrets.add(key.private_key);
    if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
      out(deps, "  That file isn't a service-account key. Download the JSON key from step 3 and try again.");
      continue;
    }
    const folder = join(deps.homedir, '.config', 'searchtrace');
    const target = join(folder, 'google-key.json');
    if (isInside(target, dir)) throw new StError('config', 'Refusing to save the key inside the data folder.', 'Pick a data folder outside ~/.config/searchtrace.');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700).catch(() => undefined);
    await writeFile(target, await readFile(src), { mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);
    out(deps, `  Saved a copy to ${target.replace(deps.homedir, '~')} (only you can read it).`);
    if (resolve(src) !== resolve(target) && (await p.confirm('  Delete the one in Downloads?', true))) await rm(src, { force: true });
    return { path: target, email: key.client_email };
  }
  throw new StError('config', 'No usable key file was given.', 'Run `npx searchtrace setup` again when you have the JSON key from step 3.');
}

async function waitForSites(auth: GoogleAuth, deps: CliDeps): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  out(deps, '  Waiting for access (checking every 5 seconds, Ctrl+C to stop)...');
  for (let i = 0; i < 120; i++) {
    try {
      const sites = await listSites(auth, deps.fetch);
      if (sites.length) return sites;
    } catch {
      // keep waiting: Google can take a minute to apply a new user
    }
    await deps.sleep(5000);
  }
  throw new StError('permission', `${auth.principal} still can't see any site after 10 minutes.`,
    `Add ${auth.principal} as a user in Search Console > Settings > Users and permissions, then run setup again.`);
}

async function pickProperty(p: Prompter, deps: CliDeps, sites: { siteUrl: string; permissionLevel: string }[], flag: string | undefined): Promise<string> {
  const usable = sites.filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  if (flag) {
    const want = normalizePropertyInput(flag);
    const hit = usable.find((s) => s.siteUrl === want.property) ?? usable.find((s) => want.guessed && siteDomainOf(s.siteUrl) === siteDomainOf(want.property));
    if (hit) return hit.siteUrl;
  }
  if (usable.length === 1) {
    out(deps, `  I can see 1 site: ${usable[0].siteUrl}`);
    if (usable[0].siteUrl.startsWith('sc-domain:')) out(deps, '  A "Domain" property covers http, https, www and subdomains. Using it.');
    return usable[0].siteUrl;
  }
  if (!usable.length) throw new StError('permission', 'No Search Console sites are visible to this credential.', 'Add it as a user on your site in Search Console, then run setup again.');
  out(deps, `  I can see ${usable.length} sites:`);
  usable.forEach((s, i) => out(deps, `    ${i + 1}. ${s.siteUrl}`));
  for (;;) {
    const n = Number(await p.ask('  Which one?', { defaultValue: '1' }));
    if (Number.isInteger(n) && n >= 1 && n <= usable.length) return usable[n - 1].siteUrl;
  }
}

async function wizard(v: Values, deps: CliDeps, secrets: SecretRegistry): Promise<number> {
  const p = requirePrompter(deps);
  const dir = resolveDir(v.dir, deps);
  out(deps, `searchtrace ${toolVersion().replace(/\.0$/, '')}\n`);
  out(deps, "Let's find out why your Google traffic changed.");
  out(deps, 'searchtrace talks only to Google, to your own website (to notice page changes), and to');
  out(deps, 'DataForSEO if you add a login later. No account, no tracking.\n');
  const existing = existsSync(join(dir, layout.config)) ? await loadConfig(dir) : null;
  if (existing && !(await p.confirm(`There is already a setup for ${existing.property} in ${dir}. Set it up again?`, false))) return ExitCode.OK;

  const base = existing ?? defaultConfig(v.property ? normalizePropertyInput(v.property).property : 'sc-domain:example.com');
  let keyPath: string | undefined = v.credentials ? checkKeyPath(v.credentials, dir, deps) : undefined;
  let robot = false;
  if (!keyPath) {
    const found = credentialSource(base, deps.env, deps.homedir);
    let use = false;
    if (found) {
      let kind = 'credential';
      if (found.path) {
        try {
          const t = (JSON.parse(readFileSync(found.path, 'utf8')) as { type?: string }).type;
          kind = t === 'service_account' ? 'service_account' : 'authorized_user';
        } catch {
          kind = 'unreadable file';
        }
      }
      out(deps, `I found Google credentials on this computer (${kind}, ${found.label.replace(deps.homedir, '~')}).`);
      use = await p.confirm('Try them?', true);
    }
    if (!use) {
      out(deps, 'How should searchtrace read your Search Console data?');
      out(deps, '  1. Robot account (recommended, about 6 minutes, keeps working on a schedule)');
      out(deps, '  2. I already use gcloud on this computer');
      out(deps, '  3. Show me a demo first');
      const choice = (await p.ask('Pick 1, 2 or 3:', { defaultValue: '1' })).trim();
      if (choice === '3') return demoCommand([], deps);
      if (choice === '2') {
        if (!found) {
          out(deps, `Sign in once with:\n  ${REAUTH_HELP}\nthen run setup again.`);
          return ExitCode.AUTH;
        }
      } else {
        const k = await robotKey(p, deps, secrets, dir);
        keyPath = k.path;
        robot = true;
        out(deps, '\nStep 4 of 4. Let the robot read your site in Search Console');
        out(deps, `  Robot email:\n    ${k.email}`);
        out(deps, '  Open https://search.google.com/search-console/users');
        out(deps, '  Pick your site, click "Add user", paste the email, choose Permission: Full, click Add.');
        out(deps, "  (Full lets it check when Google last crawled each page. It can't change anything.");
        out(deps, '  You must be an Owner of the site to add users.)\n');
      }
    }
  }
  let config: Config = { ...base, auth: { ...base.auth, ...(keyPath ? { credentialsFile: keyPath } : {}) } };
  const auth = await loadGoogleAuth({ config, env: deps.env, fetch: deps.fetch, secrets, ...(keyPath ? { credentialsOverride: keyPath } : {}) });
  const sites = robot ? await waitForSites(auth, deps) : await listSites(auth, deps.fetch);
  config = { ...config, property: await pickProperty(p, deps, sites, v.property ?? existing?.property) };

  out(deps, '\nOptional. Check for AI Overviews (costs money, usually cents a month)');
  out(deps, "  Search Console can't tell you whether an AI Overview showed above you.");
  out(deps, '  searchtrace can check your searches using DataForSEO.');
  out(deps, '    Each check costs at most $0.0012. A small site typically uses $0.05 to $0.30 a month.');
  out(deps, '    Your login stays in environment variables (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD), never in files.');
  out(deps, "  I'll check Google in the country where most of your impressions come from.");
  if (v.dataforseo || (await p.confirm('  Turn on AI Overview checks?', false))) {
    const monthly = money(v['monthly-budget'] ?? (await p.ask('  Monthly spending cap', { defaultValue: '$1.00' })), 'monthly-budget');
    const perRun = money(v['max-per-run'] ?? (await p.ask('  Most per run', { defaultValue: '$0.30' })), 'max-per-run');
    config = { ...config, serp: serpFrom({ ...v, dataforseo: true, 'monthly-budget': String(monthly), 'max-per-run': String(perRun) }, config) };
  }

  out(deps, '\nKeep it running?');
  out(deps, '  searchtrace gets smarter every day. From today it records your page changes, when Google');
  out(deps, "  recrawls them, Google's updates and (if on) AI Overviews. Search Console alone forgets");
  out(deps, '  everything after 16 months.');
  out(deps, '    1. GitHub Actions (free, private repo, recommended): writes .github/workflows/searchtrace.yml');
  out(deps, "    2. This computer's schedule: prints a cron line to copy");
  out(deps, '    3. Not now');
  const keep = v.github ? '1' : (await p.ask('  Pick 1, 2 or 3:', { defaultValue: '1' })).trim();

  config = ConfigSchema.parse(config);
  await writeConfig(dir, config);
  await ensureDataFolder(dir, config, deps, secrets);
  let github: string | null = null;
  if (keep === '1') github = await writeWorkflow(dir, toolVersion());
  if (keep === '2') {
    out(deps, '  Add this line with `crontab -e`:');
    out(deps, `    17 6 * * * cd "${deps.cwd}" && npx -y searchtrace@${toolVersion()} run --dir "${dir}" --quiet`);
  }
  out(deps, '');
  nextSteps(deps, dir, github);
  out(deps, '\nDone. Your first run takes about 5 minutes for 16 months of history.');
  if (await p.confirm('Run it now?', true)) return runCommand(['--dir', dir], deps);
  return ExitCode.OK;
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function setupCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const secrets = createSecretRegistry({ ci: false });
  try {
    const { values: v } = parseFlags(args, SETUP_OPTIONS, 'setup');
    const interactive = !v.yes && !v.ci && deps.prompter !== null && deps.stdinIsTTY;
    return interactive ? await wizard(v, deps, secrets) : await setupYes(v, deps, secrets);
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
