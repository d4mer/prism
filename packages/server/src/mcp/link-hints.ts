import type { KnowledgeBase } from "@prism/core";

export interface LinkHint {
  warning: string;
  link_candidates: { path: string; title?: string; type?: string; description?: string }[];
}

/**
 * Deterministic, LLM-free nudge returned with a direct write: a concept that
 * nothing links to and that links to nothing is an orphan, and orphans are
 * what the periodic maintenance pass has to spend tokens fixing. If the
 * concept the caller just wrote has no links yet, say so and offer the
 * closest existing concepts (plain search on its title and description) as
 * link_add targets. Best-effort: a failure here must never fail the write.
 */
export async function linkHintFor(kb: KnowledgeBase, path: string): Promise<LinkHint | undefined> {
  try {
    if ((await kb.related(path)).length > 0) return undefined;
    const concept = await kb.readConcept(path);
    const fm = concept.frontmatter as Record<string, unknown>;
    const query = [fm.title, fm.description].filter((v) => typeof v === "string").join(" ").trim();
    const hits = query ? await kb.search(query, { limit: 6 }) : [];
    const candidates = hits
      .filter((h) => h.path !== path)
      .slice(0, 5)
      .map(({ path, title, type, description }) => ({ path, title, type, description }));
    return {
      warning:
        `${path} has no links to or from other concepts yet. Link it to related concepts in both directions ` +
        `with link_add (source -> target, then the reverse), or concept_patch the related concept to reference it; ` +
        `otherwise it will be an orphan.`,
      link_candidates: candidates,
    };
  } catch {
    return undefined;
  }
}
