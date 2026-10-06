// readline prompts (TTY only, never with --ci or --yes) and the terminal IO the commands share. Owner: WP-F.
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { StError, ExitCode } from '../core/errors.js';
import { systemClock } from '../core/time.js';
import type { Clock, Fetch, SecretRegistry } from '../core/types.js';

export interface Prompter {
  ask(question: string, o?: { defaultValue?: string }): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

export interface OutStream { write(s: string): unknown; isTTY?: boolean }

/** Everything a command touches outside the data folder, injectable for tests. */
export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout: OutStream;
  stderr: OutStream;
  stdinIsTTY: boolean;
  fetch: Fetch;
  clock: Clock;
  cwd: string;
  homedir: string;
  nodeVersion: string;
  /** null when there is no terminal to ask in. */
  prompter: Prompter | null;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const noTerminal = (): StError =>
  new StError(
    'config',
    'This step needs an answer, but there is no terminal to ask in.',
    'Run setup with --yes and the flags you need, for example: npx searchtrace setup --yes --property sc-domain:example.com --credentials key.json',
  );

/** A prompter over the given streams. Each question is asked once; Enter takes the default. */
export function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  const rl = createInterface({ input, output, terminal: true });
  return {
    async ask(question, o) {
      const suffix = o?.defaultValue !== undefined && o.defaultValue !== '' ? ` [${o.defaultValue}]` : '';
      const answer = (await rl.question(`${question}${suffix} `)).trim();
      return answer === '' ? o?.defaultValue ?? '' : answer;
    },
    async confirm(question, defaultYes) {
      const answer = (await rl.question(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `)).trim().toLowerCase();
      if (answer === '') return defaultYes;
      return answer === 'y' || answer === 'yes';
    },
    close() {
      rl.close();
    },
  };
}

let shared: Prompter | null = null;

function processPrompter(): Prompter {
  if (!process.stdin.isTTY) throw noTerminal();
  shared ??= createPrompter(process.stdin, process.stdout);
  return shared;
}

export async function ask(question: string, o?: { defaultValue?: string }): Promise<string> {
  return processPrompter().ask(question, o);
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  return processPrompter().confirm(question, defaultYes);
}

/** The prompter for a command, or a StError when asked without a terminal (CI, pipes, --yes). */
export function requirePrompter(deps: CliDeps): Prompter {
  if (!deps.prompter) throw noTerminal();
  return deps.prompter;
}

const sleepReal = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new StError('network', 'Stopped.'));
    }, { once: true });
  });

/** Real process IO, with any field overridden. A prompter is created lazily only on a TTY. */
export function resolveDeps(partial: Partial<CliDeps> = {}): CliDeps {
  const stdinIsTTY = partial.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  let prompter: Prompter | null | undefined = partial.prompter;
  if (prompter === undefined) {
    prompter = stdinIsTTY
      ? { ask: (q, o) => ask(q, o), confirm: (q, d) => confirm(q, d), close: () => shared?.close() }
      : null;
  }
  return {
    env: partial.env ?? process.env,
    stdout: partial.stdout ?? process.stdout,
    stderr: partial.stderr ?? process.stderr,
    stdinIsTTY,
    fetch: partial.fetch ?? globalThis.fetch,
    clock: partial.clock ?? systemClock,
    cwd: partial.cwd ?? process.cwd(),
    homedir: partial.homedir ?? homedir(),
    nodeVersion: partial.nodeVersion ?? process.versions.node,
    prompter,
    sleep: partial.sleep ?? sleepReal,
  };
}

// ---------- shared command helpers ----------

type Options = NonNullable<ParseArgsConfig['options']>;

/** util.parseArgs with strict flags; a bad flag is a config error (exit 2) with a fix line. */
export function parseFlags<O extends Options>(args: string[], options: O, command: string) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new StError('config', (e as Error).message.replace(/^TypeError \[[A-Z_]+\]: /, ''), `Run \`searchtrace ${command} --help\` to see the flags.`);
  }
}

/** --dir, else $SEARCHTRACE_DIR, else ./searchtrace-data, as an absolute path. */
export function resolveDir(flag: string | undefined, deps: CliDeps): string {
  const raw = flag ?? deps.env.SEARCHTRACE_DIR ?? 'searchtrace-data';
  const expanded = raw === '~' ? deps.homedir : raw.startsWith('~/') ? resolve(deps.homedir, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(deps.cwd, expanded);
}

/** Colour only on a TTY, never in CI, and never when NO_COLOR is set. */
export function colorOn(deps: CliDeps, ci = false): boolean {
  const noColor = deps.env.NO_COLOR !== undefined && deps.env.NO_COLOR !== '';
  return Boolean(deps.stdout.isTTY) && !ci && !noColor;
}

/** Prints an error and its fix line to stderr (redacted) and returns the exit code it maps to. */
export function printError(e: unknown, deps: CliDeps, secrets?: SecretRegistry): number {
  const clean = (s: string): string => (secrets ? secrets.redact(s) : s);
  if (e instanceof StError) {
    deps.stderr.write(`${clean(e.message)}\n`);
    if (e.fix) deps.stderr.write(`${clean(e.fix)}\n`);
    return e.exit === ExitCode.OK ? ExitCode.ERROR : e.exit;
  }
  const msg = e instanceof Error ? e.message : String(e);
  deps.stderr.write(`searchtrace hit a problem it did not expect: ${clean(msg)}\n`);
  deps.stderr.write('This is probably a bug. Please report it at https://github.com/JhontyBarreto/searchtrace/issues without pasting any keys.\n');
  return ExitCode.ERROR;
}

/** Writes one line to stdout. */
export function out(deps: CliDeps, line = ''): void {
  deps.stdout.write(`${line}\n`);
}
