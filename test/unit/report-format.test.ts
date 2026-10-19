// Formatting rules (6.3) and escaping helpers (4.11).
import { describe, expect, it } from 'vitest';
import { csvCell, esc, externalLink, mdEscape, safeHref } from '../../src/report/escape.js';
import {
  confidenceLevel, fmtAbsPct, fmtDate, fmtFreq, fmtInt, fmtMoney, fmtPct, fmtPos, fmtRange, fmtSignedInt, truncate,
} from '../../src/report/format.js';
import { gscLink } from '../../src/report/gsc-links.js';

describe('format', () => {
  it('formats percents: whole numbers from 10%, one decimal below, always signed', () => {
    expect(fmtPct(-0.31)).toBe('-31%');
    expect(fmtPct(0.031)).toBe('+3.1%');
    expect(fmtPct(-0.0951)).toBe('-9.5%');
    expect(fmtPct(0.0996)).toBe('+10%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(-0.00001)).toBe('0%');
    expect(fmtPct(12.5)).toBe('+1,250%');
    expect(fmtPct(Number.NaN)).toBe('n/a');
    expect(fmtAbsPct(-0.45)).toBe('45%');
  });

  it('formats clicks, positions, money, ranges and dates', () => {
    expect(fmtInt(1031)).toBe('1,031');
    expect(fmtInt(-1234567.4)).toBe('-1,234,567');
    expect(fmtInt(-0.2)).toBe('0');
    expect(fmtSignedInt(0)).toBe('+0');
    expect(fmtSignedInt(-3)).toBe('-3');
    expect(fmtPos(8.44)).toBe('8.4');
    expect(fmtMoney(0.017)).toBe('$0.017');
    expect(fmtMoney(0.2052)).toBe('$0.21');
    expect(fmtMoney(0.3)).toBe('$0.30');
    expect(fmtMoney(0.05)).toBe('$0.05');
    expect(fmtMoney(0.25)).toBe('$0.25');
    expect(fmtMoney(0.0012)).toBe('$0.0012');
    expect(fmtMoney(0)).toBe('$0.00');
    expect(fmtMoney(1.24)).toBe('$1.24');
    expect(fmtMoney(24.95)).toBe('$24.95');
    expect(fmtMoney(1234.5)).toBe('$1,234.50');
    expect(fmtRange('12', '30')).toBe('12 to 30');
    expect(fmtDate('2026-09-14')).toBe('14 Sep 2026');
    expect(fmtDate('2026-10-03')).toBe('3 Oct 2026');
    expect(fmtDate('not a date')).toBe('not a date');
  });

  it('formats the wobble frequency', () => {
    expect(fmtFreq(0.25)).toBe('1 in 4 four-week periods');
    expect(fmtFreq(0)).toBe('rarely');
    expect(fmtFreq(null)).toBe('rarely');
    expect(fmtFreq(1)).toBe('every four-week period');
  });

  it('maps confidence level', () => {
    expect(confidenceLevel({ real: 'signal', causeConfidence: 'INFERRED' })).toBe('high');
    expect(confidenceLevel({ real: 'signal', causeConfidence: 'AMBIGUOUS' })).toBe('medium');
    expect(confidenceLevel({ real: 'underpowered', causeConfidence: 'INFERRED' })).toBe('low');
  });

  it('truncates with an ASCII ellipsis', () => {
    expect(truncate('a'.repeat(130), 120)).toHaveLength(120);
    expect(truncate('short', 120)).toBe('short');
  });
});

describe('escape', () => {
  it('escapes HTML', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(esc('"><img src=x onerror=1>')).toBe('&quot;&gt;&lt;img src=x onerror=1&gt;');
    expect(esc("it's & `x`")).toBe('it&#39;s &amp; &#96;x&#96;');
    expect(esc(null)).toBe('');
  });

  it('escapes Markdown, including table pipes, links, mentions and line breaks', () => {
    // "@" gets an empty span after it: GitHub decodes "&#64;" back into a live mention, so the old
    // escape gave false confidence.
    expect(mdEscape('<b>[x](javascript:alert(1)) | @someone `code`\nnext')).toBe(
      '&lt;b&gt;\\[x\\](javascript:alert(1)) \\| @<span></span>someone \\`code\\` next',
    );
    expect(mdEscape('a_b*c')).toBe('a\\_b\\*c');
  });

  it('breaks every GitHub autolink and mention trigger in untrusted text', () => {
    const hostile = ['https://evil.example/login', 'HTTPS://evil.example', 'www.evil.example', '_www.evil.example/x', '(www.evil.example)',
      'WWW.evil.example', 'evil@evil.example', 'mailto:evil@evil.example', '@octocat', 'see https://a.example and www.b.example'];
    for (const h of hostile) {
      const m = mdEscape(h);
      expect(m, h).not.toMatch(/(^|[^\\]):\/\//);
      expect(m, h).not.toMatch(/www\.(?!\\)/i);
      expect(m.match(/www/gi)?.length ?? 0, h).toBe(m.match(/www\\\./gi)?.length ?? 0);
      for (const at of m.matchAll(/@/g)) expect(m.slice(at.index, at.index + 14), h).toBe('@<span></span>');
    }
    // Rendered text keeps the characters: a copied query still matches in Search Console.
    expect(mdEscape('www.facebook.com login')).toBe('www\\.facebook.com login');
  });

  it('leaves a bare & as typed and escapes only what would start an entity', () => {
    expect(mdEscape('Google stopped honouring &num=100')).toBe('Google stopped honouring &num=100');
    expect(mdEscape('link reclamation & recovery')).toBe('link reclamation & recovery');
    expect(mdEscape('x &amp; y &#64; z')).toBe('x &amp;amp; y &amp;#64; z');
  });

  it('guards CSV cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(null)).toBe('');
  });

  it('only links https URLs, with noopener noreferrer', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('http://example.com/')).toBeNull();
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(externalLink('javascript:alert(1)', 'x')).toBe('x');
    expect(externalLink('https://example.com/', '<b>')).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">&lt;b&gt;</a>',
    );
  });
});

describe('gscLink', () => {
  it('builds a "Check it yourself" URL', () => {
    expect(gscLink('sc-domain:example.com', { page: 'https://example.com/a b', from: '2026-09-06', to: '2026-10-03' })).toBe(
      'https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Aexample.com' +
      '&start_date=20260906&end_date=20261003&page=!https%3A%2F%2Fexample.com%2Fa%20b',
    );
    expect(gscLink('https://www.example.com/', { query: 'a&b', from: '2026-09-06', to: '2026-10-03' })).toContain('&query=!a%26b');
  });
});
