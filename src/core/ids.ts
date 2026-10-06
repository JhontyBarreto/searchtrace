// sha256, base32, FNV-1a hash32 and deterministic ids (node, finding, intent, run). Owner: WP-A.
import { createHash, randomBytes } from 'node:crypto';
import { StError } from './errors.js';
import type { Clock, NodeKind, Rng } from './types.js';

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** A run id: 'r' + UTC yyyymmddThhmmssZ lowercased + '-' + 4 hex (spec 4.1). */
export const RUN_ID_RE = /^r\d{8}t\d{6}z-[0-9a-f]{4}$/;

/** sha256 of a UTF-8 string or raw bytes, as lowercase hex. */
export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Lowercase RFC 4648 alphabet a-z2-7, no padding. The input is hex-encoded bytes. */
export function b32(hex: string): string {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new StError('internal', 'b32 expects an even-length hex string.');
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 2) {
    buffer = ((buffer << 8) | parseInt(hex.slice(i, i + 2), 16)) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of s, as an unsigned integer. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `${kind}_${b32(sha256(naturalKey)).slice(0, 12)}` */
export function nodeId(kind: NodeKind, naturalKey: string): string {
  return `${kind}_${b32(sha256Hex(naturalKey)).slice(0, 12)}`;
}

/** 'f' + b32(sha256(parts.join('|'))).slice(0, 16) */
export function findingId(parts: string[]): string {
  return `f${b32(sha256Hex(parts.join('|'))).slice(0, 16)}`;
}

/** b32(sha256(parts.join('|'))).slice(0, 24) */
export function intentKey(parts: string[]): string {
  return b32(sha256Hex(parts.join('|'))).slice(0, 24);
}

/** For example 'r20261006t061700z-3f2a'. The suffix comes from rng when given, else from crypto. */
export function newRunId(clock: Clock, rng?: Rng): string {
  const iso = clock.now().toISOString(); // 2026-10-06T06:17:00.123Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}t${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}z`;
  const n = rng ? Math.floor(rng() * 0x10000) & 0xffff : randomBytes(2).readUInt16BE(0);
  return `r${stamp}-${n.toString(16).padStart(4, '0')}`;
}
