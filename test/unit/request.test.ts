import { afterEach, describe, expect, it, vi } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { redactBody, request, requestJson, retryAfterMs, safeUrl, type HttpFailure } from '../../src/http/request.js';
import { fakeFetch } from '../helpers/fake-fetch.js';

const API = 'https://api.example.test/v1/thing';
const fast = { attempts: 4, baseMs: 1, capMs: 5, on: [429, 500, 502, 503, 504] };

async function failure(p: Promise<unknown>): Promise<StError & HttpFailure> {
  try {
    await p;
  } catch (e) {
    return e as StError & HttpFailure;
  }
  throw new Error('expected a failure');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('request basics', () => {
  it('GETs, returns status, headers, url and text, and sends no body', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 200, headers: { 'x-a': '1' }, body: 'hello' } }]);
    const res = await request(ff.fetch, { url: API, headers: { authorization: 'Bearer fake-token-123456789' } });
    expect(res).toMatchObject({ status: 200, url: API, text: 'hello', truncated: false });
    expect(res.headers.get('x-a')).toBe('1');
    expect(ff.calls[0]).toMatchObject({ method: 'GET', body: null });
    expect(ff.calls[0].headers.authorization).toBe('Bearer fake-token-123456789');
  });

  it('serialises object bodies as JSON with a content type, and leaves strings alone', async () => {
    const ff = fakeFetch([{ method: 'POST', url: `${API}*`, reply: { body: { ok: true } } }]);
    await request(ff.fetch, { url: API, method: 'POST', body: { startDate: '2026-10-01', dimensions: ['date'] } });
    await request(ff.fetch, { url: `${API}/form`, method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(ff.calls[0].json()).toEqual({ startDate: '2026-10-01', dimensions: ['date'] });
    expect(ff.calls[0].headers['content-type']).toBe('application/json');
    expect(ff.calls[1].body).toBe('a=1');
    expect(ff.calls[1].headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('cuts the body at maxBytes and marks it truncated', async () => {
    const ff = fakeFetch([{ url: API, reply: { body: 'x'.repeat(10_000) } }]);
    const res = await request(ff.fetch, { url: API, maxBytes: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.text).toHaveLength(1000);
  });

  it('decodes with the charset from Content-Type', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const ff = fakeFetch([{ url: API, reply: { headers: { 'content-type': 'text/html; charset=ISO-8859-1' }, body: latin1 } }]);
    expect((await request(ff.fetch, { url: API })).text).toBe('café');
  });

  it('passes manual redirects through untouched', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 301, headers: { location: 'https://elsewhere.example/' } } }]);
    const res = await request(ff.fetch, { url: API, redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://elsewhere.example/');
  });
});

describe('retries (spec 4.7)', () => {
  it('retries 503s and returns the first success', async () => {
    const ff = fakeFetch([{ url: API, reply: (_r, n) => (n < 2 ? { status: 503 } : { body: 'ok' }) }]);
    const res = await request(ff.fetch, { url: API, retry: fast });
    expect(res.status).toBe(200);
    expect(ff.calls).toHaveLength(3);
  });

  it('returns the last response when retries run out, so callers map the status', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 429, body: '{"error":{"code":429}}' } }]);
    const res = await request(ff.fetch, { url: API, retry: fast });
    expect(res.status).toBe(429);
    expect(ff.calls).toHaveLength(4);
  });

  it('does not retry statuses outside the list, or anything when retry is false', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 403 } }, { url: `${API}/b`, reply: { status: 503 } }]);
    expect((await request(ff.fetch, { url: API, retry: fast })).status).toBe(403);
    expect((await request(ff.fetch, { url: `${API}/b`, retry: false })).status).toBe(503);
    expect(ff.calls).toHaveLength(2);
  });

  it('honours Retry-After on a 429 (fake timers)', async () => {
    vi.useFakeTimers();
    const ff = fakeFetch([{ url: API, reply: (_r, n) => (n === 0 ? { status: 429, headers: { 'retry-after': '3' } } : { body: 'ok' }) }]);
    let done = false;
    const p = request(ff.fetch, { url: API, retry: { attempts: 3, baseMs: 1, capMs: 64_000, on: [429] } }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(done).toBe(false);
    expect(ff.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).status).toBe(200);
    expect(ff.calls).toHaveLength(2);
  });

  it('stops retrying when Retry-After asks for longer than the cap', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 429, headers: { 'retry-after': '3600' } } }]);
    const res = await request(ff.fetch, { url: API, retry: { attempts: 6, baseMs: 1, capMs: 64_000, on: [429] } });
    expect(res.status).toBe(429);
    expect(ff.calls).toHaveLength(1);
  });

  it('uses full-jitter exponential backoff capped at capMs', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      const ff = fakeFetch([{ url: API, reply: { status: 503 } }]);
      const p = request(ff.fetch, { url: API });
      // Default policy: 6 attempts, waits just under 1, 2, 4, 8 and 16 s.
      await vi.advanceTimersByTimeAsync(998);
      expect(ff.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(ff.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000);
      expect((await p).status).toBe(503);
      expect(ff.calls).toHaveLength(6);
    } finally {
      random.mockRestore();
    }
  });

  it('retries network errors on idempotent requests only', async () => {
    const getFf = fakeFetch([{ url: API, reply: (_r, n) => (n === 0 ? { error: 'reset_after_send' } : { body: 'ok' }) }]);
    expect((await request(getFf.fetch, { url: API, retry: fast })).text).toBe('ok');
    expect(getFf.calls).toHaveLength(2);

    const postFf = fakeFetch([{ url: API, reply: { error: 'reset_after_send' } }]);
    const err = await failure(request(postFf.fetch, { url: API, method: 'POST', body: {}, retry: fast }));
    expect(postFf.calls).toHaveLength(1);
    expect(err.code).toBe('network');
    expect(err.notSent).toBe(false);

    const gscFf = fakeFetch([{ url: API, reply: (_r, n) => (n === 0 ? { error: 'network' } : { body: '{}' }) }]);
    expect((await request(gscFf.fetch, { url: API, method: 'POST', body: {}, idempotent: true, retry: fast })).status).toBe(200);
  });
});

describe('failures', () => {
  it('marks requests that never left as notSent (DNS, refused) and others as possibly sent', async () => {
    const ff = fakeFetch([
      { url: `${API}/dns`, reply: { error: 'dns' } },
      { url: `${API}/refused`, reply: { error: 'refused' } },
      { url: `${API}/reset`, reply: { error: 'reset_after_send' } },
    ]);
    const dns = await failure(request(ff.fetch, { url: `${API}/dns`, method: 'POST', retry: false }));
    expect(dns).toBeInstanceOf(StError);
    expect(dns).toMatchObject({ code: 'network', notSent: true, timedOut: false, attempts: 1, method: 'POST' });
    expect(dns.message).toBe('Could not reach api.example.test (ENOTFOUND).');
    expect((await failure(request(ff.fetch, { url: `${API}/refused`, retry: false }))).notSent).toBe(true);
    expect((await failure(request(ff.fetch, { url: `${API}/reset`, retry: false }))).notSent).toBe(false);
  });

  it('times out with AbortSignal.timeout and reports it', async () => {
    const ff = fakeFetch([{ url: API, reply: { delayMs: 2_000, body: 'late' } }]);
    const err = await failure(request(ff.fetch, { url: API, timeoutMs: 30, retry: false }));
    expect(err).toMatchObject({ code: 'network', timedOut: true, notSent: false });
    expect(err.message).toBe('Could not reach api.example.test (no answer within 30 ms).');
    const sim = fakeFetch([{ url: API, reply: { error: 'timeout' } }]);
    expect(await failure(request(sim.fetch, { url: API, retry: false }))).toMatchObject({ timedOut: true });
  });

  it('stops when the caller aborts, including during a backoff wait', async () => {
    const ff = fakeFetch([{ url: API, reply: { status: 503 } }]);
    const ctl = new AbortController();
    const p = request(ff.fetch, { url: API, signal: ctl.signal, retry: { attempts: 5, baseMs: 10_000, capMs: 10_000, on: [503] } });
    setTimeout(() => ctl.abort(), 20);
    const err = await failure(p);
    expect(err).toMatchObject({ code: 'network', cancelled: true });
    const pre = new AbortController();
    pre.abort();
    expect(await failure(request(ff.fetch, { url: API, signal: pre.signal }))).toMatchObject({ cancelled: true });
  });

  it('never puts query strings in messages', async () => {
    const ff = fakeFetch([{ url: 'https://api.example.test/x*', reply: { status: 500, body: '<html>oops</html>' } }]);
    const err = await failure(requestJson(ff.fetch, { url: 'https://api.example.test/x?key=fake-api-key-123456', retry: false }));
    expect(err.message).not.toContain('fake-api-key');
    expect(err.url).toBe('https://api.example.test/x');
  });
});

describe('requestJson', () => {
  it('parses JSON and asks for it', async () => {
    const ff = fakeFetch([{ url: API, reply: { body: { rows: [{ keys: ['2026-10-03'], clicks: 6 }] } } }]);
    const res = await requestJson<{ rows: { clicks: number }[] }>(ff.fetch, { url: API });
    expect(res.data.rows[0].clicks).toBe(6);
    expect(ff.calls[0].headers.accept).toBe('application/json');
  });

  it('returns non-2xx JSON bodies so callers can map Google and DataForSEO errors', async () => {
    const body = { error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)', error_subtype: 'invalid_rapt' };
    const ff = fakeFetch([{ method: 'POST', url: API, reply: { status: 400, body } }]);
    const res = await requestJson<typeof body>(ff.fetch, { url: API, method: 'POST', body: 'grant_type=refresh_token' });
    expect(res.status).toBe(400);
    expect(res.data.error_subtype).toBe('invalid_rapt');
  });

  it('drops __proto__ keys', async () => {
    const ff = fakeFetch([{ url: API, reply: { body: '{"__proto__":{"polluted":1},"ok":true}' } }]);
    const res = await requestJson<Record<string, unknown>>(ff.fetch, { url: API });
    expect(res.data).toEqual({ ok: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('throws StError(http) with status and a redacted, truncated body for non-JSON errors', async () => {
    const leaky = `<html>${'x'.repeat(600)} "access_token": "ya29.fake-token-abcdefghij" -----BEGIN PRIVATE KEY-----FAKE</html>`;
    const ff = fakeFetch([
      { url: `${API}/html`, reply: { status: 502, body: leaky } },
      { url: `${API}/bad`, reply: { status: 200, body: 'not json' } },
      { url: `${API}/empty`, reply: { status: 204 } },
      { url: `${API}/empty-error`, reply: { status: 401 } },
      { url: `${API}/big`, reply: { body: JSON.stringify({ a: 'x'.repeat(5000) }) } },
    ]);
    const err = await failure(requestJson(ff.fetch, { url: `${API}/html`, retry: false }));
    expect(err).toMatchObject({ code: 'http', status: 502 });
    expect(err.message).not.toContain('ya29.fake');
    expect((err.body ?? '').length).toBeLessThanOrEqual(503);
    expect(await failure(requestJson(ff.fetch, { url: `${API}/bad` }))).toMatchObject({ code: 'http', status: 200 });
    expect((await requestJson(ff.fetch, { url: `${API}/empty` })).data).toBeNull();
    expect(await failure(requestJson(ff.fetch, { url: `${API}/empty-error` }))).toMatchObject({ code: 'http', status: 401 });
    expect(await failure(requestJson(ff.fetch, { url: `${API}/big`, maxBytes: 100 }))).toMatchObject({ code: 'http' });
  });
});

describe('helpers', () => {
  it('retryAfterMs reads seconds and HTTP dates', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs('Tue, 06 Oct 2026 06:17:30 GMT', Date.parse('2026-10-06T06:17:00Z'))).toBe(30_000);
    expect(retryAfterMs('Tue, 06 Oct 2026 06:16:30 GMT', Date.parse('2026-10-06T06:17:00Z'))).toBe(0);
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('redactBody removes token fields, bearer tokens and keys, then cuts to 500 characters', () => {
    expect(redactBody('{"refresh_token":"fake-1","client_secret":"fake-2","ok":1}')).toBe('{"refresh_token":"[redacted]","client_secret":"[redacted]","ok":1}');
    expect(redactBody('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(redactBody('a'.repeat(800))).toHaveLength(503);
  });

  it('safeUrl keeps origin and path only', () => {
    expect(safeUrl('https://user:pw@api.example.test:8443/a/b?key=1#x')).toBe('https://api.example.test:8443/a/b');
    expect(safeUrl('nope')).toBe('(invalid URL)');
  });
});
