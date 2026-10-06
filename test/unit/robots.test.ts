// Test 53: robots.txt per RFC 9309 (groups, wildcards, $, longest match, Allow on ties, user-agent fallback).
import { describe, expect, it } from 'vitest';
import { isAllowed, normalizeRobotsPath, parseRobots, patternMatches, productToken } from '../../src/sources/crawl/robots.js';

const UA = 'searchtrace/0.1 (+https://github.com/searchtrace/searchtrace)';

// The example file from RFC 9309 section 5.1.
const RFC_EXAMPLE = `User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

EOF
`;

describe('robots.txt (RFC 9309)', () => {
  it('reads the product token from a full user agent string', () => {
    expect(productToken(UA)).toBe('searchtrace');
    expect(productToken('FooBot/2.1')).toBe('foobot');
  });

  it('applies the RFC example groups', () => {
    const foo = parseRobots(RFC_EXAMPLE, 'foobot');
    expect(isAllowed(foo, '/example/page.html')).toBe(true);
    expect(isAllowed(foo, '/example/allowed.gif')).toBe(true);
    expect(isAllowed(foo, '/other')).toBe(false);

    // barbot and bazbot share one group.
    for (const bot of ['barbot', 'bazbot']) {
      const r = parseRobots(RFC_EXAMPLE, bot);
      expect(isAllowed(r, '/example/page.html')).toBe(false);
      expect(isAllowed(r, '/example/other.html')).toBe(true);
    }

    // quxbot has an empty group, so everything is allowed.
    expect(isAllowed(parseRobots(RFC_EXAMPLE, 'quxbot'), '/example/page.html')).toBe(true);
  });

  it('falls back to the * group for searchtrace, with * and $ wildcards', () => {
    const r = parseRobots(RFC_EXAMPLE, UA);
    expect(isAllowed(r, '/example/x')).toBe(false);
    expect(isAllowed(r, '/publications/')).toBe(true);
    expect(isAllowed(r, '/images/a.gif')).toBe(false);
    expect(isAllowed(r, '/images/a.gif?size=2')).toBe(true); // $ anchors the end
    expect(isAllowed(r, '/images/a.gifx')).toBe(true);
  });

  it('prefers a group naming searchtrace over *, case-insensitively, and merges repeated groups', () => {
    const r = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: SearchTrace', 'Disallow: /a', '', 'User-agent: searchtrace', 'Disallow: /b'].join('\n'),
      UA,
    );
    expect(isAllowed(r, '/c')).toBe(true);
    expect(isAllowed(r, '/a/1')).toBe(false);
    expect(isAllowed(r, '/b/1')).toBe(false);
  });

  it('lets the longest match win and Allow win a tie', () => {
    const r = parseRobots('User-agent: *\nDisallow: /folder\nAllow: /folder/page\nAllow: /p\nDisallow: /\nAllow: /same\nDisallow: /same', UA);
    expect(isAllowed(r, '/folder/page')).toBe(true);
    expect(isAllowed(r, '/folder/other')).toBe(false);
    expect(isAllowed(r, '/page')).toBe(true); // Allow /p (2) beats Disallow / (1)
    expect(isAllowed(r, '/zzz')).toBe(false);
    expect(isAllowed(r, '/same')).toBe(true); // equal length: Allow wins
  });

  it('matches * in the middle and treats patterns as prefixes', () => {
    expect(patternMatches('/*/private/', '/a/private/x')).toBe(true);
    expect(patternMatches('/*/private/', '/a/public/x')).toBe(false);
    expect(patternMatches('/*.php$', '/index.php')).toBe(true);
    expect(patternMatches('/*.php$', '/index.php?x=1')).toBe(false);
    expect(patternMatches('/fish', '/fish.html')).toBe(true);
    expect(patternMatches('/fish', '/Fish.html')).toBe(false); // paths are case-sensitive
  });

  it('ignores empty rules, rules before any user-agent, and comments', () => {
    const r = parseRobots('Disallow: /early\n# comment\nUser-agent: * # trailing\nDisallow:\nDisallow: /x # why\n', UA);
    expect(isAllowed(r, '/early')).toBe(true);
    expect(isAllowed(r, '/anything')).toBe(true);
    expect(isAllowed(r, '/x')).toBe(false);
  });

  it('always allows /robots.txt and handles a missing leading slash', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n', UA);
    expect(isAllowed(r, '/robots.txt')).toBe(true);
    expect(isAllowed(r, '/')).toBe(false);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: private', UA), '/private/x')).toBe(false);
  });

  it('compares percent-encoded paths after normalisation', () => {
    const r = parseRobots('User-agent: *\nDisallow: /%7Efoo\nDisallow: /föö\n', UA);
    expect(isAllowed(r, '/~foo/bar')).toBe(false);
    expect(isAllowed(r, '/f%C3%B6%C3%B6')).toBe(false);
    expect(isAllowed(r, '/f%c3%b6%c3%b6/x')).toBe(false);
    expect(normalizeRobotsPath('/a%2fb')).toBe('/a%2Fb'); // reserved escapes stay encoded
  });

  it('collects Sitemap lines from anywhere and caps Crawl-delay at 10 seconds', () => {
    const r = parseRobots('Sitemap: https://x.com/a.xml\nUser-agent: *\nCrawl-delay: 30\nSitemap: https://x.com/b.xml\nDisallow: /x\n', UA);
    expect(r.sitemaps).toEqual(['https://x.com/a.xml', 'https://x.com/b.xml']);
    expect(r.crawlDelaySec).toBe(10);
    expect(parseRobots('User-agent: *\nCrawl-delay: 2.5\n', UA).crawlDelaySec).toBe(2.5);
  });

  it('allows everything when there is no matching group', () => {
    const r = parseRobots('User-agent: otherbot\nDisallow: /\n', UA);
    expect(isAllowed(r, '/anything')).toBe(true);
  });

  it('stays fast on hostile patterns', () => {
    const r = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(200)}b$\n`, UA);
    const started = performance.now();
    expect(isAllowed(r, `/${'a'.repeat(5000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
