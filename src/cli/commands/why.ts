// The why command (6.4.3). Owner: WP-F.
// Rebuilds the analysis offline from the saved data (no network), then shows the evidence chain.
import { loadConfig } from '../../core/config.js';
import { createSecretRegistry } from '../../core/secrets.js';
import type { AnalysisOutput } from '../../core/types.js';
import { openIndex } from '../../index/db.js';
import { analyzeIndex } from '../../pipeline/run.js';
import { findingToJson, stableStringify } from '../../report/json.js';
import { matchWhy, renderWhy } from '../../report/why.js';
import { layout, resolveInside } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { colorOn, out, parseFlags, printError, resolveDeps, resolveDir, type CliDeps } from '../prompt.js';

/** Syncs the index and runs the analysis over the saved data. Null when no day is sealed yet. */
export async function analyzeDataDir(dir: string, secrets = createSecretRegistry({ ci: false })): Promise<AnalysisOutput | null> {
  const config = await loadConfig(dir);
  const store = await openStore(dir, secrets);
  const index = await openIndex(resolveInside(store.root, layout.index));
  try {
    await index.sync(store);
    return analyzeIndex(index, config);
  } finally {
    index.close();
  }
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function whyCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const secrets = createSecretRegistry({ ci: false });
  try {
    const { values: v, positionals } = parseFlags(args, { dir: { type: 'string' }, json: { type: 'boolean' } }, 'why');
    const target = positionals.length ? positionals.join(' ') : null;
    const dir = resolveDir(v.dir, deps);
    const result = await analyzeDataDir(dir, secrets);
    if (!result) {
      deps.stderr.write('No finished Search Console days yet, so there is nothing to explain.\nRun `npx searchtrace run` first.\n');
      return 0;
    }
    if (v.json) {
      const m = matchWhy(result, target);
      out(deps, stableStringify({
        target, match: m.kind, findings: m.findings.map((f) => findingToJson(f, result.property)), events: m.events, suggestions: m.suggestions,
      }).trimEnd());
      return 0;
    }
    deps.stdout.write(renderWhy(result, target, { color: colorOn(deps) }));
    return 0;
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
