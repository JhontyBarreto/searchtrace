// URL template clustering (spec 5.9) with glob overrides. Owner: WP-A.
//
// A path segment is variable when it is numeric, a date, hex or a UUID (8+ characters), or
// when its parent (below the site root) has at least 3 children that each have at most one
// descendant. Variable segments become '*'. Templates with fewer than 3 pages merge into
// 'other pages'. Overrides from analysis.templateOverrides win and are never merged away.
import { normalizeUrl } from './url.js';

export const OTHER_PAGES = 'other pages';
const MIN_TEMPLATE_PAGES = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPatternVariable(seg: string): boolean {
  return /^\d+$/.test(seg) || /^\d{4}(-\d{2}){0,2}$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || UUID_RE.test(seg);
}

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Input URLs whose path ends at this node. */
  urls: string[];
}

const newNode = (): TrieNode => ({ children: new Map(), urls: [] });

function mergeInto(target: TrieNode, src: TrieNode): void {
  target.urls.push(...src.urls);
  for (const [seg, child] of src.children) {
    const existing = target.children.get(seg);
    if (existing) mergeInto(existing, child);
    else target.children.set(seg, child);
  }
}

/** True when the subtree below node has at most one node. */
function atMostOneDescendant(node: TrieNode): boolean {
  if (node.children.size === 0) return true;
  if (node.children.size > 1) return false;
  const [only] = node.children.values();
  return only.children.size === 0;
}

function collapse(node: TrieNode, depth: number): void {
  if (depth >= 1) {
    const small = [...node.children.entries()].filter(([seg, c]) => seg !== '*' && atMostOneDescendant(c));
    if (small.length >= MIN_TEMPLATE_PAGES) {
      const star = node.children.get('*') ?? newNode();
      for (const [seg, c] of small) {
        node.children.delete(seg);
        mergeInto(star, c);
      }
      node.children.set('*', star);
    }
  }
  for (const child of node.children.values()) collapse(child, depth + 1);
}

/** Normalised URL (or bare path) -> { normalised identity, pathname }; null when it is neither. */
function parseForTemplate(u: string): { id: string; pathname: string } | null {
  try {
    const id = normalizeUrl(u);
    return { id, pathname: new URL(id).pathname };
  } catch {
    if (typeof u === 'string' && u.startsWith('/')) {
      const path = u.split('#')[0];
      const q = path.indexOf('?');
      return { id: path, pathname: q >= 0 ? path.slice(0, q) : path };
    }
    return null;
  }
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function overrideFor(
  id: string,
  pathname: string,
  compiled: { re: RegExp; full: boolean; name: string }[],
): string | null {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  for (const o of compiled) {
    if (o.full ? o.re.test(id) : o.re.test(pathname) || o.re.test(trimmed)) return o.name;
  }
  return null;
}

/** url -> template key ('/blog/*', an override name, or 'other pages'). Keys are the input strings. */
export function clusterTemplates(urls: string[], overrides?: { glob: string; name: string }[]): Map<string, string> {
  const compiled = (overrides ?? [])
    .filter((o) => o && typeof o.glob === 'string' && o.glob !== '' && typeof o.name === 'string' && o.name !== '')
    .map((o) => ({ re: globToRegExp(o.glob), full: o.glob.includes('://'), name: o.name }));

  const out = new Map<string, string>();
  const root = newNode();
  const idOf = new Map<string, string>();
  for (const u of urls) {
    if (out.has(u) || idOf.has(u)) continue;
    const parsed = parseForTemplate(u);
    if (!parsed) {
      out.set(u, OTHER_PAGES);
      continue;
    }
    const forced = overrideFor(parsed.id, parsed.pathname, compiled);
    if (forced) {
      out.set(u, forced);
      continue;
    }
    idOf.set(u, parsed.id);
    let node = root;
    for (const raw of parsed.pathname.split('/').filter((s) => s !== '')) {
      const seg = isPatternVariable(raw) ? '*' : raw;
      let next = node.children.get(seg);
      if (!next) {
        next = newNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    node.urls.push(u);
  }

  collapse(root, 0);

  // Assign each URL its path template, then fold small templates into 'other pages'.
  const keyOf = new Map<string, string>();
  const pages = new Map<string, Set<string>>();
  const walk = (node: TrieNode, segs: string[]): void => {
    const key = `/${segs.join('/')}`;
    for (const u of node.urls) {
      keyOf.set(u, key);
      const set = pages.get(key) ?? new Set<string>();
      set.add(idOf.get(u) ?? u);
      pages.set(key, set);
    }
    for (const [seg, child] of node.children) walk(child, [...segs, seg]);
  };
  walk(root, []);

  for (const [u, key] of keyOf) {
    out.set(u, (pages.get(key)?.size ?? 0) >= MIN_TEMPLATE_PAGES ? key : OTHER_PAGES);
  }
  return out;
}
