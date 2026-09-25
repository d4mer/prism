import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@prism/core";
import { getSeedMemory, freshSeedMemory } from "../src/mcp/seed.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prism59-seed-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-59: the MCP overview is cached per knowledge base instead of being
// rebuilt (a whole-bundle read) on every stateless HTTP MCP request.
describe("cached MCP seed", () => {
  it("serves the cached overview on repeat calls while nothing changed", async () => {
    await kb.writeConcept("/emea/a.md", { type: "Note", title: "Alpha", description: "first" }, "x", "add");
    const first = await getSeedMemory(kb);
    expect(first).toContain("emea/");
    // Change the file behind Prism's back without bumping the generation:
    // a cached answer proves no re-read happened.
    await fs.writeFile(path.join(root, "latam.md"), "---\ntype: Note\ndescription: sneaky\n---\nx\n");
    expect(await getSeedMemory(kb)).toBe(first);
  });

  it("concurrent first calls share one computation", async () => {
    await kb.writeConcept("/a.md", { type: "Note", description: "one" }, "x", "add");
    const results = await Promise.all(Array.from({ length: 10 }, () => getSeedMemory(kb)));
    expect(new Set(results).size).toBe(1);
  });

  it("after a write, the stale overview is served immediately and a fresh one is available on demand", async () => {
    await kb.writeConcept("/emea/a.md", { type: "Note", description: "first" }, "x", "add");
    const before = await getSeedMemory(kb);
    await kb.writeConcept("/latam/b.md", { type: "Decision", description: "second" }, "x", "add");
    expect(await getSeedMemory(kb)).toBe(before); // never blocks a request on a whole-bundle read
    const fresh = await freshSeedMemory(kb);
    expect(fresh).toContain("latam/");
    expect(fresh).toContain("Decision");
    expect(await getSeedMemory(kb)).toBe(fresh);
  });
});
