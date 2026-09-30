import matter from "gray-matter";
import type { ConceptFrontmatter } from "./types.js";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Permissive parse (spec §9: consumers must not reject unknown keys/types).
 * Throws only if the YAML itself is unparseable.
 */
export function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw);
  return { frontmatter: parsed.data ?? {}, body: parsed.content.replace(/^\n/, "") };
}

export function serializeDoc(frontmatter: ConceptFrontmatter, body: string): string {
  // Pass the body as an already-parsed file object. Handing gray-matter a bare
  // string makes it parse that string as a document first, so a body that
  // begins with its own "---" block (a pasted note, say) has that block
  // stripped and its keys merged into the concept's frontmatter, skipping all
  // validation. With the object form the body is emitted verbatim.
  return matter.stringify({ content: body.endsWith("\n") ? body : body + "\n", data: {} } as never, frontmatter);
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}
