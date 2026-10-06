// Spec 5.13 test 51 (auth part): credential order and shapes, RS256 JWT, refresh grant,
// invalid_rapt, 401/403 mapping, secrets. Owner: WP-B.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { StError } from '../../src/core/errors.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { Config } from '../../src/core/types.js';
import {
  DEFAULT_TOKEN_URI, READONLY_SCOPE, SITES_URL, authTuning, googleJson, listSites, loadGoogleAuth, type LoadedGoogleAuth,
} from '../../src/sources/google/auth.js';
import { fakeFetch, type FakeRequest } from '../helpers/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SA = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'kid-123',
  private_key: privateKey,
  client_email: 'robot@test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
// The google-auth token.json shape: no "type" field (spec 0.2 F7).
const TOKEN_FILE = {
  token: 'ya29.cached-access-token-value',
  refresh_token: '1//refresh-token-value-for-tests',
  token_uri: 'https://oauth2.googleapis.com/token',
  client_id: 'client-id.apps.googleusercontent.com',
  client_secret: 'client-secret-value',
  scopes: ['https://www.googleapis.com/auth/webmasters'],
};

let dir: string;
const cfg = (o: Partial<Config['auth']> = {}): Config => {
  const c = defaultConfig('sc-domain:example.com');
  return { ...c, auth: { ...c.auth, ...o } };
};
const noHome = (): Record<string, string | undefined> => ({ HOME: join(dir, 'empty-home'), CLOUDSDK_CONFIG: join(dir, 'no-gcloud') });

function tokenRoute(reply: (req: FakeRequest, n: number) => object, status = 200) {
  return { method: 'POST' as const, url: DEFAULT_TOKEN_URI, reply: (req: FakeRequest, n: number) => ({ status, body: reply(req, n) }) };
}

beforeAll(() => {
  authTuning.retryBaseMs = 1;
  dir = mkdtempSync(join(tmpdir(), 'st-auth-'));
  writeFileSync(join(dir, 'sa.json'), JSON.stringify(SA));
  writeFileSync(join(dir, 'token.json'), JSON.stringify(TOKEN_FILE));
  mkdirSync(join(dir, 'gcloud'));
  writeFileSync(
    join(dir, 'gcloud', 'application_default_credentials.json'),
    JSON.stringify({ type: 'authorized_user', client_id: 'adc-client', client_secret: 'adc-secret-value', refresh_token: 'adc-refresh-token-value' }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadGoogleAuth', () => {
  it('signs an RS256 JWT for a service account and caches the token', async () => {
    const ff = fakeFetch([tokenRoute(() => ({ access_token: 'ya29.sa-access-token-1', expires_in: 3600, token_type: 'Bearer' }))]);
    const secrets = createSecretRegistry({ ci: false });
    const auth = await loadGoogleAuth({ config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify(SA) }, fetch: ff.fetch, secrets });
    expect(auth.kind).toBe('service_account');
    expect(auth.principal).toBe(SA.client_email);
    expect(auth.scopes).toEqual([READONLY_SCOPE]);
    expect((auth as LoadedGoogleAuth).source).toBe('env SEARCHTRACE_GOOGLE_KEY');
    expect(ff.calls).toHaveLength(0); // loading never talks to Google

    const h1 = await auth.headers();
    const h2 = await auth.headers();
    expect(h1.authorization).toBe('Bearer ya29.sa-access-token-1');
    expect(h2).toEqual(h1);
    expect(h1['x-goog-user-project']).toBeUndefined();
    expect(ff.calls).toHaveLength(1);

    const form = new URLSearchParams(ff.calls[0].body ?? '');
    expect(ff.calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = form.get('assertion') ?? '';
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-123' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims.iss).toBe(SA.client_email);
    expect(claims.scope).toBe(READONLY_SCOPE);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);

    // Secrets: the private key and the access token are registered.
    const keyLine = privateKey.split('\n')[1];
    expect(secrets.redact(`x ${keyLine} y`)).not.toContain(keyLine);
    expect(secrets.redact('token ya29.sa-access-token-1')).not.toContain('sa-access-token-1');
    expect(() => secrets.assertNoSecret('{"t":"ya29.sa-access-token-1"}')).toThrow(StError);

    // invalidate() forces a new token.
    (auth as LoadedGoogleAuth).invalidate();
    await auth.headers();
    expect(ff.calls).toHaveLength(2);
  });

  it('loads a token file with no "type" as authorized_user and uses the refresh grant', async () => {
    const ff = fakeFetch([tokenRoute(() => ({ access_token: 'ya29.user-token-1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/webmasters' }))]);
    const secrets = createSecretRegistry({ ci: false });
    const auth = await loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets, credentialsOverride: join(dir, 'token.json') });
    expect(auth.kind).toBe('authorized_user');
    expect(auth.principal).toBe('user credential');
    expect(auth.scopes).toEqual(['https://www.googleapis.com/auth/webmasters']);
    expect((await auth.headers()).authorization).toBe('Bearer ya29.user-token-1');
    const form = new URLSearchParams(ff.calls[0].body ?? '');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('client_id')).toBe(TOKEN_FILE.client_id);
    expect(form.get('client_secret')).toBe(TOKEN_FILE.client_secret);
    expect(form.get('refresh_token')).toBe(TOKEN_FILE.refresh_token);
    for (const s of [TOKEN_FILE.client_secret, TOKEN_FILE.refresh_token, TOKEN_FILE.token, 'ya29.user-token-1']) {
      expect(secrets.redact(`a ${s} b`)).not.toContain(s);
    }
  });

  it('maps invalid_rapt to reauth_required with the gcloud fix', async () => {
    const ff = fakeFetch([
      tokenRoute(() => ({ error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)', error_subtype: 'invalid_rapt' }), 400),
    ]);
    const auth = await loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets: createSecretRegistry({ ci: false }), credentialsOverride: join(dir, 'token.json') });
    const err = await auth.headers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StError);
    expect((err as StError).code).toBe('reauth_required');
    expect((err as StError).exit).toBe(3);
    expect((err as StError).fix).toContain('gcloud auth application-default login --client-id-file=<your OAuth client json>');
    expect((err as StError).fix).toContain('--credentials');
  });

  it('maps a plain invalid_grant to auth', async () => {
    const ff = fakeFetch([tokenRoute(() => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), 400)]);
    const auth = await loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets: createSecretRegistry({ ci: false }), credentialsOverride: join(dir, 'token.json') });
    const err = (await auth.headers().catch((e: unknown) => e)) as StError;
    expect(err.code).toBe('auth');
    expect(err.message).toContain('expired or revoked');
  });

  it('follows the credential order: --credentials, config file, env JSON, GOOGLE_APPLICATION_CREDENTIALS, ADC', async () => {
    const ff = fakeFetch([]);
    const secrets = createSecretRegistry({ ci: false });
    const env = { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify(SA), GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'token.json') };
    const load = (o: { config?: Config; env?: Record<string, string | undefined>; override?: string }) =>
      loadGoogleAuth({ config: o.config ?? cfg(), env: o.env ?? env, fetch: ff.fetch, secrets, credentialsOverride: o.override });

    expect((await load({ override: join(dir, 'token.json') })).kind).toBe('authorized_user');
    expect((await load({ config: cfg({ credentialsFile: join(dir, 'token.json') }) })).kind).toBe('authorized_user');
    // A config file that does not exist falls through to the next source.
    expect((await load({ config: cfg({ credentialsFile: join(dir, 'missing.json') }) })).kind).toBe('service_account');
    expect((await load({})).kind).toBe('service_account');
    const gac = await load({ env: { ...noHome(), GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'token.json') } });
    expect((gac as LoadedGoogleAuth).source).toBe(join(dir, 'token.json'));
    const adc = await load({ env: { HOME: join(dir, 'empty-home'), CLOUDSDK_CONFIG: join(dir, 'gcloud') } });
    expect(adc.kind).toBe('authorized_user');
    expect((adc as LoadedGoogleAuth).source).toBe(join(dir, 'gcloud', 'application_default_credentials.json'));
    // A custom env var name from config.
    const custom = await load({ config: cfg({ credentialsEnv: 'MY_KEY' }), env: { ...noHome(), MY_KEY: JSON.stringify(SA) } });
    expect(custom.kind).toBe('service_account');
    expect(ff.calls).toHaveLength(0);
  });

  it('fails clearly when nothing is found, when --credentials is missing, or when the JSON is wrong', async () => {
    const ff = fakeFetch([]);
    const secrets = createSecretRegistry({ ci: false });
    const none = (await loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets }).catch((e: unknown) => e)) as StError;
    expect(none.code).toBe('auth');
    expect(none.fix).toContain('npx searchtrace setup');

    const missing = (await loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets, credentialsOverride: join(dir, 'nope.json') }).catch((e: unknown) => e)) as StError;
    expect(missing.code).toBe('auth');
    expect(missing.message).toContain('--credentials');

    const bad = (await loadGoogleAuth({ config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: '{not json' }, fetch: ff.fetch, secrets }).catch((e: unknown) => e)) as StError;
    expect(bad.code).toBe('auth');
    expect(bad.message).not.toContain('{not json');

    const ext = (await loadGoogleAuth({
      config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify({ type: 'external_account', audience: 'x' }) }, fetch: ff.fetch, secrets,
    }).catch((e: unknown) => e)) as StError;
    expect(ext.code).toBe('auth');
    expect(ext.message).toContain('external_account');

    const half = (await loadGoogleAuth({
      config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify({ type: 'service_account', client_email: 'a@b.c' }) }, fetch: ff.fetch, secrets,
    }).catch((e: unknown) => e)) as StError;
    expect(half.code).toBe('auth');
    expect(half.message).toContain('private_key');
  });

  it('sends x-goog-user-project only when a quota project is set', async () => {
    const ff = fakeFetch([tokenRoute(() => ({ access_token: 'ya29.qp-token-value', expires_in: 3600 }))]);
    const secrets = createSecretRegistry({ ci: false });
    const fromCfg = await loadGoogleAuth({ config: cfg({ quotaProject: 'cfg-project' }), env: noHome(), fetch: ff.fetch, secrets, credentialsOverride: join(dir, 'token.json') });
    expect((await fromCfg.headers())['x-goog-user-project']).toBe('cfg-project');
    const fromEnv = await loadGoogleAuth({ config: cfg(), env: { ...noHome(), GOOGLE_CLOUD_QUOTA_PROJECT: 'env-project' }, fetch: ff.fetch, secrets, credentialsOverride: join(dir, 'token.json') });
    expect((await fromEnv.headers())['x-goog-user-project']).toBe('env-project');
    const fromFile = await loadGoogleAuth({
      config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify({ ...TOKEN_FILE, quota_project_id: 'file-project' }) }, fetch: ff.fetch, secrets,
    });
    expect((await fromFile.headers())['x-goog-user-project']).toBe('file-project');
  });

  it('ignores a token_uri that is not a Google endpoint', async () => {
    const ff = fakeFetch([tokenRoute(() => ({ access_token: 'ya29.safe-token-value', expires_in: 3600 }))]);
    const auth = await loadGoogleAuth({
      config: cfg(), env: { ...noHome(), SEARCHTRACE_GOOGLE_KEY: JSON.stringify({ ...TOKEN_FILE, token_uri: 'https://evil.example/token' }) }, fetch: ff.fetch,
      secrets: createSecretRegistry({ ci: false }),
    });
    await auth.headers();
    expect(ff.calls[0].url).toBe(DEFAULT_TOKEN_URI);
  });
});

describe('Google API calls', () => {
  const userAuth = async (ff: ReturnType<typeof fakeFetch>) =>
    loadGoogleAuth({ config: cfg(), env: noHome(), fetch: ff.fetch, secrets: createSecretRegistry({ ci: false }), credentialsOverride: join(dir, 'token.json') });

  it('listSites returns the properties, sorted', async () => {
    const ff = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.list-token-value', expires_in: 3600 })),
      {
        method: 'GET', url: SITES_URL,
        reply: { body: { siteEntry: [{ siteUrl: 'sc-domain:z.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://a.com/', permissionLevel: 'siteFullUser' }] } },
      },
    ]);
    const auth = await userAuth(ff);
    expect(await listSites(auth, ff.fetch)).toEqual([
      { siteUrl: 'https://a.com/', permissionLevel: 'siteFullUser' },
      { siteUrl: 'sc-domain:z.com', permissionLevel: 'siteOwner' },
    ]);
    expect(ff.callsTo(SITES_URL)[0].headers.authorization).toBe('Bearer ya29.list-token-value');
  });

  it('403 maps to permission with the "Add <principal>" fix', async () => {
    const ff = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.p-token-value', expires_in: 3600 })),
      { method: 'GET', url: SITES_URL, reply: { status: 403, body: { error: { code: 403, message: 'User does not have sufficient permission', status: 'PERMISSION_DENIED' } } } },
    ]);
    const auth = await userAuth(ff);
    const err = (await googleJson(auth, ff.fetch, { url: SITES_URL }, { property: 'sc-domain:example.com', what: 'test' }).catch((e: unknown) => e)) as StError;
    expect(err.code).toBe('permission');
    expect(err.exit).toBe(3);
    expect(err.fix).toBe('Add user credential as a user on sc-domain:example.com in Search Console > Settings > Users and permissions.');
  });

  it('403 SERVICE_DISABLED gives the activation URL as the fix', async () => {
    const url = 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123';
    const ff = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.d-token-value', expires_in: 3600 })),
      {
        method: 'GET', url: SITES_URL,
        reply: { status: 403, body: { error: { code: 403, message: 'Google Search Console API has not been used in project 123', details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: url } }] } } },
      },
    ]);
    const err = (await listSites(await userAuth(ff), ff.fetch).catch((e: unknown) => e)) as StError;
    expect(err.code).toBe('permission');
    expect(err.fix).toBe(url);
  });

  it('401 refreshes the token once, then maps to auth', async () => {
    const ff = fakeFetch([
      tokenRoute((_r, n) => ({ access_token: `ya29.refresh-${n}-token`, expires_in: 3600 })),
      { method: 'GET', url: SITES_URL, reply: { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } } },
    ]);
    const err = (await listSites(await userAuth(ff), ff.fetch).catch((e: unknown) => e)) as StError;
    expect(err.code).toBe('auth');
    expect(ff.callsTo(DEFAULT_TOKEN_URI)).toHaveLength(2);
    expect(ff.callsTo(SITES_URL)).toHaveLength(2);
    expect(ff.callsTo(SITES_URL)[1].headers.authorization).toBe('Bearer ya29.refresh-1-token');
  });

  it('404 maps to property_not_found and 400 to internal', async () => {
    const ff = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.n-token-value', expires_in: 3600 })),
      { method: 'POST', url: 'https://x.test/404', reply: { status: 404, body: { error: { message: 'not found' } } } },
      { method: 'POST', url: 'https://x.test/400', reply: { status: 400, body: { error: { message: 'bad request' } } } },
    ]);
    const auth = await userAuth(ff);
    const e404 = (await googleJson(auth, ff.fetch, { url: 'https://x.test/404', method: 'POST', body: {} }, { property: 'sc-domain:x.com', what: 't' }).catch((e: unknown) => e)) as StError;
    expect(e404.code).toBe('property_not_found');
    const e400 = (await googleJson(auth, ff.fetch, { url: 'https://x.test/400', method: 'POST', body: {} }, { what: 't' }).catch((e: unknown) => e)) as StError;
    expect(e400.code).toBe('internal');
  });

  it('429 honours Retry-After and then succeeds', async () => {
    const ff = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.r-token-value', expires_in: 3600 })),
      { method: 'POST', url: 'https://x.test/q', times: 1, reply: { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'slow down' } } } },
      { method: 'POST', url: 'https://x.test/q', reply: { body: { rows: [] } } },
    ]);
    const auth = await userAuth(ff);
    const data = await googleJson<{ rows: unknown[] }>(
      auth, ff.fetch, { url: 'https://x.test/q', method: 'POST', body: {}, retry: { attempts: 3, baseMs: 1, capMs: 10, on: [429] } }, { what: 't' },
    );
    expect(data.rows).toEqual([]);
    expect(ff.callsTo('https://x.test/q')).toHaveLength(2);
    // A Retry-After longer than the cap stops retrying and becomes a quota error.
    const ff2 = fakeFetch([
      tokenRoute(() => ({ access_token: 'ya29.r2-token-value', expires_in: 3600 })),
      { method: 'POST', url: 'https://x.test/q', reply: { status: 429, headers: { 'retry-after': '3600' }, body: { error: { message: 'quota' } } } },
    ]);
    const err = (await googleJson(await userAuth(ff2), ff2.fetch, {
      url: 'https://x.test/q', method: 'POST', body: {}, retry: { attempts: 6, baseMs: 1, capMs: 10, on: [429] },
    }, { what: 't' }).catch((e: unknown) => e)) as StError;
    expect(err.code).toBe('quota');
    expect(ff2.callsTo('https://x.test/q')).toHaveLength(1);
  });
});
