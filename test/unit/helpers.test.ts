// The shared test helpers are a contract for every package's tests, so they get tests too.
import { describe, expect, it } from 'vitest';
import {
  dowMeans, fakeFetch, manualClock, memoryStore, negBinSeries, poissonSeries, synthCells, testRng, withStep,
} from '../helpers/index.js';
import { weekday } from '../../src/core/time.js';

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: number[]): number => {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

describe('fakeFetch', () => {
  it('matches routes by method and URL (exact, prefix with *, RegExp) and records every call', async () => {
    const ff = fakeFetch([
      { method: 'POST', url: 'https://a.test/query', reply: { body: { rows: [] } } },
      { url: 'https://a.test/files/*', reply: (req, n) => ({ body: `${req.url} #${n}` }) },
      { url: /\/incidents\.json$/, reply: { status: 503 }, times: 1 },
      { url: /\/incidents\.json$/, reply: { body: '[]' } },
    ]);
    expect(await (await ff.fetch('https://a.test/query', { method: 'POST', body: '{"x":1}' })).json()).toEqual({ rows: [] });
    expect(await (await ff.fetch('https://a.test/files/a')).text()).toBe('https://a.test/files/a #0');
    expect(await (await ff.fetch('https://a.test/files/b')).text()).toBe('https://a.test/files/b #1');
    expect((await ff.fetch('https://s.test/incidents.json')).status).toBe(503);
    expect((await ff.fetch('https://s.test/incidents.json')).status).toBe(200);
    expect((await ff.fetch('https://a.test/query')).status).toBe(599); // GET does not match the POST route
    expect(ff.calls).toHaveLength(6);
    expect(ff.calls[0].json()).toEqual({ x: 1 });
    expect(ff.callsTo('https://a.test/files/*')).toHaveLength(2);
    expect(ff.unmatched().map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://a.test/query']);
  });

  it('simulates failures the way Node fetch reports them', async () => {
    const ff = fakeFetch([
      { url: 'https://a.test/dns', reply: { error: 'dns' } },
      { url: 'https://a.test/slow', reply: { delayMs: 1000, body: 'late' } },
    ]);
    await expect(ff.fetch('https://a.test/dns')).rejects.toMatchObject({ name: 'TypeError', cause: { code: 'ENOTFOUND' } });
    const ctl = new AbortController();
    const p = ff.fetch('https://a.test/slow', { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('builds real Responses, with null bodies where HTTP requires them', async () => {
    const ff = fakeFetch([{ url: 'https://a.test/x', reply: { status: 304, headers: { etag: '"1"' }, body: 'ignored' } }]);
    const res = await ff.fetch('https://a.test/x');
    expect(res.status).toBe(304);
    expect(res.url).toBe('https://a.test/x');
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.text()).toBe('');
  });
});

describe('synth', () => {
  it('is deterministic per key', () => {
    expect(poissonSeries(testRng('a'), [3, 3, 3, 3])).toEqual(poissonSeries(testRng('a'), [3, 3, 3, 3]));
    expect(poissonSeries(testRng('a'), Array(50).fill(3))).not.toEqual(poissonSeries(testRng('b'), Array(50).fill(3)));
  });

  it('Poisson draws have mean and variance near lambda, small and large', () => {
    for (const lambda of [0.5, 3, 80]) {
      const xs = poissonSeries(testRng(`p${lambda}`), Array(20_000).fill(lambda));
      expect(Math.abs(mean(xs) - lambda) / lambda).toBeLessThan(0.05);
      expect(Math.abs(variance(xs) - lambda) / lambda).toBeLessThan(0.1);
      expect(xs.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });

  it('negative binomial has variance near phi * mean', () => {
    const xs = negBinSeries(testRng('nb'), Array(20_000).fill(10), 3);
    expect(Math.abs(mean(xs) - 10) / 10).toBeLessThan(0.05);
    expect(Math.abs(variance(xs) / mean(xs) - 3)).toBeLessThan(0.3);
    expect(negBinSeries(testRng('nb1'), [5, 5], 1)).toEqual(poissonSeries(testRng('nb1'), [5, 5]));
  });

  it('dowMeans follows weekdays from the start date and withStep scales the tail', () => {
    const m = dowMeans('2026-10-05', 14, 10, [2, 1, 1, 1, 1, 1, 1]); // a Monday
    expect(weekday('2026-10-05')).toBe(0);
    expect(m[0]).toBe(20);
    expect(m[7]).toBe(20);
    expect(m[1]).toBe(10);
    expect(mean(dowMeans('2026-10-05', 7, 1))).toBeCloseTo(1, 2);
    expect(withStep([1, 1, 1, 1], 2, 0.6)).toEqual([1, 1, 0.6, 0.6]);
  });

  it('synthCells yields Search Console shaped cells', () => {
    const cells = synthCells(testRng('cells'), '2026-09-01', 28, [
      { page: 'https://example.com/a', query: 'alpha', device: 'desktop', impressionsPerDay: 50, position: 4, ctr: 0.1 },
      { page: 'https://example.com/b', query: 'beta', device: 'mobile', impressionsPerDay: 0.2, position: 9, ctr: 0.02 },
    ]);
    const alpha = cells.filter((c) => c.q === 'alpha');
    expect(alpha).toHaveLength(28);
    expect(alpha[0].date).toBe('2026-09-01');
    expect(alpha.every((c) => c.c <= c.i && c.ps / c.i >= 1)).toBe(true);
    const ctr = alpha.reduce((s, c) => s + c.c, 0) / alpha.reduce((s, c) => s + c.i, 0);
    expect(ctr).toBeGreaterThan(0.07);
    expect(ctr).toBeLessThan(0.13);
    expect(cells.filter((c) => c.q === 'beta').length).toBeLessThan(28); // zero-impression days are skipped
    expect(cells.every((c) => c.i > 0)).toBe(true);
  });
});

describe('memoryStore and manualClock', () => {
  it('memoryStore exposes raw files and keeps DataStore rules', async () => {
    const store = memoryStore();
    await store.writeFileAtomic('config.json', '{}');
    expect([...store.files.keys()]).toEqual(['config.json']);
    expect(store.root).toBe('/memory/searchtrace-data');
    await expect(store.writeFileAtomic('../x', '')).rejects.toThrow();
  });

  it('manualClock moves only when told to', () => {
    const c = manualClock('2026-10-06T00:00:00Z');
    c.advance(90_000);
    expect(c.now().toISOString()).toBe('2026-10-06T00:01:30.000Z');
    c.set('2026-10-07T00:00:00Z');
    expect(c.now().toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });
});
