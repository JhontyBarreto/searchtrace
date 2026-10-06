// esc() for HTML, mdEscape() for Markdown, csvCell() for CSV, safeHref() for links (4.11). Owner: WP-F.
//
// Every query, URL, title, annotation, domain and sentence goes through one of these before it
// reaches a report. Untrusted text (queries, page titles, annotation notes, domains) can hold
// anything, including markup, so nothing is ever written raw.

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"'`]/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/**
 * Escapes text for Markdown (GitHub flavoured), including table cells. Escapes <, >, [, ], |,
 * backticks and @ as the spec asks, plus backslash, * and _ so untrusted text cannot add
 * emphasis, links, HTML or mentions. Line breaks become spaces so a value cannot end a table row.
 */
export function mdEscape(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]|`*_~]/g, (ch) => `\\${ch}`)
    .replace(/@/g, '&#64;');
}

/** One CSV cell: quoted when needed, and guarded against spreadsheet formula injection. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Returns the URL when it is an absolute https URL, otherwise null. Only such URLs become links. */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' ? parsed.href : null;
}

/** An external link that opens in a new tab without giving the target page a handle on ours. */
export function externalLink(url: string | null | undefined, text: string): string {
  const href = safeHref(url);
  if (!href) return esc(text);
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
}
