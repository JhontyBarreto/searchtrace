// Test 58 (and the googleSeen half of 39): deriveSiteChanges. A title suffix change on 40 pages is
// one SiteChange with 40 touched URLs; an ok -> blocked pair is never diffed; googleSeen dating.
import { describe, expect, it } from 'vitest';
import { ptDate, ptDayStart } from '../../src/core/time.js';
import type { Annotation, InspectionRecord, PageFields, SnapshotRecord } from '../../src/core/types.js';
import { deriveSiteChanges, diffFields, diffShape, googleSeenFor } from '../../src/sources/crawl/diff.js';
import { fieldsHashOf } from '../../src/sources/crawl/extract.js';

function fields(over: Partial<PageFields> = {}): PageFields {
  return {
    title: 'Page',
    metaDescription: null,
    metaRobots: null,
    xRobotsTag: null,
    canonical: null,
    h1: ['Heading'],
    lang: 'en',
    siteName: 'Brand',
    wordCount: 300,
    textHash: 'a'.repeat(64),
    simhash: '0123456789abcdef',
    jsonLdTypes: [],
    internalLinks: [],
    externalLinkCount: 0,
    hreflangCount: 0,
    ...over,
  };
}

function snap(url: string, fetchedAt: string, f: PageFields | null, over: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return { url, fetchedAt, outcome: f ? 'ok' : 'blocked_challenge', status: f ? 200 : 503, finalUrl: url, redirects: [], fieldsHash: f ? fieldsHashOf(f) : null, ...over };
}

const at = (base: string, seconds: number): string => new Date(Date.parse(base) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('diffShape', () => {
  it('keeps only the changed part, digits as #', () => {
    expect(diffShape('Post 1 | Brand', 'Post 1 - Brand')).toBe('|->-');
    expect(diffShape('Post 22 | Brand', 'Post 22 - Brand')).toBe('|->-');
    expect(diffShape('Best boilers 2025', 'Best boilers 2026')).toBe('#->#');
    expect(diffShape(null, 'noindex')).toBe('(none)->noindex');
    expect(diffShape('https://x.com/a/', 'https://x.com/a')).toBe('/->');
  });
});

describe('diffFields', () => {
  it('reports every changed field and nothing else', () => {
    const a = fields({ internalLinks: ['https://x.com/a', 'https://x.com/b'] });
    const b = fields({ title: 'New', metaRobots: 'noindex', internalLinks: ['https://x.com/b', 'https://x.com/c'], simhash: 'fedcba9876543210', wordCount: 500 });
    const d = diffFields(a, b);
    expect(d.map((x) => x.field)).toEqual(['title', 'metaRobots', 'internalLinks', 'body']);
    expect(d.find((x) => x.field === 'internalLinks')).toMatchObject({ before: '/a', after: '/c' });
    expect(d.find((x) => x.field === 'body')).toMatchObject({ before: '300 words', after: '500 words' });
    expect(diffFields(a, a)).toEqual([]);
  });
});

describe('deriveSiteChanges', () => {
  const RUN1 = '2026-09-01T10:00:00Z';
  const RUN2 = '2026-09-02T10:00:00Z';

  it('groups a title suffix change on 40 pages into one SiteChange with 40 touched URLs', () => {
    const snapshots: SnapshotRecord[] = [];
    const byHash = new Map<string, PageFields>();
    const templates = new Map<string, string>();
    for (let k = 0; k < 40; k++) {
      const url = `https://example.com/blog/post-${k}`;
      templates.set(url, '/blog/*');
      const before = fields({ title: `Post ${k} | Brand` });
      const after = fields({ title: `Post ${k} - Brand` });
      byHash.set(fieldsHashOf(before), before);
      byHash.set(fieldsHashOf(after), after);
      snapshots.push(snap(url, at(RUN1, k * 2), before), snap(url, at(RUN2, k * 2), after));
    }
    // An unchanged page in the same template, and a page whose title changed differently.
    const same = fields({ title: 'Stable | Brand' });
    const other0 = fields({ title: 'About us' });
    const other1 = fields({ title: 'About the team' });
    for (const f of [same, other0, other1]) byHash.set(fieldsHashOf(f), f);
    snapshots.push(snap('https://example.com/blog/stable', at(RUN1, 100), same), snap('https://example.com/blog/stable', at(RUN2, 100), same));
    snapshots.push(snap('https://example.com/about', at(RUN1, 101), other0), snap('https://example.com/about', at(RUN2, 101), other1));

    const changes = deriveSiteChanges({ snapshots, fieldsByHash: byHash, annotations: [], inspections: [], templates });
    expect(changes).toHaveLength(2);
    const blog = changes.find((c) => c.templateKey === '/blog/*');
    expect(blog).toBeDefined();
    expect(blog?.touched).toHaveLength(40);
    expect(blog).toMatchObject({ source: 'snapshot', field: 'title', cls: 'snippet', signature: 'title:|->-:/blog/*', text: null });
    expect(blog?.deployed).toEqual({ from: RUN1, to: at(RUN2, 78), precision: 'bounded' });
    expect(blog?.touched[0]).toMatchObject({ before: 'Post 0 | Brand', after: 'Post 0 - Brand', googleSeen: null });
    expect(blog?.id).toMatch(/^sitechg_[a-z2-7]{12}$/);
    // Deterministic.
    expect(deriveSiteChanges({ snapshots: [...snapshots].reverse(), fieldsByHash: byHash, annotations: [], inspections: [], templates })).toEqual(changes);
  });

  it('never diffs an ok -> blocked pair, and diffs across the blocked gap', () => {
    const a = fields({ title: 'A' });
    const b = fields({ title: 'B' });
    const byHash = new Map([[fieldsHashOf(a), a], [fieldsHashOf(b), b]]);
    const url = 'https://example.com/p';
    const okThenBlocked = [snap(url, RUN1, a), snap(url, RUN2, null)];
    expect(deriveSiteChanges({ snapshots: okThenBlocked, fieldsByHash: byHash, annotations: [], inspections: [], templates: new Map() })).toEqual([]);
    const timeout = { ...snap(url, '2026-09-03T10:00:00Z', null), outcome: 'timeout' as const, status: null };
    const across = [snap(url, RUN1, a), snap(url, RUN2, null), timeout, snap(url, '2026-09-04T10:00:00Z', b)];
    const changes = deriveSiteChanges({ snapshots: across, fieldsByHash: byHash, annotations: [], inspections: [], templates: new Map() });
    expect(changes).toHaveLength(1);
    expect(changes[0].deployed).toEqual({ from: RUN1, to: '2026-09-04T10:00:00Z', precision: 'bounded' });
  });

  it('treats a not_modified snapshot as the same fields and records a redirect as a status change', () => {
    const a = fields();
    const byHash = new Map([[fieldsHashOf(a), a]]);
    const url = 'https://example.com/p';
    const snaps = [
      snap(url, RUN1, a),
      { ...snap(url, RUN2, a), outcome: 'not_modified' as const, status: 304 },
      { ...snap(url, '2026-09-03T10:00:00Z', a), redirects: ['https://example.com/q'], finalUrl: 'https://example.com/q' },
    ];
    const changes = deriveSiteChanges({ snapshots: snaps, fieldsByHash: byHash, annotations: [], inspections: [], templates: new Map() });
    expect(changes.map((c) => [c.field, c.cls, c.touched[0].before, c.touched[0].after])).toEqual([['status', 'technical', '2xx', '3xx']]);
  });

  it('dates when Google saw the change from inspections (4.3)', () => {
    const a = fields({ title: 'A' });
    const b = fields({ title: 'B' });
    const byHash = new Map([[fieldsHashOf(a), a], [fieldsHashOf(b), b]]);
    const url = 'https://example.com/p';
    const insp = (inspectedAt: string, lastCrawlTime?: string): InspectionRecord => ({ url, inspectedAt, reason: 'post_change', verdict: 'PASS', lastCrawlTime });
    const inspections = [
      insp('2026-08-30T00:00:00Z', '2026-08-29T00:00:00Z'),
      insp('2026-09-05T00:00:00Z', '2026-08-29T00:00:00Z'), // still not recrawled on the 5th
      insp('2026-09-25T00:00:00Z', '2026-09-24T03:00:00Z'), // recrawled
      insp('2026-09-28T00:00:00Z', '2026-09-27T00:00:00Z'),
    ];
    const changes = deriveSiteChanges({ snapshots: [snap(url, RUN1, a), snap(url, RUN2, b)], fieldsByHash: byHash, annotations: [], inspections, templates: new Map() });
    const seen = changes[0].touched[0].googleSeen;
    expect(seen).toEqual({ from: '2026-09-05T00:00:00Z', to: '2026-09-24T03:00:00Z', precision: 'bounded' });
    expect(ptDate(seen?.to ?? '')).toBe('2026-09-23'); // 03:00Z is still the 23rd in Pacific Time
    const byUrl = new Map([[url, [{ inspectedAt: Date.parse('2026-09-05T00:00:00Z'), lastCrawl: Date.parse('2026-08-29T00:00:00Z') }]]]);
    expect(googleSeenFor(url, RUN2, byUrl)).toBeNull();
  });

  it('turns annotations into day-wide SiteChanges', () => {
    const a: Annotation = { id: 'a1', at: '2026-09-10T00:00:00Z', date: '2026-09-09', text: 'New title template', urls: ['https://example.com/blog/a', 'https://example.com/blog/b'], field: 'title' };
    const templates = new Map([['https://example.com/blog/a', '/blog/*'], ['https://example.com/blog/b', '/blog/*']]);
    const [c] = deriveSiteChanges({ snapshots: [], fieldsByHash: new Map(), annotations: [a], inspections: [], templates });
    expect(c).toMatchObject({ source: 'annotation', field: 'title', cls: 'snippet', templateKey: '/blog/*', text: 'New title template' });
    expect(c.deployed).toEqual({ from: ptDayStart('2026-09-09'), to: ptDayStart('2026-09-10'), precision: 'unknown' });
    expect(c.touched.map((t) => t.url)).toEqual(['https://example.com/blog/a', 'https://example.com/blog/b']);
  });
});
