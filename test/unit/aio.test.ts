// WP-D: AI Overview effect (spec 5.11, tests 40 to 46) plus per-query facts and apportioning.
// Everything is synthetic and seeded.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import { rngFor } from '../../src/core/rng.js';
import type { AioInput, AnalysisWindows, Cell, CtrCurve, Device, Rng, SerpCandidate, SerpObservation } from '../../src/core/types.js';
import { analyzeAio, bucketOf, estimateGroups, type QueryData, statusOf, titleRewritten, type WindowName } from '../../src/analyze/aio.js';
import { poissonDraw } from '../../src/analyze/stats.js';
import { renderSentence } from '../../src/report/copy.js';
import { designSample } from '../../src/sources/dataforseo/sample.js';

const D = '2026-10-03';
const WINDOWS: AnalysisWindows = {
  current: [addDays(D, -27), D],
  baseline: [addDays(D, -55), addDays(D, -28)],
  fit: [addDays(D, -28 - 181), addDays(D, -28)],
  holdoutFrom: addDays(D, -55),
  placebo: { pre1: [addDays(D, -111), addDays(D, -84)], pre2: [addDays(D, -83), addDays(D, -56)] },
  changepoint: [addDays(D, -181), D],
  seasonal: null,
};
const WIN_OF: Record<WindowName, [string, string]> = { b: WINDOWS.baseline, c: WINDOWS.current, pre1: WINDOWS.placebo.pre1, pre2: WINDOWS.placebo.pre2 };
const WINS: WindowName[] = ['pre1', 'pre2', 'b', 'c'];

const f = (p: number): number => Math.max(1e-5, 0.3 * p ** -1.2);
const CURVE: CtrCurve = {
  f: (p) => f(p),
  fMix: (p) => f(p),
  unstable: [],
  m: 500,
  bins: [],
  fitWindow: WINDOWS.fit,
  redraw() {
    return this;
  },
};

// ---------- direct estimator tests (40, 41, 43) ----------

/** Bucket positions spread over [1, 20]. */
const POSITIONS = [1.2, 2, 3, 4.5, 7.5, 15];

function synthQueries(
  rng: Rng,
  o: { n: number; mult: number; misfit: (p: number) => number; pAio: (p: number) => number; imp: [number, number]; stratified?: boolean; levelGap?: boolean },
): QueryData[] {
  const qs: QueryData[] = [];
  for (let k = 0; k < o.n; k++) {
    const b = k % POSITIONS.length;
    const p = POSITIONS[b] * (0.92 + 0.16 * rng());
    const aio = rng() < o.pAio(p);
    const imp = o.imp[0] + Math.floor(rng() * (o.imp[1] - o.imp[0]));
    const C = { b: 0, c: 0, pre1: 0, pre2: 0 };
    const E = { b: 0, c: 0, pre1: 0, pre2: 0 };
    for (const w of WINS) {
      const mult = aio && (w === 'c' || o.levelGap) ? o.mult : 1;
      C[w] = poissonDraw(rng, imp * f(p) * o.misfit(p) * mult);
      E[w] = imp * f(p);
    }
    qs.push({ key: `q${k}|desktop`, group: aio ? 'U' : 'N', stratum: o.stratified === false ? 'all' : `${bucketOf(p)}|desktop`, w: 1, C, E });
  }
  return qs;
}

const covers = (ci: [number, number] | null, x: number): boolean => !!ci && ci[0] <= x && x <= ci[1];

describe('AIO estimators (tests 40, 41, 43)', () => {
  const misfit = (p: number): number => (p >= 2.5 && p < 5.5 ? 1.5 : 0.8);
  const pAio = (p: number): number => (p >= 2.5 && p < 5.5 ? 0.7 : 0.15);

  it('40: with AIO likelier at positions 3 to 5, the unstratified estimate is biased and the stratified CI covers truth', () => {
    const reps = 200;
    let coverCs = 0;
    let coverDid = 0;
    let unstratSum = 0;
    for (let r = 0; r < reps; r++) {
      const rng = rngFor('t40', String(r));
      const qs = synthQueries(rng, { n: 400, mult: 0.7, misfit, pAio, imp: [300, 1500] });
      const cs = estimateGroups(qs, { estimator: 'cross_section', B: 200, rng: rngFor('t40b', String(r)) });
      const dd = estimateGroups(qs, { estimator: 'did', B: 200, rng: rngFor('t40c', String(r)) });
      if (covers(cs.ci95, -0.3)) coverCs++;
      if (covers(dd.ci95, -0.3)) coverDid++;
      const flat = estimateGroups(qs.map((q) => ({ ...q, stratum: 'all' })), { estimator: 'cross_section', B: 0, rng: rngFor('x', 'y') });
      unstratSum += flat.tau as number;
      if (r === 0) expect(cs.floorsMet && dd.floorsMet).toBe(true);
    }
    expect(Math.abs(unstratSum / reps - -0.3)).toBeGreaterThan(0.15);
    expect(coverCs / reps).toBeGreaterThanOrEqual(0.92);
    expect(coverDid / reps).toBeGreaterThanOrEqual(0.92);
  }, 60_000);

  it('41: with no effect the CIs cover zero at least 92% of the time', () => {
    const reps = 200;
    let cs0 = 0;
    let dd0 = 0;
    for (let r = 0; r < reps; r++) {
      const qs = synthQueries(rngFor('t41', String(r)), { n: 400, mult: 1, misfit, pAio, imp: [300, 1500] });
      if (covers(estimateGroups(qs, { estimator: 'cross_section', B: 200, rng: rngFor('t41b', String(r)) }).ci95, 0)) cs0++;
      if (covers(estimateGroups(qs, { estimator: 'did', B: 200, rng: rngFor('t41c', String(r)) }).ci95, 0)) dd0++;
    }
    expect(cs0 / reps).toBeGreaterThanOrEqual(0.92);
    expect(dd0 / reps).toBeGreaterThanOrEqual(0.92);
  }, 60_000);

  it('43: checking only the biggest losers is biased; the HT design with certainty units recovers truth', () => {
    const reps = 150;
    let losersSum = 0;
    let htSum = 0;
    let htN = 0;
    for (let r = 0; r < reps; r++) {
      const rng = rngFor('t43', String(r));
      const pop: QueryData[] = [];
      for (let k = 0; k < 400; k++) {
        const p = k % 2 === 0 ? 7 * (0.9 + 0.2 * rng()) : 14 * (0.9 + 0.2 * rng());
        const aio = rng() < 0.4;
        const imp = 150 + Math.floor(rng() * 900);
        const C = { b: 0, c: 0, pre1: 0, pre2: 0 };
        const E = { b: 0, c: 0, pre1: 0, pre2: 0 };
        for (const w of WINS) {
          C[w] = poissonDraw(rng, imp * f(p) * (aio && w === 'c' ? 0.7 : 1));
          E[w] = imp * f(p);
        }
        pop.push({ key: `q${k}|desktop`, group: aio ? 'U' : 'N', stratum: `${bucketOf(p)}|desktop`, w: 1, C, E });
      }
      // (a) the 150 biggest losers, unweighted
      const losers = [...pop].sort((a, b) => (a.C.c - a.C.b) - (b.C.c - b.C.b)).slice(0, 150);
      const a = estimateGroups(losers, { estimator: 'did', B: 0, rng });
      if (a.tau !== null) losersSum += a.tau;
      // (b) the HT design with the same expected size, weights 1/pi
      const cands: SerpCandidate[] = pop.map((q) => ({
        keyword: q.key.split('|')[0], device: 'desktop' as Device, pbar: 7, impressions: 100, expectedBaseClicks: q.E.b,
        deltaClicks: q.C.c - q.C.b, pages: [],
      }));
      const design = designSample(cands, 150 * 0.0012, `p|w${r}`, 0.0012);
      const byKw = new Map(pop.map((q) => [q.key.split('|')[0], q]));
      const sample = design.units.map((u) => ({ ...(byKw.get(u.keyword) as QueryData), w: 1 / u.pi }));
      const b = estimateGroups(sample, { estimator: 'did', B: 0, rng });
      if (b.tau !== null) {
        htSum += b.tau;
        htN++;
      }
    }
    const biasLosers = Math.abs(losersSum / reps - -0.3);
    const biasHt = Math.abs(htSum / htN - -0.3);
    expect(htN).toBeGreaterThan(reps * 0.9);
    expect(biasHt).toBeLessThan(0.04);
    expect(biasLosers).toBeGreaterThan(biasHt + 0.05);
  }, 60_000);

  it('drops strata with fewer than 3 searches per group and reports coverage', () => {
    const rng = rngFor('cov', '1');
    const qs = synthQueries(rng, { n: 400, mult: 0.7, misfit: () => 1, pAio: () => 0.5, imp: [300, 900] });
    qs.push({ key: 'lonely|mobile', group: 'U', stratum: '0|mobile', w: 1, C: { b: 10, c: 10, pre1: 10, pre2: 10 }, E: { b: 10000, c: 10000, pre1: 10, pre2: 10 } });
    const est = estimateGroups(qs, { estimator: 'did', B: 50, rng });
    expect(est.kept).not.toContain('0|mobile');
    expect(est.coverage).toBeLessThan(0.7); // the lonely search holds most expected clicks
  });

  it('bucketOf follows the stratum edges', () => {
    expect(bucketOf(1)).toBe(0);
    expect(bucketOf(1.5)).toBe(1);
    expect(bucketOf(3.49)).toBe(2);
    expect(bucketOf(5.5)).toBe(4);
    expect(bucketOf(20.5)).toBe(5);
    expect(bucketOf(20.6)).toBeNull();
    expect(bucketOf(0.5)).toBeNull();
    expect(bucketOf(Number.NaN)).toBeNull();
  });
});

// ---------- analyzeAio end to end (tests 42, 44, 45, 46) ----------

interface Spec {
  keyword: string;
  device?: Device;
  pos: number;
  imp: number;
  mult: Partial<Record<WindowName, number>>;
  checks: { aio: boolean; cited?: boolean; at?: string; ourTitle?: string }[];
}

function obs(s: Spec, k: number, c: Spec['checks'][number]): SerpObservation {
  const refs = c.aio
    ? [
        { domain: 'www.semrush.com', url: `https://www.semrush.com/${k}`, title: 'S', source: null },
        ...(c.cited ? [{ domain: 'www.example.com', url: `https://example.com/${s.keyword}`, title: 'Us', source: null }] : []),
      ]
    : [];
  return {
    intentKey: `ik-${s.keyword}`, taskId: `t-${s.keyword}-${k}`, keyword: s.keyword, device: s.device ?? 'desktop', locationCode: 2826, languageCode: 'en',
    isoWeek: '2026-W40', observedAt: c.at ?? `${addDays(WINDOWS.current[0], 7 + k * 7)}T12:00:00Z`, design: 'census', pi: 1,
    itemTypes: c.aio ? ['ai_overview', 'organic'] : ['organic'],
    aio: c.aio ? { async: false, citesUs: !!c.cited, refs } : null,
    organic: [{ rankAbsolute: 3, domain: 'example.com', url: `https://example.com/${s.keyword}`, title: c.ourTitle ?? `${s.keyword} | Example` }],
    ours: { rankAbsolute: 3, url: `https://example.com/${s.keyword}`, title: c.ourTitle ?? `${s.keyword} | Example` },
  };
}

function input(specs: Spec[], o: { seed: string; B?: number; samePos?: Map<string, number>; titles?: Map<string, string> } = { seed: 'x' }): AioInput {
  const rng = rngFor(o.seed, 'cells');
  const cells: Cell[] = [];
  for (const s of specs) {
    for (const w of WINS) {
      const days = 28;
      for (let d = 0; d < days; d += 7) {
        const imp = s.imp / 4;
        cells.push({
          date: addDays(WIN_OF[w][0], d), q: s.keyword, p: `https://example.com/${s.keyword}`, dv: s.device ?? 'desktop',
          i: imp, ps: imp * s.pos, c: poissonDraw(rng, imp * f(s.pos) * (s.mult[w] ?? 1)),
        });
      }
    }
  }
  return {
    serp: specs.flatMap((s) => s.checks.map((c, k) => obs(s, k, c))),
    cells, curve: CURVE, isBrand: () => false, windows: WINDOWS, siteDomain: 'example.com',
    pageTitles: o.titles ?? new Map(), samePosByQuery: o.samePos ?? new Map(),
    rng: (key) => rngFor(o.seed, key), delta: 0.15, bootstrap: o.B ?? 300,
  };
}

const POS = [1.2, 2, 3, 4.5, 7.5];

function population(n: number, o: { aioShare: number; mult: (w: WindowName) => number; checks?: number; imp?: number; cited?: boolean }): Spec[] {
  return Array.from({ length: n }, (_, k) => {
    const aio = k < n * o.aioShare;
    const nChecks = o.checks ?? 2;
    return {
      keyword: `q${String(k).padStart(3, '0')}`, pos: POS[k % POS.length], imp: o.imp ?? 4000,
      mult: aio ? { pre1: o.mult('pre1'), pre2: o.mult('pre2'), b: o.mult('b'), c: o.mult('c') } : {},
      checks: Array.from({ length: nChecks }, () => ({ aio, cited: aio && !!o.cited })),
    };
  });
}

describe('analyzeAio', () => {
  it('recovers a planted DiD effect as a signal and apportions clicks', () => {
    const specs = population(150, { aioShare: 0.4, mult: (w) => (w === 'c' ? 0.7 : 1) });
    const samePos = new Map([['q000|desktop', -50], ['q001|desktop', 3]]);
    const out = analyzeAio(input(specs, { seed: 'sig', samePos }));
    const did = out.estimates.find((e) => e.estimator === 'did');
    expect(did?.real).toBe('signal');
    expect(did?.tau).toBeGreaterThan(-0.4);
    expect(did?.tau).toBeLessThan(-0.2);
    expect(did?.groups).toMatchObject({ U: 60, N: 90, Cit: 0, intermittent: 0 });
    const f0 = out.facts.find((x) => x.keyword === 'q000');
    expect(f0?.attributedClicks).toBeGreaterThan(0);
    expect(f0?.attributedClicks).toBeLessThanOrEqual(50);
    expect(out.facts.find((x) => x.keyword === 'q001')?.attributedClicks).toBeNull(); // S_q >= 0
    const fd = out.findings.find((x) => x.kind === 'aio_effect' && x.slots.estimator === 'did');
    expect(fd).toMatchObject({ kind: 'aio_effect', unit: { level: 'site', key: 'site' }, real: 'signal', cause: 'ai_overview', causeConfidence: 'INFERRED', template: 'aio_not_cited' });
    expect(fd?.slots.x).toBe(did?.tau);
    expect(fd?.slots.lo).toBe(did?.ci95?.[0]);
    expect(fd?.slots.wording).toBe('estimate_not_measured');
    expect(fd?.effect.absolute).toBeLessThan(0);
  });

  it('uses the configured false-discovery rate (AioInput.fdrQ), not a fixed 0.10', () => {
    const specs = population(150, { aioShare: 0.4, mult: (w) => (w === 'c' ? 0.7 : 1) });
    const did = (fdrQ?: number) => analyzeAio({ ...input(specs, { seed: 'sig' }), ...(fdrQ === undefined ? {} : { fdrQ }) }).estimates.find((e) => e.estimator === 'did');
    expect(did()?.real).toBe('signal');
    expect(did(0.1)?.real).toBe('signal');
    // The bootstrap p can't go below 1/(B+1), so a q-value threshold of 0.0001 can never be met.
    expect(did(1e-4)?.real).toBe('underpowered');
  });

  it('42: a level gap with no change shows in the cross-section, the DiD is about zero, and the copy says comparison', () => {
    const specs = population(150, { aioShare: 0.4, mult: () => 0.7 });
    const out = analyzeAio(input(specs, { seed: 't42' }));
    const cs = out.estimates.find((e) => e.estimator === 'cross_section');
    const did = out.estimates.find((e) => e.estimator === 'did');
    expect(cs?.tau).toBeLessThan(-0.2);
    expect(cs?.tau).toBeGreaterThan(-0.4);
    expect(Math.abs(did?.tau as number)).toBeLessThan(0.08);
    expect(covers(did?.ci95 ?? null, 0)).toBe(true);
    expect(did?.real).not.toBe('signal');
    const fCs = out.findings.find((x) => x.kind === 'aio_effect' && x.slots.estimator === 'cross_section');
    expect(fCs?.slots.wording).toBe('comparison_not_proof');
    expect(fCs?.causeConfidence).toBe('AMBIGUOUS');
  });

  it('44: 15 searches per group is underpowered with an MDE', () => {
    const specs = population(30, { aioShare: 0.5, mult: (w) => (w === 'c' ? 0.7 : 1) });
    const out = analyzeAio(input(specs, { seed: 't44' }));
    for (const e of out.estimates) expect(e.real).toBe('underpowered');
    const fd = out.findings.find((x) => x.kind === 'aio_effect' && x.slots.estimator === 'did');
    expect(fd?.reason).toBe('floors');
    expect(fd?.power?.mde).toBeGreaterThan(0);
    expect(fd?.power?.mde).toBeLessThanOrEqual(1);
    expect(fd?.template).toBe('not_enough_data');
    expect(fd?.slots.weeks).toBe(4);
    expect(fd?.falsifier.key).toBe('more_data');
  });

  it('45: a diverging pre-trend fails the placebo, so the DiD is unclear', () => {
    const trend: Record<WindowName, number> = { pre1: 1, pre2: 0.78, b: 0.61, c: 0.475 };
    const specs = population(150, { aioShare: 0.4, mult: (w) => trend[w] });
    const out = analyzeAio(input(specs, { seed: 't45' }));
    const did = out.estimates.find((e) => e.estimator === 'did');
    expect(did?.placebo?.tau).toBeLessThan(-0.1);
    expect(did?.real).toBe('unclear');
    const fd = out.findings.find((x) => x.kind === 'aio_effect' && x.slots.estimator === 'did');
    expect(fd?.template).toBe('cant_separate');
    expect(fd?.slots.check).toBe('placebo');
  });

  it('46: day 0 with single checks is never a signal: the cross-section fails single_check', () => {
    const specs = population(150, { aioShare: 0.4, mult: (w) => (w === 'c' ? 0.5 : 1), checks: 1 }).map((s) => ({
      ...s, checks: s.checks.map((c) => ({ ...c, at: '2026-10-06T08:00:00Z' })), // checked after the last sealed day
    }));
    const out = analyzeAio(input(specs, { seed: 't46' }));
    for (const e of out.estimates) expect(e.real).not.toBe('signal');
    const cs = out.estimates.find((e) => e.estimator === 'cross_section');
    expect(cs?.real).toBe('unclear');
    expect(out.estimates.find((e) => e.estimator === 'did')?.real).toBe('underpowered');
    const fCs = out.findings.find((x) => x.kind === 'aio_effect' && x.slots.estimator === 'cross_section');
    expect(fCs?.slots.check).toBe('single_check');
    expect(fCs?.slots.single_check).toBe('yes');
    expect(out.facts.every((x) => x.status === 'single_present' || x.status === 'single_absent')).toBe(true);
  });

  it('lists every checked search as a Measured fact with cited, domains and title rewrite', () => {
    const specs: Spec[] = [
      { keyword: 'cited one', pos: 2, imp: 400, mult: {}, checks: [{ aio: true, cited: true }, { aio: true, cited: true }] },
      { keyword: 'not cited', pos: 3, imp: 400, mult: {}, checks: [{ aio: true }, { aio: true }, { aio: false }], },
      { keyword: 'flaky', pos: 3, imp: 400, mult: {}, checks: [{ aio: true }, { aio: false }, { aio: false }] },
      { keyword: 'none', pos: 5, imp: 400, mult: {}, checks: [{ aio: false, ourTitle: 'Completely different title' }, { aio: false, ourTitle: 'Completely different title' }] },
    ];
    const titles = new Map([['https://example.com/none', 'None page | Example'], ['https://example.com/cited one', 'cited one']]);
    const out = analyzeAio(input(specs, { seed: 'facts', titles, B: 50 }));
    const by = new Map(out.facts.map((x) => [x.keyword, x]));
    expect(by.get('cited one')).toMatchObject({ status: 'present', cited: true, checks: 2, aioChecks: 2 });
    expect(by.get('not cited')).toMatchObject({ status: 'present', cited: false, topDomains: ['semrush.com'] });
    expect(by.get('flaky')?.status).toBe('intermittent');
    expect(by.get('none')).toMatchObject({ status: 'absent', titleRewritten: true, ourRank: 3 });
    expect(by.get('cited one')?.titleRewritten).toBe(false);
    expect(by.get('cited one')?.topDomains).toEqual(['semrush.com']);
    const facts = out.findings.filter((x) => x.kind === 'aio_fact');
    expect(facts).toHaveLength(4);
    for (const fct of facts) {
      expect(fct).toMatchObject({ reason: 'fact', causeConfidence: 'EXTRACTED', template: 'aio_fact', metric: 'aio_presence' });
      expect(fct.evidence[0].type).toBe('serp');
    }
    expect(facts.find((x) => x.unit.key === 'not cited')?.slots).toMatchObject({ cited_text: 'doesnt_cite_you', domains: 'semrush.com', k: 2, n: 3 });
    expect(facts.find((x) => x.unit.key === 'none')?.slots.cited_text).toBe('none');
    expect(out.estimates.find((e) => e.estimator === 'did')?.groups.intermittent).toBe(1);
  });

  it('every AIO finding renders through the copy deck with no leftover slots', () => {
    const cases = [
      population(150, { aioShare: 0.4, mult: (w) => (w === 'c' ? 0.7 : 1) }),
      population(30, { aioShare: 0.5, mult: () => 1 }),
      population(150, { aioShare: 0.4, mult: (w) => ({ pre1: 1, pre2: 0.78, b: 0.61, c: 0.475 })[w] }),
      population(150, { aioShare: 0.4, mult: () => 1, checks: 1 }).map((s) => ({ ...s, checks: s.checks.map((c) => ({ ...c, at: '2026-10-06T08:00:00Z' })) })),
    ];
    const templates = new Set<string>();
    for (const [k, specs] of cases.entries()) {
      for (const f of analyzeAio(input(specs, { seed: `render${k}`, B: 100 })).findings) {
        const text = renderSentence(f.template, f.slots);
        templates.add(f.template);
        expect(text, `${f.template} ${JSON.stringify(f.slots)}`).not.toMatch(/[{}]|undefined|NaN|single_check|comparison_not_proof/);
        expect(text.length).toBeGreaterThan(20);
      }
    }
    expect([...templates].sort()).toEqual(['aio_fact', 'aio_not_cited', 'cant_separate', 'not_enough_data']);
  });

  it('is deterministic and returns nothing without checks', () => {
    const specs = population(60, { aioShare: 0.4, mult: (w) => (w === 'c' ? 0.7 : 1) });
    expect(analyzeAio(input(specs, { seed: 'det', B: 100 }))).toEqual(analyzeAio(input(specs, { seed: 'det', B: 100 })));
    expect(analyzeAio({ ...input(specs, { seed: 'det' }), serp: [] })).toEqual({ facts: [], estimates: [], findings: [] });
  });
});

describe('statuses and titles', () => {
  const o = (aio: boolean, cites = false): SerpObservation => obs({ keyword: 'k', pos: 1, imp: 1, mult: {}, checks: [] }, 0, { aio, cited: cites });
  it('classifies present, absent, intermittent and single checks', () => {
    expect(statusOf([o(true), o(false)], 'example.com').status).toBe('present');
    expect(statusOf([o(false), o(false)], 'example.com').status).toBe('absent');
    expect(statusOf([o(true), o(false), o(false)], 'example.com').status).toBe('intermittent');
    expect(statusOf([o(true)], 'example.com').status).toBe('single_present');
    expect(statusOf([o(false)], 'example.com').status).toBe('single_absent');
    expect(statusOf([o(true, true), o(true, false)], 'example.com').cited).toBe(true);
    expect(statusOf([o(true, true), o(true, false), o(true, false)], 'example.com').cited).toBe(false);
  });
  it('ignores case, spacing, a site-name suffix and truncation when comparing titles', () => {
    expect(titleRewritten('How To Fix  a Leak | Pipewell', 'how to fix a leak')).toBe(false);
    expect(titleRewritten('How to fix a leak - Pipewell', 'How to fix a leak | Pipewell Plumbing')).toBe(false);
    expect(titleRewritten('How to fix a...', 'How to fix a leak fast')).toBe(false);
    expect(titleRewritten('Leak repair guide', 'How to fix a leak')).toBe(true);
    const enDash = String.fromCharCode(0x2013);
    expect(titleRewritten(`How to fix a leak ${enDash} Pipewell`, 'How to fix a leak')).toBe(false);
    expect(titleRewritten(`How to fix a leak${String.fromCharCode(0x2026)}`, 'How to fix a leak today')).toBe(false);
  });
});
