// Phase orchestration (4.9), dry-run planning, ledger start and end, exit code. Owner: WP-F.
//
// Every phase runs inside its own failure boundary: a failed phase is recorded with a redacted
// error and its fix line, and later phases carry on with the data already on disk. Exit codes
// follow D18: 0 ok (a budget cap or a quota stop is a warning), 3 auth or permission, 2 config,
// 4 partial (some phase failed, the report was still written). Errors before the run starts
// (config, lock) are thrown to the caller.
import { appendFile } from 'node:fs/promises';
import { configHash } from '../core/config.js';
import { StError, ExitCode } from '../core/errors.js';
import { newRunId } from '../core/ids.js';
import { rngFor } from '../core/rng.js';
import { clusterTemplates } from '../core/templates.js';
import { toInstant } from '../core/time.js';
import { cli } from '../core/install.js';
import { siteDomainOf, defaultOrigins, normalizeUrl } from '../core/url.js';
import type {
  AnalysisOutput, Collector, Config, ErrorCode, ExitCodeName, Finding, GoogleEvent, GraphDoc, IndexReader, PhaseName,
  PhaseResult, PipelineOptions, PlanLine, RunContext, RunSummary, SiteChange,
} from '../core/types.js';
import { layout, resolveInside } from '../store/layout.js';
import { acquireLock } from '../store/lock.js';
import { runAnalysis } from '../analyze/index.js';
import { buildGraph } from '../graph/build.js';
import { writeGraph } from '../graph/write.js';
import { answerSentences, findingSentence } from '../report/copy.js';
import { truncate } from '../report/format.js';
import { renderReports } from '../report/html.js';
import { canonicalString } from '../report/json.js';
import { deriveSiteChanges } from '../sources/crawl/diff.js';
import { crawlCollector } from '../sources/crawl/crawl.js';
import { serpCollectCollector, serpPoster } from '../sources/dataforseo/serp.js';
import { gscCollector } from '../sources/google/gsc.js';
import { inspectionCollector } from '../sources/google/inspection.js';
import { loadSeedEvents, updatesCollector } from '../sources/google/updates.js';
import { connectGoogle, createRunContext, instantOf, type PipelineInput } from './context.js';

const STEP_SUMMARY_MAX = 1024 * 1024;
const WAIT_POLL_MS = 30_000;

export const PHASE_LABEL: Record<PhaseName, string> = {
  lock: 'Lock', updates: 'Google updates', gsc: 'Search Console', index: 'Index', crawl: 'Your pages', inspect: 'Index checks',
  serp_collect: 'AI Overview results', analyze: 'Analysis', serp_post: 'AI Overview checks', report: 'Report', graph: 'Graph',
};

// ---------- phase results ----------

function blank(name: PhaseName, ctx: RunContext, startedAt: string): PhaseResult {
  return {
    name, status: 'ok', startedAt, endedAt: instantOf(ctx.clock.now()), requests: {}, rows: 0, costUsd: 0, partitions: [], notes: [], errors: [],
  };
}

export function skippedPhase(name: PhaseName, ctx: RunContext, note: string): PhaseResult {
  const at = instantOf(ctx.clock.now());
  return { ...blank(name, ctx, at), status: 'skipped', notes: [note] };
}

/** The phase result for a thrown error: redacted message, fix line as a note. */
export function failedPhase(name: PhaseName, ctx: RunContext, startedAt: string, e: unknown): PhaseResult {
  const err = e instanceof StError ? e : null;
  const code: string = err?.code ?? 'internal';
  const raw = err ? err.message : `Unexpected problem: ${(e as Error)?.message ?? String(e)}`;
  const notes = err?.fix ? [ctx.secrets.redact(err.fix)] : [];
  return { ...blank(name, ctx, startedAt), status: 'failed', notes, errors: [{ code, message: ctx.secrets.redact(raw) }] };
}

async function boundary(ctx: RunContext, name: PhaseName, body: () => Promise<PhaseResult>, onPhase?: (n: PhaseName) => void): Promise<PhaseResult> {
  const startedAt = instantOf(ctx.clock.now());
  onPhase?.(name);
  try {
    const r = await body();
    return { ...r, name };
  } catch (e) {
    const r = failedPhase(name, ctx, startedAt, e);
    ctx.log.warn(`${PHASE_LABEL[name]}: ${r.errors[0].message}${r.notes[0] ? ` ${r.notes[0]}` : ''}`);
    return r;
  }
}

async function collect<P>(ctx: RunContext, c: Collector<P>): Promise<PhaseResult> {
  const plan = await c.plan(ctx);
  if (plan.skip) return skippedPhase(c.name, ctx, plan.skip);
  return c.execute(plan, ctx);
}

/** D18: auth beats config beats partial; a budget stop or a partial phase is only a warning. */
export function exitFor(phases: PhaseResult[]): ExitCodeName {
  let auth = false;
  let config = false;
  let partial = false;
  for (const ph of phases) {
    if (ph.status !== 'failed') continue;
    if (!ph.errors.length) partial = true;
    for (const e of ph.errors) {
      const exit = new StError(e.code as ErrorCode, '').exit;
      if (exit === ExitCode.AUTH) auth = true;
      else if (exit === ExitCode.CONFIG) config = true;
      else if (exit !== ExitCode.OK) partial = true;
    }
  }
  return auth ? 'auth' : config ? 'config' : partial ? 'partial' : 'ok';
}

// ---------- analysis ----------

function mergeEvents(stored: GoogleEvent[], seed: GoogleEvent[]): GoogleEvent[] {
  const byId = new Map<string, GoogleEvent>();
  for (const e of [...seed, ...stored]) {
    const prev = byId.get(e.id);
    if (!prev || (e.modified ?? '') >= (prev.modified ?? '')) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The reader with the bundled Google update seed merged into googleEvents() (4.6: offline uses stored + seed). */
export function withSeedEvents(db: IndexReader): IndexReader {
  let seed: GoogleEvent[] = [];
  try {
    seed = loadSeedEvents();
  } catch {
    seed = [];
  }
  if (!seed.length) return db;
  const merged = mergeEvents(db.googleEvents(), seed);
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'googleEvents') return () => merged;
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function homepageSiteName(db: IndexReader, config: Config): string | null {
  const origins = config.siteOrigin ? [normalizeUrl(config.siteOrigin)] : defaultOrigins(config.property);
  const fields = db.fieldsByHash();
  const snaps = db.snapshots({ urls: origins }).filter((s) => s.fieldsHash).sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
  for (const s of snaps) {
    const name = fields.get(s.fieldsHash as string)?.siteName;
    if (name) return name;
  }
  return null;
}

/** Runs the whole analysis over the index. Null when no day is sealed yet. Notes collect soft failures. */
export function analyzeIndex(db: IndexReader, config: Config, notes: string[] = []): AnalysisOutput | null {
  const dataThrough = db.dataRange().sealedThrough;
  if (!dataThrough) return null;
  const stored = db.property();
  if (stored && stored !== config.property) {
    throw new StError('config', `This folder holds data for ${stored}, but config.json says ${config.property}.`,
      'Use a separate --dir for each property, or put the original property back in config.json.');
  }
  const reader = withSeedEvents(db);
  let siteChanges: SiteChange[] = [];
  try {
    const templates = clusterTemplates(reader.pages().map((p) => p.url), config.analysis.templateOverrides);
    siteChanges = deriveSiteChanges({
      snapshots: reader.snapshots(), fieldsByHash: reader.fieldsByHash(), annotations: reader.annotations(),
      inspections: reader.inspections(), templates,
    });
  } catch (e) {
    notes.push(`Site changes could not be worked out this time (${(e as Error)?.message ?? String(e)}), so none are used.`);
  }
  let siteName: string | null = null;
  try {
    siteName = homepageSiteName(reader, config);
  } catch {
    siteName = null;
  }
  return runAnalysis({
    property: config.property, siteDomain: siteDomainOf(config.property), dataThrough, db: reader, config, siteChanges, siteName,
  });
}

/** Writes a findings partition only when the findings differ from the latest one (4.1). */
async function writeFindingsIfChanged(ctx: RunContext, out: AnalysisOutput): Promise<string | null> {
  const files = (await ctx.store.list('findings/')).filter((f) => f.path.endsWith('.ndjson.gz'));
  const content = canonicalString(out.findings);
  const last = files[files.length - 1];
  if (last) {
    try {
      const prev = await ctx.store.readPartition<Finding>(last.path);
      if (canonicalString(prev.rows) === content) return null;
    } catch {
      // unreadable: write a fresh one
    }
  }
  const rel = await findingsPartitionPath(ctx);
  await ctx.store.writePartition(rel, {
    kind: 'findings', schema: 1, property: ctx.config.property, toolVersion: ctx.toolVersion, runId: ctx.runId,
    fetchedAt: toInstant(ctx.clock.now()), day: out.dataThrough,
  }, out.findings);
  return rel;
}

/**
 * This run's findings partition, or, when this run already wrote one (the re-analysis after
 * --wait collected AI Overview results), a fresh name from the current clock. Run ids start with
 * their UTC time, so path order stays time order and the newest findings replay last.
 */
async function findingsPartitionPath(ctx: RunContext): Promise<string> {
  const first = layout.perRun('findings', ctx.runId, ctx.startedAt);
  if (!(await ctx.store.exists(first))) return first;
  for (let n = 1; n < 1000; n++) {
    const id = newRunId(ctx.clock, rngFor(ctx.runId, `findings-partition|${n}`));
    const rel = layout.perRun('findings', id, toInstant(ctx.clock.now()));
    if (!(await ctx.store.exists(rel))) return rel;
  }
  throw new StError('internal', 'Could not find a free name for the findings partition.');
}

function parseGraph(text: string | null): GraphDoc | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text, (k, x: unknown) => (k === '__proto__' ? undefined : x)) as GraphDoc;
    return v && Array.isArray(v.nodes) ? v : null;
  } catch {
    return null;
  }
}

/** The graph label for a finding: its sentence, at most 120 characters. */
export function graphLabel(f: Finding): string {
  try {
    return truncate(findingSentence(f), 120);
  } catch {
    return truncate(f.unit.label, 120);
  }
}

// ---------- the run ----------

interface RunState {
  phases: PhaseResult[];
  out: AnalysisOutput | null;
  reportPath: string | null;
  graphPath: string | null;
  /** The index failed to load even after a retry: analysis still runs, but nothing it says is saved. */
  indexBroken?: boolean;
}

const INDEX_BROKEN_NOTE = "The search index didn't load completely, so this run's findings were not saved and the last report was kept.";

function summary(ctx: RunContext, st: RunState, plan: PlanLine[] | null): RunSummary {
  return {
    runId: ctx.runId,
    exit: exitFor(st.phases),
    phases: st.phases,
    dataThrough: st.out?.dataThrough ?? ctx.index.dataRange().sealedThrough ?? null,
    headline: st.out ? answerSentences(st.out).sentence : null,
    reportPath: st.reportPath,
    graphPath: st.graphPath,
    spendUsd: st.phases.reduce((s, p) => s + (Number.isFinite(p.costUsd) ? p.costUsd : 0), 0),
    plan,
  };
}

async function syncPhase(ctx: RunContext): Promise<PhaseResult> {
  const start = instantOf(ctx.clock.now());
  const r = await ctx.index.sync(ctx.store);
  return { ...blank('index', ctx, start), rows: r.loaded, notes: [`${r.loaded} files loaded, ${r.skipped} unchanged, ${r.removed} removed`] };
}

async function analyzePhase(ctx: RunContext, st: RunState, o: { write: boolean }): Promise<PhaseResult> {
  const start = instantOf(ctx.clock.now());
  if (!ctx.index.dataRange().sealedThrough) {
    st.out = null;
    return skippedPhase('analyze', ctx, 'No finished Search Console days yet, so there is nothing to analyse.');
  }
  const notes: string[] = [];
  st.out = analyzeIndex(ctx.index, ctx.config, notes);
  const r: PhaseResult = { ...blank('analyze', ctx, start), rows: st.out?.findings.length ?? 0, notes };
  if (st.out && o.write) {
    const rel = await writeFindingsIfChanged(ctx, st.out);
    if (rel) r.partitions.push(rel);
    r.notes.push(rel ? 'Findings changed since the last run and were saved.' : 'Findings unchanged since the last run.');
  }
  return r;
}

async function reportPhase(ctx: RunContext, st: RunState, demo: boolean): Promise<PhaseResult> {
  const start = instantOf(ctx.clock.now());
  if (!st.out) return skippedPhase('report', ctx, 'No analysis to report on yet.');
  const run = summary(ctx, st, null);
  const { html, md, json } = renderReports(st.out, { toolVersion: ctx.toolVersion, config: ctx.config, run, demo });
  await ctx.store.writeFileAtomic(layout.reportHtml, html);
  await ctx.store.writeFileAtomic(layout.reportMd, md);
  await ctx.store.writeFileAtomic(layout.findingsJson, json);
  st.reportPath = resolveInside(ctx.store.root, layout.reportHtml);
  const r: PhaseResult = { ...blank('report', ctx, start), rows: st.out.findings.length, partitions: [layout.reportHtml, layout.reportMd, layout.findingsJson] };
  const summaryFile = ctx.env.GITHUB_STEP_SUMMARY;
  if (ctx.flags.ci && summaryFile) {
    const bytes = Buffer.from(md, 'utf8');
    const text = bytes.length > STEP_SUMMARY_MAX
      ? `${bytes.subarray(0, STEP_SUMMARY_MAX - 200).toString('utf8').replace(/\uFFFD+$/, '')}\n\n_(cut to fit the 1 MiB step summary limit; the full report is in the artifact)_\n`
      : md;
    try {
      await appendFile(summaryFile, ctx.secrets.redact(text), 'utf8');
      r.notes.push('Wrote the step summary.');
    } catch (e) {
      r.notes.push(`Could not write the step summary (${(e as Error).message}).`);
    }
  }
  return r;
}

async function graphPhase(ctx: RunContext, st: RunState): Promise<PhaseResult> {
  const start = instantOf(ctx.clock.now());
  if (!ctx.config.graph.enabled) return skippedPhase('graph', ctx, 'The graph is turned off in config.json.');
  if (!st.out) return skippedPhase('graph', ctx, 'No analysis to build the graph from yet.');
  const previous = parseGraph(await ctx.store.readFile(layout.graph));
  const doc = buildGraph({
    property: ctx.config.property, siteDomain: st.out.siteDomain, dataThrough: st.out.dataThrough, db: withSeedEvents(ctx.index),
    analysis: st.out, previous, maxQueries: ctx.config.graph.maxQueries, renderLabel: graphLabel,
  });
  const w = await writeGraph(ctx.store, doc, { property: ctx.config.property, force: ctx.flags.forceGraph });
  st.graphPath = resolveInside(ctx.store.root, layout.graph);
  return { ...blank('graph', ctx, start), rows: w.nodes, partitions: [layout.graph, layout.graphMeta], notes: [`${w.nodes} nodes, ${w.links} links`] };
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StError('network', 'Cancelled while waiting.'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new StError('network', 'Cancelled while waiting.'));
    }, { once: true });
  });

/** A folder made by `searchtrace demo` says so in meta.json, so later runs on it keep the demo label. */
async function isDemoFolder(ctx: RunContext): Promise<boolean> {
  try {
    const text = await ctx.store.readFile(layout.meta);
    return text ? (JSON.parse(text, (k, x: unknown) => (k === '__proto__' ? undefined : x)) as { demo?: unknown }).demo === true : false;
  } catch {
    return false;
  }
}

const STATUS_RANK: Record<PhaseResult['status'], number> = { skipped: 0, ok: 1, deferred: 2, partial: 3, failed: 4 };

/** The run's first AI Overview collection plus every --wait poll, as one step. */
export function mergeCollectPolls(first: PhaseResult | null, polls: PhaseResult[]): PhaseResult {
  const all = first ? [first, ...polls] : polls;
  const requests: Record<string, number> = {};
  for (const p of all) for (const [k, v] of Object.entries(p.requests)) requests[k] = (requests[k] ?? 0) + v;
  const status = all.reduce<PhaseResult['status']>((w, p) => (STATUS_RANK[p.status] > STATUS_RANK[w] ? p.status : w), 'skipped');
  const collected = polls.reduce((n, p) => n + p.rows, 0);
  const last = polls[polls.length - 1];
  // The last poll says what is still outstanding; earlier "still processing" notes are out of date.
  const outstanding = (last?.notes ?? []).filter((n) => !/^Collected /.test(n));
  const earlier = (first?.notes ?? []).filter((n) => !/still being processed|could not be read/.test(n));
  const notes = [...earlier, `Collected ${collected} AI Overview check${collected === 1 ? '' : 's'} while waiting.`, ...outstanding];
  const seen = new Set<string>();
  const errors = all.flatMap((p) => p.errors).filter((e) => (seen.has(e.message) ? false : (seen.add(e.message), true)));
  return {
    name: 'serp_collect',
    status,
    startedAt: all[0].startedAt,
    endedAt: all[all.length - 1].endedAt,
    requests,
    rows: all.reduce((n, p) => n + p.rows, 0),
    costUsd: all.reduce((n, p) => n + p.costUsd, 0),
    partitions: all.flatMap((p) => p.partitions),
    notes,
    errors,
  };
}

async function fullRun(ctx: RunContext, o: PipelineInput): Promise<RunSummary> {
  const st: RunState = { phases: [], out: null, reportPath: null, graphPath: null };
  // The demo label is part of findings.json, so a re-run on the demo folder must keep it (D24).
  const demo = o.demo ?? (await isDemoFolder(ctx));
  const push = (r: PhaseResult): PhaseResult => {
    st.phases.push(r);
    return r;
  };
  const on = o.onPhase;
  // An index load that fails is tried once more (a second sync starts clean). If it still fails,
  // the run goes on but saves no findings, report or graph built on a half-loaded index.
  const syncWithRetry = async (onPhaseFn?: (n: PhaseName) => void): Promise<PhaseResult> => {
    const r = await boundary(ctx, 'index', () => syncPhase(ctx), onPhaseFn);
    if (r.status !== 'failed') return r;
    const again = await boundary(ctx, 'index', () => syncPhase(ctx));
    if (again.status !== 'failed') return { ...again, notes: [...again.notes, 'Loaded on the second try.'] };
    st.indexBroken = true;
    return { ...r, notes: [...r.notes, INDEX_BROKEN_NOTE] };
  };
  // A re-sync after a collector only shows in the summary when it fails.
  const resync = async (): Promise<void> => {
    const r = await syncWithRetry();
    if (r.status === 'failed') push(r);
  };
  const f = ctx.flags;
  const cfg = ctx.config;
  const serpOn = cfg.serp.provider === 'dataforseo';
  const lockStart = instantOf(ctx.clock.now());
  const release = await acquireLock(ctx.store, ctx.runId, ctx.clock);
  const host = ctx.env.GITHUB_ACTIONS === 'true' ? 'gha' : 'local';
  const hash = configHash(cfg);
  try {
    await ctx.store.append('runs', { runId: ctx.runId, event: 'start', at: ctx.startedAt, toolVersion: ctx.toolVersion, configHash: hash, host });
    push({ ...blank('lock', ctx, lockStart) });

    let authError: StError | null = null;
    if (!f.offline) {
      const g = await connectGoogle(ctx);
      ctx.google = g.google;
      authError = g.error;
    }
    const needGoogle = (): void => {
      if (!ctx.google) throw authError ?? new StError('auth', 'No Google credential is available.', `Run \`${cli('setup')}\`, or pass --credentials <file>.`);
    };

    // The updates collector decides for itself (plan.skip): offline it fetches nothing but still
    // stores the bundled list once, so the index, the graph and doctor see Google's updates.
    push(await boundary(ctx, 'updates', () => collect(ctx, updatesCollector), on));
    push(f.offline
      ? skippedPhase('gsc', ctx, 'Offline: no new Search Console data fetched.')
      : await boundary(ctx, 'gsc', async () => {
        needGoogle();
        return collect(ctx, gscCollector);
      }, on));
    push(await syncWithRetry(on));

    if (f.offline) push(skippedPhase('crawl', ctx, 'Offline: pages not checked.'));
    else if (!cfg.crawl.enabled) push(skippedPhase('crawl', ctx, 'Page snapshots are turned off in config.json.'));
    else {
      const r = push(await boundary(ctx, 'crawl', () => collect(ctx, crawlCollector), on));
      if (r.status !== 'skipped' && r.status !== 'failed') await resync();
    }

    if (f.offline) push(skippedPhase('inspect', ctx, 'Offline: no index checks.'));
    else if (!cfg.inspection.enabled || cfg.inspection.dailyBudget === 0) push(skippedPhase('inspect', ctx, 'Index checks are turned off in config.json.'));
    else {
      push(await boundary(ctx, 'inspect', async () => {
        needGoogle();
        return collect(ctx, inspectionCollector);
      }, on));
      await resync();
    }

    if (f.offline) push(skippedPhase('serp_collect', ctx, 'Offline: AI Overview results not collected.'));
    else if (!serpOn) push(skippedPhase('serp_collect', ctx, 'AI Overview checks are off. Add a DataForSEO login to turn them on.'));
    else {
      const r = push(await boundary(ctx, 'serp_collect', () => collect(ctx, serpCollectCollector), on));
      if (r.status !== 'skipped' && r.status !== 'failed') await resync();
    }

    push(await boundary(ctx, 'analyze', () => analyzePhase(ctx, st, { write: !st.indexBroken }), on));

    let posted = false;
    if (f.offline) push(skippedPhase('serp_post', ctx, 'Offline: no AI Overview checks posted.'));
    else if (f.noPaid) push(skippedPhase('serp_post', ctx, 'Paid checks are off for this run (--no-paid).'));
    else if (!serpOn) push(skippedPhase('serp_post', ctx, 'AI Overview checks are off. Add a DataForSEO login to turn them on.'));
    else if (!st.out) push(skippedPhase('serp_post', ctx, 'No analysis yet, so there are no searches to check.'));
    else {
      const candidates = st.out.serpCandidates;
      const r = push(await boundary(ctx, 'serp_post', async () => {
        const plan = await serpPoster.plan(ctx, candidates);
        if (plan.skip) return skippedPhase('serp_post', ctx, plan.skip);
        return serpPoster.execute(plan, ctx);
      }, on));
      posted = r.status !== 'skipped' && r.status !== 'failed' && (r.costUsd > 0 || Object.keys(r.requests).length > 0);
    }

    push(st.indexBroken ? skippedPhase('report', ctx, INDEX_BROKEN_NOTE) : await boundary(ctx, 'report', () => reportPhase(ctx, st, demo), on));
    push(st.indexBroken ? skippedPhase('graph', ctx, INDEX_BROKEN_NOTE) : await boundary(ctx, 'graph', () => graphPhase(ctx, st), on));

    if (posted && f.waitMinutes > 0) {
      const sleep = o.sleep ?? defaultSleep;
      const rounds = Math.max(1, Math.ceil((f.waitMinutes * 60_000) / WAIT_POLL_MS));
      const polls: PhaseResult[] = [];
      for (let i = 0; i < rounds; i++) {
        try {
          await sleep(WAIT_POLL_MS, ctx.signal);
        } catch {
          break;
        }
        const plan = await serpCollectCollector.plan(ctx).catch(() => null);
        // Wait for this run's checks only: an older task that keeps failing must not hold the loop for the whole --wait.
        if (!plan || plan.skip || (plan.payload.thisRunTaskIds ?? plan.payload.pendingTaskIds).length === 0) break;
        polls.push(await boundary(ctx, 'serp_collect', () => serpCollectCollector.execute(plan, ctx)));
      }
      // One row per step in the summary and the report's run ledger: the polls fold into the
      // run's "AI Overview results" step, and the refreshed analysis, report and graph replace the
      // earlier ones (the report shows their final state). A poll every 30 s for 20 minutes would
      // otherwise add 40 near-identical rows.
      if (polls.length) {
        const k = st.phases.findIndex((p) => p.name === 'serp_collect');
        const merged = mergeCollectPolls(k >= 0 ? st.phases[k] : null, polls);
        if (k >= 0) st.phases[k] = merged;
        else push(merged);
      }
      const replace = (r: PhaseResult): PhaseResult => {
        const k = st.phases.findIndex((p) => p.name === r.name);
        if (k >= 0) st.phases[k] = r;
        else st.phases.push(r);
        return r;
      };
      const sync = await syncWithRetry();
      if (sync.status === 'failed') push(sync);
      replace(await boundary(ctx, 'analyze', () => analyzePhase(ctx, st, { write: !st.indexBroken })));
      if (!st.indexBroken) {
        replace(await boundary(ctx, 'report', () => reportPhase(ctx, st, demo)));
        replace(await boundary(ctx, 'graph', () => graphPhase(ctx, st)));
      }
    }

    const result = summary(ctx, st, null);
    await ctx.store.append('runs', {
      runId: ctx.runId, event: 'end', at: instantOf(ctx.clock.now()), toolVersion: ctx.toolVersion, configHash: hash, host,
      phases: st.phases, exit: result.exit,
    });
    return result;
  } finally {
    await release();
  }
}

async function planOf<P>(ctx: RunContext, c: Collector<P>, label: string, lines: PlanLine[]): Promise<void> {
  try {
    const p = await c.plan(ctx);
    lines.push(...p.lines);
    if (p.skip && !p.lines.length) lines.push({ group: 'free', label, detail: `skipped: ${p.skip}` });
  } catch (e) {
    const msg = e instanceof StError ? e.message : (e as Error)?.message ?? String(e);
    lines.push({ group: 'free', label, detail: `can't plan yet: ${ctx.secrets.redact(msg)}` });
  }
}

/** --dry-run: plan every collector, size the paid plan from an offline analysis, write only a ledger line. */
async function dryRun(ctx: RunContext): Promise<RunSummary> {
  const f = ctx.flags;
  const cfg = ctx.config;
  const lines: PlanLine[] = [];
  const st: RunState = { phases: [], out: null, reportPath: null, graphPath: null };
  if (!f.offline) {
    const g = await connectGoogle(ctx);
    ctx.google = g.google;
    if (!g.google && g.error) lines.push({ group: 'free', label: 'Google credential', detail: `${ctx.secrets.redact(g.error.message)}${g.error.fix ? ` ${ctx.secrets.redact(g.error.fix)}` : ''}` });
    await planOf(ctx, gscCollector, 'Search Console data', lines);
    await planOf(ctx, updatesCollector, 'Google update feed', lines);
    if (cfg.crawl.enabled) await planOf(ctx, crawlCollector, 'Your pages', lines);
    if (cfg.inspection.enabled && cfg.inspection.dailyBudget > 0) await planOf(ctx, inspectionCollector, 'Index checks', lines);
    if (cfg.serp.provider === 'dataforseo') await planOf(ctx, serpCollectCollector, 'AI Overview results', lines);
  } else {
    lines.push({ group: 'free', label: 'Offline', detail: 'nothing would be fetched; reports are rebuilt from saved data' });
  }
  try {
    await ctx.index.sync(ctx.store);
    st.out = analyzeIndex(ctx.index, cfg);
  } catch {
    st.out = null;
  }
  if (!f.offline && !f.noPaid && cfg.serp.provider === 'dataforseo') {
    try {
      const p = await serpPoster.plan(ctx, st.out?.serpCandidates ?? []);
      lines.push(...p.lines);
      if (p.skip && !p.lines.length) lines.push({ group: 'paid', label: 'AI Overview checks', detail: `skipped: ${p.skip}` });
    } catch (e) {
      lines.push({ group: 'paid', label: 'AI Overview checks', detail: `can't plan yet: ${ctx.secrets.redact((e as Error)?.message ?? String(e))}` });
    }
  }
  await ctx.store.append('runs', {
    runId: ctx.runId, event: 'end', at: instantOf(ctx.clock.now()), toolVersion: ctx.toolVersion, configHash: configHash(cfg),
    host: ctx.env.GITHUB_ACTIONS === 'true' ? 'gha' : 'local', phases: [], exit: 'ok', dryRun: true,
  });
  return { ...summary(ctx, st, lines), headline: null };
}

/** The 2.4 entry point. */
export async function runPipeline(o: PipelineOptions): Promise<RunSummary> {
  return runPipelineWith(o);
}

/** runPipeline plus the CLI's and tests' extras (logger, secrets, sleep, progress). */
export async function runPipelineWith(o: PipelineInput): Promise<RunSummary> {
  const ctx = await createRunContext(o);
  try {
    return o.flags.dryRun ? await dryRun(ctx) : await fullRun(ctx, o);
  } finally {
    ctx.index.close();
  }
}
