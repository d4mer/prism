import type { Bundle } from "./bundle.js";
import { buildGraph } from "./graph.js";

export interface RelatedOptions {
  /** Max hops from the origin concept. Default 1. */
  hops?: number;
  /** PRISM-24: include superseded (historical) concepts/edges. Default: current beliefs only. */
  includeHistory?: boolean;
}

export interface RelatedHit {
  path: string;
  /** Fewest hops from the origin via existing link edges. */
  distance: number;
  title?: string;
  type?: string;
  superseded?: boolean;
}

/**
 * PRISM-47: breadth-first walk of the existing link graph (okf/graph.ts) —
 * no separate traversal implementation, so this tool, the graph view, and
 * graph_lint all see exactly the same edges. Edges are treated as
 * undirected: a body link from A to B means both "what does A touch" and
 * "what touches A" surface each other, matching how a person reading the
 * graph view thinks about "related", not the one-way direction a markdown
 * link happens to be written in.
 *
 * Current-belief-aware by default (PRISM-24, consistent with concept_search
 * and the graph view): a superseded concept and its edges are excluded from
 * the graph this walks unless includeHistory is set, so they neither appear
 * as hits nor serve as a bridge to further hops. If the origin itself is
 * excluded this way (or simply absent from the bundle), there is nothing to
 * traverse from and this returns an empty array — callers that need a real
 * "does this concept exist" check should read it first (as the concept_related
 * registry handler does).
 */
export async function findRelated(
  bundle: Bundle,
  origin: string,
  options: RelatedOptions = {}
): Promise<RelatedHit[]> {
  const hops = options.hops ?? 1;
  const { nodes, edges } = await buildGraph(bundle, { includeHistory: options.includeHistory });
  const byPath = new Map(nodes.map((n) => [n.path, n]));

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) {
      set = new Set();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const edge of edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source); // undirected — see doc comment above
  }

  const distance = new Map<string, number>([[origin, 0]]);
  let frontier = [origin];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const neighbor of adjacency.get(p) ?? []) {
        if (distance.has(neighbor)) continue;
        distance.set(neighbor, hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  distance.delete(origin); // never re-include the concept we started from

  return [...distance.entries()]
    .map(([path, dist]) => {
      const node = byPath.get(path);
      return {
        path,
        distance: dist,
        title: node?.title,
        type: node?.type,
        superseded: node?.superseded,
      };
    })
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
}
