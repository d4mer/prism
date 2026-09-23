import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, aliasScore } from "../src/okf/index.js";
import { searchBundle, type SearchOptions } from "../src/okf/search.js";
import { tryIndexedSearch, indexPath } from "../src/okf/search-index.js";
import { conceptWriteTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-aliases-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-55 acceptance criteria:
// 1. Searching an alias returns the concept even when the alias appears nowhere else in it.
// 2. Scan and index paths return identical results.
// 3. Delete-and-rebuild the index gives identical results.

async function seed() {
  await kb.writeConcept(
    "/networks/local-to-local.md",
    { type: "Reference", title: "Local-to-local supply network", aliases: ["L2L"] },
    "Sites that manufacture for their own market.",
    "add"
  );
  await kb.writeConcept(
    "/networks/cmo.md",
    { type: "Reference", title: "External manufacturing", aliases: ["CMO", "contract manufacturing organisation"] },
    "Third-party manufacturers.",
    "add"
  );
  // Mentions "CMO" in body and title-ish text but is NOT the CMO concept —
  // the exact-alias concept must still rank above it.
  await kb.writeConcept(
    "/decisions/cmo-safety-stock.md",
    { type: "Decision", title: "CMO safety stock buffer", tags: ["cmo"] },
    "Applies to every CMO in the network. CMO CMO.",
    "add"
  );
  await kb.writeConcept("/notes/plain.md", { type: "Note", title: "Unrelated" }, "Nothing here.", "add");
}

const QUERIES: { query: string; options?: SearchOptions }[] = [
  { query: "L2L" },
  { query: "l2l" },
  { query: "CMO" },
  { query: "contract manufacturing organisation" },
  { query: "manufacturing" },
  { query: "" },
  { query: "CMO", options: { type: "Reference" } },
  { query: "L2L", options: { scope: "/decisions" } },
];

describe("PRISM-55: aliases", () => {
  it("AC1: an alias that appears nowhere else still finds the concept", async () => {
    await seed();
    const hits = await kb.search("L2L");
    expect(hits.map((h) => h.path)).toEqual(["/networks/local-to-local.md"]);
    // Case-insensitive.
    expect((await kb.search("l2l")).map((h) => h.path)).toEqual(["/networks/local-to-local.md"]);
  });

  it("an exact alias match ranks first, above concepts that merely mention the term a lot", async () => {
    await seed();
    const hits = await kb.search("CMO");
    expect(hits[0].path).toBe("/networks/cmo.md");
    expect(hits.map((h) => h.path)).toContain("/decisions/cmo-safety-stock.md");
    // Multi-word exact alias, whitespace-insensitive.
    const long = await kb.search("  Contract   Manufacturing Organisation ");
    expect(long[0].path).toBe("/networks/cmo.md");
  });

  it("AC2: scan and derived index return identical results, alias queries included", async () => {
    await seed();
    await kb.rebuildSearchIndex();
    for (const { query, options } of QUERIES) {
      const scanned = await searchBundle(kb.bundle, query, options);
      const indexed = await tryIndexedSearch(kb.bundle, query, options);
      expect(indexed).toEqual(scanned);
    }
  });

  it("AC3: delete + rebuild reproduces identical alias results", async () => {
    await seed();
    await kb.rebuildSearchIndex();
    const before = [];
    for (const { query, options } of QUERIES) before.push(await kb.search(query, options));
    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(indexPath(kb.bundle) + suffix, { force: true });
    await kb.rebuildSearchIndex();
    const after = [];
    for (const { query, options } of QUERIES) after.push(await kb.search(query, options));
    expect(after).toEqual(before);
  });

  it("incremental index maintenance picks up an alias added by patch", async () => {
    await seed();
    await kb.rebuildSearchIndex();
    expect((await tryIndexedSearch(kb.bundle, "APO"))?.length).toBe(0);
    await kb.patchConcept("/notes/plain.md", { frontmatter: { aliases: ["APO"] } }, "alias");
    expect((await tryIndexedSearch(kb.bundle, "APO"))?.map((h) => h.path)).toEqual(["/notes/plain.md"]);
  });

  it("rejects malformed aliases at write time, and flags hand-edited ones as warnings", async () => {
    await expect(kb.writeConcept("/x.md", { type: "T", aliases: "L2L" as unknown as string[] }, "", "x")).rejects.toThrow(/aliases/);
    await expect(kb.writeConcept("/x.md", { type: "T", aliases: ["ok", "  "] }, "", "x")).rejects.toThrow(/aliases/);
    expect(() =>
      conceptWriteTool.inputSchema.parse({ path: "/x.md", frontmatter: { type: "T", aliases: [""] }, body: "", log_summary: "x" })
    ).toThrow();
    await fs.writeFile(path.join(root, "hand.md"), "---\ntype: T\naliases: 42\n---\nbody\n", "utf-8");
    const report = await kb.validate();
    expect(report.issues.some((i) => i.path === "/hand.md" && /aliases/.test(i.message) && i.severity === "warning")).toBe(true);
    // Read path stays tolerant: a malformed alias never breaks search.
    expect(await kb.search("body")).toHaveLength(1);
  });

  it("aliasScore: per-term title weight plus exact-match boost", () => {
    expect(aliasScore([], ["l2l"], "l2l")).toBe(0);
    expect(aliasScore(["l2l"], ["l2l"], "L2L")).toBe(110);
    expect(aliasScore(["local-to-local"], ["local"], "local")).toBe(10);
  });
});
