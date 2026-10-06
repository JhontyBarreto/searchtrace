// In-memory DataStore for unit tests. Owner: WP-A.
// Same semantics as openStore (immutability, ledgers, secret guard, gzip partitions) without
// touching disk: both run through createDataStore, only the byte storage differs.
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { DataStore, SecretRegistry } from '../../src/core/types.js';
import { createDataStore, type LocalDataStore, type StoreBackend } from '../../src/store/store.js';

export interface MemoryStore extends DataStore {
  /** Raw bytes by data-dir-relative path. Partitions are gzipped NDJSON, exactly as on disk. */
  readonly files: Map<string, Uint8Array>;
}

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

class MemoryBackend implements StoreBackend {
  constructor(
    readonly root: string,
    readonly files: Map<string, Uint8Array>,
  ) {}

  async readBytes(rel: string): Promise<Uint8Array | null> {
    return this.readBytesSync(rel);
  }

  readBytesSync(rel: string): Uint8Array | null {
    const v = this.files.get(rel);
    return v ? new Uint8Array(v) : null;
  }

  async exists(rel: string): Promise<boolean> {
    return this.files.has(rel);
  }

  async writeAtomic(rel: string, data: Uint8Array): Promise<void> {
    this.files.set(rel, new Uint8Array(data));
  }

  async appendLine(rel: string, line: string): Promise<void> {
    const old = this.files.get(rel);
    const needsNewline = old !== undefined && old.length > 0 && old[old.length - 1] !== 0x0a;
    const add = enc(`${needsNewline ? '\n' : ''}${line}\n`);
    const next = new Uint8Array((old?.length ?? 0) + add.length);
    if (old) next.set(old, 0);
    next.set(add, old?.length ?? 0);
    this.files.set(rel, next);
  }

  async list(prefix: string): Promise<{ path: string; size: number }[]> {
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.includes('.tmp-'))
      .map(([path, data]) => ({ path, size: data.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async remove(rel: string): Promise<void> {
    this.files.delete(rel);
  }

  removeSync(rel: string): void {
    this.files.delete(rel);
  }

  async createExclusive(rel: string, data: Uint8Array): Promise<boolean> {
    if (this.files.has(rel)) return false;
    this.files.set(rel, new Uint8Array(data));
    return true;
  }
}

/** Same semantics as openStore (immutability, ledgers, secret guard) without touching disk. */
export function memoryStore(o?: { root?: string; secrets?: SecretRegistry }): MemoryStore {
  const files = new Map<string, Uint8Array>();
  const store: LocalDataStore = createDataStore(
    new MemoryBackend(o?.root ?? '/memory/searchtrace-data', files),
    o?.secrets ?? createSecretRegistry({ ci: false }),
  );
  return Object.assign(store, { files });
}
