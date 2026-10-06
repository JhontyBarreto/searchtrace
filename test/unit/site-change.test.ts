// Tests 34 to 39: site-change attribution (stacked DiD with calendar-matched controls).
import { describe, expect, it } from 'vitest';
import { analyzeSiteChanges, seenDay, windowsFor } from '../../src/analyze/site-change.js';
import { rngFor } from '../../src/core/rng.js';
import { addDays, dateRange, ptDayStart } from '../../src/core/time.js';
import type { Cell, CtrCurve, GoogleEvent, IsoDate, PageDay, SiteChange, SiteChangeInput, TouchedUrl } from '../../src/core/types.js';
import { poissonOne, testRng } from '../helpers/index.js';

const START: IsoDate = '2026-01-01';
const D: IsoDate = '2026-06-30';
const X: IsoDate = '2026-04-01'; // the change was deployed by this day
const U: IsoDate = addDays(X, 4); // a core update starts here
const url = (tpl: string, k: number): string => `https://example.com/${tpl}/p${k}`;
const dayOf = (k: number): IsoDate => addDays(X, 1 + (k % 3)); // when Google recrawled treated page k

const curve: CtrCurve = {
  f: (p) => Math.max(1e-5, 0.3 / p),
  fMix: (p) => Math.max(1e-5, 0.3 / p),
  unstable: [],
  m: 500,
  bins: [],
  fitWindow: [START, D],
  redraw() {
    return curve;
  },
};

const update: GoogleEvent = {
  id: 'core-2026-04', source: 'seed', service: 'Ranking', kind: 'core', title: 'April 2026 core update',
  begin: ptDayStart(U), end: ptDayStart(addDays(U, 14)), endEstimated: false, url: null, modified: null,
};

interface Site {
  pages: string[];
  templates: Map<string, string>;
  pageDaily: PageDay[];
}

/** Daily impressions per page: a Poisson draw around its level, times the update and treatment multipliers. */
function site(o: { groups: { tpl: string; n: number }[]; treated: (u: string) => boolean; effect: number; updateEffect: number; seed: string; level?: number }): Site {
  const rng = testRng(o.seed);
  const pages: string[] = [];
  const templates = new Map<string, string>();
  for (const g of o.groups) {
    for (let k = 0; k < g.n; k++) {
      pages.push(url(g.tpl, k));
      templates.set(url(g.tpl, k), `/${g.tpl}/*`);
    }
  }
  const pageDaily: PageDay[] = [];
  for (const date of dateRange(START, D)) {
    pages.forEach((p, v) => {
      const k = Number(p.slice(p.lastIndexOf('p') + 1));
      const lambda = (o.level ?? 80) + 4 * (v % 10);
      const mult = (date >= U ? 1 + o.updateEffect : 1) * (o.treated(p) && date >= dayOf(k) ? 1 + o.effect : 1);
      const i = poissonOne(rng, lambda * mult);
      pageDaily.push({ date, p, c: poissonOne(rng, i * 0.02), i, ps: i * 5 });
    });
  }
  return { pages, templates, pageDaily };
}

function touched(urls: string[], seen: (u: string) => boolean = () => true, seenAt?: (u: string) => string): TouchedUrl[] {
  return urls.map((u) => {
    const k = Number(u.slice(u.lastIndexOf('p') + 1));
    const to = seenAt ? seenAt(u) : `${dayOf(k)}T19:00:00Z`;
    return { url: u, before: 'Old heading', after: 'New heading', googleSeen: seen(u) ? { from: ptDayStart(X), to, precision: 'bounded' as const } : null };
  });
}

function change(urls: TouchedUrl[], over: Partial<SiteChange> = {}): SiteChange {
  return {
    id: 'sitechg_testchange01', source: 'snapshot', field: 'h1', cls: 'content', templateKey: '/blog/*',
    signature: 'h1:Old->New:/blog/*', deployed: { from: ptDayStart(addDays(X, -1)), to: `${X}T18:00:00Z`, precision: 'bounded' },
    touched: urls, text: null, ...over,
  };
}

function input(s: Site, changes: SiteChange[], over: Partial<SiteChangeInput> = {}): SiteChangeInput {
  return {
    changes, pageDaily: s.pageDaily, cells: [], curve, isBrand: () => false, templates: s.templates, linksBefore: () => [],
    events: [update], demandK: null, dataThrough: D, rng: (key) => rngFor('site-change-test', key), delta: 0.1, bootstrap: 200, fdrQ: 0.1,
    ...over,
  };
}

const blog = (n: number) => Array.from({ length: n }, (_, k) => url('blog', k));
const isTreated = (n: number) => (u: string) => u.includes('/blog/') && Number(u.slice(u.lastIndexOf('p') + 1)) < n;

describe('site-change attribution', () => {
  const s34 = site({ groups: [{ tpl: 'blog', n: 60 }], treated: isTreated(20), effect: -0.3, updateEffect: -0.2, seed: 'test34' });
  const in34 = input(s34, [change(touched(blog(20)))]);
  const out34 = analyzeSiteChanges(in34);

  it('34: recovers a -30% site change under a -20% update hitting every page (synthesis both)', () => {
    const [impact] = out34.impacts;
    expect(impact.outcome).toBe('impressions');
    expect(impact.treated).toBe(20);
    expect(impact.controls).toBe(40);
    expect(impact.controlFallback).toBe(false);
    expect(impact.tau).toBeGreaterThan(-0.36);
    expect(impact.tau).toBeLessThan(-0.24);
    expect(impact.ci95?.[0]).toBeLessThanOrEqual(-0.3);
    expect(impact.ci95?.[1]).toBeGreaterThanOrEqual(-0.3);
    expect(impact.controlChange).toBeGreaterThan(-0.24);
    expect(impact.controlChange).toBeLessThan(-0.16);
    expect(impact.synthesis).toBe('both');
    expect(impact.real).toBe('signal');
    const f = out34.findings.find((x) => x.id === impact.findingId);
    expect(f).toMatchObject({ kind: 'site_change_impact', template: 'mixed', cause: 'mixed', causeConfidence: 'AMBIGUOUS', metric: 'impressions' });
    expect(f?.slots).toMatchObject({ a: 'a change on your site', b: 'April 2026 core update' });
    expect(f?.related.googleEvents).toEqual(['core-2026-04']);
    expect(f?.unit).toEqual({ level: 'template', key: '/blog/*', label: '/blog/*' });
    expect(f?.evidence.map((e) => e.type)).toEqual(['snapshot_diff', 'inspection', 'statistic']);
  });

  it('37: the placebo 28 days earlier is noise and passes', () => {
    const [impact] = out34.impacts;
    expect(impact.placebo).not.toBeNull();
    expect(Math.abs(impact.placebo?.tau ?? 1)).toBeLessThan(0.05);
    const f = out34.findings.find((x) => x.id === impact.findingId);
    expect(f?.real).toBe('signal'); // the placebo check did not fail
  });

  it('is deterministic for the same inputs', () => {
    expect(analyzeSiteChanges(in34)).toEqual(out34);
  });

  it('34b: a site change alone, with untouched pages flat, is attributed to the site', () => {
    const s = site({ groups: [{ tpl: 'blog', n: 60 }], treated: isTreated(20), effect: -0.3, updateEffect: 0, seed: 'alone' });
    const out = analyzeSiteChanges(input(s, [change(touched(blog(20)))], { events: [] }));
    const [impact] = out.impacts;
    expect(impact.synthesis).toBe('site_change');
    const f = out.findings.find((x) => x.id === impact.findingId);
    expect(f).toMatchObject({ template: 'real_site_change', cause: 'site_change', causeConfidence: 'INFERRED', real: 'signal' });
    expect(f?.slots).toMatchObject({ n: 20, change_date: X, direction: 'down', level: 'high' });
    expect(Number(f?.slots.k)).toBeGreaterThanOrEqual(18);
    expect(f?.falsifier.key).toBe('revert_and_recrawl');
    expect(f?.alternatives.find((a) => a.key === 'update_no_overlap')?.ruledOut).toBe(true);
  });

  it('34c: an update with no site effect is attributed to Google', () => {
    const s = site({ groups: [{ tpl: 'blog', n: 60 }], treated: isTreated(20), effect: 0, updateEffect: -0.25, seed: 'google' });
    const out = analyzeSiteChanges(input(s, [change(touched(blog(20)))]));
    const [impact] = out.impacts;
    expect(impact.synthesis).toBe('google');
    const f = out.findings.find((x) => x.id === impact.findingId);
    expect(f).toMatchObject({ template: 'real_google', cause: 'google_update' });
    expect(f?.slots).toMatchObject({ update: 'April 2026 core update', direction: 'down' });
  });

  it('35: URLs Google has not recrawled are excluded and listed as notYetSeen', () => {
    const urls = blog(23);
    const out = analyzeSiteChanges(input(s34, [change(touched(urls, (u) => !/p2[0-2]$/.test(u)))]));
    const [impact] = out.impacts;
    expect(impact.notYetSeen).toEqual([url('blog', 20), url('blog', 21), url('blog', 22)]);
    expect(impact.treated).toBe(20);
    const notice = out.findings.find((f) => f.template === 'site_change_unseen');
    expect(notice).toMatchObject({ kind: 'notice', causeConfidence: 'EXTRACTED', slots: { n: 3, date: X } });
    // A change Google has seen nowhere yet gives only the notice.
    const none = analyzeSiteChanges(input(s34, [change(touched(blog(5), () => false))]));
    expect(none.impacts[0]).toMatchObject({ treated: 0, tau: null, synthesis: 'unclear', real: 'underpowered' });
    expect(none.findings.map((f) => f.template)).toEqual(['site_change_unseen']);
  });

  it('36: fewer than 5 same-template controls falls back to every untouched page (AMBIGUOUS); none gives unclear', () => {
    const s = site({ groups: [{ tpl: 'svc', n: 6 }, { tpl: 'blog', n: 30 }], treated: (u) => /\/svc\/p[0-2]$/.test(u), effect: -0.4, updateEffect: 0, seed: 'fallback' });
    const svcTreated = [url('svc', 0), url('svc', 1), url('svc', 2)];
    const out = analyzeSiteChanges(input(s, [change(touched(svcTreated), { templateKey: '/svc/*' })], { events: [] }));
    const [impact] = out.impacts;
    expect(impact.controlFallback).toBe(true);
    expect(impact.controls).toBe(33);
    const f = out.findings.find((x) => x.id === impact.findingId);
    expect(f?.causeConfidence).toBe('AMBIGUOUS');
    expect(f?.slots.level).not.toBe('high');

    const all = analyzeSiteChanges(input(s, [change(touched(s.pages), { templateKey: '/blog/*' })], { events: [] }));
    expect(all.impacts[0]).toMatchObject({ controls: 0, tau: null, real: 'unclear', synthesis: 'unclear' });
    const g = all.findings.find((x) => x.id === all.impacts[0].findingId);
    expect(g).toMatchObject({ template: 'cant_separate', reason: 'identification', causeConfidence: 'AMBIGUOUS' });
    expect(g?.slots.reason_text).toBe('coverage');
  });

  it('38: a control whose inlinks from treated pages changed is excluded', () => {
    const linksBefore = (u: string, at: string): string[] => (u === url('blog', 0) && at === `${X}T18:00:00Z` ? [url('blog', 45)] : []);
    const out = analyzeSiteChanges(input(s34, [change(touched(blog(20)))], { linksBefore }));
    expect(out.impacts[0].controls).toBe(39);
  });

  it('39: interval-censored dating uses the Pacific Time day of googleSeen.to', () => {
    expect(seenDay({ from: '2026-09-20T00:00:00Z', to: '2026-09-24T03:00:00Z', precision: 'bounded' })).toBe('2026-09-23');
    expect(windowsFor('2026-09-23', false)).toEqual({ pre: ['2026-08-26', '2026-09-22'], post: ['2026-09-26', '2026-10-23'] });
    expect(windowsFor('2026-09-23', true).pre).toEqual(['2026-08-22', '2026-09-18']);
    // In the analysis, a page recrawled at 03:00Z on X+2 is dated X+1.
    const seenAt = (): string => `${addDays(X, 2)}T03:00:00Z`;
    const out = analyzeSiteChanges(input(s34, [change(touched(blog(20), () => true, seenAt))]));
    expect(out.findings.find((f) => f.kind === 'site_change_impact')?.date).toBe(addDays(X, 1));
  });

  it('reports too-recent changes with a check date', () => {
    const out = analyzeSiteChanges(input(s34, [change(touched(blog(20)))], { dataThrough: addDays(X, 10) }));
    const f = out.findings.find((x) => x.kind === 'site_change_impact');
    expect(f).toMatchObject({ template: 'too_recent', real: 'underpowered', slots: { date: dayOf(0), check_date: addDays(dayOf(2), 30) } });
  });

  it('dates annotation changes Google has not been seen on at date + 3, and keeps them AMBIGUOUS', () => {
    const s = site({ groups: [{ tpl: 'blog', n: 60 }], treated: isTreated(20), effect: -0.3, updateEffect: 0, seed: 'note' });
    const note = change(touched(blog(20), () => false), {
      id: 'sitechg_annotation001', source: 'annotation', field: 'annotation', text: 'Rewrote the intros',
      deployed: { from: ptDayStart(addDays(X, -2)), to: ptDayStart(addDays(X, -1)), precision: 'unknown' },
    });
    const out = analyzeSiteChanges(input(s, [note], { events: [] }));
    const f = out.findings.find((x) => x.kind === 'site_change_impact');
    expect(f?.date).toBe(addDays(X, 1));
    expect(f?.causeConfidence).toBe('AMBIGUOUS');
    expect(f?.evidence[0]).toMatchObject({ type: 'annotation', partition: 'annotations.ndjson' });
  });

  it('says not enough data when the pages are too small', () => {
    const s = site({ groups: [{ tpl: 'blog', n: 20 }], treated: isTreated(2), effect: -0.3, updateEffect: 0, seed: 'small', level: 0.5 });
    const out = analyzeSiteChanges(input(s, [change(touched(blog(2)))], { events: [] }));
    const f = out.findings.find((x) => x.kind === 'site_change_impact');
    expect(f).toMatchObject({ real: 'underpowered', template: 'not_enough_data' });
    expect(Object.keys(f?.slots ?? {}).sort()).toEqual(['cpw', 'impr_sentence', 'mde', 'pct', 'weeks']);
  });

  it('measures a snippet change on the click rate at the same position', () => {
    const rng = testRng('ctr');
    const cells: Cell[] = [];
    const templates = new Map<string, string>();
    for (let k = 0; k < 30; k++) templates.set(url('blog', k), '/blog/*');
    for (const date of dateRange(START, D)) {
      for (let k = 0; k < 30; k++) {
        const treatedNow = k < 10 && date >= dayOf(k);
        const i = poissonOne(rng, 200);
        const c = poissonOne(rng, i * 0.1 * (treatedNow ? 0.7 : 1));
        cells.push({ date, q: `query ${k}`, p: url('blog', k), dv: 'desktop', c, i, ps: i * 3 });
      }
    }
    const snippet = change(touched(blog(10)), { field: 'title', cls: 'snippet', signature: 'title:a->b:/blog/*' });
    const out = analyzeSiteChanges({ ...input({ pages: [], templates, pageDaily: [] }, [snippet], { events: [] }), cells });
    const [impact] = out.impacts;
    expect(impact.outcome).toBe('ctr');
    expect(impact.tau).toBeGreaterThan(-0.36);
    expect(impact.tau).toBeLessThan(-0.24);
    expect(impact.synthesis).toBe('site_change');
    const f = out.findings.find((x) => x.id === impact.findingId);
    expect(f).toMatchObject({ metric: 'ctr', template: 'real_site_change', cause: 'site_change' });
    expect(f?.effect.absolute).toBeLessThan(0);
  });
});
