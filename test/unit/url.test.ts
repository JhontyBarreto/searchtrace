import { describe, expect, it } from 'vitest';
import {
  defaultOrigins, domainMatches, isOnProperty, isPrivateHost, normalizeUrl, pathOf, siteDomainOf,
} from '../../src/core/url.js';
import { StError } from '../../src/core/errors.js';

describe('normalizeUrl, the join contract (test 69)', () => {
  const table: [string, string][] = [
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com:443/blog/x#section-2', 'https://example.com/blog/x'],
    ['http://example.com:80/a/', 'http://example.com/a/'],
    ['https://example.com:8443/a', 'https://example.com:8443/a'],
    ['https://example.com/blog/', 'https://example.com/blog/'],
    ['https://example.com/blog', 'https://example.com/blog'],
    ['https://example.com/a?b=1&a=2', 'https://example.com/a?b=1&a=2'],
    ['https://example.com/a?', 'https://example.com/a'],
    ['https://example.com/a?#top', 'https://example.com/a'],
    ['https://example.com/%7euser/%2f%3a', 'https://example.com/~user/%2F%3A'],
    ['https://example.com/a?q=%7e%2f', 'https://example.com/a?q=~%2F'],
    ['https://user:secret@example.com/x', 'https://example.com/x'],
    ['https://example.com./x', 'https://example.com/x'],
    ['https://example.com/a/./b/../c', 'https://example.com/a/c'],
    ['  https://example.com/café  ', 'https://example.com/caf%C3%A9'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
    ['https://www.example.com/', 'https://www.example.com/'],
  ];

  it.each(table)('%s -> %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const [input] of table) expect(normalizeUrl(normalizeUrl(input))).toBe(normalizeUrl(input));
  });

  it('keeps www, scheme and trailing-slash differences (they are different URLs to Google)', () => {
    expect(normalizeUrl('https://www.example.com/')).not.toBe(normalizeUrl('https://example.com/'));
    expect(normalizeUrl('http://example.com/')).not.toBe(normalizeUrl('https://example.com/'));
    expect(normalizeUrl('https://example.com/a/')).not.toBe(normalizeUrl('https://example.com/a'));
  });

  it('throws on anything that is not an absolute http(s) URL', () => {
    for (const bad of ['mailto:a@example.com', '/relative/path', 'javascript:alert(1)', '', 'ftp://example.com/', 'not a url']) {
      expect(() => normalizeUrl(bad)).toThrow(StError);
    }
  });
});

describe('property helpers', () => {
  it('siteDomainOf', () => {
    expect(siteDomainOf('sc-domain:seoengico.com')).toBe('seoengico.com');
    expect(siteDomainOf('https://www.x.com/')).toBe('x.com');
    expect(siteDomainOf('https://shop.x.com/en/')).toBe('shop.x.com');
    expect(siteDomainOf('sc-domain:Example.COM')).toBe('example.com');
  });

  it('domainMatches is the domain or a subdomain, case-insensitive', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('WWW.Example.com', 'example.com')).toBe(true);
    expect(domainMatches('blog.example.com.', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('example.com.evil.net', 'example.com')).toBe(false);
    expect(domainMatches('example.com', '')).toBe(false);
  });

  it('isOnProperty: a Domain property covers every subdomain and scheme', () => {
    const p = 'sc-domain:example.com';
    expect(isOnProperty('https://example.com/a', p)).toBe(true);
    expect(isOnProperty('http://www.example.com/', p)).toBe(true);
    expect(isOnProperty('https://shop.example.com/x', p)).toBe(true);
    expect(isOnProperty('https://example.org/', p)).toBe(false);
    expect(isOnProperty('https://notexample.com/', p)).toBe(false);
    expect(isOnProperty('mailto:x@example.com', p)).toBe(false);
    expect(isOnProperty('garbage', p)).toBe(false);
  });

  it('isOnProperty: a URL-prefix property covers its exact prefix only', () => {
    const p = 'https://www.example.com/';
    expect(isOnProperty('https://www.example.com/a', p)).toBe(true);
    expect(isOnProperty('https://www.example.com', p)).toBe(true);
    expect(isOnProperty('https://example.com/a', p)).toBe(false);
    expect(isOnProperty('http://www.example.com/a', p)).toBe(false);
    const sub = 'https://example.com/blog/';
    expect(isOnProperty('https://example.com/blog/post', sub)).toBe(true);
    expect(isOnProperty('https://example.com/about', sub)).toBe(false);
  });

  it('pathOf keeps the query string and drops the fragment', () => {
    expect(pathOf('https://example.com/')).toBe('/');
    expect(pathOf('https://example.com/a/b?c=1#d')).toBe('/a/b?c=1');
    expect(pathOf('/already/a/path#x')).toBe('/already/a/path');
  });

  it('defaultOrigins', () => {
    expect(defaultOrigins('sc-domain:seoengico.com')).toEqual(['https://seoengico.com/', 'https://www.seoengico.com/']);
    expect(defaultOrigins('sc-domain:www.example.com')).toEqual(['https://www.example.com/']);
    expect(defaultOrigins('https://www.example.com/shop/')).toEqual(['https://www.example.com/']);
  });
});

describe('isPrivateHost', () => {
  const privateHosts = [
    'localhost', 'LOCALHOST.', 'app.localhost', 'printer.local', 'db.internal', 'intranet', '',
    '127.0.0.1', '127.1.2.3', '10.0.0.8', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1',
    '2130706433', '0x7f.1', '017700000001',
    '::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2001:db8::1', 'not a host!',
  ];
  const publicHosts = ['example.com', 'www.seoengico.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];

  it.each(privateHosts)('%s is private', (h) => expect(isPrivateHost(h)).toBe(true));
  it.each(publicHosts)('%s is public', (h) => expect(isPrivateHost(h)).toBe(false));
});
