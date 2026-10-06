import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretRegistry } from '../../src/core/secrets.js';
import { createLogger } from '../../src/core/log.js';
import { StError } from '../../src/core/errors.js';

// Synthetic, obviously fake values. Nothing here is a real credential.
const TOKEN = 'fake-refresh-token-0123456789abcdef';
const PEM = ['-----BEGIN PRIVATE KEY-----', 'MIIFAKEKEYLINEONEAAAAAAAAAAAAAAAA', 'MIIFAKEKEYLINETWOBBBBBBBBBBBBBBBB', '-----END PRIVATE KEY-----'].join('\n');

function captureWrites(stream: NodeJS.WriteStream): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('SecretRegistry', () => {
  it('redacts registered values and ignores values shorter than 8 characters', () => {
    const s = createSecretRegistry({ ci: false });
    s.add(TOKEN);
    s.add('short');
    s.add(undefined);
    s.add(null);
    expect(s.redact(`refresh failed for ${TOKEN}!`)).toBe('refresh failed for [redacted]!');
    expect(s.redact('a short value stays')).toBe('a short value stays');
  });

  it('redacts each line of a multi-line key, its JSON-escaped form and its URL-encoded form', () => {
    const s = createSecretRegistry({ ci: false });
    s.add(PEM);
    s.add('pass word/with+specials');
    expect(s.redact('line: MIIFAKEKEYLINETWOBBBBBBBBBBBBBBBB')).toBe('line: [redacted]');
    expect(s.redact(JSON.stringify({ private_key: PEM }))).not.toContain('MIIFAKEKEYLINEONE');
    expect(s.redact(`?p=${encodeURIComponent('pass word/with+specials')}`)).toBe('?p=[redacted]');
  });

  it('redacts bearer tokens, Google access tokens and private key blocks even when unregistered', () => {
    const s = createSecretRegistry({ ci: false });
    expect(s.redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(s.redact('token ya29.a0FakeFakeFake_123')).toBe('token [redacted]');
    expect(s.redact(`key: ${PEM}`)).toBe('key: [redacted private key]');
    expect(s.redact('Basic understanding of the topic')).toBe('Basic understanding of the topic');
  });

  it('assertNoSecret throws StError(internal) without echoing the secret', () => {
    const s = createSecretRegistry({ ci: false });
    s.add(TOKEN);
    expect(() => s.assertNoSecret('{"q":"seo agency"}')).not.toThrow();
    let caught: unknown;
    try {
      s.assertNoSecret(`{"note":"${TOKEN}"}`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StError);
    expect((caught as StError).code).toBe('internal');
    expect((caught as StError).message).not.toContain(TOKEN);
    expect(() => createSecretRegistry({ ci: false }).assertNoSecret('-----BEGIN RSA PRIVATE KEY-----')).toThrow(StError);
  });

  it('announces ::add-mask:: per line in CI only', () => {
    const out = captureWrites(process.stdout);
    try {
      createSecretRegistry({ ci: false }).add(TOKEN);
      expect(out.lines()).toBe('');
      const ci = createSecretRegistry({ ci: true });
      ci.add(PEM);
      ci.add('100%-fake-secret');
      ci.add('100%-fake-secret'); // only once
    } finally {
      out.restore();
    }
    const text = out.lines();
    expect(text).toContain('::add-mask::MIIFAKEKEYLINEONEAAAAAAAAAAAAAAAA\n');
    expect(text).toContain('::add-mask::-----BEGIN PRIVATE KEY-----\n');
    expect(text.match(/::add-mask::100%25-fake-secret\n/g)).toHaveLength(1);
  });
});

describe('Logger', () => {
  let err: ReturnType<typeof captureWrites>;
  let out: ReturnType<typeof captureWrites>;
  const env = { ...process.env };

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.SEARCHTRACE_DEBUG;
    delete process.env.RUNNER_DEBUG;
    err = captureWrites(process.stderr);
    out = captureWrites(process.stdout);
  });
  afterEach(() => {
    err.restore();
    out.restore();
    process.env = { ...env };
  });

  it('writes plain lines to stderr, redacted, and keeps stdout clean', () => {
    const secrets = createSecretRegistry({ ci: false });
    secrets.add(TOKEN);
    const log = createLogger({ quiet: false, ci: false, color: false, secrets });
    log.info(`using ${TOKEN}`);
    log.warn('slow down');
    log.error('it broke');
    expect(err.lines()).toBe('using [redacted]\nWarning: slow down\nError: it broke\n');
    expect(out.lines()).toBe('');
  });

  it('--quiet hides info and debug but never warnings or errors', () => {
    process.env.SEARCHTRACE_DEBUG = '1';
    const log = createLogger({ quiet: true, ci: false, color: false, secrets: createSecretRegistry({ ci: false }) });
    log.info('hidden');
    log.warn('shown');
    expect(err.lines()).toBe('Warning: shown\n');
  });

  it('prints debug lines only when SEARCHTRACE_DEBUG is set', () => {
    const secrets = createSecretRegistry({ ci: false });
    createLogger({ quiet: false, ci: false, color: false, secrets }).debug('nope');
    process.env.SEARCHTRACE_DEBUG = '1';
    createLogger({ quiet: false, ci: false, color: false, secrets }).debug('yes');
    expect(err.lines()).toBe('debug: yes\n');
  });

  it('uses colour only when asked and NO_COLOR is not set', () => {
    const secrets = createSecretRegistry({ ci: false });
    createLogger({ quiet: false, ci: false, color: true, secrets }).warn('w');
    expect(err.lines()).toContain('\x1b[33m');
    process.env.NO_COLOR = '1';
    const before = err.lines().length;
    createLogger({ quiet: false, ci: false, color: true, secrets }).warn('w');
    expect(err.lines().slice(before)).toBe('Warning: w\n');
  });

  it('in CI emits ::warning:: and ::error:: annotations on stdout with escaped data', () => {
    const secrets = createSecretRegistry({ ci: false });
    secrets.add(TOKEN);
    const log = createLogger({ quiet: false, ci: true, color: true, secrets });
    log.warn(`50% of days\nhad ${TOKEN}`);
    log.error('stop');
    log.debug('hidden unless RUNNER_DEBUG');
    expect(out.lines()).toBe('::warning::50%25 of days%0Ahad [redacted]\n::error::stop\n');
    process.env.RUNNER_DEBUG = '1';
    createLogger({ quiet: false, ci: true, color: false, secrets }).debug('now visible');
    expect(out.lines()).toContain('::debug::now visible\n');
  });

  it('draws progress only on a TTY and never in CI', () => {
    const secrets = createSecretRegistry({ ci: false });
    const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    createLogger({ quiet: false, ci: false, color: false, secrets }).progress('Sealing days', 1, 10);
    expect(err.lines()).toBe('');
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    try {
      const log = createLogger({ quiet: false, ci: false, color: false, secrets });
      log.progress('Sealing days', 1, 10);
      log.progress('Sealing days', 2, 10); // throttled
      log.progress('Sealing days', 10, 10); // always drawn when finished
      createLogger({ quiet: false, ci: true, color: false, secrets }).progress('CI', 1, 2);
    } finally {
      if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
    const text = err.lines();
    expect(text).toContain('Sealing days 1 of 10 (10%)');
    expect(text).not.toContain('2 of 10');
    expect(text).toContain('Sealing days 10 of 10 (100%)\n');
    expect(text).not.toContain('CI');
  });
});
