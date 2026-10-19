// ============================================================================
// searchtrace core contracts. FROZEN after Phase 0. Additive changes only, by WP-A.
// Phase 2 additions (all optional or widening, so every Phase 1 caller still compiles):
//   SpendEvent design.location, HttpRequest.gunzip, GoogleAuth.source/invalidate,
//   CurveCell.date, BarGroup keys on ScopeDecomposition.ci95 and Finding.componentCi95,
//   AioInput.fdrQ, DemoTruth.expect extras (DemoExpectation).
// ============================================================================
import type { Config } from './config.js';
export type { Config };

// ---------- primitives ----------
/** 'YYYY-MM-DD'. Always a Pacific Time (America/Los_Angeles) calendar day, as Search Console reports. */
export type IsoDate = string;
/** UTC ISO-8601 instant, e.g. '2026-10-04T23:22:42Z'. */
export type Instant = string;
/** GSC TABLET is summed into 'mobile' at ingest. */
export type Device = 'desktop' | 'mobile';
export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
export interface Interval { from: Instant; to: Instant; precision: 'exact' | 'bounded' | 'unknown' }
export type Rng = () => number;                       // uniform [0, 1), seeded
export type Fetch = typeof fetch;
export interface Clock { now(): Date }

// ---------- Search Console rows (stored) ----------
export type SliceName = 't' | 'td' | 'tc' | 'p' | 'qpd';
/** ps = average position * impressions, so impression-weighted position re-aggregates exactly. CTR is never stored. */
export type GscRow =
  | { s: 't'; c: number; i: number; ps: number }                                       // (date) byProperty
  | { s: 'td'; dv: Device; c: number; i: number; ps: number }                         // (date, device) byProperty
  | { s: 'tc'; cc: string; c: number; i: number; ps: number }                         // (date, country) byProperty; cc = ISO-3 lowercase
  | { s: 'p'; p: string; c: number; i: number; ps: number }                           // (date, page) byPage. COMPLETE: includes anonymised queries
  | { s: 'qpd'; q: string; p: string; dv: Device; c: number; i: number; ps: number }; // (date, query, page, device) byPage. Named queries only

export type PartitionKind = 'gsc_day' | 'gsc_fresh' | 'inspect' | 'crawl' | 'serp' | 'google_events' | 'findings';
export interface PartitionMeta {
  kind: PartitionKind;
  schema: 1;
  property: string;
  toolVersion: string;
  runId: string;
  fetchedAt: Instant;
  day?: IsoDate;                                            // gsc_day
  revision?: number;                                        // gsc_day: 1 = first seal, 2+ = after revalidation
  dataState?: 'final' | 'all';
  slices?: Partial<Record<SliceName, { rows: number; truncated: boolean }>>;
  keyframe?: boolean;                                       // crawl: every record carries full fields
}

// ---------- URL Inspection ----------
export type InspectReason = 'post_change' | 'blast_radius' | 'traffic' | 'coverage';
export interface InspectionRecord {
  url: string;
  inspectedAt: Instant;
  reason: InspectReason;
  verdict: string;                                          // PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: Instant;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
  sitemaps?: string[];
  referringUrls?: string[];                                 // capped at 10
  richResults?: { verdict: string; types: string[] };
}

// ---------- Page snapshots ----------
export type FetchOutcome =
  | 'ok' | 'not_modified' | 'http_error' | 'blocked_challenge' | 'timeout'
  | 'too_large' | 'robots_disallowed' | 'not_html' | 'off_property' | 'network_error'
  | 'private_address';
export interface PageFields {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  canonical: string | null;                                 // absolute, normalised
  h1: string[];                                             // first 3
  lang: string | null;
  siteName: string | null;                                  // og:site_name, else JSON-LD Organization/WebSite name
  wordCount: number;
  textHash: string;                                         // sha256 hex of main text
  simhash: string;                                          // 16 hex chars
  jsonLdTypes: string[];                                    // sorted unique @type values (walks @graph)
  internalLinks: string[];                                  // sorted unique normalised on-property URLs
  externalLinkCount: number;
  hreflangCount: number;
}
export interface SnapshotRecord {
  url: string;                                              // normalised requested URL
  fetchedAt: Instant;
  outcome: FetchOutcome;
  status: number | null;
  finalUrl: string | null;
  redirects: string[];                                      // hop URLs in order
  fieldsHash: string | null;                                // sha256 of canonical JSON of fields; set for ok and not_modified
  fields?: PageFields;                                      // present iff hash changed vs previous snapshot of this URL, or keyframe
}

// ---------- Site changes (derived, never stored as source of truth) ----------
export type ChangeField =
  | 'title' | 'metaDescription' | 'metaRobots' | 'xRobotsTag' | 'canonical' | 'h1'
  | 'jsonLdTypes' | 'internalLinks' | 'body' | 'status' | 'annotation';
export type ChangeClass = 'snippet' | 'content' | 'technical';
// snippet: title, metaDescription | content: h1, body, jsonLdTypes, internalLinks, annotation (default)
// technical: metaRobots, xRobotsTag, canonical, status
export interface TouchedUrl {
  url: string;
  before: string | null;
  after: string | null;
  googleSeen: Interval | null;                              // from inspections; null = Google hasn't recrawled since the change
}
export interface SiteChange {
  id: string;                                               // nodeId('sitechg', signature + deployed.to)
  source: 'snapshot' | 'annotation';
  field: ChangeField;
  cls: ChangeClass;
  templateKey: string;
  signature: string;                                        // field + normalised before->after shape + template
  deployed: Interval;                                       // (previous snapshot, this snapshot] or the annotation date
  touched: TouchedUrl[];                                    // the blast radius
  text: string | null;                                      // annotation text (untrusted user input)
}
export interface Annotation {
  id: string;
  at: Instant;                                              // when recorded
  date: IsoDate;                                            // when the change happened (user-declared)
  text: string;
  urls: string[];                                           // resolved, normalised
  field: ChangeField;                                       // default 'annotation'
}

// ---------- SERP / DataForSEO ----------
export type SampleDesignKind = 'census' | 'certainty' | 'poisson';
export interface AioRef { domain: string; url: string; title: string | null; source: string | null }
export interface SerpObservation {
  intentKey: string;
  taskId: string;
  keyword: string;
  device: Device;
  locationCode: number;
  languageCode: string;
  isoWeek: string;
  observedAt: Instant;                                      // DataForSEO result datetime
  design: SampleDesignKind;
  pi: number;                                               // inclusion probability (1 for census/certainty)
  itemTypes: string[];
  aio: null | { async: boolean | null; citesUs: boolean; refs: AioRef[] };   // null = no AI Overview on this check
  organic: { rankAbsolute: number; domain: string; url: string; title: string }[]; // top 10 only
  ours: { rankAbsolute: number; url: string; title: string } | null;
}
export type SpendEvent = { at: Instant; runId: string } & (
  | { type: 'design'; isoWeek: string; budgetUsd: number; mode: 'census' | 'sample';
      units: { intentKey: string; keyword: string; device: Device; pi: number; design: SampleDesignKind; weekday: number }[];
      location?: { locationCode: number; languageCode: string } }   // the location baked into that week's intent keys
  | { type: 'intent'; intentKey: string; tag: string; estUsd: number }
  // postedAt: when DataForSEO created the task, for a task adopted from id_list later (at is when it was recorded).
  | { type: 'posted'; intentKey: string; tag: string; taskId: string; costUsd: number; postedAt?: Instant }
  // unconfirmed: settled after its week ended without proof either way, so its worst-case cost counts as spent.
  | { type: 'failed' | 'unknown' | 'abandoned'; intentKey: string; tag: string; reason: string; unconfirmed?: boolean }
  | { type: 'collected'; intentKey: string; taskId: string; partition: string }
  // DataForSEO answered a task with a final error (for example 40102 No Search Results): never fetched again.
  | { type: 'unavailable'; intentKey: string; taskId: string; reason: string });

// ---------- Google events ----------
export type GoogleEventKind = 'core' | 'spam' | 'discover' | 'other_ranking' | 'outage' | 'data_anomaly';
export interface GoogleEvent {
  id: string;                                               // incident id, or 'curated-...'
  source: 'incidents' | 'seed' | 'curated';
  service: string;                                          // Ranking | Serving | Indexing | Crawling | Reporting
  kind: GoogleEventKind;
  title: string;
  begin: Instant;
  end: Instant | null;
  endEstimated: boolean;                                    // true when end was null and begin+14d is used
  url: string | null;
  modified: Instant | null;
}

// ---------- Run ledger ----------
export type PhaseName =
  | 'lock' | 'updates' | 'gsc' | 'index' | 'crawl' | 'inspect' | 'serp_collect'
  | 'analyze' | 'serp_post' | 'report' | 'graph';
export interface PhaseResult {
  name: PhaseName;
  status: 'ok' | 'skipped' | 'partial' | 'failed' | 'deferred';
  startedAt: Instant;
  endedAt: Instant;
  requests: Record<string, number>;                         // e.g. { 'gsc.query': 982, 'gsc.probe': 1 }
  rows: number;
  costUsd: number;
  partitions: string[];
  notes: string[];                                          // plain-English one-liners for the run summary
  errors: { code: string; message: string }[];              // redacted
}
export interface RunRecord {
  runId: string;
  event: 'start' | 'end';
  at: Instant;
  toolVersion: string;
  configHash: string;
  host: 'gha' | 'local';
  phases?: PhaseResult[];
  exit?: ExitCodeName;
}
export type ExitCodeName = 'ok' | 'error' | 'config' | 'auth' | 'partial';
export type LedgerStream = 'runs' | 'spend' | 'inspect' | 'events';
export type ErrorCode =
  | 'config' | 'auth' | 'reauth_required' | 'permission' | 'property_not_found' | 'quota'
  | 'budget' | 'network' | 'http' | 'lock_held' | 'graph_not_ours' | 'not_implemented' | 'internal';

// ---------- Storage ----------
export interface DataStore {
  readonly root: string;
  writePartition<T>(rel: string, meta: PartitionMeta, rows: Iterable<T>): Promise<{ path: string; sha256: string; rows: number }>;
  readPartition<T>(rel: string): Promise<{ meta: PartitionMeta; rows: T[] }>;
  /** Only the {"_meta": ...} line, without decoding the rows (optional: callers fall back to readPartition). */
  readPartitionMeta?(rel: string): Promise<PartitionMeta>;
  list(prefix: string): Promise<{ path: string; size: number }[]>;          // sorted by path; prefix relative to root
  exists(rel: string): Promise<boolean>;
  append(stream: LedgerStream, rec: object): Promise<void>;                  // ledger/<stream>/YYYY-MM.ndjson, fsync
  readLedger<T>(stream: LedgerStream): Promise<T[]>;                          // all months, skips a torn last line
  writeFileAtomic(rel: string, data: string | Uint8Array): Promise<void>;
  readFile(rel: string): Promise<string | null>;
  removeFile(rel: string): Promise<void>;
}
export interface Layout {
  config: 'config.json';
  meta: 'meta.json';
  gscDay(day: IsoDate, revision?: number): string;        // gsc/2026/10/2026-10-03.ndjson.gz | gsc/2026/10/2026-10-03.r2.ndjson.gz
  gscFresh: 'state/gsc-fresh.ndjson.gz';
  perRun(kind: 'inspect' | 'crawl' | 'serp' | 'findings' | 'google', runId: string, at: Instant): string; // <kind>/YYYY/MM/<runId>.ndjson.gz
  annotations: 'annotations.ndjson';
  ledger(stream: LedgerStream, month: string): string;    // ledger/<stream>/2026-10.ndjson
  reportHtml: 'reports/latest.html';
  reportMd: 'reports/latest.md';
  findingsJson: 'reports/findings.json';
  graph: 'graphify-out/graph.json';
  graphMeta: 'graphify-out/searchtrace.meta.json';
  index: 'state/index.sqlite';
  lock: 'state/lock';
  cacheDir: 'state/cache';
}

// ---------- Index (derived, disposable) ----------
export interface DayTotal { date: IsoDate; c: number; i: number; ps: number }
export interface PageDay { date: IsoDate; p: string; c: number; i: number; ps: number }
export interface Cell { date: IsoDate; q: string; p: string; dv: Device; c: number; i: number; ps: number }
export interface IndexReader {
  property(): string | null;
  dataRange(): { first: IsoDate | null; sealedThrough: IsoDate | null; provisionalThrough: IsoDate | null };
  siteDaily(from: IsoDate, to: IsoDate, o?: { device?: Device; provisional?: boolean }): DayTotal[]; // t (or td when device)
  siteDeviceDaily(from: IsoDate, to: IsoDate): { date: IsoDate; dv: Device; c: number; i: number; ps: number }[];
  countryTotals(from: IsoDate, to: IsoDate): { cc: string; c: number; i: number }[];
  pageDaily(from: IsoDate, to: IsoDate, o?: { pages?: string[] }): PageDay[];                     // p slice
  cells(from: IsoDate, to: IsoDate, o?: { pages?: string[]; queries?: string[] }): Cell[];         // qpd slice
  pages(): { url: string; firstSeen: IsoDate; lastSeen: IsoDate }[];                               // GSC p slice + crawl
  inspections(o?: { urls?: string[]; since?: Instant }): InspectionRecord[];
  snapshots(o?: { urls?: string[]; since?: Instant }): SnapshotRecord[];                           // fields omitted; use fieldsByHash
  fieldsByHash(): Map<string, PageFields>;
  annotations(): Annotation[];
  serp(o?: { since?: Instant }): SerpObservation[];
  googleEvents(): GoogleEvent[];
  findingsHistory(): Map<string, { firstReported: IsoDate; lastReported: IsoDate; last: Finding }>;   // replayed from findings partitions
  truncatedDays(): IsoDate[];
  revisions(): { day: IsoDate; revision: number }[];
  partitionsUsed(): { path: string; sha256: string }[];                                            // for inputsHash
}
export interface IndexDb extends IndexReader {
  sync(store: DataStore): Promise<{ loaded: number; skipped: number; removed: number }>;
  close(): void;
}

// ---------- HTTP ----------
export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;                                           // JSON-serialised when not a string/Uint8Array
  timeoutMs?: number;                                       // default 60000
  retry?: false | { attempts: number; baseMs: number; capMs: number; on: number[] }; // default: 6, 1000, 64000, [429,500,502,503,504]
  idempotent?: boolean;                                     // retries on network errors only when true (default true for GET)
  maxBytes?: number;                                        // decoded bytes; abort and set truncated
  gunzip?: boolean;                                         // a body starting with the gzip magic bytes is decompressed (.xml.gz sitemaps); maxBytes caps the decompressed size
  redirect?: 'follow' | 'manual';
  signal?: AbortSignal;
}
export interface HttpResponse { status: number; headers: Headers; url: string; text: string; truncated: boolean }
export interface Limiter { run<T>(fn: () => Promise<T>): Promise<T> }

// ---------- Auth ----------
export interface GoogleAuth {
  kind: 'service_account' | 'authorized_user';
  principal: string;                                        // SA email or account email or 'user credential'
  scopes: string[];
  headers(signal?: AbortSignal): Promise<Record<string, string>>;   // Authorization + optional x-goog-user-project
  source?: string;                                          // where the credential came from (a path or 'env NAME'), never its content
  invalidate?(): void;                                      // drop the cached access token: the next headers() call refreshes (401 retry once)
}

// ---------- Logging and secrets ----------
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;                                  // CI: ::warning::
  error(msg: string): void;                                 // CI: ::error::
  debug(msg: string): void;
  progress(label: string, done: number, total: number): void;   // TTY only, throttled
}
export interface SecretRegistry {
  add(value: string | undefined | null): void;              // ignores values shorter than 8 chars; CI: ::add-mask::
  redact(text: string): string;
  assertNoSecret(line: string): void;                       // throws StError('internal')
}

// ---------- Run context and collectors ----------
export interface RunFlags {
  dryRun: boolean;
  offline: boolean;
  noPaid: boolean;
  ci: boolean;
  yes: boolean;
  interactive: boolean;                                     // stdin is a TTY and not --ci
  budgetUsd: number | null;                                 // --budget overrides serp.maxPerRunUsd
  waitMinutes: number;                                      // --wait, default 0
  credentials: string | null;                               // --credentials
  forceGraph: boolean;
}
export interface RunContext {
  runId: string;
  startedAt: Instant;
  toolVersion: string;
  config: Config;
  store: DataStore;
  index: IndexDb;
  clock: Clock;
  fetch: Fetch;
  log: Logger;
  secrets: SecretRegistry;
  signal: AbortSignal;
  flags: RunFlags;
  google: GoogleAuth | null;                                // null when offline or auth failed
  env: Record<string, string | undefined>;
  /** Looks up a host's addresses so the crawler can refuse private ones. Absent in tests and the demo. */
  resolveHost?: (host: string) => Promise<string[]>;
}
export interface PlanLine { group: 'free' | 'paid'; label: string; detail: string }
export interface CollectorPlan<P> { lines: PlanLine[]; estRequests: number; estUsd: number; payload: P; skip: string | null }
export interface Collector<P> {
  name: PhaseName;
  plan(ctx: RunContext): Promise<CollectorPlan<P>>;
  execute(plan: CollectorPlan<P>, ctx: RunContext): Promise<PhaseResult>;
}
export interface SerpPoster {
  plan(ctx: RunContext, candidates: SerpCandidate[]): Promise<CollectorPlan<SerpPostPlan>>;
  execute(plan: CollectorPlan<SerpPostPlan>, ctx: RunContext): Promise<PhaseResult>;
}
// Plan payloads are owned by the source WP; exported here as opaque-but-typed records.
export interface GscPlan { probeFrom: IsoDate; probeTo: IsoDate; sealDays: IsoDate[]; revalidateDays: IsoDate[]; rangeChunks: [IsoDate, IsoDate][] }
export interface GscPlanState { today: IsoDate; firstIncompleteDate: IsoDate | null; sealed: { day: IsoDate; revision: number; fetchedAt: Instant }[]; revalidated: IsoDate[]; backfillMonths: number; revalidateAfterDays: number; firstDataDay: IsoDate | null }
export interface UpdatesPlan { url: string }
export interface InspectionPlan { budget: number; queue: { url: string; reason: InspectReason }[] }
export interface CrawlPlan { origin: string; urls: string[]; keyframe: boolean }
export interface SerpCollectPlan {
  reconcileFrom: Instant;
  pendingTaskIds: string[];
  /** The pending tasks this run posted: the --wait loop waits for these only, not for older stragglers. */
  thisRunTaskIds?: string[];
}
export interface SerpPostPlan { isoWeek: string; budgetUsd: number; design: Extract<SpendEvent, { type: 'design' }> | null; due: { intentKey: string; keyword: string; device: Device; pi: number; design: SampleDesignKind }[] }

// ---------- Analysis: shared ----------
export interface Windows { baseline: [IsoDate, IsoDate]; current: [IsoDate, IsoDate] }
export interface AnalysisWindows extends Windows {
  fit: [IsoDate, IsoDate];                                  // 182 days ending at baseline end
  holdoutFrom: IsoDate;                                     // last 28 days of fit window
  placebo: { pre1: [IsoDate, IsoDate]; pre2: [IsoDate, IsoDate] };
  changepoint: [IsoDate, IsoDate];                          // last 182 sealed days
  seasonal: Windows | null;                                 // both windows shifted back 364 days, when history covers them
}
export interface AnalysisUnit { level: 'site' | 'template' | 'page' | 'query'; key: string; label: string; device?: Device }
export type Segment = 'desktop|brand' | 'desktop|nonbrand' | 'mobile|brand' | 'mobile|nonbrand';
export interface BrandMatcher { isBrand(query: string): boolean; tokens: string[]; suggestions(cells: Cell[], curve: CtrCurve | null, homepage: string): string[] }

// ---------- Analysis: CTR curve ----------
export interface CurveCell { p: number; c: number; i: number; seg: Segment; date?: IsoDate }   // one day-level named cell; p = ps / i; date splits the holdout (cells without one only train)
export interface CurveBin { seg: Segment; lo: number; hi: number; center: number; clicks: number; impressions: number; prior: number; fit: number }
export interface CtrCurve {
  f(p: number, seg: Segment): number;                       // monotone non-increasing in p, floor 1e-5
  fMix(p: number, weights: Partial<Record<Segment, number>>): number;  // weighted average of f over segments
  unstable: Segment[];                                      // failed the holdout calibration check
  m: number;                                                // empirical-Bayes prior strength
  bins: CurveBin[];
  fitWindow: [IsoDate, IsoDate];
  redraw(rng: Rng): CtrCurve;                               // bootstrap replicate: x*_gk ~ Poisson(x_gk), prior fixed
}

// ---------- Analysis: decomposition ----------
export interface Bars {
  demand: number;          // D, or D_demand after a page-1 crossing split
  visibility: number;      // D_visibility (page-1 crossing); displayed with ranking
  rank: number;            // R
  samePos: number;         // S: click rate change at the same position
  appeared: number;        // +C_c when I_b = 0
  disappeared: number;     // -C_b when I_c = 0
  aioCitation: number;     // R + S merged when AIO citation flattening is detected
}                          // invariant: sum of all fields === C_c - C_b (to 1e-9)
/** Display groups (5.5.5) whose CIs cannot be summed from per-bar CIs: ranking = rank + visibility, churn = appeared + disappeared. */
export type BarGroup = 'ranking' | 'churn';
export interface UnitKey { page: string; query: string | null; device: Device | 'all' }   // query null = anonymised remainder
export interface WindowStats { I: number; C: number; F: number; pbar: number | null }
export type UnitFlag = 'page1_crossing' | 'k_fallback' | 'aio_flattening' | 'remainder' | 'remainder_clamped' | 'remainder_sparse' | 'curve_unstable';
export interface UnitDecomposition { key: UnitKey; template: string; brand: boolean | null; base: WindowStats; cur: WindowStats; bars: Bars; flags: UnitFlag[] }
export interface ScopeDecomposition {
  unit: AnalysisUnit;
  baseClicks: number;
  curClicks: number;
  deltaClicks: number;
  bars: Bars;
  ci95: Partial<Record<keyof Bars | BarGroup | 'total', [number, number]>> | null;   // null when not bootstrapped
  pTotal: number | null;
  units: number;
  namedClickShare: number;                                  // share of baseline+current clicks in named units
}

// ---------- Analysis: verdicts ----------
export type Verdict = 'signal' | 'noise' | 'underpowered' | 'unclear';
export type VerdictReason = 'floors' | 'identification' | 'signal' | 'noise_bounded' | 'noise_small' | 'wide_ci' | 'fact';
export type IdCheckName = 'placebo' | 'measurement_event' | 'competing_events' | 'coverage' | 'curve_unstable' | 'single_check' | 'seasonal';
export interface IdCheck { name: IdCheckName; passed: boolean; detail: string }
export interface VerdictInput {
  estimate: number;                                         // relative effect tau (e.g. -0.31)
  ci95: [number, number] | null;                            // CI on tau
  floorsMet: boolean;
  identification: IdCheck[];
  q: number | null;                                         // BH q-value (p for single-test families)
  delta: number;                                            // smallest effect worth acting on
  fdrQ: number;                                             // config analysis.fdrQ (0.10)
  weeksObserved: number;
  counts?: { pre: number; post: number; phi: number };      // for power when no CI exists
}
export interface PowerInfo { mde: number; weeksNeeded: number | null; notMeasurable: boolean }
export interface VerdictResult { verdict: Verdict; reason: VerdictReason; power: PowerInfo | null; failed: IdCheck[] }

// ---------- Analysis: findings ----------
export type Cause =
  | 'demand' | 'rank' | 'ctr_serp' | 'ai_overview' | 'site_change' | 'google_update'
  | 'index_state' | 'outage' | 'data_anomaly' | 'seasonal' | 'mixed' | 'unknown';
export type FindingKind =
  | 'headline' | 'waterfall' | 'change_point' | 'update_impact' | 'aio_effect' | 'aio_fact'
  | 'site_change_impact' | 'index_transition' | 'notice';
export type TemplateId =
  | 'headline' | 'boring' | 'real_google' | 'real_google_no_changes' | 'real_site_change' | 'demand' | 'ranking'
  | 'aio_not_cited' | 'aio_cited' | 'aio_flattening' | 'same_spot_unchecked' | 'same_spot_checked'
  | 'noise' | 'not_enough_data' | 'cause_unknown' | 'cant_separate' | 'mixed' | 'reporting_artefact'
  | 'too_recent' | 'no_site_changes' | 'before_recording' | 'site_change_unseen' | 'index_change'
  | 'update_row' | 'change_point' | 'gradual' | 'aio_fact' | 'coverage' | 'freshness';
export type AltKey =
  | 'demand_ruled_out' | 'demand_possible' | 'rank_ruled_out' | 'rank_possible'
  | 'site_change_none_recorded' | 'site_change_controls_fell_too' | 'site_change_possible'
  | 'update_no_overlap' | 'update_overlaps' | 'seasonal_same_last_year' | 'seasonal_not_last_year'
  | 'aio_not_checked' | 'aio_no_signal' | 'measurement_event_overlaps' | 'index_unchanged' | 'outage_overlaps';
export type FalsifierKey =
  | 'revert_and_recrawl' | 'next_update_recovery' | 'impressions_recover' | 'aio_disappears'
  | 'position_recovers' | 'more_data' | 'reverts' | 'record_changes';
export interface EvidenceRef {
  type: 'gsc' | 'inspection' | 'snapshot_diff' | 'serp' | 'google_event' | 'annotation' | 'statistic';
  confidence: Confidence;
  partition: string;                                        // data-dir-relative path holding the decisive rows
  key?: Record<string, string>;
  summary: string;                                          // short factual line, may include untrusted text (escape on output)
}
export interface Finding {
  id: string;                                               // deterministic findingId([kind, unit.key, windows/date, discriminator])
  kind: FindingKind;
  unit: AnalysisUnit;
  metric: 'clicks' | 'impressions' | 'ctr' | 'position' | 'index_state' | 'aio_presence';
  windows: Windows | null;
  date: IsoDate | null;
  dateWindow: [IsoDate, IsoDate] | null;
  effect: { estimate: number | null; ci95: [number, number] | null; absolute: number | null; absoluteCi95: [number, number] | null; p: number | null; q: number | null };
  real: Verdict;
  reason: VerdictReason;
  cause: Cause | null;
  causeConfidence: Confidence;
  components: Bars | null;
  componentCi95: Partial<Record<keyof Bars | BarGroup, [number, number]>> | null;
  power: (PowerInfo & { perWeek: number }) | null;
  template: TemplateId;
  slots: Record<string, string | number>;
  evidence: EvidenceRef[];
  alternatives: { cause: Cause; ruledOut: boolean; key: AltKey; slots: Record<string, string | number> }[];
  falsifier: { key: FalsifierKey; slots: Record<string, string | number> };
  verify: { page?: string; query?: string; from: IsoDate; to: IsoDate } | null;   // F turns this into a GSC link
  related: { googleEvents: string[]; siteChanges: string[]; findings: string[] };
  analyzer: { name: string; version: string };
  priority: number;                                         // higher first; ties broken by id
}

// ---------- Analysis: module inputs and outputs ----------
export interface PeriodCompareInput {
  values: number[]; start: IsoDate;                          // full sealed daily history of the metric
  pre: [IsoDate, IsoDate]; post: [IsoDate, IsoDate];         // equal length
  s: number[];                                               // seasonal factors per day, aligned to values
  phi: number;
  exclude: [IsoDate, IsoDate][];                             // windows the empirical SE must not overlap (events)
  floor: number;                                             // minimum pre total (30 clicks or 1000 impressions)
  delta: number;                                             // for the verdict (site 0.10)
  fdrQ: number;
}
export interface PeriodEffect {
  pre: number; post: number; tau: number; ci95: [number, number]; p: number; se: number;
  seSource: 'quasi_poisson' | 'empirical'; freq: number | null; floorsMet: boolean;
  real: Verdict; reason: VerdictReason; power: PowerInfo | null;
}
export interface Series {
  id: string;                                               // 'site:clicks', 'site:impressions:mobile', 'tpl:/blog/*:clicks', 'page:<url>:impressions', 'brand:clicks'
  unit: AnalysisUnit;
  metric: 'clicks' | 'impressions';
  start: IsoDate;
  values: number[];                                         // contiguous sealed days
  primary: boolean;                                         // site totals: always reported
  segmentsOf?: string;                                      // localisation: this series is a segment of that series id
}
export interface ChangePointInput {
  series: Series[];
  dow: number[];                                            // site-impressions DOW factors (Monday first)
  events: GoogleEvent[];
  dataThrough: IsoDate;
  historyStart: IsoDate;
  seasonalValues: Record<string, { start: IsoDate; values: number[] }>;   // full history per series id for the last-year check
  fdrQ: number;
  delta: number;
}
export interface ChangePoint {
  seriesId: string; unit: AnalysisUnit; metric: 'clicks' | 'impressions';
  date: IsoDate; dateWindow: [IsoDate, IsoDate];
  before: number; after: number; ratio: number; ci95: [number, number];
  p: number; q: number; shape: 'step' | 'gradual'; slopePerWeek: number | null;
  overlaps: { eventId: string; kind: GoogleEventKind; title: string }[];
  localisation: LocaliseResult | null;
  seasonalMatch: boolean; tooRecent: boolean; mode: 'daily' | 'weekly';
}
export interface ChangePointOutput { changePoints: ChangePoint[]; findings: Finding[]; dispersion: Record<string, number> }
export interface LocaliseInput { date: IsoDate; segments: { label: string; values: number[]; start: IsoDate }[]; phi: number; days: number }
export interface LocaliseResult { proportional: boolean; g2: number; df: number; p: number; top: { label: string; residual: number; changePct: number }[] }
export interface ScorecardInput {
  clicks: number[]; impressions: number[]; start: IsoDate;  // sealed site daily totals
  dow: number[]; phi: { clicks: number; impressions: number };
  events: GoogleEvent[]; dataThrough: IsoDate; siteChanges: SiteChange[]; delta: number; fdrQ: number;
}
export interface UpdateRow {
  eventId: string; title: string; kind: GoogleEventKind; begin: IsoDate; end: IsoDate | null; endEstimated: boolean;
  status: 'measured' | 'partial' | 'too_recent' | 'before_history' | 'skipped_discover';
  window: { pre: [IsoDate, IsoDate]; post: [IsoDate, IsoDate] } | null;
  clicks: PeriodEffect | null; impressions: PeriodEffect | null;
  competing: string[]; measurementOverlap: boolean; siteChangesSeen: number; checkAgainOn: IsoDate | null; findingId: string;
}
export interface SiteChangeInput {
  changes: SiteChange[];
  pageDaily: PageDay[];                                     // complete page totals over the needed span
  cells: Cell[];                                            // named cells for CTR outcomes
  curve: CtrCurve;
  isBrand: (q: string) => boolean;
  templates: Map<string, string>;
  linksBefore: (url: string, at: Instant) => string[];      // internal links of a page as of a time (spillover check)
  events: GoogleEvent[];
  demandK: number | null;                                   // stable-unit demand index (5.3) for the "Demand" synthesis row
  dataThrough: IsoDate;
  rng: (key: string) => Rng;
  delta: number; bootstrap: number; fdrQ: number;
}
export interface SiteChangeImpact {
  siteChangeId: string; outcome: 'ctr' | 'impressions' | 'index_state';
  treated: number; controls: number; controlFallback: boolean;
  tau: number | null; ci95: [number, number] | null;
  controlChange: number | null; controlCi95: [number, number] | null;
  placebo: { tau: number; ci95: [number, number] } | null;
  notYetSeen: string[];
  synthesis: 'site_change' | 'google' | 'both' | 'demand' | 'unclear';
  real: Verdict; reason: VerdictReason; findingId: string;
}
export interface SerpCandidate {
  keyword: string; device: Device;                          // majority device over the current window
  pbar: number; impressions: number;                        // current window, that device
  expectedBaseClicks: number;                               // E_b (baseline curve-expected clicks)
  deltaClicks: number;                                      // C_c - C_b on that device
  pages: string[];
}
export interface AioInput {
  serp: SerpObservation[]; cells: Cell[]; curve: CtrCurve; isBrand: (q: string) => boolean;
  windows: AnalysisWindows; siteDomain: string; pageTitles: Map<string, string>;
  samePosByQuery: Map<string, number>;                      // 'keyword|device' -> sum of samePos bars (for apportioning)
  rng: (key: string) => Rng; delta: number; bootstrap: number;
  fdrQ?: number;                                            // config analysis.fdrQ (default 0.10)
}
export interface AioQueryFact {
  keyword: string; device: Device; checks: number; aioChecks: number;
  status: 'present' | 'absent' | 'intermittent' | 'single_present' | 'single_absent';
  cited: boolean; topDomains: string[]; ourRank: number | null; titleRewritten: boolean | null;
  attributedClicks: number | null; findingId: string;
}
export interface AioEstimate {
  estimator: 'cross_section' | 'did'; tau: number | null; ci95: [number, number] | null;
  missingClicks: number | null; missingCi95: [number, number] | null;
  groups: { U: number; N: number; Cit: number; intermittent: number }; coverage: number;
  placebo: { tau: number; ci95: [number, number] } | null; real: Verdict; reason: VerdictReason; findingId: string;
}
export interface AioOutput { facts: AioQueryFact[]; estimates: AioEstimate[]; findings: Finding[] }
export interface AnalysisInput {
  property: string; siteDomain: string; dataThrough: IsoDate; db: IndexReader; config: Config;
  siteChanges: SiteChange[]; siteName: string | null;
}
export interface AnalysisOutput {
  schemaVersion: 1;
  property: string; siteDomain: string; dataThrough: IsoDate; windows: AnalysisWindows; inputsHash: string;
  headline: { clicks: PeriodEffect; impressions: PeriodEffect; findingId: string; boring: boolean };
  findings: Finding[];                                      // sorted by priority desc, then id asc
  scopes: ScopeDecomposition[];                             // site, every template, top 50 pages and top 50 queries by |delta|
  changePoints: ChangePoint[];
  scorecard: UpdateRow[];
  siteChangeImpacts: SiteChangeImpact[];
  siteChanges: SiteChange[];
  aio: AioOutput | null;
  curve: { m: number; unstable: Segment[]; bins: CurveBin[]; fitWindow: [IsoDate, IsoDate] };
  serpCandidates: SerpCandidate[];
  timeline: { sealed: DayTotal[]; provisional: DayTotal[] };
  templates: Record<string, string>;                        // url -> template key
  diagnostics: {
    namedClickShare: number;
    reconciliation: { byPageClicks: number; byPropertyClicks: number };
    truncatedDays: IsoDate[]; revisions: number; underpoweredUnits: number;
    measurementEvents: string[]; bootstrapB: Record<string, number>;
    brandTokens: string[]; brandSuggestions: string[]; historyDays: number;
  };
}
export interface DemoTruth {
  property: string; dataThrough: IsoDate;
  expect: DemoExpectation[];
}
/** One planted-story expectation. The optional fields pin which finding answers it (spec 6.9). */
export interface DemoExpectation {
  kind: FindingKind; unitKey: string; real: Verdict; cause: Cause | null; tauRange?: [number, number];
  realAnyOf?: Verdict[];                                    // any of these verdicts passes (a diluted effect at this level)
  eventId?: string;                                         // update_impact: the Google event the row is for
  failedCheck?: IdCheckName;                                // the identification check that must fail
  estimator?: 'cross_section' | 'did';                      // aio_effect: which estimator
  synthesis?: SiteChangeImpact['synthesis'];                // site_change_impact: the synthesis row
  needsMde?: boolean;                                       // the finding must carry a minimum detectable effect
  note?: string;                                            // what was planted, in plain words
}

// ---------- Graph (graphify node-link) ----------
export type NodeKind = 'site' | 'page' | 'query' | 'tpl' | 'dom' | 'sitechg' | 'gupd' | 'finding' | 'idx' | 'cause';
export type FileType = 'code' | 'document' | 'paper' | 'image' | 'rationale' | 'concept';
export interface GNode {
  id: string; label: string; file_type: FileType; source_file: string; kind: NodeKind;
  first_seen?: IsoDate; last_seen?: IsoDate; community?: number | null; community_name?: string;
  [k: string]: unknown;
}
export interface GEdge {
  source: string; target: string; relation: string; confidence: Confidence; source_file: string; weight: number;
  valid_from?: IsoDate; valid_to?: IsoDate | null; observations?: number; evidence?: string[];
  [k: string]: unknown;
}
export interface GraphDoc { directed: false; multigraph: false; graph: Record<string, unknown>; nodes: GNode[]; links: GEdge[] }
export interface GraphInput {
  property: string; siteDomain: string; dataThrough: IsoDate; db: IndexReader; analysis: AnalysisOutput;
  previous: GraphDoc | null; maxQueries: number;
  renderLabel: (f: Finding) => string;                      // injected by the pipeline (report/copy.ts), truncated to 120 chars
}

// ---------- Pipeline ----------
export interface PipelineOptions { dir: string; flags: RunFlags; clock?: Clock; fetch?: Fetch; env?: Record<string, string | undefined>; demo?: boolean }
export interface RunSummary {
  runId: string; exit: ExitCodeName; phases: PhaseResult[]; dataThrough: IsoDate | null;
  headline: string | null; reportPath: string | null; graphPath: string | null; spendUsd: number; plan: PlanLine[] | null;
}
export interface ReportContext { toolVersion: string; config: Config; run: RunSummary | null; demo: boolean }
