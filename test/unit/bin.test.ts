import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSqliteExperimentalWarning, nodeVersionProblem, silenceSqliteWarning, start } from '../../src/bin.js';

const OLD_MESSAGE = 'searchtrace needs Node 22.13 or newer (you have 20.11.0). Get it from nodejs.org.';

describe('Node version guard (6.4.4)', () => {
  it('explains the problem on an old Node', () => {
    expect(nodeVersionProblem('20.11.0')).toBe(OLD_MESSAGE);
    expect(nodeVersionProblem('22.12.9')).toMatch(/needs Node 22\.13 or newer \(you have 22\.12\.9\)/);
    expect(nodeVersionProblem('18.0.0')).not.toBeNull();
  });

  it('accepts 22.13 and newer', () => {
    for (const v of ['22.13.0', '22.17.1', 'v22.13.1', '23.0.0', '24.0.0', '26.1.0']) expect(nodeVersionProblem(v)).toBeNull();
  });

  describe('start() with a faked process.versions.node of 20.11.0', () => {
    const real = Object.getOwnPropertyDescriptor(process.versions, 'node');
    afterEach(() => {
      if (real) Object.defineProperty(process.versions, 'node', real);
      vi.restoreAllMocks();
    });

    it('prints the 6.4.4 message, exits 1 and never loads the CLI', async () => {
      Object.defineProperty(process.versions, 'node', { ...real, value: '20.11.0' });
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await start(['--version'])).toBe(1);
      expect(err).toHaveBeenCalledWith(OLD_MESSAGE);
    });
  });
});

describe('SQLite ExperimentalWarning filter', () => {
  it('recognises only the SQLite experimental warning', () => {
    const sqlite = Object.assign(new Error('SQLite is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' });
    const other = Object.assign(new Error('VM Modules is an experimental feature'), { name: 'ExperimentalWarning' });
    const deprecation = Object.assign(new Error('SQLite thing'), { name: 'DeprecationWarning' });
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true);
    expect(isSqliteExperimentalWarning(other)).toBe(false);
    expect(isSqliteExperimentalWarning(Object.assign(new Error('Mentions SQLite later'), { name: 'ExperimentalWarning' }))).toBe(false);
    expect(isSqliteExperimentalWarning(deprecation)).toBe(false);
    expect(isSqliteExperimentalWarning('SQLite')).toBe(false);
    expect(isSqliteExperimentalWarning(null)).toBe(false);
  });

  it('drops the SQLite warning and lets every other warning through', () => {
    silenceSqliteWarning();
    const seen: string[] = [];
    const listener = (w: Error) => seen.push(w.message);
    process.on('warning', listener);
    try {
      const sqlite = Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' });
      const other = Object.assign(new Error('bin.test: other warnings still print'), { name: 'ExperimentalWarning' });
      process.emit('warning', sqlite);
      process.emit('warning', other);
    } finally {
      process.off('warning', listener);
    }
    expect(seen).toEqual(['bin.test: other warnings still print']);
  });
});
