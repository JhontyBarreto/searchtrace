#!/usr/bin/env node
// searchtrace entry point. Owner: WP-A.
// 1. Refuse to run on Node older than 22.13, with the plain-English fix from 6.4.4.
// 2. Drop the ExperimentalWarning Node prints when its built-in SQLite module loads (0.2 F11).
// 3. Hand over to ./cli/main.js, which owns argument parsing, errors and exit codes.
// Nothing from the project is imported before the version check, so this file can
// still explain itself on an old Node.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_NODE = { major: 22, minor: 13 } as const;

/** The 6.4.4 message when `version` (process.versions.node) is too old, otherwise null. */
export function nodeVersionProblem(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) return null;
  return `searchtrace needs Node 22.13 or newer (you have ${version}). Get it from nodejs.org.`;
}

/** True for the warning object Node emits when its SQLite module is first loaded. */
export function isSqliteExperimentalWarning(w: unknown): boolean {
  if (typeof w !== 'object' || w === null) return false;
  const { name, message } = w as { name?: unknown; message?: unknown };
  // Node 22 and 24 word it 'SQLite is an experimental feature and might change at any time'.
  return name === 'ExperimentalWarning' && typeof message === 'string' && /^\s*sqlite\b/i.test(message);
}

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;
let silenced = false;

/** Filters the SQLite ExperimentalWarning out of process 'warning' events. Every other warning still prints. */
export function silenceSqliteWarning(): void {
  if (silenced) return;
  silenced = true;
  const target = process as unknown as { emit: Emit };
  const original = target.emit;
  target.emit = function emit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'warning' && isSqliteExperimentalWarning(args[0])) return false;
    return original.call(this, event, ...args);
  };
}

/** Runs the CLI and resolves to the process exit code. */
export async function start(argv: string[] = process.argv.slice(2)): Promise<number> {
  const problem = nodeVersionProblem(process.versions.node);
  if (problem) {
    console.error(problem);
    return 1;
  }
  silenceSqliteWarning();
  try {
    const { main } = await import('./cli/main.js');
    return await main(argv);
  } catch (e) {
    // Last resort only: cli/main catches, redacts and reports its own errors.
    const err = (typeof e === 'object' && e !== null ? e : {}) as { message?: unknown; fix?: unknown; exit?: unknown };
    console.error(`searchtrace stopped: ${typeof err.message === 'string' ? err.message : String(e)}`);
    if (typeof err.fix === 'string') console.error(err.fix);
    return typeof err.exit === 'number' ? err.exit : 1;
  }
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const target = realpathSync(entry);
    return process.platform === 'win32' ? self.toLowerCase() === target.toLowerCase() : self === target;
  } catch {
    return false;
  }
}

// Always run, except when the test runner imports this module to test the helpers above.
// A test that spawns `node dist/bin.js` still runs it, because then this file is the entry script.
if (invokedAsScript() || process.env.VITEST === undefined) {
  process.exitCode = await start();
}
