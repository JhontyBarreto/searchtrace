// util.parseArgs dispatch, bare-command routing and exit codes (6.1). Owner: WP-F.
// bin.ts calls main(argv) after the Node version guard and sets process.exitCode to the result.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ExitCode } from '../core/errors.js';
import { toolVersion } from '../pipeline/context.js';
import { demoCommand } from './commands/demo.js';
import { doctorCommand } from './commands/doctor.js';
import { noteCommand } from './commands/note.js';
import { runCommand } from './commands/run.js';
import { setupCommand } from './commands/setup.js';
import { whyCommand } from './commands/why.js';
import { out, printError, resolveDeps, resolveDir, type CliDeps } from './prompt.js';

type Command = (args: string[], deps?: Partial<CliDeps>) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  setup: setupCommand,
  init: setupCommand,
  run: runCommand,
  why: whyCommand,
  explain: whyCommand,
  doctor: doctorCommand,
  demo: demoCommand,
  note: noteCommand,
};

export const HELP = `searchtrace: honest answers to "why did my Google traffic change?"

Usage
  searchtrace                     set up when there is no config yet, otherwise run
  searchtrace setup               connect Search Console and write searchtrace-data/config.json (alias: init)
  searchtrace run                 collect, analyse, and write the report and graph
  searchtrace why [TARGET]        explain a change: a page path or URL, "search words", a date, or a finding id (alias: explain)
  searchtrace doctor              check the setup, with a one-line fix for anything wrong
  searchtrace demo                build a report for a made-up site, offline, in about 30 seconds
  searchtrace note "TEXT"         record a change you made: --date YYYY-MM-DD --urls "/blog/*"

Common flags
  --dir DIR                       data folder (default ./searchtrace-data, or $SEARCHTRACE_DIR)
  --json                          machine-readable output on stdout (run, why, doctor)
  --version, --help

run flags
  --dry-run  --offline  --no-paid  --budget USD  --wait MIN  --ci  --yes  --quiet  --credentials FILE  --force-graph

setup flags
  --property P  --credentials FILE  --dataforseo  --monthly-budget USD  --max-per-run USD  --github  --yes

Exit codes: 0 ok, 1 internal error, 2 config, 3 auth or permission, 4 partial (a step failed, the report was still written).
Docs: https://github.com/JhontyBarreto/searchtrace#readme
`;

/** The --dir value from loosely parsed args, for routing a bare `searchtrace`. */
function dirFromArgs(args: string[], deps: CliDeps): string {
  try {
    const { values } = parseArgs({ args, options: { dir: { type: 'string' } }, strict: false, allowPositionals: true });
    return resolveDir(typeof values.dir === 'string' ? values.dir : undefined, deps);
  } catch {
    return resolveDir(undefined, deps);
  }
}

/** argv excludes the node binary and script path. Resolves to the process exit code (ExitCode). */
export async function main(argv: string[]): Promise<number> {
  return mainWith(argv);
}

/** main with injectable terminal, clock, fetch and prompts (tests, the setup wizard's hand-off). */
export async function mainWith(argv: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  try {
    const [first, ...rest] = argv;
    if (first === '--version' || first === '-v' || first === 'version') {
      out(deps, toolVersion());
      return ExitCode.OK;
    }
    if (first === '--help' || first === '-h' || first === 'help') {
      deps.stdout.write(HELP);
      return ExitCode.OK;
    }
    let name: string;
    let args: string[];
    if (first === undefined || first.startsWith('-')) {
      args = argv;
      name = existsSync(join(dirFromArgs(args, deps), 'config.json')) ? 'run' : 'setup';
    } else {
      name = first;
      args = rest;
    }
    const cmd = COMMANDS[name];
    if (!cmd) {
      deps.stderr.write(`"${name}" is not a searchtrace command.\n\n`);
      deps.stderr.write(HELP);
      return ExitCode.CONFIG;
    }
    if (args.includes('--help') || args.includes('-h')) {
      deps.stdout.write(HELP);
      return ExitCode.OK;
    }
    return await cmd(args, deps);
  } catch (e) {
    return printError(e, deps);
  } finally {
    deps.prompter?.close();
  }
}
