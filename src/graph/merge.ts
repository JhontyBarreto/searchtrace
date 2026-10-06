// Carry graphify-owned attributes forward by node id, ownership check (7.1, 7.4). Owner: WP-D.
//
// graph.json is a pure function of the index plus exactly two graphify-owned node attributes
// from the previous graph: community and community_name. Nothing else is copied, so stale data
// cannot survive a run. norm_label and confidence_score are left for graphify to recompute.
import type { GNode, GraphDoc } from '../core/types.js';
import { NODE_ID_PATTERN } from './model.js';

export interface Sidecar {
  generator: 'searchtrace';
  schema: 1;
  property: string;
  toolVersion: string;
  dataThrough: string;
  nodes: number;
  links: number;
}

/** Copies community and community_name from previous by node id; nothing else. */
export function carryForward(doc: GraphDoc, previous: GraphDoc | null): GraphDoc {
  if (!previous || !Array.isArray(previous.nodes)) return doc;
  const prev = new Map<string, { community?: unknown; community_name?: unknown }>();
  for (const n of previous.nodes) {
    if (n && typeof n === 'object' && typeof (n as GNode).id === 'string') prev.set((n as GNode).id, n as GNode);
  }
  const nodes = doc.nodes.map((n): GNode => {
    const p = prev.get(n.id);
    const out: GNode = { ...n };
    delete out.community;
    delete out.community_name;
    if (!p) return out;
    if (typeof p.community === 'number' && Number.isInteger(p.community)) out.community = p.community;
    else if (p.community === null) out.community = null;
    if (typeof p.community_name === 'string') out.community_name = p.community_name;
    return out;
  });
  return { ...doc, nodes };
}

export function parseSidecar(text: string | null): Partial<Sidecar> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<Sidecar>) : null;
  } catch {
    return null;
  }
}

/** The sidecar names this property, or every node id matches NODE_ID_PATTERN. */
export function isOurGraph(previous: GraphDoc, sidecar: unknown, property: string): boolean {
  const sc = sidecar && typeof sidecar === 'object' ? (sidecar as Partial<Sidecar>) : null;
  if (sc && sc.generator === 'searchtrace' && sc.property === property) return true;
  if (!previous || !Array.isArray(previous.nodes)) return false;
  return previous.nodes.every((n) => !!n && typeof n === 'object' && typeof (n as GNode).id === 'string' && NODE_ID_PATTERN.test((n as GNode).id));
}
