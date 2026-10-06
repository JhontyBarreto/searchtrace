import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, configHash, defaultConfig, loadConfig, writeConfig } from '../../src/core/config.js';
import { ExitCode, StError } from '../../src/core/errors.js';

const PROPERTY = 'sc-domain:example.com';

const EXPECTED_DEFAULTS = {
  version: 1,
  property: PROPERTY,
  auth: { credentialsEnv: 'SEARCHTRACE_GOOGLE_KEY' },
  gsc: { backfillMonths: 16, revalidateAfterDays: 10, concurrency: 2, requestsPerSecond: 4 },
  inspection: { enabled: true, dailyBudget: 200, shareOfPropertyQuota: 0.25 },
  crawl: { enabled: true, maxUrls: 500, concurrency: 2, delayMs: 1000, timeoutMs: 15000, maxBytes: 5_000_000, minHoursBetween: 20 },
  serp: { provider: 'none' },
  analysis: {
    windowDays: 28,
    fdrQ: 0.1,
    brandTerms: [],
    templateOverrides: [],
    bootstrap: { waterfall: 1000, aio: 2000, did: 1000 },
  },
  graph: { enabled: true, maxQueries: 2000 },
};

describe('ConfigSchema defaults (D21, test 70)', () => {
  it('fills every nested default from a minimal config via prefault', () => {
    const cfg = ConfigSchema.parse({ version: 1, property: PROPERTY });
    expect(cfg).toEqual(EXPECTED_DEFAULTS);
    expect(cfg.serp.provider).toBe('none');
    expect(cfg.analysis.bootstrap.waterfall).toBe(1000);
  });

  it('keeps sibling defaults when a nested object is partly given', () => {
    const cfg = ConfigSchema.parse({ version: 1, property: PROPERTY, gsc: { concurrency: 3 }, analysis: { bootstrap: { aio: 500 } } });
    expect(cfg.gsc).toEqual({ backfillMonths: 16, revalidateAfterDays: 10, concurrency: 3, requestsPerSecond: 4 });
    expect(cfg.analysis.bootstrap).toEqual({ waterfall: 1000, aio: 500, did: 1000 });
    expect(cfg.analysis.windowDays).toBe(28);
  });

  it('fills DataForSEO defaults when that provider is chosen', () => {
    const cfg = ConfigSchema.parse({ version: 1, property: PROPERTY, serp: { provider: 'dataforseo' } });
    expect(cfg.serp).toEqual({
      provider: 'dataforseo',
      loginEnv: 'DATAFORSEO_LOGIN',
      passwordEnv: 'DATAFORSEO_PASSWORD',
      monthlyBudgetUsd: 1,
      maxPerRunUsd: 0.3,
      costPerCheckUsd: 0.0012,
    });
  });

  it('accepts both property forms and rejects a bare domain or a URL without the trailing slash', () => {
    expect(ConfigSchema.safeParse({ version: 1, property: 'https://www.example.com/' }).success).toBe(true);
    expect(ConfigSchema.safeParse({ version: 1, property: 'example.com' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ version: 1, property: 'https://www.example.com' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(ConfigSchema.safeParse({ version: 1, property: PROPERTY, extra: true }).success).toBe(false);
  });
});

describe('secret refine (test 70)', () => {
  const message = 'Config must not contain keys or passwords';

  it('rejects a PEM block anywhere in the config', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
    const r = ConfigSchema.safeParse({ version: 1, property: PROPERTY, analysis: { brandTerms: [pem] } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toContain(message);
  });

  it('rejects a long token-like string', () => {
    const token = 'ya29a0AfB_byC' + 'x'.repeat(40);
    const r = ConfigSchema.safeParse({ version: 1, property: PROPERTY, auth: { quotaProject: token } });
    expect(r.success).toBe(false);
  });

  it('accepts ordinary paths and names', () => {
    const r = ConfigSchema.safeParse({
      version: 1,
      property: PROPERTY,
      auth: { credentialsFile: '/home/someone/.config/searchtrace/google-key.json', quotaProject: 'my-project-123' },
      analysis: { brandTerms: ['example', 'example co'], templateOverrides: [{ glob: '/blog/**', name: 'Blog' }] },
    });
    expect(r.success).toBe(true);
  });
});

describe('defaultConfig and configHash', () => {
  it('defaultConfig equals a parse of the minimal config', () => {
    expect(defaultConfig(PROPERTY)).toEqual(EXPECTED_DEFAULTS);
  });

  it('defaultConfig turns a bad property into StError(config) with a fix', () => {
    try {
      defaultConfig('example.com');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StError);
      expect((e as StError).code).toBe('config');
      expect((e as StError).exit).toBe(ExitCode.CONFIG);
      expect((e as StError).fix).toMatch(/sc-domain:example\.com/);
    }
  });

  it('configHash is 64 hex chars, ignores key order and changes with any value', () => {
    const a = defaultConfig(PROPERTY);
    const rebuilt = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(Object.keys(rebuilt)).not.toEqual(Object.keys(a));
    expect(configHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash(rebuilt)).toBe(configHash(a));
    const b = { ...a, gsc: { ...a.gsc, concurrency: 3 } };
    expect(configHash(b)).not.toBe(configHash(a));
  });
});

describe('loadConfig and writeConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'searchtrace-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const expectConfigError = async (p: Promise<unknown>, fix: RegExp) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(StError);
    expect((e as StError).code).toBe('config');
    expect((e as StError).fix ?? '').toMatch(fix);
  };

  it('round-trips through disk with defaults filled and no temp files left behind', async () => {
    const cfg = defaultConfig(PROPERTY);
    cfg.analysis.brandTerms = ['example'];
    await writeConfig(dir, cfg);
    expect(await loadConfig(dir)).toEqual(cfg);
    expect(await readdir(dir)).toEqual(['config.json']);
    const text = await readFile(join(dir, 'config.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('creates the folder when it does not exist', async () => {
    const nested = join(dir, 'searchtrace-data');
    await writeConfig(nested, defaultConfig(PROPERTY));
    expect((await loadConfig(nested)).property).toBe(PROPERTY);
  });

  it('applies defaults to a minimal file written by hand', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ version: 1, property: PROPERTY }));
    expect(await loadConfig(dir)).toEqual(EXPECTED_DEFAULTS);
  });

  it('missing file: StError(config) pointing at setup', async () => {
    await expectConfigError(loadConfig(dir), /searchtrace setup/);
  });

  it('broken JSON: StError(config)', async () => {
    await writeFile(join(dir, 'config.json'), '{ "version": 1, ');
    await expectConfigError(loadConfig(dir), /JSON/);
  });

  it('a __proto__ key is refused', async () => {
    await writeFile(join(dir, 'config.json'), '{ "version": 1, "property": "sc-domain:example.com", "__proto__": { "x": 1 } }');
    await expectConfigError(loadConfig(dir), /JSON/);
  });

  it('invalid values: StError(config) naming the field', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ version: 1, property: PROPERTY, gsc: { concurrency: 9 } }));
    const e = await loadConfig(dir).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(StError);
    expect((e as StError).message).toContain('gsc.concurrency');
  });

  it('writeConfig refuses a config holding a secret', async () => {
    const cfg = defaultConfig(PROPERTY);
    cfg.analysis.brandTerms = ['-----BEGIN PRIVATE KEY-----'];
    await expect(writeConfig(dir, cfg)).rejects.toBeInstanceOf(StError);
    expect(await readdir(dir)).toEqual([]);
  });
});
