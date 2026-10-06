// Test 71 (XSS fixtures inert in HTML and Markdown, CSP, no script, safe links, size) and
// test 48, F part (findings.json is byte-stable for fixed inputs), plus report structure (6.5, 6.6).
import { describe, expect, it } from 'vitest';
import type { AnalysisOutput } from '../../src/core/types.js';
import { renderReports } from '../../src/report/html.js';
import { canonicalString, renderFindingsJson, stableStringify } from '../../src/report/json.js';
import { XSS, makeAnalysisOutput, makeReportContext } from './report-fixture.js';

function shuffleKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(shuffleKeys) as T;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).reverse();
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = shuffleKeys((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
}

describe('HTML and Markdown reports (test 71)', () => {
  const out = makeAnalysisOutput({ xss: true });
  const { html, md } = renderReports(out, makeReportContext());

  it('renders XSS payloads inert in HTML', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
    for (const t of tags) expect(t).not.toMatch(/\son\w+\s*=/i); // no event-handler attributes on any real element
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/<a [^>]*href="(?!https:)/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('has the CSP meta, no script element and only safe external links', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
    const blanks = html.match(/<a [^>]*target="_blank"[^>]*>/g) ?? [];
    expect(blanks.length).toBeGreaterThan(0);
    for (const a of blanks) expect(a).toContain('rel="noopener noreferrer"');
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    for (const a of anchors) expect(a).toContain('target="_blank"');
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http[^"]*\.css/);
    expect(html).not.toMatch(/@import|url\(http/);
  });

  it('stays under 300 KB', () => {
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(300_000);
  });

  it('renders XSS payloads inert in Markdown', () => {
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toContain('<img');
    expect(md).not.toMatch(/\]\(javascript:/i);
    expect(md).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(md).not.toMatch(/(^|[^\\&#])@\w/m);
  });

  it('keeps sections in the 6.5 order', () => {
    const order = ['The answer', 'Where the clicks went', 'Timeline', 'Google update scorecard', 'Pages and sections that moved',
      'Searches that moved', 'Your site changes', "What we checked and what we couldn't", 'What gets smarter next', 'Run ledger'];
    let last = -1;
    for (const h of order) {
      const i = Math.max(html.indexOf(`<h2>${h}</h2>`), html.indexOf(`<h2>${h.replace("'", '&#39;')}</h2>`));
      expect(i, h).toBeGreaterThan(last);
      last = i;
      const j = md.indexOf(`## ${h}`);
      expect(j, h).toBeGreaterThan(-1);
    }
  });

  it('puts the headline sentence first', () => {
    const clean = makeAnalysisOutput();
    const r = renderReports(clean, makeReportContext());
    const answer = r.html.indexOf('In the last 28 days Google sent you 80 clicks, 9 fewer than the 28 days before (-10%).');
    expect(answer).toBeGreaterThan(-1);
    expect(answer).toBeLessThan(r.html.indexOf('Where the clicks went'));
    expect(r.md).toContain('In the last 28 days Google sent you 80 clicks, 9 fewer than the 28 days before (-10%).');
    expect(r.html).toContain('Page totals 252 clicks, property total 252.');
    expect(r.html).toContain('Show the maths');
  });

  it('shows only the boring line when nothing changed', () => {
    const r = renderReports(makeAnalysisOutput({ boring: true }), makeReportContext());
    expect(r.html).toContain('Nothing important changed. Clicks and impressions stayed within their normal range.');
    expect(r.html).not.toContain('Is it real?');
  });

  it('marks the demo', () => {
    const r = renderReports(makeAnalysisOutput(), makeReportContext({ demo: true }));
    expect(r.html).toContain('made-up site');
  });

  it('caps tables at 25 rows', () => {
    const big = makeAnalysisOutput();
    const fact = big.aio!.facts[0];
    big.aio!.facts = Array.from({ length: 60 }, (_, i) => ({ ...fact, keyword: `search ${i}` }));
    const r = renderReports(big, makeReportContext());
    expect(r.html).toContain('and 35 more searches in findings.json');
  });
});

describe('findings.json (test 48, F part)', () => {
  it('is byte-identical for the same inputs, whatever the key order or run', () => {
    const a = renderFindingsJson(makeAnalysisOutput(), makeReportContext());
    const b = renderFindingsJson(shuffleKeys(makeAnalysisOutput()) as AnalysisOutput, makeReportContext({ run: null }));
    expect(a).toBe(b);
    expect(a).not.toContain('r20261006t061700z');
    expect(a.endsWith('\n')).toBe(true);
  });

  it('has the 6.6 shape', () => {
    const doc = JSON.parse(renderFindingsJson(makeAnalysisOutput(), makeReportContext()));
    expect(doc.schema_version).toBe(1);
    expect(doc.generator).toBe('searchtrace');
    expect(doc.data_through).toBe('2026-10-03');
    expect(doc.windows.current).toEqual(['2026-09-06', '2026-10-03']);
    expect(doc.headline.real_label).toBe('Not enough data yet');
    expect(doc.headline.sentence).toContain('In the last 28 days');
    const f = doc.findings.find((x: { id: string }) => x.id === 'fbbbbbbbbbbbbbbbb');
    expect(f.badge).toBe('Estimated');
    expect(f.cause_label).toBe('Ranking');
    expect(f.verify_url).toMatch(/^https:\/\/search\.google\.com\/search-console\//);
    expect(f.falsifier).toMatch(/^What would prove this wrong: /);
    expect(doc.diagnostics.namedClickShare).toBe(0.19);
    expect(doc.diagnostics.reconciliation).toEqual({ byPageClicks: 252, byPropertyClicks: 252 });
    expect(doc.scorecard[0].title).toBeDefined();
    expect(doc.site_changes[0].source).toBe('annotation');
    expect(Array.isArray(doc.aio.facts)).toBe(true);
  });

  it('writes a zero-traffic baseline as explicit nulls, never Infinity or NaN (valid JSON by design)', () => {
    // periodCompare with a zero pre total: tau is Infinity, se Infinity, ci95 [-1, Infinity] (WP-A stats note).
    const out = makeAnalysisOutput();
    out.headline.clicks = { ...out.headline.clicks, pre: 0, post: 40, tau: Number.POSITIVE_INFINITY, se: Number.POSITIVE_INFINITY, ci95: [-1, Number.POSITIVE_INFINITY], p: Number.NaN };
    out.findings[0] = { ...out.findings[0], effect: { ...out.findings[0].effect, estimate: Number.POSITIVE_INFINITY, ci95: [-1, Number.POSITIVE_INFINITY] } };
    const { json, md, html } = renderReports(out, makeReportContext());
    const doc = JSON.parse(json);
    expect(doc.headline.clicks.tau).toBeNull();
    expect(doc.headline.clicks.se).toBeNull();
    expect(doc.headline.clicks.ci95).toEqual([-1, null]);
    expect(doc.headline.clicks.p).toBeNull();
    expect(json).not.toMatch(/Infinity|NaN/);
    for (const text of [md, html]) expect(text).not.toMatch(/\b(NaN|Infinity|undefined)\b/);
  });

  it('sorts keys and rounds to 4 decimals', () => {
    expect(stableStringify({ b: 1, a: { d: 0.123456, c: -0 } }, 0)).toBe('{"a":{"c":0,"d":0.1235},"b":1}\n');
    expect(canonicalString({ x: Number.POSITIVE_INFINITY, y: [1, undefined] })).toBe('{"x":null,"y":[1,null]}');
  });
});

describe('Show the maths', () => {
  it('includes control-group sizes for site-change impacts', () => {
    const out = makeAnalysisOutput();
    const { html } = renderReports(out, makeReportContext());
    expect(html).toContain('<dt>Pages compared</dt><dd>3 changed, 2 unchanged (fallback controls)</dd>');
    expect(html).toContain('<dt>Bootstrap replicates (B)</dt><dd>waterfall 1,000</dd>');
  });
});
