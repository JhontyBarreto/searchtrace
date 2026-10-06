// Byte-stable serialisation, atomic write, sidecar, graphify-safety assertions (7.1). Owner: WP-D.
//
// - Ownership: an existing graph.json is overwritten only when it is ours (sidecar names this
//   property, or every node id has our shape). Otherwise StError('graph_not_ours'), unless forced.
// - Merge: community and community_name are carried forward from our previous graph.
// - Safety: every node passes graphify's validator, links are unique unordered pairs between
//   existing nodes, and no node id equals or extends a stem graphify derives from its
//   source_file (graphify would otherwise re-key the node, 0.2 F10).
// - Bytes: nodes sorted by id, links canonical (source < target) and sorted by
//   (source, target, relation), keys sorted, numbers rounded to 4 decimals, one node or link
//   per line, no timestamps. graph.json is written atomically, then the sidecar.
import { readFileSync } from 'node:fs';
import { StError } from '../core/errors.js';
import type { DataStore, GEdge, GNode, GraphDoc } from '../core/types.js';
import { layout } from '../store/layout.js';
import { carryForward, isOurGraph, parseSidecar, type Sidecar } from './merge.js';
import { VALID_CONFIDENCES, VALID_FILE_TYPES } from './model.js';

export const NOT_OURS_FIX =
  "graphify-out/graph.json here wasn't written by searchtrace (it looks like another graph). Use a different --dir, or pass --force-graph to replace it.";

let cachedVersion: string | null = null;

/** The package version, read once from package.json (two levels up from src/graph and dist/graph). */
export function toolVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

// ---------- graphify id rules ----------

/** NFKC, lowercase, [^\p{L}\p{N}_]+ to '_', collapse and trim '_' (graphify make_id). */
export function makeId(s: string): string {
  let cur = String(s);
  for (let k = 0; k < 6; k++) {
    const next = cur.toLowerCase().normalize('NFKC');
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/** Python pathlib's name, stem and parent name for a POSIX path. */
function pathParts(p: string): { dir: string; name: string; stem: string; parentName: string } {
  const clean = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  const dir = slash >= 0 ? clean.slice(0, slash) : '';
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  const parentName = dir.split('/').filter(Boolean).pop() ?? '';
  return { dir, name, stem, parentName };
}

/** [makeId(path without its last suffix), makeId(parent + '.' + stem), makeId(stem)] (0.2 F10). */
export function graphifyStemForms(sourceFile: string): string[] {
  const { dir, stem, parentName } = pathParts(sourceFile);
  const forms = [makeId(dir ? `${dir}/${stem}` : stem)];
  if (parentName) forms.push(makeId(`${parentName}.${stem}`));
  forms.push(makeId(stem));
  return [...new Set(forms.filter(Boolean))];
}

/** True when graphify would re-key this id because it equals or extends a stem of its source file. */
export function rekeyedByGraphify(id: string, sourceFile: string): boolean {
  const norm = makeId(id);
  return graphifyStemForms(sourceFile).some((f) => norm === f || norm.startsWith(`${f}_`));
}

// ---------- validation (graphify's validate_extraction, plus our own rules) ----------

/** Mirrors graphify.validate.validate_extraction: an empty list means valid. */
export function validateGraph(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['Extraction must be a JSON object'];
  const d = data as Record<string, unknown>;
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!('nodes' in d)) errors.push("Missing required key 'nodes'");
  else if (!Array.isArray(d.nodes)) errors.push("'nodes' must be a list");
  else {
    d.nodes.forEach((n, k) => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        errors.push(`Node ${k} must be an object`);
        return;
      }
      const node = n as Record<string, unknown>;
      for (const f of ['id', 'label', 'file_type', 'source_file']) if (!(f in node)) errors.push(`Node ${k} missing required field '${f}'`);
      if (typeof node.id === 'string') ids.add(node.id);
      else if ('id' in node) errors.push(`Node ${k} has non-string id`);
      if ('file_type' in node && !VALID_FILE_TYPES.has(String(node.file_type))) errors.push(`Node ${k} has invalid file_type '${String(node.file_type)}'`);
    });
  }
  const edges = 'edges' in d ? d.edges : d.links;
  if (edges === undefined || edges === null) errors.push("Missing required key 'edges'");
  else if (!Array.isArray(edges)) errors.push("'edges' must be a list");
  else {
    edges.forEach((e, k) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        errors.push(`Edge ${k} must be an object`);
        return;
      }
      const edge = e as Record<string, unknown>;
      for (const f of ['source', 'target', 'relation', 'confidence', 'source_file']) if (!(f in edge)) errors.push(`Edge ${k} missing required field '${f}'`);
      if ('confidence' in edge && !VALID_CONFIDENCES.has(String(edge.confidence))) errors.push(`Edge ${k} has invalid confidence '${String(edge.confidence)}'`);
      for (const end of ['source', 'target'] as const) {
        if (end in edge && ids.size > 0 && !ids.has(String(edge[end]))) errors.push(`Edge ${k} ${end} '${String(edge[end])}' does not match any node id`);
      }
    });
  }
  return errors;
}

/** Our rules on top of graphify's: unique ids, unique unordered pairs, no self loops, id-stem safety. */
export function assertGraphifySafe(doc: GraphDoc): void {
  const problems = validateGraph(doc);
  const seen = new Set<string>();
  for (const n of doc.nodes) {
    if (seen.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    seen.add(n.id);
    if (rekeyedByGraphify(n.id, n.source_file)) problems.push(`node ${n.id} would be re-keyed by graphify (source_file ${n.source_file})`);
  }
  const pairs = new Set<string>();
  for (const e of doc.links) {
    if (e.source === e.target) problems.push(`self loop on ${e.source}`);
    const key = e.source < e.target ? `${e.source}\u0000${e.target}` : `${e.target}\u0000${e.source}`;
    if (pairs.has(key)) problems.push(`more than one link between ${e.source} and ${e.target}`);
    pairs.add(key);
  }
  if (problems.length) {
    throw new StError('internal', `The knowledge graph failed its safety checks: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`);
  }
}

// ---------- byte-stable serialisation ----------

function round4(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const r = Math.round(x * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

/** Sorted keys, numbers rounded to 4 decimals, undefined dropped, non-finite numbers as null. */
export function stable(v: unknown): unknown {
  if (typeof v === 'number') return round4(v);
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : stable(x)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

function canonicalLink(e: GEdge): GEdge {
  return e.source <= e.target ? e : { ...e, source: e.target, target: e.source };
}

/** The canonical, sorted form of a graph document. */
export function canonicalGraph(doc: GraphDoc): GraphDoc {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const nodes = [...doc.nodes].sort((a, b) => cmp(a.id, b.id));
  const links = doc.links.map(canonicalLink).sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.relation, b.relation));
  return { directed: false, multigraph: false, graph: doc.graph, nodes, links };
}

/** One node or link per line keeps git diffs small; the bytes depend only on the content. */
export function serializeGraph(doc: GraphDoc): string {
  const c = canonicalGraph(doc);
  const line = (x: unknown): string => JSON.stringify(stable(x));
  const block = (items: unknown[]): string => (items.length ? `[\n${items.map(line).join(',\n')}\n]` : '[]');
  return `{"directed":false,"graph":${line(c.graph)},"links":${block(c.links)},"multigraph":false,"nodes":${block(c.nodes)}}\n`;
}

// ---------- write ----------

export async function writeGraph(
  store: DataStore,
  doc: GraphDoc,
  o: { property: string; force: boolean },
): Promise<{ nodes: number; links: number; path: string }> {
  const existingText = await store.readFile(layout.graph);
  let previous: GraphDoc | null = null;
  if (existingText !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      parsed = null;
    }
    const sidecar = parseSidecar(await store.readFile(layout.graphMeta));
    const candidate = parsed && typeof parsed === 'object' && Array.isArray((parsed as GraphDoc).nodes) ? (parsed as GraphDoc) : null;
    const ours = candidate !== null && isOurGraph(candidate, sidecar, o.property);
    if (!ours && !o.force) throw new StError('graph_not_ours', 'The existing knowledge graph was not written by searchtrace.', NOT_OURS_FIX);
    previous = ours ? candidate : null;
  }
  const version = toolVersion();
  const merged = carryForward(doc, previous);
  const final: GraphDoc = canonicalGraph({ ...merged, graph: { ...merged.graph, generator: 'searchtrace', property: o.property, tool_version: version } });
  assertGraphifySafe(final);
  const text = serializeGraph(final);
  await store.writeFileAtomic(layout.graph, text);
  const sidecar: Sidecar = {
    generator: 'searchtrace', schema: 1, property: o.property, toolVersion: version,
    dataThrough: typeof final.graph.data_through === 'string' ? final.graph.data_through : '',
    nodes: final.nodes.length, links: final.links.length,
  };
  await store.writeFileAtomic(layout.graphMeta, `${JSON.stringify(stable(sidecar), null, 2)}\n`);
  return { nodes: final.nodes.length, links: final.links.length, path: layout.graph };
}

