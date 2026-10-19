// RunContext factory: store, index, auth, clock, fetch, logger, secrets. Owner: WP-F.
import { loadConfig } from '../core/config.js';
import { StError } from '../core/errors.js';
import { newRunId } from '../core/ids.js';
import { rngFor } from '../core/rng.js';
import { createLogger } from '../core/log.js';
import { toolVersion } from '../core/install.js';
import { createSecretRegistry } from '../core/secrets.js';
import { systemClock } from '../core/time.js';
import type {
  Clock, Fetch, GoogleAuth, Instant, Logger, PhaseName, PipelineOptions, RunContext, SecretRegistry,
} from '../core/types.js';
import { openIndex } from '../index/db.js';
import { layout, resolveInside } from '../store/layout.js';
import { openStore } from '../store/store.js';
import { loadGoogleAuth } from '../sources/google/auth.js';

/** Optional extras on top of the 2.4 PipelineOptions, for the CLI and tests. */
export interface PipelineExtras {
  log?: Logger;
  secrets?: SecretRegistry;
  quiet?: boolean;
  color?: boolean;
  signal?: AbortSignal;
  toolVersion?: string;
  /** Waits between AI Overview polls (--wait). Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called as each phase starts, for progress output. */
  onPhase?: (name: PhaseName) => void;
  /** Host lookups for the crawler's private-address check (the CLI passes real DNS). */
  resolveHost?: (host: string) => Promise<string[]>;
}
export type PipelineInput = PipelineOptions & PipelineExtras;

// The running package version lives in core so hints anywhere can name the release.
export { toolVersion };

/** UTC instant with second precision. */
export function instantOf(d: Date): Instant {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function createRunContext(o: PipelineInput): Promise<RunContext> {
  const flags = o.flags;
  const clock: Clock = o.clock ?? systemClock;
  const env = o.env ?? process.env;
  const secrets = o.secrets ?? createSecretRegistry({ ci: flags.ci });
  const log = o.log ?? createLogger({ quiet: o.quiet ?? false, ci: flags.ci, color: o.color ?? false, secrets });
  const config = await loadConfig(o.dir);
  const store = await openStore(o.dir, secrets);
  const index = await openIndex(resolveInside(store.root, layout.index));
  const fetchFn: Fetch = o.fetch ?? globalThis.fetch;
  return {
    // The demo runs on a fixed clock; a seeded suffix makes its run id, and so every path it
    // writes, the same on each run (byte-identical demo folders).
    runId: o.demo ? newRunId(clock, rngFor('searchtrace-demo', 'run-id')) : newRunId(clock),
    startedAt: instantOf(clock.now()),
    toolVersion: o.toolVersion ?? toolVersion(),
    config,
    store,
    index,
    clock,
    fetch: fetchFn,
    log,
    secrets,
    signal: o.signal ?? new AbortController().signal,
    flags,
    google: null,
    env,
    ...(o.resolveHost ? { resolveHost: o.resolveHost } : {}),
  };
}

/** Loads the Google credential. Never throws: the error is returned for the phases that need it. */
export async function connectGoogle(ctx: RunContext): Promise<{ google: GoogleAuth | null; error: StError | null }> {
  try {
    const google = await loadGoogleAuth({
      config: ctx.config,
      env: ctx.env,
      fetch: ctx.fetch,
      secrets: ctx.secrets,
      ...(ctx.flags.credentials ? { credentialsOverride: ctx.flags.credentials } : {}),
    });
    return { google, error: null };
  } catch (e) {
    if (e instanceof StError) return { google: null, error: e };
    return { google: null, error: new StError('auth', `Could not load Google credentials: ${ctx.secrets.redact((e as Error)?.message ?? String(e))}`) };
  }
}
