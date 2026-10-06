import { describe, expect, it } from 'vitest';
import { OTHER_PAGES, clusterTemplates } from '../../src/core/templates.js';

const SITE = 'https://example-agency.test';

/** A synthetic site shaped like the real test property (0.2 F5): 174 posts, 7 services, 7 case studies, singletons. */
function agencyFixture(): string[] {
  const urls = [`${SITE}/`, `${SITE}/about/`, `${SITE}/contact/`, `${SITE}/pricing/`, `${SITE}/blog/`, `${SITE}/services/`, `${SITE}/case-studies/`];
  for (let k = 0; k < 174; k++) urls.push(`${SITE}/blog/post-about-topic-${k}/`);
  for (const s of ['seo', 'link-building', 'local-seo', 'ppc', 'content', 'technical-seo', 'web-design']) urls.push(`${SITE}/services/${s}/`);
  for (let k = 0; k < 7; k++) urls.push(`${SITE}/case-studies/client-${k}/`);
  urls.push(`${SITE}/privacy-policy/`, `${SITE}/terms/`);
  return urls;
}

function counts(m: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of m.values()) out[key] = (out[key] ?? 0) + 1;
  return out;
}

describe('clusterTemplates (test 47, spec 5.9)', () => {
  it('gives /blog/* (174), /services/* (7), /case-studies/* (7) and other pages on the agency fixture', () => {
    const urls = agencyFixture();
    const m = clusterTemplates(urls);
    expect(m.size).toBe(urls.length);
    expect(counts(m)).toEqual({ '/blog/*': 174, '/services/*': 7, '/case-studies/*': 7, [OTHER_PAGES]: 9 });
    expect(m.get(`${SITE}/`)).toBe(OTHER_PAGES);
    expect(m.get(`${SITE}/blog/`)).toBe(OTHER_PAGES);
    expect(m.get(`${SITE}/blog/post-about-topic-3/`)).toBe('/blog/*');
  });

  it('keys the map by the input strings, and ignores fragments and query strings for the template', () => {
    const urls = [`${SITE}/blog/a#x`, `${SITE}/blog/b?utm_source=x`, `${SITE}/blog/c`, `${SITE}/blog/d`];
    const m = clusterTemplates(urls);
    expect([...m.keys()]).toEqual(urls);
    expect(new Set(m.values())).toEqual(new Set(['/blog/*']));
  });

  it('treats numeric, date, hex and UUID segments as variable regardless of siblings', () => {
    const urls = [
      `${SITE}/product/1001`, `${SITE}/product/1002`, `${SITE}/product/1004`, `${SITE}/product/1003/reviews`,
      `${SITE}/2024/05/first-post`, `${SITE}/2024/06/second-post`, `${SITE}/2025/01/third-post`,
      `${SITE}/u/3f2a9c1d77`, `${SITE}/u/deadbeef00`, `${SITE}/u/0b1c2d3e4f`,
      `${SITE}/o/123e4567-e89b-12d3-a456-426614174000/view`, `${SITE}/o/223e4567-e89b-12d3-a456-426614174000/view`,
      `${SITE}/o/323e4567-e89b-12d3-a456-426614174000/view`,
      `${SITE}/archive/2026-10-03`, `${SITE}/archive/2026-10`, `${SITE}/archive/2026-09-01`,
    ];
    const m = clusterTemplates(urls);
    expect(m.get(`${SITE}/product/1001`)).toBe('/product/*');
    expect(m.get(`${SITE}/product/1003/reviews`)).toBe(OTHER_PAGES); // '/product/*/reviews' has 1 page
    expect(m.get(`${SITE}/2024/05/first-post`)).toBe('/*/*/*');
    expect(m.get(`${SITE}/u/3f2a9c1d77`)).toBe('/u/*');
    expect(m.get(`${SITE}/o/223e4567-e89b-12d3-a456-426614174000/view`)).toBe('/o/*/view');
    expect(m.get(`${SITE}/archive/2026-10`)).toBe('/archive/*');
  });

  it('only collapses children with at most one descendant, and never at the site root', () => {
    const urls = [
      `${SITE}/docs/install`, `${SITE}/docs/configure`, `${SITE}/docs/faq`,
      `${SITE}/docs/api/a`, `${SITE}/docs/api/b`, `${SITE}/docs/api/c`, `${SITE}/docs/api/d`,
      `${SITE}/one`, `${SITE}/two`, `${SITE}/three`, `${SITE}/four`,
    ];
    const m = clusterTemplates(urls);
    expect(m.get(`${SITE}/docs/install`)).toBe('/docs/*');
    expect(m.get(`${SITE}/docs/api/b`)).toBe('/docs/api/*');
    for (const u of [`${SITE}/one`, `${SITE}/two`, `${SITE}/three`, `${SITE}/four`]) expect(m.get(u)).toBe(OTHER_PAGES);
  });

  it('keeps a child with one descendant inside the template (an /amp page under each post)', () => {
    const urls = [`${SITE}/news/a`, `${SITE}/news/a/amp`, `${SITE}/news/b`, `${SITE}/news/b/amp`, `${SITE}/news/c`, `${SITE}/news/c/amp`];
    const m = clusterTemplates(urls);
    expect(m.get(`${SITE}/news/b`)).toBe('/news/*');
    expect(m.get(`${SITE}/news/b/amp`)).toBe('/news/*/amp');
  });

  it('merges templates with fewer than 3 pages into other pages', () => {
    const m = clusterTemplates([`${SITE}/team/a/x`, `${SITE}/team/b/y`, `${SITE}/team/c/z`, `${SITE}/legal/a`, `${SITE}/legal/b`]);
    expect(m.get(`${SITE}/legal/a`)).toBe(OTHER_PAGES);
    expect(m.get(`${SITE}/team/a/x`)).toBe('/team/*/*'); // three members, each with one page below
  });

  it('lets glob overrides win, even for small groups, in the order given', () => {
    const urls = [...agencyFixture(), `${SITE}/landing/spring-offer`, `${SITE}/landing/summer-offer`];
    const m = clusterTemplates(urls, [
      { glob: '/landing/**', name: 'Landing pages' },
      { glob: '/services/*', name: 'Services' },
      { glob: '/services/**', name: 'Never used' },
      { glob: '/', name: 'Home' },
    ]);
    expect(m.get(`${SITE}/landing/spring-offer`)).toBe('Landing pages');
    expect(m.get(`${SITE}/services/seo/`)).toBe('Services');
    expect(m.get(`${SITE}/`)).toBe('Home');
    expect(m.get(`${SITE}/blog/post-about-topic-1/`)).toBe('/blog/*');
    const full = clusterTemplates([`${SITE}/a`, 'https://shop.example-agency.test/a'], [{ glob: 'https://shop.*/**', name: 'Shop' }]);
    expect(full.get('https://shop.example-agency.test/a')).toBe('Shop');
  });

  it('puts unparseable input in other pages instead of throwing', () => {
    const m = clusterTemplates(['not a url', 'mailto:x@example.com']);
    expect([...m.values()]).toEqual([OTHER_PAGES, OTHER_PAGES]);
  });

  it('is deterministic and independent of input order', () => {
    const urls = agencyFixture();
    const a = clusterTemplates(urls);
    const b = clusterTemplates([...urls].reverse());
    for (const u of urls) expect(b.get(u)).toBe(a.get(u));
  });
});
