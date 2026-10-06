// Config schema (spec 3.5, zod 4) plus load, write, default and hash helpers.
// Nested objects use .prefault({}) so inner defaults are applied (D21).
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StError } from './errors.js';

const SECRET_LIKE = [/-----BEGIN/, /"private_key"/, /^[A-Za-z0-9+/=_-]{40,}$/];
const noSecrets = (v: unknown): boolean =>
  !JSON.stringify(v).split('"').some((s) => SECRET_LIKE.some((re) => re.test(s)));

export const ConfigSchema = z.object({
  version: z.literal(1),
  property: z.string().regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+\/)$/),
  siteOrigin: z.string().url().optional(),                      // crawl start; default from defaultOrigins(property)
  auth: z.object({
    credentialsFile: z.string().optional(),                     // path to SA or authorized_user JSON (never inside the data dir)
    credentialsEnv: z.string().default('SEARCHTRACE_GOOGLE_KEY'), // env var holding the JSON itself (CI)
    quotaProject: z.string().optional(),                        // sent as x-goog-user-project when set
  }).prefault({}),
  gsc: z.object({
    backfillMonths: z.number().int().min(1).max(16).default(16),
    revalidateAfterDays: z.number().int().min(3).max(30).default(10),
    concurrency: z.number().int().min(1).max(4).default(2),
    requestsPerSecond: z.number().positive().max(10).default(4),
  }).prefault({}),
  inspection: z.object({
    enabled: z.boolean().default(true),
    dailyBudget: z.number().int().min(0).max(2000).default(200),
    shareOfPropertyQuota: z.number().min(0).max(1).default(0.25),
  }).prefault({}),
  crawl: z.object({
    enabled: z.boolean().default(true),
    maxUrls: z.number().int().min(1).max(5000).default(500),
    concurrency: z.number().int().min(1).max(4).default(2),
    delayMs: z.number().int().min(250).default(1000),
    timeoutMs: z.number().int().default(15000),
    maxBytes: z.number().int().default(5_000_000),
    minHoursBetween: z.number().min(1).default(20),
  }).prefault({}),
  serp: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('none') }),
    z.object({
      provider: z.literal('dataforseo'),
      loginEnv: z.string().default('DATAFORSEO_LOGIN'),
      passwordEnv: z.string().default('DATAFORSEO_PASSWORD'),
      monthlyBudgetUsd: z.number().min(0).max(100).default(1),
      maxPerRunUsd: z.number().min(0).max(100).default(0.3),
      costPerCheckUsd: z.number().default(0.0012),              // worst case; actual cost read back from id_list
      locationCode: z.number().int().optional(),                // default: top GSC country by impressions, 28 days
      languageCode: z.string().optional(),                      // default from assets/country-locations.json
    }),
  ]).prefault({ provider: 'none' }),
  analysis: z.object({
    windowDays: z.number().int().min(14).max(91).default(28),
    fdrQ: z.number().min(0.01).max(0.25).default(0.1),
    brandTerms: z.array(z.string()).default([]),
    templateOverrides: z.array(z.object({ glob: z.string(), name: z.string() })).default([]),
    bootstrap: z.object({
      waterfall: z.number().int().min(100).default(1000),
      aio: z.number().int().min(100).default(2000),
      did: z.number().int().min(100).default(1000),
    }).prefault({}),
  }).prefault({}),
  graph: z.object({
    enabled: z.boolean().default(true),
    maxQueries: z.number().int().min(0).default(2000),
  }).prefault({}),
}).strict().refine(noSecrets, { message: 'Config must not contain keys or passwords. Store them in a file or environment variable and reference that.' });

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_FILE = 'config.json';
const SETUP_FIX = 'Run `npx searchtrace setup` to create one, or pass --dir to point at your searchtrace-data folder.';
const PROPERTY_FIX =
  'Use sc-domain:example.com for a Domain property, or the full URL with a trailing slash (https://www.example.com/) for a URL-prefix property.';

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.length ? i.path.map((p) => String(p)).join('.') : '(top level)'}: ${i.message}`)
    .join('; ');
}

/** JSON.parse that refuses prototype-polluting keys (4.11). */
function parseJsonStrict(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === '__proto__') throw new SyntaxError('the key "__proto__" is not allowed');
    return value;
  });
}

/** Stable JSON: object keys sorted at every level, arrays in order, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Reads and validates <dir>/config.json. Every failure is StError('config') with a fix line. */
export async function loadConfig(dir: string): Promise<Config> {
  const file = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new StError('config', `No ${CONFIG_FILE} in ${dir}.`, SETUP_FIX);
    throw new StError('config', `Could not read ${file} (${code ?? 'unknown error'}).`, SETUP_FIX, { cause: e });
  }
  let raw: unknown;
  try {
    raw = parseJsonStrict(text);
  } catch (e) {
    throw new StError(
      'config',
      `${file} is not valid JSON: ${(e as Error).message}`,
      'Fix the JSON in that file, or run `npx searchtrace setup` to write a fresh one.',
      { cause: e },
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StError(
      'config',
      `${file} has problems: ${describeIssues(parsed.error.issues)}`,
      `Fix those values in ${file}, or run \`npx searchtrace setup\` again.`,
    );
  }
  return parsed.data;
}

/** Validates, then writes <dir>/config.json atomically (tmp file, fsync, rename). */
export async function writeConfig(dir: string, cfg: Config): Promise<void> {
  const parsed = ConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new StError('config', `Refusing to write an invalid config: ${describeIssues(parsed.error.issues)}`);
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, CONFIG_FILE);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  try {
    const fh = await open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new StError('config', `Could not write ${file}: ${(e as Error).message}`, undefined, { cause: e });
  }
  // Make the rename durable. Directories cannot be opened for fsync on Windows.
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // best effort
  }
}

/** A complete config for a property with every default filled in. */
export function defaultConfig(property: string): Config {
  const parsed = ConfigSchema.safeParse({ version: 1, property });
  if (!parsed.success) {
    throw new StError('config', `"${property}" is not a Search Console property name.`, PROPERTY_FIX);
  }
  return parsed.data;
}

/** sha256 (hex) of the canonical JSON of the config, recorded in the run ledger. */
export function configHash(cfg: Config): string {
  return createHash('sha256').update(canonicalJson(cfg), 'utf8').digest('hex');
}
