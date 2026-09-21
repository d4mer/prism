import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-related-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-47 acceptance criteria, verbatim from the ticket:
// 1. Given a concept with N direct links, a 1-hop query returns exactly
//    those N linked concepts.
// 2. A 2-hop query returns the 1-hop concepts' own links too, without
//    duplicates and without re-including the origin.
// 3. Superseded concepts are excluded by default and included with
//    include_history, consistent with concept_search/graph.

/**
 * A small diamond-shaped graph, reused by most of the tests below:
 *
 *   f --> a --> b --> d
 *         |            ^
 *         +----> c ----+
 *
 * a has two outbound links (b, c); f has one inbound link (into a) — so
 * a's direct neighbors, regardless of edge direction, are {b, c, f}. b and
 * c both link to d, so d is two hops from a via either path (a dedup case).
 * e is wired to nothing, for the "isolated concept has no related" case.
 */
async function buildDiamond(kb: KnowledgeBase) {
  await kb.writeConcept("/a.md", { type: "Note", title: "A" }, "[B](/b.md) [C](/c.md)", "add a");
  await kb.writeConcept("/b.md", { type: "Note", title: "B" }, "[D](/d.md)", "add b");
  await kb.writeConcept("/c.md", { type: "Note", title: "C" }, "[D](/d.md)", "add c");
  await kb.writeConcept("/d.md", { type: "Note", title: "D" }, "no outbound links", "add d");
  await kb.writeConcept("/e.md", { type: "Note", title: "E" }, "isolated, links to nothing", "add e");
  await kb.writeConcept("/f.md", { type: "Note", title: "F" }, "[A](/a.md)", "add f");
}

describe("PRISM-47: concept_related (graph-neighbor retrieval)", () => {
  it("AC1: a 1-hop query returns exactly the N concepts linked to/from the origin", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md", { hops: 1 });
    expect(hits.map((h) => h.path).sort()).toEqual(["/b.md", "/c.md", "/f.md"]);
    for (const h of hits) expect(h.distance).toBe(1);
  });

  it("defaults to 1 hop when hops is omitted", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md");
    expect(hits.map((h) => h.path).sort()).toEqual(["/b.md", "/c.md", "/f.md"]);
  });

  it("AC2: a 2-hop query adds the 1-hop concepts' own links, deduplicated, without the origin", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md", { hops: 2 });
    const byPath = new Map(hits.map((h) => [h.path, h]));
    // b, c at distance 1; d reached via BOTH b and c but appears exactly once, at distance 2.
    expect([...byPath.keys()].sort()).toEqual(["/b.md", "/c.md", "/d.md", "/f.md"]);
    expect(byPath.get("/b.md")?.distance).toBe(1);
    expect(byPath.get("/c.md")?.distance).toBe(1);
    expect(byPath.get("/f.md")?.distance).toBe(1);
    expect(byPath.get("/d.md")?.distance).toBe(2);
    expect(byPath.has("/a.md")).toBe(false); // never re-includes the origin
  });

  it("a hop count beyond the graph's diameter returns the same set as the diameter (no error, no phantom hits)", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md", { hops: 10 });
    expect(hits.map((h) => h.path).sort()).toEqual(["/b.md", "/c.md", "/d.md", "/f.md"]);
  });

  it("an isolated concept (no inbound or outbound links) has no related concepts", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/e.md", { hops: 5 });
    expect(hits).toEqual([]);
  });

  it("edges are undirected: an inbound-only link surfaces the same as an outbound one", async () => {
    await buildDiamond(kb);
    // f links TO a (f -> a in the markdown), but asking "what's related to a"
    // must surface f too — "related" is symmetric, not "what a points at".
    const hits = await kb.related("/a.md", { hops: 1 });
    expect(hits.some((h) => h.path === "/f.md")).toBe(true);
  });

  it("hits carry the neighbor's title/type from the graph, not just its path", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md", { hops: 1 });
    const b = hits.find((h) => h.path === "/b.md");
    expect(b?.title).toBe("B");
    expect(b?.type).toBe("Note");
  });

  it("throws for a concept that doesn't exist (same as concept_read)", async () => {
    await buildDiamond(kb);
    await expect(kb.related("/nope.md")).rejects.toThrow(/not found/i);
  });

  it("AC3: a superseded concept, and edges reachable only through it, are excluded by default", async () => {
    await buildDiamond(kb);
    await kb.supersede(
      "/d.md",
      "/d-v2.md",
      { type: "Note", title: "D v2" },
      "no outbound links",
      "supersede d"
    );

    const defaultHits = await kb.related("/a.md", { hops: 2 });
    expect(defaultHits.some((h) => h.path === "/d.md")).toBe(false);
    // d-v2 isn't linked from b/c directly (only supersedes /d.md, which is
    // itself excluded) — so it correctly doesn't appear either.
    expect(defaultHits.some((h) => h.path === "/d-v2.md")).toBe(false);
    expect(defaultHits.map((h) => h.path).sort()).toEqual(["/b.md", "/c.md", "/f.md"]);

    const historyHits = await kb.related("/a.md", { hops: 2, includeHistory: true });
    const oldD = historyHits.find((h) => h.path === "/d.md");
    expect(oldD).toBeDefined();
    expect(oldD?.superseded).toBe(true);
    expect(oldD?.distance).toBe(2);
  });

  it("results are sorted by distance, then path, for deterministic output", async () => {
    await buildDiamond(kb);
    const hits = await kb.related("/a.md", { hops: 2 });
    const distances = hits.map((h) => h.distance);
    expect(distances).toEqual([...distances].sort((x, y) => x - y));
    // Within the same distance, alphabetical by path.
    const distance1 = hits.filter((h) => h.distance === 1).map((h) => h.path);
    expect(distance1).toEqual([...distance1].sort());
  });
});
