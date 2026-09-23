import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, deriveTitle, slugify, planCapture } from "../src/okf/index.js";
import { conceptCaptureTool, conceptSearchTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-capture-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-52 acceptance criteria:
// 1. Only `text` → a valid concept under /inbox, path returned.
// 2. Same title twice the same day → two distinct files, nothing overwritten.
// 3. Immediately findable via concept_search (and the inbox tag).
// 4. Available over MCP and REST from the single registry entry (registry.test.ts + routes).

describe("capture helpers", () => {
  it("derives a title from the first meaningful line, stripping markdown markers", () => {
    expect(deriveTitle("\n\n# Cutover risks\nmore")).toBe("Cutover risks");
    expect(deriveTitle("- Ask client about CMO lead times")).toBe("Ask client about CMO lead times");
    expect(deriveTitle("   ")).toBe("Untitled note");
  });

  it("caps long titles at a word boundary", () => {
    const long = "Safety stock method for the CMO network needs to move from dynamic to fixed banding because OMP lacks it";
    const t = deriveTitle(long);
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith("…")).toBe(true);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
  });

  it("slugifies to ascii-safe hyphenated names, with a fallback", () => {
    expect(slugify("APO → OMP: Safety-Stock (CMO)!")).toBe("apo-omp-safety-stock-cmo");
    expect(slugify("Décision réseau")).toBe("decision-reseau");
    expect(slugify("!!!")).toBe("note");
  });

  it("rejects a concept path passed as a folder", () => {
    expect(() => planCapture({ text: "x", folder: "/inbox/a.md" })).toThrow(/directory/);
  });
});

describe("KnowledgeBase.capture", () => {
  it("AC1: files a valid concept under /inbox from text alone", async () => {
    const c = await kb.capture({ text: "Cutover risks\n\nFreeze APO writes 48h before go-live." });
    expect(c.path).toBe(`/inbox/${today()}-cutover-risks.md`);
    const read = await kb.readConcept(c.path);
    expect(read.frontmatter.type).toBe("note");
    expect(read.frontmatter.title).toBe("Cutover risks");
    expect(read.frontmatter.source).toBe("human");
    expect(typeof read.frontmatter.asserted).toBe("string");
    expect(read.frontmatter.tags).toEqual(["inbox"]);
    expect(read.body).toContain("Freeze APO writes 48h before go-live.");
    const report = await kb.validate();
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("AC2: same title twice the same day yields distinct files, first untouched", async () => {
    const a = await kb.capture({ text: "Standup\nfirst" });
    const b = await kb.capture({ text: "Standup\nsecond" });
    const c = await kb.capture({ text: "Standup\nthird" });
    expect(new Set([a.path, b.path, c.path]).size).toBe(3);
    expect(b.path).toBe(a.path.replace(/\.md$/, "-2.md"));
    expect(c.path).toBe(a.path.replace(/\.md$/, "-3.md"));
    expect((await kb.readConcept(a.path)).body).toContain("first");
  });

  it("AC2 under concurrency: parallel same-title captures never collide", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => kb.capture({ text: `Workshop notes\nitem ${i}` }))
    );
    expect(new Set(results.map((r) => r.path)).size).toBe(5);
    const bodies = await Promise.all(results.map((r) => kb.readConcept(r.path)));
    expect(new Set(bodies.map((b) => b.body.trim())).size).toBe(5);
  });

  it("AC3: captured note is immediately searchable, including by the inbox tag", async () => {
    await kb.capture({ text: "Interface IF-042 nightly batch fails on BOM changes" });
    const byText = await kb.search("nightly batch");
    expect(byText.map((h) => h.path)).toContain(`/inbox/${today()}-interface-if-042-nightly-batch-fails-on-bom-changes.md`);
    const byTag = await kb.search("", { tags: ["inbox"] });
    expect(byTag.length).toBe(1);
  });

  it("honours explicit title, type, tags, source and folder (no inbox tag outside /inbox)", async () => {
    const c = await kb.capture({
      text: "body text",
      title: "Decision: fixed banding",
      type: "Decision",
      tags: ["emea", "cmo"],
      source: "document",
      folder: "/emea/cmo/",
    });
    expect(c.path).toBe(`/emea/cmo/${today()}-decision-fixed-banding.md`);
    expect(c.frontmatter).toMatchObject({ type: "Decision", source: "document", tags: ["emea", "cmo"] });
  });

  it("writes a Creation entry to log.md and keeps index.md in sync", async () => {
    const c = await kb.capture({ text: "Log me" });
    const log = await kb.readLog();
    expect(log[0].action).toBe("Creation");
    expect(log[0].summary).toContain(c.path);
    const index = await fs.readFile(path.join(root, "inbox", "index.md"), "utf-8");
    expect(index).toContain(path.posix.basename(c.path));
  });

  it("cannot escape the bundle via folder", async () => {
    await expect(kb.capture({ text: "x", folder: "/../../etc" })).rejects.toThrow();
  });
});

describe("concept_capture registry tool", () => {
  it("round-trips through the handler and schema", async () => {
    const input = conceptCaptureTool.inputSchema.parse({ text: "Quick thought about L2L sourcing" });
    const filesChanged = new Set<string>();
    const out = await conceptCaptureTool.handler(kb, input, { filesChanged });
    expect(out.captured).toBe(`/inbox/${today()}-quick-thought-about-l2l-sourcing.md`);
    expect(out).toMatchObject({ title: "Quick thought about L2L sourcing", type: "note" });
    expect([...filesChanged]).toEqual([out.captured]);
    const hits = await conceptSearchTool.handler(kb, conceptSearchTool.inputSchema.parse({ query: "L2L sourcing" }));
    expect(Array.isArray(hits) && hits.map((h) => h.path)).toContain(out.captured);
  });

  it("rejects empty text and an invalid source at the schema level", () => {
    expect(() => conceptCaptureTool.inputSchema.parse({ text: "   " })).toThrow();
    expect(() => conceptCaptureTool.inputSchema.parse({ text: "x", source: "gossip" })).toThrow();
  });
});
