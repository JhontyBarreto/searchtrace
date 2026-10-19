// Spec 5.13 tests 24 to 30 and 32 (change points). Owner: WP-B.
import { describe, expect, it } from 'vitest';
import { addDays, diffDays } from '../../src/core/time.js';
import type { ChangePointInput, GoogleEvent, IsoDate, Series } from '../../src/core/types.js';
import { seasonalSeries } from '../../src/analyze/stats.js';
import {
  analyzeChangePoints, analyzeChangePointsWith, bestSplit, cusumTest, eventWindow, optimalPartition, prefixSums, pruneBoundaries,
} from '../../src/analyze/changepoint.js';
import { localiseOutcome } from '../../src/analyze/localise.js';
import { DEFAULT_DOW, dowMeans, negBinSeries, normalDraw, poissonSeries, testRng, withStep } from '../helpers/index.js';

const START = '2026-04-05';
const N = 182;
const END = addDays(START, N - 1);

function series(id: string, values: number[], o: Partial<Series> = {}): Series {
  return {
    id,
    unit: { level: 'site', key: 'site', label: 'Whole site' },
    metric: 'clicks',
    start: START,
    values,
    primary: false,
    ...o,
  };
}

function input(list: Series[], o: Partial<ChangePointInput> = {}): ChangePointInput {
  return {
    series: list,
    dow: DEFAULT_DOW,
    events: [],
    dataThrough: END,
    historyStart: START,
    seasonalValues: {},
    fdrQ: 0.1,
    delta: 0.15,
    ...o,
  };
}

describe('numerics', () => {
  it('optimal partitioning finds a clean step and pruning keeps it', () => {
    const y = [...Array(60).fill(10), ...Array(60).fill(4)];
    const s = Array(120).fill(1);
    const P = prefixSums(y, s);
    expect(bestSplit(P, 0, 120, 14)).toBe(60);
    const b = optimalPartition(P, 120, 1, 14, 3 * Math.log(120));
    expect(b).toEqual([60]);
    expect(pruneBoundaries(P, 120, b, 14, 1)).toEqual([60]);
  });

  it('pruning drops steps under 15% and merges', () => {
    const y = [...Array(40).fill(10), ...Array(40).fill(10.5), ...Array(40).fill(3)];
    const s = Array(120).fill(1);
    const P = prefixSums(y, s);
    expect(pruneBoundaries(P, 120, [40, 80], 14, 1)).toEqual([80]);
  });

  it('a flat series has p = 1 and an all-zero series is not tested', () => {
    expect(cusumTest(Array(100).fill(5), Array(100).fill(1), 14).p).toBeGreaterThan(0.99);
    expect(cusumTest(Array(100).fill(0), Array(100).fill(1), 14)).toEqual({ K: 0, p: 1, argmax: -1 });
  });

  it('event windows run from begin - 2 to end + 7 in PT, open events lasting 14 days', () => {
    const e: GoogleEvent = { id: 'x', source: 'seed', service: 'Ranking', kind: 'core', title: 'x', begin: '2026-09-24T03:00:00Z', end: null, endEstimated: true, url: null, modified: null };
    expect(eventWindow(e)).toEqual(['2026-09-21', '2026-10-14']);
  });
});

describe('analyzeChangePoints', () => {
  it('test 24: a -40% step at t = 120 on Poisson mean 3 with a DOW pattern is found within 7 days in >= 80 of 100 runs', () => {
    const truth = addDays(START, 120);
    let hits = 0;
    let detected = 0;
    for (let rep = 0; rep < 100; rep++) {
      const y = poissonSeries(testRng(`cp24-${rep}`), withStep(dowMeans(START, N, 3), 120, 0.6));
      const out = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
      if (out.changePoints.length > 0) detected++;
      const cp = out.changePoints[0];
      if (cp && Math.abs(diffDays(truth, cp.date)) <= 7) hits++;
    }
    expect(detected).toBeGreaterThanOrEqual(90);
    expect(hits).toBeGreaterThanOrEqual(80);
  });

  it('the step finding carries the effect, the window, the verdict and the template', () => {
    const y = poissonSeries(testRng('cp24-detail'), withStep(dowMeans(START, N, 6), 120, 0.5));
    const out = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
    expect(out.changePoints).toHaveLength(1);
    const cp = out.changePoints[0];
    expect(cp.shape).toBe('step');
    expect(cp.mode).toBe('daily');
    expect(cp.ratio).toBeGreaterThan(0.35);
    expect(cp.ratio).toBeLessThan(0.7);
    expect(cp.ci95[0]).toBeLessThan(cp.ratio);
    expect(cp.ci95[1]).toBeGreaterThan(cp.ratio);
    expect(cp.dateWindow[0] <= cp.date && cp.date <= cp.dateWindow[1]).toBe(true);
    const f = out.findings[0];
    expect(f.kind).toBe('change_point');
    expect(f.template).toBe('change_point');
    expect(f.real).toBe('signal');
    expect(f.causeConfidence).toBe('AMBIGUOUS');
    expect(f.slots).toMatchObject({ metric: 'clicks', unit: 'Whole site', date: cp.date, d1: cp.dateWindow[0], d2: cp.dateWindow[1], direction: 'down' });
    expect(f.slots.pct as number).toBeCloseTo(1 - cp.ratio, 9);
    expect(f.effect.estimate).toBeCloseTo(cp.ratio - 1, 9);
    expect(f.effect.absolute as number).toBeLessThan(0);
    expect(f.alternatives.map((a) => a.key)).toContain('update_no_overlap');
    expect(f.falsifier.key).toBe('reverts');
    expect(f.priority).toBeGreaterThan(1000);
    expect(f.evidence[0].partition).toBe(`gsc/${cp.date.slice(0, 4)}/${cp.date.slice(5, 7)}/${cp.date}.ndjson.gz`);
    expect(out.dispersion['site:clicks']).toBeGreaterThanOrEqual(1);
  });

  it('test 25: a day-of-week pattern alone is not detected', () => {
    const strong = [1.4, 1.3, 1.2, 1.1, 1.0, 0.5, 0.5];
    let found = 0;
    for (let rep = 0; rep < 50; rep++) {
      const y = poissonSeries(testRng(`cp25-${rep}`), dowMeans(START, N, 60, strong));
      const out = analyzeChangePoints(input([series('site:impressions', y, { metric: 'impressions', primary: true })]));
      if (out.changePoints.length > 0) found++;
    }
    expect(found).toBeLessThanOrEqual(6);
    const y0 = poissonSeries(testRng('cp25-0'), dowMeans(START, N, 60, strong));
    expect(analyzeChangePoints(input([series('s', y0)])).changePoints).toEqual([]);
  });

  it('test 26: a 3-day spike is not detected', () => {
    let found = 0;
    for (let rep = 0; rep < 50; rep++) {
      const means = dowMeans(START, N, 3).map((m, k) => (k >= 90 && k < 93 ? m * 6 : m));
      const out = analyzeChangePoints(input([series('s', poissonSeries(testRng(`cp26-${rep}`), means))]));
      if (out.changePoints.length > 0) found++;
    }
    expect(found).toBeLessThanOrEqual(6);
  });

  it('test 27: a step at t = 175 is too recent', () => {
    const y = poissonSeries(testRng('cp27'), withStep(dowMeans(START, N, 40), 175, 0.2));
    const out = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
    expect(out.changePoints).toHaveLength(1);
    const cp = out.changePoints[0];
    expect(cp.tooRecent).toBe(true);
    expect(Math.abs(diffDays(addDays(START, 175), cp.date))).toBeLessThanOrEqual(2);
    expect(cp.dateWindow[1]).toBe(END);
    const f = out.findings[0];
    expect(f.template).toBe('too_recent');
    expect(f.real).toBe('underpowered');
    // metric, unit and direction name the series, so two too-recent changes read differently.
    expect(f.slots).toEqual({ metric: 'clicks', unit: 'Whole site', direction: 'down', date: cp.date, check_date: addDays(cp.date, 14) });
    expect(f.falsifier).toEqual({ key: 'more_data', slots: { check_date: addDays(cp.date, 14) } });
  });

  it('test 28: CUSUM p-values on 500 null series are roughly uniform', () => {
    const s = seasonalSeries(START, N, DEFAULT_DOW);
    const ps: number[] = [];
    for (let rep = 0; rep < 500; rep++) ps.push(cusumTest(poissonSeries(testRng(`cp28-${rep}`), dowMeans(START, N, 3)), s, 14).p);
    const below = (x: number) => ps.filter((p) => p < x).length / ps.length;
    expect(below(0.05)).toBeGreaterThanOrEqual(0.02);
    expect(below(0.05)).toBeLessThanOrEqual(0.08);
    expect(below(0.5)).toBeGreaterThan(0.38);
    expect(below(0.5)).toBeLessThan(0.62);
  });

  it('test 29: 200 null series x 100 runs with BH, the share of runs with any discovery is <= 0.13', () => {
    let runsWithDiscovery = 0;
    for (let run = 0; run < 100; run++) {
      const list: Series[] = [];
      for (let k = 0; k < 200; k++) list.push(series(`page:${k}`, poissonSeries(testRng(`cp29-${run}-${k}`), dowMeans(START, N, 2 + (k % 5)))));
      if (analyzeChangePoints(input(list)).changePoints.length > 0) runsWithDiscovery++;
    }
    expect(runsWithDiscovery / 100).toBeLessThanOrEqual(0.13);
  });

  it('test 30: negative binomial with phi = 3 gives phi-hat in [2, 4.5] and false positives stay controlled', () => {
    const phis: number[] = [];
    let found = 0;
    for (let rep = 0; rep < 60; rep++) {
      const y = negBinSeries(testRng(`cp30-${rep}`), dowMeans(START, N, 20), 3);
      const out = analyzeChangePoints(input([series('s', y)]));
      phis.push(out.dispersion.s);
      if (out.changePoints.length > 0) found++;
    }
    phis.sort((a, b) => a - b);
    const median = phis[Math.floor(phis.length / 2)];
    expect(median).toBeGreaterThanOrEqual(2);
    expect(median).toBeLessThanOrEqual(4.5);
    expect(found / 60).toBeLessThanOrEqual(0.15);
  });

  it('test 32: the same step 364 days earlier makes the change unclear (seasonal)', () => {
    const histStart = addDays(START, -400);
    const len = diffDays(histStart, END) + 1;
    const stepAt = 120;
    const stepDate = addDays(START, stepAt);
    const lastYear = diffDays(histStart, addDays(stepDate, -364));
    // Last year: the same drop on the same date, recovering 60 days later.
    const means = dowMeans(histStart, len, 8).map((m, k) => {
      const t = k - diffDays(histStart, START);
      if (k >= lastYear && k < lastYear + 60) return m * 0.5;
      return t >= stepAt ? m * 0.5 : m;
    });
    const full = poissonSeries(testRng('cp32'), means);
    const offset = diffDays(histStart, START);
    const values = full.slice(offset);
    const out = analyzeChangePoints(
      input([series('site:clicks', values, { primary: true })], { historyStart: histStart, seasonalValues: { 'site:clicks': { start: histStart, values: full } } }),
    );
    expect(out.changePoints.length).toBeGreaterThanOrEqual(1);
    const cp = out.changePoints[0];
    expect(cp.seasonalMatch).toBe(true);
    const f = out.findings.find((x) => x.date === cp.date);
    expect(f?.real).toBe('unclear');
    expect(f?.reason).toBe('identification');
    expect(f?.cause).toBe('seasonal');
    expect(f?.alternatives.map((a) => a.key)).toContain('seasonal_same_last_year');

    // Without last year's drop the same change stays real.
    const plain = poissonSeries(testRng('cp32'), dowMeans(histStart, len, 8).map((m, k) => (k - offset >= stepAt ? m * 0.5 : m)));
    const out2 = analyzeChangePoints(
      input([series('site:clicks', plain.slice(offset), { primary: true })], { historyStart: histStart, seasonalValues: { 'site:clicks': { start: histStart, values: plain } } }),
    );
    expect(out2.changePoints[0].seasonalMatch).toBe(false);
    expect(out2.findings[0].real).toBe('signal');
    expect(out2.findings[0].alternatives.map((a) => a.key)).toContain('seasonal_not_last_year');
  });

  it('a near-empty or flat last year is not "the same thing last year"', () => {
    // Found on a real small site: a rise this July was capped as seasonal because last July had a
    // few clicks whose noisy ratio landed inside the change's wide interval.
    const histStart = addDays(START, -400);
    const len = diffDays(histStart, END) + 1;
    const offset = diffDays(histStart, START);
    const stepAt = 120;
    const now = (k: number, m: number): number => (k - offset >= stepAt ? m * 2 : m);
    // Last year averages 0.3 a day: below the 1-a-day floor, so the season is not checked at all.
    const thin = poissonSeries(testRng('cp32-thin'), dowMeans(histStart, len, 8).map((m, k) => (k < offset ? 0.3 : now(k, m))));
    const a = analyzeChangePoints(
      input([series('site:clicks', thin.slice(offset), { primary: true })], { historyStart: histStart, seasonalValues: { 'site:clicks': { start: histStart, values: thin } } }),
    );
    expect(a.changePoints[0].seasonalMatch).toBe(false);
    expect(a.findings[0].alternatives.map((x) => x.key)).not.toContain('seasonal_same_last_year');
    // Last year flat at 8 a day (ratio about 1): a rise now is not "the same thing".
    const flat = poissonSeries(testRng('cp32-flat'), dowMeans(histStart, len, 8).map((m, k) => (k < offset ? m : now(k, m))));
    const b = analyzeChangePoints(
      input([series('site:clicks', flat.slice(offset), { primary: true })], { historyStart: histStart, seasonalValues: { 'site:clicks': { start: histStart, values: flat } } }),
    );
    expect(b.changePoints[0].seasonalMatch).toBe(false);
    expect(b.findings[0].real).toBe('signal');
  });

  it('labels Google update overlaps and caps impressions changes during a reporting change', () => {
    const stepDate = addDays(START, 120);
    const core: GoogleEvent = {
      id: 'core1', source: 'seed', service: 'Ranking', kind: 'core', title: 'Test core update', begin: `${addDays(stepDate, -3)}T16:00:00Z`,
      end: `${addDays(stepDate, 5)}T16:00:00Z`, endEstimated: false, url: null, modified: null,
    };
    const anomaly: GoogleEvent = { ...core, id: 'curated-x', source: 'curated', service: 'Reporting', kind: 'data_anomaly', title: 'Counting change' };
    const clicks = poissonSeries(testRng('cp-ov-c'), withStep(dowMeans(START, N, 8), 120, 0.5));
    const impressions = poissonSeries(testRng('cp-ov-i'), withStep(dowMeans(START, N, 300), 120, 0.6));
    const out = analyzeChangePoints(
      input(
        [
          series('site:clicks', clicks, { primary: true }),
          series('site:impressions', impressions, { metric: 'impressions', primary: true }),
        ],
        { events: [core, anomaly] },
      ),
    );
    const c = out.findings.find((f) => f.metric === 'clicks');
    const i = out.findings.find((f) => f.metric === 'impressions');
    expect(c?.cause).toBe('google_update');
    expect(c?.real).toBe('signal'); // click claims are not capped by a reporting change
    expect(c?.related.googleEvents).toEqual(expect.arrayContaining(['core1', 'curated-x']));
    expect(c?.alternatives.map((a) => a.key)).toContain('update_overlaps');
    expect(i?.template).toBe('reporting_artefact');
    expect(i?.real).toBe('unclear');
    expect(i?.cause).toBe('data_anomaly');
    expect(i?.slots).toMatchObject({ metric: 'impressions', event: 'Counting change' });
    const cpI = out.changePoints.find((x) => x.metric === 'impressions');
    expect(cpI?.overlaps.map((o) => o.kind).sort()).toEqual(['core', 'data_anomaly']);
  });

  it('localises site-level changes across segment series (rates over 40 runs)', () => {
    const tpl = (key: string, base: number, ratio: number, rep: number): Series =>
      series(`tpl:${key}:clicks`, poissonSeries(testRng(`loc-${key}-${ratio}-${rep}`), withStep(dowMeans(START, N, base), 120, ratio)), {
        unit: { level: 'template', key, label: key }, segmentsOf: 'site:clicks',
      });
    const scenario = (ratios: [number, number, number], rep: number) => {
      const segs = [tpl('/blog/*', 30, ratios[0], rep), tpl('/services/*', 20, ratios[1], rep), tpl('other pages', 20, ratios[2], rep)];
      const site = series('site:clicks', segs[0].values.map((v, k) => v + segs[1].values[k] + segs[2].values[k]), { primary: true });
      return analyzeChangePoints(input([site, ...segs])).changePoints.find((x) => x.seriesId === 'site:clicks')?.localisation ?? null;
    };
    let concentrated = 0;
    let topIsBlog = 0;
    let notConcentrated = 0;
    let calledProportional = 0;
    for (let rep = 0; rep < 40; rep++) {
      // Only /blog/* falls.
      const a = scenario([0.3, 1, 1], rep);
      if (a && localiseOutcome(a) === 'concentrated') concentrated++;
      if (a?.top[0]?.label === '/blog/*') topIsBlog++;
      // Every section falls by the same share.
      const b = scenario([0.5, 0.5, 0.5], rep);
      if (b && localiseOutcome(b) !== 'concentrated') notConcentrated++;
      if (b?.proportional) calledProportional++;
    }
    expect(concentrated).toBeGreaterThanOrEqual(38);
    expect(topIsBlog).toBeGreaterThanOrEqual(38);
    // A 5% test: about 2 of 40 reject by chance. Not rejecting is no longer read as "in proportion":
    // at 20 to 30 a day per section the equivalence check rarely passes, which is the honest answer.
    expect(notConcentrated).toBeGreaterThanOrEqual(34);
    expect(calledProportional).toBeLessThanOrEqual(notConcentrated);
  });

  it('tests a segment-only series as a localisation segment but never on its own', () => {
    const y = poissonSeries(testRng('seg-only'), withStep(dowMeans(START, N, 20), 100, 0.5));
    const tpl = series('tpl:/:clicks', y, { unit: { level: 'template', key: '/', label: '/' }, segmentsOf: 'site:clicks' });
    const page = series('page:https://x.example/:clicks', y, { unit: { level: 'page', key: 'https://x.example/', label: '/' } });
    const both = analyzeChangePoints(input([tpl, page]));
    expect(new Set(both.changePoints.map((c) => c.seriesId))).toEqual(new Set([tpl.id, page.id]));
    const once = analyzeChangePointsWith(input([tpl, page]), { segmentOnly: new Set([tpl.id]) });
    expect(once.changePoints.map((c) => c.seriesId)).toEqual([page.id]);
  });

  it('judges each change point with its own unit delta and its own test (BH family 1b)', () => {
    const y = poissonSeries(testRng('own-delta'), withStep(dowMeans(START, N, 30), 90, 0.5));
    const page = analyzeChangePoints(input([series('page:p', y, { unit: { level: 'page', key: 'https://x.example/p', label: '/p' } })]));
    expect(page.findings[0].slots.delta).toBe(0.2);
    const site = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
    expect(site.findings[0].slots.delta).toBe(0.1);
    // A big step and a small one on the same series get their own p-values, not the series' one.
    const two = poissonSeries(testRng('two-steps'), dowMeans(START, N, 40).map((m, k) => (k < 60 ? m : k < 130 ? m * 0.5 : m * 0.42)));
    const out = analyzeChangePoints(input([series('site:clicks', two, { primary: true })]));
    if (out.changePoints.length >= 2) expect(new Set(out.changePoints.map((c) => c.p)).size).toBeGreaterThan(1);
    expect(out.changePoints[0].q).toBeGreaterThanOrEqual(out.changePoints[0].p);
  });

  it('a dip that comes back within 60 days is one temporary change, not two', () => {
    const means = dowMeans(START, N, 25).map((m, k) => (k >= 80 && k < 115 ? m * 0.4 : m));
    const out = analyzeChangePoints(input([series('site:clicks', poissonSeries(testRng('dip'), means), { primary: true })]));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.slots.direction).toBe('down');
    expect(f.slots.back).toBe(addDays(START, 115));
    expect(f.real).toBe('signal');
    expect(f.falsifier.key).toBe('record_changes');
  });

  it('births: new pages are tested only after they appear, reported as one fact, and never shift the q-values of other series', () => {
    const nulls: Series[] = [];
    for (let k = 0; k < 40; k++) nulls.push(series(`page:n${k}`, poissonSeries(testRng(`birth-null-${k}`), dowMeans(START, N, 3 + (k % 4))), { unit: { level: 'page', key: `https://x.example/n${k}`, label: `/n${k}` } }));
    const births = (count: number): Series[] => Array.from({ length: count }, (_, k) => {
      const at = 40 + 3 * k;
      const y = poissonSeries(testRng(`birth-${k}`), dowMeans(START, N, 6).map((m, t) => (t < at ? 0 : m)));
      return series(`page:b${k}`, y, { metric: 'impressions', unit: { level: 'page', key: `https://x.example/b${k}`, label: `/b${k}` } });
    });
    const qOf = (out: ReturnType<typeof analyzeChangePoints>): string => JSON.stringify(out.changePoints.filter((c) => c.seriesId.startsWith('page:n')).map((c) => [c.seriesId, c.q]));
    const none = analyzeChangePoints(input(nulls));
    const some = analyzeChangePoints(input([...nulls, ...births(10)]));
    const many = analyzeChangePoints(input([...nulls, ...births(30)]));
    expect(qOf(some)).toBe(qOf(none));
    expect(qOf(many)).toBe(qOf(none));
    // No finding on a birth series claims a ratio change caused by an update; the births are one fact.
    for (const f of many.findings) if (f.unit.key.includes('/b')) expect(f.cause).not.toBe('google_update');
    for (const c of many.changePoints.filter((x) => x.seriesId.startsWith('page:b'))) {
      const k = Number(c.seriesId.slice('page:b'.length));
      expect(c.date >= addDays(START, 40 + 3 * k + 28)).toBe(true);
    }
    const fact = many.findings.find((f) => f.kind === 'notice');
    expect(fact?.reason).toBe('fact');
    expect(fact?.slots.appeared).toBe(30);
    expect(fact?.slots.d1).toBe(addDays(START, 40));
    // A page with history before the window is not a birth, even when its first window day is empty:
    // it is tested from the start and its rise is an ordinary change point.
    const old = poissonSeries(testRng('old-page'), dowMeans(START, N, 6).map((m, t) => (t === 0 ? 0 : t < 60 ? 2 : m)));
    const hist = [...Array(100).fill(2), ...old];
    const seasonal = analyzeChangePoints(input([series('page:old', old, { unit: { level: 'page', key: 'https://x.example/old', label: '/old' } })], {
      historyStart: addDays(START, -100), seasonalValues: { 'page:old': { start: addDays(START, -100), values: hist } },
    }));
    expect(seasonal.findings.some((f) => f.kind === 'notice')).toBe(false);
    expect(seasonal.changePoints.some((c) => c.ratio > 2)).toBe(true);
  });

  it('wander measured before the window keeps a drifting series from turning into Real changes', () => {
    // AR(1) level wander (no events) with 300 days of the same wander before the window.
    let signalsWithHistory = 0;
    let signalsWithout = 0;
    for (let rep = 0; rep < 30; rep++) {
      const rng = testRng(`wander-${rep}`);
      const len = 300 + N;
      let x = 0;
      const lv: number[] = [];
      for (let t = 0; t < len; t++) {
        x = 0.95 * x + 0.06 * normalDraw(rng);
        lv.push(x);
      }
      const full = poissonSeries(rng, dowMeans(addDays(START, -300), len, 20).map((m, t) => m * Math.exp(lv[t])));
      const win = full.slice(300);
      const base = series('page:w', win, { unit: { level: 'page', key: 'https://x.example/w', label: '/w' } });
      const withH = analyzeChangePoints(input([base], { historyStart: addDays(START, -300), seasonalValues: { 'page:w': { start: addDays(START, -300), values: full } } }));
      const without = analyzeChangePoints(input([base]));
      signalsWithHistory += withH.findings.filter((f) => f.real === 'signal').length;
      signalsWithout += without.findings.filter((f) => f.real === 'signal').length;
    }
    expect(signalsWithHistory).toBeLessThan(signalsWithout);
    expect(signalsWithHistory).toBeLessThanOrEqual(6);
  });

  it('sparse series use weekly mode; series below every floor are not tested', () => {
    // About 0.6 a day: below the daily floor (mean >= 1), above the weekly floor (total >= 60).
    const y = poissonSeries(testRng('weekly'), withStep(dowMeans(START, N, 0.9), 91, 0.15));
    const out = analyzeChangePoints(input([series('page:x', y)]));
    for (const cp of out.changePoints) expect(cp.mode).toBe('weekly');
    const tiny = analyzeChangePoints(input([series('page:tiny', poissonSeries(testRng('tiny'), dowMeans(START, N, 0.2)))]));
    expect(tiny.changePoints).toEqual([]);
    expect(tiny.dispersion['page:tiny']).toBeGreaterThanOrEqual(1);
  });

  it('a slow slide is labelled gradual with a weekly slope', () => {
    const means = dowMeans(START, N, 30).map((m, k) => (k < 70 ? m : k < 140 ? m * (1 - (0.7 * (k - 70)) / 70) : m * 0.3));
    const y = poissonSeries(testRng('gradual'), means);
    const out = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
    expect(out.changePoints).toHaveLength(1);
    const cp = out.changePoints[0];
    expect(cp.shape).toBe('gradual');
    expect(cp.slopePerWeek as number).toBeLessThan(0);
    const f = out.findings[0];
    expect(f.template).toBe('gradual');
    expect(f.slots).toMatchObject({ metric: 'clicks', unit: 'Whole site', direction: 'down', date: cp.date });
    expect(f.slots.slope as number).toBeGreaterThan(0);
  });

  it('is deterministic and sorts its output', () => {
    const list = [
      series('a', poissonSeries(testRng('det-a'), withStep(dowMeans(START, N, 10), 60, 0.4))),
      series('b', poissonSeries(testRng('det-b'), withStep(dowMeans(START, N, 10), 130, 2))),
    ];
    const one = analyzeChangePoints(input(list));
    const two = analyzeChangePoints(input(structuredClone(list)));
    expect(two).toEqual(one);
    const dates = one.changePoints.map((c) => c.date);
    expect([...dates].sort()).toEqual(dates);
    const pr = one.findings.map((f) => f.priority);
    expect([...pr].sort((a, b) => b - a)).toEqual(pr);
    expect(one.findings.find((f) => f.slots.direction === 'up')).toBeDefined();
  });

  it('copy rules: no long dashes in any slot or evidence line', () => {
    const y = poissonSeries(testRng('copy'), withStep(dowMeans(START, N, 12), 100, 0.5));
    const out = analyzeChangePoints(input([series('site:clicks', y, { primary: true })]));
    const text = JSON.stringify(out);
    expect(text).not.toMatch(new RegExp('[\\u2013\\u2014]'));
    expect(out.findings.length).toBeGreaterThan(0);
  });
});

export const _unused: IsoDate = START;
