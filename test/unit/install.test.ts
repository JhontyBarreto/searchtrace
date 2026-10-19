// How searchtrace is installed and named in printed commands: from GitHub, never the npm registry name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP } from '../../src/cli/main.js';
import { cliCommand, docUrl, expandHome, githubSpec, homeRelative, runsFromNpxCache, toolCommit, toolVersion } from '../../src/core/install.js';

const ROOT = join(__dirname, '..', '..');

describe('naming the command', () => {
  it('is plain `searchtrace` for an installed copy, and the quoted GitHub spec under npx', () => {
    expect(cliCommand('/usr/local/bin/searchtrace')).toBe('searchtrace');
    expect(cliCommand('/home/me/.nvm/versions/node/v22/lib/node_modules/searchtrace/dist/bin.js')).toBe('searchtrace');
    const npx = '/Users/me/.npm/_npx/4f1c2a/node_modules/.bin/searchtrace';
    expect(runsFromNpxCache(npx)).toBe(true);
    expect(runsFromNpxCache('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\4f1c2a\\node_modules\\searchtrace\\dist\\bin.js')).toBe(true);
    expect(cliCommand(npx)).toBe(`npx -y "github:JhontyBarreto/searchtrace#v${toolVersion()}"`);
  });

  it('quotes the GitHub spec, so zsh with extendedglob keeps the #', () => {
    expect(githubSpec('0.1.0')).toBe('"github:JhontyBarreto/searchtrace#v0.1.0"');
  });

  it('links docs on GitHub, because the package ships without docs/', () => {
    expect(docUrl('GRAPHIFY.md')).toBe('https://github.com/JhontyBarreto/searchtrace/blob/main/docs/GRAPHIFY.md');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).not.toContain('docs');
  });
});

describe('home paths', () => {
  it('expands ~ and writes paths under home as ~/', () => {
    expect(expandHome('~/k.json', '/home/me')).toBe(join('/home/me', 'k.json'));
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    expect(expandHome('/abs/k.json', '/home/me')).toBe('/abs/k.json');
    expect(homeRelative('/home/me/.config/searchtrace/google-key.json', '/home/me')).toBe('~/.config/searchtrace/google-key.json');
    expect(homeRelative('/srv/keys/k.json', '/home/me')).toBe('/srv/keys/k.json');
    expect(homeRelative('/home/meme/k.json', '/home/me')).toBe('/home/meme/k.json');
  });
});

describe('the package installs from GitHub', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>; bin: Record<string, string>; files: string[];
  };

  it('builds dist/ on a git install (prepare), and records the commit for the workflow pin', () => {
    // Without prepare, a git install ships no dist/bin.js and the command doesn't exist.
    expect(pkg.scripts.prepare).toBe('npm run build');
    expect(pkg.scripts.build).toContain('node scripts/build-info.mjs');
    expect(pkg.bin.searchtrace).toBe('dist/bin.js');
    expect(pkg.files).toContain('dist');
  });

  it('ships no source maps that point at sources the package leaves out', () => {
    expect(pkg.scripts.build).toContain('--sourceMap false');
  });

  it('knows no commit when running from src/ (the workflow then pins the version tag)', () => {
    expect(toolCommit()).toBeNull();
  });

  it('shows the demo flag and an honest demo time in --help', () => {
    expect(HELP).toContain('--out DIR');
    expect(HELP).toContain('in under 30 seconds');
    expect(HELP).toContain('--share');
  });
});
