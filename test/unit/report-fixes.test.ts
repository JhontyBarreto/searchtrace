// Report-layer fixes from the v0.1 review: verdict wording, falsifiers, labels, links, grouping,
// layout and the charts. Each test names the problem it guards against. Owner: WP-F.
import { describe, expect, it } from 'vitest';
import type { AnalysisOutput, Finding } from '../../src/core/types.js';
import {
  aioBridgeSentence, findingFalsifier, isEmptyRow, realLabel, renderSentence, shownGroups, unitDisplay, whyText,
} from '../../src/report/copy.js';
import { verifyLink } from '../../src/report/gsc-links.js';
import { renderReports, selectFindings } from '../../src/report/html.js';
import { renderWhy } from '../../src/report/why.js';
import { answerChart, answerWeeks, timelineChart, timelineLegend } from '../../src/report/svg.js';
import { ladder, scorecardCells, updateName } from '../../src/report/tables.js';
import { makeAnalysisOutput, makeReportContext } from './report-fixture.js';

const ctx = makeReportContext();

function withFinding(out: AnalysisOutput, f: Finding): AnalysisOutput {
  return { ...out, findings: [...out.findings, f] };
}

describe('"Is it real?" wording (noise-label-on-real-change, wobble frequency)', () => {
  it('a real but small change is a "Small change", never wobble or "nothing to act on"', () => {
    const s = renderSentence('noise', { pct: -0.08, verdict_reason: 'noise_small', ci_lo: -0.096, ci_hi: -0.065, delta: 0.1, freq: 0.16 });
    expect(s).toBe("Clicks fell 8% (likely 6.5% to 9.6%). That's a real drop, but smaller than the 10% we treat as worth acting on, so keep an eye on it rather than act on it.");
    expect(s).not.toMatch(/wobble|Nothing to act on|ups and downs|1 in/);
    expect(realLabel({ real: 'noise', reason: 'noise_small' })).toBe('Small change');
    expect(realLabel({ real: 'noise', reason: 'noise_bounded' })).toBe('Normal wobble');
    expect(realLabel({ real: 'signal', reason: 'fact' })).toBe('Measured fact');
  });

  it('wobble only quotes a frequency for a range that contains zero, and gives the size it rules out', () => {
    expect(renderSentence('noise', { pct: -0.03, verdict_reason: 'noise_bounded', ci_lo: -0.06, ci_hi: 0.01, delta: 0.1, freq: 0.25 }))
      .toBe('This is normal wobble. Clicks moved -3%, and swings this size happen about 1 in 4 four-week periods in your history. Nothing to act on.');
    // Range excludes zero (but failed false-discovery control): no "1 in N", the bound instead.
    expect(renderSentence('noise', { pct: -0.05, verdict_reason: 'noise_bounded', ci_lo: -0.09, ci_hi: -0.01, delta: 0.1, freq: 0.25 }))
      .toBe('This is normal wobble. Clicks moved -5%, and any real change is smaller than 10%. Nothing to act on.');
  });

  it('a real change below the size we flag carries its range', () => {
    const s = renderSentence('change_point', {
      metric: 'clicks', unit: '/services/*', pct: 0.094, date: '2026-09-06', d1: '2026-09-06', d2: '2026-09-06', direction: 'down',
      ci_lo: -0.14, ci_hi: -0.05, delta: 0.1, verdict_reason: 'signal',
    });
    expect(s).toBe('Clicks on pages under /services/ dropped by about 9.4% (at least 5%, possibly 14%) around 6 Sep 2026.');
    const w = renderSentence('ranking', { pb: 4, pc: 5, n: 3, lo: 10, hi: 30, direction: 'down', size_pct: -0.09, size_lo: -0.14, size_hi: -0.05 });
    expect(w).toMatch(/Clicks fell 9% over the period \(at least 5%, possibly 14%\)\.$/);
  });
});

describe('falsifiers falsify (falsifier-copy-confirms-instead-of-falsifies)', () => {
  const base = makeAnalysisOutput().findings[0];
  const f = (real: Finding['real'], reason: Finding['reason'], key: Finding['falsifier']['key']): Finding => ({ ...base, real, reason, falsifier: { key, slots: { check_date: '2026-10-31' } } });

  it('never says "if it reverts, it was a blip" under a wobble verdict', () => {
    expect(findingFalsifier(f('noise', 'noise_bounded', 'reverts'))).toBe('What would prove this wrong: if the new level holds for another 4 weeks, it was more than normal wobble.');
    expect(findingFalsifier(f('noise', 'noise_small', 'reverts'))).toContain("keeps moving the same way");
    expect(findingFalsifier(f('signal', 'signal', 'reverts'))).toBe('What would prove this wrong: if the next 4 weeks return to the old level, this was a blip.');
  });

  it('words the causes as tests and gives non-falsifiers their own prefix', () => {
    expect(findingFalsifier(f('signal', 'signal', 'revert_and_recrawl'))).toContain("the change wasn't the cause");
    expect(findingFalsifier(f('signal', 'signal', 'impressions_recover'))).toContain("it wasn't fewer searches");
    expect(findingFalsifier(f('underpowered', 'wide_ci', 'more_data'))).toBe("When we'll know: by 31 Oct 2026.");
    expect(findingFalsifier(f('noise', 'fact', 'record_changes'))).toMatch(/^Next step: if you changed something around then, add it with `npx -y "github:JhontyBarreto\/searchtrace#v[^"]+" note "what you changed" --date YYYY-MM-DD --urls "\/path\/\*"`/);
  });
});

describe('labels and the "Why?" gate (headline-wobble-buries-the-real-story, why-cli-jargon)', () => {
  it('names a cause only for a real or unclear change, never "Unclear" or under wobble', () => {
    const base = makeAnalysisOutput().findings[0];
    expect(whyText({ ...base, real: 'noise', cause: 'site_change' })).toBeNull();
    expect(whyText({ ...base, real: 'underpowered', cause: 'ai_overview' })).toBeNull();
    expect(whyText({ ...base, real: 'signal', cause: 'unknown' })).toBeNull();
    expect(whyText({ ...base, real: 'signal', cause: 'site_change', causeConfidence: 'INFERRED' })).toBe('Why: Your change (Estimated)');
    expect(whyText({ ...base, kind: 'aio_effect', real: 'underpowered', cause: 'ai_overview' })).toBeNull();
  });

  it('the headline row omits Why for wobble in HTML and Markdown, and shows it for a real change', () => {
    const out = makeAnalysisOutput();
    out.findings[0] = { ...out.findings[0], real: 'noise', reason: 'noise_bounded', template: 'noise', cause: 'site_change', slots: { pct: -0.03 } };
    const { html, md } = renderReports(out, ctx);
    expect(html).toContain('<span>Is it real?</span>');
    expect(html).not.toContain('<span>Why?</span>');
    expect(md).not.toContain('**Why?**');
    out.findings[0] = { ...out.findings[0], real: 'signal', reason: 'signal', template: 'real_google_no_changes', cause: 'google_update', causeConfidence: 'INFERRED', effect: { ...out.findings[0].effect, estimate: -0.2 } };
    const r2 = renderReports(out, ctx);
    expect(r2.html).toContain('<span>Why?</span>');
    expect(r2.md).toContain('**Why?** Google update (Estimated)');
  });

  it('shows sections, the home page and brand classes in plain words', () => {
    expect(unitDisplay({ level: 'template', key: '/blog/*', label: '/blog/*' })).toBe('Pages under /blog/');
    expect(unitDisplay({ level: 'template', key: 'other pages', label: 'other pages' })).toBe('Other pages (small sections)');
    expect(unitDisplay({ level: 'template', key: '/', label: '/' })).toBe('Home page (with its ?query variants)');
    expect(unitDisplay({ level: 'page', key: 'https://x.example/', label: '/' })).toBe('Home page');
    const { html } = renderReports(makeAnalysisOutput(), ctx);
    expect(html).toContain('<title>Search traffic report: example.com (Domain property)</title>');
    expect(html).not.toContain('sealed day');
  });
});

describe('findings.json and the graph never call a sighting "Real change" (facts-labelled-real-change)', () => {
  it('serialises facts with real null and "Measured fact", and lists also-worth items with their unit', () => {
    const doc = JSON.parse(renderReports(makeAnalysisOutput(), ctx).json);
    const fact = doc.findings.find((f: { kind: string }) => f.kind === 'aio_fact');
    expect(fact.real).toBeNull();
    expect(fact.real_label).toBe('Measured fact');
    const notice = doc.findings.find((f: { kind: string }) => f.kind === 'notice');
    expect(notice.real_label).toBe('Measured fact');
    expect(Array.isArray(doc.headline.also_worth)).toBe(true);
    for (const a of doc.headline.also_worth) expect(typeof a.unit_label).toBe('string');
  });
});

describe('Check it yourself (check-it-yourself-links-unfiltered)', () => {
  const v = { from: '2026-09-06', to: '2026-10-03' };
  it('filters a section by "URLs containing" and says it is approximate', () => {
    const r = verifyLink('sc-domain:x.example', { verify: v, unit: { level: 'template', key: '/blog/*', label: '/blog/*' } });
    expect(r?.url).toContain('page=*%2Fblog%2F');
    expect(r?.note).toContain('approximate');
  });
  it('never sends an internal class key as a query filter, and says how to filter by hand', () => {
    const r = verifyLink('sc-domain:x.example', { verify: v, unit: { level: 'query', key: 'class:nonbrand', label: 'Searches without your business name' } }, ['pipewell']);
    expect(r?.url).not.toContain('query=');
    expect(r?.note).toContain('not containing "pipewell"');
    const other = verifyLink('sc-domain:x.example', { verify: v, unit: { level: 'template', key: 'other pages', label: 'other pages' } });
    expect(other?.url).not.toContain('page=');
    expect(other?.note).toContain('whole site');
  });
});

describe('layout (mobile-horizontal-scroll, verdict-colours-mean-alarm)', () => {
  const { html } = renderReports(makeAnalysisOutput(), ctx);
  it('puts every table in its own scroll box and lets the maths grid shrink', () => {
    const tables = html.match(/<table/g) ?? [];
    const wrapped = html.match(/<div class="table-wrap" role="region" tabindex="0" aria-label="[^"]+"><table/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(tables.length);
    expect(html).not.toContain('grid-template-columns:max-content 1fr');
    expect(html).toContain('.table-wrap{overflow:visible}');
  });

  it('colours pills by certainty only, with direction as an arrow on real changes', () => {
    expect(html).not.toContain('#b42318');
    expect(html).not.toContain('--sig');
    const out = makeAnalysisOutput();
    const tpl = out.findings.find((f) => f.id === 'fbbbbbbbbbbbbbbbb') as Finding;
    const up = withFinding(out, { ...tpl, id: 'fupupupupupupupup', unit: { level: 'page', key: 'https://example.com/up', label: '/up' }, effect: { ...tpl.effect, estimate: 0.75 } });
    const r = renderReports(up, ctx).html;
    expect(r).toContain('<span class="dir pos" aria-hidden="true">▲</span>Real change');
    expect(r).toContain('<span class="dir neg" aria-hidden="true">▼</span>Real change');
    // Wobble gets no arrow.
    expect(r).not.toMatch(/dir (pos|neg)[^<]*<\/span>Normal wobble/);
  });
});

describe('one story told once (same-page-wobble-and-real-change, walls-of-repeated-items)', () => {
  it('a 28-day wobble that dilutes a real step inside the window is one item led by the step, never "Nothing to act on"', () => {
    const out = makeAnalysisOutput();
    const page = out.findings.find((f) => f.id === 'fcccccccccccccccc') as Finding;
    const cp: Finding = {
      ...page, id: 'fcpcpcpcpcpcpcpcp', kind: 'change_point', template: 'change_point', real: 'signal', reason: 'signal', windows: null,
      date: '2026-09-15', dateWindow: ['2026-09-14', '2026-09-15'], effect: { ...page.effect, estimate: -0.3, ci95: [-0.4, -0.2] },
      slots: { metric: 'clicks', unit: page.unit.label, pct: 0.3, date: '2026-09-15', d1: '2026-09-14', d2: '2026-09-15', direction: 'down' },
      falsifier: { key: 'reverts', slots: {} }, priority: 3000,
    };
    out.findings = out.findings.map((f) => (f.id === page.id
      ? { ...page, real: 'noise', reason: 'noise_small', template: 'noise', slots: { pct: -0.2, verdict_reason: 'noise_small' }, effect: { ...page.effect, estimate: -0.2 }, related: { ...page.related, findings: [cp.id] } }
      : f));
    out.findings.push(cp);
    const sel = selectFindings(out);
    expect(sel.reconciled.get(page.id)?.id).toBe(cp.id);
    const { html, md } = renderReports(out, ctx);
    for (const text of [html, md]) expect(text).toContain('dropped by 30% around 15 Sep 2026');
    expect(md).toContain("Over the full 28 days it's -20%, because the first 9 days were still at the old level.");
    expect(html).toContain('Over the full 28 days it&#39;s -20%, because the first 9 days were still at the old level.');
    expect(md).not.toMatch(/slow-drains[^\n]*Nothing to act on/);
    const why = renderWhy(out, page.unit.key, { color: false });
    expect(why).toContain('Over the full 28 days');
    expect(why).not.toContain('Nothing to act on');
  });
});

describe('the click breakdown (waterfall-labels-and-ai-citation-row, waterfall-ranges)', () => {
  it('hides structural zeros, labels direction, and bridges to the AI Overview estimate with its own numbers', () => {
    expect(isEmptyRow({ group: 'aioCitation', label: '', value: 0, ci: [0, 0] })).toBe(true);
    expect(isEmptyRow({ group: 'ranking', label: '', value: 0.004, ci: [0.001, 0.007] })).toBe(true);
    expect(isEmptyRow({ group: 'ranking', label: '', value: 0, ci: [-3, 2] })).toBe(false);
    const rows = shownGroups({ demand: 0, visibility: 0, rank: 0, samePos: 12, appeared: 0, disappeared: 0, aioCitation: 0 }, { samePos: [5, 20] });
    expect(rows.map((r) => r.label)).toEqual(['Same position, more clicks']);
    const out = makeAnalysisOutput();
    expect(aioBridgeSentence(out)).toBeNull();
    out.aio!.estimates = [{
      estimator: 'did', tau: -0.29, ci95: [-0.34, -0.24], missingClicks: 730, missingCi95: [562, 908], groups: { U: 30, N: 60, Cit: 5, intermittent: 0 },
      coverage: 1, placebo: null, real: 'signal', reason: 'signal', findingId: 'fdid',
    }];
    expect(aioBridgeSentence(out)).toBe("About 730 of the clicks lost at the same position (likely 562 to 908) were on searches where an AI Overview now shows and doesn't cite you, estimated separately and likely understated. See AI Overviews below.");
  });

  it("the Total row carries the headline's own range in clicks", () => {
    const { html } = renderReports(makeAnalysisOutput(), ctx);
    expect(html).toMatch(/<strong>Total<\/strong><\/td><td class="num"><strong>-9<\/strong><\/td><td class="num">-30 to \+12<\/td>/);
  });
});

describe('scorecard, ladder and charts', () => {
  it('uses human dates, plain verdicts and counts instead of percents on thin rows (scorecard-dates-and-wording)', () => {
    const out = makeAnalysisOutput();
    const [recent, num100] = out.scorecard;
    const r = scorecardCells(recent, out);
    expect(r.dates).toBe('24 Sep 2026, still rolling out');
    expect(r.verdict).toBe('Too recent, check on 15 Oct 2026');
    expect(r.notes).not.toContain('Check again on');
    const n = scorecardCells(num100, out);
    expect(n.name).toBe('Reporting change: Google stopped showing 100 results per page');
    expect(n.notes).toContain("Impressions before and after this change aren't comparable");
    const thin = scorecardCells({ ...num100, clicks: { ...num100.clicks!, reason: 'floors', pre: 2, post: 9 } }, out);
    expect(thin.clicks).toBe('Too few clicks (2 before, 9 after)');
    expect(updateName({ kind: 'outage', title: 'Serving was experiencing an issue' })).toBe('Google Search serving outage');
    const small = scorecardCells({ ...num100, kind: 'spam', measurementOverlap: false, clicks: { ...num100.clicks!, real: 'noise', reason: 'noise_small', ci95: [-0.054, -0.008] } }, { ...out, findings: [] });
    expect(small.verdict).toBe('Small change');
    expect(small.notes).toContain('Small but real, under the 10%');
  });

  it("calls the 16-month row true only once the oldest saved day has left Google's retention (ladder-already-true-on-day-one)", () => {
    const out = makeAnalysisOutput();
    // A first run on 3 Oct 2026 brings back about 490 days, all still in Search Console.
    const first = ladder(out, ctx).at(-1);
    expect(first?.status).toMatch(/^Not yet \(from 1 \w+ 2026\)$/);
    const later = ladder({ ...out, diagnostics: { ...out.diagnostics, historyDays: 560 } }, ctx).at(-1);
    expect(later?.status).toBe('Already true');
  });

  it('the answer chart covers both compared windows, shades them and says so (sparkline-flat-and-unlabelled)', () => {
    const out = makeAnalysisOutput();
    const { weeks, end } = answerWeeks(out);
    expect(end).toBe(out.windows.current[1]);
    expect(weeks).toHaveLength(16);
    expect(weeks.at(-1)?.end).toBe(out.windows.current[1]);
    const c = answerChart(out);
    expect(c?.svg).toContain('class="spark-base"');
    expect(c?.svg).toContain('class="spark-cur"');
    expect(c?.svg).toContain('aria-labelledby="answer-chart"');
    expect(c?.caption).toMatch(/^Weekly clicks for the 16 weeks to 3 Oct 2026\. Shaded: the two 28-day periods compared above/);
    // A 90-day window needs more weeks than 16 to show both periods.
    const long: AnalysisOutput = { ...out, windows: { ...out.windows, baseline: ['2026-04-07', '2026-07-05'], current: ['2026-07-06', '2026-10-03'] } };
    expect(answerWeeks(long).weeks.length).toBeGreaterThanOrEqual(Math.ceil(180 / 7));
  });

  it('the timeline legend lists only what was drawn, and the last month is never clipped (timeline-chart-gaps)', () => {
    const out = { ...makeAnalysisOutput(), changePoints: [] };
    const { svg, drawn } = timelineChart(out);
    expect(drawn.changes).toBe(false);
    expect(drawn.provisional).toBe(true);
    const legend = timelineLegend(drawn);
    expect(legend).not.toContain('Detected change');
    expect(legend).toContain('Not final yet');
    for (const m of svg.matchAll(/<text class="axis-label" x="([\d.]+)" y="[\d.]+" text-anchor="middle">([^<]+)<\/text>/g)) {
      expect(Number(m[1]) + m[2].length * 3.1).toBeLessThanOrEqual(960);
    }
  });
});

describe('small details', () => {
  it('words a jump from a tiny base in counts, not "+22,400%"', () => {
    const s = renderSentence('not_enough_data', { cpw: 2, mde: 0.9, weeks: 4, pct: 0.5, impr_pct: 224, impr_real: 'underpowered', impr_reason: 'floors', impr_base: 1, impr_cur: 225 });
    expect(s).toContain('Impressions went from 1 to 225, but there are too few of them to judge either.');
    expect(s).not.toContain('22,400%');
  });

  it('a note holding links is defanged in the Markdown report (markdown-autolinks-from-untrusted-text)', () => {
    const out = makeAnalysisOutput();
    out.siteChanges[0] = { ...out.siteChanges[0], text: 'Moved login to https://evil.example/login see www.evil.example or mail evil@evil.example' };
    const { md } = renderReports(out, ctx);
    // Our own links are Markdown links "](https://..."; anything else must not be a bare URL.
    const bare = md.replace(/\]\(https:\/\/[^)]*\)/g, '](LINK)');
    expect(bare).not.toMatch(/(^|[^\\])https?:\/\//m);
    expect(bare).not.toMatch(/www\.(?!\\)/i);
    expect(bare).toContain('evil@<span></span>evil.example');
  });
});

