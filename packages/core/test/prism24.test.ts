import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-prism24-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-24 acceptance criteria, verbatim from the ticket:
// 1. A default search after a supersession returns only the new belief.
// 2. The historical belief is retrievable on request (include_history) and
//    labelled superseded:true.
// 3. An as-of query for a date before the supersession returns the old
//    belief; for a date after, the new one.
// 4. Superseded concepts do not inflate the orphan count in graph_lint.

describe("PRISM-24: current-belief-aware retrieval", () => {
  it("AC1: default search after a supersession returns only the new belief", async () => {
    await kb.writeConcept(
      "/facts/price.md",
      { type: "Fact", title: "Price", asserted: "2026-01-01T00:00:00Z" },
      "# Price\n\nThe widget costs $10.",
      "Added price fact."
    );
    await kb.supersede(
      "/facts/price.md",
      "/facts/price-v2.md",
      { type: "Fact", title: "Price", asserted: "2026-06-01T00:00:00Z" },
      "# Price\n\nThe widget costs $12 (updated).",
      "Price increased to $12."
    );

    const hits = await kb.search("widget");
    expect(hits.map((h) => h.path)).toEqual(["/facts/price-v2.md"]);
    expect(hits[0].superseded).toBeUndefined();
  });

  it("AC2: the historical belief is retrievable via include_history, labelled superseded:true", async () => {
    await kb.writeConcept(
      "/facts/price.md",
      { type: "Fact", title: "Price", asserted: "2026-01-01T00:00:00Z" },
      "# Price\n\nThe widget costs $10.",
      "Added price fact."
    );
    await kb.supersede(
      "/facts/price.md",
      "/facts/price-v2.md",
      { type: "Fact", title: "Price", asserted: "2026-06-01T00:00:00Z" },
      "# Price\n\nThe widget costs $12 (updated).",
      "Price increased to $12."
    );

    const hits = await kb.search("widget", { includeHistory: true });
    const byPath = new Map(hits.map((h) => [h.path, h]));
    expect(byPath.size).toBe(2);
    expect(byPath.get("/facts/price.md")?.superseded).toBe(true);
    expect(byPath.get("/facts/price-v2.md")?.superseded).toBeUndefined();
  });

  it("AC3: an as-of query returns the belief that was current at that date", async () => {
    await kb.writeConcept(
      "/facts/status.md",
      { type: "Fact", title: "Status", asserted: "2026-01-01T00:00:00Z" },
      "v1: draft",
      "Added v1."
    );
    await kb.supersede(
      "/facts/status.md",
      "/facts/status-v2.md",
      { type: "Fact", title: "Status", asserted: "2026-06-01T00:00:00Z" },
      "v2: shipped",
      "Shipped."
    );

    const before = await kb.asOf("2026-03-01T00:00:00Z");
    const beforeHit = before.find((c) => c.path === "/facts/status.md" || c.path === "/facts/status-v2.md");
    expect(beforeHit?.path).toBe("/facts/status.md");
    expect(beforeHit?.body).toContain("draft");

    const after = await kb.asOf("2026-08-01T00:00:00Z");
    const afterHit = after.find((c) => c.path === "/facts/status.md" || c.path === "/facts/status-v2.md");
    expect(afterHit?.path).toBe("/facts/status-v2.md");
    expect(afterHit?.body).toContain("shipped");

    const beforeEverything = await kb.asOf("2020-01-01T00:00:00Z");
    expect(beforeEverything.some((c) => c.path === "/facts/status.md" || c.path === "/facts/status-v2.md")).toBe(
      false
    );
  });

  it("AC3b: falls back to write timestamp when asserted is absent", async () => {
    await kb.writeConcept("/facts/note.md", { type: "Fact", title: "Note" }, "an ordinary note", "Added note.");
    const reread = await kb.readConcept("/facts/note.md");
    const writtenAt = reread.frontmatter.timestamp as string;
    expect(typeof writtenAt).toBe("string");

    const before = await kb.asOf(new Date(Date.parse(writtenAt) - 60_000).toISOString());
    expect(before.some((c) => c.path === "/facts/note.md")).toBe(false);

    const after = await kb.asOf(new Date(Date.parse(writtenAt) + 60_000).toISOString());
    expect(after.some((c) => c.path === "/facts/note.md")).toBe(true);
  });

  it("AC3c: beliefs asserted at the same instant resolve by supersession order, not path order", async () => {
    const same = "2026-03-01";
    // Originals sort FIRST alphabetically, so the traversal starts from the
    // oldest belief and a stable sort on equal times would keep it on top.
    await kb.writeConcept("/facts/a-v1.md", { type: "Fact", asserted: same }, "v1", "Added v1.");
    await kb.supersede("/facts/a-v1.md", "/facts/b-v2.md", { type: "Fact", asserted: same }, "v2", "Superseded v1.");
    await kb.supersede("/facts/b-v2.md", "/facts/c-v3.md", { type: "Fact", asserted: same }, "v3", "Superseded v2.");
    await kb.writeConcept("/facts/d-x1.md", { type: "Fact", asserted: same }, "x1", "Added x1.");
    await kb.supersede("/facts/d-x1.md", "/facts/e-x2.md", { type: "Fact", asserted: same }, "x2", "Superseded x1.");

    const got = (await kb.asOf(`${same}T12:00:00Z`)).map((c) => c.path);
    expect(got).toEqual(["/facts/c-v3.md", "/facts/e-x2.md"]);
  });

  it("AC3d: marking a belief superseded (which refreshes its write time) does not make it look newer than its replacement", async () => {
    await kb.writeConcept("/facts/old.md", { type: "Fact", title: "Old" }, "old", "Added old.");
    await kb.supersede("/facts/old.md", "/facts/new.md", { type: "Fact", title: "New" }, "new", "Superseded old.");
    const replacement = await kb.readConcept("/facts/new.md");
    const replacedAt = Date.parse(replacement.frontmatter.timestamp as string);

    // Simulate the old concept having been re-stamped after the replacement
    // was written (exactly what happens when the superseded_by link is added).
    const file = path.join(root, "facts", "old.md");
    const raw = await fs.readFile(file, "utf8");
    const later = new Date(replacedAt + 3_600_000).toISOString();
    expect(raw).toMatch(/timestamp:/);
    await fs.writeFile(file, raw.replace(/^timestamp: .*$/m, `timestamp: '${later}'`));

    const got = (await kb.asOf(new Date(replacedAt + 7_200_000).toISOString())).map((c) => c.path);
    expect(got).toEqual(["/facts/new.md"]);
  });

  it("rejects a malformed as-of date", async () => {
    await expect(kb.asOf("not-a-date")).rejects.toThrow(/Invalid "as_of" date/);
  });

  it("AC4: superseded concepts do not inflate the graph_lint orphan count", async () => {
    await kb.writeConcept("/facts/a.md", { type: "Fact" }, "a", "Added a.");
    await kb.supersede("/facts/a.md", "/facts/a2.md", { type: "Fact" }, "a2", "Superseded a.");

    const lint = await kb.lint();
    expect(lint.orphans.some((o) => o.path === "/facts/a.md")).toBe(false);
    expect(lint.healthy).toBe(true);
  });

  it("graph() excludes superseded nodes/edges by default, includes them with includeHistory", async () => {
    await kb.writeConcept("/facts/a.md", { type: "Fact" }, "a", "Added a.");
    await kb.supersede("/facts/a.md", "/facts/a2.md", { type: "Fact" }, "a2", "Superseded a.");

    const defaultGraph = await kb.graph();
    expect(defaultGraph.nodes.map((n) => n.path)).toEqual(["/facts/a2.md"]);

    const fullGraph = await kb.graph({ includeHistory: true });
    const paths = fullGraph.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(["/facts/a.md", "/facts/a2.md"]);
    const oldNode = fullGraph.nodes.find((n) => n.path === "/facts/a.md");
    expect(oldNode?.superseded).toBe(true);
  });

  it("listTree marks superseded concepts (what the seed overview relies on to skip them)", async () => {
    await kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "a", "Added a.");
    await kb.supersede("/facts/a.md", "/facts/a2.md", { type: "Fact", title: "A" }, "a2", "Superseded a.");

    const tree = await kb.listTree();
    const factsDir = tree.children?.find((c) => c.name === "facts");
    const aNode = factsDir?.children?.find((c) => c.path === "/facts/a.md");
    const a2Node = factsDir?.children?.find((c) => c.path === "/facts/a2.md");
    expect(aNode?.superseded).toBe(true);
    expect(a2Node?.superseded).toBeUndefined();
  });
});
