// Test 72: every TemplateId, AltKey and FalsifierKey renders with no leftover "{" and none of
// the banned words or dashes; plus the label maps and direction swaps (6.2).
import { describe, expect, it } from 'vitest';
import {
  ALT_KEYS, BADGE, CAUSE_LABEL, FALSIFIER_KEYS, REAL_LABEL, TEMPLATE_IDS, renderAlt, renderFalsifier, renderSentence, slotsFor,
} from '../../src/report/copy.js';
import { makeAnalysisOutput } from './report-fixture.js';

const BANNED = [/statistically significant/i, /p-value/i, /\bDiD\b/, /\bCTR\b/, new RegExp(String.fromCharCode(0x2014)), new RegExp(String.fromCharCode(0x2013))];

const FULL_SLOTS: Record<string, string | number> = {
  days: 28, clicks: 80, abs: 9, pct: -0.1, direction: 'down', date: '2026-09-14', n_days: 5, update: 'December 2025 core update',
  touched: -0.31, untouched: -0.29, level: 'high', k: 9, n: 11, change_date: '2026-09-09', summary: 'new titles', d1: '2026-09-12',
  d2: '2026-09-15', ctrl: 0.01, share: 0.6, yoy: -0.12, pb: 6.2, pc: 8.9, lo: -30, hi: -12, x: 0.3, cb: 0.052, cc: 0.031,
  cost: 0.25, freq: 0.25, cpw: 20, mde: 0.45, weeks: 4, impr_pct: 0.03, impr_label: 'Normal wobble', top_segment: '/blog/*',
  reason_text: 'the same kind of gap already existed before', a: 'demand', b: 'rank', metric: 'impressions', event: 'num=100',
  check_date: '2026-10-31', url: '/pricing', before: 'Submitted and indexed', after: 'Crawled - currently not indexed',
  dates: '11 Dec 2025 to 29 Dec 2025', clicks_pct: -0.12, clicks_label: 'Real change', status: 'measured', unit: '/blog/*',
  slope: -0.02, query: 'slow drain', device: 'desktop', cited: 1, hidden: 0.81, shown: 0.19, domains: 'a.example, b.example',
};

function clean(s: string): void {
  expect(s).not.toMatch(/[{}]/);
  for (const re of BANNED) expect(s).not.toMatch(re);
  expect(s).not.toContain('undefined');
  expect(s).not.toContain('NaN');
}

describe('copy deck', () => {
  it('has the 6.2 labels', () => {
    expect(REAL_LABEL).toEqual({ signal: 'Real change', noise: 'Normal wobble', underpowered: 'Not enough data yet', unclear: "Can't separate the causes" });
    expect(BADGE).toEqual({ EXTRACTED: 'Measured', INFERRED: 'Estimated', AMBIGUOUS: 'Possible' });
    expect(CAUSE_LABEL.ctr_serp).toBe('Same spot, different click rate');
    expect(CAUSE_LABEL.data_anomaly).toBe('Reporting change');
    expect(Object.keys(CAUSE_LABEL)).toHaveLength(12);
  });

  it('lists every template, alternative and falsifier key', () => {
    expect(TEMPLATE_IDS).toHaveLength(29);
    expect(ALT_KEYS).toHaveLength(16);
    expect(FALSIFIER_KEYS).toHaveLength(8);
  });

  for (const direction of ['down', 'up']) {
    it(`renders every template with full slots (${direction})`, () => {
      for (const t of TEMPLATE_IDS) {
        const s = renderSentence(t, { ...FULL_SLOTS, direction });
        clean(s);
        expect(s.length).toBeGreaterThan(10);
      }
    });
  }

  it('renders every template with no slots and never leaks a placeholder', () => {
    for (const t of TEMPLATE_IDS) clean(renderSentence(t, {}));
  });

  it('renders every alternative and falsifier', () => {
    for (const k of ALT_KEYS) {
      clean(renderAlt(k, FULL_SLOTS));
      clean(renderAlt(k, {}));
    }
    for (const k of FALSIFIER_KEYS) {
      const s = renderFalsifier(k, FULL_SLOTS);
      clean(s);
      expect(s.startsWith('What would prove this wrong: ')).toBe(true);
    }
  });

  it('formats the headline sentence (6.4.1)', () => {
    expect(renderSentence('headline', { days: 28, clicks: 80, abs: 9, pct: -0.1, direction: 'down' })).toBe(
      'In the last 28 days Google sent you 80 clicks, 9 fewer than the 28 days before (-10%).',
    );
    expect(renderSentence('headline', { days: 28, clicks: 1, abs: 0, pct: 0, direction: 'up' })).toBe(
      'In the last 28 days Google sent you 1 click, the same as the 28 days before.',
    );
    expect(renderSentence('headline', { days: 28, clicks: 120, abs: -31, pct: 0.35, direction: 'up' })).toContain('31 more than');
  });

  it('formats not_enough_data like the terminal template', () => {
    const s = renderSentence('not_enough_data', { cpw: 20, mde: 0.45, weeks: 4, pct: -0.1, impr_pct: 0.03, impr_label: 'Normal wobble' });
    expect(s).toBe(
      'Not enough data to tell yet. With about 20 clicks a week, only a change of roughly 45% or more stands out from normal ' +
      "ups and downs over 4 weeks, and this one was -10%. Impressions, which have far more data, didn't change meaningfully (+3%).",
    );
    const nm = renderSentence('not_enough_data', { cpw: 1, not_measurable: 1, pct: -0.4 });
    expect(nm).toBe("Not enough data to tell yet. At this traffic level a change this size can't be measured reliably.");
    expect(renderSentence('not_enough_data', { cpw: 1, mde: 0.9, weeks: 4, pct: -0.4 })).toContain('about 1 click a week');
    expect(renderSentence('not_enough_data', { cpw: 20, mde: 0.45, weeks: 4, pct: 0.2, impr_pct: 0.25, impr_real: 'signal', impr_label: 'Real change' }))
      .toContain('did change: +25% (Real change)');
  });

  it('swaps direction words', () => {
    const down = renderSentence('ranking', { ...FULL_SLOTS, direction: 'down' });
    const up = renderSentence('ranking', { ...FULL_SLOTS, direction: 'up' });
    expect(down).toContain('You slipped in the rankings');
    expect(down).toContain('That cost an estimated 12 to 30 clicks.');
    expect(up).toContain('You climbed in the rankings');
    expect(up).toContain('earned');
    expect(renderSentence('demand', { ...FULL_SLOTS, direction: 'up', yoy: 0.08, pct: 0.1 })).toMatch(/^More people searched\..*rose 10%.*gained clicks/);
    expect(renderSentence('change_point', { ...FULL_SLOTS })).toBe(
      'Impressions on /blog/* dropped by 10% around 14 Sep 2026 (most likely between 12 Sep 2026 and 15 Sep 2026).',
    );
  });

  it('chooses the seasonal sentence from yoy', () => {
    expect(renderSentence('demand', { pct: -0.2, share: 0.6, yoy: -0.18, direction: 'down' })).toContain('were down 18% too, so this is probably seasonal.');
    expect(renderSentence('demand', { pct: -0.2, share: 0.6, yoy: 0.02, direction: 'down' })).toContain("didn't show this");
    expect(renderSentence('demand', { pct: -0.2, share: 0.6, direction: 'down' })).toMatch(/lost clicks\.$/);
  });

  it('builds reason text, cited text and update rows', () => {
    expect(renderSentence('cant_separate', { date: '2026-03-20', check: 'competing_events', a: 'March 2026 core update', b: 'March 2026 spam update' }))
      .toBe("Something changed around 20 Mar 2026, but March 2026 core update and March 2026 spam update overlapped, so we can't separate the causes.");
    expect(renderSentence('aio_fact', { query: 'q', device: 'mobile', k: 2, n: 3, cited: 0, domains: 'x.example' }))
      .toBe('"q" (mobile): an AI Overview showed in 2 of 3 checks, and it doesn\'t cite you; it cites x.example.');
    expect(renderSentence('aio_fact', { query: 'q', device: 'mobile', k: 0, n: 1 })).toBe('"q" (mobile): an AI Overview showed in 0 of 1 check.');
    expect(renderSentence('update_row', { update: 'Discover update', status: 'skipped_discover' })).toBe('Discover update: a Discover update, not web search, so skipped.');
    expect(renderSentence('update_row', { update: 'X', dates: 'a to b', clicks_pct: -0.12, clicks_real: 'signal', impr_pct: 0.01, impr_real: 'noise', status: 'measured' }))
      .toBe('X (a to b): clicks -12% (Real change), impressions +1% (Normal wobble).');
    expect(renderSentence('freshness', { date: '2026-10-03', n: 3 })).toContain('so the last 3 days are left out');
  });

  it('derives level, direction and power slots from a finding', () => {
    const out = makeAnalysisOutput();
    const tpl = out.findings.find((f) => f.id === 'fbbbbbbbbbbbbbbbb')!;
    const s = slotsFor(tpl);
    expect(s.level).toBe('high');
    const page = out.findings.find((f) => f.id === 'fcccccccccccccccc')!;
    expect(slotsFor(page).not_measurable).toBe(1);
    expect(renderSentence(page.template, slotsFor(page))).toContain("can't be measured reliably");
  });
});

describe('slot conventions seen from the analysis package', () => {
  it('accepts selector keywords and verdict keys as well as finished text', () => {
    expect(renderSentence('not_enough_data', { cpw: 1277.75, mde: 0.0845, weeks: 4, pct: 0.0438, not_measurable: 0, impr_pct: 0.0197, impr_label: 'noise', impr_sentence: 'unchanged' }))
      .toBe('Not enough data to tell yet. With about 1,278 clicks a week, only a change of roughly 8.5% or more stands out from normal ' +
        "ups and downs over 4 weeks, and this one was +4.4%. Impressions, which have far more data, didn't change meaningfully (+2%).");
    expect(renderSentence('not_enough_data', { cpw: 5, mde: 0.5, weeks: 4, pct: 0.3, impr_pct: 0.25, impr_label: 'signal' }))
      .toContain('did change: +25% (Real change)');
    expect(renderSentence('aio_fact', { query: 'q', device: 'mobile', k: 6, n: 6, cited_text: 'doesnt_cite_you', domains: 'a.example, b.example' }))
      .toBe('"q" (mobile): an AI Overview showed in 6 of 6 checks, and it doesn\'t cite you; it cites a.example, b.example.');
    expect(renderSentence('aio_fact', { query: 'q', device: 'mobile', k: 2, n: 2, cited_text: 'cites_you' })).toContain(', and it cites you.');
    expect(renderSentence('aio_not_cited', { x: 0.22, lo: 0.31, hi: 0.12 })).toContain('(likely range 12% to 31%)');
    expect(renderSentence('update_row', { update: 'December 2025 core update', dates: '2025-12-11 to 2025-12-29', clicks_pct: -0.18, clicks_label: 'Real change', impr_pct: -0.007, impr_label: 'noise', status: 'measured' }))
      .toBe('December 2025 core update (11 Dec 2025 to 29 Dec 2025): clicks -18% (Real change), impressions -0.7% (Normal wobble).');
    expect(renderSentence('change_point', { metric: 'clicks', unit: 'Whole site', pct: 0.15, date: '2026-04-21', d1: '2026-04-21', d2: '2026-04-21', direction: 'up' }))
      .toBe('Clicks on the whole site rose by 15% around 21 Apr 2026.');
    expect(renderSentence('change_point', { metric: 'clicks', unit: 'Whole site (mobile)', pct: 0.16, date: '2026-04-21', direction: 'up' })).toContain('on the whole site (mobile) rose');
  });

  it('never calls normal wobble rare when the frequency is unknown', () => {
    expect(renderSentence('noise', { pct: -0.03 })).toBe('This is normal wobble. Clicks moved -3%, which is within normal ups and downs for your site. Nothing to act on.');
    expect(renderSentence('noise', { pct: -0.03, freq: 0.5 })).toContain('happen about 1 in 2 four-week periods');
  });
});
