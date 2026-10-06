// Logger: NO_COLOR, --quiet, CI annotations (::warning:: ::error:: ::debug::), redaction via secrets. Owner: WP-A.
//
// Streams: log lines go to stderr, so stdout stays clean for --json and for the commands'
// own output. GitHub workflow commands (::warning::, ::error::, ::debug::) go to stdout,
// where the runner reads them. Every message passes through SecretRegistry.redact first.
// Debug lines print only when SEARCHTRACE_DEBUG is set (or RUNNER_DEBUG=1 in CI).
import { styleText } from 'node:util';
import type { Logger, SecretRegistry } from './types.js';

const PROGRESS_INTERVAL_MS = 200;

function escapeCommandData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function createLogger(o: { quiet: boolean; ci: boolean; color: boolean; secrets: SecretRegistry }): Logger {
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
  const color = o.color && !noColor;
  const debugOn = envFlag('SEARCHTRACE_DEBUG') || (o.ci && process.env.RUNNER_DEBUG === '1');
  const paint = (style: Parameters<typeof styleText>[0], text: string): string =>
    color ? styleText(style, text, { validateStream: false }) : text;

  let progressShown = false;
  let lastProgressAt = 0;

  const clean = (msg: unknown): string => o.secrets.redact(typeof msg === 'string' ? msg : String(msg));
  const clearProgress = (): void => {
    if (progressShown) {
      process.stderr.write('\r\x1b[2K');
      progressShown = false;
    }
  };
  const line = (text: string): void => {
    clearProgress();
    process.stderr.write(`${text}\n`);
  };
  const command = (name: 'warning' | 'error' | 'debug', text: string): void => {
    clearProgress();
    process.stdout.write(`::${name}::${escapeCommandData(text)}\n`);
  };

  return {
    info(msg: string): void {
      if (o.quiet) return;
      line(clean(msg));
    },
    warn(msg: string): void {
      const m = clean(msg);
      if (o.ci) command('warning', m);
      else line(`${paint('yellow', 'Warning:')} ${m}`);
    },
    error(msg: string): void {
      const m = clean(msg);
      if (o.ci) command('error', m);
      else line(`${paint('red', 'Error:')} ${m}`);
    },
    debug(msg: string): void {
      if (!debugOn) return;
      const m = clean(msg);
      if (o.ci) command('debug', m);
      else line(paint('dim', `debug: ${m}`));
    },
    progress(label: string, done: number, total: number): void {
      if (o.quiet || o.ci || !process.stderr.isTTY) return;
      const finished = total > 0 && done >= total;
      const now = Date.now();
      if (!finished && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      const pct = total > 0 ? ` (${Math.floor((100 * Math.min(done, total)) / total)}%)` : '';
      process.stderr.write(`\r\x1b[2K${clean(label)} ${done} of ${total}${pct}`);
      progressShown = true;
      if (finished) {
        process.stderr.write('\n');
        progressShown = false;
      }
    },
  };
}
