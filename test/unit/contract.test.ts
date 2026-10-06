// Pins every cross-package export from spec 2.4 to its exact signature.
// The type assertions are checked by `npm run typecheck` (tsc includes test/), so a
// package that drifts from the contract fails typecheck, not just this test run.
// The runtime part proves every module loads and every export exists.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import * as config from '../../src/core/config.js';
import * as errors from '../../src/core/errors.js';
import * as log from '../../src/core/log.js';
import * as secrets from '../../src/core/secrets.js';
import * as time from '../../src/core/time.js';
import * as ids from '../../src/core/ids.js';
import * as url from '../../src/core/url.js';
import * as templates from '../../src/core/templates.js';
import * as rng from '../../src/core/rng.js';
import * as request from '../../src/http/request.js';
import * as limiter from '../../src/http/limiter.js';
import * as layout from '../../src/store/layout.js';
import * as store from '../../src/store/store.js';
import * as lock from '../../src/store/lock.js';
import * as db from '../../src/index/db.js';
import * as stats from '../../src/analyze/stats.js';
import * as verdicts from '../../src/analyze/verdicts.js';
import * as auth from '../../src/sources/google/auth.js';
import * as gsc from '../../src/sources/google/gsc.js';
import * as gscPlan from '../../src/sources/google/gsc-plan.js';
import * as updates from '../../src/sources/google/updates.js';
import * as changepoint from '../../src/analyze/changepoint.js';
import * as localiseMod from '../../src/analyze/localise.js';
import * as scorecard from '../../src/analyze/scorecard.js';
import * as inspection from '../../src/sources/google/inspection.js';
import * as crawl from '../../src/sources/crawl/crawl.js';
import * as diff from '../../src/sources/crawl/diff.js';
import * as extract from '../../src/sources/crawl/extract.js';
import * as annotations from '../../src/sources/annotations.js';
import * as siteChange from '../../src/analyze/site-change.js';
import * as indexState from '../../src/analyze/index-state.js';
import * as serp from '../../src/sources/dataforseo/serp.js';
import * as normalize from '../../src/sources/dataforseo/normalize.js';
import * as aio from '../../src/analyze/aio.js';
import * as graphBuild from '../../src/graph/build.js';
import * as graphWrite from '../../src/graph/write.js';
import * as windows from '../../src/analyze/windows.js';
import * as brand from '../../src/analyze/brand.js';
import * as ctrCurve from '../../src/analyze/ctr-curve.js';
import * as analysis from '../../src/analyze/index.js';
import * as fixture from '../../src/demo/fixture.js';
import * as copy from '../../src/report/copy.js';
import * as html from '../../src/report/html.js';
import * as why from '../../src/report/why.js';
import * as pipeline from '../../src/pipeline/run.js';
import * as cliMain from '../../src/cli/main.js';

import type {
  AioInput, AioOutput, AltKey, AnalysisInput, AnalysisOutput, AnalysisWindows, Annotation, BrandMatcher, Cause,
  ChangePointInput, ChangePointOutput, Clock, Collector, Config, Confidence, CrawlPlan, CtrCurve, CurveCell, DataStore,
  DemoTruth, ErrorCode, FalsifierKey, Fetch, Finding, GoogleAuth, GoogleEvent, GraphDoc, GraphInput, GscPlan, GscPlanState,
  HttpRequest, HttpResponse, IndexDb, InspectionPlan, InspectionRecord, Instant, IsoDate, Layout, Limiter, LocaliseInput,
  LocaliseResult, Logger, NodeKind, PageFields, PeriodCompareInput, PeriodEffect, PipelineOptions, PowerInfo, ReportContext,
  Rng, RunSummary, SampleDesignKind, ScopeDecomposition, ScorecardInput, SecretRegistry, SerpCollectPlan, SerpObservation, SerpPoster,
  SiteChange, SiteChangeImpact, SiteChangeInput, SnapshotRecord, TemplateId, UpdateRow, UpdatesPlan, Verdict, VerdictInput,
  VerdictResult,
} from '../../src/core/types.js';

type Slots = Record<string, string | number>;

describe('spec 2.4 skeleton contract', () => {
  it('WP-A core/config, errors, log, secrets', () => {
    expectTypeOf(config.ConfigSchema).toExtend<z.ZodType<Config>>();
    expectTypeOf(config.loadConfig).toEqualTypeOf<(dir: string) => Promise<Config>>();
    expectTypeOf(config.writeConfig).toEqualTypeOf<(dir: string, cfg: Config) => Promise<void>>();
    expectTypeOf(config.defaultConfig).toEqualTypeOf<(property: string) => Config>();
    expectTypeOf(config.configHash).toEqualTypeOf<(cfg: Config) => string>();
    expectTypeOf(new errors.StError('config', 'm', 'f')).toExtend<{ code: ErrorCode; fix?: string; exit: errors.ExitCode }>();
    expectTypeOf(errors.notImplemented).toEqualTypeOf<(name: string) => never>();
    expectTypeOf(log.createLogger).toEqualTypeOf<
      (o: { quiet: boolean; ci: boolean; color: boolean; secrets: SecretRegistry }) => Logger
    >();
    expectTypeOf(secrets.createSecretRegistry).toEqualTypeOf<(o: { ci: boolean }) => SecretRegistry>();
  });

  it('WP-A core/time, ids, url, templates, rng', () => {
    expectTypeOf(time.ptDate).toEqualTypeOf<(x: Date | Instant) => IsoDate>();
    expectTypeOf(time.addDays).toEqualTypeOf<(d: IsoDate, n: number) => IsoDate>();
    expectTypeOf(time.diffDays).toEqualTypeOf<(a: IsoDate, b: IsoDate) => number>();
    expectTypeOf(time.dateRange).toEqualTypeOf<(from: IsoDate, to: IsoDate) => IsoDate[]>();
    expectTypeOf(time.isoWeek).toEqualTypeOf<(d: IsoDate) => string>();
    expectTypeOf(time.weekday).toEqualTypeOf<(d: IsoDate) => number>();
    expectTypeOf(time.isIsoDate).toEqualTypeOf<(s: string) => boolean>();
    expectTypeOf(time.ptDayStart).toEqualTypeOf<(d: IsoDate) => Instant>();
    expectTypeOf(time.systemClock).toEqualTypeOf<Clock>();
    expectTypeOf(time.fixedClock).toEqualTypeOf<(iso: Instant) => Clock>();
    expectTypeOf(ids.sha256Hex).toEqualTypeOf<(s: string | Uint8Array) => string>();
    expectTypeOf(ids.b32).toEqualTypeOf<(hex: string) => string>();
    expectTypeOf(ids.hash32).toEqualTypeOf<(s: string) => number>();
    expectTypeOf(ids.nodeId).toEqualTypeOf<(kind: NodeKind, naturalKey: string) => string>();
    expectTypeOf(ids.findingId).toEqualTypeOf<(parts: string[]) => string>();
    expectTypeOf(ids.intentKey).toEqualTypeOf<(parts: string[]) => string>();
    expectTypeOf(ids.newRunId).toEqualTypeOf<(clock: Clock, rng?: Rng) => string>();
    expectTypeOf(url.normalizeUrl).toEqualTypeOf<(u: string) => string>();
    expectTypeOf(url.siteDomainOf).toEqualTypeOf<(property: string) => string>();
    expectTypeOf(url.isOnProperty).toEqualTypeOf<(url: string, property: string) => boolean>();
    expectTypeOf(url.domainMatches).toEqualTypeOf<(domain: string, siteDomain: string) => boolean>();
    expectTypeOf(url.pathOf).toEqualTypeOf<(url: string) => string>();
    expectTypeOf(url.defaultOrigins).toEqualTypeOf<(property: string) => string[]>();
    expectTypeOf(url.isPrivateHost).toEqualTypeOf<(host: string) => boolean>();
    expectTypeOf(templates.clusterTemplates).toEqualTypeOf<
      (urls: string[], overrides?: { glob: string; name: string }[]) => Map<string, string>
    >();
    expectTypeOf(rng.mulberry32).toEqualTypeOf<(seed: number) => Rng>();
    expectTypeOf(rng.rngFor).toEqualTypeOf<(seed: string, key: string) => Rng>();
  });

  it('WP-A http, store, index', () => {
    expectTypeOf(request.request).toEqualTypeOf<(fetchFn: Fetch, req: HttpRequest) => Promise<HttpResponse>>();
    expectTypeOf(request.requestJson<{ ok: true }>).toEqualTypeOf<
      (fetchFn: Fetch, req: HttpRequest) => Promise<{ status: number; data: { ok: true }; headers: Headers }>
    >();
    expectTypeOf(limiter.createLimiter).toEqualTypeOf<(o: { rps: number; concurrency: number }) => Limiter>();
    expectTypeOf(layout.layout).toEqualTypeOf<Layout>();
    expectTypeOf(layout.resolveInside).toEqualTypeOf<(root: string, rel: string) => string>();
    expectTypeOf(store.openStore).toEqualTypeOf<(root: string, secrets: SecretRegistry) => Promise<DataStore>>();
    expectTypeOf(lock.acquireLock).toEqualTypeOf<
      (store: DataStore, runId: string, clock: Clock) => Promise<() => Promise<void>>
    >();
    expectTypeOf(db.openIndex).toEqualTypeOf<(path: string) => Promise<IndexDb>>();
  });

  it('WP-A analyze/stats and verdicts', () => {
    expectTypeOf(stats.lgamma).toEqualTypeOf<(x: number) => number>();
    expectTypeOf(stats.logBetaBinomial).toEqualTypeOf<(x: number, n: number, a: number, b: number) => number>();
    expectTypeOf(stats.pava).toEqualTypeOf<(y: number[], w: number[], direction: 'decreasing' | 'increasing') => number[]>();
    expectTypeOf(stats.quantile).toEqualTypeOf<(sortedAsc: number[], q: number) => number>();
    expectTypeOf(stats.percentileCi).toEqualTypeOf<(samples: number[], level?: number) => [number, number]>();
    expectTypeOf(stats.bootstrapP).toEqualTypeOf<(samples: number[]) => number>();
    expectTypeOf(stats.benjaminiHochberg).toEqualTypeOf<(p: number[]) => number[]>();
    expectTypeOf(stats.kolmogorovTail).toEqualTypeOf<(k: number) => number>();
    expectTypeOf(stats.chiSquareTail).toEqualTypeOf<(x: number, df: number) => number>();
    expectTypeOf(stats.normalCdf).toEqualTypeOf<(z: number) => number>();
    expectTypeOf(stats.normalQuantile).toEqualTypeOf<(p: number) => number>();
    expectTypeOf(stats.poissonDraw).toEqualTypeOf<(rng: Rng, lambda: number) => number>();
    expectTypeOf(stats.mad).toEqualTypeOf<(x: number[]) => number>();
    expectTypeOf(stats.theilSen).toEqualTypeOf<(x: number[], y: number[]) => { slope: number; intercept: number }>();
    expectTypeOf(stats.dowFactors).toEqualTypeOf<(start: IsoDate, values: number[]) => number[]>();
    expectTypeOf(stats.seasonalSeries).toEqualTypeOf<(start: IsoDate, n: number, f: number[]) => number[]>();
    expectTypeOf(stats.overdispersion).toEqualTypeOf<(values: number[], s: number[]) => number>();
    expectTypeOf(stats.periodCompare).toEqualTypeOf<(i: PeriodCompareInput) => PeriodEffect>();
    expectTypeOf(verdicts.DEFAULT_DELTA).toEqualTypeOf<{
      site: number; template: number; page: number; query: number; aio: number; changepoint: number; siteChange: number;
    }>();
    expectTypeOf(verdicts.decideVerdict).toEqualTypeOf<(v: VerdictInput) => VerdictResult>();
    expectTypeOf(verdicts.powerFromCi).toEqualTypeOf<(ci: [number, number], delta: number, weeksObserved: number) => PowerInfo>();
    expectTypeOf(verdicts.powerFromCounts).toEqualTypeOf<
      (pre: number, post: number, phi: number, delta: number, weeksObserved: number) => PowerInfo
    >();
    expectTypeOf(verdicts.confidenceFor).toEqualTypeOf<(verdict: Verdict, isFact: boolean) => Confidence>();
  });

  it('WP-B', () => {
    expectTypeOf(auth.loadGoogleAuth).toEqualTypeOf<
      (o: {
        config: Config;
        env: Record<string, string | undefined>;
        fetch: Fetch;
        secrets: SecretRegistry;
        credentialsOverride?: string;
      }) => Promise<GoogleAuth>
    >();
    expectTypeOf(auth.listSites).toEqualTypeOf<
      (auth: GoogleAuth, fetchFn: Fetch) => Promise<{ siteUrl: string; permissionLevel: string }[]>
    >();
    expectTypeOf(gsc.gscCollector).toEqualTypeOf<Collector<GscPlan>>();
    expectTypeOf(gscPlan.planGsc).toEqualTypeOf<(s: GscPlanState) => GscPlan>();
    expectTypeOf(updates.updatesCollector).toEqualTypeOf<Collector<UpdatesPlan>>();
    expectTypeOf(updates.loadSeedEvents).toEqualTypeOf<() => GoogleEvent[]>();
    expectTypeOf(updates.classifyIncident).toEqualTypeOf<(raw: unknown) => GoogleEvent | null>();
    expectTypeOf(updates.measurementEvents).toEqualTypeOf<(events: GoogleEvent[]) => GoogleEvent[]>();
    expectTypeOf(changepoint.analyzeChangePoints).toEqualTypeOf<(i: ChangePointInput) => ChangePointOutput>();
    expectTypeOf(localiseMod.localise).toEqualTypeOf<(i: LocaliseInput) => LocaliseResult>();
    expectTypeOf(scorecard.buildScorecard).toEqualTypeOf<(i: ScorecardInput) => { rows: UpdateRow[]; findings: Finding[] }>();
  });

  it('WP-C', () => {
    expectTypeOf(inspection.inspectionCollector).toEqualTypeOf<Collector<InspectionPlan>>();
    expectTypeOf(crawl.crawlCollector).toEqualTypeOf<Collector<CrawlPlan>>();
    expectTypeOf(diff.deriveSiteChanges).toEqualTypeOf<
      (i: {
        snapshots: SnapshotRecord[];
        fieldsByHash: Map<string, PageFields>;
        annotations: Annotation[];
        inspections: InspectionRecord[];
        templates: Map<string, string>;
      }) => SiteChange[]
    >();
    expectTypeOf(extract.extractFields).toEqualTypeOf<(html: string, pageUrl: string, property: string) => PageFields>();
    expectTypeOf(annotations.addAnnotation).toEqualTypeOf<
      (store: DataStore, a: Omit<Annotation, 'id' | 'at'>, clock: Clock) => Promise<Annotation>
    >();
    expectTypeOf(siteChange.analyzeSiteChanges).toEqualTypeOf<
      (i: SiteChangeInput) => { impacts: SiteChangeImpact[]; findings: Finding[] }
    >();
    expectTypeOf(indexState.analyzeIndexStates).toEqualTypeOf<
      (i: { inspections: InspectionRecord[]; dataThrough: IsoDate }) => Finding[]
    >();
  });

  it('WP-D', () => {
    expectTypeOf(serp.serpCollectCollector).toEqualTypeOf<Collector<SerpCollectPlan>>();
    expectTypeOf(serp.serpPoster).toEqualTypeOf<SerpPoster>();
    expectTypeOf(normalize.normalizeSerp).toEqualTypeOf<
      (
        raw: unknown,
        ctx: { intentKey: string; isoWeek: string; design: SampleDesignKind; pi: number; siteDomain: string },
      ) => SerpObservation
    >();
    expectTypeOf(aio.analyzeAio).toEqualTypeOf<(i: AioInput) => AioOutput>();
    expectTypeOf(graphBuild.buildGraph).toEqualTypeOf<(i: GraphInput) => GraphDoc>();
    expectTypeOf(graphWrite.writeGraph).toEqualTypeOf<
      (store: DataStore, doc: GraphDoc, o: { property: string; force: boolean }) => Promise<{ nodes: number; links: number; path: string }>
    >();
  });

  it('WP-E', () => {
    expectTypeOf(windows.computeWindows).toEqualTypeOf<(dataThrough: IsoDate, windowDays: number) => AnalysisWindows>();
    expectTypeOf(brand.buildBrandMatcher).toEqualTypeOf<
      (i: { siteDomain: string; siteName: string | null; terms: string[] }) => BrandMatcher
    >();
    expectTypeOf(ctrCurve.fitCurve).toEqualTypeOf<
      (cells: CurveCell[], o: { fitWindow: [IsoDate, IsoDate]; holdoutFrom: IsoDate }) => CtrCurve
    >();
    expectTypeOf(analysis.runAnalysis).toEqualTypeOf<(i: AnalysisInput) => AnalysisOutput>();
    expectTypeOf(fixture.writeDemoFixture).toEqualTypeOf<(store: DataStore) => Promise<DemoTruth>>();
  });

  it('WP-F', () => {
    expectTypeOf(copy.renderSentence).toEqualTypeOf<(template: TemplateId, slots: Slots) => string>();
    expectTypeOf(copy.renderAlt).toEqualTypeOf<(key: AltKey, slots: Slots) => string>();
    expectTypeOf(copy.renderFalsifier).toEqualTypeOf<(key: FalsifierKey, slots: Slots) => string>();
    expectTypeOf(copy.REAL_LABEL).toEqualTypeOf<Record<Verdict, string>>();
    expectTypeOf(copy.BADGE).toEqualTypeOf<Record<Confidence, string>>();
    expectTypeOf(copy.CAUSE_LABEL).toEqualTypeOf<Record<Cause, string>>();
    expectTypeOf(html.renderReports).toEqualTypeOf<
      (out: AnalysisOutput, ctx: ReportContext) => { html: string; md: string; json: string }
    >();
    expectTypeOf(why.renderWhy).toEqualTypeOf<(out: AnalysisOutput, target: string | null, o: { color: boolean }) => string>();
    expectTypeOf(pipeline.runPipeline).toEqualTypeOf<(o: PipelineOptions) => Promise<RunSummary>>();
    expectTypeOf(cliMain.main).toEqualTypeOf<(argv: string[]) => Promise<number>>();
  });

  it('Phase 2 additions to core/types.ts are optional, so Phase 1 callers still compile', () => {
    expectTypeOf<GoogleAuth['source']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<GoogleAuth['invalidate']>>().toEqualTypeOf<() => void>();
    expectTypeOf<HttpRequest['gunzip']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CurveCell['date']>().toEqualTypeOf<IsoDate | undefined>();
    expectTypeOf<AioInput['fdrQ']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NonNullable<ScopeDecomposition['ci95']>['ranking']>().toEqualTypeOf<[number, number] | undefined>();
    expectTypeOf<NonNullable<Finding['componentCi95']>['churn']>().toEqualTypeOf<[number, number] | undefined>();
    expectTypeOf<DemoTruth['expect'][number]['eventId']>().toEqualTypeOf<string | undefined>();
    // An object written to the Phase 0 shapes still satisfies them.
    const auth: GoogleAuth = { kind: 'service_account', principal: 'p', scopes: [], headers: async () => ({}) };
    const cell: CurveCell = { p: 1, c: 0, i: 1, seg: 'desktop|brand' };
    expect(auth.invalidate).toBeUndefined();
    expect(cell.date).toBeUndefined();
  });

  it('every module loads and every 2.4 export exists', () => {
    const fns: [string, unknown][] = Object.entries({
      ...config, ...errors, ...log, ...secrets, ...time, ...ids, ...url, ...templates, ...rng, ...request, ...limiter,
      ...layout, ...store, ...lock, ...db, ...stats, ...verdicts, ...auth, ...gscPlan, ...updates, ...changepoint,
      ...localiseMod, ...scorecard, ...diff, ...extract, ...annotations, ...siteChange, ...indexState, ...normalize, ...aio,
      ...graphBuild, ...graphWrite, ...windows, ...brand, ...ctrCurve, ...analysis, ...fixture, ...copy, ...html, ...why,
      ...pipeline, ...cliMain,
    });
    const names = new Set(fns.map(([n]) => n));
    const expected = [
      'ConfigSchema', 'loadConfig', 'writeConfig', 'defaultConfig', 'configHash', 'ExitCode', 'StError', 'notImplemented',
      'createLogger', 'createSecretRegistry', 'ptDate', 'addDays', 'diffDays', 'dateRange', 'isoWeek', 'weekday', 'isIsoDate',
      'ptDayStart', 'systemClock', 'fixedClock', 'sha256Hex', 'b32', 'hash32', 'nodeId', 'findingId', 'intentKey', 'newRunId',
      'normalizeUrl', 'siteDomainOf', 'isOnProperty', 'domainMatches', 'pathOf', 'defaultOrigins', 'isPrivateHost',
      'clusterTemplates', 'mulberry32', 'rngFor', 'request', 'requestJson', 'createLimiter', 'layout', 'resolveInside',
      'openStore', 'acquireLock', 'openIndex', 'lgamma', 'logBetaBinomial', 'pava', 'quantile', 'percentileCi', 'bootstrapP',
      'benjaminiHochberg', 'kolmogorovTail', 'chiSquareTail', 'normalCdf', 'normalQuantile', 'poissonDraw', 'mad', 'theilSen',
      'dowFactors', 'seasonalSeries', 'overdispersion', 'periodCompare', 'DEFAULT_DELTA', 'decideVerdict', 'powerFromCi',
      'powerFromCounts', 'confidenceFor', 'loadGoogleAuth', 'listSites', 'planGsc', 'updatesCollector', 'loadSeedEvents',
      'classifyIncident', 'measurementEvents', 'analyzeChangePoints', 'localise', 'buildScorecard', 'deriveSiteChanges',
      'extractFields', 'addAnnotation', 'analyzeSiteChanges', 'analyzeIndexStates', 'normalizeSerp', 'analyzeAio',
      'buildGraph', 'writeGraph', 'computeWindows', 'buildBrandMatcher', 'fitCurve', 'runAnalysis', 'writeDemoFixture',
      'renderSentence', 'renderAlt', 'renderFalsifier', 'REAL_LABEL', 'BADGE', 'CAUSE_LABEL', 'renderReports', 'renderWhy',
      'runPipeline', 'main',
    ];
    expect(expected.filter((n) => !names.has(n))).toEqual([]);
    expect(gsc.gscCollector.name).toBe('gsc');
    expect(updates.updatesCollector.name).toBe('updates');
    expect(inspection.inspectionCollector.name).toBe('inspect');
    expect(crawl.crawlCollector.name).toBe('crawl');
    expect(serp.serpCollectCollector.name).toBe('serp_collect');
    expect(typeof serp.serpPoster.plan).toBe('function');
  });
});
