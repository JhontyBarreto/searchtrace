// Brand matcher and doctor suggestions (spec 5.2; test 18). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import type { Cell, CtrCurve } from '../../src/core/types.js';
import { brandTokens, buildBrandMatcher, compact, damerauLevenshtein, domainLabel } from '../../src/analyze/brand.js';

describe('brand matcher', () => {
  // A made-up glued brand: a generic prefix ("seo") on a name ending in "co", which must not lose its "co".
  const m = buildBrandMatcher({ siteDomain: 'seonorvico.example', siteName: 'SEO Norvico', terms: [] });

  it('18. seonorvico: brand and non-brand searches, and the splitter yields norvico', () => {
    expect(m.tokens).toEqual(['norvico']);
    for (const q of ['seo norvico', 'norvico seo', 'seonorvico.example', 'seo norvigo']) expect(m.isBrand(q)).toBe(true);
    expect(m.isBrand('seo agency london')).toBe(false);
  });

  it('handles accents, case, typos and transpositions, and leaves short words alone', () => {
    expect(compact('Pipéwell  Plumbing!')).toBe('pipewellplumbing');
    expect(m.isBrand('NORVICO reviews')).toBe(true);
    expect(m.isBrand('norvcio')).toBe(true); // adjacent transposition
    expect(m.isBrand('seo northern')).toBe(false);
    expect(m.isBrand('')).toBe(false);
    expect(damerauLevenshtein('norvico', 'norvigo')).toBe(1);
    expect(damerauLevenshtein('norvico', 'norvcio')).toBe(1);
    expect(damerauLevenshtein('kitten', 'sitting', 1)).toBe(2);
  });

  it('strips generic words from the domain label, longest first', () => {
    expect(domainLabel('www.pipewell-plumbing.example')).toBe('pipewell-plumbing');
    expect(domainLabel('example.co.uk')).toBe('example');
    expect(brandTokens('pipewell-plumbing')).toEqual(['pipewell']);
    expect(brandTokens('londondentalclinic')).toEqual([]);
    expect(brandTokens('bestwebdesigns')).toEqual([]);
    expect(brandTokens('acmeplumbing')).toEqual(['acme']);
    expect(brandTokens('acme-heating')).toEqual(['acmeheating']);
    expect(brandTokens('seo-norvico')).toEqual(['norvico']);
    const p = buildBrandMatcher({ siteDomain: 'pipewell-plumbing.example', siteName: 'Pipewell Plumbing', terms: ['Pipewell & Sons'] });
    expect(p.isBrand('pipewell plumbers reviews')).toBe(true);
    expect(p.isBrand('pipewel plumbing')).toBe(true);
    expect(p.isBrand('pipewell and sons')).toBe(true);
    expect(p.isBrand('emergency plumber leeds')).toBe(false);
    expect(p.isBrand('plumbing near me')).toBe(false);
  });

  it('suggests words that act like a brand on the homepage but are not configured', () => {
    const home = 'https://acme.example/';
    const cells: Cell[] = [];
    for (const q of ['zorblax login', 'zorblax pricing', 'zorblax support', 'cheap widgets']) {
      cells.push({ date: '2026-09-10', q, p: home, dv: 'desktop', i: 100, c: q.startsWith('zorblax') ? 60 : 2, ps: 120 });
    }
    cells.push({ date: '2026-09-10', q: 'zorblax review', p: 'https://acme.example/blog/x', dv: 'desktop', i: 100, c: 60, ps: 120 });
    const matcher = buildBrandMatcher({ siteDomain: 'acme.example', siteName: null, terms: [] });
    const flat: CtrCurve = {
      f: () => 0.1, fMix: () => 0.1, unstable: [], m: 100, bins: [], fitWindow: ['2026-01-01', '2026-06-30'], redraw: () => flat,
    };
    expect(matcher.suggestions(cells, flat, home)).toEqual(['zorblax']);
    expect(matcher.suggestions(cells, null, home)).toEqual(['zorblax']);
    const configured = buildBrandMatcher({ siteDomain: 'acme.example', siteName: null, terms: ['zorblax'] });
    expect(configured.suggestions(cells, flat, home)).toEqual([]);
  });
});
