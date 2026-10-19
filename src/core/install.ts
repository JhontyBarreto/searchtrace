// Where searchtrace comes from and how to name it in printed commands, hints and fix lines.
//
// searchtrace is installed from GitHub, never from the npm registry by name (the npm name is not
// ours to rely on). Every hint goes through cli() so a command we print can never fall back to
// the registry: an installed copy is called `searchtrace`, and a copy npx fetched from GitHub
// gets the same pinned GitHub spec back, quoted so zsh's extendedglob can't eat the "#".
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const REPO = 'JhontyBarreto/searchtrace';
export const REPO_URL = `https://github.com/${REPO}`;

/** A file under docs/ on GitHub. The package ships without docs/, so a bare relative path would dangle. */
export function docUrl(name: string, anchor?: string): string {
  return `${REPO_URL}/blob/main/docs/${name}${anchor ? `#${anchor}` : ''}`;
}

let cachedVersion: string | null = null;

/** The running package version, read from package.json next to src/ or dist/. */
export function toolVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.1.0';
  } catch {
    cachedVersion = '0.1.0';
  }
  return cachedVersion;
}

let cachedCommit: string | null | undefined;

/**
 * The git commit this build was made from, from dist/build-info.json (written by
 * scripts/build-info.mjs after tsc). Null when running from src/ or when the build had no git
 * checkout to read, in which case callers pin to the version tag instead.
 */
export function toolCommit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;
  try {
    const info = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8')) as { commit?: unknown };
    cachedCommit = typeof info.commit === 'string' && /^[0-9a-f]{40}$/.test(info.commit) ? info.commit : null;
  } catch {
    cachedCommit = null;
  }
  return cachedCommit;
}

/** The npm spec for this release on GitHub, double-quoted for shells (zsh extendedglob treats "#" as a glob). */
export function githubSpec(version = toolVersion()): string {
  return `"github:${REPO}#v${version}"`;
}

/** True when this copy runs out of npx's cache (`npx github:...`), where a bare `searchtrace` isn't on PATH. */
export function runsFromNpxCache(argv1: string = process.argv[1] ?? ''): boolean {
  return /[\\/]_npx[\\/]/.test(argv1);
}

/** The command a user should type to run searchtrace again, as this copy was started. */
export function cliCommand(argv1: string = process.argv[1] ?? ''): string {
  return runsFromNpxCache(argv1) ? `npx -y ${githubSpec()}` : 'searchtrace';
}

/** A full command line for a hint, e.g. cli('doctor') is "searchtrace doctor". */
export function cli(rest: string): string {
  return `${cliCommand()} ${rest}`;
}

/** ~, ~/x and ~\x expanded against home. Anything else is returned unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** A path under home as "~/..." (forward slashes), so a config.json that gets committed doesn't carry the username. */
export function homeRelative(path: string, home: string): string {
  const rel = relative(resolve(home), resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path;
  return `~/${rel.split(/[\\/]/).join('/')}`;
}
