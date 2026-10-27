import matter from "gray-matter";
import yaml from "js-yaml";
import type { ConceptFrontmatter } from "./types.js";

// gray-matter's default YAML engine uses js-yaml's DEFAULT schema, which turns
// an unquoted 2026-10-05 into a Date and writes it back as a full ISO
// timestamp (2026-10-05T00:00:00.000Z). That rewrote hand-authored dates and
// tags on every save, and made typeof-string checks on date fields miss them.
// The CORE schema has no timestamp type, so dates stay exactly as written.
const engines = {
  yaml: {
    parse: (input: string) => yaml.safeLoad(input, { schema: yaml.CORE_SCHEMA }) as object,
    stringify: (data: object) => yaml.safeDump(data, { schema: yaml.CORE_SCHEMA }),
  },
};

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Permissive parse (spec §9: consumers must not reject unknown keys/types).
 * Throws only if the YAML itself is unparseable.
 */
export function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw, { engines });
  return { frontmatter: parsed.data ?? {}, body: parsed.content.replace(/^\n/, "") };
}

export function serializeDoc(frontmatter: ConceptFrontmatter, body: string): string {
  // Pass the body as an already-parsed file object. Handing gray-matter a bare
  // string makes it parse that string as a document first, so a body that
  // begins with its own "---" block (a pasted note, say) has that block
  // stripped and its keys merged into the concept's frontmatter, skipping all
  // validation. With the object form the body is emitted verbatim.
  return matter.stringify({ content: body.endsWith("\n") ? body : body + "\n", data: {} } as never, frontmatter, { engines });
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}
