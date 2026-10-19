// Credential loader, RS256 JWT signing, refresh grant, invalid_rapt handling, listSites. Owner: WP-B.
//
// Order (spec 4.8, first that exists wins):
//   1. --credentials FILE            2. config.auth.credentialsFile
//   3. env[config.auth.credentialsEnv] (the JSON itself)
//   4. env GOOGLE_APPLICATION_CREDENTIALS (a path)
//   5. the gcloud ADC file ($CLOUDSDK_CONFIG, ~/.config/gcloud or %APPDATA%\gcloud)
// Accepted shapes: a service-account key, an authorized_user file (gcloud ADC), or a google-auth
// token.json, which has the same fields with no "type". Loading reads files only; the first token
// request happens on the first headers() call, so a dry run never talks to Google.
// Every key, client secret, refresh token and access token is registered with the SecretRegistry.
// The loader never writes to credential files.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { StError } from '../../core/errors.js';
import { cli, docUrl } from '../../core/install.js';
import type { Config, Fetch, GoogleAuth, HttpRequest, SecretRegistry } from '../../core/types.js';
import { requestJson } from '../../http/request.js';

export const READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const SITES_URL = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

/** Retry and timing knobs. Tests shorten the backoff; nothing else should touch these. */
export const authTuning = { retryBaseMs: 1000, retryCapMs: 8000, attempts: 3, timeoutMs: 30_000, refreshMarginMs: 60_000 };

export const REAUTH_FIX = [
  'Google wants you to sign in again. Run:',
  '  gcloud auth application-default login --client-id-file=<your OAuth client json> \\',
  '    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform',
  'or point searchtrace at a service-account key with --credentials.',
].join('\n');

const MISSING_FIX = `Run \`${cli('setup')}\`, or pass --credentials <file>.`;
const DOCTOR_FIX = `Run \`${cli('doctor')}\` to check the credential.`;

/** gcloud's own OAuth client: a plain `gcloud auth application-default login` uses it, and it can't be granted Search Console. */
export const GCLOUD_DEFAULT_CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';

export const SCOPE_FIX = [
  "This Google sign-in doesn't include Search Console access, and gcloud's own sign-in can't get it. Either use a robot account",
  `(\`${cli('setup')}\`, option 1), or sign in with your own OAuth client (${docUrl('SETUP.md')}, option 2):`,
  '  gcloud auth application-default login --client-id-file=<your OAuth client json> \\',
  '    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform',
].join('\n');

/** The GoogleAuth this module returns: source and invalidate (optional in the contract) are always set. */
export interface LoadedGoogleAuth extends GoogleAuth {
  /** Where the credential came from, e.g. "/path/key.json" or "env SEARCHTRACE_GOOGLE_KEY". Never the content. */
  source: string;
  /** Drops the cached access token so the next headers() call asks Google for a new one. */
  invalidate(): void;
}

// ---------- parsing ----------

const ServiceAccountSchema = z
  .object({
    type: z.literal('service_account'),
    client_email: z.string().min(3),
    private_key: z.string().min(20),
    private_key_id: z.string().optional(),
    token_uri: z.string().optional(),
    quota_project_id: z.string().optional(),
  })
  .passthrough();

const AuthorizedUserSchema = z
  .object({
    type: z.literal('authorized_user').optional(),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    token_uri: z.string().optional(),
    quota_project_id: z.string().optional(),
    scopes: z.union([z.array(z.string()), z.string()]).optional(),
    account: z.string().optional(),
    token: z.string().optional(),
  })
  .passthrough();

type Credential =
  | { kind: 'service_account'; clientEmail: string; privateKey: string; keyId: string | null; tokenUri: string; quotaProject: string | null }
  | {
      kind: 'authorized_user';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      tokenUri: string;
      quotaProject: string | null;
      scopes: string[];
      account: string | null;
    };

/** JSON.parse that drops "__proto__" keys, so a credential file cannot touch prototypes. */
function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (k, v: unknown) => (k === '__proto__' ? undefined : v));
}

/** Only Google's own token endpoints are used; anything else falls back to the default. */
function safeTokenUri(uri: string | undefined): string {
  if (!uri) return DEFAULT_TOKEN_URI;
  try {
    const u = new URL(uri);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === 'oauth2.googleapis.com' || host === 'www.googleapis.com' || host === 'accounts.google.com')) {
      return u.toString();
    }
  } catch {
    // fall through
  }
  return DEFAULT_TOKEN_URI;
}

function nonEmpty(s: string | undefined | null): string | null {
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
}

/** Turns credential JSON into a Credential, or throws StError('auth') with a fix. Never echoes the content. */
export function parseCredential(json: unknown, source: string): Credential {
  const bad = (why: string): never => {
    throw new StError('auth', `The Google credential from ${source} ${why}`, MISSING_FIX);
  };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return bad('is not a JSON object.');
  const type = (json as { type?: unknown }).type;
  if (type === 'service_account') {
    const r = ServiceAccountSchema.safeParse(json);
    if (!r.success) return bad('looks like a service-account key but is missing client_email or private_key.');
    return {
      kind: 'service_account',
      clientEmail: r.data.client_email,
      privateKey: r.data.private_key,
      keyId: nonEmpty(r.data.private_key_id),
      tokenUri: safeTokenUri(r.data.token_uri),
      quotaProject: nonEmpty(r.data.quota_project_id),
    };
  }
  if (type === undefined || type === null || type === 'authorized_user') {
    const r = AuthorizedUserSchema.safeParse({ ...(json as object), type: type ?? undefined });
    if (!r.success) return bad('is missing client_id, client_secret or refresh_token.');
    const scopes = Array.isArray(r.data.scopes) ? r.data.scopes : typeof r.data.scopes === 'string' ? r.data.scopes.split(/\s+/) : [];
    const account = nonEmpty(r.data.account);
    return {
      kind: 'authorized_user',
      clientId: r.data.client_id,
      clientSecret: r.data.client_secret,
      refreshToken: r.data.refresh_token,
      tokenUri: safeTokenUri(r.data.token_uri),
      quotaProject: nonEmpty(r.data.quota_project_id),
      scopes: scopes.filter((x) => x !== ''),
      account: account && account.includes('@') ? account : null,
    };
  }
  return bad(`has type "${String(type).slice(0, 40)}", which searchtrace does not support yet. Use a service-account key or an authorized_user file.`);
}

// ---------- finding the credential ----------

function expandHome(p: string, env: Record<string, string | undefined>): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    return join(home, p.slice(1));
  }
  return p;
}

function adcPath(env: Record<string, string | undefined>): string {
  if (nonEmpty(env.CLOUDSDK_CONFIG)) return join(env.CLOUDSDK_CONFIG as string, 'application_default_credentials.json');
  if (process.platform === 'win32' && nonEmpty(env.APPDATA)) {
    return join(env.APPDATA as string, 'gcloud', 'application_default_credentials.json');
  }
  return join(env.HOME ?? homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new StError('auth', `Could not read the Google credential file ${path} (${code ?? 'read error'}).`, MISSING_FIX);
  }
}

function parseText(text: string, source: string): unknown {
  try {
    return parseJsonSafe(text);
  } catch {
    throw new StError('auth', `The Google credential from ${source} is not valid JSON.`, MISSING_FIX);
  }
}

async function findCredential(o: {
  config: Config;
  env: Record<string, string | undefined>;
  credentialsOverride?: string;
}): Promise<{ json: unknown; source: string }> {
  const env = o.env;
  const abs = (p: string): string => {
    const e = expandHome(p, env);
    return isAbsolute(e) ? e : resolve(e);
  };
  // 1. --credentials: an explicit flag that points nowhere is an error, not a fallback.
  if (nonEmpty(o.credentialsOverride)) {
    const path = abs(o.credentialsOverride as string);
    const text = await readIfExists(path);
    if (text === null) throw new StError('auth', `The credential file passed with --credentials does not exist: ${path}`, MISSING_FIX);
    return { json: parseText(text, path), source: path };
  }
  const missing: string[] = [];
  // 2. config.auth.credentialsFile
  const cfgFile = nonEmpty(o.config.auth?.credentialsFile);
  if (cfgFile) {
    const path = abs(cfgFile);
    const text = await readIfExists(path);
    if (text !== null) return { json: parseText(text, path), source: path };
    missing.push(`auth.credentialsFile (${path})`);
  }
  // 3. the env var holding the JSON itself (CI)
  const envName = nonEmpty(o.config.auth?.credentialsEnv) ?? 'SEARCHTRACE_GOOGLE_KEY';
  const inline = nonEmpty(env[envName]);
  if (inline) return { json: parseText(inline, `env ${envName}`), source: `env ${envName}` };
  // 4. GOOGLE_APPLICATION_CREDENTIALS
  const gac = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (gac) {
    const path = abs(gac);
    const text = await readIfExists(path);
    if (text !== null) return { json: parseText(text, path), source: path };
    missing.push(`GOOGLE_APPLICATION_CREDENTIALS (${path})`);
  }
  // 5. gcloud application default credentials
  const adc = adcPath(env);
  const text = await readIfExists(adc);
  if (text !== null) return { json: parseText(text, adc), source: adc };

  const tail = missing.length > 0 ? ` These were set but the files don't exist: ${missing.join(', ')}.` : '';
  throw new StError('auth', `No Google credential found.${tail}`, MISSING_FIX);
}

// ---------- tokens ----------

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/** An RS256 JWT for the service-account grant (claims iss, scope, aud, iat, exp = iat + 3600). */
export function signServiceAccountJwt(o: {
  clientEmail: string;
  privateKey: string;
  keyId: string | null;
  scope: string;
  aud: string;
  nowSeconds: number;
}): string {
  const header = o.keyId ? { alg: 'RS256', typ: 'JWT', kid: o.keyId } : { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: o.clientEmail, scope: o.scope, aud: o.aud, iat: o.nowSeconds, exp: o.nowSeconds + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(o.privateKey, 'base64url');
  } catch {
    throw new StError('auth', "The service-account key's private_key could not be used to sign a request.", 'Download a fresh JSON key for the service account and point --credentials at it.');
  }
  return `${unsigned}.${signature}`;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
  error_subtype?: unknown;
}

function tokenError(status: number, data: TokenResponse | null, cred: Credential, secrets: SecretRegistry): StError {
  const code = typeof data?.error === 'string' ? data.error : `HTTP ${status}`;
  const desc = typeof data?.error_description === 'string' ? secrets.redact(data.error_description).slice(0, 200) : '';
  const subtype = typeof data?.error_subtype === 'string' ? data.error_subtype : '';
  const detail = desc ? `${code}: ${desc}` : code;
  if (code === 'invalid_grant' && (subtype === 'invalid_rapt' || /rapt/i.test(desc))) {
    return new StError('reauth_required', `Google needs you to sign in again before this credential works (${detail}).`, REAUTH_FIX);
  }
  if (code === 'invalid_grant') {
    return new StError(
      'auth',
      `Google rejected the saved credential (${detail}).`,
      cred.kind === 'service_account'
        ? "Check that the service-account key still exists in Google Cloud and that this computer's clock is right."
        : 'Sign in again with your own OAuth client (gcloud auth application-default login --client-id-file=<your OAuth client json> ' +
          '--scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform). ' +
          'An External OAuth app left in Testing expires sign-ins after 7 days; a robot key does not. Or use a service-account key with --credentials.',
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new StError('auth', `Google rejected the OAuth client in this credential (${detail}).`, 'Create the credential again, or use a service-account key with --credentials.');
  }
  return new StError('auth', `Google would not issue an access token (${detail}).`, DOCTOR_FIX);
}

function tokenRequest(cred: Credential, nowSeconds: number): { url: string; body: string } {
  if (cred.kind === 'service_account') {
    const jwt = signServiceAccountJwt({
      clientEmail: cred.clientEmail,
      privateKey: cred.privateKey,
      keyId: cred.keyId,
      scope: READONLY_SCOPE,
      aud: cred.tokenUri,
      nowSeconds,
    });
    return {
      url: cred.tokenUri,
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
    };
  }
  return {
    url: cred.tokenUri,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
    }).toString(),
  };
}

function createAuth(cred: Credential, o: { fetch: Fetch; secrets: SecretRegistry; quotaProject: string | null; source: string }): LoadedGoogleAuth {
  let token: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  let scopes: string[] = cred.kind === 'service_account' ? [READONLY_SCOPE] : [...cred.scopes];

  const refresh = async (signal?: AbortSignal): Promise<string> => {
    const { url, body } = tokenRequest(cred, Math.floor(Date.now() / 1000));
    const res = await requestJson<TokenResponse | null>(o.fetch, {
      url,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: authTuning.timeoutMs,
      // Network errors only: an error status from the token endpoint is an answer, not a blip.
      retry: { attempts: authTuning.attempts, baseMs: authTuning.retryBaseMs, capMs: authTuning.retryCapMs, on: [] },
      idempotent: true,
      signal,
    });
    const data = res.data;
    const access = typeof data?.access_token === 'string' ? data.access_token : null;
    if (res.status < 200 || res.status >= 300 || !access) throw tokenError(res.status, data, cred, o.secrets);
    o.secrets.add(access);
    const ttl = typeof data?.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    token = { value: access, expiresAt: Date.now() + ttl * 1000 };
    if (typeof data?.scope === 'string' && data.scope.trim() !== '') {
      scopes = data.scope.trim().split(/\s+/).sort();
      // A plain gcloud ADC login grants cloud-platform but never Search Console: say so now, not as a 403 later.
      if (cred.kind === 'authorized_user' && !scopes.some((x) => x === READONLY_SCOPE || x === WRITE_SCOPE)) {
        token = null;
        throw new StError('auth', `This Google sign-in (${cred.account ?? 'user credential'}) was not granted Search Console access.`, SCOPE_FIX);
      }
    }
    return access;
  };

  const accessToken = async (signal?: AbortSignal): Promise<string> => {
    if (token && Date.now() < token.expiresAt - authTuning.refreshMarginMs) return token.value;
    if (!inflight) {
      inflight = refresh(signal).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  return {
    kind: cred.kind,
    principal: cred.kind === 'service_account' ? cred.clientEmail : (cred.account ?? 'user credential'),
    get scopes(): string[] {
      return [...scopes];
    },
    source: o.source,
    async headers(signal?: AbortSignal): Promise<Record<string, string>> {
      const h: Record<string, string> = { authorization: `Bearer ${await accessToken(signal)}` };
      if (o.quotaProject) h['x-goog-user-project'] = o.quotaProject;
      return h;
    },
    invalidate(): void {
      token = null;
    },
  };
}

export async function loadGoogleAuth(o: {
  config: Config;
  env: Record<string, string | undefined>;
  fetch: Fetch;
  secrets: SecretRegistry;
  credentialsOverride?: string;
}): Promise<GoogleAuth> {
  const found = await findCredential(o);
  const cred = parseCredential(found.json, found.source);
  if (cred.kind === 'service_account') {
    o.secrets.add(cred.privateKey);
  } else {
    o.secrets.add(cred.clientSecret);
    o.secrets.add(cred.refreshToken);
  }
  // A google-auth token.json can carry a cached access token; it is never used but must never leak.
  const cached = (found.json as { token?: unknown }).token;
  if (typeof cached === 'string') o.secrets.add(cached);
  const quotaProject = nonEmpty(o.config.auth?.quotaProject) ?? nonEmpty(o.env.GOOGLE_CLOUD_QUOTA_PROJECT) ?? cred.quotaProject;
  const auth: LoadedGoogleAuth = createAuth(cred, { fetch: o.fetch, secrets: o.secrets, quotaProject, source: found.source });
  return auth;
}

// ---------- calling Google APIs ----------

export interface GoogleCallContext {
  /** The property the call is about, for error messages and fixes. */
  property?: string;
  /** Short name of the call for error messages, e.g. "Search Console query". */
  what: string;
}

interface GoogleErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: { reason?: unknown; metadata?: Record<string, unknown> }[];
    errors?: { reason?: unknown }[];
  };
}

function googleMessage(data: unknown): { message: string; reasons: string[]; activationUrl: string | null } {
  const err = (data as GoogleErrorBody | null)?.error;
  const message = typeof err?.message === 'string' ? err.message.replace(/\s+/g, ' ').slice(0, 200) : '';
  const reasons: string[] = [];
  let activationUrl: string | null = null;
  for (const d of Array.isArray(err?.details) ? err.details : []) {
    if (typeof d?.reason === 'string') reasons.push(d.reason);
    const url = d?.metadata?.activationUrl;
    if (typeof url === 'string' && /^https:\/\/console\.(developers|cloud)\.google\.com\//.test(url)) activationUrl = url;
  }
  for (const e of Array.isArray(err?.errors) ? err.errors : []) if (typeof e?.reason === 'string') reasons.push(e.reason);
  if (typeof err?.status === 'string') reasons.push(err.status);
  return { message, reasons, activationUrl };
}

/** A 403 because the token lacks the Search Console scope (a plain gcloud ADC login), not because of property access. */
function isScopeError(g: { message: string; reasons: string[] }): boolean {
  return g.reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(g.message);
}

/** Maps a Google API error response to an StError with a one-line fix (spec 4.7 and 6.4.4). */
export function mapGoogleError(status: number, data: unknown, auth: Pick<GoogleAuth, 'principal'>, c: GoogleCallContext): StError {
  const g = googleMessage(data);
  const said = g.message ? ` Google said: ${g.message}` : '';
  const property = c.property ?? 'this property';
  if (status === 401) {
    return new StError('auth', `Google did not accept the credential for ${auth.principal} (${c.what}).${said}`, DOCTOR_FIX);
  }
  if (status === 403) {
    const disabled = g.reasons.some((r) => r === 'SERVICE_DISABLED' || r === 'accessNotConfigured') || /has not been used|is disabled/i.test(g.message);
    if (disabled) {
      return new StError(
        'permission',
        `The Search Console API is turned off for this credential's Google Cloud project.${said}`,
        g.activationUrl ?? 'Turn on the Google Search Console API in your Google Cloud project, then run again.',
      );
    }
    if (isScopeError(g)) {
      return new StError('auth', `This credential (${auth.principal}) was not granted Search Console access (${c.what}).${said}`, SCOPE_FIX);
    }
    return new StError(
      'permission',
      `${auth.principal} is not allowed to read ${property} (${c.what}).${said}`,
      `Add ${auth.principal} as a user on ${property} in Search Console > Settings > Users and permissions.`,
    );
  }
  if (status === 404) {
    return new StError(
      'property_not_found',
      `Search Console has no property ${property} that ${auth.principal} can see.${said}`,
      `Check the property name with \`${cli('doctor')}\`. Domain properties look like sc-domain:example.com; URL-prefix properties end with a slash.`,
    );
  }
  if (status === 429) return new StError('quota', `Search Console is rate limiting requests (${c.what}).${said}`);
  if (status === 400) return new StError('internal', `Search Console rejected a request as malformed (${c.what}). This is a bug in searchtrace.${said}`);
  return new StError('http', `Search Console returned HTTP ${status} (${c.what}).${said}`);
}

/**
 * Calls a Google API with the credential's headers and parses the JSON answer. A 401 drops the
 * cached token and tries once more; any other non-2xx status becomes an StError from mapGoogleError.
 */
export async function googleJson<T>(auth: GoogleAuth, fetchFn: Fetch, req: HttpRequest, c: GoogleCallContext): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const headers = { ...(req.headers ?? {}), ...(await auth.headers(req.signal)) };
    let res: { status: number; data: T };
    try {
      res = await requestJson<T>(fetchFn, { ...req, headers });
    } catch (e) {
      // requestJson throws StError('http') for a non-JSON error body; keep the status mapping.
      const status = (e as { status?: unknown }).status;
      if (e instanceof StError && e.code === 'http' && typeof status === 'number') {
        if (status === 401 && attempt === 1) {
          auth.invalidate?.();
          continue;
        }
        throw mapGoogleError(status, null, auth, c);
      }
      throw e;
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    if (res.status === 401 && attempt === 1) {
      auth.invalidate?.();
      continue;
    }
    throw mapGoogleError(res.status, res.data, auth, c);
  }
}

export async function listSites(auth: GoogleAuth, fetchFn: Fetch): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const data = await googleJson<{ siteEntry?: unknown } | null>(
    auth,
    fetchFn,
    { url: SITES_URL, method: 'GET', timeoutMs: 30_000 },
    { what: 'list properties' },
  );
  const entries = Array.isArray(data?.siteEntry) ? data.siteEntry : [];
  const out: { siteUrl: string; permissionLevel: string }[] = [];
  for (const e of entries) {
    const siteUrl = (e as { siteUrl?: unknown })?.siteUrl;
    const level = (e as { permissionLevel?: unknown })?.permissionLevel;
    if (typeof siteUrl === 'string') out.push({ siteUrl, permissionLevel: typeof level === 'string' ? level : 'unknown' });
  }
  return out.sort((a, b) => (a.siteUrl < b.siteUrl ? -1 : a.siteUrl > b.siteUrl ? 1 : 0));
}
