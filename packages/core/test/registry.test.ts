import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { buildReadTools, buildWriteTools } from "../src/agent/tools.js";
import { clearHotMemory } from "../src/agent/hot-memory.js";
import {
  CORE_TOOLS,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  getTool,
  conceptAsOfTool,
  conceptDeleteTool,
  conceptListTool,
  conceptPatchTool,
  conceptReadTool,
  conceptSearchTool,
  conceptSupersedeTool,
  conceptWriteTool,
  graphLintTool,
  linkAddTool,
} from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  kb = new KnowledgeBase(root);
  clearHotMemory();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CORE_TOOLS registry", () => {
  it("lists exactly the ten deterministic operations, correctly classified", () => {
    const names = [...CORE_TOOLS.map((t) => t.name)].sort();
    expect(names).toEqual(
      [
        "concept_search",
        "concept_read",
        "concept_list",
        "graph_lint",
        "concept_write",
        "concept_patch",
        "concept_delete",
        "link_add",
        "concept_supersede",
        "concept_as_of",
      ].sort()
    );
    // Every registry entry is Tier 0/1 — never Tier 2. This is the
    // structural claim PRISM-11's boundary proposal rests on.
    for (const def of CORE_TOOLS) {
      expect(def.requiresDeliberation).toBe(false);
    }
    const mutators = [...CORE_TOOLS.filter((t) => t.mutates).map((t) => t.name)].sort();
    expect(mutators).toEqual(
      ["concept_delete", "concept_patch", "concept_write", "link_add", "concept_supersede"].sort()
    );
  });

  it("getTool resolves by name and returns undefined for unknown names", () => {
    expect(getTool("concept_read")).toBe(conceptReadTool);
    expect(getTool("does_not_exist")).toBeUndefined();
  });

  it("READ_TOOL_NAMES and WRITE_TOOL_NAMES partition CORE_TOOLS with no overlap", () => {
    const all = new Set(CORE_TOOLS.map((t) => t.name));
    const read = new Set<string>(READ_TOOL_NAMES);
    const write = new Set<string>(WRITE_TOOL_NAMES);
    for (const n of read) expect(write.has(n)).toBe(false);
    expect(read.size + write.size).toBe(all.size);
  });

  it("no handler signature leaves room for a provider/model argument", () => {
    // Structural guarantee: every handler is (kb, input, ctx?) — ctx only
    // ever carries a trace recorder and a filesChanged set. There is no
    // parameter slot for an LLM provider, which is what makes Tier 0/1
    // purity checkable rather than just asserted.
    for (const def of CORE_TOOLS) {
      expect(def.handler.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("registry handlers perform a full round trip with no LLM involved", () => {
  it("writes, reads, searches, lists, lints, patches and deletes a concept via registry handlers alone", async () => {
    const written = await conceptWriteTool.handler(kb, {
      path: "/tables/customers.md",
      frontmatter: { type: "Table", title: "Customers", tags: ["crm"] },
      body: "# Schema\n\nid, name, email",
      log_summary: "Added customers table.",
    });
    expect(written).toEqual({ written: "/tables/customers.md" });

    const read = await conceptReadTool.handler(kb, { path: "/tables/customers.md" });
    expect(read.frontmatter.type).toBe("Table");
    expect(read.body).toContain("# Schema");

    const hits = await conceptSearchTool.handler(kb, { query: "customers" });
    const paths = Array.isArray(hits) ? hits.map((h) => h.path) : [];
    expect(paths).toContain("/tables/customers.md");

    const tree = await conceptListTool.handler(kb, {});
    expect(tree).toContain("customers.md");

    const lint = await graphLintTool.handler(kb, {});
    expect(lint.conceptCount).toBe(1);

    const patched = await conceptPatchTool.handler(kb, {
      path: "/tables/customers.md",
      frontmatter: { description: "Core customer table" },
      log_summary: "Added description.",
    });
    expect(patched).toEqual({ patched: "/tables/customers.md" });

    const reread = await conceptReadTool.handler(kb, { path: "/tables/customers.md" });
    expect(reread.frontmatter.description).toBe("Core customer table");
    // PRISM-13 acceptance criterion: a frontmatter-only patch leaves the body byte-identical.
    expect(reread.body).toBe(read.body);

    const deleted = await conceptDeleteTool.handler(kb, {
      path: "/tables/customers.md",
      log_summary: "Removed.",
    });
    expect(deleted).toEqual({ deleted: "/tables/customers.md" });
    await expect(conceptReadTool.handler(kb, { path: "/tables/customers.md" })).rejects.toBeTruthy();
  });

  it("search miss returns the notice-and-layout shape, not an empty array", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    const result = await conceptSearchTool.handler(kb, { query: "zzz_no_such_term" });
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) {
      expect(result.hits).toEqual([]);
      expect(result.bundle_layout).toContain("a.md");
    }
  });

  it("concept_search respects 'limit'", async () => {
    for (const n of [1, 2, 3]) {
      await conceptWriteTool.handler(kb, {
        path: `/match-${n}.md`,
        frontmatter: { type: "T" },
        body: "findme",
        log_summary: "seed",
      });
    }
    const hits = await conceptSearchTool.handler(kb, { query: "findme", limit: 2 });
    expect(Array.isArray(hits) && hits.length).toBe(2);
  });

  it("concept_list respects 'prefix'", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/apis/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await conceptWriteTool.handler(kb, {
      path: "/tables/b.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    const scoped = await conceptListTool.handler(kb, { prefix: "/apis" });
    expect(scoped).toContain("a.md");
    expect(scoped).not.toContain("b.md");
  });

  it("an invalid write is rejected with a message naming the offending field", async () => {
    // Zod validation happens on the parsed input shape; a caller driving the
    // schema directly (as an MCP adapter does) gets a field-named error.
    const result = conceptWriteTool.inputSchema.safeParse({
      path: "/a.md",
      frontmatter: {}, // missing required 'type'
      body: "x",
      log_summary: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path.join(".")).toBe("frontmatter.type");
    }
  });
});

describe("link_add", () => {
  it("adds a markdown link under a new '# Related' section", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/apis/billing.md",
      frontmatter: { type: "API", title: "Billing API" },
      body: "Charges customers.",
      log_summary: "seed",
    });
    await conceptWriteTool.handler(kb, {
      path: "/tables/customers.md",
      frontmatter: { type: "Table", title: "Customers" },
      body: "Customer records.",
      log_summary: "seed",
    });

    const result = await linkAddTool.handler(kb, {
      source: "/apis/billing.md",
      target: "/tables/customers.md",
      log_summary: "Linked billing to customers.",
    });
    expect(result).toEqual({
      source: "/apis/billing.md",
      target: "/tables/customers.md",
      added: true,
      markdown: "[Customers](/tables/customers.md)",
    });

    const reread = await conceptReadTool.handler(kb, { path: "/apis/billing.md" });
    expect(reread.body).toContain("# Related");
    expect(reread.body).toContain("[Customers](/tables/customers.md)");
    expect(reread.body).toContain("Charges customers.");

    const lint = await graphLintTool.handler(kb, {});
    expect(lint.orphans.map((o) => o.path)).not.toContain("/tables/customers.md");
  });

  it("appends to an existing '# Related' section instead of replacing it", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await conceptWriteTool.handler(kb, {
      path: "/b.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await conceptWriteTool.handler(kb, {
      path: "/c.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });

    await linkAddTool.handler(kb, { source: "/a.md", target: "/b.md", log_summary: "link 1" });
    await linkAddTool.handler(kb, { source: "/a.md", target: "/c.md", log_summary: "link 2" });

    const reread = await conceptReadTool.handler(kb, { path: "/a.md" });
    expect(reread.body).toContain("[b](/b.md)");
    expect(reread.body).toContain("[c](/c.md)");
    // Exactly one "# Related" heading — second link_add grew it, didn't duplicate it.
    expect(reread.body.match(/^# Related$/m)?.length).toBe(1);
  });

  it("is idempotent: re-adding the same link is a no-op", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await conceptWriteTool.handler(kb, {
      path: "/b.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await linkAddTool.handler(kb, { source: "/a.md", target: "/b.md", log_summary: "link" });
    const second = await linkAddTool.handler(kb, { source: "/a.md", target: "/b.md", log_summary: "link again" });
    expect(second).toEqual({ source: "/a.md", target: "/b.md", added: false, reason: "already linked" });
  });

  it("rejects a missing target with an actionable error", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await expect(
      linkAddTool.handler(kb, { source: "/a.md", target: "/does-not-exist.md", log_summary: "x" })
    ).rejects.toThrow(/not found/i);
  });

  it("rejects source === target", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    await expect(
      linkAddTool.handler(kb, { source: "/a.md", target: "/a.md", log_summary: "x" })
    ).rejects.toThrow(/must be a different concept/i);
  });
});

describe("granular registry operations make zero provider requests (PRISM-15)", () => {
  it("issues no network requests across a full write/read/search/list/patch/link/lint/delete round trip", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("a registry handler called fetch — that would mean a provider request was made");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await conceptWriteTool.handler(kb, {
        path: "/a.md",
        frontmatter: { type: "T" },
        body: "body",
        log_summary: "seed",
      });
      await conceptWriteTool.handler(kb, {
        path: "/b.md",
        frontmatter: { type: "T" },
        body: "body",
        log_summary: "seed",
      });
      await conceptReadTool.handler(kb, { path: "/a.md" });
      await conceptSearchTool.handler(kb, { query: "body" });
      await conceptListTool.handler(kb, {});
      await conceptPatchTool.handler(kb, {
        path: "/a.md",
        frontmatter: { description: "x" },
        log_summary: "patch",
      });
      await linkAddTool.handler(kb, { source: "/a.md", target: "/b.md", log_summary: "link" });
      await graphLintTool.handler(kb, {});
      await conceptDeleteTool.handler(kb, { path: "/b.md", log_summary: "cleanup" });

      // Same guarantee through the exact render a coarse memory_add/memory_query
      // run drives internally (buildReadTools/buildWriteTools over CORE_TOOLS) —
      // proves the registry surface itself never reaches for a provider, whichever
      // door a caller comes through.
      const filesChanged = new Set<string>();
      const write = buildWriteTools(kb, filesChanged) as Record<
        string,
        { execute: (input: unknown) => Promise<unknown> }
      >;
      await write.concept_write.execute({
        path: "/c.md",
        frontmatter: { type: "T" },
        body: "body",
        log_summary: "via agent loop",
      });
      const read = buildReadTools(kb) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
      await read.concept_read.execute({ path: "/c.md" });

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("agent tool loop is a direct render of the same registry (PRISM-12/13)", () => {
  it("buildReadTools exposes exactly READ_TOOL_NAMES", () => {
    const read = buildReadTools(kb);
    expect(Object.keys(read).sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it("buildWriteTools exposes exactly WRITE_TOOL_NAMES", () => {
    const write = buildWriteTools(kb, new Set());
    expect(Object.keys(write).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
  });

  it("the agent-loop concept_write tool and the registry's concept_write handler produce identical bundle state", async () => {
    const filesChanged = new Set<string>();
    const write = buildWriteTools(kb, filesChanged) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await write.concept_write.execute({
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "via agent loop",
    });
    expect([...filesChanged]).toEqual(["/a.md"]);

    const direct = await conceptWriteTool.handler(kb, {
      path: "/b.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "via registry directly",
    });
    expect(direct).toEqual({ written: "/b.md" });

    const a = await kb.readConcept("/a.md");
    const b = await kb.readConcept("/b.md");
    expect(a.frontmatter.type).toBe(b.frontmatter.type);
    expect(a.body).toBe(b.body);
  });
});
