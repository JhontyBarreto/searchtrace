// Gzip NDJSON codec with a leading {"_meta": ...} line, plus a JSON parser that drops __proto__ keys.
// Owner: WP-A (internal to the store; the index and http modules reuse parseJsonSafe).
import { promisify } from 'node:util';
import { createGunzip, gunzip, gzip } from 'node:zlib';
import { StError } from '../core/errors.js';
import type { PartitionMeta } from '../core/types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** gzip header byte 9 names the OS that wrote the file. Pin it so every platform writes identical bytes. */
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNIX = 3;

/** JSON.parse that drops every "__proto__" key, so parsed data can never reach a prototype later. */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => (key === '__proto__' ? undefined : value));
}

/**
 * {"_meta": meta} as line 1, then one JSON object per row, each line ending in '\n', gzipped.
 * checkLine runs on every serialised line before anything is compressed (the secret guard).
 * `text` is the uncompressed content, used for content-equality checks.
 */
export async function encodeNdjsonGz(
  meta: PartitionMeta,
  rows: Iterable<unknown>,
  checkLine?: (line: string) => void,
): Promise<{ data: Uint8Array; rows: number; text: string }> {
  const head = JSON.stringify({ _meta: meta });
  checkLine?.(head);
  const lines = [head];
  let n = 0;
  for (const row of rows) {
    const line = JSON.stringify(row);
    if (typeof line !== 'string' || !line.startsWith('{')) {
      throw new StError('internal', `Partition rows must be JSON objects (row ${n + 1} is not).`);
    }
    checkLine?.(line);
    lines.push(line);
    n++;
  }
  const text = `${lines.join('\n')}\n`;
  const buf = await gzipAsync(Buffer.from(text, 'utf8'));
  buf[GZIP_OS_BYTE] = GZIP_OS_UNIX;
  return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), rows: n, text };
}

/** Uncompressed text of a gzipped file. Throws StError('internal') when it is not valid gzip. */
export async function gunzipText(data: Uint8Array): Promise<string> {
  try {
    return (await gunzipAsync(data)).toString('utf8');
  } catch {
    throw new StError('internal', 'A partition file is not valid gzip. Delete it or restore it from git.');
  }
}

/** Parses NDJSON partition text: a {"_meta": ...} first line, then one object per line. Throws on a corrupt line. */
export function parseNdjsonText<T>(text: string): { meta: PartitionMeta; rows: T[] } {
  const lines = text.split('\n');
  let meta: PartitionMeta | null = null;
  const rows: T[] = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = parseJsonSafe(line);
    } catch {
      throw new StError('internal', `A partition has a corrupt line (${k + 1}). Delete the file or restore it from git.`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new StError('internal', `A partition line is not a JSON object (line ${k + 1}).`);
    }
    if (meta === null) {
      const m = (value as { _meta?: unknown })._meta;
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        throw new StError('internal', 'A partition does not start with a {"_meta": ...} line.');
      }
      meta = m as PartitionMeta;
      continue;
    }
    rows.push(value as T);
  }
  if (meta === null) throw new StError('internal', 'A partition is empty (no {"_meta": ...} line).');
  return { meta, rows };
}

export async function decodeNdjsonGz<T>(data: Uint8Array): Promise<{ meta: PartitionMeta; rows: T[] }> {
  return parseNdjsonText<T>(await gunzipText(data));
}

/**
 * The {"_meta": ...} line of a gzipped partition, decompressing only until the first newline.
 * Reading every old day's meta this way costs milliseconds where a full decode costs seconds.
 */
export async function decodeNdjsonGzMeta(data: Uint8Array): Promise<PartitionMeta> {
  const head = await new Promise<string>((resolve, reject) => {
    const z = createGunzip();
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      z.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    z.on('data', (c: Buffer) => {
      chunks.push(c);
      if (c.includes(0x0a)) finish();
    });
    z.on('end', finish);
    z.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
    z.end(data);
  }).catch(() => {
    throw new StError('internal', 'A partition file is not valid gzip. Delete it or restore it from git.');
  });
  const line = head.split('\n', 1)[0];
  return parseNdjsonText(`${line}\n`).meta;
}
