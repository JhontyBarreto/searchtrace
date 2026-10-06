// Test 54: sitemaps (index, .gz, entity decoding, DOCTYPE entities left unexpanded, hostile input).
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { request } from '../../src/http/request.js';
import { decodeXmlText, parseSitemapXml } from '../../src/sources/crawl/sitemap.js';
import { fakeFetch } from '../helpers/index.js';

describe('parseSitemapXml', () => {
  it('reads a urlset with loc and lastmod, decoding the five XML entities', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-09-01</lastmod></url>
  <url>
    <loc> https://example.com/b </loc>
  </url>
  <url><lastmod>2026-09-02</lastmod></url>
</urlset>`;
    const r = parseSitemapXml(xml);
    expect(r.kind).toBe('urlset');
    expect(r.entries).toEqual([
      { loc: 'https://example.com/a?x=1&y=2', lastmod: '2026-09-01' },
      { loc: 'https://example.com/b', lastmod: null },
    ]);
  });

  it('reads a sitemap index', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/s1.xml</loc></sitemap>
      <sitemap><loc>https://example.com/s2.xml.gz</loc><lastmod>2026-01-01</lastmod></sitemap>
    </sitemapindex>`;
    const r = parseSitemapXml(xml);
    expect(r.kind).toBe('index');
    expect(r.entries.map((e) => e.loc)).toEqual(['https://example.com/s1.xml', 'https://example.com/s2.xml.gz']);
  });

  it('handles CDATA, namespace prefixes and numeric character references', () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sm:url><sm:loc><![CDATA[https://example.com/c?a=1&b=2]]></sm:loc></sm:url>
      <sm:url><sm:loc>https://example.com/caf&#233;/&#x41;</sm:loc></sm:url>
    </sm:urlset>`;
    expect(parseSitemapXml(xml).entries.map((e) => e.loc)).toEqual(['https://example.com/c?a=1&b=2', 'https://example.com/café/A']);
  });

  it('leaves DOCTYPE-declared entities unexpanded (no DTD processing)', () => {
    const lol = '&lol;'.repeat(10);
    const xml = `<?xml version="1.0"?>
<!DOCTYPE urlset [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "${lol}">
  <!ENTITY evil SYSTEM "file:///etc/passwd">
]>
<urlset><url><loc>https://example.com/&evil;</loc></url><url><loc>https://example.com/&lol2;</loc></url></urlset>`;
    const r = parseSitemapXml(xml);
    expect(r.entries.map((e) => e.loc)).toEqual(['https://example.com/&evil;', 'https://example.com/&lol2;']);
    expect(decodeXmlText('&amp;&lt;&gt;&quot;&apos;&nbsp;')).toBe(`&<>"'&nbsp;`);
  });

  it('ignores locations inside comments', () => {
    const xml = '<urlset><!-- <url><loc>https://example.com/hidden</loc></url> --><url><loc>https://example.com/shown</loc></url></urlset>';
    expect(parseSitemapXml(xml).entries.map((e) => e.loc)).toEqual(['https://example.com/shown']);
  });

  it('returns unknown for non-sitemap content', () => {
    expect(parseSitemapXml('<html><body>Not found</body></html>')).toEqual({ kind: 'unknown', entries: [] });
  });

  it('stays linear on hostile input (thousands of unclosed tags)', () => {
    const xml = `<urlset>${'<url><loc>'.repeat(40_000)}<!-- ${'<!--'.repeat(20_000)}`;
    const started = performance.now();
    expect(parseSitemapXml(xml).entries).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('gzipped sitemaps through request()', () => {
  const xml = '<urlset><url><loc>https://example.com/gz</loc></url></urlset>';

  it('decompresses an .xml.gz body served without Content-Encoding', async () => {
    const ff = fakeFetch([{ url: 'https://example.com/s.xml.gz', reply: { headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(gzipSync(xml)) } }]);
    const res = await request(ff.fetch, { url: 'https://example.com/s.xml.gz', retry: false, gunzip: true });
    expect(res.text).toBe(xml);
    expect(parseSitemapXml(res.text).entries[0].loc).toBe('https://example.com/gz');
  });

  it('passes plain bodies through untouched', async () => {
    const ff = fakeFetch([{ url: 'https://example.com/s.xml', reply: { headers: { 'content-type': 'application/xml' }, body: xml } }]);
    const res = await request(ff.fetch, { url: 'https://example.com/s.xml', retry: false, gunzip: true });
    expect(res.text).toBe(xml);
  });

  it('cuts a gzip bomb off at maxBytes of decoded text', async () => {
    const bomb = gzipSync(Buffer.alloc(20_000_000, 0x41));
    expect(bomb.length).toBeLessThan(100_000);
    const ff = fakeFetch([{ url: 'https://example.com/bomb.xml.gz', reply: { body: new Uint8Array(bomb) } }]);
    const res = await request(ff.fetch, { url: 'https://example.com/bomb.xml.gz', retry: false, maxBytes: 1_000_000, gunzip: true });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBe(1_000_000);
  });

  it('leaves gzip bytes alone unless gunzip is asked for', async () => {
    const ff = fakeFetch([{ url: 'https://example.com/s.xml.gz', reply: { headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(gzipSync(xml)) } }]);
    const res = await request(ff.fetch, { url: 'https://example.com/s.xml.gz', retry: false });
    expect(res.text).not.toBe(xml);
  });

  it('marks a corrupt gzip body as cut short instead of throwing', async () => {
    const good = gzipSync(xml);
    const broken = new Uint8Array(good.subarray(0, Math.floor(good.length / 2)));
    const ff = fakeFetch([{ url: 'https://example.com/broken.xml.gz', reply: { body: broken } }]);
    const res = await request(ff.fetch, { url: 'https://example.com/broken.xml.gz', retry: false, gunzip: true });
    expect(res.truncated).toBe(true);
    expect(parseSitemapXml(res.text).entries).toEqual([]);
  });
});
