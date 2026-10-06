// 64-bit simhash (word 3-shingles, two FNV-1a-32 seeds) and hamming distance (4.4). Owner: WP-C.
//
// Each shingle is hashed twice with FNV-1a 32 using two different offset bases; the two
// 32-bit values form the high and low halves of a 64-bit fingerprint. Every shingle votes
// +1 or -1 on each of the 64 bits, and a bit is set when its votes sum above zero.
// Distance <= 3 is a trivial edit, > 10 a substantive rewrite (spec 4.4).

/** The standard FNV-1a 32 offset basis, and a second basis for the low half. */
const SEED_HI = 0x811c9dc5;
const SEED_LO = 0x050c5d1f;
const FNV_PRIME = 0x01000193;

const encoder = new TextEncoder();

function fnv1a32(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Lower-cased word tokens: runs of letters and digits in any script. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Consecutive 3-word shingles; texts shorter than 3 words give one shingle of what is there. */
export function shingles(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  if (tokens.length < 3) return [tokens.join(' ')];
  const out: string[] = [];
  for (let k = 0; k + 2 < tokens.length; k++) out.push(`${tokens[k]} ${tokens[k + 1]} ${tokens[k + 2]}`);
  return out;
}

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** 16 hex chars. An empty text hashes to all zeros. */
export function simhash64(text: string): string {
  const sh = shingles(words(text));
  if (sh.length === 0) return '0000000000000000';
  const votes = new Int32Array(64);
  for (const s of sh) {
    const bytes = encoder.encode(s);
    const hi = fnv1a32(bytes, SEED_HI);
    const lo = fnv1a32(bytes, SEED_LO);
    for (let bit = 0; bit < 32; bit++) {
      votes[bit] += (hi >>> bit) & 1 ? 1 : -1;
      votes[32 + bit] += (lo >>> bit) & 1 ? 1 : -1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (votes[bit] > 0) hi |= 1 << bit;
    if (votes[32 + bit] > 0) lo |= 1 << bit;
  }
  return hex8(hi) + hex8(lo);
}

function popcount32(n: number): number {
  let x = n >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Number of differing bits between two 16-hex-char simhashes. Malformed input counts as fully different (64). */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  const hi = parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16);
  const lo = parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16);
  return popcount32(hi) + popcount32(lo);
}

/** Thresholds from spec 4.4. */
export const TRIVIAL_DISTANCE = 3;
export const SUBSTANTIVE_DISTANCE = 10;
