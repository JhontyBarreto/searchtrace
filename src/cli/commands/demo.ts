// The demo command: fixture, offline pipeline, report (6.4.5). Owner: WP-F.
//
// Builds "Pipewell Plumbing" (made up) in a fresh folder, runs the pipeline offline with a fixed
// clock, and prints the report link. Nothing touches the network.
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfig, writeConfig } from '../../core/config.js';
import { StError, ExitCode } from '../../core/errors.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { addDays, fixedClock, ptDayStart } from '../../core/time.js';
import { writeDemoFixture } from '../../demo/fixture.js';
import { runPipelineWith } from '../../pipeline/run.js';
import { toolVersion } from '../../pipeline/context.js';
import { stableStringify } from '../../report/json.js';
import { layout } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { out, parseFlags, printError, resolveDeps, resolveDir, type CliDeps } from '../prompt.js';

async function prepareFolder(outFlag: string | undefined, deps: CliDeps): Promise<string> {
  if (!outFlag) return mkdtemp(join(tmpdir(), 'searchtrace-demo-'));
  const dir = resolveDir(outFlag, deps);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length) {
    throw new StError('config', `${dir} is not empty.`, 'Pick an empty folder for --out, or leave --out off to use a temporary folder.');
  }
  return dir;
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function demoCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const secrets = createSecretRegistry({ ci: false });
  try {
    const { values: v } = parseFlags(args, { out: { type: 'string' }, json: { type: 'boolean' } }, 'demo');
    if (!v.json) out(deps, 'Building a demo site (Pipewell Plumbing, made up) with 16 months of history...');
    const dir = await prepareFolder(v.out, deps);
    const store = await openStore(dir, secrets);
    const truth = await writeDemoFixture(store);
    if (!(await store.exists(layout.config))) {
      const cfg = defaultConfig(truth.property);
      await writeConfig(dir, { ...cfg, crawl: { ...cfg.crawl, enabled: false }, inspection: { ...cfg.inspection, enabled: false } });
    }
    const runAt = ptDayStart(addDays(truth.dataThrough, 3));
    if (!(await store.exists(layout.meta))) {
      await store.writeFileAtomic(layout.meta, stableStringify({ schema: 1, property: truth.property, createdAt: runAt, toolVersion: toolVersion(), demo: true }));
    }
    if (!(await store.exists('truth.json'))) await store.writeFileAtomic('truth.json', stableStringify(truth));
    const summary = await runPipelineWith({
      dir,
      demo: true,
      clock: fixedClock(runAt),
      env: {},
      secrets,
      quiet: true,
      flags: {
        dryRun: false, offline: true, noPaid: true, ci: false, yes: true, interactive: false, budgetUsd: 0, waitMinutes: 0,
        credentials: null, forceGraph: false,
      },
    });
    if (v.json) {
      out(deps, JSON.stringify({ ...summary, dir }, null, 2));
    } else if (summary.reportPath) {
      out(deps, `Report: ${pathToFileURL(summary.reportPath).href}`);
      out(deps, 'It shows every kind of answer once: a Google update, your own change, AI Overviews, normal wobble and not enough data.');
      out(deps, `Try: npx searchtrace why --dir ${dir}`);
    } else {
      const failed = summary.phases.filter((p) => p.status === 'failed').map((p) => `${p.name}: ${p.errors[0]?.message ?? 'failed'}`);
      deps.stderr.write(`The demo could not build its report.${failed.length ? ` ${failed.join(' ')}` : ''}\n`);
      return ExitCode.ERROR;
    }
    return summary.exit === 'ok' ? ExitCode.OK : ExitCode.PARTIAL;
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
