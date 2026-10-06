// Acceptance (9.2 WP-A): loading the CLI prints no SQLite ExperimentalWarning.
// Runs real Node child processes (child_process is fine in tests; lint forbids it in src/ only).
//  1. Always: src/bin.ts is transpiled on the fly, and a child imports it, installs the filter
//     and loads node:sqlite. A control child without the filter shows the warning does appear.
//  2. When dist/ has been built: a child imports dist/bin.js as the entry script, then loads
//     dist/index/db.js (the node:sqlite importer), and stderr must not mention the warning.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'searchtrace-bin-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runNode(code: string, env: Record<string, string | undefined>): { stdout: string; stderr: string; status: number | null } {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) childEnv[k] = v;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 60_000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('SQLite ExperimentalWarning', () => {
  const source = readFileSync(join(ROOT, 'src', 'bin.ts'), 'utf8');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const binJs = join(work, 'bin.mjs');
  writeFileSync(binJs, out.outputText);
  const binUrl = pathToFileURL(binJs).href;

  it('is silenced by the bin.ts filter in a real process', () => {
    const silenced = runNode(
      `const bin = await import(${JSON.stringify(binUrl)}); bin.silenceSqliteWarning();
       const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close();
       process.emitWarning('a different warning still prints', 'ExperimentalWarning');
       console.log('LOADED');`,
      { VITEST: '1' },
    );
    expect(silenced.stdout).toContain('LOADED');
    expect(silenced.stderr).not.toMatch(/SQLite/);
    expect(silenced.stderr).toContain('a different warning still prints');

    const control = runNode(`await import('node:sqlite'); console.log('LOADED');`, { VITEST: '1' });
    expect(control.stdout).toContain('LOADED');
    // Node versions that no longer flag SQLite as experimental print nothing either way.
    if (!/ExperimentalWarning/.test(control.stderr)) return;
    expect(control.stderr).toMatch(/SQLite/);
  });

  const distBin = join(ROOT, 'dist', 'bin.js');
  const distDb = join(ROOT, 'dist', 'index', 'db.js');
  it.skipIf(!existsSync(distBin) || !existsSync(distDb))('importing the built dist/bin.js prints none', () => {
    const r = runNode(
      `process.argv = [process.argv[0], ${JSON.stringify(distBin)}, '--version'];
       await import(${JSON.stringify(pathToFileURL(distBin).href)});
       await import(${JSON.stringify(pathToFileURL(distDb).href)});
       console.log('LOADED');`,
      { VITEST: undefined },
    );
    expect(r.stdout).toContain('LOADED');
    expect(r.stderr).not.toMatch(/ExperimentalWarning/);
  });
});
