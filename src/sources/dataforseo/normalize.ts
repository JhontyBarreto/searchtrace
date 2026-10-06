// Raw task_get/advanced result -> SerpObservation, with the recursive references walk (4.5). Owner: WP-D.
//
// Accepts the whole response envelope, one task object, or a bare result object. The payload is
// untrusted: it is parsed with zod into fresh objects and only the fields below are kept.
// - itemTypes from result.item_types.
// - aio: the first top-level item with type 'ai_overview', or null when there is none.
// - refs: every references[] entry found anywhere inside that item (nested items included),
//   deduplicated by URL in the order found.
// - citesUs: some ref domain (www. stripped) matches the site domain.
// - organic: the first 10 'organic' items; ours: the first of them on our domain.
// - observedAt: result.datetime as a UTC ISO instant.
import { z } from 'zod';
import { StError } from '../../core/errors.js';
import { domainMatches } from '../../core/url.js';
import type { AioRef, Device, SampleDesignKind, SerpObservation } from '../../core/types.js';
import { parseDfsDatetime } from './client.js';

const MAX_DEPTH = 24;
const MAX_REFS = 200;
const MAX_TEXT = 500;

const ItemSchema = z.looseObject({
  type: z.string().optional(),
  rank_absolute: z.number().nullish(),
  rank_group: z.number().nullish(),
  domain: z.string().nullish(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  asynchronous_ai_overview: z.boolean().nullish(),
});
const ResultSchema = z.looseObject({
  keyword: z.string().nullish(),
  location_code: z.number().nullish(),
  language_code: z.string().nullish(),
  datetime: z.string().nullish(),
  item_types: z.array(z.string()).nullish(),
  items: z.array(z.unknown()).nullish(),
});
const TaskSchema = z.looseObject({
  id: z.string(),
  data: z.record(z.string(), z.unknown()).nullish(),
  result: z.array(z.unknown()).nullish(),
});

export function stripWww(domain: string): string {
  const d = String(domain ?? '').trim().toLowerCase().replace(/\.$/, '');
  return d.startsWith('www.') ? d.slice(4) : d;
}

function clip(s: string | null | undefined, n = MAX_TEXT): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** DataForSEO devices are desktop (its default), mobile and tablet; tablet counts as mobile (D22). */
function asDevice(v: unknown): Device {
  return v === 'mobile' || v === 'tablet' ? 'mobile' : 'desktop';
}

/** Every references[] entry under node (any depth), in document order, deduplicated by URL. */
export function collectRefs(node: unknown): AioRef[] {
  const out: AioRef[] = [];
  const seen = new Set<string>();
  const walk = (x: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_REFS || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const v of x) walk(v, depth + 1);
      return;
    }
    const obj = x as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === 'references' && Array.isArray(v)) {
        for (const r of v) {
          if (out.length >= MAX_REFS) break;
          if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
          const ref = r as Record<string, unknown>;
          const url = typeof ref.url === 'string' ? ref.url.trim() : '';
          if (!url || seen.has(url)) continue;
          const domain = typeof ref.domain === 'string' && ref.domain.trim() ? ref.domain : hostOf(url);
          if (!domain) continue;
          seen.add(url);
          out.push({
            domain: domain.trim().toLowerCase(),
            url: url.slice(0, 2000),
            title: clip(typeof ref.title === 'string' ? ref.title : null),
            source: clip(typeof ref.source === 'string' ? ref.source : null, 200),
          });
        }
      }
      walk(v, depth + 1);
    }
  };
  walk(node, 0);
  return out;
}

/** Picks the task object out of an envelope, a task, or returns null for a bare result. */
function taskOf(raw: unknown): z.infer<typeof TaskSchema> | null {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) {
    const first = (raw as { tasks: unknown[] }).tasks[0];
    const t = TaskSchema.safeParse(first);
    return t.success ? t.data : null;
  }
  const t = TaskSchema.safeParse(raw);
  return t.success && Array.isArray(t.data.result) ? t.data : null;
}

export function normalizeSerp(
  raw: unknown,
  ctx: { intentKey: string; isoWeek: string; design: SampleDesignKind; pi: number; siteDomain: string },
): SerpObservation {
  const task = taskOf(raw);
  const rawResult = task ? (task.result ?? [])[0] : raw;
  const parsed = ResultSchema.safeParse(rawResult);
  if (!parsed.success) throw new StError('http', 'DataForSEO sent a search result in an unexpected shape.');
  const result = parsed.data;
  const data = task?.data ?? {};
  const observedAt = parseDfsDatetime(result.datetime);
  if (!observedAt) throw new StError('http', 'DataForSEO sent a search result without a valid datetime.');
  // The posted keyword (echoed in task.data) is what joins to Search Console; the result's copy may be normalised.
  const keyword = (typeof data.keyword === 'string' && data.keyword.trim() ? data.keyword : null) ?? result.keyword ?? null;
  if (!keyword) throw new StError('http', 'DataForSEO sent a search result without a keyword.');
  const locationCode = result.location_code ?? (typeof data.location_code === 'number' ? data.location_code : 0);
  const languageCode = result.language_code ?? (typeof data.language_code === 'string' ? data.language_code : '');
  const site = stripWww(ctx.siteDomain);

  const items = (result.items ?? []).filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
  const aioRaw = items.find((x) => x.type === 'ai_overview') ?? null;
  let aio: SerpObservation['aio'] = null;
  if (aioRaw) {
    const head = ItemSchema.safeParse(aioRaw);
    const refs = collectRefs(aioRaw);
    aio = {
      async: head.success ? (head.data.asynchronous_ai_overview ?? null) : null,
      citesUs: refs.some((r) => domainMatches(stripWww(r.domain), site)),
      refs,
    };
  }

  const organic: SerpObservation['organic'] = [];
  for (const x of items) {
    if (organic.length >= 10) break;
    if (x.type !== 'organic') continue;
    const it = ItemSchema.safeParse(x);
    if (!it.success) continue;
    const url = typeof it.data.url === 'string' ? it.data.url : '';
    const domain = (it.data.domain ?? hostOf(url) ?? '').trim().toLowerCase();
    if (!url || !domain) continue;
    organic.push({
      rankAbsolute: it.data.rank_absolute ?? it.data.rank_group ?? organic.length + 1,
      domain,
      url: url.slice(0, 2000),
      title: clip(it.data.title) ?? '',
    });
  }
  const mine = organic.find((o) => domainMatches(stripWww(o.domain), site)) ?? null;

  return {
    intentKey: ctx.intentKey,
    taskId: task?.id ?? '',
    keyword: clip(keyword, 300) ?? keyword,
    device: asDevice(data.device),
    locationCode,
    languageCode,
    isoWeek: ctx.isoWeek,
    observedAt,
    design: ctx.design,
    pi: ctx.pi,
    itemTypes: [...new Set((result.item_types ?? []).filter((t) => typeof t === 'string'))],
    aio,
    organic,
    ours: mine ? { rankAbsolute: mine.rankAbsolute, url: mine.url, title: mine.title } : null,
  };
}
