// Test 56: extraction. Fixture HTML to fields, JSON-LD @graph, malformed JSON-LD ignored, main-text selection.
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/ids.js';
import { canonicalJson, extractFields, fieldsHashOf } from '../../src/sources/crawl/extract.js';
import { simhash64 } from '../../src/sources/crawl/simhash.js';

const PROPERTY = 'sc-domain:example.com';
const PAGE = 'https://example.com/blog/post-1';

const FIXTURE = `<!doctype html>
<html lang="EN-gb">
<head>
  <meta charset="utf-8">
  <title>  Fixing a   leaky tap | Pipewell  </title>
  <meta name="description" content="How to fix a leaky tap &amp; save water.">
  <meta name="robots" content="Index, Follow">
  <meta name="googlebot" content="max-snippet:50">
  <meta property="og:site_name" content="Pipewell Plumbing">
  <link rel="canonical" href="/blog/post-1?utm=x#top">
  <link rel="alternate" hreflang="en-gb" href="https://example.com/blog/post-1">
  <link rel="alternate" hreflang="fr" href="https://example.com/fr/blog/post-1">
  <style>.x { color: red }</style>
  <script>var ignored = "script words";</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"WebSite","name":"Pipewell Site"},
    {"@type":["Organization","LocalBusiness"],"name":"Pipewell Ltd"},
    {"@type":"BreadcrumbList"},
    {"@type":"Article","author":{"@type":"Person","name":"Sam"}}
  ]}</script>
  <script type="application/ld+json">{ this is not json </script>
  <script type="application/ld+json">{"@type":"http://schema.org/FAQPage","__proto__":{"polluted":true}}</script>
</head>
<body>
  <header><nav><a href="/">Home</a> <a href="/services/">Services</a></nav><h1>Site header heading</h1></header>
  <main>
    <h1>Fixing a <em>leaky</em> tap</h1>
    <p>Turn off the water supply first. Then remove the handle carefully.</p>
    <svg><title>icon title</title><text>svg words</text></svg>
    <noscript>noscript words</noscript>
    <p>Read <a href="/blog/post-2#comments">the next post</a>, <a href="https://www.example.com/blog/post-3">another</a>,
       <a href="https://other.example/x">a partner</a>, <a href="https://other.example/x#y">same partner</a>,
       <a href="mailto:hi@example.com">email us</a>, <a href="#top">top</a>, <a href="javascript:void(0)">js</a>.</p>
  </main>
  <aside>Sidebar words</aside>
  <footer>Footer words <a href="/contact">Contact</a></footer>
</body>
</html>`;

describe('extractFields', () => {
  const f = extractFields(FIXTURE, PAGE, PROPERTY);

  it('reads the head fields', () => {
    expect(f.title).toBe('Fixing a leaky tap | Pipewell');
    expect(f.metaDescription).toBe('How to fix a leaky tap & save water.');
    expect(f.metaRobots).toBe('index, follow, googlebot: max-snippet:50');
    expect(f.xRobotsTag).toBeNull();
    expect(f.canonical).toBe('https://example.com/blog/post-1?utm=x');
    expect(f.lang).toBe('en-gb');
    expect(f.siteName).toBe('Pipewell Plumbing');
    expect(f.hreflangCount).toBe(2);
  });

  it('collects h1 text from the whole page, first three', () => {
    expect(f.h1).toEqual(['Site header heading', 'Fixing a leaky tap']);
  });

  it('walks JSON-LD @graph, ignores malformed blocks and keeps types sorted and unique', () => {
    expect(f.jsonLdTypes).toEqual(['Article', 'BreadcrumbList', 'FAQPage', 'LocalBusiness', 'Organization', 'WebSite']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('separates internal and external links', () => {
    expect(f.internalLinks).toEqual([
      'https://example.com/',
      'https://example.com/blog/post-2',
      'https://example.com/contact',
      'https://example.com/services/',
      'https://www.example.com/blog/post-3',
    ]);
    expect(f.externalLinkCount).toBe(1);
  });

  it('takes the main text from <main>, without script, style, svg or noscript', () => {
    const main = 'Fixing a leaky tap Turn off the water supply first. Then remove the handle carefully. Read the next post, another, a partner, same partner, email us, top, js.';
    expect(f.textHash).toBe(sha256Hex(main));
    expect(f.simhash).toBe(simhash64(main));
    expect(f.wordCount).toBe(main.match(/\p{L}+/gu)?.length);
  });

  it('falls back to <article>, then to the body minus page chrome', () => {
    const article = extractFields('<body><nav>Menu</nav><article><p>Alpha beta</p></article><article>Gamma</article><p>Outside</p></body>', PAGE, PROPERTY);
    expect(article.wordCount).toBe(3);
    const body = extractFields('<html><head><title>T</title></head><body><header>Top</header><nav>Menu</nav><p>Only these words</p><footer>Bottom</footer></body></html>', PAGE, PROPERTY);
    expect(body.wordCount).toBe(3);
    expect(body.textHash).toBe(sha256Hex('Only these words'));
  });

  it('uses <base href> to resolve links and siteName falls back to JSON-LD', () => {
    const r = extractFields(
      '<head><base href="https://example.com/docs/"><script type="application/ld+json">[{"@type":"WebSite","name":"Docs Site"}]</script></head><body><a href="intro">x</a></body>',
      'https://example.com/other/page',
      PROPERTY,
    );
    expect(r.internalLinks).toEqual(['https://example.com/docs/intro']);
    expect(r.siteName).toBe('Docs Site');
    const org = extractFields('<script type="application/ld+json">{"@type":"Organization","name":"Org Name"}</script>', PAGE, PROPERTY);
    expect(org.siteName).toBe('Org Name');
  });

  it('copes with an empty or broken document', () => {
    const r = extractFields('', PAGE, PROPERTY);
    expect(r).toMatchObject({ title: null, metaDescription: null, canonical: null, h1: [], wordCount: 0, jsonLdTypes: [], internalLinks: [] });
    const broken = extractFields('<html><title>Unclosed <b>title', PAGE, PROPERTY);
    expect(broken.wordCount).toBe(0);
  });

  it('counts letters in any script', () => {
    expect(extractFields('<main>Привет мир, こんにちは 2026</main>', PAGE, PROPERTY).wordCount).toBe(3);
  });
});

describe('fieldsHashOf', () => {
  it('hashes canonical JSON, so key order never matters', () => {
    const f = extractFields(FIXTURE, PAGE, PROPERTY);
    const reordered = Object.fromEntries(Object.entries(f).reverse()) as typeof f;
    expect(fieldsHashOf(reordered)).toBe(fieldsHashOf(f));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(fieldsHashOf({ ...f, title: 'Other' })).not.toBe(fieldsHashOf(f));
  });
});
