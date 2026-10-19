// WP-D: DataForSEO building blocks. Spec tests 61 (budget formula), 62 (normalise), 63 (design),
// plus the location table and the client's status mapping. No network: fakeFetch only.
import { describe, expect, it } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { hash32 } from '../../src/core/ids.js';
import { createSecretRegistry } from '../../src/core/secrets.js';
import type { SerpCandidate } from '../../src/core/types.js';
import { affordableChecks, availableBudget, budgetFor } from '../../src/sources/dataforseo/budget.js';
import { createDfsClient, dfsDatetime, parseDfsDatetime, PATHS } from '../../src/sources/dataforseo/client.js';
import { locationForCountry, locationTable, resolveLocation } from '../../src/sources/dataforseo/locations.js';
import { collectRefs, normalizeSerp, stripWww } from '../../src/sources/dataforseo/normalize.js';
import { designSample, eligibleCandidates, expectedDesignCost, hasSearchOperator, PI_MIN, scaledInclusion, weekdayFor } from '../../src/sources/dataforseo/sample.js';
import { fakeFetch } from '../helpers/index.js';

// ---------- locations ----------

describe('country locations', () => {
  it('maps the common Search Console countries to DataForSEO codes', () => {
    expect(locationForCountry('gbr')).toEqual({ iso2: 'GB', locationCode: 2826, languageCode: 'en' });
    expect(locationForCountry('usa')?.locationCode).toBe(2840);
    expect(locationForCountry('ind')?.locationCode).toBe(2356);
    expect(locationForCountry('aus')?.locationCode).toBe(2036);
    expect(locationForCountry('can')?.locationCode).toBe(2124);
    expect(locationForCountry('deu')).toEqual({ iso2: 'DE', locationCode: 2276, languageCode: 'de' });
    expect(locationForCountry('GBR')?.locationCode).toBe(2826);
  });

  it('follows the 2000 + ISO numeric rule for every entry it knows the numeric code of', () => {
    const isoNumeric: Record<string, number> = {
      gbr: 826, usa: 840, ind: 356, aus: 36, can: 124, irl: 372, nzl: 554, deu: 276, fra: 250, esp: 724, ita: 380, nld: 528,
      bra: 76, mex: 484, jpn: 392, zaf: 710, sgp: 702, swe: 752, pol: 616, prt: 620,
    };
    for (const [cc, n] of Object.entries(isoNumeric)) expect(locationForCountry(cc)?.locationCode, cc).toBe(2000 + n);
    for (const [cc, loc] of locationTable()) {
      expect(cc).toMatch(/^[a-z]{3}$/);
      expect(loc.locationCode).toBeGreaterThan(2000);
      expect(loc.locationCode).toBeLessThan(2900);
    }
  });

  it('returns null for countries it does not know, and config wins', () => {
    expect(locationForCountry('xkx')).toBeNull();
    expect(locationForCountry('')).toBeNull();
    expect(resolveLocation({}, 'xkx')).toBeNull();
    expect(resolveLocation({}, 'gbr')).toEqual({ locationCode: 2826, languageCode: 'en', source: 'country', country: 'gbr' });
    expect(resolveLocation({ locationCode: 2276 }, 'gbr')).toMatchObject({ locationCode: 2276, languageCode: 'de', source: 'config' });
    expect(resolveLocation({ locationCode: 2999, languageCode: 'xx' }, null)).toMatchObject({ locationCode: 2999, languageCode: 'xx' });
    expect(resolveLocation({ languageCode: 'cy' }, 'gbr')).toMatchObject({ locationCode: 2826, languageCode: 'cy' });
  });
});

// ---------- client ----------

describe('DataForSEO client', () => {
  const ok = { status_code: 20000, status_message: 'Ok.', cost: 0, tasks: [{ id: 't1', status_code: 20000, result: [{ money: { balance: 24.95 } }] }] };

  it('sends basic auth and registers the credentials as secrets', async () => {
    const ff = fakeFetch([{ url: `https://api.dataforseo.com${PATHS.userData}`, reply: { body: ok } }]);
    const secrets = createSecretRegistry({ ci: false });
    const c = createDfsClient({ fetch: ff.fetch, login: 'login@example.com', password: 'a-password-for-tests', secrets });
    const env = await c.get(PATHS.userData);
    expect(env.tasks?.[0].id).toBe('t1');
    const auth = ff.calls[0].headers.authorization;
    expect(auth).toBe(`Basic ${Buffer.from('login@example.com:a-password-for-tests').toString('base64')}`);
    expect(secrets.redact(`x ${auth} a-password-for-tests`)).not.toContain('a-password-for-tests');
  });

  it('maps 401 to auth with the fix line and 402 to budget', async () => {
    const ff = fakeFetch([
      { url: /user_data/, reply: { status: 401, body: { status_code: 40100, status_message: 'Not authorized', tasks: null } }, times: 1 },
      { url: /user_data/, reply: { status: 402, body: { status_code: 40200, status_message: 'Payment Required.', tasks: null } } },
    ]);
    const c = createDfsClient({ fetch: ff.fetch, login: 'l', password: 'p-1234567890', secrets: createSecretRegistry({ ci: false }) });
    const e1 = await c.get(PATHS.userData).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(StError);
    expect((e1 as StError).code).toBe('auth');
    expect((e1 as StError).fix).toMatch(/DATAFORSEO_LOGIN/);
    const e2 = await c.get(PATHS.userData).catch((e: unknown) => e);
    expect((e2 as StError).code).toBe('budget');
  });

  it('only calls a real lack of money a low balance, and only a refused login an auth error', async () => {
    const answer = (status: number, code: number, message: string) => ({ url: /user_data/, reply: { status, body: { status_code: code, status_message: message, tasks: null } }, times: 1 });
    const ff = fakeFetch([
      answer(200, 40202, 'The rate-limit per minute has been exceeded.'),
      answer(200, 40210, 'Insufficient Funds.'),
      answer(200, 40203, 'Cost limit exceeded.'),
      answer(200, 40207, 'Your IP is not whitelisted.'),
      answer(200, 40103, 'Task execution failed.'),
      answer(200, 40104, 'Please verify your account.'),
      { method: 'POST', url: /task_post/, reply: { status: 429, body: { status_code: 40202, status_message: 'The rate-limit per minute has been exceeded.', tasks: null } } },
    ]);
    const c = createDfsClient({ fetch: ff.fetch, login: 'l', password: 'p-1234567890', secrets: createSecretRegistry({ ci: false }) });
    const next = async () => (await c.get(PATHS.userData).catch((e: unknown) => e)) as StError & { dfsCode?: number };
    const rate = await next();
    expect([rate.code, rate.dfsCode]).toEqual(['http', 40202]);
    expect(rate.message).toContain('rate-limit');
    expect((await next()).code).toBe('budget');
    const limit = await next();
    expect(limit.code).toBe('budget');
    expect(limit.fix).toContain('spending limit');
    const ip = await next();
    expect([ip.code, ip.dfsCode]).toEqual(['http', 40207]);
    expect(ip.fix).toContain('Whitelist');
    expect((await next()).code).toBe('http');
    const verify = await next();
    expect(verify.code).toBe('auth');
    expect(verify.fix).toContain('Verify your account');
    // A 429 carrying 40202 on task_post keeps DataForSEO's code, so the intents are failed (sent again later), not 'budget'.
    const throttled = (await c.post(PATHS.taskPost, [], { idempotent: false }).catch((e: unknown) => e)) as StError & { dfsCode?: number };
    expect([throttled.code, throttled.dfsCode]).toEqual(['http', 40202]);
    expect(throttled.message).toContain('429');
  });

  it('never retries a non-idempotent POST', async () => {
    const ff = fakeFetch([{ method: 'POST', url: /task_post/, reply: { status: 503, body: 'busy' } }]);
    const c = createDfsClient({ fetch: ff.fetch, login: 'l', password: 'p-1234567890', secrets: createSecretRegistry({ ci: false }) });
    const e = await c.post(PATHS.taskPost, [{ keyword: 'x' }], { idempotent: false }).catch((x: unknown) => x);
    expect((e as StError).code).toBe('http');
    expect(ff.calls).toHaveLength(1);
  });

  it('flags a whole-request refusal with its DataForSEO code', async () => {
    const ff = fakeFetch([{ method: 'POST', url: /task_post/, reply: { body: { status_code: 40501, status_message: 'Invalid Field', tasks: [] } } }]);
    const c = createDfsClient({ fetch: ff.fetch, login: 'l', password: 'p-1234567890', secrets: createSecretRegistry({ ci: false }) });
    const e = (await c.post(PATHS.taskPost, [], { idempotent: false }).catch((x: unknown) => x)) as StError & { dfsCode?: number };
    expect(e.code).toBe('http');
    expect(e.dfsCode).toBe(40501);
  });

  it('formats and parses DataForSEO datetimes', () => {
    expect(dfsDatetime(new Date('2026-10-06T06:17:00.123Z'))).toBe('2026-10-06 06:17:00 +00:00');
    expect(parseDfsDatetime('2026-10-06 06:17:00 +00:00')).toBe('2026-10-06T06:17:00Z');
    expect(parseDfsDatetime('2026-10-06 08:17:00 +02:00')).toBe('2026-10-06T06:17:00Z');
    expect(parseDfsDatetime('2026-10-06T06:17:00Z')).toBe('2026-10-06T06:17:00Z');
    expect(parseDfsDatetime('nope')).toBeNull();
    expect(parseDfsDatetime(null)).toBeNull();
  });
});

// ---------- normalise (test 62) ----------

function serpTask(items: unknown[], o: { device?: string; keyword?: string } = {}): Record<string, unknown> {
  return {
    id: '10061234-aaaa', status_code: 20000, status_message: 'Ok.', cost: 0,
    data: { keyword: o.keyword ?? 'how to fix a leak', device: o.device ?? 'desktop', location_code: 2826, language_code: 'en', tag: 'st1:x:y' },
    result: [{
      keyword: (o.keyword ?? 'how to fix a leak').toUpperCase(), location_code: 2826, language_code: 'en',
      datetime: '2026-10-06 06:20:15 +00:00', item_types: ['ai_overview', 'organic', 'organic'], items,
    }],
  };
}

const ctxN = { intentKey: 'ik1', isoWeek: '2026-W41', design: 'census' as const, pi: 1, siteDomain: 'example.com' };

describe('normalizeSerp (test 62)', () => {
  const aioItem = {
    type: 'ai_overview', rank_group: 1, rank_absolute: 1, asynchronous_ai_overview: true, markdown: '...',
    items: [
      { type: 'ai_overview_element', references: [{ domain: 'www.semrush.com', url: 'https://www.semrush.com/a', title: 'A', source: 'Semrush' }],
        items: [{ type: 'ai_overview_expanded_element', references: [{ domain: 'ahrefs.com', url: 'https://ahrefs.com/b', title: 'B' }] }] },
    ],
    references: [
      { domain: 'www.example.com', url: 'https://www.example.com/fix', title: 'Ours', source: 'Example' },
      { domain: 'www.semrush.com', url: 'https://www.semrush.com/a', title: 'A again' },
    ],
  };
  const organic = [
    { type: 'organic', rank_group: 1, rank_absolute: 2, domain: 'www.semrush.com', url: 'https://www.semrush.com/x', title: 'Semrush' },
    { type: 'people_also_ask', rank_absolute: 3 },
    { type: 'organic', rank_group: 2, rank_absolute: 4, domain: 'www.example.com', url: 'https://www.example.com/fix', title: 'Fix a leak | Example' },
  ];

  it('walks nested references, dedupes by URL and matches www. domains', () => {
    const o = normalizeSerp(serpTask([aioItem, ...organic]), ctxN);
    expect(o.aio).not.toBeNull();
    expect(o.aio?.async).toBe(true);
    expect(o.aio?.refs.map((r) => r.url).sort()).toEqual(['https://ahrefs.com/b', 'https://www.example.com/fix', 'https://www.semrush.com/a']);
    expect(o.aio?.citesUs).toBe(true);
    expect(o.organic.map((x) => x.rankAbsolute)).toEqual([2, 4]);
    expect(o.ours).toEqual({ rankAbsolute: 4, url: 'https://www.example.com/fix', title: 'Fix a leak | Example' });
    expect(o.keyword).toBe('how to fix a leak'); // the posted keyword, not the result's copy
    expect(o.observedAt).toBe('2026-10-06T06:20:15Z');
    expect(o.taskId).toBe('10061234-aaaa');
    expect(o).toMatchObject({ intentKey: 'ik1', isoWeek: '2026-W41', design: 'census', pi: 1, device: 'desktop', locationCode: 2826, languageCode: 'en' });
    expect(o.itemTypes).toEqual(['ai_overview', 'organic']);
  });

  it('gives aio null when there is no AI Overview, and not cited when we are absent', () => {
    const none = normalizeSerp(serpTask(organic), ctxN);
    expect(none.aio).toBeNull();
    const notUs = normalizeSerp(serpTask([{ ...aioItem, references: [] , items: [] }, ...organic]), { ...ctxN, siteDomain: 'other.org' });
    expect(notUs.aio).toEqual({ async: true, citesUs: false, refs: [] });
    expect(notUs.ours).toBeNull();
  });

  it('does not match look-alike domains and counts tablet as mobile', () => {
    const o = normalizeSerp(
      serpTask([{ type: 'ai_overview', references: [{ domain: 'notexample.com', url: 'https://notexample.com/' }] }], { device: 'tablet' }),
      ctxN,
    );
    expect(o.aio?.citesUs).toBe(false);
    expect(o.device).toBe('mobile');
    expect(stripWww('WWW.Example.COM.')).toBe('example.com');
  });

  it('accepts the whole envelope and rejects junk', () => {
    const env = { status_code: 20000, tasks: [serpTask(organic)] };
    expect(normalizeSerp(env, ctxN).organic).toHaveLength(2);
    expect(() => normalizeSerp({ nonsense: true }, ctxN)).toThrow(StError);
    expect(() => normalizeSerp(serpTask(organic, {}) && { id: 'x', result: [{ keyword: 'k' }] }, ctxN)).toThrow(/datetime/);
  });

  it('caps organic at 10 and ignores refs without a URL', () => {
    const many = Array.from({ length: 15 }, (_, k) => ({ type: 'organic', rank_absolute: k + 1, domain: `d${k}.com`, url: `https://d${k}.com/`, title: `T${k}` }));
    expect(normalizeSerp(serpTask(many), ctxN).organic).toHaveLength(10);
    expect(collectRefs({ references: [{ domain: 'a.com' }, null, 'x', { url: 'https://b.com/p' }] })).toEqual([
      { domain: 'b.com', url: 'https://b.com/p', title: null, source: null },
    ]);
  });
});

// ---------- design (test 63) ----------

function candidates(n: number, o: { negative?: number } = {}): SerpCandidate[] {
  return Array.from({ length: n }, (_, k) => ({
    keyword: `query ${String(k).padStart(4, '0')}`,
    device: k % 5 === 0 ? 'mobile' : 'desktop',
    pbar: 1 + (k % 19),
    impressions: 10 + ((k * 37) % 500),
    expectedBaseClicks: ((k * 13) % 97) / 3,
    deltaClicks: k < (o.negative ?? 30) ? -(k + 1) : (k % 7) - 3,
    pages: [`https://example.com/p${k}`],
  }));
}

describe('designSample (test 63)', () => {
  it('runs a census when every eligible search fits the budget', () => {
    const c = candidates(206);
    const d = designSample(c, 0.3, 'p|2026-W41', 0.0012);
    expect(d.mode).toBe('census');
    expect(d.units).toHaveLength(206);
    expect(d.units.every((u) => u.pi === 1 && u.design === 'census')).toBe(true);
    expect(expectedDesignCost(d.units, 0.0012)).toBeLessThanOrEqual(0.3);
  });

  it('leaves out searches with Google search operators (billed at 5x), but keeps quoted phrases', () => {
    const mk = (keyword: string): SerpCandidate => ({ keyword, device: 'desktop', pbar: 3, impressions: 50, expectedBaseClicks: 2, deltaClicks: 0, pages: [] } as unknown as SerpCandidate);
    const kept = eligibleCandidates(['site:example.com', 'seo inurl:blog', '-site:x.com tips', 'intitle:guide seo', 'seo AROUND(3) agency', '"seo agency" london', 'what is a site map', 'website: tips']
      .map(mk)).map((x) => x.keyword);
    expect(kept).toEqual(['"seo agency" london', 'website: tips', 'what is a site map']);
    expect(hasSearchOperator('site:example.com')).toBe(true);
    expect(hasSearchOperator('my site: review')).toBe(false);
  });

  it('filters ineligible candidates: position over 20, under 10 impressions, duplicates', () => {
    const c = candidates(5);
    c[0].pbar = 21;
    c[1].impressions = 9;
    c.push({ ...c[2], impressions: c[2].impressions + 1 });
    expect(eligibleCandidates(c).map((x) => x.keyword)).toEqual(['query 0002', 'query 0003', 'query 0004']);
  });

  it('samples with certainty units and pi in [0.05, 1] when the budget is short', () => {
    const c = candidates(600);
    const budget = 0.2; // 166 checks for 600 searches
    const d = designSample(c, budget, 'p|2026-W41', 0.0012);
    expect(d.mode).toBe('sample');
    const cert = d.units.filter((u) => u.design === 'certainty');
    const losers = [...c].sort((a, b) => a.deltaClicks - b.deltaClicks).slice(0, 20).map((x) => x.keyword);
    const top = [...c].sort((a, b) => b.expectedBaseClicks - a.expectedBaseClicks || (a.keyword < b.keyword ? -1 : 1)).slice(0, 20).map((x) => x.keyword);
    for (const k of [...losers, ...top]) expect(cert.some((u) => u.keyword === k), k).toBe(true);
    for (const u of d.units) {
      expect(u.pi).toBeGreaterThanOrEqual(PI_MIN - 1e-12);
      expect(u.pi).toBeLessThanOrEqual(1);
    }
    // Expected spend of the whole design (certainty + sum of pi over the population) equals the budget.
    const certKeys = new Set(cert.map((u) => `${u.keyword}|${u.device}`));
    const rest = eligibleCandidates(c).filter((x) => !certKeys.has(`${x.keyword}|${x.device}`));
    const pis = scaledInclusion(rest.map((x) => Math.max(x.expectedBaseClicks, 1e-3)), (budget - certKeys.size * 0.0012) / 0.0012);
    expect(certKeys.size * 0.0012 + pis.reduce((s, p) => s + p, 0) * 0.0012).toBeCloseTo(budget, 6);
    expect(pis.every((p) => p >= PI_MIN - 1e-12 && p <= 1)).toBe(true);
  });

  it('is deterministic per week and changes with the week', () => {
    const c = candidates(600);
    const a = designSample(c, 0.2, 'p|2026-W41', 0.0012);
    const b = designSample([...c].reverse(), 0.2, 'p|2026-W41', 0.0012);
    expect(b).toEqual(a);
    const next = designSample(c, 0.2, 'p|2026-W42', 0.0012);
    expect(next.units.map((u) => u.keyword)).not.toEqual(a.units.map((u) => u.keyword));
  });

  it('spreads units over weekdays by hash32(keyword) % 7', () => {
    const d = designSample(candidates(206), 1, 'p|2026-W41', 0.0012);
    for (const u of d.units) expect(u.weekday).toBe(hash32(u.keyword) % 7);
    expect(new Set(d.units.map((u) => u.weekday)).size).toBe(7);
    expect(weekdayFor('seo engico')).toBe(hash32('seo engico') % 7);
  });

  it('keeps certainty units within a tiny budget and handles empty input', () => {
    expect(designSample(candidates(600), 0.006, 's', 0.0012).units).toHaveLength(5);
    expect(designSample([], 1, 's', 0.0012)).toEqual({ mode: 'census', units: [] });
    expect(designSample(candidates(50), 0, 's', 0.0012).units).toHaveLength(0);
  });

  it('Horvitz-Thompson weights recover a population total over many weeks', () => {
    const c = candidates(400);
    const truth = c.reduce((s, x) => s + x.impressions, 0);
    let sum = 0;
    const weeks = 300;
    for (let w = 0; w < weeks; w++) {
      const d = designSample(c, 0.15, `p|week${w}`, 0.0012);
      const byKey = new Map(c.map((x) => [`${x.keyword}|${x.device}`, x]));
      sum += d.units.reduce((s, u) => s + (byKey.get(`${u.keyword}|${u.device}`)?.impressions ?? 0) / u.pi, 0);
    }
    expect(Math.abs(sum / weeks / truth - 1)).toBeLessThan(0.03);
  });
});

// ---------- budget formula (test 61, part) ----------

describe('budget', () => {
  const base = { monthlyBudgetUsd: 1, monthSpendUsd: 0, pendingUnknown: 0, costPerCheckUsd: 0.0012, perRunCapUsd: 0.3, balanceUsd: 24.95 };

  it('takes the smallest of monthly headroom, per-run cap and balance', () => {
    expect(budgetFor(base)).toMatchObject({ availableUsd: 0.3, limitedBy: 'per_run' });
    expect(budgetFor({ ...base, monthSpendUsd: 0.9 })).toMatchObject({ limitedBy: 'monthly' });
    expect(budgetFor({ ...base, monthSpendUsd: 0.9 }).availableUsd).toBeCloseTo(0.1, 12);
    expect(budgetFor({ ...base, pendingUnknown: 100, monthSpendUsd: 0.85 }).availableUsd).toBeCloseTo(0.03, 12);
    expect(budgetFor({ ...base, balanceUsd: 0.05 })).toMatchObject({ availableUsd: 0.05, limitedBy: 'balance' });
    expect(availableBudget({ ...base, perRunCapUsd: 0.5, monthlyBudgetUsd: 2 })).toBe(0.5);
  });

  it('treats an unreadable balance as zero and never goes negative', () => {
    expect(availableBudget({ ...base, balanceUsd: null })).toBe(0);
    expect(availableBudget({ ...base, monthSpendUsd: 5 })).toBe(0);
    expect(availableBudget({ ...base, balanceUsd: Number.POSITIVE_INFINITY })).toBe(0.3);
  });

  it('counts whole worst-case checks', () => {
    expect(affordableChecks(0.3, 0.0012)).toBe(250);
    expect(affordableChecks(0.0011, 0.0012)).toBe(0);
    expect(affordableChecks(1, 0)).toBe(0);
  });
});
