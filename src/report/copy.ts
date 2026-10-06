// Every user-facing sentence and label (6.2). Owner: WP-F.
//
// Analysis emits a template id plus slots (D9); this file turns them into English. Slots may
// arrive as numbers (formatted here by slot name, per 6.3) or as strings (used as given). A
// missing slot renders as "n/a" rather than leaking a "{placeholder}". Directional templates
// take direction 'down' | 'up' and swap fell/rose, fewer/more, lost/gained, drop/rise,
// slipped/climbed and cost/earned. Output is plain text: escape it for HTML or Markdown.
import { diffDays } from '../core/time.js';
import type { AltKey, AnalysisOutput, Cause, Confidence, FalsifierKey, Finding, IdCheckName, TemplateId, Verdict } from '../core/types.js';
import {
  capitalise, confidenceLevel, eventName, fmtAbsPct, fmtCount, fmtDate, fmtFreq, fmtInt, fmtMoney, fmtPct, fmtPos, fmtRate, plural,
} from './format.js';

export const REAL_LABEL: Record<Verdict, string> = {
  signal: 'Real change',
  noise: 'Normal wobble',
  underpowered: 'Not enough data yet',
  unclear: "Can't separate the causes",
};

export const BADGE: Record<Confidence, string> = {
  EXTRACTED: 'Measured',
  INFERRED: 'Estimated',
  AMBIGUOUS: 'Possible',
};

export const CAUSE_LABEL: Record<Cause, string> = {
  demand: 'Fewer or more searches',
  rank: 'Ranking',
  ctr_serp: 'Same spot, different click rate',
  ai_overview: 'AI Overview',
  site_change: 'Your change',
  google_update: 'Google update',
  index_state: 'Index status',
  outage: 'Google outage',
  data_anomaly: 'Reporting change',
  seasonal: 'Seasonal',
  mixed: 'Several things at once',
  unknown: 'Unclear',
};

/** Causes as they read inside a sentence ("Two things happened at once: {a} and {b}"). */
export const CAUSE_PHRASE: Record<Cause, string> = {
  demand: 'a change in how many people searched',
  rank: 'a ranking move',
  ctr_serp: 'a different click rate at the same position',
  ai_overview: 'AI Overviews',
  site_change: 'a change on your site',
  google_update: 'a Google update',
  index_state: 'a change in index status',
  outage: 'a Google outage',
  data_anomaly: 'a reporting change',
  seasonal: 'the season',
  mixed: 'several things at once',
  unknown: 'something we can not name yet',
};

/** Waterfall display groups (5.5.5). */
export type DisplayGroup = 'demand' | 'ranking' | 'samePos' | 'aioCitation' | 'churn';
export const GROUP_LABEL: Record<DisplayGroup, string> = {
  demand: 'Fewer or more searches',
  ranking: 'Ranking',
  samePos: 'Same spot, different click rate',
  aioCitation: 'AI Overview citation',
  churn: 'Appeared or disappeared',
};
export const REMAINDER_LABEL = 'Unattributed searches (included above; private or not reported)';
/** The note under the click breakdown table about the searches Google doesn't name. */
export const REMAINDER_NOTE = "Searches Google doesn't name (private or not reported) are already counted in the parts above.";

/** cant_separate reason text, by the identification check that failed (6.2). */
export const REASON_TEXT: Record<IdCheckName, string> = {
  placebo: 'the same kind of gap already existed before',
  measurement_event: 'Google changed how it counts these numbers at the same time',
  competing_events: '{a} and {b} overlapped',
  coverage: 'too few comparable searches were checked',
  single_check: "we've only checked these searches once so far",
  seasonal: 'the same thing happened at this time last year',
  curve_unstable: "your click-rate curve isn't stable enough yet",
};

export const FALSIFIER_PREFIX = 'What would prove this wrong:';

// Exhaustive key lists, checked against the frozen unions by `satisfies`.
const TEMPLATE_KEYS = {
  headline: 1, boring: 1, real_google: 1, real_google_no_changes: 1, real_site_change: 1, demand: 1, ranking: 1,
  aio_not_cited: 1, aio_cited: 1, aio_flattening: 1, same_spot_unchecked: 1, same_spot_checked: 1, noise: 1,
  not_enough_data: 1, cause_unknown: 1, cant_separate: 1, mixed: 1, reporting_artefact: 1, too_recent: 1,
  no_site_changes: 1, before_recording: 1, site_change_unseen: 1, index_change: 1, update_row: 1, change_point: 1,
  gradual: 1, aio_fact: 1, coverage: 1, freshness: 1,
} satisfies Record<TemplateId, 1>;
const ALT_COPY = {
  demand_ruled_out: 'Fewer searches: ruled out, impressions held ({impr_pct}).',
  demand_possible: 'Fewer searches: possible, impressions moved {impr_pct}.',
  rank_ruled_out: 'Ranking: ruled out, average position held ({pb} to {pc}).',
  rank_possible: 'Ranking: possible, average position moved from {pb} to {pc}.',
  site_change_none_recorded: "Your change: can't rule it out, nothing was recorded on your site then.",
  site_change_controls_fell_too: "Your change: ruled out, pages you didn't touch fell as much ({ctrl}).",
  site_change_possible: 'Your change: possible, {n} pages changed on {date}.',
  update_no_overlap: 'Google update: ruled out, no confirmed update overlaps.',
  update_overlaps: 'Google update: possible, it overlaps the {update}.',
  seasonal_same_last_year: 'Season: possible, the same weeks last year moved {yoy}.',
  seasonal_not_last_year: "Season: ruled out, last year didn't do this.",
  aio_not_checked: 'AI Overviews: not checked yet.',
  aio_no_signal: 'AI Overviews: checked, no measurable effect yet.',
  measurement_event_overlaps: 'Reporting change: {event} overlaps these dates.',
  index_unchanged: 'Index status: unchanged on the pages checked.',
  outage_overlaps: 'Google outage: {event} overlaps these dates.',
} satisfies Record<AltKey, string>;
const FALSIFIER_COPY = {
  revert_and_recrawl: 'if you undo the change and Google recrawls, clicks should come back within about 4 weeks.',
  next_update_recovery: "if pages you didn't touch recover at the next core update while yours don't, it was something on your side.",
  impressions_recover: 'if impressions recover while your positions stay put, it was demand.',
  aio_disappears: "if the AI Overview goes away and your click rate stays low, it wasn't the AI Overview.",
  position_recovers: "if your position recovers and clicks don't, ranking wasn't the whole story.",
  more_data: "we'll know more by {check_date}.",
  reverts: 'if the next 4 weeks return to the old level, this was a blip.',
  record_changes: 'if you changed something around then, add it with `searchtrace note` and we\'ll test it.',
} satisfies Record<FalsifierKey, string>;

export const TEMPLATE_IDS = Object.keys(TEMPLATE_KEYS) as TemplateId[];
export const ALT_KEYS = Object.keys(ALT_COPY) as AltKey[];
export const FALSIFIER_KEYS = Object.keys(FALSIFIER_COPY) as FalsifierKey[];

// ---------- slot formatting ----------
type Slots = Record<string, string | number | boolean | null | undefined>;
type SlotKind = 'int' | 'absInt' | 'count' | 'pct' | 'absPct' | 'rate' | 'pos' | 'date' | 'money' | 'freq' | 'event' | 'text';

const DEFAULT_KIND: Record<string, SlotKind> = {
  days: 'int', clicks: 'int', abs: 'absInt', n: 'int', k: 'int', n_days: 'int', weeks: 'int', cpw: 'count',
  lo: 'int', hi: 'int',
  pct: 'pct', impr_pct: 'pct', clicks_pct: 'pct', yoy: 'pct', ctrl: 'pct', touched: 'pct', untouched: 'pct',
  mde: 'absPct', share: 'absPct', hidden: 'absPct', shown: 'absPct', x: 'absPct', slope: 'absPct',
  cb: 'rate', cc: 'rate', pb: 'pos', pc: 'pos', cost: 'money', freq: 'freq',
  date: 'date', d1: 'date', d2: 'date', change_date: 'date', check_date: 'date',
  update: 'event', event: 'event',
};
const KIND_OVERRIDE: Partial<Record<TemplateId, Record<string, SlotKind>>> = {
  demand: { pct: 'absPct', yoy: 'absPct' },
  change_point: { pct: 'absPct' },
};

function formatSlot(v: string | number | boolean | null | undefined, kind: SlotKind): string {
  if (v === null || v === undefined || v === '') return 'n/a';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return kind === 'date' ? fmtDate(v) : kind === 'event' ? eventName(v) : v;
  switch (kind) {
    case 'int': return fmtInt(v);
    case 'absInt': return fmtInt(Math.abs(v));
    case 'count': return fmtCount(v);
    case 'pct': return fmtPct(v);
    case 'absPct': return fmtAbsPct(v);
    case 'rate': return fmtRate(v);
    case 'pos': return fmtPos(v);
    case 'money': return fmtMoney(v);
    case 'freq': return fmtFreq(v);
    case 'date': return String(v);
    case 'event': return String(v);
    case 'text': return String(v);
  }
}

interface SlotReader {
  up: boolean;
  /** The formatted slot. */
  s(name: string, kind?: SlotKind): string;
  num(name: string): number | null;
  str(name: string): string | null;
  has(name: string): boolean;
  /** down form, up form. */
  w(down: string, up: string): string;
}

function reader(template: TemplateId | null, slots: Slots): SlotReader {
  const override = template ? KIND_OVERRIDE[template] ?? {} : {};
  const up = String(slots.direction ?? 'down').toLowerCase() === 'up';
  const has = (name: string): boolean => slots[name] !== undefined && slots[name] !== null && slots[name] !== '';
  return {
    up,
    has,
    s: (name, kind) => formatSlot(slots[name], kind ?? override[name] ?? DEFAULT_KIND[name] ?? 'text'),
    num: (name) => {
      const v = slots[name];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      // Some analyzers send percents already formatted ("56%", "+20%", "-1.5%"): read them as fractions.
      if (typeof v === 'string') {
        const m = /^\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)%\s*$/.exec(v);
        if (m) return Number(m[1].replace(/,/g, '')) / 100;
      }
      return null;
    },
    str: (name) => (has(name) ? String(slots[name]) : null),
    w: (down, upWord) => (up ? upWord : down),
  };
}

/** A label slot may hold the label itself or a verdict key ('noise'); either way, return the label. */
function labelOf(v: string | null): string | null {
  if (v === null) return null;
  return v in REAL_LABEL ? REAL_LABEL[v as Verdict] : v;
}

/** A selector slot holds a short keyword (no spaces) rather than finished text. */
function isKeyword(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z_]*$/.test(v);
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/** Fills {name} placeholders in a fixed copy string from slots. */
function fill(text: string, r: SlotReader): string {
  return text.replace(/\{([a-z_]+)\}/g, (_m, name: string) => r.s(name));
}

function countWord(r: SlotReader, name: string, one: string, many: string): string {
  const n = r.num(name);
  return `${r.s(name)} ${n === null ? many : plural(n, one, many)}`;
}

function yoySentence(r: SlotReader, slots: Slots): string {
  if (typeof slots.yoy_sentence === 'string') return slots.yoy_sentence;
  const yoy = r.num('yoy');
  if (yoy === null) return '';
  const pct = r.num('pct');
  const sameWay = pct === null ? yoy !== 0 : Math.sign(yoy) === Math.sign(pct) && Math.abs(yoy) >= 0.5 * Math.abs(pct);
  if (sameWay) {
    return `The same weeks last year were ${yoy < 0 ? 'down' : 'up'} ${fmtAbsPct(yoy)} too, so this is probably seasonal.`;
  }
  return "The same weeks last year didn't show this, so it isn't just the season.";
}

function imprSentence(r: SlotReader, slots: Slots): string {
  const given = slots.impr_sentence;
  if (typeof given === 'string' && !isKeyword(given)) return given;
  if (given === '' || given === 'none' || !r.has('impr_pct')) return '';
  const rawLabel = r.str('impr_label');
  const label = labelOf(rawLabel);
  // The impressions verdict, from impr_real, a verdict key in impr_label, or the label text itself.
  let real: Verdict | null = (r.str('impr_real') as Verdict | null) ?? (rawLabel && rawLabel in REAL_LABEL ? (rawLabel as Verdict) : null);
  if (real === null && label) real = (Object.keys(REAL_LABEL) as Verdict[]).find((k) => REAL_LABEL[k] === label) ?? null;
  if (given === 'changed') real = 'signal';
  if (given === 'unchanged' && (real === null || real === 'signal')) real = 'noise';
  const pct = r.s('impr_pct');
  const tau = r.num('impr_pct');
  switch (real) {
    case 'signal':
      return `Impressions, which have far more data, did change: ${pct} (${REAL_LABEL.signal}).`;
    case 'underpowered': {
      // Say why impressions don't settle it either, rather than "didn't change" next to +200%.
      const moved = tau !== null && tau <= -0.995 ? 'Impressions went to zero'
        : tau !== null && Math.abs(tau) < 0.01 ? `Impressions barely moved (${pct})`
          : `Impressions moved ${pct}`;
      return r.str('impr_reason') === 'floors'
        ? `${moved}, but there are too few of them to judge either.`
        : `${moved}, but they swing too much from month to month to call that real either.`;
    }
    case 'unclear':
      return `Impressions moved ${pct}, but other things that happened at the same time make that hard to read.`;
    default:
      return `Impressions, which have far more data, didn't change meaningfully (${pct}).`;
  }
}

function reasonText(r: SlotReader, slots: Slots): string {
  const given = slots.reason_text;
  // A finished phrase is used as given; an IdCheck name (a keyword) is worded from REASON_TEXT.
  if (typeof given === 'string' && !(given in REASON_TEXT) && given !== '') return given;
  const check = (typeof given === 'string' && given in REASON_TEXT ? given : null) ?? r.str('check') ?? r.str('reason');
  if (check && check in REASON_TEXT) return fill(REASON_TEXT[check as IdCheckName], r);
  return 'the evidence points more than one way';
}

function causePhrase(v: string | null, up: boolean): string {
  if (v === null) return 'n/a';
  if (v === 'demand') return up ? 'more people searching' : 'fewer people searching';
  return v in CAUSE_PHRASE ? CAUSE_PHRASE[v as Cause] : v;
}

function citedText(r: SlotReader, slots: Slots): string {
  const given = slots.cited_text;
  if (typeof given === 'string' && !isKeyword(given)) return given;
  if (given === 'cites_you' || given === 'cited') return ', and it cites you';
  if (given === 'doesnt_cite_you' || given === 'not_cited') {
    return r.has('domains') ? `, and it doesn't cite you; it cites ${r.s('domains')}` : ", and it doesn't cite you";
  }
  if (typeof given === 'string') return '';
  const k = r.num('k');
  if (k !== null && k <= 0) return '';
  if (truthy(slots.cited)) return ', and it cites you';
  if (slots.cited === undefined && !r.has('domains')) return '';
  return r.has('domains') ? `, and it doesn't cite you; it cites ${r.s('domains')}` : ", and it doesn't cite you";
}

/** Series labels read naturally inside a sentence: "the whole site", "brand searches". */
function unitPhrase(u: string): string {
  return u.replace(/^whole site\b/i, 'the whole site').replace(/^(Brand|Other) searches\b/, (m) => m.toLowerCase());
}

/** "has" or "have" for a metric name used as a subject ("Impressions have", "Clicks have"). */
function verbHave(metric: string): string {
  return /s$/i.test(metric.trim()) ? 'have' : 'has';
}

/** A daily level for a sentence: "about 12 a day", "about 2 a week" below half a day, "almost none" below half a week. */
function perDayText(v: number): string {
  if (v >= 0.5) return `about ${fmtCount(v)} a day`;
  if (v * 7 >= 0.5) return `about ${fmtCount(v * 7)} a week`;
  return 'almost none';
}

/** "from about 3 a day to about 40 a day", or null when the slots carry no levels or the two read the same. */
function levelChange(r: SlotReader): string | null {
  const from = r.num('from');
  const to = r.num('to');
  if (from === null || to === null) return null;
  const a = perDayText(from);
  const b = perDayText(to);
  return a === b ? null : `from ${a} to ${b}`;
}

/** " We can't separate the causes: <reason>." when a change point names the check that failed. */
function whyUnclear(r: SlotReader): string {
  const check = r.str('check');
  if (!check || !(check in REASON_TEXT)) return '';
  return ` We can't separate the causes: ${fill(REASON_TEXT[check as IdCheckName], r)}.`;
}

/** Two magnitudes as an ascending range of plain percents ("12% to 31%"). */
function pctRange(r: SlotReader): string {
  const lo = r.num('lo');
  const hi = r.num('hi');
  if (lo === null || hi === null) return `${r.s('lo')} to ${r.s('hi')}`;
  const a = Math.abs(lo);
  const b = Math.abs(hi);
  return `${fmtAbsPct(Math.min(a, b))} to ${fmtAbsPct(Math.max(a, b))}`;
}

function clickRange(r: SlotReader): string {
  const lo = r.num('lo');
  const hi = r.num('hi');
  if (lo === null || hi === null) return `${r.s('lo')} to ${r.s('hi')}`;
  const a = Math.abs(lo);
  const b = Math.abs(hi);
  return `${fmtInt(Math.min(a, b))} to ${fmtInt(Math.max(a, b))}`;
}

function nDaysInto(r: SlotReader): string {
  const n = r.num('n_days');
  if (n === 0) return `the first day of the ${r.s('update')}`;
  return `${countWord(r, 'n_days', 'day', 'days')} into the ${r.s('update')}`;
}

/** One sentence (or a short paragraph) for a template. */
export function renderSentence(template: TemplateId, slots: Record<string, string | number>): string {
  const sl = slots as Slots;
  const r = reader(template, sl);
  const { w } = r;
  switch (template) {
    case 'headline': {
      const abs = r.num('abs');
      const clicks = countWord(r, 'clicks', 'click', 'clicks');
      const head = `In the last ${r.s('days')} days Google sent you ${clicks}, `;
      if (abs !== null && Math.round(Math.abs(abs)) === 0) return `${head}the same as the ${r.s('days')} days before.`;
      const pct = r.has('pct') ? ` (${r.s('pct')})` : '';
      return `${head}${r.s('abs')} ${w('fewer', 'more')} than the ${r.s('days')} days before${pct}.`;
    }
    case 'boring':
      return 'Nothing important changed. Clicks and impressions stayed within their normal range.';
    case 'real_google':
      return `This is a real ${w('drop', 'rise')}, and it most likely came from Google's side. It started on ${r.s('date')}, ` +
        `${nDaysInto(r)}, and pages you didn't change ${w('fell', 'rose')} about as much as pages you did ` +
        `(${r.s('touched')} vs ${r.s('untouched')}). Confidence: ${r.s('level')}.`;
    case 'real_google_no_changes':
      return `This is a real ${w('drop', 'rise')}, and it most likely came from Google's side. It started on ${r.s('date')}, ` +
        `${nDaysInto(r)}. We had no recorded changes on your site at that time. Confidence: ${r.s('level')}.`;
    case 'real_site_change': {
      // "{k} of the {n} pages you changed": the pages that changed, and how many of them moved.
      const one = r.num('n') === 1;
      const which = one && r.num('k') === 1
        ? `The page you changed on ${r.s('change_date')} (${r.s('summary')}) ${w('lost', 'gained')} clicks.`
        : `${r.s('k')} of the ${countWord(r, 'n', 'page', 'pages')} you changed on ${r.s('change_date')} (${r.s('summary')}) ${w('lost', 'gained')} clicks.`;
      return `This is a real ${w('drop', 'rise')}, and it most likely came from a change on your site. ${which} ` +
        `Google recrawled ${one ? 'it' : 'them'} between ${r.s('d1')} and ${r.s('d2')}, and the ${w('drop', 'rise')} started right after. ` +
        `Pages you didn't touch held steady (${r.s('ctrl')}). Confidence: ${r.s('level')}.`;
    }
    case 'demand': {
      const yoy = yoySentence(r, sl);
      return `${w('Fewer', 'More')} people searched. Your rankings and click rate held steady, but impressions ` +
        `${w('fell', 'rose')} ${r.s('pct')}, which accounts for about ${r.s('share')} of the ${w('lost', 'gained')} clicks.` +
        (yoy ? ` ${yoy}` : '');
    }
    case 'ranking':
      return `You ${w('slipped', 'climbed')} in the rankings, from about position ${r.s('pb')} to ${r.s('pc')} on ` +
        `${countWord(r, 'n', 'search', 'searches')}. That ${w('cost', 'earned')} an estimated ${clickRange(r)} clicks.`;
    case 'aio_not_cited':
      // The side-by-side comparison (cross-section) compares levels at one time, so it is worded as
      // a comparison, not proof (5.11.3); the before-and-after estimate keeps the 6.2 wording.
      if (r.str('wording') === 'comparison_not_proof' || r.str('estimator') === 'cross_section') {
        return 'On searches where Google shows an AI Overview that doesn\'t cite you, your click rate is ' +
          `${r.s('x')} lower than on similar searches without one (likely range ${pctRange(r)}). This is a comparison, ` +
          "not proof: those searches may differ in other ways, and Google doesn't report clicks lost to AI Overviews.";
      }
      return 'People clicked less even though you ranked in the same place. On searches where Google now shows an AI Overview ' +
        `that doesn't cite you, your click rate fell ${r.s('x')} more than on similar searches without one ` +
        `(likely range ${pctRange(r)}). This is an estimate: Google doesn't report clicks lost to AI Overviews.`;
    case 'aio_cited':
      return `An AI Overview now appears on ${r.s('n')} of these searches and it cites you. Being cited can mean fewer clicks ` +
        "or more, so we can't say which way it pushed.";
    case 'aio_flattening':
      return `Your average position jumped to about ${r.s('pc')} because Google counts an AI Overview citation as one position. ` +
        "That isn't a real ranking gain, so we don't count it as one.";
    case 'same_spot_unchecked':
      return `People clicked ${w('less', 'more')} at the same ranking position (${r.s('cb')} to ${r.s('cc')}). That usually means ` +
        'the results page itself changed, for example an AI Overview, ads or a video block. ' +
        "We haven't checked these searches yet. Add a DataForSEO login and the next run will check the " +
        `${r.s('n')} biggest ones (about ${r.s('cost')}).`;
    case 'same_spot_checked':
      if (r.num('n') === 0) {
        return `People clicked ${w('less', 'more')} at the same ranking position (${r.s('cb')} to ${r.s('cc')}). We checked these searches ` +
          "and found no AI Overview, so something else on the results page changed, for example ads, a video block or your snippet.";
      }
      return `People clicked ${w('less', 'more')} at the same ranking position (${r.s('cb')} to ${r.s('cc')}), and an AI Overview ` +
        `shows on ${r.s('n')} of these searches. We can't size its effect on your site yet.`;
    case 'noise': {
      const metric = r.has('metric') ? capitalise(r.s('metric')) : 'Clicks';
      const freq = r.num('freq');
      // Without a frequency (too little history to count past swings), don't claim one.
      const how = freq === null
        ? 'which is within normal ups and downs for your site'
        : freq <= 0 ? 'and swings this size happen rarely in your history' : `and swings this size happen about ${fmtFreq(freq)} in your history`;
      return `This is normal wobble. ${metric} moved ${r.s('pct')}, ${how}. Nothing to act on.`;
    }
    case 'not_enough_data': {
      const impr = imprSentence(r, sl);
      const notMeasurable = truthy(sl.not_measurable) || (typeof sl.mde === 'number' && !Number.isFinite(sl.mde));
      // The smallest detectable change is worth showing whenever it is a real number below about
      // 95%: it tells the owner how big a move has to be before we can call it. Only when there is
      // no usable number (no clicks in a window) does the plain "can't be measured" line replace it.
      const mde = r.num('mde');
      const mdeUsable = mde !== null && mde > 0 && mde < 0.95 && r.has('cpw');
      // A change bigger than the detectable size can still be "not enough data" when the earlier
      // weeks had too few clicks to judge at all (the minimum-data floor): say that, not a contradiction.
      const pctNum = r.num('pct');
      const beyond = pctNum !== null && mde !== null && Math.abs(pctNum) >= mde;
      const mdeSentence = `With about ${countWord(r, 'cpw', 'click', 'clicks')} a week, only a change of roughly ${r.s('mde')} or more stands out ` +
        `from normal ups and downs over ${countWord(r, 'weeks', 'week', 'weeks')}, and this one was ${r.s('pct')}` +
        (beyond ? ', but the earlier weeks had too few clicks to call it either way.' : '.');
      const cpw = r.num('cpw');
      const over = r.has('weeks') ? ` over ${countWord(r, 'weeks', 'week', 'weeks')}` : '';
      const was = r.has('pct') ? ` (this one was ${r.s('pct')})` : '';
      let second: string;
      if (!notMeasurable) second = mdeSentence;
      else if (mdeUsable) second = `${mdeSentence} At this traffic level, a change much smaller than that can't be confirmed even with a year of data.`;
      else if (cpw !== null && cpw <= 0) second = 'There were no clicks in the weeks before, so there is nothing to compare against yet.';
      else if (cpw !== null) {
        // The smallest detectable change is effectively everything: say so plainly.
        const rate = cpw < 1 ? 'under 1 click' : `about ${countWord(r, 'cpw', 'click', 'clicks')}`;
        second = `With ${rate} a week, changes of any size are hard to tell apart from normal ups and downs${over}${was}.`;
      } else second = "At this traffic level a change this size can't be measured reliably.";
      return `Not enough data to tell yet. ${second}${impr ? ` ${impr}` : ''}`;
    }
    case 'cause_unknown': {
      const start = r.has('top_segment') ? ` Start looking at ${r.s('top_segment')}.` : '';
      return `Something real happened around ${r.s('date')}, but we can't say why. It doesn't line up with a Google update, ` +
        `a change we recorded on your site, or a drop in searches.${start} If you changed something around then, run ` +
        "`searchtrace note` and we'll re-check.";
    }
    case 'cant_separate':
      return `Something changed around ${r.s('date')}, but ${reasonText(r, sl)}, so we can't separate the causes.`;
    case 'mixed':
      return `Two things happened at once: ${causePhrase(r.str('a'), r.up)} and ${causePhrase(r.str('b'), r.up)}. ` +
        `Together they explain about ${r.s('x')} of the change, but we can't cleanly separate them.`;
    case 'reporting_artefact':
      return `Heads up: Google changed how it counts ${r.s('metric')} around ${r.s('date')} (${r.s('event')}). ` +
        'Movement across that date may be a reporting change, not real traffic.';
    case 'too_recent':
      if (r.has('metric') && r.has('unit')) {
        return `${capitalise(r.s('metric'))} on ${unitPhrase(r.s('unit'))} started to ${w('fall', 'rise')} around ${r.s('date')}, ` +
          `too recently to judge. Check again on ${r.s('check_date')}.`;
      }
      return `This started on ${r.s('date')}, too recently to judge. Check again on ${r.s('check_date')}.`;
    case 'no_site_changes':
      return 'No site changes recorded yet. From now on searchtrace snapshots your pages each run, so future changes can be dated.';
    case 'before_recording':
      // With {since}, the date recording started, so it reads right next to changes recorded later.
      if (r.has('since')) {
        return `We only started recording your site's changes on ${r.s('since', 'date')}, so for anything earlier we can't say whether ` +
          "something you did caused it. If you remember changing something, add it with `searchtrace note` and we'll re-check.";
      }
      return "We weren't recording your site's changes back then, so we can't say whether something you did caused this. " +
        "If you remember changing something, add it with `searchtrace note` and we'll re-check.";
    case 'site_change_unseen':
      return `Google hasn't seen this change yet on ${countWord(r, 'n', 'page', 'pages')} (last crawled before ${r.s('date')}).`;
    case 'index_change':
      return `Google's index status for ${r.s('url')} changed from "${r.s('before')}" to "${r.s('after')}" (checked ${r.s('date')}).`;
    case 'update_row': {
      const status = r.str('status');
      if (status === 'too_recent') {
        return `${r.s('update')}: still rolling out or too recent to judge. Check again on ${r.s('check_date')}.`;
      }
      if (status === 'skipped_discover') return `${r.s('update')}: a Discover update, not web search, so skipped.`;
      if (status === 'before_history') return `${r.s('update')}: before your Search Console history starts.`;
      const label = (name: string): string => {
        const given = labelOf(r.str(`${name}_label`));
        if (given) return given;
        const real = r.str(`${name}_real`);
        return real && real in REAL_LABEL ? REAL_LABEL[real as Verdict] : 'n/a';
      };
      const dates = r.s('dates').replace(/\d{4}-\d{2}-\d{2}/g, (d) => fmtDate(d));
      return `${r.s('update')} (${dates}): clicks ${r.s('clicks_pct')} (${label('clicks')}), ` +
        `impressions ${r.s('impr_pct')} (${label('impr')}).`;
    }
    case 'change_point': {
      const window = r.has('d1') && r.has('d2') && r.s('d1') !== r.s('d2') ? ` (most likely between ${r.s('d1')} and ${r.s('d2')})` : '';
      const subject = `${capitalise(r.s('metric'))} on ${unitPhrase(r.s('unit'))}`;
      // From almost nothing (a new page) or by many times over, a percent says little: give the levels.
      const levels = levelChange(r);
      if (levels && ((r.num('pct') ?? 0) >= 3 || (r.num('from') ?? 1) < 1 || (r.num('to') ?? 1) < 1)) {
        return `${subject} ${w('fell', 'went')} ${levels} around ${r.s('date')}${window}.${whyUnclear(r)}`;
      }
      return `${subject} ${w('dropped', 'rose')} by ${r.s('pct')} around ${r.s('date')}${window}.${whyUnclear(r)}`;
    }
    case 'gradual': {
      const metric = capitalise(r.s('metric'));
      const unit = unitPhrase(r.s('unit'));
      const from = r.num('from');
      const to = r.num('to');
      // Several moves that roughly cancel out are not a slide or a climb: say where it ended up.
      if (from !== null && to !== null && from > 0 && Math.abs(to / from - 1) < 0.1) {
        return `${metric} on ${unit} shifted up and down several times since ${r.s('date')} and ended close to where ` +
          `${verbHave(r.s('metric')) === 'have' ? 'they' : 'it'} started (${perDayText(to)}).${whyUnclear(r)}`;
      }
      const subject = `${metric} on ${unit} ${verbHave(r.s('metric'))} been ${w('sliding', 'climbing')} gradually`;
      const levels = levelChange(r);
      if (levels) return `${subject} since ${r.s('date')}, ${levels}.${whyUnclear(r)}`;
      if (r.has('slope')) return `${subject}, about ${r.s('slope')} a week since ${r.s('date')}.${whyUnclear(r)}`;
      return `${subject} since ${r.s('date')}.${whyUnclear(r)}`;
    }
    case 'aio_fact':
      return `"${r.s('query')}" (${r.s('device')}): an AI Overview showed in ${r.s('k')} of ${countWord(r, 'n', 'check', 'checks')}` +
        `${citedText(r, sl)}.`;
    case 'coverage':
      return `Google hides the exact searches behind ${r.s('hidden')} of your clicks to protect searchers' privacy. ` +
        `The search-level explanations cover the other ${r.s('shown')}. Page-level numbers include everything.`;
    case 'freshness':
      return `Data runs to ${r.s('date')}, in Pacific Time as Google reports it. Google finalises data 2 to 3 days late, ` +
        (r.has('n') ? `so the last ${countWord(r, 'n', 'day is', 'days are')} left out` : 'so later days are left out') +
        ' rather than shown as a fake drop.';
  }
  return assertNever(template);
}

function assertNever(x: never): string {
  return `n/a (${String(x)})`;
}

/** One "Other explanations" line. */
export function renderAlt(key: AltKey, slots: Record<string, string | number>): string {
  const r = reader(null, slots as Slots);
  // "Ruled out" can mean the part was tiny even though the number itself moved: don't say "held"
  // next to a position that went from 4.8 to 2.6 or impressions that moved 11%.
  if (key === 'rank_ruled_out') {
    const pb = r.num('pb');
    const pc = r.num('pc');
    if (pb !== null && pc !== null && Math.abs(pc - pb) >= 0.5) {
      return `Ranking: ruled out, the move from position ${r.s('pb')} to ${r.s('pc')} explains little of the change.`;
    }
  }
  if (key === 'demand_ruled_out') {
    const ip = r.num('impr_pct');
    if (ip !== null && Math.abs(ip) >= 0.05) return `Fewer searches: ruled out, impressions moved ${r.s('impr_pct')} but that explains little of the change.`;
  }
  const copy = ALT_COPY[key];
  return copy === undefined ? String(key) : fill(copy, r);
}

/** The falsifier line, including its "What would prove this wrong:" prefix. */
export function renderFalsifier(key: FalsifierKey, slots: Record<string, string | number>): string {
  const copy = FALSIFIER_COPY[key];
  return `${FALSIFIER_PREFIX} ${copy === undefined ? String(key) : fill(copy, reader(null, slots as Slots))}`;
}

/** The finding's slots plus what the report can derive from the finding itself (level, direction, power). */
export function slotsFor(f: Finding): Record<string, string | number> {
  const s: Record<string, string | number> = { ...f.slots };
  if (s.level === undefined) s.level = confidenceLevel(f);
  if (s.direction === undefined) {
    const a = f.effect.absolute ?? f.effect.estimate;
    s.direction = a !== null && a > 0 ? 'up' : 'down';
  }
  if (f.power) {
    if (s.not_measurable === undefined && f.power.notMeasurable) s.not_measurable = 1;
    if (s.mde === undefined) s.mde = f.power.mde;
    if (s.cpw === undefined) s.cpw = f.power.perWeek;
  }
  if (s.pct === undefined && f.effect.estimate !== null) s.pct = f.effect.estimate;
  return s;
}

/** The finding's sentence in plain text. */
export function findingSentence(f: Finding): string {
  return renderSentence(f.template, slotsFor(f));
}

/** The finding's falsifier line. */
export function findingFalsifier(f: Finding): string {
  return renderFalsifier(f.falsifier.key, f.falsifier.slots);
}

/** Every "Other explanations" line for a finding. */
export function findingAlternatives(f: Finding): { cause: Cause; ruledOut: boolean; text: string }[] {
  return f.alternatives.map((a) => ({ cause: a.cause, ruledOut: a.ruledOut, text: renderAlt(a.key, a.slots) }));
}

/** The headline finding, or null when analysis produced none. */
export function headlineFinding(out: AnalysisOutput): Finding | null {
  return out.findings.find((f) => f.id === out.headline.findingId) ?? out.findings.find((f) => f.kind === 'headline') ?? null;
}

/** Slots for the headline sentence, computed from the site click comparison (5.12). */
export function headlineSlots(out: AnalysisOutput): Record<string, string | number> {
  const c = out.headline.clicks;
  const days = diffDays(out.windows.current[0], out.windows.current[1]) + 1;
  return { days, clicks: c.post, abs: Math.abs(c.post - c.pre), pct: c.tau, direction: c.post < c.pre ? 'down' : 'up' };
}

/** The two answer sentences shown first everywhere: the headline and the verdict, or only the boring line. */
export function answerSentences(out: AnalysisOutput): { sentence: string; verdict: string } {
  if (out.headline.boring) return { sentence: renderSentence('boring', {}), verdict: '' };
  const f = headlineFinding(out);
  if (!f) return { sentence: renderSentence('headline', headlineSlots(out)), verdict: '' };
  const slots = slotsFor(f);
  // The headline comparison carries the wobble frequency even when the finding's slots don't.
  if (slots.freq === undefined && out.headline.clicks.freq !== null) slots.freq = out.headline.clicks.freq;
  let verdict = renderSentence(f.template, slots);
  // The site total can be wobble while a section or a search really changed: don't tell people
  // there is nothing to act on right above those changes.
  const elsewhere = out.findings.some((x) => x.id !== f.id && x.real === 'signal' && x.reason !== 'fact' && x.kind !== 'update_impact');
  if (f.template === 'noise' && elsewhere) {
    verdict = verdict.replace(/ Nothing to act on\.$/, " Across the whole site that's nothing to act on, but parts of it did change.");
  }
  return { sentence: renderSentence('headline', headlineSlots(out)), verdict };
}

/** One waterfall display group with its value and 95% range, when known. */
export interface GroupRow { group: DisplayGroup; label: string; value: number; ci: [number, number] | null }

type CiMap = Partial<Record<string, [number, number]>> | null | undefined;

/** The five display groups of a set of bars (5.5.5): ranking = rank + visibility, churn = appeared + disappeared. */
export function displayGroups(
  bars: { demand: number; visibility: number; rank: number; samePos: number; appeared: number; disappeared: number; aioCitation: number },
  ci: CiMap,
): GroupRow[] {
  const c = (ci ?? {}) as Record<string, [number, number] | undefined>;
  const pick = (...keys: (string | false)[]): [number, number] | null => {
    for (const k of keys) if (k && Array.isArray(c[k]) && c[k]!.length === 2) return c[k]!;
    return null;
  };
  const rows: GroupRow[] = [
    { group: 'demand', label: GROUP_LABEL.demand, value: bars.demand, ci: pick('demand') },
    { group: 'ranking', label: GROUP_LABEL.ranking, value: bars.rank + bars.visibility, ci: pick('ranking', bars.visibility === 0 && 'rank') },
    { group: 'samePos', label: GROUP_LABEL.samePos, value: bars.samePos, ci: pick('samePos') },
    { group: 'aioCitation', label: GROUP_LABEL.aioCitation, value: bars.aioCitation, ci: pick('aioCitation') },
    {
      group: 'churn', label: GROUP_LABEL.churn, value: bars.appeared + bars.disappeared,
      ci: pick('churn', bars.disappeared === 0 && 'appeared', bars.appeared === 0 && 'disappeared'),
    },
  ];
  return rows;
}
