// The note command, backed by sources/annotations.ts (6.4.5). Owner: WP-F.
//
//   searchtrace note "New title template on blog posts" --date 2026-09-09 --urls "/blog/*"
//
// --urls takes a comma-separated list of paths or full URLs, or globs with "*" matched against
// the pages searchtrace already knows (Search Console and crawl). Every URL must be on the property.
import { loadConfig } from '../../core/config.js';
import { StError } from '../../core/errors.js';
import { createSecretRegistry } from '../../core/secrets.js';
import { isIsoDate } from '../../core/time.js';
import { defaultOrigins, isOnProperty, normalizeUrl, pathOf } from '../../core/url.js';
import type { ChangeField } from '../../core/types.js';
import { openIndex } from '../../index/db.js';
import { addAnnotation } from '../../sources/annotations.js';
import { fmtDate, fmtInt, plural } from '../../report/format.js';
import { layout, resolveInside } from '../../store/layout.js';
import { openStore } from '../../store/store.js';
import { out, parseFlags, printError, resolveDeps, resolveDir, type CliDeps } from '../prompt.js';

const FIELDS: ChangeField[] = ['annotation', 'title', 'metaDescription', 'h1', 'body', 'canonical', 'metaRobots'];
const MAX_TEXT = 500;

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

/** Resolves --urls against the known pages. Exported for tests. */
export function resolveNoteUrls(spec: string, o: { property: string; origin: string; known: string[] }): string[] {
  const items = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new StError('config', 'No URLs given.', 'Pass --urls with paths or URLs, for example --urls "/blog/*" or --urls "/pricing,/about".');
  const found = new Set<string>();
  for (const item of items) {
    const absolute = /^https?:\/\//i.test(item);
    if (item.includes('*')) {
      const re = globToRegExp(item);
      const hits = o.known.filter((u) => re.test(absolute ? u : pathOf(u)));
      if (!hits.length) {
        throw new StError('config', `No known pages match "${item}".`,
          'Run `npx searchtrace run` first so searchtrace knows your pages, or list the URLs with commas.');
      }
      for (const h of hits) found.add(h);
      continue;
    }
    let url: string;
    try {
      url = normalizeUrl(absolute ? item : new URL(item.startsWith('/') ? item : `/${item}`, o.origin).href);
    } catch {
      throw new StError('config', `"${item}" is not a page path or URL.`, 'Use a path like /pricing or a full URL like https://example.com/pricing.');
    }
    if (!isOnProperty(url, o.property)) {
      throw new StError('config', `${url} is not part of ${o.property}.`, 'Only pages on your own Search Console property can be noted.');
    }
    found.add(url);
  }
  return [...found].sort();
}

/** args are the arguments after the command name. Resolves to the process exit code. */
export async function noteCommand(args: string[], partial?: Partial<CliDeps>): Promise<number> {
  const deps = resolveDeps(partial);
  const secrets = createSecretRegistry({ ci: false });
  try {
    const { values: v, positionals } = parseFlags(args, {
      dir: { type: 'string' }, date: { type: 'string' }, urls: { type: 'string' }, field: { type: 'string' },
    }, 'note');
    const text = positionals.join(' ').trim();
    if (!text) throw new StError('config', 'Say what changed.', 'For example: searchtrace note "New title template on blog posts" --date 2026-09-09 --urls "/blog/*"');
    if (text.length > MAX_TEXT) throw new StError('config', `Keep the note under ${MAX_TEXT} characters.`, 'Shorten the text and try again.');
    if (!v.date || !isIsoDate(v.date)) throw new StError('config', 'Give the date of the change as --date YYYY-MM-DD.', 'For example: --date 2026-09-09');
    if (!v.urls) throw new StError('config', 'Say which pages changed with --urls.', 'For example: --urls "/blog/*" or --urls "/pricing,/about"');
    const field = (v.field ?? 'annotation') as ChangeField;
    if (!FIELDS.includes(field)) {
      throw new StError('config', `--field must be one of ${FIELDS.filter((f) => f !== 'annotation').join(', ')}.`, 'Leave it out for a general note.');
    }
    const dir = resolveDir(v.dir, deps);
    const config = await loadConfig(dir);
    const store = await openStore(dir, secrets);
    const index = await openIndex(resolveInside(store.root, layout.index));
    let known: string[];
    try {
      await index.sync(store);
      known = index.pages().map((p) => p.url);
    } finally {
      index.close();
    }
    const origin = config.siteOrigin ?? defaultOrigins(config.property)[0];
    const urls = resolveNoteUrls(v.urls, { property: config.property, origin, known });
    await addAnnotation(store, { date: v.date, text, urls, field }, deps.clock);
    out(deps, `Noted for ${fmtDate(v.date)}: "${text}" (${fmtInt(urls.length)} ${plural(urls.length, 'page', 'pages')}). ` +
      "The next run will test it against pages you didn't change.");
    return 0;
  } catch (e) {
    return printError(e, deps, secrets);
  }
}
