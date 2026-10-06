// Test 57: simhash. Identical text gives 0, a one-word edit stays within 3, a rewrite is over 10.
import { describe, expect, it } from 'vitest';
import { SUBSTANTIVE_DISTANCE, TRIVIAL_DISTANCE, hammingDistance, shingles, simhash64, words } from '../../src/sources/crawl/simhash.js';
import { testRng } from '../helpers/index.js';

const VOCAB = (
  'search traffic page site google clicks ranking update content title change report index crawl link query people ' +
  'week month answer data console signal noise plumber boiler repair heating service local emergency price guide ' +
  'install water pressure valve leak bathroom kitchen radiator tank pump heat home customer review booking quote'
).split(' ');

function text(seed: string, n: number): string[] {
  const rng = testRng(seed);
  return Array.from({ length: n }, () => VOCAB[Math.floor(rng() * VOCAB.length)]);
}

describe('simhash64', () => {
  it('is 16 hex characters and deterministic', () => {
    const h = simhash64('The quick brown fox jumps over the lazy dog');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash64('The quick brown fox jumps over the lazy dog')).toBe(h);
    expect(simhash64('')).toBe('0000000000000000');
  });

  it('tokenises any script and builds 3-word shingles', () => {
    expect(words('Café, naïve 2026 crème-brûlée')).toEqual(['café', 'naïve', '2026', 'crème', 'brûlée']);
    expect(shingles(['a', 'b', 'c', 'd'])).toEqual(['a b c', 'b c d']);
    expect(shingles(['a', 'b'])).toEqual(['a b']);
  });

  it('gives distance 0 for identical text (case and punctuation ignored)', () => {
    const t = text('base', 600).join(' ');
    expect(hammingDistance(simhash64(t), simhash64(t.toUpperCase().replace(/ /g, ', ')))).toBe(0);
  });

  it('keeps a one-word edit within the trivial threshold', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const base = text(seed, 600);
      const edited = [...base];
      edited[300] = 'zebra';
      const d = hammingDistance(simhash64(base.join(' ')), simhash64(edited.join(' ')));
      expect(d).toBeLessThanOrEqual(TRIVIAL_DISTANCE);
    }
  });

  it('puts a rewrite beyond the substantive threshold', () => {
    for (const seed of ['a', 'b', 'c']) {
      const d = hammingDistance(simhash64(text(seed, 600).join(' ')), simhash64(text(`${seed}-rewrite`, 600).join(' ')));
      expect(d).toBeGreaterThan(SUBSTANTIVE_DISTANCE);
    }
  });

  it('counts bits and treats malformed input as fully different', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1);
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('xyz', '0000000000000000')).toBe(64);
  });
});
