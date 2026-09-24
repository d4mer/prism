import { z } from "zod";
import { recordHotDelete, recordHotWrite } from "../agent/hot-memory.js";
import { contentVersion, normalizeScope, replaceSection, type ChangesReport, type ConceptTemplate, type OpenItemsReport, type ReviewReport, type LintReport, type RelatedHit, type SearchHit } from "../okf/index.js";
import { BELIEF_SOURCES } from "../okf/temporal.js";
import { ITEM_STATUSES, RESOLVED_STATUSES } from "../okf/fields.js";
import { formatTree } from "./format-tree.js";
import { conceptPathSchema, frontmatterSchema, logSummarySchema } from "./schemas.js";
import type { ToolContext, ToolDefinition } from "./types.js";
import type { KnowledgeBase } from "../okf/index.js";

/** PRISM-27: the write guard for `path` if this run read it earlier. */
function guardFor(kb: KnowledgeBase, ctx: ToolContext | undefined, path: string) {
  const expectedVersion = ctx?.readVersions?.get(kb.bundle.toBundlePath(path));
  return expectedVersion ? { expectedVersion } : undefined;
}

/** PRISM-27: after a successful write, what this run "has read" is what it just wrote. */
function remember(ctx: ToolContext | undefined, concept: { path: string; raw: string }) {
  ctx?.readVersions?.set(concept.path, contentVersion(concept.raw));
}

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
  scope: z
    .string()
    .optional()
    .describe(
      'PRISM-54: only search under this bundle directory, e.g. "/clients/acme" or "/emea/cmo" — use it to keep one workstream or client separate from another. Directory-aligned: "/clients/acme" does not match "/clients/acme-corp".'
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
    "Search the knowledge base by keywords, optionally filtered by concept type, tags and/or a directory scope (one workstream/client), capped at 'limit' hits (default 20). Returns ranked hits with paths and snippets. Excludes superseded (historical) concepts by default (PRISM-24) — set include_history to include them (marked superseded:true), or use concept_as_of for a snapshot as of a specific date. Matches a concept's aliases (acronyms/long forms) like its title, and an exact alias match ranks first (PRISM-55). NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
  inputSchema: conceptSearchInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { query, type, tags, limit, include_history, scope }, ctx) {
    const hits = await kb.search(query, { type, tags, limit, includeHistory: include_history, scope });
    ctx?.trace?.record("concept_search", query, hits.map((h) => h.path));
    if (hits.length > 0) return hits;
    // Scoped miss: show the scoped layout when that directory exists, the
    // whole bundle otherwise (a mistyped scope is itself worth seeing).
    const normalized = normalizeScope(scope);
    const tree = formatTree(
      normalized ? await kb.listTree(normalized).catch(() => kb.listTree()) : await kb.listTree()
    );
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
    remember(ctx, c);
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

// ── concept_related ──────────────────────────────────────────────────
// PRISM-47: "what else touches this" directly from the link graph, no
// fresh keyword/semantic query required. Reuses okf/graph.ts's traversal
// (via KnowledgeBase.related) rather than a new implementation, and is
// current-belief-aware by default, consistent with concept_search/graph.

const conceptRelatedInput = z.object({
  path: conceptPathSchema.describe("Starting concept"),
  hops: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max hops from the starting concept to traverse (default 1)"),
  include_history: z
    .boolean()
    .optional()
    .describe(
      "PRISM-24: include superseded (historical) concepts and the edges through them, each marked superseded:true. Default: current beliefs only, consistent with concept_search/graph."
    ),
});
type ConceptRelatedInput = z.infer<typeof conceptRelatedInput>;

export const conceptRelatedTool: ToolDefinition<ConceptRelatedInput, RelatedHit[]> = {
  name: "concept_related",
  title: "Related concepts",
  description:
    "Concepts reachable from 'path' via existing link edges (body links, supersedes/superseded_by) — the link graph itself, not a fresh search. Each hit is tagged with its hop distance from the origin; a 1-hop query (the default) returns exactly its direct links, a 2-hop query also returns their links, deduplicated, without re-including the origin. Excludes superseded (historical) concepts by default (PRISM-24) — set include_history to include them, consistent with concept_search/graph. Use this instead of concept_search when you already have a concept and want what connects to it, not a fresh keyword/semantic query.",
  inputSchema: conceptRelatedInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { path, hops, include_history }, ctx) {
    const hits = await kb.related(path, { hops, includeHistory: include_history });
    ctx?.trace?.record("concept_related", path, hits.map((h) => h.path));
    return hits;
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
    const c = await kb.writeConcept(path, frontmatter, body, log_summary, guardFor(kb, ctx, path));
    remember(ctx, c);
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
      log_summary,
      guardFor(kb, ctx, path)
    );
    remember(ctx, c);
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
    await kb.deleteConcept(path, log_summary, guardFor(kb, ctx, path));
    ctx?.readVersions?.delete(kb.bundle.toBundlePath(path));
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
    // PRISM-27: this is a read-modify-write of src's whole body, so it is
    // guarded by the version link_add itself just read. A concurrent edit to
    // src makes it fail with CONFLICT instead of being overwritten.
    const c = await kb.patchConcept(src.path, { replaceBody: newBody }, log_summary, {
      expectedVersion: contentVersion(src.raw),
    });
    remember(ctx, c);
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
      log_summary,
      guardFor(kb, ctx, old_path)
    );
    remember(ctx, oldConcept);
    remember(ctx, newConcept);
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

// ── concept_capture ──────────────────────────────────────────────────
// PRISM-52: the zero-friction write. Everything concept_write asks for up
// front (path, type, log summary) is derived here so a note can be filed
// mid-meeting from just its text, then triaged later from /inbox.

const conceptCaptureInput = z.object({
  text: z
    .string()
    .refine((t) => t.trim().length > 0, { message: "must not be empty" })
    .describe("The note itself, as markdown. The first line doubles as the title if none is given."),
  title: z.string().optional().describe("Optional title; defaults to the first line of text"),
  type: z.string().optional().describe("Concept type; defaults to 'note'"),
  tags: z.array(z.string()).optional().describe("Optional tags. Captures to the default /inbox also get the 'inbox' tag."),
  source: z
    .enum(BELIEF_SOURCES)
    .optional()
    .describe(`Provenance (PRISM-22), one of ${BELIEF_SOURCES.join(", ")}; defaults to 'human'`),
  folder: z
    .string()
    .optional()
    .describe("Bundle-relative directory to file into; defaults to /inbox for later triage"),
  template: z
    .string()
    .optional()
    .describe(
      "PRISM-57: apply a concept template by name or type (see concept_template), e.g. 'decision', 'meeting-note', 'fit-gap'. Adds its defaults (type, status) and section skeleton below your text."
    ),
});
type ConceptCaptureInput = z.infer<typeof conceptCaptureInput>;
interface ConceptCaptureOutput {
  captured: string;
  title: string;
  type: string;
}

export const conceptCaptureTool: ToolDefinition<ConceptCaptureInput, ConceptCaptureOutput> = {
  name: "concept_capture",
  title: "Quick capture",
  description:
    "File a note in one call from just its text — no path, type or log summary needed. The path is derived as <folder>/YYYY-MM-DD-<slug>.md (default folder /inbox, never overwriting: a same-day duplicate title gets a -2/-3 suffix), the title from the first line, type defaults to 'note', and asserted/source provenance is stamped. Default-folder captures are tagged 'inbox' so they can be triaged later with concept_search (tags:['inbox']) and moved/linked properly. Use this when speed matters more than filing it perfectly; use concept_write when you already know exactly where and what it is.",
  inputSchema: conceptCaptureInput,
  mutates: true,
  requiresDeliberation: false,
  async handler(kb, { text, title, type, tags, source, folder, template }, ctx) {
    const c = await kb.capture({ text, title, type, tags, source, folder, template });
    ctx?.filesChanged?.add(c.path);
    recordHotWrite(c.path);
    ctx?.trace?.record("concept_capture", c.path, [c.path], true);
    return { captured: c.path, title: String(c.frontmatter.title), type: c.frontmatter.type };
  },
};

// ── changes_since ────────────────────────────────────────────────────
// PRISM-53: re-orientation after a context switch, in one call.

const changesSinceInput = z.object({
  since: z
    .string()
    .min(1)
    .describe("Window start: an ISO date/date-time (2026-09-01, 2026-09-01T09:00:00Z) or a relative window: 24h, 7d, 2w"),
  scope: z
    .string()
    .optional()
    .describe('Only report changes under this bundle directory, e.g. "/emea/cmo" (directory-aligned: /acme does not match /acme-corp)'),
  limit: z.number().int().positive().optional().describe("Max entries in 'changes' (default 100); counts stay complete"),
});
type ChangesSinceInput = z.infer<typeof changesSinceInput>;

export const changesSinceTool: ToolDefinition<ChangesSinceInput, ChangesReport> = {
  name: "changes_since",
  title: "What changed since…",
  description:
    "Everything created, updated, superseded or deleted since a point in time, newest first, optionally scoped to a subtree — use it to brief someone returning from another workstream, a weekend or leave (e.g. since:'7d', scope:'/emea'). Each change carries kind (created | updated | changed | superseded), path, title, type and timestamp; superseded ones point at their replacement. 'changed' means the write time is in the window but log.md didn't name the path, so created-vs-updated is unknown. Deletions come from log.md at day granularity. Read the returned paths with concept_read for detail.",
  inputSchema: changesSinceInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { since, scope, limit }, ctx) {
    const report = await kb.changesSince(since, { scope, limit });
    ctx?.trace?.record("changes_since", since, report.changes.map((c) => c.path));
    return report;
  },
};

// ── open_items ───────────────────────────────────────────────────────
// PRISM-56: the action log / RAID view over the knowledge store.

const openItemsInput = z.object({
  status: z
    .array(z.enum(ITEM_STATUSES))
    .optional()
    .describe(`Statuses to include (default: every unresolved one — ${ITEM_STATUSES.filter((s) => !RESOLVED_STATUSES.includes(s)).join(", ")})`),
  owner: z.string().optional().describe('Case-insensitive owner match, e.g. "priya" matches "Priya S."'),
  scope: z.string().optional().describe('Only items under this bundle directory, e.g. "/emea"'),
  overdue_only: z.boolean().optional().describe("Only items past their due date"),
  limit: z.number().int().positive().optional().describe("Max items returned (default 100); counts stay complete"),
});
type OpenItemsInput = z.infer<typeof openItemsInput>;

export const openItemsTool: ToolDefinition<OpenItemsInput, OpenItemsReport> = {
  name: "open_items",
  title: "Open items",
  description:
    "The action log: every tracked item (a concept with a 'status' frontmatter field — actions, open questions, decisions awaiting sign-off) that is still unresolved, overdue first, then by due date. Filter by status, owner, scope or overdue_only. Each item has path, title, status, owner, due and overdue/days_overdue. To track something, set status (open | in_progress | blocked | decided | closed), and optionally owner and due, via concept_write or concept_patch; mark it decided/closed to drop it from this list.",
  inputSchema: openItemsInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { status, owner, scope, overdue_only, limit }, ctx) {
    const report = await kb.openItems({ status, owner, scope, overdueOnly: overdue_only, limit });
    ctx?.trace?.record("open_items", owner ?? "", report.items.map((i) => i.path));
    return report;
  },
};

// ── concept_template ─────────────────────────────────────────────────
// PRISM-57: consistent structure for the documents consultants write most.

const conceptTemplateInput = z.object({
  name: z
    .string()
    .optional()
    .describe("Template name or the type it produces, e.g. 'decision', 'Fit-Gap Item'. Omit to list every template."),
});
type ConceptTemplateInput = z.infer<typeof conceptTemplateInput>;
type TemplateSummary = Pick<ConceptTemplate, "name" | "type" | "description" | "source"> & { sections: string[]; path?: string };
type ConceptTemplateOutput = { templates: TemplateSummary[] } | ConceptTemplate;

function sectionsOf(body: string): string[] {
  return [...body.matchAll(/^#\s+(.+)$/gm)].map((m) => m[1].trim());
}

export const conceptTemplateTool: ToolDefinition<ConceptTemplateInput, ConceptTemplateOutput> = {
  name: "concept_template",
  title: "Concept templates",
  description:
    "Skeletons for the documents consultants write most: decision, meeting-note, fit-gap, requirement, interface, config-item (plus any the bundle defines in /.templates/<name>.md, which override built-ins of the same name). Without 'name', lists them with their sections. With 'name' (or the type it produces), returns the frontmatter defaults and markdown body to fill in and pass to concept_write, or pass template:'<name>' to concept_capture to apply it in one step. Using the same structure every time makes later retrieval far more precise.",
  inputSchema: conceptTemplateInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { name }, ctx) {
    ctx?.trace?.record("concept_template", name ?? "", []);
    if (name) return kb.getTemplate(name);
    const all = await kb.listTemplates();
    return {
      templates: all.map((t) => ({
        name: t.name,
        type: t.type,
        description: t.description,
        source: t.source,
        sections: sectionsOf(t.body),
        ...(t.path ? { path: t.path } : {}),
      })),
    };
  },
};

// ── review_queue ─────────────────────────────────────────────────────
// PRISM-58: a short, prioritised "what should I re-check?" list.

const reviewQueueInput = z.object({
  scope: z.string().optional().describe('Only review under this bundle directory, e.g. "/emea"'),
  inbox_days: z.number().nonnegative().optional().describe("Inbox captures older than this many days count as untriaged (default 3)"),
  stale_days: z.number().positive().optional().describe("Untouched this many days, in a directory with more recent changes, counts as stale (default 90)"),
  min_confidence: z.number().min(0).max(1).optional().describe("Confidence strictly below this counts as low_confidence (default 0.5)"),
  limit: z.number().int().positive().optional().describe("Max entries (default 50); counts stay complete"),
});
type ReviewQueueInput = z.infer<typeof reviewQueueInput>;

export const reviewQueueTool: ToolDefinition<ReviewQueueInput, ReviewReport> = {
  name: "review_queue",
  title: "Review queue",
  description:
    "What to re-check, as one prioritised list: overdue open items, quick captures still untriaged in the inbox, low-confidence beliefs, and stale concepts (untouched for stale_days while others in the same directory changed since). Each entry lists its reasons with a human-readable detail; highest priority first. Superseded concepts are never included. Use it for a weekly tidy-up or before a workshop on a given area (scope).",
  inputSchema: reviewQueueInput,
  mutates: false,
  requiresDeliberation: false,
  async handler(kb, { scope, inbox_days, stale_days, min_confidence, limit }, ctx) {
    const report = await kb.reviewQueue({
      scope,
      inboxDays: inbox_days,
      staleDays: stale_days,
      minConfidence: min_confidence,
      limit,
    });
    ctx?.trace?.record("review_queue", scope ?? "", report.entries.map((e) => e.path));
    return report;
  },
};
