// Setup wizard and non-interactive `setup --yes` (6.8). Owner: WP-F.
//
// The wizard only runs on a terminal. `setup --yes --property P [--credentials F] [--dataforseo
// --monthly-budget X --max-per-run Y] [--github]` does the same without prompts, and on an
// existing config merges the flags into it instead of replacing it. URLs are printed, never
// opened (searchtrace never starts other programs). A key is copied only in the wizard's robot path, to
// ~/.config/searchtrace/ with mode 0600, and never into the data folder or a git repo.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, defaultConfig, loadConfig, writeConfig } from '../../core/config.js';
import { ExitCode, StError } from '../../core/errors.js';
import { cli, docUrl, expandHome, homeRelative, runsFromNpxCache, toolCommit } from '../../core/install.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { siteDomainOf } from '../../core/url.js';
import type { Config, GoogleAuth, SecretRegistry } from '../../core/types.js';
import { toolVersion, instantOf } from '../../pipeline/context.js';
import { GCLOUD_DEFAULT_CLIENT_ID, listSites, loadGoogleAuth } from '../../sources/google/auth.js';
import { MIN_COST_PER_CHECK, planningPrice } from '../../sources/dataforseo/budget.js';
import { layout } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { credentialSource, gitRootOf } from './doctor.js';
import { demoCommand } from './demo.js';
import { runCommand } from './run.js';
import { displayPath, out, parseFlags, printError, requirePrompter, resolveDeps, resolveDir, type CliDeps, type Prompter } from '../prompt.js';

// Built by concatenation so the repo lint rule about the console global never trips on a URL.
const CLOUD = `https://${'console'}.cloud.google.com`;
const PROPERTY_RE = /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+\/)$/;
const FOLDER_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DATA_GITIGNORE = 'state/\n*.tmp-*\ngraphify-out/*\n!graphify-out/graph.json\n!graphify-out/searchtrace.meta.json\n';
// Ledgers only ever gain lines, so a run saved from this computer and one from the Action merge cleanly.
const DATA_GITATTRIBUTES = 'ledger/** merge=union\nannotations.ndjson merge=union\n';
const COMMIT_RE = /^[0-9a-f]{40}$/;
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

/**
 * True when the data folder sits at the top of a git working tree: GitHub only reads
 * .github/workflows at the repo root, and the workflow runs from there.
 */
export function repoReady(dir: string): boolean {
  const root = gitRootOf(join(resolve(dir), 'x'));
  return root !== null && resolve(root) === dirname(resolve(dir));
}

const NOT_A_REPO_FIX = 'Create a private repo on GitHub, clone it, and run setup with --github --dir <clone>/searchtrace-data from there.';

/**
 * Writes .github/workflows/searchtrace.yml next to the data folder (6.7). searchtrace itself is
 * checked out at `commit` (the commit this build was made from), or at the version tag when the
 * build doesn't know its commit, and built from its lockfile: never fetched from npm by name.
 */
export async function writeWorkflow(dir: string, version: string, o: { commit?: string | null } = {}): Promise<string> {
  const folder = basename(dir);
  if (!FOLDER_RE.test(folder)) {
    throw new StError('config', `The data folder name "${folder}" can't be used in a workflow file.`, 'Use a folder name with only letters, digits, dots, dashes and underscores.');
  }
  if (!VERSION_RE.test(version)) throw new StError('internal', `Unexpected version "${version}".`);
  const commit = o.commit === undefined ? toolCommit() : o.commit;
  if (commit !== null && !COMMIT_RE.test(commit)) throw new StError('internal', `Unexpected commit "${commit}".`);
  if (!repoReady(dir)) {
    throw new StError('config', `${dirname(resolve(dir))} isn't the top of a git repo, so GitHub would never see the workflow.`, NOT_A_REPO_FIX);
  }
  let text = readFileSync(new URL('../../../assets/workflow.yml.tmpl', import.meta.url), 'utf8')
    .split('{{version}}').join(version)
    .split('{{ref}}').join(commit ?? `v${version}`);
  if (folder !== 'searchtrace-data') text = text.split('searchtrace-data').join(folder);
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
  if (!(await store.exists('.gitattributes'))) await store.writeFileAtomic('.gitattributes', DATA_GITATTRIBUTES);
}

/** The key path to save in config.json: "~/..." under home, so a committed config doesn't carry your username. */
function keyPathForConfig(abs: string, deps: CliDeps): string {
  const shown = homeRelative(abs, deps.homedir);
  if (shown === abs) deps.stdout.write(`Note: config.json will hold the full path ${abs}. It is committed if you use the GitHub Action.\n`);
  return shown;
}

function checkKeyPath(path: string, dir: string, deps: CliDeps): string {
  const abs = resolve(deps.cwd, expandHome(path, deps.homedir));
  if (!existsSync(abs)) throw new StError('config', `Can't find the key file ${abs}.`, `Check the path, or run \`${cli('setup')}\` without --credentials to be walked through it.`);
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

function nextSteps(deps: CliDeps, dir: string, github: string | null, keyFile: string | null): void {
  const dirArg = dir === join(deps.cwd, 'searchtrace-data') ? '' : ` --dir ${displayPath(deps.cwd, dir)}`;
  if (github) {
    out(deps, `Wrote ${displayPath(deps.cwd, github)}.`);
    const shown = keyFile ? homeRelative(keyFile, deps.homedir) : null;
    const source = shown ? `the contents of ${shown}` : 'the robot key JSON';
    out(deps, `Next: make the repo private and add the secret SEARCHTRACE_GOOGLE_KEY with ${source}.`);
    if (shown && process.platform === 'darwin') out(deps, `      On a Mac, \`pbcopy < ${shown}\` copies it.`);
    out(deps, "      Commit the data folder's config.json, meta.json, .gitignore and .gitattributes plus the workflow, then click");
    out(deps, `      "Run workflow". See ${docUrl('GITHUB-ACTION.md')}.`);
  }
  out(deps, `Check everything with: ${cli('doctor')}${dirArg}`);
  out(deps, `Run it with:           ${cli('run')}${dirArg}`);
}

async function setupYes(v: Values, deps: CliDeps, secrets: SecretRegistry): Promise<number> {
  const dir = resolveDir(v.dir, deps);
  const existing = existsSync(join(dir, layout.config)) ? await loadConfig(dir) : null;
  const input = v.property ?? existing?.property;
  if (!input) {
    throw new StError('config', 'Tell setup which Search Console property to use.', `For example: ${cli('setup --yes --property sc-domain:example.com --credentials key.json')}`);
  }
  const wanted = normalizePropertyInput(input);
  const keyPath = v.credentials ? checkKeyPath(v.credentials, dir, deps) : undefined;
  const base = existing ?? defaultConfig(wanted.property);
  let config: Config = {
    ...base,
    property: wanted.property,
    auth: { ...base.auth, ...(keyPath ? { credentialsFile: keyPathForConfig(keyPath, deps) } : {}) },
    serp: serpFrom(v, base),
  };
  try {
    const auth = await loadGoogleAuth({ config, env: deps.env, fetch: deps.fetch, secrets, ...(keyPath ? { credentialsOverride: keyPath } : {}) });
    const ok = await confirmProperty(auth, wanted, deps);
    config = { ...config, property: ok.property };
    out(deps, `I can see ${ok.property} (${ok.permission}).`);
    if (ok.note) out(deps, ok.note);
    if (ok.permission === 'siteRestrictedUser') warnRestricted(deps);
    if (wanted.guessed && ok.property !== input) out(deps, `You typed ${input}; your property is ${ok.property}.`);
  } catch (e) {
    if (e instanceof StError && (e.code === 'config' || e.code === 'permission')) throw e;
    const err = e instanceof StError ? e : null;
    deps.stderr.write(`Couldn't check the property with Google yet: ${secrets.redact(err?.message ?? (e as Error)?.message ?? String(e))}\n`);
    if (err?.fix) deps.stderr.write(`${secrets.redact(err.fix)}\n`);
    deps.stderr.write(`Saving the settings anyway. Run \`${cli('doctor')}\` once access works.\n`);
  }
  config = ConfigSchema.parse(config);
  // Checked before anything is written, so a --github that can't work leaves no half setup behind.
  if (v.github && !repoReady(dir)) {
    throw new StError('config', `${dirname(resolve(dir))} isn't the top of a git repo, so GitHub would never see the workflow.`, NOT_A_REPO_FIX);
  }
  await writeConfig(dir, config);
  await ensureDataFolder(dir, config, deps, secrets);
  out(deps, `${existing ? 'Updated' : 'Saved'} your settings in ${join(dir, layout.config)}.`);
  const github = v.github ? await writeWorkflow(dir, toolVersion()) : null;
  nextSteps(deps, dir, github, keyPath ?? null);
  return ExitCode.OK;
}

function warnRestricted(deps: CliDeps): void {
  out(deps, 'Warning: this is a Restricted user. Restricted users may not be allowed to inspect URLs, so the daily run could fail at');
  out(deps, '  the index checks. Change the permission to Full in Search Console, or set "inspection": {"enabled": false}');
  out(deps, '  in config.json to skip index checks (reports will then lack crawl dates).');
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
    // Yes by default only for the risky case, a key left in Downloads; a key kept elsewhere was put there on purpose.
    const inDownloads = isInside(src, join(deps.homedir, 'Downloads'));
    if (resolve(src) !== resolve(target) &&
      (await p.confirm(`  Delete the original at ${homeRelative(src, deps.homedir)}? The copy above is the one searchtrace uses.`, inDownloads))) {
      await rm(src, { force: true });
    }
    return { path: target, email: key.client_email };
  }
  throw new StError('config', 'No usable key file was given.', `Run \`${cli('setup')}\` again when you have the JSON key from step 3.`);
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

/** What a found credential file is, in plain words, and whether it's gcloud's own sign-in (which can't read Search Console). */
function describeCredential(path: string | null): { words: string; kind: 'service_account' | 'authorized_user' | 'unknown'; gcloudDefault: boolean } {
  if (!path) return { words: 'a Google key in an environment variable', kind: 'unknown', gcloudDefault: false };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { type?: string; client_id?: string };
    if (j.type === 'service_account') return { words: 'a robot account key', kind: 'service_account', gcloudDefault: false };
    const gcloudDefault = typeof j.client_id === 'string' && j.client_id === GCLOUD_DEFAULT_CLIENT_ID;
    return { words: gcloudDefault ? 'a Google sign-in from gcloud' : 'a Google sign-in', kind: 'authorized_user', gcloudDefault };
  } catch {
    return { words: 'a credential file searchtrace could not read', kind: 'unknown', gcloudDefault: false };
  }
}

type Site = { siteUrl: string; permissionLevel: string };

/** Loads a found credential and lists its sites. A refusal prints why and returns null, so the menu can offer the robot path. */
async function tryFound(base: Config, deps: CliDeps, secrets: SecretRegistry): Promise<{ auth: GoogleAuth; sites: Site[] } | null> {
  try {
    const auth = await loadGoogleAuth({ config: base, env: deps.env, fetch: deps.fetch, secrets });
    return { auth, sites: await listSites(auth, deps.fetch) };
  } catch (e) {
    if (!(e instanceof StError) || !['auth', 'permission', 'reauth_required'].includes(e.code)) throw e;
    out(deps, `  That didn't work: ${secrets.redact(e.message)}`);
    if (e.fix) out(deps, secrets.redact(e.fix).split('\n').map((l) => `  ${l}`).join('\n'));
    out(deps, '');
    return null;
  }
}

/** The cron line for this install: absolute Node and searchtrace paths, so cron's bare PATH can't break it. */
async function printCron(deps: CliDeps, dir: string, config: Config): Promise<void> {
  if (process.platform === 'win32') {
    out(deps, `  Windows has no cron. Run ${cli('run')} --dir "${dir}" --quiet daily with Task Scheduler instead, or pick the GitHub Action.`);
    return;
  }
  const node = process.execPath;
  const bin = fileURLToPath(new URL('../../bin.js', import.meta.url));
  if ([dir, node, bin].some((x) => /[%"$`\\\n]/.test(x))) {
    out(deps, '  A path here has a character a cron line can\'t carry (%, ", $, ` or \\). Move the data folder, then run setup again.');
    return;
  }
  if (runsFromNpxCache()) {
    out(deps, "  This copy runs from npx's cache, which npm can clear at any time, so a cron line would stop working.");
    out(deps, '  Install searchtrace first (see the README), then run setup again to get the line.');
    return;
  }
  await mkdir(join(dir, 'state'), { recursive: true });
  const log = join(dir, 'state', 'cron.log');
  out(deps, '  Add this line with `crontab -e`:');
  out(deps, `    17 6 * * * "${node}" "${bin}" run --dir "${dir}" --quiet >> "${log}" 2>&1`);
  out(deps, `  It uses the Node in ${dirname(node)}. Run setup again if you remove or switch Node versions.`);
  if (config.serp.provider === 'dataforseo') {
    out(deps, `  cron doesn't see ${config.serp.loginEnv} and ${config.serp.passwordEnv} from your shell. Add them as NAME=value lines`);
    out(deps, '  above the schedule in the crontab, or AI Overview checks will stop.');
  }
  if (process.platform === 'darwin') {
    out(deps, '  On a Mac, a data folder in Documents, Desktop, Downloads or iCloud needs Full Disk Access for cron');
    out(deps, '  (System Settings > Privacy & Security).');
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
  let auth: GoogleAuth | null = null;
  let sites: Site[] | null = null;
  // The robot key the GitHub secret should hold, for the next-steps line.
  let robotFile: string | null = keyPath ?? null;
  if (!keyPath) {
    const found = credentialSource(base, deps.env, deps.homedir, null, deps.cwd);
    const about = found ? describeCredential(found.path) : null;
    let tried = false;
    if (found && about) {
      // A home-relative label is the well-known gcloud path, shown with forward slashes on every OS.
      const shown = found.label.replace(deps.homedir, '~');
      out(deps, `I found ${about.words} on this computer (${shown.startsWith('~') ? shown.split(sep).join('/') : shown}).`);
      if (about.gcloudDefault) {
        out(deps, "  It's gcloud's own sign-in, which Google never lets read Search Console, so it won't work here.");
      }
      if (await p.confirm('Try them?', !about.gcloudDefault)) {
        tried = true;
        const got = await tryFound(base, deps, secrets);
        if (got) {
          ({ auth, sites } = got);
          if (about.kind === 'service_account') robotFile = found.path;
        }
      }
    }
    if (!auth) {
      out(deps, 'How should searchtrace read your Search Console data?');
      out(deps, '  1. Robot account (recommended, about 6 minutes, keeps working on a schedule)');
      out(deps, '  2. I already use gcloud on this computer');
      out(deps, '  3. Show me a demo first');
      const choice = (await p.ask('Pick 1, 2 or 3:', { defaultValue: '1' })).trim();
      if (choice === '3') return demoCommand([], deps);
      if (choice === '2') {
        const got = found && !tried && !about?.gcloudDefault ? await tryFound(base, deps, secrets) : null;
        if (!got) {
          out(deps, `Sign in once with your own OAuth client (gcloud's own sign-in can't read Search Console):\n  ${REAUTH_HELP}`);
          out(deps, `then run setup again. The steps are in ${docUrl('SETUP.md')} (option 2).`);
          return ExitCode.AUTH;
        }
        ({ auth, sites } = got);
      } else {
        const k = await robotKey(p, deps, secrets, dir);
        keyPath = k.path;
        robotFile = k.path;
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
  let config: Config = { ...base, auth: { ...base.auth, ...(keyPath ? { credentialsFile: keyPathForConfig(keyPath, deps) } : {}) } };
  auth ??= await loadGoogleAuth({ config, env: deps.env, fetch: deps.fetch, secrets, ...(keyPath ? { credentialsOverride: keyPath } : {}) });
  sites ??= robot ? await waitForSites(auth, deps) : await listSites(auth, deps.fetch);
  config = { ...config, property: await pickProperty(p, deps, sites, v.property ?? existing?.property) };
  if (sites.find((x) => x.siteUrl === config.property)?.permissionLevel === 'siteRestrictedUser') {
    warnRestricted(deps);
    if (await p.confirm('  Skip index checks for now?', false)) config = { ...config, inspection: { ...config.inspection, enabled: false } };
  }

  const price = planningPrice(config.serp.provider === 'dataforseo' ? config.serp.costPerCheckUsd : MIN_COST_PER_CHECK);
  out(deps, '\nOptional. Check for AI Overviews (paid, through DataForSEO)');
  out(deps, "  Search Console can't tell you whether an AI Overview showed above you.");
  out(deps, '  searchtrace can check your searches using DataForSEO.');
  out(deps, `    Each qualifying search is checked once a week at up to $${price}, so 100 searches is about $${(price * 100 * 4.3).toFixed(2)} a month.`);
  out(deps, '    Spending stops at the monthly cap you set below.');
  out(deps, `    DataForSEO gives new accounts $1 free (about ${Math.floor(1 / price)} checks). After that you pay in advance, and their`);
  out(deps, '    smallest top-up is $50. It never expires, and at the default $1 a month cap it lasts over four years.');
  out(deps, '    Your login stays in environment variables (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD), never in files.');
  out(deps, "  I'll check Google in the country where most of your impressions come from.");
  if (v.dataforseo || (await p.confirm('  Turn on AI Overview checks?', false))) {
    const monthly = money(v['monthly-budget'] ?? (await p.ask('  Monthly spending cap', { defaultValue: '$1.00' })), 'monthly-budget');
    const perRun = money(v['max-per-run'] ?? (await p.ask('  Most per run', { defaultValue: '$0.30' })), 'max-per-run');
    config = { ...config, serp: serpFrom({ ...v, dataforseo: true, 'monthly-budget': String(monthly), 'max-per-run': String(perRun) }, config) };
  }

  // GitHub Actions only works with a robot key (never a personal sign-in) and a data folder at the top of a repo.
  const robotKind = auth.kind === 'service_account';
  const ready = repoReady(dir);
  out(deps, '\nKeep it running?');
  out(deps, '  searchtrace gets smarter every day. From today it records your page changes, when Google');
  out(deps, "  recrawls them, Google's updates and (if on) AI Overviews. Search Console alone forgets");
  out(deps, '  everything after 16 months.');
  out(deps, '    1. GitHub Actions (for developers: needs a private GitHub repo and a robot key): writes .github/workflows/searchtrace.yml');
  out(deps, "    2. This computer's schedule: prints a cron line to copy");
  out(deps, '    3. Not now');
  let keep = v.github ? '1' : (await p.ask('  Pick 1, 2 or 3:', { defaultValue: robotKind && ready ? '1' : '3' })).trim();
  if (keep === '1' && !robotKind) {
    out(deps, '  GitHub Actions needs a robot account key, not a personal Google sign-in. Run setup again and pick 1. Robot account.');
    keep = '3';
  } else if (keep === '1' && !ready) {
    out(deps, `  ${dirname(resolve(dir))} isn't the top of a git repo, so GitHub would never see the workflow. Nothing was written for it.`);
    out(deps, `  ${NOT_A_REPO_FIX}`);
    keep = '3';
  }

  config = ConfigSchema.parse(config);
  await writeConfig(dir, config);
  await ensureDataFolder(dir, config, deps, secrets);
  let github: string | null = null;
  if (keep === '1') github = await writeWorkflow(dir, toolVersion());
  if (keep === '2') await printCron(deps, dir, config);
  out(deps, '');
  nextSteps(deps, dir, github, robotFile);
  out(deps, '\nDone. The first run takes about 10 minutes on a small site: roughly 4 minutes downloading 16 months of');
  out(deps, 'Search Console data, 3 to 4 minutes reading your pages and 3 minutes of index checks. A bigger site takes');
  out(deps, 'longer. After that a daily run takes seconds.');
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
