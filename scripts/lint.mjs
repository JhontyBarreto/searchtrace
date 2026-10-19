#!/usr/bin/env node
// Zero-dependency repo rules for searchtrace (spec 2.5). Exits 1 on any hit.
//
//   node scripts/lint.mjs               lint the repo
//   node scripts/lint.mjs --self-test   plant violations in a temp folder and prove every rule catches them
//   node scripts/lint.mjs --root DIR    lint another folder laid out like this repo
//
// Rules scan raw text, comments included, so a banned word in a comment is a hit too.
// Patterns that would trip the rules on this file are built from escapes or concatenation.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'searchtrace-data', 'graphify-out']);
const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MARKUP_EXTS = new Set(['.html', '.tmpl']);
// Rule 8 covers .ts, .md, .json and .tmpl (2.5) plus the other text formats in this repo.
const DASH_EXTS = new Set([...CODE_EXTS, ...MARKUP_EXTS, '.md', '.json', '.yml', '.yaml', '.txt', '.css']);
const MAX_SRC_LINES = 800;

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const INNER = 'inner' + 'HTML';
const DANGEROUS_INNER = 'dangerouslySet' + 'Inner' + 'HTML';

const COPY_FILE = 'src/report/copy.ts';
const WORKFLOW_TMPL = 'assets/workflow.yml.tmpl';
// searchtrace is not on the npm registry, so nothing may tell anyone to fetch it from there by name.
const REGISTRY_NPX = [new RegExp('npx\\s+' + 'searchtrace(?![\\w-])'), new RegExp('npx\\s+-y\\s+' + 'searchtrace@')];
// The GitHub spec must be quoted: zsh with extendedglob reads an unquoted "#" as a glob.
const UNQUOTED_SPEC = new RegExp('(?<![\'"])' + 'github:JhontyBarreto/searchtrace#');
// A uses: line pinned to a full commit SHA (optionally with a comment), a local action, or a digest-pinned image.
const PINNED_USES = /^\s*(?:-\s+)?uses:\s*(?:[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}|\.\/\S+|docker:\/\/\S+@sha256:[0-9a-f]{64})\s*(?:#.*)?$/;

/** @typedef {{ file: string; line: number; col: number; rule: string; message: string }} Hit */

/** Every file below root that a rule might read, as forward-slash relative paths, sorted. */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.github') continue;
        walk(abs);
      } else if (st.isFile()) {
        const ext = extname(name);
        if (DASH_EXTS.has(ext)) out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

/** Hits for every match of each regex, with 1-based line and column. */
function scan(file, lines, regexes, rule, message) {
  const hits = [];
  lines.forEach((text, i) => {
    for (const re of regexes) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of text.matchAll(g)) hits.push({ file, line: i + 1, col: (m.index ?? 0) + 1, rule, message });
    }
  });
  return hits;
}

/** Line numbers (0-based) and text of every `run:` value in a YAML file: inline, block scalar or continuation. */
function runBlockLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)run:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyCol = m[1].length;
    if (m[2].trim() === '') {
      // An empty value followed by a nested mapping or list is a key named "run" (for example a job id), not a command.
      const next = lines.slice(i + 1).find((t) => t.trim() !== '');
      if (next !== undefined && next.length - next.trimStart().length > keyCol && /^\s*(?:-(?:\s|$)|[\w.-]+\s*:(?:\s|$))/.test(next)) continue;
    }
    out.push({ index: i, text: m[2] });
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (t.trim() === '') continue;
      const indent = t.length - t.trimStart().length;
      if (indent <= keyCol) break;
      out.push({ index: j, text: t });
    }
  }
  return out;
}

const isSrcCode = (f) => f.startsWith('src/') && CODE_EXTS.has(extname(f));
const isWorkflow = (f) => f === WORKFLOW_TMPL || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f);
const isCodeOrMarkup = (f) => CODE_EXTS.has(extname(f)) || MARKUP_EXTS.has(extname(f));
const isDeterministicScope = (f) => isSrcCode(f) && /^src\/(analyze|graph|report|demo)\//.test(f);

/** @returns {Hit[]} */
function lintRoot(root) {
  /** @type {Hit[]} */
  const hits = [];
  for (const file of listFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');

    if (isSrcCode(file)) {
      // 1. No child_process anywhere in src/ (D19).
      hits.push(...scan(file, lines, [/child_process/], 'no-child-process',
        'child_process is not allowed in src/. Print file:// links or copyable text instead (D19).'));
      // 2. No eval( or new Function(.
      hits.push(...scan(file, lines, [/(?<![\w$])eval\s*\(/, /(?<![\w$])new\s+Function\s*\(/], 'no-eval',
        'eval and new Function are not allowed in src/.'));
      // 3. fetch( only in src/http/request.ts; node:sqlite only in src/index/db.ts.
      if (file !== 'src/http/request.ts') {
        hits.push(...scan(file, lines, [/(?<![\w$])fetch\s*\(/], 'fetch-only-in-request',
          'Call fetch only in src/http/request.ts. Use request() or requestJson() with the injected fetch.'));
      }
      if (file !== 'src/index/db.ts') {
        hits.push(...scan(file, lines, [/node:sqlite/], 'sqlite-only-in-db',
          'Import node:sqlite only in src/index/db.ts.'));
      }
      // 4. console only in src/core/log.ts and src/bin.ts.
      if (file !== 'src/core/log.ts' && file !== 'src/bin.ts') {
        hits.push(...scan(file, lines, [/(?<![\w$])console\s*[.[]/], 'console-only-in-log',
          'Use the injected Logger. console is allowed only in src/core/log.ts and src/bin.ts.'));
      }
      // 9. No src file over 800 lines.
      const count = text.endsWith('\n') ? lines.length - 1 : lines.length;
      if (count > MAX_SRC_LINES) {
        hits.push({ file, line: MAX_SRC_LINES + 1, col: 1, rule: 'max-lines',
          message: `${count} lines; source files in src/ must stay at or under ${MAX_SRC_LINES}. Split into helpers.` });
      }
    }

    // 5. Determinism in analyze, graph, report and demo: inject Rng and Clock instead.
    if (isDeterministicScope(file)) {
      hits.push(...scan(file, lines,
        [/Math\.random/, /(?<![\w$])Date\.now\s*\(/, /(?<![\w$])new\s+Date\s*\(\s*\)/, /(?<![\w$])new\s+Date\b(?!\s*\()/],
        'determinism', 'No Math.random, Date.now() or argless new Date() here. Use the injected Rng and Clock.'));
    }

    // 6. No raw HTML injection sinks anywhere.
    if (isCodeOrMarkup(file)) {
      hits.push(...scan(file, lines, [new RegExp(DANGEROUS_INNER), new RegExp(`\\.${INNER}\\b`)], 'no-inner-html',
        `${DANGEROUS_INNER} and .${INNER} are not allowed. Build strings with esc().`));
    }

    // 7. The Action template: explicit-path commits and no event data in run: blocks.
    if (file === WORKFLOW_TMPL) {
      hits.push(...scan(file, lines, [/git\s+add\s+(?:-A|--all|\.)(?=\s|$|;|&|\||\))/], 'workflow-git-add',
        'Commit explicit paths only (no git add -A, --all or .).'));
      for (const { index, text: t } of runBlockLines(lines)) {
        const m = /\$\{\{\s*github\.event/.exec(t);
        if (m) {
          hits.push({ file, line: index + 1, col: m.index + 1, rule: 'workflow-event-in-run',
            message: 'Never put ${{ github.event... }} inside a run: block. Pass it through env: instead.' });
        }
      }
    }

    // 11. Every action a workflow uses is pinned to a full commit SHA (tags can be moved).
    if (isWorkflow(file)) {
      lines.forEach((t, i) => {
        if (/^\s*(?:-\s+)?uses:/.test(t) && !PINNED_USES.test(t)) {
          hits.push({ file, line: i + 1, col: t.indexOf('uses:') + 1, rule: 'workflow-uses-sha',
            message: 'Pin every uses: to a full 40-character commit SHA with a version comment, e.g. actions/checkout@<sha> # v7.0.1.' });
        }
      });
    }

    // 12. Never point anyone at the npm registry name, and always quote the GitHub spec.
    if (file !== 'scripts/lint.mjs') {
      hits.push(...scan(file, lines, REGISTRY_NPX, 'no-registry-npx',
        'searchtrace is installed from GitHub, not the npm registry. Use cli() in src, or the GitHub install in docs.'));
      hits.push(...scan(file, lines, [UNQUOTED_SPEC], 'quote-github-spec',
        'Quote the GitHub spec ("github:JhontyBarreto/searchtrace#v1.2.3"): zsh with extendedglob treats an unquoted # as a glob.'));
    }

    // 8. No em or en dashes in text files.
    if (DASH_EXTS.has(extname(file))) {
      hits.push(...scan(file, lines, [new RegExp(`[${EM_DASH}${EN_DASH}]`)], 'no-long-dash',
        'Em and en dashes are not allowed. Use a comma, a full stop, "to" for ranges, or rewrite the sentence.'));
    }

    // 10. Banned words in the copy deck.
    if (file === COPY_FILE) {
      hits.push(...scan(file, lines,
        [/statistically significant/i, /(?<![\w-])p-value/i, /(?<![\w$])DiD(?![\w$])/, /(?<![\w$])CTR(?![\w$])/],
        'copy-banned-words', 'Copy must not say "statistically significant", "p-value", "DiD" or "CTR" (say "click rate").'));
    }
  }
  return hits;
}

function report(hits) {
  for (const h of hits) process.stderr.write(`${h.file}:${h.line}:${h.col}  ${h.rule}  ${h.message}\n`);
}

/** Plants one violation per rule (plus allowed exceptions) in a temp folder and checks the result. */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'searchtrace-lint-'));
  const put = (rel, body) => {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const checks = [];
  try {
    // The two planted violations the spec names.
    put('src/planted/child.ts', "import { exec } from 'node:child_process';\nexport const run = exec;\n");
    put('docs/planted.md', `# Notes\n\nOne thing ${EM_DASH} then another.\n`);
    // One for every other rule.
    put('src/planted/evil.ts', "export const x = eval('1');\nexport const f = new Function('return 1');\n");
    put('src/planted/net.ts', "export const get = () => fetch('https://example.com/');\n");
    put('src/planted/db.ts', "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;\n");
    put('src/planted/log.ts', "console.log('hi');\n");
    put('src/analyze/planted.ts', 'export const a = Math.random();\nexport const b = Date.now();\nexport const c = new Date();\n');
    put('src/report/planted.ts', `export const h = (el: { ${INNER}: string }) => { el.${INNER} = 'x'; };\n`);
    put(WORKFLOW_TMPL, [
      'jobs:', '  run:', '    steps:',
      '      - name: bad', '        run: |', '          git add -A', '          echo "${{ github.event.issue.title }}"',
      '      - name: fine', '        env:', '          TITLE: ${{ github.event.issue.title }}', '        run: echo "$TITLE"',
      '      - name: explicit paths', '        run: |', '          for p in config.json gsc; do git add -- "$p"; done',
      '',
    ].join('\n'));
    put('src/planted/long.ts', `${Array.from({ length: MAX_SRC_LINES + 1 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
    put(COPY_FILE, "export const s = 'Your CTR fell, a DiD with a p-value says it is statistically significant.';\n");
    put('test/planted.json', `{ "range": "1${EN_DASH}2" }\n`);
    put('.github/workflows/planted.yml', [
      'jobs:', '  a:', '    steps:',
      '      - uses: actions/checkout@v7', '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
      '      - uses: ./local-action', '',
    ].join('\n'));
    put('docs/install.md', ['Run `npx ' + 'searchtrace demo`.', 'Or npx -y ' + 'searchtrace@0.1.0 run.', 'Or npm i -g ' + 'github:JhontyBarreto/searchtrace#v0.1.0.', ''].join('\n'));
    put('docs/fine.md', ['Run `npx -y "' + 'github:JhontyBarreto/searchtrace#v0.1.0" demo`.', 'Then `searchtrace why`, or npx searchtrace-other.', ''].join('\n'));
    // Allowed exceptions and clean files: these must produce no hits.
    put('src/http/request.ts', 'export const r = (f: typeof fetch) => f;\nexport const go = () => fetch("x");\n');
    put('src/index/db.ts', "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;\n");
    put('src/core/log.ts', "console.error('ok');\n");
    put('src/bin.ts', "console.error('ok');\n");
    put('src/core/clock.ts', 'export const now = () => new Date();\nexport const later = new Date(0);\n');
    put('src/analyze/clean.ts', "export const d = new Date('2026-10-03T00:00:00Z');\nexport const fetchFn = 1;\nexport const prefetch = () => 1;\n");
    put('test/unit/allowed.test.ts', "import { execFileSync } from 'node:child_process';\nexport const e = execFileSync;\n");

    const hits = lintRoot(root);
    const has = (file, rule, min = 1) => hits.filter((h) => h.file === file && h.rule === rule).length >= min;
    const none = (file) => !hits.some((h) => h.file === file);
    checks.push(
      ['planted child_process import is caught', has('src/planted/child.ts', 'no-child-process')],
      ['planted em dash is caught', has('docs/planted.md', 'no-long-dash')],
      ['planted en dash in JSON is caught', has('test/planted.json', 'no-long-dash')],
      ['eval and new Function are caught', has('src/planted/evil.ts', 'no-eval', 2)],
      ['fetch outside request.ts is caught', has('src/planted/net.ts', 'fetch-only-in-request')],
      ['node:sqlite outside db.ts is caught', has('src/planted/db.ts', 'sqlite-only-in-db')],
      ['console outside log.ts and bin.ts is caught', has('src/planted/log.ts', 'console-only-in-log')],
      ['Math.random, Date.now and new Date() in analyze are caught', has('src/analyze/planted.ts', 'determinism', 3)],
      ['raw HTML sink is caught', has('src/report/planted.ts', 'no-inner-html')],
      ['git add -A in the Action template is caught', has(WORKFLOW_TMPL, 'workflow-git-add')],
      ['explicit-path git add is allowed', hits.filter((h) => h.rule === 'workflow-git-add').length === 1],
      ['github.event inside run: is caught', has(WORKFLOW_TMPL, 'workflow-event-in-run', 1)],
      ['github.event inside env: is allowed', hits.filter((h) => h.rule === 'workflow-event-in-run').length === 1],
      ['a src file over 800 lines is caught', has('src/planted/long.ts', 'max-lines')],
      ['banned copy words are caught', has(COPY_FILE, 'copy-banned-words', 4)],
      ['fetch inside request.ts is allowed', none('src/http/request.ts')],
      ['node:sqlite inside db.ts is allowed', none('src/index/db.ts')],
      ['console inside log.ts and bin.ts is allowed', none('src/core/log.ts') && none('src/bin.ts')],
      ['new Date() outside the determinism scope is allowed', none('src/core/clock.ts')],
      ['dated new Date(...) and fetch-like names are allowed', none('src/analyze/clean.ts')],
      ['child_process in test/ is allowed', none('test/unit/allowed.test.ts')],
      ['a tag-pinned uses: is caught', hits.filter((h) => h.file === '.github/workflows/planted.yml' && h.rule === 'workflow-uses-sha').length === 1],
      ['npx with the registry name is caught', has('docs/install.md', 'no-registry-npx', 2)],
      ['an unquoted GitHub spec is caught', has('docs/install.md', 'quote-github-spec')],
      ['a quoted GitHub spec and other packages are allowed', none('docs/fine.md')],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  let ok = true;
  for (const [name, pass] of checks) {
    process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}\n`);
    if (!pass) ok = false;
  }
  process.stdout.write(ok ? `lint self-test passed (${checks.length} checks)\n` : 'lint self-test FAILED\n');
  return ok;
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1;
} else {
  const at = process.argv.indexOf('--root');
  const root = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : dirname(dirname(fileURLToPath(import.meta.url)));
  const hits = lintRoot(root);
  report(hits);
  if (hits.length) {
    process.stderr.write(`\nlint: ${hits.length} problem${hits.length === 1 ? '' : 's'}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('lint: clean\n');
  }
}
