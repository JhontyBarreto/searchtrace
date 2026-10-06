// `searchtrace why` matching rules and layout (6.4.3).
import { describe, expect, it } from 'vitest';
import { cleanTerminal, matchWhy, renderWhy } from '../../src/report/why.js';
import { XSS, makeAnalysisOutput } from './report-fixture.js';

describe('why', () => {
  const out = makeAnalysisOutput();

  it('shows the headline with no target, in the evidence-chain layout', () => {
    const s = renderWhy(out, null, { color: false });
    const lines = s.split('\n');
    expect(lines[0]).toBe('sc-domain:example.com · last 28 days vs the 28 before');
    expect(s).toContain('  Not enough data yet · Why: Unclear · Possible');
    expect(s).toContain('In the last 28 days Google sent you 80 clicks');
    expect(s).toContain('  Where the clicks went (estimated, 95% range)');
    expect(s).toMatch(/ {4}Fewer or more searches +-3 {4}\(-8 to \+2\)/);
    expect(s).toContain('    Unattributed searches');
    expect(s).toContain('  Evidence');
    expect(s).toContain('    Measured   Search Console: 80 clicks');
    expect(s).toContain('  Other explanations');
    expect(s).toContain("Your change: can't rule it out, nothing was recorded on your site then.");
    expect(s).toContain("What would prove this wrong: we'll know more by 31 Oct 2026.");
    expect(s).toContain('  Check it yourself: https://search.google.com/search-console/');
    expect(s).not.toContain('\u001b[');
  });

  it('matches pages by path, exact first then suffix', () => {
    expect(matchWhy(out, '/blog/slow-drains').kind).toBe('page');
    expect(matchWhy(out, 'slow-drains').kind).not.toBe('page');
    expect(matchWhy(out, '/slow-drains').findings[0].unit.label).toBe('/blog/slow-drains');
    expect(matchWhy(out, 'https://example.com/blog/slow-drains').findings.length).toBeGreaterThan(0);
    const s = renderWhy(out, '/blog/slow-drains', { color: false });
    expect(s.split('\n')[0]).toBe('/blog/slow-drains · last 28 days vs the 28 before');
    expect(s).toContain('Also about this page');
  });

  it('matches searches case-insensitively and finding ids exactly', () => {
    expect(matchWhy(out, 'SLOW DRAIN').kind).toBe('query');
    expect(matchWhy(out, '"slow drain fix"').findings[0].unit.key).toBe('slow drain fix');
    expect(matchWhy(out, 'fbbbbbbbbbbbbbbbb').findings[0].id).toBe('fbbbbbbbbbbbbbbbb');
  });

  it('matches dates against findings and Google events', () => {
    const m = matchWhy(out, '2025-09-12');
    expect(m.kind).toBe('date');
    expect(m.events.map((e) => e.eventId)).toEqual(['curated-num100']);
    const s = renderWhy(out, '2025-09-12', { color: false });
    expect(s).toContain('Heads up: Google changed how it counts impressions and average position');
    const cp = matchWhy(out, '2026-09-10');
    expect(cp.findings[0].id).toBe('feeeeeeeeeeeeeeee');
  });

  it('prints the 5 closest labels when nothing matches', () => {
    const s = renderWhy(out, 'nothing like this', { color: false });
    expect(s).toContain('Nothing matched "nothing like this".');
    expect(s.split('Closest:\n')[1].split('\n\n')[0].split('\n')).toHaveLength(5);
  });

  it('strips terminal control characters from untrusted text', () => {
    expect(cleanTerminal('a\u001b[31mred\u0007')).toBe('a?[31mred?');
    const x = makeAnalysisOutput({ xss: true });
    x.findings[0].evidence[0].summary = 'evil \u001b]0;title\u0007';
    expect(renderWhy(x, null, { color: false })).not.toContain('\u001b');
    expect(renderWhy(x, XSS.script, { color: false })).toContain(XSS.script);
  });

  it('adds colour only when asked', () => {
    expect(renderWhy(out, null, { color: true })).toContain('\u001b[1m');
  });
});
