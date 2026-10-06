// Click waterfall: unit bars, edge cases, remainder, aggregation and bootstrap (spec 5.5; tests 1 to 11 and 47). Owner: WP-E.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/time.js';
import type { Bars, Cell, CtrCurve, PageDay, Segment, WindowStats } from '../../src/core/types.js';
import { fitCurve } from '../../src/analyze/ctr-curve.js';
import {
  BAR_KEYS, barsFromTotals, barsTotal, bootstrapScopes, bootstrapSize, buildUnits, decomposeUnits, scopeDecomposition, unitBars,
  type ScopeSpec, type WaterfallInput,
} from '../../src/analyze/waterfall.js';
import { testRng } from '../helpers/index.js';

/** A hand-made curve f(p) = a * p^-b for every segment (strongly convex in p). */
function powerCurve(a = 0.3, b = 1.2): CtrCurve {
  const f = (p: number): number => Math.max(1e-5, a * Math.max(1, p) ** -b);
  const curve: CtrCurve = {
    f: (p) => f(p),
    fMix: (p) => f(p),
    unstable: [],
    m: 100,
    bins: [],
    fitWindow: ['2026-01-01', '2026-06-30'],
    redraw: () => curve,
  };
  return curve;
}

const ws = (I: number, C: number, F: number): WindowStats => ({ I, C, F, pbar: I > 0 ? 5 : null });
const sum = (b: Bars): number => barsTotal(b);

const W = { baseline: ['2026-08-09', '2026-09-05'] as [string, string], current: ['2026-09-06', '2026-10-03'] as [string, string] };
const baseDays = Array.from({ length: 28 }, (_, k) => addDays(W.baseline[0], k));
const curDays = Array.from({ length: 28 }, (_, k) => addDays(W.current[0], k));

function input(cells: Cell[], pageDaily: PageDay[], over: Partial<WaterfallInput> = {}): WaterfallInput {
  return {
    windows: W,
    cells,
    pageDaily,
    deviceDaily: [...baseDays, ...curDays].flatMap((date) => [
      { date, dv: 'desktop' as const, i: 70 },
      { date, dv: 'mobile' as const, i: 30 },
    ]),
    siteImpressions: { base: 1000, cur: 1000 },
    curve: powerCurve(),
    isBrand: (q) => q.includes('brand'),
    templates: new Map(),
    flattening: new Set(),
    ...over,
  };
}

describe('unit bars (5.5.1)', () => {
  it('1. 1,000 random units: the bars sum to the click change to 1e-9', () => {
    const rng = testRng('waterfall:invariant');
    for (let n = 0; n < 1000; n++) {
      const zeroB = rng() < 0.1;
      const zeroC = !zeroB && rng() < 0.1;
      const Ib = zeroB ? 0 : Math.floor(rng() * 5000);
      const Ic = zeroC ? 0 : Math.floor(rng() * 5000);
      const Cb = Math.floor(rng() * Ib * 0.4);
      const Cc = Math.floor(rng() * Ic * 0.4);
      const edges = { crossingK: rng() < 0.3 ? 0.5 + rng() : null, flatten: rng() < 0.2 };
      const bars = barsFromTotals(Ib, Cb, Ib * rng() * 0.3, Ic, Cc, Ic * rng() * 0.3, edges);
      expect(Math.abs(sum(bars) - (Cc - Cb))).toBeLessThan(1e-9);
      for (const k of BAR_KEYS) expect(Number.isFinite(bars[k])).toBe(true);
    }
  });

  it('2. time reversal negates every bar', () => {
    const rng = testRng('waterfall:reverse');
    for (let n = 0; n < 200; n++) {
      const b = ws(1 + Math.floor(rng() * 900), 0, rng() * 0.2);
      b.C = Math.floor(rng() * b.I * 0.3);
      const c = ws(1 + Math.floor(rng() * 900), 0, rng() * 0.2);
      c.C = Math.floor(rng() * c.I * 0.3);
      const fwd = unitBars(b, c);
      const back = unitBars(c, b);
      for (const k of BAR_KEYS) expect(back[k]).toBeCloseTo(-fwd[k], 9);
    }
    // Churn reverses too: appeared one way is disappeared the other way.
    const fwd = unitBars(ws(0, 0, 0), ws(100, 7, 0.05));
    const back = unitBars(ws(100, 7, 0.05), ws(0, 0, 0));
    expect(fwd.appeared + fwd.disappeared).toBe(-(back.appeared + back.disappeared));
  });

  it('3. I 100 -> 200 with CTR 0.10 -> 0.05 and F constant: demand +7.5, samePos -7.5', () => {
    const bars = unitBars(ws(100, 10, 0.08), ws(200, 10, 0.08));
    expect(bars.demand).toBeCloseTo(7.5, 12);
    expect(bars.samePos).toBeCloseTo(-7.5, 12);
    expect(bars.rank).toBeCloseTo(0, 12);
    // Backwards it is the exact negation (the draft's ordered formula gave +10/-10 and -5/+5).
    const back = unitBars(ws(200, 10, 0.08), ws(100, 10, 0.08));
    expect(back.demand).toBeCloseTo(-7.5, 12);
    expect(back.samePos).toBeCloseTo(7.5, 12);
  });

  it('4. pure demand: rank and samePos are zero', () => {
    const bars = unitBars(ws(400, 40, 0.1), ws(300, 30, 0.1));
    expect(bars.rank).toBe(0);
    expect(bars.samePos).toBeCloseTo(0, 12);
    expect(bars.demand).toBeCloseTo(-10, 12);
  });

  it('5. a click rate that moves exactly along f is all rank', () => {
    const bars = unitBars(ws(500, 50, 0.1), ws(500, 30, 0.06));
    expect(bars.demand).toBe(0);
    expect(bars.samePos).toBeCloseTo(0, 12);
    expect(bars.rank).toBeCloseTo(-20, 12);
  });

  it('6. a click-rate shock at the same position is all samePos', () => {
    const bars = unitBars(ws(500, 50, 0.1), ws(500, 35, 0.1));
    expect(bars.demand).toBe(0);
    expect(bars.rank).toBe(0);
    expect(bars.samePos).toBeCloseTo(-15, 12);
  });

  it('7. I_b = 0 gives only appeared, and C_b = 0 gives no NaN', () => {
    const appeared = unitBars(ws(0, 0, 0), ws(120, 9, 0.07));
    expect(appeared).toEqual({ demand: 0, visibility: 0, rank: 0, samePos: 0, appeared: 9, disappeared: -0, aioCitation: 0 });
    const gone = unitBars(ws(120, 9, 0.07), ws(0, 0, 0));
    expect(gone.disappeared).toBe(-9);
    expect(sum(gone)).toBe(-9);
    const noClicks = unitBars(ws(80, 0, 0.05), ws(90, 3, 0.05));
    for (const k of BAR_KEYS) expect(Number.isNaN(noClicks[k])).toBe(false);
    expect(sum(noClicks)).toBeCloseTo(3, 12);
  });
});

describe('edge cases and units (5.5.2, 5.5.3)', () => {
  it('8. Jensen: day-cell F gives samePos near 0 where the window-mean position would not', () => {
    const curve = powerCurve();
    const f = (p: number): number => curve.f(p, 'desktop|nonbrand');
    const cells: Cell[] = [];
    for (const date of baseDays) cells.push({ date, q: 'how to fix a tap', p: 'https://x.example/a', dv: 'desktop', i: 1000, c: 1000 * f(6), ps: 6000 });
    curDays.forEach((date, k) => {
      const p = k % 2 === 0 ? 3 : 9;
      cells.push({ date, q: 'how to fix a tap', p: 'https://x.example/a', dv: 'desktop', i: 1000, c: 1000 * f(p), ps: 1000 * p });
    });
    const model = buildUnits(input(cells, []));
    const [u] = decomposeUnits(model, curve).filter((x) => x.key.query !== null);
    expect(u.bars.samePos).toBeCloseTo(0, 6);
    expect(u.cur.pbar).toBeCloseTo(6, 12);
    // What a window-mean approach would have said: CTR_c - f(6) is far from zero.
    const naive = u.cur.C / u.cur.I - f(6);
    expect(Math.abs(naive)).toBeGreaterThan(0.005);
  });

  it('9. page-1 crossing with stable units at K = 1: demand 0, the impression change goes to visibility', () => {
    const cells: Cell[] = [];
    for (let s = 0; s < 12; s++) {
      for (const date of [...baseDays, ...curDays]) cells.push({ date, q: `stable ${s}`, p: `https://x.example/blog/p${s}`, dv: 'desktop', i: 50, c: 4, ps: 50 * 4 });
    }
    for (const date of baseDays) cells.push({ date, q: 'mover', p: 'https://x.example/blog/m', dv: 'desktop', i: 40, c: 2, ps: 40 * 8 });
    for (const date of curDays) cells.push({ date, q: 'mover', p: 'https://x.example/blog/m', dv: 'desktop', i: 20, c: 0.5, ps: 20 * 14 });
    const templates = new Map([...Array.from({ length: 12 }, (_, s) => [`https://x.example/blog/p${s}`, '/blog/*'] as [string, string]), ['https://x.example/blog/m', '/blog/*']]);
    const model = buildUnits(input(cells, [], { templates }));
    const units = decomposeUnits(model, powerCurve());
    const mover = units.find((u) => u.key.query === 'mover');
    expect(mover?.flags).toContain('page1_crossing');
    expect(mover?.flags).not.toContain('k_fallback');
    expect(mover?.bars.demand).toBeCloseTo(0, 12);
    expect(mover?.bars.visibility).toBeLessThan(0);
    expect(sum(mover!.bars)).toBeCloseTo(mover!.cur.C - mover!.base.C, 9);
    expect(model.demandK).toBeCloseTo(1, 12);
  });

  it('9b. too few stable units fall back to site impressions and flag k_fallback', () => {
    const cells: Cell[] = [];
    for (const date of baseDays) cells.push({ date, q: 'mover', p: 'https://x.example/m', dv: 'mobile', i: 40, c: 2, ps: 40 * 8 });
    for (const date of curDays) cells.push({ date, q: 'mover', p: 'https://x.example/m', dv: 'mobile', i: 20, c: 0.5, ps: 20 * 14 });
    const model = buildUnits(input(cells, [], { siteImpressions: { base: 1000, cur: 800 } }));
    const mover = decomposeUnits(model, powerCurve()).find((u) => u.key.query === 'mover');
    expect(mover?.flags).toEqual(expect.arrayContaining(['page1_crossing', 'k_fallback']));
    // demand = I_b (K - 1) CTR-bar with K = 0.8
    const ctrBar = (2 / 40 + 0.5 / 20) / 2;
    expect(mover?.bars.demand).toBeCloseTo(40 * 28 * (0.8 - 1) * ctrBar, 9);
  });

  it('10. AIO citation flattening: a cited query moving 6 -> 1 with lower clicks gets one aioCitation bar', () => {
    const cells: Cell[] = [];
    for (const date of baseDays) cells.push({ date, q: 'how to bleed a radiator', p: 'https://x.example/r', dv: 'desktop', i: 100, c: 6, ps: 600 });
    for (const date of curDays) cells.push({ date, q: 'how to bleed a radiator', p: 'https://x.example/r', dv: 'desktop', i: 100, c: 4, ps: 100 });
    const model = buildUnits(input(cells, [], { flattening: new Set(['how to bleed a radiator|desktop']) }));
    const u = decomposeUnits(model, powerCurve()).find((x) => x.key.query !== null)!;
    expect(u.flags).toContain('aio_flattening');
    expect(u.bars.rank).toBe(0);
    expect(u.bars.samePos).toBe(0);
    expect(u.bars.aioCitation).toBeCloseTo(-56, 9);
    expect(sum(u.bars)).toBeCloseTo(-56, 9);
  });

  it('11. remainder: 252 page clicks with 48 named gives 204 hidden; page bars sum to site bars; clamping is flagged', () => {
    const page = 'https://x.example/';
    const cells: Cell[] = [];
    const pageDaily: PageDay[] = [];
    // Baseline: 252 page clicks, 48 of them on named searches (spread evenly over 28 days: 9 and 1.714...).
    for (const date of baseDays) {
      cells.push({ date, q: 'brand name', p: page, dv: 'desktop', i: 20, c: 48 / 28, ps: 20 * 1.2 });
      pageDaily.push({ date, p: page, i: 400, c: 9, ps: 400 * 6 });
    }
    for (const date of curDays) {
      cells.push({ date, q: 'brand name', p: page, dv: 'desktop', i: 22, c: 2, ps: 22 * 1.1 });
      pageDaily.push({ date, p: page, i: 380, c: 8, ps: 380 * 6.5 });
    }
    // A second page whose named cells exceed its page total on one day (GSC rounding): clamped.
    cells.push({ date: curDays[3], q: 'odd search', p: 'https://x.example/odd', dv: 'mobile', i: 10, c: 2, ps: 30 });
    pageDaily.push({ date: curDays[3], p: 'https://x.example/odd', i: 6, c: 1, ps: 20 });
    const model = buildUnits(input(cells, pageDaily));
    const units = decomposeUnits(model, powerCurve());
    const rem = units.find((u) => u.key.page === page && u.key.query === null)!;
    expect(rem.flags).toContain('remainder');
    expect(rem.base.C).toBeCloseTo(252 - 48, 9);
    const odd = units.find((u) => u.key.page === 'https://x.example/odd' && u.key.query === null)!;
    expect(odd.flags).toContain('remainder_clamped');

    // 47. Sum of page bars equals site bars, and every scope keeps the invariant.
    const all = units.map((_, k) => k);
    const site = scopeDecomposition({ unit: { level: 'site', key: 'site', label: 'Whole site' }, members: all }, units, null);
    const pages = [...new Set(units.map((u) => u.key.page))].map((p) =>
      scopeDecomposition({ unit: { level: 'page', key: p, label: p }, members: all.filter((k) => units[k].key.page === p) }, units, null),
    );
    for (const k of BAR_KEYS) expect(pages.reduce((s, d) => s + d.bars[k], 0)).toBeCloseTo(site.bars[k], 9);
    for (const d of [site, ...pages]) expect(barsTotal(d.bars)).toBeCloseTo(d.deltaClicks, 9);
    // The home page's waterfall covers all of its clicks: named plus hidden.
    const home = pages.find((d) => d.unit.key === page)!;
    expect(home.baseClicks).toBeCloseTo(252, 9);
    expect(home.namedClickShare).toBeCloseTo((48 + 56) / (252 + 224), 9);
  });

  it('a sparse remainder day borrows the page named F and is flagged', () => {
    const page = 'https://x.example/s';
    const cells: Cell[] = [{ date: baseDays[0], q: 'q', p: page, dv: 'desktop', i: 50, c: 5, ps: 150 }];
    const pageDaily: PageDay[] = [{ date: baseDays[0], p: page, i: 53, c: 5, ps: 150 + 3 * 40 }];
    const units = decomposeUnits(buildUnits(input(cells, pageDaily)), powerCurve());
    const rem = units.find((u) => u.key.query === null)!;
    expect(rem.flags).toContain('remainder_sparse');
    expect(rem.base.F).toBeCloseTo(powerCurve().f(3, 'desktop|nonbrand'), 12);
  });
});

describe('scopes and bootstrap (5.5.4, 5.5.5)', () => {
  function syntheticSite(): { input: WaterfallInput; curve: CtrCurve } {
    const rng = testRng('waterfall:site');
    const cells: Cell[] = [];
    const pageDaily: PageDay[] = [];
    const templates = new Map<string, string>();
    for (let pg = 0; pg < 40; pg++) {
      const url = `https://x.example/blog/post-${pg}`;
      templates.set(url, '/blog/*');
      for (const [days, mult] of [[baseDays, 1], [curDays, pg < 10 ? 0.6 : 1]] as const) {
        for (const date of days) {
          let ni = 0;
          let nc = 0;
          let nps = 0;
          for (let q = 0; q < 3; q++) {
            const i = 20 + Math.floor(rng() * 20);
            const p = 3 + q * 2 + rng();
            const c = Math.round(i * 0.3 * p ** -1.2 * mult * (0.8 + 0.4 * rng()));
            cells.push({ date, q: `post ${pg} query ${q}`, p: url, dv: q === 2 ? 'mobile' : 'desktop', i, c, ps: i * p });
            ni += i;
            nc += c;
            nps += i * p;
          }
          pageDaily.push({ date, p: url, i: ni + 15, c: nc + 1, ps: nps + 15 * 8 });
        }
      }
    }
    const fitCells = cells.map((c) => ({ p: c.ps / c.i, c: c.c, i: c.i, seg: (c.dv === 'desktop' ? 'desktop|nonbrand' : 'mobile|nonbrand') as Segment }));
    const curve = fitCurve(fitCells, { fitWindow: ['2026-08-09', '2026-10-03'], holdoutFrom: '2026-10-03' });
    return { input: input(cells, pageDaily, { templates, curve, isBrand: () => false }), curve };
  }

  it('bootstrap CIs bracket the point estimates, are deterministic, and the invariant holds per scope', () => {
    const { input: inp, curve } = syntheticSite();
    const model = buildUnits(inp);
    const units = decomposeUnits(model, curve);
    const all = units.map((_, k) => k);
    const scopes: ScopeSpec[] = [
      { unit: { level: 'site', key: 'site', label: 'Whole site' }, members: all },
      { unit: { level: 'template', key: '/blog/*', label: '/blog/*' }, members: all.filter((k) => units[k].template === '/blog/*') },
      { unit: { level: 'page', key: 'https://x.example/blog/post-0', label: '/blog/post-0' }, members: all.filter((k) => units[k].key.page === 'https://x.example/blog/post-0') },
    ];
    const run = (): ReturnType<typeof bootstrapScopes> =>
      bootstrapScopes(model, units, scopes, { B: 200, curve, rng: testRng('boot'), scopeRng: (s) => testRng(`boot:${s.unit.key}`), phi: 1.3 });
    const boots = run();
    expect(run()).toEqual(boots);
    scopes.forEach((spec, s) => {
      const d = scopeDecomposition(spec, units, boots[s]);
      expect(barsTotal(d.bars)).toBeCloseTo(d.deltaClicks, 9);
      const [lo, hi] = d.ci95?.total as [number, number];
      expect(lo).toBeLessThanOrEqual(d.deltaClicks);
      expect(hi).toBeGreaterThanOrEqual(d.deltaClicks);
      expect(d.pTotal).toBeGreaterThan(0);
      expect(d.pTotal).toBeLessThanOrEqual(1);
    });
    // 10 of 40 pages lost 40% of their named clicks at the same positions: a clear samePos loss.
    const site = scopeDecomposition(scopes[0], units, boots[0]);
    expect(site.bars.samePos).toBeLessThan(0);
    expect(boots[0].groupCi.samePos[1]).toBeLessThan(0);
    expect(site.pTotal).toBeLessThan(0.05);
  });

  it('B is reduced so cells x B stays within 3e8, never below 200 unless configured lower', () => {
    expect(bootstrapSize(1000, 50_000)).toBe(1000);
    expect(bootstrapSize(1000, 1_000_000)).toBe(300);
    expect(bootstrapSize(1000, 10_000_000)).toBe(200);
    expect(bootstrapSize(150, 10_000_000)).toBe(150);
  });
});
