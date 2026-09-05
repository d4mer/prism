import type { Bundle } from "./bundle.js";
import type { SearchHit } from "./types.js";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  limit?: number;
  /** PRISM-24: include superseded (historical) concepts, each marked superseded:true. Default: current beliefs only. */
  includeHistory?: boolean;
}

/**
 * Naive in-memory scan over all concepts — fine into the thousands of files.
 * Scores: title match > description/tag match > body match.
 */
export async function searchBundle(
  bundle: Bundle,
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const paths = await bundle.listConceptPaths();
  const hits: SearchHit[] = [];

  for (const conceptPath of paths) {
    let concept;
    try {
      concept = await bundle.readConcept(conceptPath);
    } catch {
      continue; // Permissive: skip unreadable files.
    }
    const fm = concept.frontmatter;

    // PRISM-24: current beliefs only by default — a superseded concept
    // stays fully readable via concept_read, just not surfaced here unless
    // asked for.
    const superseded = typeof fm.superseded_by === "string" && fm.superseded_by.length > 0;
    if (superseded && !options.includeHistory) continue;

    if (options.type && fm.type?.toLowerCase() !== options.type.toLowerCase()) continue;
    if (options.tags?.length) {
      const conceptTags = (Array.isArray(fm.tags) ? fm.tags : []).map((t) =>
        String(t).toLowerCase()
      );
      if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) continue;
    }

    const title = (fm.title ?? "").toString().toLowerCase();
    const description = (fm.description ?? "").toString().toLowerCase();
    const tags = (Array.isArray(fm.tags) ? fm.tags : []).join(" ").toLowerCase();
    const body = concept.body.toLowerCase();
    const pathLower = conceptPath.toLowerCase();

    let score = 0;
    let firstBodyMatch = -1;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      if (pathLower.includes(term)) score += 6;
      if (description.includes(term)) score += 5;
      if (tags.includes(term)) score += 5;
      const bodyIdx = body.indexOf(term);
      if (bodyIdx !== -1) {
        score += 2;
        if (firstBodyMatch === -1) firstBodyMatch = bodyIdx;
      }
    }
    // Empty query with type/tag filters = browse mode: include everything that passed filters.
    if (terms.length === 0) score = 1;
    if (score === 0) continue;

    hits.push({
      path: conceptPath,
      type: fm.type ?? "unknown",
      title: fm.title as string | undefined,
      description: fm.description as string | undefined,
      snippet:
        firstBodyMatch >= 0
          ? concept.body
              .slice(Math.max(0, firstBodyMatch - 60), firstBodyMatch + 120)
              .replace(/\s+/g, " ")
              .trim()
          : undefined,
      superseded: superseded ? true : undefined,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}

/** Distinct `type` values in use across the bundle (fed to the agent's system prompt). */
export async function listTypes(bundle: Bundle): Promise<string[]> {
  const paths = await bundle.listConceptPaths();
  const types = new Set<string>();
  for (const p of paths) {
    try {
      const { frontmatter } = await bundle.readConcept(p);
      if (frontmatter.type) types.add(frontmatter.type);
    } catch {
      // skip
    }
  }
  return [...types].sort();
}
