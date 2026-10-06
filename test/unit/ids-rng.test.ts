import { describe, expect, it } from 'vitest';
import { RUN_ID_RE, b32, findingId, hash32, intentKey, newRunId, nodeId, sha256Hex } from '../../src/core/ids.js';
import { mulberry32, rngFor } from '../../src/core/rng.js';
import { fixedClock } from '../../src/core/time.js';

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

describe('ids', () => {
  it('sha256Hex matches the standard vectors for strings and bytes', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array(Buffer.from('abc')))).toBe(sha256Hex('abc'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('b32 matches the RFC 4648 vectors, lowercase and unpadded', () => {
    const vectors: [string, string][] = [
      ['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi'],
    ];
    for (const [plain, encoded] of vectors) expect(b32(hex(plain))).toBe(encoded);
    expect(b32('FF')).toBe('74');
    expect(() => b32('abc')).toThrow();
    expect(() => b32('zz')).toThrow();
  });

  it('hash32 is FNV-1a 32-bit over UTF-8', () => {
    expect(hash32('')).toBe(0x811c9dc5);
    expect(hash32('a')).toBe(0xe40c292c);
    expect(hash32('foobar')).toBe(0xbf9cf968);
    expect(hash32('é')).not.toBe(hash32('e'));
  });

  it('builds node, finding and intent ids with the agreed shapes', () => {
    const n = nodeId('page', 'https://example.com/');
    expect(n).toMatch(/^page_[a-z2-7]{12}$/);
    expect(n).toBe(`page_${b32(sha256Hex('https://example.com/')).slice(0, 12)}`);
    expect(nodeId('page', 'https://example.com/')).toBe(n);
    const f = findingId(['waterfall', 'site', '2026-09-06']);
    expect(f).toMatch(/^f[a-z2-7]{16}$/);
    expect(f).toBe(`f${b32(sha256Hex('waterfall|site|2026-09-06')).slice(0, 16)}`);
    expect(intentKey(['sc-domain:example.com', 'seo audit', '2826', 'en', 'desktop', '2026-W41'])).toMatch(/^[a-z2-7]{24}$/);
  });

  it('newRunId uses the clock in UTC and a 4-hex suffix', () => {
    const clock = fixedClock('2026-10-06T06:17:00Z');
    const id = newRunId(clock, () => 0.2479);
    expect(id).toBe('r20261006t061700z-3f76');
    expect(RUN_ID_RE.test(id)).toBe(true);
    expect(newRunId(clock, () => 0)).toBe('r20261006t061700z-0000');
    expect(newRunId(clock, () => 0.99999999)).toBe('r20261006t061700z-ffff');
    const random = newRunId(clock);
    expect(random).toMatch(RUN_ID_RE);
    expect(random.startsWith('r20261006t061700z-')).toBe(true);
  });
});

describe('rng', () => {
  it('mulberry32 is deterministic, uniform in [0, 1) and pinned', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 10_000 }, () => a());
    expect(Array.from({ length: 10_000 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    // Pin the sequence so a refactor cannot silently change every seeded result.
    const pinned = mulberry32(1);
    expect([pinned(), pinned(), pinned()].map((x) => x.toFixed(10))).toEqual(PINNED_SEED_1);
  });

  it('rngFor(seed, key) is mulberry32(hash32(seed|key)) and keys are independent', () => {
    const r = rngFor('sc-domain:example.com|2026-10-03|abc', 'waterfall:site');
    const m = mulberry32(hash32('sc-domain:example.com|2026-10-03|abc|waterfall:site'));
    expect([r(), r(), r()]).toEqual([m(), m(), m()]);
    const x = rngFor('s', 'k1');
    const y = rngFor('s', 'k2');
    expect(x()).not.toBe(y());
  });
});

// mulberry32(1): the widely published reference values (0.6270739405881613, ...).
const PINNED_SEED_1 = ['0.6270739406', '0.0027357212', '0.5274470400'];
