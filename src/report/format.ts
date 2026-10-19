// Number, percent, position, money, date, range and frequency formatting (6.3). Owner: WP-F.
//
// Output is locale-independent so reports are byte-stable on every machine: thousands are
// separated with commas and minus signs are the ASCII hyphen-minus.
import { githubSpec } from '../core/install.js';
import type { Finding, IsoDate } from '../core/types.js';

/**
 * How reports name the CLI in a command to copy: the pinned GitHub spec through npx. It works
 * however searchtrace was installed (it is not on the npm registry), and unlike the run summary's
 * hints it does not depend on how this run was started, so findings.json stays byte-identical.
 */
export const CLI = `npx -y ${githubSpec()}`;

/** A full `note` command line, with the date and pages filled in when known. */
export function noteCommand(o: { date?: string | null; urls?: string | null } = {}): string {
  return `${CLI} note "what you changed" --date ${o.date ?? 'YYYY-MM-DD'} --urls "${o.urls ?? '/path/*'}"`;
}
export const NOTE_COMMAND = noteCommand();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Rounds half away from zero, and never returns -0. */
function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.sign(x) * Math.round(Math.abs(x) * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * A relative change as a signed percent: whole numbers when |x| is at least 10%, one decimal
 * below that. x is a fraction (-0.31 is "-31%"). Zero is "0%".
 */
export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const body = fmtAbsPct(x);
  if (body === '0%') return body;
  return `${x < 0 ? '-' : '+'}${body}`;
}

/** The size of a percent with no sign ("45%"), with the same rounding as fmtPct. */
export function fmtAbsPct(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const pct = Math.abs(x) * 100;
  const oneDecimal = roundTo(pct, 1);
  if (oneDecimal >= 10) return `${groupThousands(String(roundTo(pct, 0)))}%`;
  const s = oneDecimal.toFixed(1).replace(/\.0$/, '');
  return `${s}%`;
}

/** An integer with thousands separators: "1,031", "-9". */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const r = roundTo(n, 0);
  return `${r < 0 ? '-' : ''}${groupThousands(String(Math.abs(r)))}`;
}

/** A signed integer: "+3", "-1", "+0". */
export function fmtSignedInt(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const r = roundTo(n, 0);
  return r < 0 ? fmtInt(r) : `+${fmtInt(r)}`;
}

/** A small count that may be fractional: whole above 10, else one decimal with ".0" dropped. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 10) return fmtInt(n);
  return roundTo(n, 1).toFixed(1).replace(/\.0$/, '');
}

/** A Google position with one decimal: "8.4". */
export function fmtPos(p: number): string {
  if (!Number.isFinite(p)) return 'n/a';
  return roundTo(p, 1).toFixed(1);
}

/** "$0.017" below $1 (up to 4 decimals, at least 2), "$1.24" otherwise. */
export function fmtMoney(usd: number): string {
  if (!Number.isFinite(usd)) return 'n/a';
  const sign = usd < 0 ? '-' : '';
  const a = Math.abs(usd);
  if (a === 0) return '$0.00';
  if (a < 1) {
    // Two significant figures, at least two decimals: $0.25, $0.21, $0.017, $0.0012.
    const decimals = Math.min(6, Math.max(2, Math.ceil(-Math.log10(a)) + 1));
    let s = a.toFixed(decimals);
    if (decimals > 2) s = s.replace(/0+$/, '').replace(/\.(\d)$/, '.$10');
    return `${sign}$${s}`;
  }
  const [whole, frac] = a.toFixed(2).split('.');
  return `${sign}$${groupThousands(whole)}.${frac}`;
}

/** "12 to 30", never with a dash. */
export function fmtRange(lo: string, hi: string): string {
  return `${lo} to ${hi}`;
}

/** "14 Sep 2026". Anything that is not YYYY-MM-DD is returned unchanged. */
export function fmtDate(d: IsoDate): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  if (!m) return String(d);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return String(d);
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** "1 in N four-week periods" (N = round(1 / freq)), or "rarely" when freq is 0 or unknown. */
export function fmtFreq(freq: number | null): string {
  if (freq === null || !Number.isFinite(freq) || freq <= 0) return 'rarely';
  const n = Math.max(1, Math.round(1 / Math.min(1, freq)));
  return n === 1 ? 'every four-week period' : `1 in ${fmtInt(n)} four-week periods`;
}

/** A click rate (0.052) as a plain percent ("5.2%"). */
export function fmtRate(r: number): string {
  return fmtAbsPct(r);
}

/** Bytes as "2.7 MB". */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${roundTo(n / 1024, 1).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${roundTo(n / 1024 ** 2, 1).toFixed(1)} MB`;
  return `${roundTo(n / 1024 ** 3, 1).toFixed(1)} GB`;
}

/** "1 page" / "2 pages". */
export function plural(n: number, one: string, many: string): string {
  return Math.abs(n) === 1 ? one : many;
}

/**
 * The {level} slot (6.3): high when the verdict is a real change and the cause is an estimate
 * with every check passed, medium when real but the cause is only possible, low otherwise.
 */
export function confidenceLevel(f: Pick<Finding, 'real' | 'causeConfidence'>): 'high' | 'medium' | 'low' {
  if (f.real !== 'signal') return 'low';
  return f.causeConfidence === 'INFERRED' || f.causeConfidence === 'EXTRACTED' ? 'high' : 'medium';
}

/** Cuts text to at most max characters, ending with "..." when cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/**
 * A Google event's title as a short name. Status-page titles are already short; a curated
 * description ("Google stopped honouring ... . Many sites saw ...") is cut to its first sentence.
 */
export function eventName(title: string): string {
  const t = String(title).trim();
  if (t.length <= 90) return t;
  const m = /^(.{12,}?[^.\s])\.\s/.exec(t);
  return m ? m[1] : truncate(t, 90);
}

/** Upper-cases the first character. */
export function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Lower-cases the first character unless the second is also upper case (keeps "AI", "URL"). */
export function lowerFirst(s: string): string {
  if (s.length < 2) return s.toLowerCase();
  return /[A-Z]/.test(s[1]) ? s : s[0].toLowerCase() + s.slice(1);
}
