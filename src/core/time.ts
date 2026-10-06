// Pacific Time dates (America/Los_Angeles), date math, ISO weeks, weekdays and clocks. Owner: WP-A.
//
// An IsoDate is a calendar day ('YYYY-MM-DD') in Pacific Time, because that is the day
// Search Console reports. Date math on IsoDates is pure calendar arithmetic (done in UTC
// so DST never shifts a day). Only ptDate and ptDayStart touch the time zone.
import { StError } from './errors.js';
import type { Clock, Instant, IsoDate } from './types.js';

const PT_ZONE = 'America/Los_Angeles';
const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const ptFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PT_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface PtParts { year: string; month: string; day: string; hour: number; minute: number }

function ptParts(d: Date): PtParts {
  const out: Record<string, string> = {};
  for (const p of ptFormat.formatToParts(d)) out[p.type] = p.value;
  return {
    year: out.year.padStart(4, '0'),
    month: out.month,
    day: out.day,
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
  };
}

function badInput(what: string, value: unknown): never {
  throw new StError('internal', `Not a valid ${what}: ${JSON.stringify(value)}`);
}

/** Parses an IsoDate into UTC midnight milliseconds. Throws on anything that is not a real calendar day. */
function utcMs(d: IsoDate): number {
  const m = typeof d === 'string' ? ISO_DATE_RE.exec(d) : null;
  if (!m) return badInput('date (YYYY-MM-DD)', d);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, da);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) {
    return badInput('date (YYYY-MM-DD)', d);
  }
  return ms;
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

function toDate(x: Date | Instant): Date {
  const d = x instanceof Date ? new Date(x.getTime()) : typeof x === 'string' ? new Date(x) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) return badInput('instant', x instanceof Date ? 'Invalid Date' : x);
  return d;
}

/** UTC ISO-8601 instant with second precision, e.g. '2026-10-04T23:22:42Z'. */
export function toInstant(x: Date | Instant): Instant {
  return toDate(x).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 'YYYY-MM' of the UTC calendar month containing x (ledger files and spend months use UTC months). */
export function utcMonth(x: Date | Instant): string {
  return toDate(x).toISOString().slice(0, 7);
}

/** The Pacific Time calendar day containing the instant x. */
export function ptDate(x: Date | Instant): IsoDate {
  const p = ptParts(toDate(x));
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(d: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) return badInput('day count', n);
  return fromUtcMs(utcMs(d) + n * DAY_MS);
}

/** b - a in days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** Inclusive. Empty when from is after to. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const start = utcMs(from);
  const end = utcMs(to);
  const out: IsoDate[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(fromUtcMs(t));
  return out;
}

/** For example '2026-W41'. ISO 8601: weeks start on Monday and week 1 holds the year's first Thursday. */
export function isoWeek(d: IsoDate): string {
  const ms = utcMs(d);
  const thursday = ms + (3 - weekdayOfMs(ms)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

function weekdayOfMs(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/** Monday = 0 ... Sunday = 6. */
export function weekday(d: IsoDate): number {
  return weekdayOfMs(utcMs(d));
}

export function isIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  try {
    utcMs(s);
    return true;
  } catch {
    return false;
  }
}

/** UTC instant of 00:00 PT on d. Midnight is never skipped or repeated in Los Angeles (DST moves at 02:00). */
export function ptDayStart(d: IsoDate): Instant {
  const base = utcMs(d);
  // PDT is UTC-7 and PST is UTC-8, so local midnight is 07:00 or 08:00 UTC.
  for (const hours of [7, 8]) {
    const at = new Date(base + hours * 3_600_000);
    const p = ptParts(at);
    if (`${p.year}-${p.month}-${p.day}` === d && p.hour === 0 && p.minute === 0) return toInstant(at);
  }
  // Not reachable for real Los Angeles offsets; kept so a tz database change fails loudly.
  throw new StError('internal', `Could not find midnight Pacific Time on ${d}.`);
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at iso. Each call returns a fresh Date, so callers cannot move it by mutation. */
export function fixedClock(iso: Instant): Clock {
  const ms = toDate(iso).getTime();
  return { now: () => new Date(ms) };
}
