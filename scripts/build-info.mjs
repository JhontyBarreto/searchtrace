#!/usr/bin/env node
// Writes dist/build-info.json: { version, commit }. Runs after tsc in `npm run build`.
//
// setup --github pins the generated workflow to `commit`, an immutable 40-character SHA, rather
// than a tag someone could move. The commit is read straight from .git (no git binary, nothing
// spawned), so it works in a clone, in CI and in the temporary clone npm makes when it installs
// searchtrace from GitHub. With no .git (a tarball build), commit is null and setup falls back to
// the version tag. SEARCHTRACE_BUILD_COMMIT overrides it for unusual build setups.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = /^[0-9a-f]{40}$/;

/** The .git directory for root: a folder, or a "gitdir: ..." file (worktrees and submodules). */
function gitDir(dir) {
  const dotgit = join(dir, '.git');
  if (!existsSync(dotgit)) return null;
  if (statSync(dotgit).isDirectory()) return dotgit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
  return m ? resolve(dir, m[1].trim()) : null;
}

/** HEAD as a commit SHA, following one symbolic ref through loose refs or packed-refs. */
function headCommit(dir) {
  const git = gitDir(dir);
  if (!git) return null;
  let head;
  try {
    head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  if (SHA.test(head)) return head;
  const m = /^ref:\s*(\S+)$/.exec(head);
  if (!m) return null;
  const ref = m[1];
  // A worktree keeps its refs in the common dir.
  const common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git;
  for (const base of [git, common]) {
    try {
      const v = readFileSync(join(base, ...ref.split('/')), 'utf8').trim();
      if (SHA.test(v)) return v;
    } catch {
      // not a loose ref here
    }
  }
  try {
    for (const line of readFileSync(join(common, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && SHA.test(sha)) return sha;
    }
  } catch {
    // no packed-refs
  }
  return null;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const override = process.env.SEARCHTRACE_BUILD_COMMIT;
const commit = override && SHA.test(override) ? override : headCommit(root);
writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify({ version: pkg.version, commit }, null, 2)}\n`);
process.stdout.write(`build-info: ${pkg.version} at ${commit ?? 'an unknown commit (the workflow will pin the version tag)'}\n`);
