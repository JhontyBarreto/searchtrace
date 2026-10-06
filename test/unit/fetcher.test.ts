// Test 55: fetcher. Off-property redirects blocked, private IPs blocked, the decoded-size cap,
// challenge detection, conditional GET and 304 handling, plus the robots.txt status rules.
import { describe, expect, it } from 'vitest';
import { fetchPage, isChallenge, loadRobots, urlAllowed, USER_AGENT } from '../../src/sources/crawl/fetcher.js';
import { isAllowed } from '../../src/sources/crawl/robots.js';
import { fakeFetch } from '../helpers/index.js';

const PROPERTY = 'sc-domain:example.com';
const OPTS = { property: PROPERTY, userAgent: USER_AGENT, timeoutMs: 5000, maxBytes: 5_000_000 };
const HTML = { 'content-type': 'text/html; charset=utf-8' };

describe('urlAllowed', () => {
  it('accepts http(s) URLs on the property and refuses everything else', () => {
    expect(urlAllowed('https://example.com/a', PROPERTY)).toBe(true);
    expect(urlAllowed('http://blog.example.com/a', PROPERTY)).toBe(true);
    expect(urlAllowed('https://evil.example/a', PROPERTY)).toBe(false);
    expect(urlAllowed('ftp://example.com/a', PROPERTY)).toBe(false);
    expect(urlAllowed('https://user:pw@example.com/a', PROPERTY)).toBe(false);
    expect(urlAllowed('not a url', PROPERTY)).toBe(false);
  });

  it('refuses private hosts even when they are the property itself', () => {
    expect(urlAllowed('http://10.0.0.1/', 'http://10.0.0.1/')).toBe(false);
    expect(urlAllowed('http://127.0.0.1:8080/x', 'http://127.0.0.1:8080/')).toBe(false);
    expect(urlAllowed('http://localhost/', 'sc-domain:localhost')).toBe(false);
  });
});

describe('fetchPage', () => {
  it('fetches an HTML page with the searchtrace user agent and no automatic redirects', async () => {
    const ff = fakeFetch([{ url: 'https://example.com/a', reply: { headers: { ...HTML, etag: '"v1"', 'x-robots-tag': 'NoIndex' }, body: '<html><title>A</title></html>' } }]);
    const r = await fetchPage(ff.fetch, 'https://example.com/a', OPTS);
    expect(r.outcome).toBe('ok');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<title>A</title>');
    expect(r.etag).toBe('"v1"');
    expect(r.xRobotsTag).toBe('noindex');
    expect(ff.calls[0].headers['user-agent']).toBe(USER_AGENT);
  });

  it('follows an on-property redirect by hand and records the hops', async () => {
    const ff = fakeFetch([
      { url: 'https://example.com/old', reply: { status: 301, headers: { location: '/new' } } },
      { url: 'https://example.com/new', reply: { status: 302, headers: { location: 'https://www.example.com/final' } } },
      { url: 'https://www.example.com/final', reply: { headers: HTML, body: '<html></html>' } },
    ]);
    const r = await fetchPage(ff.fetch, 'https://example.com/old', OPTS);
    expect(r.outcome).toBe('ok');
    expect(r.redirects).toEqual(['https://example.com/new', 'https://www.example.com/final']);
    expect(r.finalUrl).toBe('https://www.example.com/final');
    expect(ff.unmatched()).toEqual([]);
  });

  it('blocks an off-property redirect without requesting it', async () => {
    const ff = fakeFetch([{ url: 'https://example.com/out', reply: { status: 302, headers: { location: 'https://evil.example/steal' } } }]);
    const r = await fetchPage(ff.fetch, 'https://example.com/out', OPTS);
    expect(r.outcome).toBe('off_property');
    expect(r.finalUrl).toBe('https://evil.example/steal');
    expect(ff.calls.map((c) => c.url)).toEqual(['https://example.com/out']);
  });

  it('blocks redirects to private and metadata addresses without requesting them', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:2375/', 'http://[::1]/', 'http://10.1.2.3/', 'javascript:alert(1)']) {
      const ff = fakeFetch([{ url: 'https://example.com/r', reply: { status: 307, headers: { location: target } } }]);
      const r = await fetchPage(ff.fetch, 'https://example.com/r', OPTS);
      expect(r.outcome).toBe('off_property');
      expect(ff.calls).toHaveLength(1);
    }
  });

  it('stops after 5 redirects', async () => {
    const ff = fakeFetch([{ url: /^https:\/\/example\.com\/loop/, reply: (req) => ({ status: 301, headers: { location: `${req.url}x` } }) }]);
    const r = await fetchPage(ff.fetch, 'https://example.com/loop', OPTS);
    expect(r.outcome).toBe('http_error');
    expect(r.redirects).toHaveLength(5);
    expect(ff.calls).toHaveLength(6);
  });

  it('marks a body over the 5 MB decoded cap as too_large', async () => {
    const big = `<html><body>${'a'.repeat(5_000_001)}</body></html>`;
    const ff = fakeFetch([{ url: 'https://example.com/big', reply: { headers: HTML, body: big } }]);
    const r = await fetchPage(ff.fetch, 'https://example.com/big', OPTS);
    expect(r.outcome).toBe('too_large');
    expect(r.html).toBeNull();
  });

  it('detects challenge pages', async () => {
    const ff = fakeFetch([
      { url: 'https://example.com/cf', reply: { status: 503, headers: { ...HTML, 'cf-mitigated': 'challenge' }, body: '<html></html>' } },
      { url: 'https://example.com/moment', reply: { status: 200, headers: HTML, body: '<html><head><title>Just a moment...</title></head></html>' } },
      { url: 'https://example.com/forbidden', reply: { status: 403, headers: HTML, body: '<html><title>Forbidden</title></html>' } },
    ]);
    expect((await fetchPage(ff.fetch, 'https://example.com/cf', OPTS)).outcome).toBe('blocked_challenge');
    expect((await fetchPage(ff.fetch, 'https://example.com/moment', OPTS)).outcome).toBe('blocked_challenge');
    expect((await fetchPage(ff.fetch, 'https://example.com/forbidden', OPTS)).outcome).toBe('http_error');
    expect(isChallenge(200, new Headers(), '<title class="x">Just a moment</title>')).toBe(true);
  });

  it('sends validators and maps a 304 to not_modified', async () => {
    const ff = fakeFetch([
      {
        url: 'https://example.com/same',
        reply: (req) => (req.headers['if-none-match'] === '"v1"' ? { status: 304 } : { headers: HTML, body: '<html></html>' }),
      },
    ]);
    const r = await fetchPage(ff.fetch, 'https://example.com/same', { ...OPTS, etag: '"v1"', lastModified: 'Tue, 01 Sep 2026 00:00:00 GMT' });
    expect(r.outcome).toBe('not_modified');
    expect(r.status).toBe(304);
    expect(ff.calls[0].headers['if-modified-since']).toBe('Tue, 01 Sep 2026 00:00:00 GMT');
  });

  it('maps errors, non-HTML bodies and network failures to outcomes', async () => {
    const ff = fakeFetch([
      { url: 'https://example.com/404', reply: { status: 404, headers: HTML, body: 'nope' } },
      { url: 'https://example.com/doc.pdf', reply: { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' } },
      { url: 'https://example.com/sniff', reply: { body: new TextEncoder().encode('<!DOCTYPE html><html></html>') } }, // no content-type
      { url: 'https://example.com/slow', reply: { error: 'timeout' } },
      { url: 'https://example.com/down', reply: { error: 'refused' } },
    ]);
    expect((await fetchPage(ff.fetch, 'https://example.com/404', OPTS)).outcome).toBe('http_error');
    expect((await fetchPage(ff.fetch, 'https://example.com/doc.pdf', OPTS)).outcome).toBe('not_html');
    expect((await fetchPage(ff.fetch, 'https://example.com/sniff', OPTS)).outcome).toBe('ok');
    expect((await fetchPage(ff.fetch, 'https://example.com/slow', OPTS)).outcome).toBe('timeout');
    expect((await fetchPage(ff.fetch, 'https://example.com/down', OPTS)).outcome).toBe('network_error');
  });

  it('never fetches a private starting URL', async () => {
    const ff = fakeFetch([]);
    const r = await fetchPage(ff.fetch, 'http://127.0.0.1/', { ...OPTS, property: 'http://127.0.0.1/' });
    expect(r.outcome).toBe('off_property');
    expect(ff.calls).toHaveLength(0);
  });
});

describe('loadRobots', () => {
  const opts = { property: PROPERTY, userAgent: USER_AGENT, timeoutMs: 5000 };

  it('parses a 200, allows everything on a 4xx, and disallows everything on a 5xx or network error', async () => {
    const ff = fakeFetch([
      { url: 'https://a.example.com/robots.txt', reply: { body: 'User-agent: *\nDisallow: /x\n' } },
      { url: 'https://b.example.com/robots.txt', reply: { status: 404 } },
      { url: 'https://c.example.com/robots.txt', reply: { status: 503 } },
      { url: 'https://d.example.com/robots.txt', reply: { error: 'network' } },
      { url: 'https://e.example.com/robots.txt', reply: { status: 429 } },
    ]);
    const a = await loadRobots(ff.fetch, 'https://a.example.com/', opts);
    expect(a.state).toBe('parsed');
    expect(isAllowed(a.rules, '/x')).toBe(false);
    expect(isAllowed(a.rules, '/y')).toBe(true);
    const b = await loadRobots(ff.fetch, 'https://b.example.com/', opts);
    expect(b.state).toBe('unavailable');
    expect(isAllowed(b.rules, '/anything')).toBe(true);
    for (const host of ['c', 'd', 'e']) {
      const r = await loadRobots(ff.fetch, `https://${host}.example.com/`, opts);
      expect(r.state).toBe('unreachable');
      expect(isAllowed(r.rules, '/anything')).toBe(false);
    }
  });
});
