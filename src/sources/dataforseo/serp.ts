// serpCollectCollector and serpPoster (the at-most-once posting protocol, 4.5). Owner: WP-D.
//
// Every run, in order:
//   1. Reconcile (collector): id_list for our tag, resolve unknown intents, cache the answer.
//   2. Collect (collector): tasks_ready for young tasks, task_get for ready or 1 hour old ones,
//      normalise, write one serp partition, append 'collected'.
//   3. Post (poster, after analysis): budget, the week's design, due units, then for each batch
//      of up to 100: append 'intent' (fsync) for every unit, POST once, append the outcome.
//      A POST is never retried. Provably unsent -> 'failed' (eligible again); anything else
//      without a task id -> 'unknown' (reserved until the next reconcile settles it).
// plan() never writes, and with --dry-run it never touches the network either.
// The --wait loop belongs to the pipeline: call serpCollectCollector.plan/execute until
// plan().payload.pendingTaskIds is empty or time runs out (the id_list answer is cached per run).
import { isStError, StError } from '../../core/errors.js';
import { intentKey as makeIntentKey, newRunId } from '../../core/ids.js';
import { rngFor } from '../../core/rng.js';
import { addDays, isoWeek, ptDate, toInstant, weekday } from '../../core/time.js';
import type {
  Collector, CollectorPlan, Config, Device, PartitionMeta, PhaseName, PhaseResult, PlanLine, RunContext, SampleDesignKind,
  SerpCandidate, SerpCollectPlan, SerpObservation, SerpPostPlan, SerpPoster, SpendEvent,
} from '../../core/types.js';
import { layout } from '../../store/layout.js';
import { siteDomainOf } from '../../core/url.js';
import { affordableChecks, budgetFor } from './budget.js';
import { type DfsClient, type DfsEnvelope, PATHS, createDfsClient, dfsLimiters, taskOk, taskPending } from './client.js';
import { resolveLocation } from './locations.js';
import { normalizeSerp } from './normalize.js';
import {
  type DesignEvent, type RemoteTask, type SpendState, cachedRemote, cleanSpendEvents, designOf, fetchOurTasks, isEligible,
  monthSpendUsd, pendingUnknownCount, reconcile, reconcileWindow, rememberRemote, resolveAgainstRemote, spendState, tagFor,
} from './reconcile.js';
import { designSample } from './sample.js';

type DfsConfig = Extract<Config['serp'], { provider: 'dataforseo' }>;

export const BATCH_SIZE = 100;
const HOUR_MS = 3_600_000;
const RESULTS_KEPT_DAYS = 30;

// ---------- shared helpers ----------

function dfsConfig(ctx: RunContext): DfsConfig | null {
  return ctx.config.serp.provider === 'dataforseo' ? ctx.config.serp : null;
}

function credentials(ctx: RunContext, cfg: DfsConfig): { login: string; password: string } | null {
  const login = ctx.env[cfg.loginEnv]?.trim();
  const password = ctx.env[cfg.passwordEnv]?.trim();
  return login && password ? { login, password } : null;
}

function clientFor(ctx: RunContext, cfg: DfsConfig): DfsClient | null {
  const creds = credentials(ctx, cfg);
  if (!creds) return null;
  return createDfsClient({ fetch: ctx.fetch, login: creds.login, password: creds.password, secrets: ctx.secrets, signal: ctx.signal });
}

function missingLoginNote(cfg: DfsConfig): string {
  return `AI Overview checks are on, but ${cfg.loginEnv} and ${cfg.passwordEnv} are not set, so nothing was checked.`;
}

/** $0.0012 for tiny amounts, $0.247 below $1, $1.24 otherwise. */
export function usd(x: number): string {
  const v = Math.max(0, x);
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4).replace(/0+$/, '')}`;
  if (v < 1) {
    const s = v.toFixed(3).replace(/0$/, '');
    return `$${s}`;
  }
  return `$${v.toFixed(2)}`;
}

function newPhase(name: PhaseName, ctx: RunContext): PhaseResult {
  const at = toInstant(ctx.clock.now());
  return { name, status: 'ok', startedAt: at, endedAt: at, requests: {}, rows: 0, costUsd: 0, partitions: [], notes: [], errors: [] };
}

function finish(p: PhaseResult, ctx: RunContext): PhaseResult {
  p.endedAt = toInstant(ctx.clock.now());
  p.costUsd = Math.round(p.costUsd * 1e6) / 1e6;
  return p;
}

function bump(p: PhaseResult, key: string, n = 1): void {
  if (n > 0) p.requests[key] = (p.requests[key] ?? 0) + n;
}

function errorOf(e: unknown, ctx: RunContext): { code: string; message: string } {
  if (isStError(e)) return { code: e.code, message: ctx.secrets.redact(e.message) };
  return { code: 'internal', message: ctx.secrets.redact(e instanceof Error ? e.message : String(e)) };
}

function skipPlan<P>(payload: P, skip: string, lines: PlanLine[] = []): CollectorPlan<P> {
  return { lines, estRequests: 0, estUsd: 0, payload, skip };
}

async function readState(ctx: RunContext): Promise<SpendState> {
  return spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
}

// ---------- collect ----------

/** Posted, uncollected tasks young enough that DataForSEO still holds their results (30 days). */
function pendingTasks(state: SpendState, now: Date): { taskId: string; at: string; intentKey: string }[] {
  return [...state.tasks.values()]
    .filter((t) => !t.collected && now.getTime() - Date.parse(t.at) < RESULTS_KEPT_DAYS * 86_400_000)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.taskId < b.taskId ? -1 : 1))
    .map((t) => ({ taskId: t.taskId, at: t.at, intentKey: t.intentKey }));
}

/** This run's serp partition, or a fresh name (from the clock) when an earlier collection in this run used it. */
async function serpPartitionPath(ctx: RunContext): Promise<string> {
  const first = layout.perRun('serp', ctx.runId, ctx.startedAt);
  if (!(await ctx.store.exists(first))) return first;
  for (let n = 1; n < 1000; n++) {
    const id = newRunId(ctx.clock, rngFor(ctx.runId, `serp-partition|${n}`));
    const rel = layout.perRun('serp', id, toInstant(ctx.clock.now()));
    if (!(await ctx.store.exists(rel))) return rel;
  }
  throw new StError('internal', 'Could not find a free name for the serp partition.');
}

async function collect(ctx: RunContext, client: DfsClient, state: SpendState, phase: PhaseResult): Promise<void> {
  const now = ctx.clock.now();
  const pending = pendingTasks(state, now);
  if (pending.length === 0) return;
  const young = pending.filter((t) => now.getTime() - Date.parse(t.at) < HOUR_MS);
  const ready = new Set<string>();
  if (young.length > 0) {
    try {
      const env = await dfsLimiters().tasksReady.run(() => client.get(PATHS.tasksReady));
      bump(phase, 'dataforseo.tasks_ready');
      for (const t of env.tasks ?? []) {
        for (const r of t.result ?? []) {
          const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : null;
          if (typeof id === 'string') ready.add(id);
        }
      }
    } catch (e) {
      bump(phase, 'dataforseo.tasks_ready');
      if (isStError(e) && e.code === 'auth') throw e;
      phase.notes.push('Could not ask DataForSEO which checks are ready; older ones were fetched directly.');
    }
  }
  const toFetch = pending.filter((t) => ready.has(t.taskId) || now.getTime() - Date.parse(t.at) >= HOUR_MS);
  const siteDomain = siteDomainOf(ctx.config.property);
  const observations: SerpObservation[] = [];
  let notReady = pending.length - toFetch.length;
  let broken = 0;
  await Promise.all(
    toFetch.map((t) =>
      dfsLimiters().taskGet.run(async () => {
        let env: DfsEnvelope;
        try {
          env = await client.get(PATHS.taskGet(t.taskId));
        } catch (e) {
          if (isStError(e) && e.code === 'auth') throw e;
          broken++;
          return;
        } finally {
          bump(phase, 'dataforseo.task_get');
        }
        const task = env.tasks?.[0];
        if (!task) {
          broken++;
          return;
        }
        if (taskPending(task.status_code)) {
          notReady++;
          return;
        }
        if (!taskOk(task.status_code)) {
          broken++;
          return;
        }
        const d = designOf(state, t.intentKey);
        const week = d?.isoWeek ?? isoWeek(ptDate(t.at));
        try {
          const obs = normalizeSerp(task, {
            intentKey: t.intentKey, isoWeek: week, design: d?.design ?? 'census', pi: d?.pi ?? 1, siteDomain,
          });
          observations.push({ ...obs, taskId: obs.taskId || t.taskId });
        } catch {
          broken++;
        }
      }),
    ),
  );
  observations.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.taskId < b.taskId ? -1 : 1));
  if (observations.length > 0) {
    const rel = await serpPartitionPath(ctx);
    const meta: PartitionMeta = {
      kind: 'serp', schema: 1, property: ctx.config.property, toolVersion: ctx.toolVersion, runId: ctx.runId, fetchedAt: toInstant(now),
    };
    const written = await ctx.store.writePartition(rel, meta, observations);
    phase.partitions.push(written.path);
    phase.rows += observations.length;
    const at = toInstant(ctx.clock.now());
    for (const o of observations) {
      await ctx.store.append('spend', { type: 'collected', at, runId: ctx.runId, intentKey: o.intentKey, taskId: o.taskId, partition: written.path } satisfies SpendEvent);
    }
    phase.notes.push(`Collected ${observations.length} AI Overview check${observations.length === 1 ? '' : 's'}.`);
  }
  if (notReady > 0) phase.notes.push(`${notReady} check${notReady === 1 ? ' is' : 's are'} still being processed by DataForSEO and will be collected next run.`);
  // Never fatal (4.7): unread results stay pending and are fetched again next run.
  if (broken > 0) phase.notes.push(`${broken} check${broken === 1 ? '' : 's'} could not be read this time; they will be tried again next run.`);
}

export const serpCollectCollector: Collector<SerpCollectPlan> = {
  name: 'serp_collect',

  async plan(ctx) {
    const now = ctx.clock.now();
    const empty: SerpCollectPlan = { reconcileFrom: toInstant(addMs(now, -8 * 86_400_000)), pendingTaskIds: [] };
    const cfg = dfsConfig(ctx);
    if (!cfg) return skipPlan(empty, 'AI Overview checks are off.');
    if (ctx.flags.offline) return skipPlan(empty, 'Offline run: AI Overview results are not collected.');
    if (!credentials(ctx, cfg)) return skipPlan(empty, missingLoginNote(cfg));
    const state = await readState(ctx);
    const win = reconcileWindow(state, now);
    const pending = pendingTasks(state, now);
    const lines: PlanLine[] = pending.length
      ? [{ group: 'free', label: 'AI Overview results', detail: `${pending.length} check${pending.length === 1 ? '' : 's'} waiting to be collected` }]
      : [];
    return {
      lines,
      estRequests: 1 + (pending.length ? 1 : 0) + pending.length,
      estUsd: 0,
      payload: { reconcileFrom: toInstant(win.from), pendingTaskIds: pending.map((p) => p.taskId) },
      skip: null,
    };
  },

  async execute(plan, ctx) {
    const phase = newPhase('serp_collect', ctx);
    if (plan.skip) {
      phase.status = 'skipped';
      phase.notes.push(plan.skip);
      return finish(phase, ctx);
    }
    const cfg = dfsConfig(ctx);
    const client = cfg ? clientFor(ctx, cfg) : null;
    if (!cfg || !client) {
      phase.status = 'skipped';
      phase.notes.push(cfg ? missingLoginNote(cfg) : 'AI Overview checks are off.');
      return finish(phase, ctx);
    }
    try {
      const rec = await reconcile(ctx, client, { useCache: true });
      bump(phase, 'dataforseo.id_list', rec.requests);
      const found = rec.appended.filter((e) => e.type === 'posted').length;
      const dropped = rec.appended.filter((e) => e.type === 'abandoned').length;
      if (found) phase.notes.push(`Confirmed ${found} earlier check${found === 1 ? '' : 's'} with DataForSEO.`);
      if (dropped) phase.notes.push(`${dropped} earlier request${dropped === 1 ? '' : 's'} never reached DataForSEO and can be sent again.`);
      await collect(ctx, client, rec.state, phase);
    } catch (e) {
      const err = errorOf(e, ctx);
      phase.errors.push(err);
      phase.status = err.code === 'auth' ? 'failed' : 'partial';
      phase.notes.push(err.code === 'auth' ? 'DataForSEO did not accept the login, so no AI Overview results were collected.' : 'AI Overview results could not all be collected; the rest will be tried next run.');
      ctx.log.warn(`AI Overview collection: ${err.message}`);
    }
    return finish(phase, ctx);
  },
};

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

// ---------- post ----------

interface DueUnit { intentKey: string; keyword: string; device: Device; pi: number; design: SampleDesignKind }

function spentThisWeek(state: SpendState, week: string): number {
  let total = 0;
  for (const t of state.tasks.values()) if (isoWeek(ptDate(t.at)) === week) total += Math.max(0, t.costUsd);
  return total;
}

function firstPostingWeek(state: SpendState, week: string): boolean {
  for (const t of state.tasks.values()) if (isoWeek(ptDate(t.at)) < week) return false;
  return true;
}

function dueUnits(design: DesignEvent, state: SpendState, today: string, first: boolean): DueUnit[] {
  const wd = weekday(today);
  return design.units
    .filter((u) => (first || u.weekday <= wd) && isEligible(state.intents.get(u.intentKey)))
    .map((u) => ({ intentKey: u.intentKey, keyword: u.keyword, device: u.device, pi: u.pi, design: u.design }));
}

/** The top country by impressions over the current window (Search Console's lowercase ISO-3). */
function topCountry(ctx: RunContext): string | null {
  const through = ctx.index.dataRange().sealedThrough;
  if (!through) return null;
  const from = addDays(through, -(ctx.config.analysis.windowDays - 1));
  return ctx.index.countryTotals(from, through)[0]?.cc ?? null;
}

async function balanceOf(client: DfsClient): Promise<number | null> {
  const env = await client.get(PATHS.userData);
  const money = (env.tasks?.[0]?.result?.[0] as { money?: { balance?: unknown } } | undefined)?.money;
  return typeof money?.balance === 'number' && Number.isFinite(money.balance) ? money.balance : null;
}

/**
 * A design record. Besides the frozen fields it stores `location`, the Google location and
 * language baked into every intent key of the week, so a mid-week change of top country or
 * config cannot produce intent keys that no longer match the design.
 */
/** The design ledger record; `location` (now part of SpendEvent) pins the week's Google location and language. */
export type StoredDesign = DesignEvent;

function designRecord(
  ctx: RunContext, week: string, budgetUsd: number, mode: 'census' | 'sample', units: ReturnType<typeof designSample>['units'],
  loc: { locationCode: number; languageCode: string },
): StoredDesign {
  return {
    type: 'design', at: toInstant(ctx.clock.now()), runId: ctx.runId, isoWeek: week, budgetUsd: Math.round(budgetUsd * 1e6) / 1e6, mode,
    location: { locationCode: loc.locationCode, languageCode: loc.languageCode },
    units: units.map((u) => ({
      intentKey: makeIntentKey([ctx.config.property, u.keyword, String(loc.locationCode), loc.languageCode, u.device, week]),
      keyword: u.keyword, device: u.device, pi: u.pi, design: u.design, weekday: u.weekday,
    })),
  };
}

function checksDetail(due: DueUnit[], cost: number): string {
  const n = due.length;
  const desktop = due.filter((d) => d.device === 'desktop').length;
  const mobile = n - desktop;
  const total = usd(n * cost);
  const head = desktop === 0 || mobile === 0
    ? `${n} search${n === 1 ? '' : 'es'} x 1 device = ${n} check${n === 1 ? '' : 's'}`
    : `${desktop} desktop + ${mobile} mobile searches = ${n} checks`;
  return `${head} x ${usd(cost)} = ${total} (worst case)`;
}

interface PostContext { cfg: DfsConfig; client: DfsClient | null; state: SpendState; remote: RemoteTask[]; requests: Record<string, number> }

async function postContext(ctx: RunContext, cfg: DfsConfig, network: boolean): Promise<PostContext> {
  const client = network ? clientFor(ctx, cfg) : null;
  const requests: Record<string, number> = {};
  let state = await readState(ctx);
  let remote: RemoteTask[] = [];
  if (client) {
    const cached = cachedRemote(ctx);
    if (cached) remote = cached;
    else {
      const win = reconcileWindow(state, ctx.clock.now());
      const got = await fetchOurTasks(client, ctx.config.property, win.from, win.to);
      requests['dataforseo.id_list'] = got.requests;
      remote = got.tasks;
      rememberRemote(ctx, remote);
    }
    // Apply the resolutions in memory only: plan() never writes.
    const virtual = resolveAgainstRemote(state, remote, ctx.clock.now(), ctx.config.property);
    if (virtual.length) state = spendState([...cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')), ...virtual]);
  }
  return { cfg, client, state, remote, requests };
}

export const serpPoster: SerpPoster = {
  async plan(ctx, candidates) {
    const now = ctx.clock.now();
    const today = ptDate(now);
    const week = isoWeek(today);
    const empty: SerpPostPlan = { isoWeek: week, budgetUsd: 0, design: null, due: [] };
    const cfg = dfsConfig(ctx);
    if (!cfg) {
      return skipPlan(empty, 'AI Overview checks are off. Add a DataForSEO login to turn them on.', [
        { group: 'paid', label: 'AI Overview checks', detail: 'off, add a DataForSEO login to turn them on' },
      ]);
    }
    if (ctx.flags.offline) return skipPlan(empty, 'Offline run: no AI Overview checks were posted.');
    if (ctx.flags.noPaid) return skipPlan(empty, 'Paid checks are off for this run (--no-paid).');
    if (!credentials(ctx, cfg)) return skipPlan(empty, missingLoginNote(cfg));

    const pc = await postContext(ctx, cfg, !ctx.flags.dryRun);
    const cost = cfg.costPerCheckUsd;
    const perRun = ctx.flags.budgetUsd ?? cfg.maxPerRunUsd;
    let balance: number | null = Number.POSITIVE_INFINITY; // a dry run does not ask for the balance
    if (pc.client) {
      try {
        balance = await balanceOf(pc.client);
      } catch {
        balance = null;
      }
      pc.requests['dataforseo.user_data'] = 1;
    }
    const spend = monthSpendUsd(pc.state, pc.remote, now);
    const b = budgetFor({
      monthlyBudgetUsd: cfg.monthlyBudgetUsd, monthSpendUsd: spend, pendingUnknown: pendingUnknownCount(pc.state),
      costPerCheckUsd: cost, perRunCapUsd: perRun, balanceUsd: balance,
    });
    const monthLine: PlanLine = {
      group: 'paid', label: 'This month so far', detail: `${usd(spend)} of your ${usd(cfg.monthlyBudgetUsd)} cap`,
    };
    if (b.availableUsd < cost) {
      const why = balance === null
        ? "DataForSEO's balance could not be read, so nothing was posted."
        : b.limitedBy === 'balance'
          ? `The DataForSEO balance (${usd(balance)}) is below one check.`
          : b.limitedBy === 'per_run'
            ? `The per-run cap (${usd(perRun)}) is below one check.`
            : `This month's AI Overview budget is used up (${usd(spend)} of ${usd(cfg.monthlyBudgetUsd)}).`;
      return skipPlan(empty, why, [monthLine]);
    }

    let design: DesignEvent | null = pc.state.designs.get(week) ?? null;
    let newDesign: DesignEvent | null = null;
    if (!design) {
      const loc = resolveLocation(cfg, topCountry(ctx));
      if (!loc) {
        return skipPlan(empty, 'searchtrace does not know which Google country to check. Set serp.locationCode and serp.languageCode in config.json.');
      }
      const d = designSample(candidates, b.availableUsd + spentThisWeek(pc.state, week), `${ctx.config.property}|${week}`, cost);
      if (d.units.length === 0) return skipPlan(empty, 'No searches qualify for AI Overview checks yet (they need a top 20 position and 10 or more impressions).');
      newDesign = designRecord(ctx, week, b.availableUsd + spentThisWeek(pc.state, week), d.mode, d.units, loc);
      design = newDesign;
    }
    const allDue = dueUnits(design, pc.state, today, firstPostingWeek(pc.state, week));
    const due = allDue.slice(0, affordableChecks(b.availableUsd, cost));
    if (due.length === 0) {
      const why = allDue.length > 0 ? 'Nothing fits the AI Overview budget this run.' : "This week's AI Overview checks are already posted.";
      return skipPlan({ ...empty, budgetUsd: b.availableUsd, design: newDesign }, why, [monthLine]);
    }
    const estUsd = due.length * cost;
    monthLine.detail = `${usd(spend)} of your ${usd(cfg.monthlyBudgetUsd)} cap  ->  ${usd(spend + estUsd)} after this run`;
    return {
      lines: [{ group: 'paid', label: 'AI Overview checks', detail: checksDetail(due, cost) }, monthLine],
      estRequests: Math.ceil(due.length / BATCH_SIZE),
      estUsd,
      payload: { isoWeek: week, budgetUsd: b.availableUsd, design: newDesign, due },
      skip: null,
    };
  },

  async execute(plan, ctx) {
    const phase = newPhase('serp_post', ctx);
    const cfg = dfsConfig(ctx);
    if (plan.skip || ctx.flags.dryRun || ctx.flags.offline || ctx.flags.noPaid || !cfg) {
      phase.status = 'skipped';
      phase.notes.push(plan.skip ?? 'AI Overview checks were not posted this run.');
      return finish(phase, ctx);
    }
    const client = clientFor(ctx, cfg);
    if (!client) {
      phase.status = 'skipped';
      phase.notes.push(missingLoginNote(cfg));
      return finish(phase, ctx);
    }
    try {
      await postAll(plan, ctx, cfg, client, phase);
    } catch (e) {
      const err = errorOf(e, ctx);
      phase.errors.push(err);
      phase.status = err.code === 'auth' ? 'failed' : 'partial';
      ctx.log.warn(`AI Overview checks: ${err.message}`);
    }
    return finish(phase, ctx);
  },
};

type Outcome = { kind: 'posted'; taskId: string; costUsd: number } | { kind: 'failed' | 'unknown'; reason: string };

/** How a whole-batch failure maps to intent outcomes: provably not created -> failed, otherwise unknown. */
function batchFailure(e: unknown): { kind: 'failed' | 'unknown'; reason: string; stop: 'auth' | 'budget' | 'other' } {
  if (isStError(e)) {
    const x = e as StError & { status?: number; dfsCode?: number; notSent?: boolean };
    if (e.code === 'auth') return { kind: 'failed', reason: 'DataForSEO did not accept the login', stop: 'auth' };
    if (e.code === 'budget') return { kind: 'failed', reason: 'DataForSEO balance too low', stop: 'budget' };
    if (e.code === 'network') return { kind: x.notSent ? 'failed' : 'unknown', reason: x.notSent ? 'request never left this machine' : 'no answer after sending', stop: 'other' };
    if (e.code === 'http') {
      if (typeof x.dfsCode === 'number') {
        return x.dfsCode >= 40000 && x.dfsCode < 50000
          ? { kind: 'failed', reason: `DataForSEO refused the request (${x.dfsCode})`, stop: 'other' }
          : { kind: 'unknown', reason: `DataForSEO answered ${x.dfsCode}`, stop: 'other' };
      }
      const status = typeof x.status === 'number' ? x.status : 0;
      return status >= 400 && status < 500
        ? { kind: 'failed', reason: `HTTP ${status}`, stop: 'other' }
        : { kind: 'unknown', reason: status ? `HTTP ${status}` : 'unexpected response', stop: 'other' };
    }
  }
  return { kind: 'unknown', reason: 'unexpected error after sending', stop: 'other' };
}

function outcomesFor(env: DfsEnvelope, batch: { tag: string }[], cost: number): Outcome[] {
  const tasks = env.tasks ?? [];
  const byTag = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) {
    const tag = t.data && typeof t.data.tag === 'string' ? t.data.tag : null;
    if (tag && !byTag.has(tag)) byTag.set(tag, t);
  }
  const allTagged = tasks.length > 0 && tasks.every((t) => t.data && typeof t.data.tag === 'string');
  return batch.map((u, k): Outcome => {
    const t = byTag.get(u.tag) ?? (allTagged ? undefined : tasks[k]);
    if (!t) return { kind: 'unknown', reason: 'missing from the response' };
    if (taskOk(t.status_code) && typeof t.id === 'string' && t.id) {
      return { kind: 'posted', taskId: t.id, costUsd: typeof t.cost === 'number' && Number.isFinite(t.cost) ? t.cost : cost };
    }
    if (t.status_code >= 40000 && t.status_code < 50000) {
      return { kind: 'failed', reason: `${t.status_code} ${(t.status_message ?? '').slice(0, 120)}`.trim() };
    }
    return { kind: 'unknown', reason: `task answered ${t.status_code}` };
  });
}

async function postAll(plan: CollectorPlan<SerpPostPlan>, ctx: RunContext, cfg: DfsConfig, client: DfsClient, phase: PhaseResult): Promise<void> {
  const now = ctx.clock.now();
  const today = ptDate(now);
  const week = plan.payload.isoWeek;
  const cost = cfg.costPerCheckUsd;

  // Authoritative re-check right before spending: settle unknowns, read the balance, recompute A.
  const rec = await reconcile(ctx, client, { useCache: true });
  bump(phase, 'dataforseo.id_list', rec.requests);
  let state = rec.state;
  let balance: number | null = null;
  try {
    balance = await balanceOf(client);
  } catch (e) {
    if (isStError(e) && e.code === 'auth') throw e;
  }
  bump(phase, 'dataforseo.user_data');
  const spend = monthSpendUsd(state, rec.remote, now);
  const b = budgetFor({
    monthlyBudgetUsd: cfg.monthlyBudgetUsd, monthSpendUsd: spend, pendingUnknown: pendingUnknownCount(state),
    costPerCheckUsd: cost, perRunCapUsd: ctx.flags.budgetUsd ?? cfg.maxPerRunUsd, balanceUsd: balance,
  });
  const allowed = Math.min(affordableChecks(b.availableUsd, cost), affordableChecks(plan.payload.budgetUsd, cost));
  if (allowed === 0) {
    phase.status = 'skipped';
    phase.notes.push(balance === null ? "DataForSEO's balance could not be read, so no AI Overview checks were posted." : 'The AI Overview budget is used up for now; nothing was posted.');
    return;
  }

  let design: StoredDesign | null = state.designs.get(week) ?? null;
  if (!design && plan.payload.design && plan.payload.design.isoWeek === week) {
    await ctx.store.append('spend', plan.payload.design);
    design = plan.payload.design;
    state = spendState(cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')));
  }
  if (!design) {
    phase.status = 'skipped';
    phase.notes.push('No AI Overview design for this week yet.');
    return;
  }
  const allDue = dueUnits(design, state, today, firstPostingWeek(state, week));
  const due = allDue.slice(0, allowed);
  if (due.length === 0) {
    phase.status = 'skipped';
    phase.notes.push("This week's AI Overview checks are already posted.");
    return;
  }
  const loc = locationOfDesign(design, ctx, cfg);

  let posted = 0;
  let failed = 0;
  let unknown = 0;
  let stop: 'auth' | 'budget' | 'other' | null = null;
  for (let i = 0; i < due.length && !stop; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE).map((u) => ({ ...u, tag: tagFor(ctx.config.property, u.intentKey) }));
    // 1. Intent first, fsynced, so a crash after this point is settled by the next reconcile.
    for (const u of batch) {
      await ctx.store.append('spend', { type: 'intent', at: toInstant(ctx.clock.now()), runId: ctx.runId, intentKey: u.intentKey, tag: u.tag, estUsd: cost } satisfies SpendEvent);
    }
    // 2. One POST, never retried.
    const body = batch.map((u) => ({
      keyword: u.keyword, location_code: loc.locationCode, language_code: loc.languageCode, device: u.device,
      os: u.device === 'desktop' ? 'windows' : 'android', depth: 10, priority: 1, load_async_ai_overview: true, tag: u.tag,
    }));
    let outcomes: Outcome[];
    try {
      const env = await client.post(PATHS.taskPost, body, { idempotent: false });
      outcomes = outcomesFor(env, batch, cost);
    } catch (e) {
      // Any whole-batch failure ends posting for this run; later batches wait for the next run.
      const f = batchFailure(e);
      outcomes = batch.map(() => ({ kind: f.kind, reason: f.reason }));
      stop = f.stop;
      if (f.stop === 'auth') phase.errors.push({ code: 'auth', message: 'DataForSEO did not accept the login.' });
      if (f.stop === 'budget') {
        phase.notes.push('DataForSEO says the balance is too low. Top it up to keep checking AI Overviews.');
        ctx.log.warn('DataForSEO says the balance is too low, so no AI Overview checks were posted.');
      }
    } finally {
      bump(phase, 'dataforseo.task_post');
    }
    // 3. The outcome of every intent.
    const at = toInstant(ctx.clock.now());
    for (let k = 0; k < batch.length; k++) {
      const u = batch[k];
      const o = outcomes[k];
      if (o.kind === 'posted') {
        await ctx.store.append('spend', { type: 'posted', at, runId: ctx.runId, intentKey: u.intentKey, tag: u.tag, taskId: o.taskId, costUsd: o.costUsd } satisfies SpendEvent);
        posted++;
        phase.costUsd += o.costUsd;
      } else {
        await ctx.store.append('spend', { type: o.kind, at, runId: ctx.runId, intentKey: u.intentKey, tag: u.tag, reason: o.reason } satisfies SpendEvent);
        if (o.kind === 'failed') failed++;
        else unknown++;
      }
    }
  }
  phase.rows = posted;
  if (posted) phase.notes.push(`Posted ${posted} AI Overview check${posted === 1 ? '' : 's'} (${usd(phase.costUsd)}). Results arrive by the next run.`);
  phase.notes.push(`AI Overview spend this month: ${usd(spend + phase.costUsd)} of ${usd(cfg.monthlyBudgetUsd)}.`);
  if (allDue.length > due.length) phase.notes.push(`${allDue.length - due.length} more check${allDue.length - due.length === 1 ? '' : 's'} wait for budget in a later run.`);
  if (unknown) phase.notes.push(`${unknown} request${unknown === 1 ? '' : 's'} got no clear answer; the next run checks with DataForSEO before sending anything again.`);
  if (failed) phase.notes.push(`${failed} check${failed === 1 ? '' : 's'} could not be posted and will be tried again.`);
  // A low balance is a warning, not a failure (D18); the intents stay eligible for the next run.
  if (stop === 'auth') phase.status = 'failed';
  else if (unknown || (failed && stop !== 'budget')) phase.status = 'partial';
}

/** The location baked into this week's intent keys: stored on the design, else re-derived. */
function locationOfDesign(design: StoredDesign, ctx: RunContext, cfg: DfsConfig): { locationCode: number; languageCode: string } {
  const stored = design.location;
  if (stored && Number.isInteger(stored.locationCode) && typeof stored.languageCode === 'string') return stored;
  const loc = resolveLocation(cfg, topCountry(ctx));
  if (loc) return loc;
  throw new StError('config', 'searchtrace does not know which Google country to check.', 'Set serp.locationCode and serp.languageCode in config.json.');
}
