// Backend for `searchtrace note`: append and read annotations.ndjson. Owner: WP-C.
//
// annotations.ndjson is append-only: one JSON object per line. Each append rewrites the file
// atomically (read, add one line, write to a temporary name, rename), so a crash leaves either
// the old file or the new one. Readers skip lines that do not parse or do not look like an
// Annotation. Annotation text is untrusted user input: it is stored as given (trimmed) and must
// be escaped wherever it is shown.
import { StError } from '../core/errors.js';
import { b32, sha256Hex } from '../core/ids.js';
import { isIsoDate } from '../core/time.js';
import type { Annotation, ChangeField, Clock, DataStore } from '../core/types.js';
import { layout } from '../store/layout.js';
import { normalizeUrl } from '../core/url.js';

const CHANGE_FIELDS: ReadonlySet<ChangeField> = new Set<ChangeField>([
  'title', 'metaDescription', 'metaRobots', 'xRobotsTag', 'canonical', 'h1',
  'jsonLdTypes', 'internalLinks', 'body', 'status', 'annotation',
]);
const MAX_TEXT = 500;
const MAX_URLS = 50_000;

function instantOf(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function noteError(message: string, fix: string): StError {
  return new StError('config', message, fix);
}

export async function addAnnotation(store: DataStore, a: Omit<Annotation, 'id' | 'at'>, clock: Clock): Promise<Annotation> {
  const text = String(a.text ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') throw noteError('The note is empty.', 'Describe the change in a few words, for example: searchtrace note "New title template on blog posts" --date 2026-09-09 --urls "/blog/*"');
  if (text.length > MAX_TEXT) throw noteError(`The note is ${text.length} characters long.`, `Keep it under ${MAX_TEXT} characters.`);
  if (!isIsoDate(a.date)) throw noteError(`"${String(a.date).slice(0, 40)}" is not a date.`, 'Use --date YYYY-MM-DD, for example --date 2026-09-09.');
  const field: ChangeField = CHANGE_FIELDS.has(a.field) ? a.field : 'annotation';
  if (!Array.isArray(a.urls)) throw noteError('No pages were given for the note.', 'Pass --urls with a list of URLs or a pattern such as "/blog/*".');
  if (a.urls.length > MAX_URLS) throw noteError(`The note lists ${a.urls.length} pages.`, `Keep it under ${MAX_URLS} pages.`);
  const urls = new Set<string>();
  for (const u of a.urls) {
    try {
      urls.add(normalizeUrl(String(u)));
    } catch {
      throw noteError(`"${String(u).slice(0, 200)}" is not a full web address.`, 'Use full URLs starting with https://, or a path pattern such as "/blog/*".');
    }
  }
  const at = instantOf(clock.now());
  const sorted = [...urls].sort();
  const id = `a${b32(sha256Hex(JSON.stringify([at, a.date, text, field, sorted]))).slice(0, 15)}`;
  const record: Annotation = { id, at, date: a.date, text, urls: sorted, field };

  const existing = (await store.readFile(layout.annotations)) ?? '';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await store.writeFileAtomic(layout.annotations, `${existing}${sep}${JSON.stringify(record)}\n`);
  return record;
}

function asAnnotation(v: unknown): Annotation | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.at !== 'string' || typeof o.text !== 'string') return null;
  if (typeof o.date !== 'string' || !isIsoDate(o.date)) return null;
  if (!Array.isArray(o.urls) || !o.urls.every((u) => typeof u === 'string')) return null;
  const field = typeof o.field === 'string' && CHANGE_FIELDS.has(o.field as ChangeField) ? (o.field as ChangeField) : 'annotation';
  return { id: o.id, at: o.at, date: o.date, text: o.text, urls: [...(o.urls as string[])], field };
}

/** Every stored annotation in file order. Torn or malformed lines are skipped; a repeated id keeps the last copy. */
export async function readAnnotations(store: DataStore): Promise<Annotation[]> {
  const text = await store.readFile(layout.annotations);
  if (!text) return [];
  const byId = new Map<string, Annotation>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line, (key, value: unknown) => (key === '__proto__' ? undefined : value));
    } catch {
      continue;
    }
    const a = asAnnotation(parsed);
    if (a) byId.set(a.id, a);
  }
  return [...byId.values()];
}
