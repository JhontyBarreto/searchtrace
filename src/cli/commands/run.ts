// The run command: flags to pipeline (6.1), terminal output (6.4.1, 6.4.2). Owner: WP-F.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StError, ExitCode } from '../../core/errors.js';
import { cli, docUrl } from '../../core/install.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { diffDays, ptDate } from '../../core/time.js';
import type { Config, ExitCodeName, PhaseName, PhaseResult, PlanLine, RunSummary } from '../../core/types.js';
import { loadConfig } from '../../core/config.js';
import { PHASE_LABEL, runPipelineWith } from '../../pipeline/run.js';
import { toolVersion } from '../../pipeline/context.js';
import { fmtDate, fmtInt, fmtMoney, lowerFirst } from '../../report/format.js';
import { colorOn, displayPath, out, parseFlags, printError, resolveDeps, resolveDir, type CliDeps } from '../prompt.js';

const EXIT_NUMBER: Record<ExitCodeName, number> = {
  ok: ExitCode.OK, error: ExitCode.ERROR, config: ExitCode.CONFIG, auth: ExitCode.AUTH, partial: ExitCode.PARTIAL,
};

export const RUN_OPTIONS = {
  dir: { type: 'string' },
  'dry-run': { type: 'boolean' },
  offline: { type: 'boolean' },
  'no-paid': { type: 'boolean' },
  budget: { type: 'string' },
  wait: { type: 'string' },
  ci: { type: 'boolean' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  credentials: { type: 'string' },
  'force-graph': { type: 'boolean' },
} as const;

function numberFlag(v: string | undefined, name: string, max: number): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new StError('config', `--${name} must be a number from 0 to ${max} (got "${v}").`, `For example: --${name} ${name === 'wait' ? '20' : '0.30'}`);
  }
  return n;
}

const LABEL_WIDTH = 22;
const row = (label: string, detail: string): string => `  ${label.padEnd(LABEL_WIDTH)}${detail}`;

/** 6.4.2: the dry-run plan. */
export function formatPlan(property: string, plan: PlanLine[], config: Config, noPaid: boolean): string {
  const lines = [`Plan for ${property} (nothing will be fetched)`, '', 'Free (Google and your site)'];
  const free = plan.filter((l) => l.group === 'free');
  const paid = plan.filter((l) => l.group === 'paid');
  if (free.length) for (const l of free) lines.push(row(l.label, l.detail));
  else lines.push(row('Nothing to do', 'everything is up to date'));
  lines.push('', 'Paid (DataForSEO, standard queue)');
  if (paid.length) for (const l of paid) lines.push(row(l.label, l.detail));
  else if (config.serp.provider === 'none') lines.push(row('AI Overview checks', 'off · add a DataForSEO login to turn on'));
  else if (noPaid) lines.push(row('AI Overview checks', 'skipped for this run (--no-paid)'));
  else lines.push(row('AI Overview checks', 'nothing due this week'));
  lines.push('', `Run it for real: ${cli('run')}`);
  return `${lines.join('\n')}\n`;
}

/** Word-wraps text at 100 columns; continuation lines use `rest` (a hanging indent for bullets). */
function wrap(text: string, indent: string, width = 100, rest = indent): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const res: string[] = [];
  let line = '';
  const pad = (): string => (res.length ? rest : indent);
  for (const w of words) {
    if (line && pad().length + line.length + 1 + w.length > width) {
      res.push(pad() + line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) res.push(pad() + line);
  return res;
}

function totalRequests(p: PhaseResult): number {
  return Object.values(p.requests).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

function phaseDetail(p: PhaseResult): string {
  const notes = p.notes.filter(Boolean);
  if (p.status === 'failed') return 'stopped early, see below';
  const parts = [...notes];
  const req = totalRequests(p);
  if (req > 0 && !notes.some((n) => /request/i.test(n))) parts.push(`${fmtInt(req)} requests`);
  if (p.costUsd > 0 && !notes.some((n) => n.includes('$'))) parts.push(fmtMoney(p.costUsd));
  if (!parts.length) parts.push(p.status === 'skipped' ? 'skipped' : 'done');
  return parts.join(' · ');
}

interface FindingsDoc {
  headline?: { sentence?: string; verdict_sentence?: string };
  findings?: { id: string; kind: string; template?: string; real: string; real_label: string; badge: string; sentence: string; cause?: string | null; cause_label?: string }[];
}

/** 6.4.1: the run summary. */
export function formatRunSummary(s: RunSummary, o: { property: string; config: Config; today: string; dir: string; cwd: string; findings: FindingsDoc | null }): string {
  const lines: string[] = [`searchtrace ${toolVersion()} · ${o.property}`];
  if (s.dataThrough) {
    const n = diffDays(s.dataThrough, o.today);
    lines.push(`Data runs to ${fmtDate(s.dataThrough)} (Pacific Time).` +
      (n > 0 ? ` The last ${n} ${n === 1 ? "day is" : 'days are'} still being finalised by Google, so ${n === 1 ? "it's" : "they're"} left out.` : ''));
  } else {
    lines.push('No finished Search Console days yet.');
  }
  const last = new Map<PhaseName, PhaseResult>();
  for (const p of s.phases) last.set(p.name, p);
  lines.push('', 'Collecting');
  for (const name of ['updates', 'gsc', 'crawl', 'inspect'] as PhaseName[]) {
    const p = last.get(name);
    if (p) lines.push(row(PHASE_LABEL[name], phaseDetail(p)));
  }
  if (o.config.serp.provider === 'none') lines.push(row('AI Overview checks', 'off · add a DataForSEO login to turn on'));
  else {
    const post = last.get('serp_post');
    const got = last.get('serp_collect');
    const parts = [got && got.status !== 'skipped' ? phaseDetail(got) : '', post ? phaseDetail(post) : ''].filter(Boolean);
    lines.push(row('AI Overview checks', parts.join(' · ') || 'nothing to do'));
  }
  const failed = s.phases.filter((p) => p.status === 'failed');
  if (failed.length) {
    lines.push('');
    for (const p of failed) {
      const msg = p.errors[0]?.message ?? 'did not finish';
      lines.push(`! ${PHASE_LABEL[p.name]}: ${msg}${p.notes[0] ? ` ${p.notes[0]}` : ''}`);
    }
  }
  const partial = s.phases.filter((p) => p.status === 'partial' || p.status === 'deferred');
  for (const p of partial) lines.push(`! ${PHASE_LABEL[p.name]}: ${p.notes.join(' ') || 'stopped early. Finished work is saved; the rest happens next run.'}`);

  lines.push('', 'The answer');
  const head = o.findings?.headline;
  if (head?.sentence) {
    lines.push(...wrap(head.sentence, '  '));
    if (head.verdict_sentence) lines.push(...wrap(head.verdict_sentence, '  '));
  } else {
    const why = last.get('analyze')?.notes[0] ?? 'There is no analysis yet.';
    lines.push(...wrap(`No answer yet. ${why}`, '  '));
  }
  const fs = o.findings?.findings ?? [];
  const skip = new Set(['headline', 'update_impact', 'aio_fact', 'notice', 'index_transition']);
  const worth = fs.filter((f) => f.real === 'signal' && !skip.has(f.kind)).slice(0, 3);
  const coverage = fs.find((f) => f.template === 'coverage');
  if (worth.length || coverage) {
    lines.push('', 'Also worth knowing');
    for (const f of worth) {
      // The badge rates the cause, so it goes with the cause; an unnamed cause gets neither.
      const why = f.cause && f.cause !== 'unknown' ? ` · Why: ${f.cause_label} (${f.badge})` : '';
      lines.push(...wrap(`· ${f.real_label}: ${lowerFirst(f.sentence.replace(/\.$/, ''))}${why}`, '  ', 100, '    '));
    }
    if (coverage) {
      const parts = coverage.sentence.split(/(?<=\.)\s+/);
      const short = parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : coverage.sentence;
      lines.push(...wrap(`· ${short.replace(" to protect searchers' privacy", '')}`, '  ', 100, '    '));
    }
  }

  lines.push('');
  const dirArg = o.dir === join(o.cwd, 'searchtrace-data') ? '' : ` --dir ${displayPath(o.cwd, o.dir)}`;
  if (s.reportPath) lines.push(`Report   ${pathToFileURL(s.reportPath).href}`);
  lines.push(`Why      ${cli('why')}${dirArg}`);
  if (s.graphPath) {
    const nodes = last.get('graph')?.rows ?? 0;
    lines.push(`Graph    ${displayPath(o.cwd, s.graphPath)} (${fmtInt(nodes)} nodes)`);
    lines.push(`         ask it in Claude: ${docUrl('GRAPHIFY.md')}`);
  }
  if (s.exit === 'partial') lines.push('', "Some steps didn't finish. The report uses everything collected so far.");
  return `${lines.join('\n')}\n`;
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function runCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const { values: v } = parseFlags(args, RUN_OPTIONS, 'run');
  const ci = Boolean(v.ci);
  const secrets = createSecretRegistry({ ci });
  try {
    const dir = resolveDir(v.dir, deps);
    const budget = numberFlag(v.budget, 'budget', 100);
    const wait = numberFlag(v.wait, 'wait', 120) ?? 0;
    const quiet = Boolean(v.quiet) || Boolean(v.json);
    const config = await loadConfig(dir);
    const progress = !quiet && Boolean(deps.stderr.isTTY) && !ci;
    const summary = await runPipelineWith({
      dir,
      flags: {
        dryRun: Boolean(v['dry-run']), offline: Boolean(v.offline), noPaid: Boolean(v['no-paid']), ci, yes: Boolean(v.yes),
        interactive: deps.stdinIsTTY && !ci, budgetUsd: budget, waitMinutes: wait, credentials: v.credentials ?? null,
        forceGraph: Boolean(v['force-graph']),
      },
      clock: deps.clock,
      fetch: deps.fetch,
      env: deps.env,
      secrets,
      quiet: Boolean(v.quiet),
      color: colorOn(deps, ci),
      sleep: deps.sleep,
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
      onPhase: progress ? (name) => deps.stderr.write(`  ${PHASE_LABEL[name]}...\n`) : undefined,
    });
    if (v.json) {
      out(deps, secrets.redact(JSON.stringify(summary, null, 2)));
    } else if (summary.plan) {
      deps.stdout.write(secrets.redact(formatPlan(config.property, summary.plan, config, Boolean(v['no-paid']))));
    } else if (!v.quiet || summary.exit !== 'ok') {
      let findings: FindingsDoc | null = null;
      if (summary.reportPath) {
        try {
          findings = JSON.parse(await readFile(join(dir, 'reports', 'findings.json'), 'utf8')) as FindingsDoc;
        } catch {
          findings = null;
        }
      }
      const text = formatRunSummary(summary, { property: config.property, config, today: ptDate(deps.clock.now()), dir, cwd: deps.cwd, findings });
      deps.stdout.write(secrets.redact(text));
    }
    return EXIT_NUMBER[summary.exit] ?? ExitCode.ERROR;
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
