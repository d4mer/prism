import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-supersede-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-23 acceptance criteria, verbatim from the ticket:
// 1. Both versions exist on disk and are linked in both directions.
// 2. Enrichment (a routine update, not a correction) produces no
//    supersession record.
// 3. Following superseded_by from any historical belief reaches the
//    current one.

describe("PRISM-23: deterministic supersession semantics", () => {
  it("AC1: both versions exist on disk, linked in both directions, one log entry", async () => {
    await kb.writeConcept(
      "/facts/price.md",
      { type: "Fact", title: "Price" },
      "# Price\n\nThe widget costs $10.",
      "Added price fact."
    );

    const { old: oldConcept, new: newConcept } = await kb.supersede(
      "/facts/price.md",
      "/facts/price-v2.md",
      { type: "Fact", title: "Price" },
      "# Price\n\nThe widget costs $12 (updated).",
      "Price increased to $12."
    );

    expect(oldConcept.path).toBe("/facts/price.md");
    expect(newConcept.path).toBe("/facts/price-v2.md");

    // Both versions exist on disk.
    const rereadOld = await kb.readConcept("/facts/price.md");
    const rereadNew = await kb.readConcept("/facts/price-v2.md");
    expect(rereadOld.frontmatter.superseded_by).toBe("/facts/price-v2.md");
    expect(rereadNew.frontmatter.supersedes).toBe("/facts/price.md");

    // One log entry, tagged Supersession, mentioning both.
    const log = await kb.readLog();
    const supersessionEntries = log.filter((e) => e.action === "Supersession");
    expect(supersessionEntries).toHaveLength(1);
    expect(supersessionEntries[0].summary).toContain("Price increased to $12.");
  });

  it("rejects superseding a concept that doesn't exist", async () => {
    await expect(
      kb.supersede("/facts/nope.md", "/facts/new.md", { type: "Fact" }, "body", "log")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("AC2: an ordinary patch (enrichment) produces no supersession record", async () => {
    await kb.writeConcept(
      "/facts/price.md",
      { type: "Fact", title: "Price" },
      "# Price\n\nThe widget costs $10.",
      "Added price fact."
    );
    // Enrichment: adding a description is a routine update, not a
    // correction — concept_patch, not concept_supersede.
    await kb.patchConcept(
      "/facts/price.md",
      { frontmatter: { description: "Retail price of the widget" } },
      "Added description."
    );
    const log = await kb.readLog();
    expect(log.some((e) => e.action === "Supersession")).toBe(false);
    expect(log.some((e) => e.action === "Update")).toBe(true);
    const reread = await kb.readConcept("/facts/price.md");
    expect(reread.frontmatter.supersedes).toBeUndefined();
    expect(reread.frontmatter.superseded_by).toBeUndefined();
  });

  it("AC3: following superseded_by from any historical belief reaches the current one", async () => {
    await kb.writeConcept("/facts/status.md", { type: "Fact", title: "Status" }, "v1: draft", "Added v1.");
    const r2 = await kb.supersede(
      "/facts/status.md",
      "/facts/status-v2.md",
      { type: "Fact", title: "Status" },
      "v2: in review",
      "Moved to in review."
    );
    const r3 = await kb.supersede(
      r2.new.path,
      "/facts/status-v3.md",
      { type: "Fact", title: "Status" },
      "v3: shipped",
      "Shipped."
    );

    // Starting from the oldest version, following superseded_by should
    // reach the current (v3) belief, which has no superseded_by itself.
    let current = await kb.readConcept("/facts/status.md");
    const visited = [current.path];
    while (typeof current.frontmatter.superseded_by === "string") {
      current = await kb.readConcept(current.frontmatter.superseded_by);
      visited.push(current.path);
    }
    expect(visited).toEqual(["/facts/status.md", "/facts/status-v2.md", "/facts/status-v3.md"]);
    expect(current.path).toBe(r3.new.path);
    expect(current.frontmatter.superseded_by).toBeUndefined();

    // And starting from the middle version reaches the same current one.
    let fromMiddle = await kb.readConcept("/facts/status-v2.md");
    while (typeof fromMiddle.frontmatter.superseded_by === "string") {
      fromMiddle = await kb.readConcept(fromMiddle.frontmatter.superseded_by);
    }
    expect(fromMiddle.path).toBe(r3.new.path);
  });

  it("keeps index/log/graph healthy after a chain of supersessions (no orphans, no broken links)", async () => {
    await kb.writeConcept("/facts/a.md", { type: "Fact" }, "a", "Added a.");
    await kb.supersede("/facts/a.md", "/facts/a2.md", { type: "Fact" }, "a2", "Superseded a.");
    const lint = await kb.lint();
    expect(lint.healthy).toBe(true);
    const validation = await kb.validate();
    expect(validation.conformant).toBe(true);
  });
});
