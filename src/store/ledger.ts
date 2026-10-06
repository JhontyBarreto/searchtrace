// Append-only ledger streams with fsync and torn-line tolerance. Owner: WP-A (internal to the store).
//
// A crash can leave a half-written last line. The next append writes '\n' first so the new
// record starts on a fresh line, and readers skip every line that does not parse.
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonSafe } from './ndjson.js';

/**
 * Appends one JSON line (rec is serialised unless it is already a string) with O_APPEND and
 * fsync, writing a newline first if the file does not end with one.
 */
export async function appendLedgerLine(absPath: string, rec: object | string): Promise<void> {
  const line = typeof rec === 'string' ? rec : JSON.stringify(rec);
  await mkdir(dirname(absPath), { recursive: true });
  const fh = await open(absPath, 'a+');
  try {
    const { size } = await fh.stat();
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    await fh.write(`${prefix}${line}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Parses ledger text into records, skipping torn or unparseable lines and anything that is not an object. */
export function parseLedgerText<T>(text: string): T[] {
  const out: T[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const value = parseJsonSafe(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.push(value as T);
    } catch {
      // a torn line from a crash mid-write; the records around it are intact
    }
  }
  return out;
}
