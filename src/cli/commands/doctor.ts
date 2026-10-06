// Doctor checks with one-line fixes (6.4.4). Owner: WP-F.
//
// One line per check: ✓ ok, ! warning, ✗ failure (followed by its fix), i information.
// graphify is found by reading the shebang of the `graphify` executable on PATH; nothing is spawned.
import { constants as fsc, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { ExitCode, StError } from '../../core/errors.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { ptDate } from '../../core/time.js';
import { defaultOrigins, siteDomainOf } from '../../core/url.js';
import type { Config, GoogleAuth, SecretRegistry } from '../../core/types.js';
import { requestJson } from '../../http/request.js';
import { buildBrandMatcher } from '../../analyze/brand.js';
import { fmtBytes, fmtDate, fmtInt, fmtMoney } from '../../report/format.js';
import { listSites, loadGoogleAuth } from '../../sources/google/auth.js';
import { layout } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { out, parseFlags, printError, resolveDeps, resolveDir, type CliDeps } from '../prompt.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface Check { status: CheckStatus; area: 'node' | 'config' | 'auth' | 'gsc' | 'inspect' | 'serp' | 'folder' | 'key' | 'graphify' | 'brand'; text: string; fix?: string }

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', info: 'i' };
const RW_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const DFS_USER_DATA = 'https://api.dataforseo.com/v3/appendix/user_data';
const SETUP_FIX = 'Run `npx searchtrace setup`, or pass --credentials <file>.';
const MOVE_KEY_FIX = 'Move it to ~/.config/searchtrace/ and update auth.credentialsFile.';

export interface CredentialSource { kind: 'file' | 'env'; label: string; path: string | null }

/** Which credential loadGoogleAuth will pick (4.8 order, without --credentials), for display and the key-location check. */
export function credentialSource(config: Config, env: Record<string, string | undefined>, home: string, override?: string | null): CredentialSource | null {
  if (override) return { kind: 'file', label: override, path: override };
  if (config.auth.credentialsFile) return { kind: 'file', label: config.auth.credentialsFile, path: config.auth.credentialsFile };
  const envName = config.auth.credentialsEnv;
  if (env[envName]) return { kind: 'env', label: `the ${envName} environment variable`, path: null };
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac) return { kind: 'file', label: gac, path: gac };
  const adc = process.platform === 'win32' && env.APPDATA
    ? join(env.APPDATA, 'gcloud', 'application_default_credentials.json')
    : join(home, '.config', 'gcloud', 'application_default_credentials.json');
  return existsSync(adc) ? { kind: 'file', label: adc, path: adc } : null;
}

/** The working-tree root (the folder holding .git) that contains path, or null. */
function gitRootOf(path: string): string | null {
  let dir = dirname(resolve(path));
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** A gitignore glob as a RegExp over a slash-separated relative path. Supports *, ?, ** and [classes]. */
function gitGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close > i) {
        re += `[${glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = close;
      } else re += '\\[';
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether git would ignore path, from the .gitignore files between the repo root and the file plus
 * .git/info/exclude. A simplified reading of gitignore rules (last match wins, '!' re-includes,
 * a trailing '/' matches folders only, a pattern with a '/' is anchored to its .gitignore's folder).
 * Read-only: nothing is spawned.
 */
function ignoredByGit(path: string, root: string): boolean {
  const abs = resolve(path);
  const sources: { base: string; file: string }[] = [{ base: root, file: join(root, '.git', 'info', 'exclude') }];
  const parts = relative(root, dirname(abs)).split(sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const base = join(root, ...parts.slice(0, i));
    sources.push({ base, file: join(base, '.gitignore') });
  }
  let ignored = false;
  for (const { base, file } of sources) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(base, abs).split(sep).join('/');
    const segs = rel.split('/');
    // Candidate paths: every ancestor folder (for folder rules) and the file itself.
    const candidates = segs.map((_, k) => ({ path: segs.slice(0, k + 1).join('/'), isDir: k < segs.length - 1 }));
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes('/');
      const re = gitGlob(line.replace(/^\//, ''));
      const hit = candidates.some((c) => (!dirOnly || c.isDir) && (anchored ? re.test(c.path) : re.test(c.path.split('/').pop() ?? '')));
      if (hit) ignored = !negate;
    }
  }
  return ignored;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The graphify executable on PATH and the Python from its shebang, plus whether the MCP extra is installed. */
export async function findGraphify(env: Record<string, string | undefined>): Promise<{ exe: string; python: string | null; mcp: boolean } | null> {
  const names = process.platform === 'win32' ? ['graphify.exe', 'graphify.cmd', 'graphify'] : ['graphify'];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const exe = join(dir, name);
      try {
        await access(exe, process.platform === 'win32' ? fsc.F_OK : fsc.X_OK);
      } catch {
        continue;
      }
      let python: string | null = null;
      try {
        const fh = await open(exe, 'r');
        try {
          const buf = Buffer.alloc(512);
          const { bytesRead } = await fh.read(buf, 0, 512, 0);
          const first = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0];
          const m = /^#!\s*(\S+)/.exec(first);
          python = m && !/\/env$/.test(m[1]) ? m[1] : null;
        } finally {
          await fh.close();
        }
      } catch {
        python = null;
      }
      return { exe, python, mcp: python ? hasMcpExtra(python) : false };
    }
  }
  return null;
}

function hasMcpExtra(python: string): boolean {
  const root = dirname(dirname(python));
  const candidates: string[] = [join(root, 'Lib', 'site-packages')];
  try {
    for (const d of readdirSync(join(root, 'lib'))) if (d.startsWith('python')) candidates.push(join(root, 'lib', d, 'site-packages'));
  } catch {
    // no lib folder
  }
  return candidates.some((sp) => existsSync(join(sp, 'graphify')) && existsSync(join(sp, 'mcp')));
}

function dirSize(path: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const e of entries) {
      if (p === path && (e === 'state' || e === '.git')) continue;
      const abs = join(p, e);
      try {
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else total += st.size;
      } catch {
        // vanished
      }
    }
  };
  walk(path);
  return total;
}

interface Ctx { deps: CliDeps; dir: string; secrets: SecretRegistry; checks: Check[]; config: Config | null; auth: GoogleAuth | null }

const add = (c: Ctx, check: Check): void => {
  c.checks.push(check);
};

async function checkCredential(c: Ctx, cfg: Config): Promise<CredentialSource | null> {
  const src = credentialSource(cfg, c.deps.env, c.deps.homedir);
  try {
    c.auth = await loadGoogleAuth({ config: cfg, env: c.deps.env, fetch: c.deps.fetch, secrets: c.secrets });
    const from = src?.label ?? c.auth.source;
    add(c, { status: 'ok', area: 'auth', text: `Google credential: ${c.auth.kind}${from ? ` from ${from}` : ''}` });
    if (c.auth.scopes.includes(RW_SCOPE)) {
      add(c, { status: 'warn', area: 'auth', text: 'This credential can change Search Console settings (webmasters scope). searchtrace only needs read access.' });
    }
  } catch (e) {
    const err = e instanceof StError ? e : null;
    add(c, { status: 'fail', area: 'auth', text: `Google credential: ${err?.message ?? (e as Error)?.message ?? String(e)}`, fix: err?.fix ?? SETUP_FIX });
  }
  return src;
}

async function checkSearchConsole(c: Ctx, cfg: Config, auth: GoogleAuth): Promise<boolean> {
  try {
    const sites = await listSites(auth, c.deps.fetch);
    const site = sites.find((s) => s.siteUrl === cfg.property);
    if (site) {
      if (site.permissionLevel === 'siteUnverifiedUser') {
        add(c, { status: 'fail', area: 'gsc', text: `Search Console: ${auth.principal} is not a verified user of ${cfg.property}`, fix: `Add ${auth.principal} as a user on ${cfg.property} in Search Console > Settings > Users and permissions.` });
        return false;
      }
      add(c, { status: 'ok', area: 'gsc', text: `Search Console: can read ${cfg.property} (${site.permissionLevel})` });
      if (site.permissionLevel === 'siteRestrictedUser') {
        add(c, { status: 'warn', area: 'gsc', text: 'Restricted users may not be allowed to inspect URLs.', fix: 'Change the permission to Full.' });
      }
      return true;
    }
    const domain = siteDomainOf(cfg.property);
    const near = sites.find((s) => siteDomainOf(s.siteUrl) === domain);
    add(c, near
      ? { status: 'fail', area: 'gsc', text: `Search Console: ${cfg.property} is not one of your properties`, fix: `You typed ${cfg.property}; your property is ${near.siteUrl}.` }
      : { status: 'fail', area: 'gsc', text: `Search Console: ${auth.principal} can't see ${cfg.property}`, fix: `Add ${auth.principal} as a user on ${cfg.property} in Search Console > Settings > Users and permissions.` });
    return false;
  } catch (e) {
    const err = e instanceof StError ? e : null;
    add(c, { status: 'fail', area: 'gsc', text: `Search Console: ${err?.message ?? (e as Error)?.message ?? String(e)}`, fix: err?.fix });
    return false;
  }
}

interface InspectReply { inspectionResult?: { indexStatusResult?: { lastCrawlTime?: string; coverageState?: string } }; error?: { message?: string; status?: string } }

async function checkInspection(c: Ctx, cfg: Config, auth: GoogleAuth): Promise<void> {
  const url = cfg.siteOrigin ?? defaultOrigins(cfg.property)[0];
  try {
    const res = await requestJson<InspectReply>(c.deps.fetch, {
      url: INSPECT_URL, method: 'POST', headers: await auth.headers(), body: { inspectionUrl: url, siteUrl: cfg.property, languageCode: 'en-US' },
      timeoutMs: 30_000, idempotent: true, retry: { attempts: 2, baseMs: 1000, capMs: 4000, on: [500, 502, 503, 504] },
    });
    try {
      const store = await openStore(c.dir, c.secrets);
      const now = c.deps.clock.now();
      await store.append('inspect', { ptDay: ptDate(now), count: 1, runId: 'doctor', at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') });
    } catch {
      // quota accounting is best effort for doctor
    }
    if (res.status === 403) {
      add(c, { status: 'fail', area: 'inspect', text: 'URL Inspection: this robot is not allowed to inspect URLs', fix: 'Change the permission to Full.' });
      return;
    }
    if (res.status === 429) {
      add(c, { status: 'warn', area: 'inspect', text: "URL Inspection: today's checks for this property are used up. Try again tomorrow." });
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      add(c, { status: 'fail', area: 'inspect', text: `URL Inspection: Google answered HTTP ${res.status}${res.data?.error?.message ? ` (${res.data.error.message})` : ''}` });
      return;
    }
    const idx = res.data?.inspectionResult?.indexStatusResult;
    const crawled = idx?.lastCrawlTime ? ` last crawled ${fmtDate(ptDate(idx.lastCrawlTime))}` : idx?.coverageState ? ` ${idx.coverageState}` : '';
    add(c, { status: 'ok', area: 'inspect', text: `URL Inspection: live check passed (${url}${crawled})` });
  } catch (e) {
    const err = e instanceof StError ? e : null;
    add(c, { status: 'fail', area: 'inspect', text: `URL Inspection: ${err?.message ?? (e as Error)?.message ?? String(e)}`, fix: err?.fix });
  }
}

async function checkQuotaAndSpend(c: Ctx, cfg: Config): Promise<void> {
  let usedToday = 0;
  let monthSpend = 0;
  const now = c.deps.clock.now();
  try {
    const store = await openStore(c.dir, c.secrets);
    const today = ptDate(now);
    for (const r of await store.readLedger<{ ptDay?: string; count?: number }>('inspect')) if (r.ptDay === today) usedToday += Number(r.count) || 0;
    const month = now.toISOString().slice(0, 7);
    for (const r of await store.readLedger<{ type?: string; at?: string; costUsd?: number }>('spend')) {
      if (r.type === 'posted' && typeof r.at === 'string' && r.at.startsWith(month)) monthSpend += Number(r.costUsd) || 0;
    }
  } catch {
    // an unreadable ledger shows as zero; the folder check reports the folder itself
  }
  const budget = Math.min(cfg.inspection.dailyBudget, Math.floor(2000 * cfg.inspection.shareOfPropertyQuota));
  // doctor's own live check counts too, so a day whose budget a run used up can show one over.
  const over = usedToday > budget ? '; the extra ones are doctor\'s own test checks' : '';
  add(c, { status: 'ok', area: 'inspect', text: `Index checks used today: ${fmtInt(usedToday)} of ${fmtInt(budget)} (2,000 per property, shared with your other tools${over})` });

  if (cfg.serp.provider !== 'dataforseo') {
    add(c, { status: 'info', area: 'serp', text: 'AI Overview checks are off. Run `npx searchtrace setup --dataforseo` to turn them on (usually cents a month).' });
    return;
  }
  const serp = cfg.serp;
  const login = c.deps.env[serp.loginEnv];
  const password = c.deps.env[serp.passwordEnv];
  if (!login || !password) {
    add(c, { status: 'fail', area: 'serp', text: `DataForSEO: no login found in ${serp.loginEnv} and ${serp.passwordEnv}`, fix: `Set ${serp.loginEnv} and ${serp.passwordEnv} (or the GitHub secrets of the same names).` });
    return;
  }
  c.secrets.add(login);
  c.secrets.add(password);
  const basic = Buffer.from(`${login}:${password}`).toString('base64');
  c.secrets.add(basic);
  try {
    const res = await requestJson<{ tasks?: { result?: { money?: { balance?: number } }[] }[] }>(c.deps.fetch, {
      url: DFS_USER_DATA, headers: { authorization: `Basic ${basic}` }, timeoutMs: 30_000,
    });
    if (res.status === 401) {
      add(c, { status: 'fail', area: 'serp', text: 'DataForSEO: the login was refused', fix: `Check ${serp.loginEnv} and ${serp.passwordEnv}.` });
      return;
    }
    const balance = res.data?.tasks?.[0]?.result?.[0]?.money?.balance;
    const bal = typeof balance === 'number' && Number.isFinite(balance) ? balance : null;
    const checks = bal !== null && serp.costPerCheckUsd > 0 ? ` about ${fmtInt(Math.floor(bal / serp.costPerCheckUsd))} checks ·` : '';
    add(c, {
      status: bal !== null && bal < serp.costPerCheckUsd ? 'warn' : 'ok', area: 'serp',
      text: `DataForSEO: ${bal === null ? 'balance unknown' : `${fmtMoney(bal)} balance,`}${checks} cap ${fmtMoney(serp.monthlyBudgetUsd)}/month · used ${fmtMoney(monthSpend)} this month`,
    });
  } catch (e) {
    add(c, { status: 'fail', area: 'serp', text: `DataForSEO: ${c.secrets.redact((e as Error)?.message ?? String(e))}` });
  }
}

async function checkFolder(c: Ctx): Promise<void> {
  if (!existsSync(c.dir)) {
    add(c, { status: 'fail', area: 'folder', text: `Folder ${c.dir} does not exist`, fix: 'Run `npx searchtrace setup` to create it.' });
    return;
  }
  try {
    const store = await openStore(c.dir, c.secrets);
    await store.writeFileAtomic('state/doctor-probe', 'ok\n');
    await store.removeFile('state/doctor-probe');
    const runs = await store.readLedger<{ runId?: string; event?: string; at?: string; exit?: string; dryRun?: boolean }>('runs');
    const ends = runs.filter((r) => r.event === 'end' && !r.dryRun);
    const last = ends[ends.length - 1];
    const lastText = last?.at ? `last run ${last.exit ?? 'ok'} ${fmtDate(ptDate(last.at))}` : 'no runs yet';
    add(c, { status: 'ok', area: 'folder', text: `Folder writable · ${fmtBytes(dirSize(c.dir))} of history · ${lastText}` });
    const ended = new Set(runs.filter((r) => r.event === 'end').map((r) => r.runId));
    const starts = runs.filter((r) => r.event === 'start');
    const lastStart = starts[starts.length - 1];
    if (lastStart?.runId && !ended.has(lastStart.runId)) {
      add(c, { status: 'warn', area: 'folder', text: `The last run (${lastStart.runId}) didn't finish. It's safe to run again.` });
    }
  } catch (e) {
    const err = e instanceof StError ? e : null;
    add(c, { status: 'fail', area: 'folder', text: `Folder: ${err?.message ?? (e as Error)?.message ?? String(e)}`, fix: 'Check the folder permissions, or pick another folder with --dir.' });
  }
}

function checkKeyLocation(c: Ctx, src: CredentialSource | null, cfg: Config): void {
  if (!src) return;
  if (src.kind === 'env') {
    add(c, { status: 'ok', area: 'key', text: `Key comes from the ${cfg.auth.credentialsEnv} environment variable, not a file` });
    return;
  }
  const path = src.path as string;
  if (isInside(path, c.dir)) {
    add(c, { status: 'fail', area: 'key', text: 'The key file is inside the data folder, which you may commit', fix: MOVE_KEY_FIX });
  } else {
    const root = gitRootOf(path);
    if (root && !ignoredByGit(path, root)) {
      add(c, { status: 'warn', area: 'key', text: 'The key file is inside a git repository, where it could be committed by mistake', fix: MOVE_KEY_FIX });
    } else if (root) {
      add(c, { status: 'ok', area: 'key', text: "Key file is outside this folder, and the git repo it sits in ignores it (.gitignore)" });
    } else {
      add(c, { status: 'ok', area: 'key', text: 'Key file is outside this folder and not in a git repo' });
    }
  }
}

async function checkGraphify(c: Ctx): Promise<void> {
  const g = await findGraphify(c.deps.env);
  const graph = join(c.dir, ...layout.graph.split('/'));
  if (!g) {
    add(c, { status: 'info', area: 'graphify', text: 'graphify not found.', fix: 'Optional: pipx/uv install graphifyy to ask your history in Claude or Cursor.' });
    return;
  }
  if (!g.mcp) {
    add(c, { status: 'warn', area: 'graphify', text: 'graphify found but its MCP server is not installed. To ask your history in Claude:', fix: '  uv tool install --force "graphifyy[mcp]"' });
  } else {
    add(c, { status: 'ok', area: 'graphify', text: 'graphify found, with its MCP server. Add it to Claude Code with:', fix: `  claude mcp add seo-history -- ${g.python} -m graphify.serve "${graph}"` });
  }
  if (g.python && !g.mcp) {
    add(c, { status: 'info', area: 'graphify', text: 'Then add it to Claude Code with:', fix: `  claude mcp add seo-history -- ${g.python} -m graphify.serve "${graph}"` });
  }
}

async function checkBrandAndSize(c: Ctx, cfg: Config): Promise<void> {
  let doc: { diagnostics?: { brandSuggestions?: string[]; namedClickShare?: number }; headline?: { clicks?: { post?: number } } } | null = null;
  try {
    const store = await openStore(c.dir, c.secrets);
    const text = await store.readFile(layout.findingsJson);
    doc = text ? JSON.parse(text) : null;
  } catch {
    doc = null;
  }
  try {
    const m = buildBrandMatcher({ siteDomain: siteDomainOf(cfg.property), siteName: null, terms: cfg.analysis.brandTerms });
    const sug = doc?.diagnostics?.brandSuggestions ?? [];
    add(c, { status: 'ok', area: 'brand', text: `Brand words: ${m.tokens.join(', ') || 'none'} (suggested: ${sug.length ? sug.join(', ') : 'none'})` });
  } catch {
    add(c, { status: 'info', area: 'brand', text: 'Brand words: worked out on the first run.' });
  }
  const named = (doc?.headline?.clicks?.post ?? 0) * (doc?.diagnostics?.namedClickShare ?? 0);
  if (doc && named < 60) {
    add(c, { status: 'info', area: 'serp', text: "AI Overview impact can't be measured at this size; we'll still list which searches show one and whether you're cited." });
  }
}

export async function runDoctor(dir: string, deps: CliDeps, secrets: SecretRegistry): Promise<Check[]> {
  const c: Ctx = { deps, dir, secrets, checks: [], config: null, auth: null };
  const m = /^v?(\d+)\.(\d+)/.exec(deps.nodeVersion);
  const okNode = m !== null && (Number(m[1]) > 22 || (Number(m[1]) === 22 && Number(m[2]) >= 13));
  add(c, okNode
    ? { status: 'ok', area: 'node', text: `Node ${deps.nodeVersion} (needs 22.13 or newer)` }
    : { status: 'fail', area: 'node', text: `Node ${deps.nodeVersion} is too old`, fix: `searchtrace needs Node 22.13 or newer (you have ${deps.nodeVersion}). Get it from nodejs.org.` });
  try {
    c.config = await loadConfig(dir);
    add(c, { status: 'ok', area: 'config', text: `Config valid (${c.config.property})` });
  } catch (e) {
    const err = e instanceof StError ? e : null;
    add(c, { status: 'fail', area: 'config', text: `Config: ${err?.message ?? String(e)}`, fix: err?.fix ?? SETUP_FIX });
  }
  let src: CredentialSource | null = null;
  if (c.config) {
    src = await checkCredential(c, c.config);
    if (c.auth && (await checkSearchConsole(c, c.config, c.auth)) && c.config.inspection.enabled) await checkInspection(c, c.config, c.auth);
    await checkQuotaAndSpend(c, c.config);
  }
  await checkFolder(c);
  if (c.config) checkKeyLocation(c, src, c.config);
  await checkGraphify(c);
  if (c.config) await checkBrandAndSize(c, c.config);
  return c.checks;
}

export function formatChecks(dir: string, checks: Check[]): string {
  const lines = [`searchtrace doctor · ${dir}`];
  for (const ch of checks) {
    lines.push(`  ${MARK[ch.status]} ${ch.text}`);
    if (ch.fix) for (const l of ch.fix.split('\n')) lines.push(`    ${l}`);
  }
  return `${lines.join('\n')}\n`;
}

export function doctorExit(checks: Check[]): number {
  const failed = checks.filter((c) => c.status === 'fail');
  if (!failed.length) return ExitCode.OK;
  if (failed.some((c) => c.area === 'config')) return ExitCode.CONFIG;
  if (failed.some((c) => c.area === 'auth' || c.area === 'gsc' || c.area === 'inspect')) return ExitCode.AUTH;
  return ExitCode.ERROR;
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function doctorCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const secrets = createSecretRegistry({ ci: false });
  try {
    const { values: v } = parseFlags(args, { dir: { type: 'string' }, json: { type: 'boolean' } }, 'doctor');
    const dir = resolveDir(v.dir, deps);
    const checks = await runDoctor(dir, deps, secrets);
    if (v.json) out(deps, secrets.redact(JSON.stringify({ dir, checks }, null, 2)));
    else deps.stdout.write(secrets.redact(formatChecks(dir.split(sep).join('/'), checks)));
    return doctorExit(checks);
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
