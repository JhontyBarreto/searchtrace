// buildGraph from IndexReader + AnalysisOutput (7.2, 7.3). Owner: WP-D.
//
// Pure: the same index, analysis and previous communities give the same graph. Temporal
// attributes (first_seen, last_seen, valid_from, valid_to, observations, first_reported,
// last_reported) come from the full stored history in the index. Edges are one per unordered
// pair; when two relations meet on a pair the higher-precedence one wins and the other's
// attributes are kept under `also`.
import { buildBrandMatcher } from '../analyze/brand.js';
import { nodeId } from '../core/ids.js';
import { addDays, diffDays, ptDate } from '../core/time.js';
import { domainMatches, pathOf } from '../core/url.js';
import type {
  Cause, Confidence, Finding, GEdge, GNode, GoogleEvent, GraphDoc, GraphInput, InspectionRecord, IsoDate, NodeKind, SerpObservation, SiteChange,
} from '../core/types.js';
import { CAUSE_LABEL, REAL_LABEL } from '../report/copy.js';
import { carryForward } from './merge.js';
import {
  CONFIG_FILE, ANNOTATIONS_FILE, FIELD_LABEL, FILE_TYPE_OF, NODE_ID_PATTERN, type PartitionIndex, type Relation, eventRange, fmtDay,
  gscPathFor, indexPartitions, overlapDays, partitionAfter, partitionHolding, precedenceOf, stripWww, truncate,
} from './model.js';

export const PAGE_CAP = 5000;
export const DOMAIN_CAP = 200;
export const AIO_FACT_CAP = 200;
export const PAST_FINDING_DAYS = 365;
const LABEL_MAX = 120;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function compact(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** WP-E's brand matcher when it is available, else "contains a brand token". */
function brandTest(i: GraphInput): (q: string) => boolean {
  const tokens = i.analysis.diagnostics.brandTokens ?? [];
  try {
    const m = buildBrandMatcher({ siteDomain: i.siteDomain, siteName: null, terms: tokens });
    return (q) => m.isBrand(q);
  } catch {
    const label = compact(i.siteDomain.split('.')[0] ?? '');
    const terms = [...new Set([...tokens.map(compact), label])].filter((t) => t.length >= 4);
    return (q) => {
      const c = compact(q);
      return terms.some((t) => c.includes(t));
    };
  }
}

/** Calendar-month chunks covering [from, to]. */
function monthChunks(from: IsoDate, to: IsoDate): [IsoDate, IsoDate][] {
  const out: [IsoDate, IsoDate][] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const end = addDays(nextMonth, -1);
    out.push([start, end < to ? end : to]);
    start = nextMonth;
  }
  return out;
}

interface EdgeIn {
  source: string;
  target: string;
  relation: Relation;
  confidence: Confidence;
  source_file: string;
  weight: number;
  [k: string]: unknown;
}

class GraphBuilder {
  readonly nodes = new Map<string, GNode>();
  readonly edges = new Map<string, GEdge>();

  node(kind: NodeKind, key: string, label: string, sourceFile: string, attrs: Record<string, unknown>): string {
    const id = nodeId(kind, key);
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { ...attrs, id, label: label || key || kind, file_type: FILE_TYPE_OF[kind], source_file: sourceFile, kind });
    }
    return id;
  }

  /** Adds a node with an id the caller already has (site changes carry their own). */
  nodeWithId(id: string, kind: NodeKind, label: string, sourceFile: string, attrs: Record<string, unknown>): string {
    if (!this.nodes.has(id)) this.nodes.set(id, { ...attrs, id, label, file_type: FILE_TYPE_OF[kind], source_file: sourceFile, kind });
    return id;
  }

  edge(e: EdgeIn): void {
    if (!this.nodes.has(e.source) || !this.nodes.has(e.target) || e.source === e.target) return;
    const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source];
    const key = `${a}\u0000${b}`;
    const next: GEdge = { ...e, source: a, target: b };
    const prev = this.edges.get(key);
    if (!prev) {
      this.edges.set(key, next);
      return;
    }
    if (prev.relation === next.relation) return;
    const [win, lose] = precedenceOf(next.relation) < precedenceOf(prev.relation) ? [next, prev] : [prev, next];
    const { source: _s, target: _t, relation, also: loseAlso, ...rest } = lose;
    const also = { ...((win.also as Record<string, unknown> | undefined) ?? {}), ...((loseAlso as Record<string, unknown> | undefined) ?? {}), [relation]: rest };
    this.edges.set(key, { ...win, also });
  }

  doc(graph: Record<string, unknown>): GraphDoc {
    const nodes = [...this.nodes.values()].sort((x, y) => cmp(x.id, y.id));
    const links = [...this.edges.values()].sort((x, y) => cmp(x.source, y.source) || cmp(x.target, y.target) || cmp(x.relation, y.relation));
    return { directed: false, multigraph: false, graph, nodes, links };
  }
}

interface PageStat { c28: number; i28: number; ps28: number; cBase: number; i90: number }

function findingInterval(f: Finding): [IsoDate, IsoDate] | null {
  if (f.dateWindow) return f.dateWindow;
  if (f.windows) return f.windows.current;
  return f.date ? [f.date, f.date] : null;
}

function monthOfDay(prefix: 'findings', d: IsoDate): string {
  return `${prefix}/${d.slice(0, 4)}/${d.slice(5, 7)}/`;
}

function edgeSource(f: Finding, fallback: string): { source_file: string; evidence?: string[] } {
  const parts = [...new Set(f.evidence.map((e) => e.partition).filter((p) => typeof p === 'string' && p.length > 0))];
  if (parts.length === 0) return { source_file: fallback };
  return parts.length > 1 ? { source_file: parts[0], evidence: parts.slice(1, 6) } : { source_file: parts[0] };
}

function siteChangeLabel(c: SiteChange): string {
  if (c.source === 'annotation') {
    const day = ptDate(c.deployed.from);
    return truncate(`Noted: ${c.text ?? 'a change'} (${fmtDay(day)})`, LABEL_MAX);
  }
  const n = c.touched.length;
  const day = fmtDay(ptDate(c.deployed.to));
  const where = c.templateKey === 'other pages' ? `${n} other page${n === 1 ? '' : 's'}` : `${n} ${c.templateKey} page${n === 1 ? '' : 's'}`;
  return truncate(`${FIELD_LABEL[c.field] ?? c.field} changed on ${where} (${day})`, LABEL_MAX);
}

function siteChangeId(c: SiteChange): string {
  return NODE_ID_PATTERN.test(c.id) && c.id.startsWith('sitechg_') ? c.id : nodeId('sitechg', c.id);
}

export function buildGraph(i: GraphInput): GraphDoc {
  const a = i.analysis;
  const g = new GraphBuilder();
  const D = i.dataThrough;
  const Wc = a.windows.current;
  const Wb = a.windows.baseline;
  const range = i.db.dataRange();
  const first = range.first ?? Wb[0];
  const ix: PartitionIndex = indexPartitions(i.db.partitionsUsed().map((p) => p.path));
  const isBrand = brandTest(i);

  // ---------- findings in scope ----------
  const current: Finding[] = [];
  let aioFacts = 0;
  for (const f of a.findings) {
    if (f.kind === 'aio_fact' && aioFacts++ >= AIO_FACT_CAP) continue;
    current.push(f);
  }
  const currentIds = new Set(current.map((f) => f.id));
  const hist = i.db.findingsHistory();
  const past: { f: Finding; first: IsoDate; last: IsoDate }[] = [];
  for (const [id, h] of [...hist.entries()].sort(([x], [y]) => cmp(x, y))) {
    if (currentIds.has(id) || h.last.real !== 'signal' || diffDays(h.lastReported, D) > PAST_FINDING_DAYS) continue;
    if (h.last.kind === 'aio_fact' && aioFacts++ >= AIO_FACT_CAP) continue;
    past.push({ f: h.last, first: h.firstReported, last: h.lastReported });
  }
  const allFindings = [...current.map((f) => ({ f, isCurrent: true })), ...past.map((p) => ({ f: p.f, isCurrent: false }))];

  const forcedPages = new Set<string>();
  const forcedQueries = new Set<string>();
  const forcedTemplates = new Set<string>();
  for (const { f } of allFindings) {
    if (f.unit.level === 'page') forcedPages.add(f.unit.key);
    if (f.unit.level === 'query') forcedQueries.add(f.unit.key);
    if (f.unit.level === 'template') forcedTemplates.add(f.unit.key);
    if (f.verify?.page) forcedPages.add(f.verify.page);
  }
  for (const c of a.siteChanges) for (const t of c.touched) forcedPages.add(t.url);
  const serp: SerpObservation[] = i.db.serp();
  for (const o of serp) forcedQueries.add(o.keyword);

  // ---------- site ----------
  const siteTotals = i.db.siteDaily(Wc[0], Wc[1]).reduce((s, r) => ({ c: s.c + r.c, i: s.i + r.i }), { c: 0, i: 0 });
  const siteId = g.node('site', i.siteDomain, `${i.siteDomain} (whole site)`, CONFIG_FILE, {
    property: i.property, clicks_28d: siteTotals.c, impr_28d: siteTotals.i,
  });

  // ---------- pages ----------
  const statFrom = [addDays(D, -89), Wb[0], Wc[0]].sort(cmp)[0];
  const pageStats = new Map<string, PageStat>();
  for (const r of i.db.pageDaily(statFrom, D)) {
    const s = pageStats.get(r.p) ?? { c28: 0, i28: 0, ps28: 0, cBase: 0, i90: 0 };
    if (r.date >= Wc[0] && r.date <= Wc[1]) {
      s.c28 += r.c;
      s.i28 += r.i;
      s.ps28 += r.ps;
    }
    if (r.date >= Wb[0] && r.date <= Wb[1]) s.cBase += r.c;
    if (r.date >= addDays(D, -89)) s.i90 += r.i;
    pageStats.set(r.p, s);
  }
  const snapshots = i.db.snapshots();
  const firstSnap = new Map<string, string>();
  for (const s of snapshots) if (!firstSnap.has(s.url)) firstSnap.set(s.url, s.fetchedAt);
  const inspections: InspectionRecord[] = [...i.db.inspections()].sort((x, y) => cmp(x.url, y.url) || cmp(x.inspectedAt, y.inspectedAt));
  const latestInspection = new Map<string, InspectionRecord>();
  const lastCrawl = new Map<string, string>();
  for (const r of inspections) {
    latestInspection.set(r.url, r);
    if (r.lastCrawlTime && (!lastCrawl.has(r.url) || (lastCrawl.get(r.url) as string) < r.lastCrawlTime)) lastCrawl.set(r.url, r.lastCrawlTime);
  }
  const pageReal = new Map<string, string>();
  for (const f of current) {
    if (f.unit.level !== 'page') continue;
    if (f.kind === 'waterfall' || !pageReal.has(f.unit.key)) pageReal.set(f.unit.key, f.real);
  }
  const known = new Map(i.db.pages().map((p) => [p.url, p]));
  for (const url of forcedPages) if (!known.has(url)) known.set(url, { url, firstSeen: D, lastSeen: D });
  const ranked = [...known.values()]
    .filter((p) => !forcedPages.has(p.url))
    .sort((x, y) => (pageStats.get(y.url)?.i90 ?? 0) - (pageStats.get(x.url)?.i90 ?? 0) || cmp(x.url, y.url))
    .slice(0, Math.max(0, PAGE_CAP - forcedPages.size));
  const includedPages = [...ranked, ...[...forcedPages].map((u) => known.get(u) as { url: string; firstSeen: IsoDate; lastSeen: IsoDate })]
    .sort((x, y) => cmp(x.url, y.url));
  const pageIds = new Map<string, string>();
  const templateOf = (url: string): string | null => a.templates[url] ?? null;
  for (const p of includedPages) {
    const st = pageStats.get(p.url);
    const snap = firstSnap.get(p.url);
    const inGsc = !!st || !snap || p.firstSeen < ptDate(snap);
    const insp = latestInspection.get(p.url);
    // graphify ignores a query with no letters or digits, so a bare "/" can never be asked about;
    // "/ (homepage)" can ("graphify explain homepage").
    const path = pathOf(p.url) || '/';
    const id = g.node('page', p.url, path === '/' ? '/ (homepage)' : path, inGsc || !snap ? gscPathFor(ix, p.firstSeen) : partitionHolding(ix, 'crawl', snap), {
      url: p.url, template: templateOf(p.url), first_seen: p.firstSeen, last_seen: p.lastSeen,
      clicks_28d: st?.c28 ?? 0, impr_28d: st?.i28 ?? 0, pos_28d: st && st.i28 > 0 ? st.ps28 / st.i28 : null,
      delta_clicks: st ? st.c28 - st.cBase : 0, real: pageReal.get(p.url) ?? null,
      index_state: insp?.coverageState ?? null, last_crawl: lastCrawl.get(p.url) ?? null,
    });
    pageIds.set(p.url, id);
  }

  // ---------- templates ----------
  const templateCounts = new Map<string, number>();
  for (const t of Object.values(a.templates)) templateCounts.set(t, (templateCounts.get(t) ?? 0) + 1);
  const tplIds = new Map<string, string>();
  const ensureTpl = (key: string): string => {
    let id = tplIds.get(key);
    if (!id) {
      id = g.node('tpl', key, key, CONFIG_FILE, { pages: templateCounts.get(key) ?? 0 });
      tplIds.set(key, id);
      g.edge({ source: id, target: siteId, relation: 'part_of', confidence: 'INFERRED', source_file: CONFIG_FILE, weight: 0.5 });
    }
    return id;
  };
  for (const p of includedPages) {
    const t = templateOf(p.url);
    if (t) g.edge({ source: pageIds.get(p.url) as string, target: ensureTpl(t), relation: 'instance_of', confidence: 'INFERRED', source_file: CONFIG_FILE, weight: 1 });
  }
  for (const t of [...forcedTemplates].sort()) ensureTpl(t);

  // ---------- queries and ranks_for ----------
  const recent = new Map<string, number>();
  const recentFrom = [addDays(D, -89), Wc[0]].sort(cmp)[0];
  for (const [from, to] of monthChunks(recentFrom, D)) {
    for (const c of i.db.cells(from, to)) recent.set(c.q, (recent.get(c.q) ?? 0) + c.i);
  }
  const top = [...recent.entries()].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).slice(0, Math.max(0, i.maxQueries)).map(([q]) => q);
  const selected = [...new Set([...top, ...forcedQueries])].sort(cmp);
  interface QAgg { first: IsoDate; last: IsoDate; c: number; i: number; ps: number }
  interface PairAgg extends QAgg { obs: number; lastDate: IsoDate; i28: number }
  const qAgg = new Map<string, QAgg>();
  const pairs = new Map<string, PairAgg>();
  if (selected.length && range.sealedThrough) {
    for (const [from, to] of monthChunks(first, D)) {
      for (const c of i.db.cells(from, to, { queries: selected })) {
        if (!(c.i > 0)) continue;
        const inWc = c.date >= Wc[0] && c.date <= Wc[1];
        const q = qAgg.get(c.q) ?? { first: c.date, last: c.date, c: 0, i: 0, ps: 0 };
        if (c.date < q.first) q.first = c.date;
        if (c.date > q.last) q.last = c.date;
        if (inWc) {
          q.c += c.c;
          q.i += c.i;
          q.ps += c.ps;
        }
        qAgg.set(c.q, q);
        const pk = `${c.p}\u0000${c.q}`;
        const pr = pairs.get(pk) ?? { first: c.date, last: c.date, c: 0, i: 0, ps: 0, obs: 0, lastDate: '', i28: 0 };
        if (pr.lastDate !== c.date) {
          pr.obs++;
          pr.lastDate = c.date;
        }
        if (c.date < pr.first) pr.first = c.date;
        if (c.date > pr.last) pr.last = c.date;
        if (inWc) {
          pr.c += c.c;
          pr.i += c.i;
          pr.ps += c.ps;
        }
        pairs.set(pk, pr);
      }
    }
  }
  const serpByKeyword = new Map<string, SerpObservation[]>();
  for (const o of serp) {
    const list = serpByKeyword.get(o.keyword) ?? [];
    list.push(o);
    serpByKeyword.set(o.keyword, list);
  }
  const queryIds = new Map<string, string>();
  for (const q of selected) {
    const agg = qAgg.get(q);
    const checksAll = serpByKeyword.get(q) ?? [];
    const checks = checksAll.filter((o) => ptDate(o.observedAt) >= Wc[0]);
    const use = checks.length ? checks : checksAll;
    const withAio = use.filter((o) => o.aio !== null);
    const cited = withAio.filter((o) => o.aio?.citesUs).length;
    const source = agg ? gscPathFor(ix, agg.first) : checksAll[0] ? partitionAfter(ix, 'serp', checksAll[0].observedAt) : CONFIG_FILE;
    const id = g.node('query', q, q, source, {
      brand: isBrand(q), first_seen: agg?.first ?? null, last_seen: agg?.last ?? null,
      clicks_28d: agg?.c ?? 0, impr_28d: agg?.i ?? 0, pos_28d: agg && agg.i > 0 ? agg.ps / agg.i : null,
      aio_present_share: use.length ? withAio.length / use.length : null, aio_cites_us: withAio.length ? cited / withAio.length >= 0.5 : null,
    });
    queryIds.set(q, id);
  }
  for (const [pk, pr] of [...pairs.entries()].sort(([x], [y]) => cmp(x, y))) {
    const [p, q] = pk.split('\u0000');
    const pid = pageIds.get(p);
    const qid = queryIds.get(q);
    if (!pid || !qid) continue;
    const lastPath = gscPathFor(ix, pr.last);
    const firstPath = gscPathFor(ix, pr.first);
    g.edge({
      source: pid, target: qid, relation: 'ranks_for', confidence: 'EXTRACTED', source_file: lastPath,
      weight: Math.max(0.01, Math.log1p(pr.i)), clicks_28d: pr.c, impr_28d: pr.i, pos_28d: pr.i > 0 ? pr.ps / pr.i : null,
      first_seen: pr.first, last_seen: pr.last, valid_from: pr.first, valid_to: pr.i > 0 ? null : pr.last, observations: pr.obs,
      ...(firstPath !== lastPath ? { evidence: [firstPath] } : {}),
    });
  }

  // ---------- domains and competes_with ----------
  const site = stripWww(i.siteDomain);
  interface DomAgg { aio: number; outranks: number; checks: number; firstAt: string; lastAt: string }
  const doms = new Map<string, DomAgg>();
  const qdoms = new Map<string, DomAgg>();
  const bump = (m: Map<string, DomAgg>, key: string, at: string, aio: boolean, out: boolean): void => {
    const x = m.get(key) ?? { aio: 0, outranks: 0, checks: 0, firstAt: at, lastAt: at };
    x.checks++;
    if (aio) x.aio++;
    if (out) x.outranks++;
    if (at < x.firstAt) x.firstAt = at;
    if (at > x.lastAt) x.lastAt = at;
    m.set(key, x);
  };
  for (const o of serp) {
    const cited = new Set((o.aio?.refs ?? []).map((r) => stripWww(r.domain)).filter((d) => d && !domainMatches(d, site)));
    const ourRank = o.ours?.rankAbsolute ?? Number.POSITIVE_INFINITY;
    const above = new Set(o.organic.filter((x) => x.rankAbsolute < ourRank).map((x) => stripWww(x.domain)).filter((d) => d && !domainMatches(d, site)));
    const all = new Set([...cited, ...o.organic.map((x) => stripWww(x.domain)).filter((d) => d && !domainMatches(d, site))]);
    for (const d of [...all].sort()) {
      bump(doms, d, o.observedAt, cited.has(d), above.has(d));
      bump(qdoms, `${o.keyword}\u0000${d}`, o.observedAt, cited.has(d), above.has(d));
    }
  }
  const domIds = new Map<string, string>();
  const topDoms = [...doms.entries()].sort((x, y) => y[1].checks - x[1].checks || y[1].aio - x[1].aio || cmp(x[0], y[0])).slice(0, DOMAIN_CAP);
  for (const [d, x] of topDoms.sort(([p], [q]) => cmp(p, q))) {
    domIds.set(d, g.node('dom', d, d, partitionAfter(ix, 'serp', x.firstAt), { aio_citations: x.aio, organic_outranks: x.outranks, checks: x.checks }));
  }
  for (const [key, x] of [...qdoms.entries()].sort(([p], [q]) => cmp(p, q))) {
    const [q, d] = key.split('\u0000');
    const qid = queryIds.get(q);
    const did = domIds.get(d);
    if (!qid || !did) continue;
    g.edge({
      source: qid, target: did, relation: 'competes_with', confidence: 'EXTRACTED', source_file: partitionAfter(ix, 'serp', x.lastAt),
      weight: Math.max(0.01, Math.log1p(x.checks)), aio_citations: x.aio, organic_outranks: x.outranks, checks: x.checks,
    });
  }

  // ---------- site changes ----------
  const changeIds = new Map<string, string>();
  for (const c of [...a.siteChanges].sort((x, y) => cmp(x.id, y.id))) {
    const seen = c.touched.map((t) => t.googleSeen).filter((s): s is NonNullable<typeof s> => s !== null);
    const src = c.source === 'annotation' ? ANNOTATIONS_FILE : partitionHolding(ix, 'crawl', c.deployed.to);
    const id = g.nodeWithId(siteChangeId(c), 'sitechg', siteChangeLabel(c), src, {
      field: c.field, cls: c.cls, source: c.source, deployed_from: c.deployed.from, deployed_to: c.deployed.to,
      google_seen_from: seen.length ? seen.map((s) => s.from).sort()[0] : null,
      google_seen_to: seen.length ? seen.map((s) => s.to).sort()[seen.length - 1] : null, touched: c.touched.length,
    });
    changeIds.set(c.id, id);
    for (const t of [...c.touched].sort((x, y) => cmp(x.url, y.url))) {
      const pid = pageIds.get(t.url);
      if (!pid) continue;
      g.edge({
        source: id, target: pid, relation: 'touched', confidence: 'EXTRACTED', source_file: src, weight: 1,
        before: t.before === null ? null : truncate(t.before, 200), after: t.after === null ? null : truncate(t.after, 200),
        google_seen_from: t.googleSeen?.from ?? null, google_seen_to: t.googleSeen?.to ?? null,
      });
    }
  }

  // ---------- Google events ----------
  const referencedEvents = new Set(allFindings.flatMap(({ f }) => f.related.googleEvents));
  const eventIds = new Map<string, string>();
  const eventRanges = new Map<string, [IsoDate, IsoDate]>();
  for (const ev of i.db.googleEvents() as GoogleEvent[]) {
    const r = eventRange(ev.begin, ev.end);
    if (!referencedEvents.has(ev.id) && (r[1] < first || r[0] > D)) continue;
    eventRanges.set(ev.id, r);
    eventIds.set(ev.id, g.node('gupd', ev.id, ev.title, partitionAfter(ix, 'google', ev.modified ?? ev.begin), {
      kind: ev.kind, begin: ev.begin, end: ev.end, end_estimated: ev.endEstimated, url: ev.url,
    }));
  }

  // ---------- index states ----------
  const stateIds = new Map<string, string>();
  const byUrl = new Map<string, InspectionRecord[]>();
  for (const r of inspections) {
    if (!r.coverageState) continue;
    const list = byUrl.get(r.url) ?? [];
    list.push(r);
    byUrl.set(r.url, list);
    if (!stateIds.has(r.coverageState)) {
      stateIds.set(r.coverageState, g.node('idx', r.coverageState, r.coverageState, partitionHolding(ix, 'inspect', r.inspectedAt), { state: r.coverageState }));
    }
  }
  for (const [url, list] of [...byUrl.entries()].sort(([x], [y]) => cmp(x, y))) {
    const pid = pageIds.get(url);
    if (!pid) continue;
    const runs: { value: string; from: IsoDate; to: IsoDate | null; lastAt: string }[] = [];
    for (const r of list) {
      const prev = runs[runs.length - 1];
      if (prev && prev.value === r.coverageState) prev.lastAt = r.inspectedAt;
      else {
        if (prev) prev.to = ptDate(r.inspectedAt);
        runs.push({ value: r.coverageState as string, from: ptDate(r.inspectedAt), to: null, lastAt: r.inspectedAt });
      }
    }
    const history = runs.slice(-10).map((x) => ({ from: x.from, to: x.to, value: x.value }));
    for (const value of [...new Set(runs.map((x) => x.value))].sort()) {
      const mine = runs.filter((x) => x.value === value);
      const last = mine[mine.length - 1];
      g.edge({
        source: pid, target: stateIds.get(value) as string, relation: 'in_state', confidence: 'EXTRACTED',
        source_file: partitionHolding(ix, 'inspect', last.lastAt), weight: 0.1,
        valid_from: mine[0].from, valid_to: last.to, history,
      });
    }
  }

  // ---------- findings ----------
  const causeIds = new Map<Cause, string>();
  const unitTarget = (f: Finding): string | null => {
    switch (f.unit.level) {
      case 'site':
        return siteId;
      case 'template':
        return ensureTpl(f.unit.key);
      case 'page':
        return pageIds.get(f.unit.key) ?? null;
      case 'query':
        return queryIds.get(f.unit.key) ?? null;
      default:
        return null;
    }
  };
  for (const { f, isCurrent } of [...allFindings].sort((x, y) => cmp(x.f.id, y.f.id))) {
    const h = hist.get(f.id);
    const firstReported = h?.firstReported ?? D;
    const lastReported = isCurrent ? D : (h?.lastReported ?? D);
    let label: string;
    try {
      label = truncate(i.renderLabel(f), LABEL_MAX);
    } catch {
      label = truncate(`${f.kind.replace(/_/g, ' ')}: ${f.unit.label}`, LABEL_MAX);
    }
    const src = monthOfDay('findings', firstReported);
    const fid = g.node('finding', f.id, label, src, {
      finding_id: f.id, kind: f.kind, real: f.real, real_label: REAL_LABEL[f.real] ?? f.real, cause: f.cause,
      confidence: f.causeConfidence, estimate: num(f.effect.estimate), ci_lo: num(f.effect.ci95?.[0]), ci_hi: num(f.effect.ci95?.[1]),
      method: f.analyzer.name, first_reported: firstReported, last_reported: lastReported, current: isCurrent,
    });
    const ev = edgeSource(f, src);
    const target = unitTarget(f);
    if (target) g.edge({ source: fid, target, relation: 'about', confidence: 'EXTRACTED', weight: 1, ...ev });
    if (f.kind === 'site_change_impact') {
      for (const sc of f.related.siteChanges) {
        const cid = changeIds.get(sc) ?? (g.nodes.has(sc) ? sc : null);
        if (!cid) continue;
        g.edge({
          source: fid, target: cid, relation: 'measures', confidence: f.real === 'signal' ? 'INFERRED' : 'AMBIGUOUS', weight: 1, ...ev,
          tau: num(f.effect.estimate), ci_lo: num(f.effect.ci95?.[0]), ci_hi: num(f.effect.ci95?.[1]),
        });
      }
    }
    if (f.cause) {
      let cid = causeIds.get(f.cause);
      if (!cid) {
        cid = g.node('cause', f.cause, CAUSE_LABEL[f.cause] ?? f.cause, CONFIG_FILE, { cause: f.cause });
        causeIds.set(f.cause, cid);
      }
      g.edge({ source: fid, target: cid, relation: 'attributed_to', confidence: f.causeConfidence, weight: f.real === 'signal' ? 1 : 0.3, ...ev });
    }
    const interval = findingInterval(f);
    const strong = f.real === 'signal' && (f.cause === 'google_update' || f.cause === 'site_change');
    for (const eid of f.related.googleEvents) {
      const nid = eventIds.get(eid);
      if (!nid) continue;
      g.edge({
        source: fid, target: nid, relation: 'coincides_with', confidence: strong ? 'INFERRED' : 'AMBIGUOUS', weight: 0.5,
        source_file: g.nodes.get(nid)?.source_file ?? src,
        overlap_days: interval ? overlapDays(interval, eventRanges.get(eid) as [IsoDate, IsoDate]) : 0,
      });
    }
    for (const sc of f.related.siteChanges) {
      const cid = changeIds.get(sc);
      const change = a.siteChanges.find((c) => c.id === sc);
      if (!cid || !change) continue;
      const span: [IsoDate, IsoDate] = [ptDate(change.deployed.from), ptDate(change.deployed.to)];
      g.edge({
        source: fid, target: cid, relation: 'coincides_with', confidence: strong ? 'INFERRED' : 'AMBIGUOUS', weight: 0.5,
        source_file: g.nodes.get(cid)?.source_file ?? src, overlap_days: interval ? overlapDays(interval, span) : 0,
      });
    }
  }

  // ---------- internal links ----------
  const fields = i.db.fieldsByHash();
  const links = new Map<string, { first: IsoDate; last: IsoDate; lastAt: string }>();
  for (const s of snapshots) {
    if (!pageIds.has(s.url) || !s.fieldsHash || (s.outcome !== 'ok' && s.outcome !== 'not_modified')) continue;
    const pf = fields.get(s.fieldsHash);
    if (!pf) continue;
    const day = ptDate(s.fetchedAt);
    for (const to of pf.internalLinks) {
      if (to === s.url || !pageIds.has(to)) continue;
      const key = `${s.url}\u0000${to}`;
      const x = links.get(key);
      if (!x) links.set(key, { first: day, last: day, lastAt: s.fetchedAt });
      else {
        if (day < x.first) x.first = day;
        if (s.fetchedAt > x.lastAt) {
          x.last = day;
          x.lastAt = s.fetchedAt;
        }
      }
    }
  }
  for (const [key, x] of [...links.entries()].sort(([p], [q]) => cmp(p, q))) {
    const [from, to] = key.split('\u0000');
    g.edge({
      source: pageIds.get(from) as string, target: pageIds.get(to) as string, relation: 'links_to', confidence: 'EXTRACTED',
      source_file: partitionHolding(ix, 'crawl', x.lastAt), weight: 0.5, first_seen: x.first, last_seen: x.last,
    });
  }

  const doc = g.doc({ generator: 'searchtrace', property: i.property, data_through: D });
  return carryForward(doc, i.previous);
}
