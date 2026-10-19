// SecretRegistry: register values, redact text, assertNoSecret(line). Owner: WP-A.
//
// Every key, password, refresh token and access token is registered here as soon as it is
// read. The logger redacts registered values from every line, and the store refuses to write
// a partition, ledger or file line that contains one. In CI each value is also announced with
// ::add-mask:: so GitHub hides it from the job log.
import { StError } from './errors.js';
import type { SecretRegistry } from './types.js';

const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';

// Shapes that are secrets whether or not anyone registered them.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const GOOGLE_ACCESS_TOKEN = /\bya29\.[A-Za-z0-9._-]{8,}/g;

/**
 * Third-party text (a competitor's page title in a SERP) that quotes a PEM header would trip the
 * store's key guard and sink a whole partition. Rewriting the marker keeps the text readable while
 * the stored line no longer looks like a key. assertNoSecret itself is never relaxed.
 */
export function defangUntrusted(s: string): string {
  return s.replace(/-----(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY)-----/g, '[$1 $2]');
}

/** GitHub workflow command data escaping. */
function escapeCommandData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function variantsOf(value: string): string[] {
  const out = new Set<string>([value, value.trim(), JSON.stringify(value).slice(1, -1)]);
  try {
    out.add(encodeURIComponent(value));
  } catch {
    // lone surrogates cannot be URI-encoded; the raw value is still registered
  }
  // A multi-line secret (a PEM key) can leak one line at a time.
  for (const line of value.split(/\r?\n|\\n/)) out.add(line.trim());
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export function createSecretRegistry(o: { ci: boolean }): SecretRegistry {
  const known = new Set<string>();
  let longestFirst: string[] = [];

  return {
    add(value: string | undefined | null): void {
      if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
      let changed = false;
      for (const v of variantsOf(value)) {
        if (known.has(v)) continue;
        known.add(v);
        changed = true;
      }
      if (!changed) return;
      longestFirst = [...known].sort((a, b) => b.length - a.length);
      if (o.ci) {
        for (const line of value.split(/\r?\n/).map((l) => l.trim())) {
          if (line.length >= MIN_SECRET_LENGTH) process.stdout.write(`::add-mask::${escapeCommandData(line)}\n`);
        }
      }
    },

    redact(text: string): string {
      let out = String(text);
      for (const v of longestFirst) if (out.includes(v)) out = out.split(v).join(REDACTED);
      return out
        .replace(PRIVATE_KEY_BLOCK, '[redacted private key]')
        .replace(BEARER, `Bearer ${REDACTED}`)
        .replace(GOOGLE_ACCESS_TOKEN, REDACTED);
    },

    assertNoSecret(line: string): void {
      const s = String(line);
      if (PRIVATE_KEY_MARKER.test(s) || longestFirst.some((v) => s.includes(v))) {
        // Never echo the line: it holds the secret.
        throw new StError(
          'internal',
          'Refusing to save data that contains a key or token. This is a bug in searchtrace; please report it without pasting the data.',
        );
      }
    },
  };
}
