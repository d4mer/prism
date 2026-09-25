import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, regenerateIndex, clearIndexSummaryCache } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-summary-cache-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  clearIndexSummaryCache(kb.bundle);
  await fs.rm(root, { recursive: true, force: true });
});

/** Every index.md in the bundle, keyed by bundle-relative directory. */
async function snapshotIndexes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string) => {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.name === "index.md") out["/" + path.relative(root, abs)] = await fs.readFile(child, "utf-8");
    }
  };
  await walk(root);
  return out;
}

/** A from-scratch regeneration of every index.md, with no cached summaries. */
async function fullRegeneration(): Promise<Record<string, string>> {
  clearIndexSummaryCache(kb.bundle);
  const dirs = Object.keys(await snapshotIndexes()).sort((a, b) => b.split("/").length - a.split("/").length);
  for (const d of dirs) await regenerateIndex(kb.bundle, d === "/" ? "/" : d);
  return snapshotIndexes();
}

// PRISM-59 AC3: index.md files after a sequence of writes are byte-identical
// to a full regeneration.
describe("cached folder summaries", () => {
  it("after a mixed sequence of writes, patches, deletes, supersessions and captures, every index.md equals a full regeneration", async () => {
    const types = ["Decision", "Interface", "Note", "Config Item"];
    for (let i = 0; i < 40; i++) {
      const region = ["emea", "latam", "apac"][i % 3];
      const stream = ["cmo", "l2l"][i % 2];
      await kb.writeConcept(`/${region}/${stream}/c${i}.md`, { type: types[i % 4], title: `Concept ${String(i).padStart(2, "0")}` }, "x", "add");
    }
    await kb.writeConcept("/emea/cmo/deeper/d1.md", { type: "Risk", title: "Aardvark first" }, "x", "add");
    await kb.patchConcept("/latam/l2l/c1.md", { frontmatter: { title: "AAA renamed to sort first", type: "Requirement" } }, "rename");
    await kb.deleteConcept("/apac/cmo/c2.md", "gone");
    await kb.supersede("/emea/cmo/c0.md", "/apac/l2l/c0-v2.md", { type: "Decision", title: "Moved and replaced" }, "v2", "");
    await kb.capture({ text: "Inbox thought" });
    for (const p of ["/emea/cmo/deeper/d1.md"]) await kb.deleteConcept(p, "gone"); // prunes /emea/cmo/deeper

    const incremental = await snapshotIndexes();
    const full = await fullRegeneration();
    expect(incremental).toEqual(full);
    expect(incremental["/"]).toContain("[emea](emea/)");
    expect(Object.keys(incremental)).not.toContain("/emea/cmo/deeper");
  });

  it("an external edit picked up by reconcile refreshes the affected folder summaries", async () => {
    await kb.writeConcept("/emea/a.md", { type: "Note", title: "Alpha" }, "x", "add");
    await kb.writeConcept("/latam/b.md", { type: "Note", title: "Beta" }, "x", "add");
    await kb.rebuildSearchIndex();
    // Outside Prism: a new file with a new type appears under /emea.
    await fs.writeFile(path.join(root, "emea", "ext.md"), "---\ntype: Interface\ntitle: External\n---\nx\n");
    await kb.reconcileSearchIndex();
    // The next unrelated write regenerates the root index from cached summaries.
    await kb.writeConcept("/latam/c.md", { type: "Note", title: "Gamma" }, "x", "add");
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).toMatch(/\[emea\]\(emea\/\) - 2 concepts \(Interface, Note\)/);
  });

  it("bumps the generation on in-band writes and on reconciled external edits, not on no-ops", async () => {
    const g0 = kb.generation;
    await kb.writeConcept("/a.md", { type: "Note" }, "x", "add");
    expect(kb.generation).toBeGreaterThan(g0);
    await kb.rebuildSearchIndex();
    const g1 = kb.generation;
    await kb.reconcileSearchIndex();
    expect(kb.generation).toBe(g1); // nothing changed on disk
    await fs.writeFile(path.join(root, "b.md"), "---\ntype: Note\n---\nx\n");
    await kb.reconcileSearchIndex();
    expect(kb.generation).toBeGreaterThan(g1);
  });
});
