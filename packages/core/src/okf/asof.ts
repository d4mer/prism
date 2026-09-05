import type { Bundle } from "./bundle.js";
import type { Concept } from "./types.js";

/**
 * PRISM-24: the belief set held as of a given moment. For each independent
 * concept / supersession chain, returns whichever version was current at
 * `asOfDate` — the chain member with the latest effective time not after
 * asOfDate. A concept's effective time is its `asserted` field (when a
 * caller set one — that is exactly what it is for) falling back to its
 * write `timestamp` (always present) otherwise, so an as-of query still
 * works on beliefs that never set `asserted`.
 *
 * A chain with no member effective by asOfDate is omitted entirely — the
 * belief simply did not exist yet.
 */
export async function queryAsOf(bundle: Bundle, asOfDate: string): Promise<Concept[]> {
  const asOf = Date.parse(asOfDate);
  if (Number.isNaN(asOf)) {
    throw new Error(`Invalid "as_of" date: ${JSON.stringify(asOfDate)} (expected ISO 8601)`);
  }

  const paths = await bundle.listConceptPaths();
  const concepts = new Map<string, Concept>();
  for (const p of paths) {
    try {
      concepts.set(p, await bundle.readConcept(p));
    } catch {
      // Permissive: skip unreadable files, same as search/validate.
    }
  }

  const effectiveTime = (c: Concept): number => {
    const raw =
      typeof c.frontmatter.asserted === "string"
        ? c.frontmatter.asserted
        : typeof c.frontmatter.timestamp === "string"
          ? c.frontmatter.timestamp
          : undefined;
    if (!raw) return -Infinity; // no date recorded at all: treat as always already true
    const t = Date.parse(raw);
    return Number.isNaN(t) ? -Infinity : t;
  };

  const visited = new Set<string>();
  const results: Concept[] = [];

  for (const [startPath, start] of concepts) {
    if (visited.has(startPath)) continue;

    // Collect this concept's whole supersession chain (both directions —
    // a chain member may be reached via either its own supersedes or the
    // superseded_by pointing at it).
    const chain: Concept[] = [];
    const stack: Concept[] = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      chain.push(current);
      for (const field of ["supersedes", "superseded_by"] as const) {
        const target = current.frontmatter[field];
        if (typeof target !== "string" || target.length === 0) continue;
        const canonical = bundle.toBundlePath(target);
        const neighbor = concepts.get(canonical);
        if (neighbor && !visited.has(neighbor.path)) stack.push(neighbor);
      }
    }

    const eligible = chain.filter((c) => effectiveTime(c) <= asOf);
    if (eligible.length === 0) continue; // nothing in this chain existed yet as of asOfDate
    eligible.sort((a, b) => effectiveTime(b) - effectiveTime(a));
    results.push(eligible[0]);
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
