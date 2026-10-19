// DataStore implementation: atomic tmp + fsync + rename writes, immutability, tmp sweep. Owner: WP-A.
//
// The DataStore semantics (3.2) live in createDataStore and are shared by the disk backend
// here and the in-memory backend in test/helpers/memory-store.ts, so tests exercise the same
// rules (immutability, secret guard, ledger months) that real runs do.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { StError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';
import { utcMonth } from '../core/time.js';
import type { DataStore, LedgerStream, PartitionMeta, SecretRegistry } from '../core/types.js';
import { checkRelPath, layout, resolveInside } from './layout.js';
import { appendLedgerLine, parseLedgerText } from './ledger.js';
import { decodeNdjsonGz, decodeNdjsonGzMeta, encodeNdjsonGz, gunzipText } from './ndjson.js';

const TMP_MARK = '.tmp-';
const TMP_MAX_AGE_MS = 3_600_000;
const SKIP_WALK = new Set(['.git', 'node_modules']);

/** Raw storage under a DataStore. Paths are data-dir-relative with forward slashes, already checked. */
export interface StoreBackend {
  readonly root: string;
  readBytes(rel: string): Promise<Uint8Array | null>;
  readBytesSync(rel: string): Uint8Array | null;
  exists(rel: string): Promise<boolean>;
  /** Write to a temporary name, flush, then rename over rel, so readers see the old or the new file, never half. */
  writeAtomic(rel: string, data: Uint8Array): Promise<void>;
  /** Append one line (no trailing newline in `line`), repairing a missing final newline first, then flush. */
  appendLine(rel: string, line: string): Promise<void>;
  /** Files under the prefix, sorted by path, temporary files excluded. */
  list(prefix: string): Promise<{ path: string; size: number }[]>;
  remove(rel: string): Promise<void>;
  removeSync(rel: string): void;
  /** Create rel only if it does not exist (open 'wx'). False when it already exists. */
  createExclusive(rel: string, data: Uint8Array): Promise<boolean>;
}

/** The DataStore plus the extras the lock and the index use. Both store implementations provide them. */
export interface LocalDataStore extends DataStore {
  readBytes(rel: string): Promise<Uint8Array | null>;
  readFileSync(rel: string): string | null;
  createExclusive(rel: string, data: string): Promise<boolean>;
  removeFileSync(rel: string): void;
}

/** True when the store offers the LocalDataStore extras (both built-in stores do). */
export function isLocalDataStore(s: DataStore): s is LocalDataStore {
  const x = s as Partial<LocalDataStore>;
  return typeof x.readBytes === 'function' && typeof x.createExclusive === 'function' && typeof x.removeFileSync === 'function';
}

const utf8 = new TextDecoder('utf-8');
const encode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

function ledgerMonth(rec: object): string {
  const at = (rec as { at?: unknown }).at;
  if (typeof at === 'string') {
    try {
      return utcMonth(at);
    } catch {
      // fall through to the current month
    }
  }
  return utcMonth(new Date());
}

/** DataStore semantics (spec 3.2) over any backend. */
export function createDataStore(backend: StoreBackend, secrets: SecretRegistry): LocalDataStore {
  const guard = (line: string): void => secrets.assertNoSecret(line);

  return {
    root: backend.root,

    async writePartition<T>(rel: string, meta: PartitionMeta, rows: Iterable<T>) {
      checkRelPath(rel);
      if (!rel.endsWith('.ndjson.gz')) throw new StError('internal', `Partitions must end in .ndjson.gz: ${JSON.stringify(rel)}`);
      const encoded = await encodeNdjsonGz(meta, rows, guard);
      const existing = await backend.readBytes(rel);
      if (existing && rel !== layout.gscFresh) {
        let oldText: string | null = null;
        try {
          oldText = await gunzipText(existing);
        } catch {
          oldText = null;
        }
        if (oldText === encoded.text) return { path: rel, sha256: sha256Hex(existing), rows: encoded.rows };
        throw new StError(
          'internal',
          `${rel} already exists with different content. Saved partitions are never rewritten; write a new revision instead.`,
        );
      }
      await backend.writeAtomic(rel, encoded.data);
      return { path: rel, sha256: sha256Hex(encoded.data), rows: encoded.rows };
    },

    async readPartition<T>(rel: string) {
      checkRelPath(rel);
      const data = await backend.readBytes(rel);
      if (!data) throw new StError('internal', `Partition not found: ${rel}`);
      return decodeNdjsonGz<T>(data);
    },

    async readPartitionMeta(rel: string) {
      checkRelPath(rel);
      const data = await backend.readBytes(rel);
      if (!data) throw new StError('internal', `Partition not found: ${rel}`);
      return decodeNdjsonGzMeta(data);
    },

    async list(prefix: string) {
      checkRelPath(prefix, { prefix: true });
      return backend.list(prefix);
    },

    async exists(rel: string) {
      checkRelPath(rel);
      return backend.exists(rel);
    },

    async append(stream: LedgerStream, rec: object) {
      const line = JSON.stringify(rec);
      if (typeof line !== 'string' || !line.startsWith('{')) throw new StError('internal', 'Ledger records must be JSON objects.');
      guard(line);
      await backend.appendLine(layout.ledger(stream, ledgerMonth(rec)), line);
    },

    async readLedger<T>(stream: LedgerStream) {
      const prefix = `ledger/${stream}/`;
      layout.ledger(stream, '2000-01'); // validates the stream name
      const files = (await backend.list(prefix)).filter((f) => /^ledger\/[a-z]+\/\d{4}-\d{2}\.ndjson$/.test(f.path));
      const out: T[] = [];
      for (const f of files) {
        const data = await backend.readBytes(f.path);
        if (data) out.push(...parseLedgerText<T>(utf8.decode(data)));
      }
      return out;
    },

    async writeFileAtomic(rel: string, data: string | Uint8Array) {
      checkRelPath(rel);
      const bytes = typeof data === 'string' ? encode(data) : data;
      guard(typeof data === 'string' ? data : utf8.decode(data));
      await backend.writeAtomic(rel, bytes);
    },

    async readFile(rel: string) {
      checkRelPath(rel);
      const data = await backend.readBytes(rel);
      return data ? utf8.decode(data) : null;
    },

    async removeFile(rel: string) {
      checkRelPath(rel);
      await backend.remove(rel);
    },

    async readBytes(rel: string) {
      checkRelPath(rel);
      return backend.readBytes(rel);
    },

    readFileSync(rel: string) {
      checkRelPath(rel);
      const data = backend.readBytesSync(rel);
      return data ? utf8.decode(data) : null;
    },

    async createExclusive(rel: string, data: string) {
      checkRelPath(rel);
      guard(data);
      return backend.createExclusive(rel, encode(data));
    },

    removeFileSync(rel: string) {
      checkRelPath(rel);
      backend.removeSync(rel);
    },
  };
}

// ---------- disk backend ----------

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;
}

async function fsyncDir(dir: string): Promise<void> {
  // Directory fsync makes the rename durable on POSIX. Windows cannot open a directory; skip there.
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // not supported on this platform or file system
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const toPosix = (p: string): string => p.split(sep).join('/');

class DiskBackend implements StoreBackend {
  /** durable: fsync every file and its folder (real data). Off only for throwaway folders (openScratchStore). */
  constructor(readonly root: string, private readonly durable = true) {}

  private abs(rel: string): string {
    return resolveInside(this.root, rel);
  }

  async readBytes(rel: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.abs(rel));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'EISDIR' || errCode(e) === 'ENOTDIR') return null;
      throw e;
    }
  }

  readBytesSync(rel: string): Uint8Array | null {
    try {
      const buf = readFileSync(this.abs(rel));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'EISDIR' || errCode(e) === 'ENOTDIR') return null;
      throw e;
    }
  }

  async exists(rel: string): Promise<boolean> {
    try {
      return (await stat(this.abs(rel))).isFile();
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return false;
      throw e;
    }
  }

  async writeAtomic(rel: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    this.abs(rel); // re-check: mkdir must not have raced a link into place
    const tmp = `${abs}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`;
    const fh = await open(tmp, 'wx');
    try {
      await fh.writeFile(data);
      if (this.durable) await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    try {
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    if (this.durable) await fsyncDir(dirname(abs));
  }

  async appendLine(rel: string, line: string): Promise<void> {
    await appendLedgerLine(this.abs(rel), line);
  }

  async list(prefix: string): Promise<{ path: string; size: number }[]> {
    const slash = prefix.lastIndexOf('/');
    const dirRel = slash >= 0 ? prefix.slice(0, slash) : '';
    const start = dirRel ? this.abs(dirRel) : this.root;
    const out: { path: string; size: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return;
        throw e;
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (!SKIP_WALK.has(ent.name)) await walk(abs);
          continue;
        }
        if (!ent.isFile() || ent.name.includes(TMP_MARK)) continue;
        const rel = toPosix(relative(this.root, abs));
        if (!rel.startsWith(prefix)) continue;
        out.push({ path: rel, size: (await lstat(abs)).size });
      }
    };
    await walk(start);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }

  removeSync(rel: string): void {
    rmSync(this.abs(rel), { force: true });
  }

  async createExclusive(rel: string, data: Uint8Array): Promise<boolean> {
    const abs = this.abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    let fh;
    try {
      fh = await open(abs, 'wx');
    } catch (e) {
      if (errCode(e) === 'EEXIST') return false;
      throw e;
    }
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }
}

/** Removes leftover '*.tmp-*' files older than maxAgeMs (a crash between write and rename). Returns how many. */
export async function sweepTmpFiles(root: string, now: number = Date.now(), maxAgeMs: number = TMP_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!SKIP_WALK.has(ent.name)) await walk(abs);
      } else if (ent.isFile() && ent.name.includes(TMP_MARK)) {
        try {
          if (now - (await lstat(abs)).mtimeMs > maxAgeMs) {
            await rm(abs, { force: true });
            removed++;
          }
        } catch {
          // vanished meanwhile
        }
      }
    }
  };
  await walk(root);
  return removed;
}

export async function openStore(root: string, secrets: SecretRegistry): Promise<DataStore> {
  return openDiskStore(root, secrets, true);
}

/**
 * A store for throwaway folders (the demo): the same semantics as openStore (atomic rename,
 * immutability, secret guard), but files are not fsynced, so a power cut can lose the most
 * recent writes. Never use it for a real data folder; nothing else in searchtrace opens one.
 */
export async function openScratchStore(root: string, secrets: SecretRegistry): Promise<DataStore> {
  return openDiskStore(root, secrets, false);
}

async function openDiskStore(root: string, secrets: SecretRegistry, durable: boolean): Promise<DataStore> {
  const abs = resolve(root);
  await mkdir(abs, { recursive: true });
  try {
    if (!(await stat(abs)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new StError('config', `The data folder is not a folder: ${abs}`, 'Point --dir at a folder (it is created when missing).');
  }
  await sweepTmpFiles(abs);
  return createDataStore(new DiskBackend(abs, durable), secrets);
}
