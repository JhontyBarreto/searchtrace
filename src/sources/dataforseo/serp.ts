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
import { affordableChecks, budgetFor, planningPrice } from './budget.js';
import { type DfsClient, type DfsEnvelope, PATHS, createDfsClient, dfsLimiters, taskOk, taskPending } from './client.js';
import { resolveLocation } from './locations.js';
import { normalizeSerp } from './normalize.js';
import {
  type DesignEvent, type RemoteTask, type SpendState, cleanSpendEvents, designOf, isEligible,
  monthSpendUsd, pendingUnknownCount, reconcile, reconcileWindow, resolveIntents, spendState, sweep, tagFor,
} from './reconcile.js';
import { designSample, hasSearchOperator } from './sample.js';

type DfsConfig = Extract<Config['serp'], { provider: 'dataforseo' }>;

export const BATCH_SIZE = 100;
/** The first batch of a run is small, so a price above the planned one shows before much is spent. */
export const PROBE_BATCH = 10;
const HOUR_MS = 3_600_000;
const RESULTS_KEPT_DAYS = 30;
/** task_get codes that are final: the task will never have a result. */
const TERMINAL_TASK_CODES = new Set([40102, 40400, 40401, 40501, 40503]);
/** Any other failure on a task this old is treated as final too (tasks finish in minutes). */
const SETTLE_AFTER_MS = 72 * HOUR_MS;
const INCOMPLETE_SWEEP_NOTE = "DataForSEO's task list was too long to read in full, so this month's spend counts this folder's own records plus what could be read.";
const RESERVED_NOTE = (n: number): string =>
  `DataForSEO's task list was too long to confirm ${n} earlier check${n === 1 ? '' : 's'}; ${n === 1 ? 'it stays' : 'they stay'} reserved and won't be sent again.`;

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

/** Posted tasks with no result yet and no final error, young enough that DataForSEO still holds their results (30 days). */
function pendingTasks(state: SpendState, now: Date): { taskId: string; at: string; intentKey: string; runId: string }[] {
  return [...state.tasks.values()]
    .filter((t) => !t.collected && !t.unavailable && now.getTime() - Date.parse(t.at) < RESULTS_KEPT_DAYS * 86_400_000)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.taskId < b.taskId ? -1 : 1))
    .map((t) => ({ taskId: t.taskId, at: t.at, intentKey: t.intentKey, runId: t.runId }));
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
  const settle: { taskId: string; intentKey: string; reason: string }[] = [];
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
        const old = now.getTime() - Date.parse(t.at) >= SETTLE_AFTER_MS;
        if (!taskOk(task.status_code)) {
          // A final answer (40102 No Search Results and the like) is settled at once, anything else once the task is old.
          if (TERMINAL_TASK_CODES.has(task.status_code) || old) {
            settle.push({ taskId: t.taskId, intentKey: t.intentKey, reason: `${task.status_code} ${(task.status_message ?? '').slice(0, 120)}`.trim() });
          } else broken++;
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
          if (old) settle.push({ taskId: t.taskId, intentKey: t.intentKey, reason: 'the result could not be read' });
          else broken++;
        }
      }),
    ),
  );
  observations.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.taskId < b.taskId ? -1 : 1));
  // Backstop, one row at a time like the crawler: a row the store's key guard would refuse is left
  // out (and settled), so one odd result can never sink the whole paid batch.
  const kept: SerpObservation[] = [];
  let refused = 0;
  for (const o of observations) {
    try {
      ctx.secrets.assertNoSecret(JSON.stringify(o));
      kept.push(o);
    } catch {
      refused++;
      settle.push({ taskId: o.taskId, intentKey: o.intentKey, reason: 'the result contained text that looks like a key' });
    }
  }
  observations.length = 0;
  observations.push(...kept);
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
  if (settle.length > 0) {
    const at = toInstant(ctx.clock.now());
    for (const x of settle) {
      await ctx.store.append('spend', { type: 'unavailable', at, runId: ctx.runId, intentKey: x.intentKey, taskId: x.taskId, reason: x.reason } satisfies SpendEvent);
    }
    const final = settle.length - refused;
    if (final > 0) {
      const reasons = [...new Set(settle.slice(0, 3).map((x) => x.reason))].join('; ');
      phase.notes.push(`DataForSEO had no result for ${final} check${final === 1 ? '' : 's'} (${reasons}); ${final === 1 ? 'it' : 'they'} won't be retried.`);
    }
    if (refused > 0) phase.notes.push(`${refused} AI Overview result${refused === 1 ? '' : 's'} contained text that looks like a key and ${refused === 1 ? 'was' : 'were'} not saved.`);
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
      payload: {
        reconcileFrom: toInstant(win.from), pendingTaskIds: pending.map((p) => p.taskId),
        thisRunTaskIds: pending.filter((p) => p.runId === ctx.runId).map((p) => p.taskId),
      },
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
      const dropped = rec.appended.filter((e) => e.type === 'abandoned' && !e.unconfirmed).length;
      const unconfirmed = rec.appended.filter((e) => e.type === 'abandoned' && e.unconfirmed).length;
      if (found) phase.notes.push(`Confirmed ${found} earlier check${found === 1 ? '' : 's'} with DataForSEO.`);
      if (dropped) phase.notes.push(`${dropped} earlier request${dropped === 1 ? '' : 's'} never reached DataForSEO and can be sent again.`);
      if (unconfirmed) phase.notes.push(`${unconfirmed} earlier check${unconfirmed === 1 ? '' : 's'} could not be confirmed before ${unconfirmed === 1 ? 'its' : 'their'} week ended; the cost is counted as spent.`);
      if (rec.stillReserved) phase.notes.push(RESERVED_NOTE(rec.stillReserved));
      if (!rec.complete) phase.notes.push(INCOMPLETE_SWEEP_NOTE);
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
    const sw = await sweep(ctx, client, { useCache: true });
    remote = sw.snapshot.tasks;
    // Apply the resolutions in memory only: plan() never writes. Old unresolved intents get a fresh, narrow lookup.
    const r = await resolveIntents(ctx, client, state, sw.snapshot);
    if (sw.requests + r.requests) requests['dataforseo.id_list'] = sw.requests + r.requests;
    if (r.events.length) state = spendState([...cleanSpendEvents(await ctx.store.readLedger<unknown>('spend')), ...r.events]);
  }
  return { cfg, client, state, remote, requests };
}

/**
 * The price to plan with: the configured one (never below $0.0012), raised to the 90th percentile
 * of the last 200 real charges. Operator searches (billed at 5x, now never posted) are ignored, so
 * one old outlier can't cut a month of checks.
 */
export function priceFor(state: SpendState, configured: number): number {
  const recent = [...state.tasks.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 200);
  const costs: number[] = [];
  for (const t of recent) {
    const kw = designOf(state, t.intentKey)?.keyword;
    if (kw !== undefined && hasSearchOperator(kw)) continue;
    if (t.costUsd > 0) costs.push(t.costUsd);
  }
  const floor = planningPrice(configured);
  if (costs.length < 10) return floor;
  costs.sort((a, b) => a - b);
  return Math.max(floor, costs[Math.ceil(0.9 * costs.length) - 1]);
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
    const cost = priceFor(pc.state, cfg.costPerCheckUsd);
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
    if (e.code === 'budget') return { kind: 'failed', reason: e.message.replace(/^DataForSEO says /, '').replace(/\.$/, ''), stop: 'budget' };
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

  // Authoritative re-check right before spending: settle unknowns (old ones with a fresh lookup),
  // read the balance, recompute A.
  const rec = await reconcile(ctx, client, { useCache: true });
  bump(phase, 'dataforseo.id_list', rec.requests);
  let state = rec.state;
  const cost = priceFor(state, cfg.costPerCheckUsd);
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
  // The cap holds against what DataForSEO really bills: spent counts real charges (and the planned
  // price for any answer we never saw), each batch is sized from what is left at the highest price
  // seen so far, and the first batch is a small probe.
  const cap = Math.min(b.availableUsd, plan.payload.budgetUsd);
  let spent = 0;
  let runPrice = cost;
  let sent = 0;
  while (sent < due.length && !stop) {
    const room = affordableChecks(cap - spent, runPrice);
    const n = Math.min(sent === 0 ? PROBE_BATCH : BATCH_SIZE, room, due.length - sent);
    if (n <= 0) break;
    const batch = due.slice(sent, sent + n).map((u) => ({ ...u, tag: tagFor(ctx.config.property, u.intentKey) }));
    sent += n;
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
        const err = e as StError;
        phase.notes.push(`${err.message} ${err.fix ?? ''}`.trim());
        ctx.log.warn(`${err.message} No more AI Overview checks were posted this run.`);
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
        spent += o.costUsd;
        runPrice = Math.max(runPrice, o.costUsd);
      } else {
        await ctx.store.append('spend', { type: o.kind, at, runId: ctx.runId, intentKey: u.intentKey, tag: u.tag, reason: o.reason } satisfies SpendEvent);
        if (o.kind === 'failed') failed++;
        else {
          unknown++;
          spent += runPrice; // it may have been charged
        }
      }
    }
  }
  phase.rows = posted;
  if (runPrice > cost + 1e-12) {
    phase.notes.push(`DataForSEO billed ${usd(runPrice)} per check, above the ${usd(cost)} searchtrace plans with; posting stopped at the cap.`);
  }
  if (posted) phase.notes.push(`Posted ${posted} AI Overview check${posted === 1 ? '' : 's'} (${usd(phase.costUsd)}). Results arrive by the next run.`);
  phase.notes.push(`AI Overview spend this month: ${usd(spend + phase.costUsd)} of ${usd(cfg.monthlyBudgetUsd)}.`);
  const waiting = allDue.length - sent;
  if (waiting > 0 && !stop) phase.notes.push(`${waiting} more check${waiting === 1 ? '' : 's'} wait for budget in a later run.`);
  if (!rec.complete) phase.notes.push(INCOMPLETE_SWEEP_NOTE);
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
