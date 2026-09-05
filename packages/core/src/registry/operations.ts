import { z } from "zod";
import { recordHotDelete, recordHotWrite } from "../agent/hot-memory.js";
import { replaceSection, type LintReport, type SearchHit } from "../okf/index.js";
import { formatTree } from "./format-tree.js";
import { conceptPathSchema, frontmatterSchema, logSummarySchema } from "./schemas.js";
import type { ToolDefinition } from "./types.js";

// ── concept_search ───────────────────────────────────────────────────

const conceptSearchInput = z.object({
  query: z.string().describe("Keywords to search for. May be empty when filtering by type/tags only."),
  type: z.string().optional().describe("Exact concept type filter"),
  tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
  limit: z.number().int().positive().optional().describe("Max hits to return (default 20)"),
  include_history: z
    .boolean()
    .optional()
    .describe(
      "PRISM-24: include superseded (historical) concepts, each marked superseded:true. Default: current beliefs only — use concept_as_of for a snapshot at a specific date instead."
    ),
});
type ConceptSearchInput = z.infer<typeof conceptSearchInput>;
interface ConceptSearchMiss {
  hits: [];
  notice: string;
  bundle_layout: string;
}
type ConceptSearchOutput = SearchHit[] | ConceptSearchMiss;

export const conceptSearchTool: ToolDefinition<ConceptSearchInput, ConceptSearchOutput> = {
  name: "concept_search",
  title: "Search knowledge",
  description:
    "Search the knowledge base by keywords, optionally filtered by concept type and/or tags, capped at 'limit' hits (default 20). Returns ranked hits with paths and snippets. Excludes superseded (historical) concepts by default (PRISM-24) — set include_history to include them (marked superseded:true), or use concept_as_of for a snapshot as of a specific date. NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
  inputSchema: conceptSearchInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { query, type, tags, limit, include_history }, ctx) {
    const hits = await kb.search(query, { type, tags, limit, includeHistory: include_history });
    ctx?.trace?.record("concept_search", query, hits.map((h) => h.path));
    if (hits.length > 0) return hits;
    const tree = formatTree(await kb.listTree());
    return {
      hits: [],
      notice:
        "No keyword matches — but this search is literal, not semantic. The knowledge may exist under different wording. Before concluding it is absent: (1) retry with 1-2 synonyms or broader terms, (2) review the layout below and concept_read ANY concept whose type, name, or description could plausibly relate to the question.",
      bundle_layout: tree,
    };
  },
};

// ── concept_read ─────────────────────────────────────────────────────

const conceptReadInput = z.object({ path: conceptPathSchema });
type ConceptReadInput = z.infer<typeof conceptReadInput>;
interface ConceptReadOutput {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export const conceptReadTool: ToolDefinition<ConceptReadInput, ConceptReadOutput> = {
  name: "concept_read",
  title: "Read concept",
  description: "Read one concept document in full: frontmatter and markdown body.",
  inputSchema: conceptReadInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { path }, ctx) {
    const c = await kb.readConcept(path);
    ctx?.trace?.record("concept_read", c.path, [c.path]);
    return { path: c.path, frontmatter: c.frontmatter, body: c.body };
  },
};

// ── concept_list ─────────────────────────────────────────────────────

const conceptListInput = z.object({
  prefix: z
    .string()
    .optional()
    .describe('Bundle-relative directory to list, e.g. "/apis". Omit to list the whole bundle.'),
});
type ConceptListInput = z.infer<typeof conceptListInput>;

export const conceptListTool: ToolDefinition<ConceptListInput, string> = {
  name: "concept_list",
  title: "List directory",
  description:
    "List the bundle's directory tree with concept types/titles/descriptions, optionally scoped to one subdirectory via 'prefix'. Use to understand structure and decide where new concepts belong.",
  inputSchema: conceptListInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { prefix }, ctx) {
    ctx?.trace?.record("concept_list", prefix ?? "", []);
    return formatTree(await kb.listTree(prefix));
  },
};

// ── graph_lint ───────────────────────────────────────────────────────

const graphLintInput = z.object({});
type GraphLintInput = z.infer<typeof graphLintInput>;

export const graphLintTool: ToolDefinition<GraphLintInput, LintReport> = {
  name: "graph_lint",
  title: "Lint knowledge graph",
  description:
    "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
  inputSchema: graphLintInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, _input, ctx) {
    ctx?.trace?.record("graph_lint", "", []);
    return kb.lint();
  },
};

// ── concept_write ────────────────────────────────────────────────────

const conceptWriteInput = z.object({
  path: conceptPathSchema,
  frontmatter: frontmatterSchema,
  body: z.string().describe("Markdown body (no frontmatter block)"),
  log_summary: logSummarySchema,
});
type ConceptWriteInput = z.infer<typeof conceptWriteInput>;
interface ConceptWriteOutput {
  written: string;
}

export const conceptWriteTool: ToolDefinition<ConceptWriteInput, ConceptWriteOutput> = {
  name: "concept_write",
  title: "Write concept",
  description:
    "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those. Optional temporal/provenance fields (asserted, source, confidence, supersedes, superseded_by) are validated when present (PRISM-22). To retire a belief and replace it with a new version, prefer concept_supersede over hand-setting supersedes/superseded_by here.",
  inputSchema: conceptWriteInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { path, frontmatter, body, log_summary }, ctx) {
    const c = await kb.writeConcept(path, frontmatter, body, log_summary);
    ctx?.filesChanged?.add(c.path);
    recordHotWrite(c.path);
    ctx?.trace?.record("concept_write", c.path, [c.path], true);
    return { written: c.path };
  },
};

// ── concept_patch ────────────────────────────────────────────────────

const conceptPatchInput = z.object({
  path: conceptPathSchema,
  frontmatter: z
    .record(z.unknown())
    .optional()
    .describe("Frontmatter keys to merge; set a key to null to remove it"),
  replace_section: z
    .object({
      heading: z
        .string()
        .min(1)
        .describe(
          "Top-level heading name, e.g. 'Schema'. Must be non-empty — to replace the whole body use replace_body instead."
        ),
      content: z.string().describe("New content for that section"),
    })
    .optional(),
  replace_body: z
    .string()
    .optional()
    .describe(
      "Replace the entire markdown body (frontmatter untouched). Use for restructuring; prefer replace_section for targeted edits."
    ),
  log_summary: logSummarySchema,
});
type ConceptPatchInput = z.infer<typeof conceptPatchInput>;
interface ConceptPatchOutput {
  patched: string;
}

export const conceptPatchTool: ToolDefinition<ConceptPatchInput, ConceptPatchOutput> = {
  name: "concept_patch",
  title: "Patch concept",
  description:
    "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one top-level '# Section' body section. Prefer this over concept_write for small edits — a frontmatter-only patch leaves the body byte-identical. For adding a cross-reference to another concept, prefer link_add. Temporal/provenance fields (asserted, source, confidence, supersedes, superseded_by) are validated the same way as concept_write. To retire a belief and replace it with a new version, prefer concept_supersede over hand-setting supersedes/superseded_by here.",
  inputSchema: conceptPatchInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { path, frontmatter, replace_section, replace_body, log_summary }, ctx) {
    const c = await kb.patchConcept(
      path,
      {
        frontmatter,
        replaceSection: replace_section
          ? { heading: replace_section.heading, content: replace_section.content }
          : undefined,
        replaceBody: replace_body,
      },
      log_summary
    );
    ctx?.filesChanged?.add(c.path);
    recordHotWrite(c.path);
    ctx?.trace?.record("concept_patch", c.path, [c.path], true);
    return { patched: c.path };
  },
};

// ── concept_delete ───────────────────────────────────────────────────
// Not part of PRISM-13's minimum tool-surface list, but already a safe,
// deterministic registry entry (Tier 0/1, same as everything else here) —
// exposed to every adapter alongside the rest rather than held back.

const conceptDeleteInput = z.object({
  path: conceptPathSchema,
  log_summary: logSummarySchema,
});
type ConceptDeleteInput = z.infer<typeof conceptDeleteInput>;
interface ConceptDeleteOutput {
  deleted: string;
}

export const conceptDeleteTool: ToolDefinition<ConceptDeleteInput, ConceptDeleteOutput> = {
  name: "concept_delete",
  title: "Delete concept",
  description:
    "Permanently delete a concept file. Prefer deprecation (tag 'deprecated' via concept_patch) unless content is wrong/harmful or deletion was explicitly requested.",
  inputSchema: conceptDeleteInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { path, log_summary }, ctx) {
    await kb.deleteConcept(path, log_summary);
    ctx?.filesChanged?.add(path);
    recordHotDelete(path);
    ctx?.trace?.record("concept_delete", path, [path], true);
    return { deleted: path };
  },
};

// ── link_add ─────────────────────────────────────────────────────────
// The deterministic version of what write-time linking used to leave entirely
// to prompting: wire two existing concepts together with a real markdown
// link, filed under a "# Related" section (grown if it already exists,
// created if not) rather than a caller having to hand-craft body text.

const linkAddInput = z.object({
  source: conceptPathSchema.describe("Concept the link is added into"),
  target: conceptPathSchema.describe("Concept being linked to; must already exist"),
  label: z
    .string()
    .optional()
    .describe("Link text. Defaults to the target's frontmatter title, else its filename."),
  log_summary: logSummarySchema,
});
type LinkAddInput = z.infer<typeof linkAddInput>;
interface LinkAddOutput {
  source: string;
  target: string;
  added: boolean;
  markdown?: string;
  reason?: string;
}

/** Content of a top-level "# Heading" section, or null if the heading is absent. */
function extractSection(body: string, heading: string): string | null {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  const isHeading = (line: string) => /^#\s+/.test(line);
  const start = lines.findIndex(
    (line) => isHeading(line) && line.replace(/^#\s+/, "").trim() === normalized
  );
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      end = i;
      break;
    }
  }
  const content = lines.slice(start + 1, end).join("\n").trim();
  return content.length > 0 ? content : null;
}

export const linkAddTool: ToolDefinition<LinkAddInput, LinkAddOutput> = {
  name: "link_add",
  title: "Add link",
  description:
    "Write a real markdown link from one concept to another, filed under a '# Related' section (created if absent, appended to if present). Use this instead of hand-editing body text with concept_write/concept_patch when the only change is wiring two concepts together — it also fixes graph_lint orphans without risking malformed link syntax.",
  inputSchema: linkAddInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { source, target, label, log_summary }, ctx) {
    const src = await kb.readConcept(source);
    const tgt = await kb.readConcept(target);
    if (src.path === tgt.path) {
      throw new Error(`link_add: 'target' must be a different concept from 'source' (both resolved to ${src.path})`);
    }
    if (src.body.includes(`(${tgt.path})`)) {
      return { source: src.path, target: tgt.path, added: false, reason: "already linked" };
    }
    const linkLabel =
      label ?? (typeof tgt.frontmatter.title === "string" && tgt.frontmatter.title
        ? tgt.frontmatter.title
        : (tgt.path.split("/").pop() ?? tgt.path).replace(/\.md$/, ""));
    const markdown = `[${linkLabel}](${tgt.path})`;
    const existingRelated = extractSection(src.body, "Related");
    const mergedContent = existingRelated ? `${existingRelated}\n- ${markdown}` : `- ${markdown}`;
    const newBody = replaceSection(src.body, "Related", mergedContent);
    const c = await kb.patchConcept(src.path, { replaceBody: newBody }, log_summary);
    ctx?.filesChanged?.add(c.path);
    recordHotWrite(c.path);
    ctx?.trace?.record("link_add", `${src.path} -> ${tgt.path}`, [c.path], true);
    return { source: c.path, target: tgt.path, added: true, markdown };
  },
};

// ── concept_supersede ───────────────────────────────────────────────
// PRISM-23: deterministic belief-versioning built on PRISM-22's temporal
// fields. Hand-setting supersedes/superseded_by via concept_write +
// concept_patch works, but is two separate writes with two chances to get
// the cross-links wrong and no single log entry tying them together. This
// tool does both sides atomically under KnowledgeBase's mutation queue.

const conceptSupersedeInput = z.object({
  old_path: conceptPathSchema.describe("Concept being retired; must already exist"),
  new_path: conceptPathSchema.describe("Path for the new concept that replaces it"),
  frontmatter: frontmatterSchema.describe(
    "Frontmatter for the new concept. 'supersedes' is set automatically to old_path — don't set it yourself."
  ),
  body: z.string().describe("Markdown body for the new concept (no frontmatter block)"),
  log_summary: logSummarySchema,
});
type ConceptSupersedeInput = z.infer<typeof conceptSupersedeInput>;
interface ConceptSupersedeOutput {
  superseded: string;
  created: string;
}

export const conceptSupersedeTool: ToolDefinition<ConceptSupersedeInput, ConceptSupersedeOutput> = {
  name: "concept_supersede",
  title: "Supersede concept",
  description:
    "Retire a belief and replace it with a new version in one atomic step: creates the new concept with 'supersedes' pointing at the old one, and patches 'superseded_by' onto the old concept pointing at the new one — both sides, one log entry. Prefer this over hand-editing supersedes/superseded_by with concept_write/concept_patch, which leaves the two writes unordered and unlinked if one fails partway.",
  inputSchema: conceptSupersedeInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { old_path, new_path, frontmatter, body, log_summary }, ctx) {
    const { old: oldConcept, new: newConcept } = await kb.supersede(
      old_path,
      new_path,
      frontmatter,
      body,
      log_summary
    );
    ctx?.filesChanged?.add(oldConcept.path);
    ctx?.filesChanged?.add(newConcept.path);
    recordHotWrite(oldConcept.path);
    recordHotWrite(newConcept.path);
    ctx?.trace?.record(
      "concept_supersede",
      `${oldConcept.path} -> ${newConcept.path}`,
      [oldConcept.path, newConcept.path],
      true
    );
    return { superseded: oldConcept.path, created: newConcept.path };
  },
};

// ── concept_as_of ────────────────────────────────────────────────────
// PRISM-24: read-only historical snapshot. concept_search/concept_read
// (and the seed overview, and the graph view) only ever surface CURRENT
// beliefs by default — this is the explicit, opt-in way to ask "what did
// we believe as of <date>" instead.

const conceptAsOfInput = z.object({
  as_of: z
    .string()
    .describe(
      "ISO 8601 date or date-time. For each concept / supersession chain, returns whichever version was current at this moment (by its 'asserted' field, falling back to its write timestamp when 'asserted' is absent). A chain with nothing yet true by this date is omitted."
    ),
});
type ConceptAsOfInput = z.infer<typeof conceptAsOfInput>;
interface ConceptAsOfHit {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export const conceptAsOfTool: ToolDefinition<ConceptAsOfInput, ConceptAsOfHit[]> = {
  name: "concept_as_of",
  title: "Query as of a date",
  description:
    "Return the belief set held as of a given date: for each independent concept / supersession chain, the version that was current at that moment. Use this for historical questions ('what did we believe about X on <date>') — concept_search and concept_read only ever surface the CURRENT belief.",
  inputSchema: conceptAsOfInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { as_of }, ctx) {
    const results = await kb.asOf(as_of);
    ctx?.trace?.record("concept_as_of", as_of, results.map((c) => c.path));
    return results.map((c) => ({ path: c.path, frontmatter: c.frontmatter, body: c.body }));
  },
};
