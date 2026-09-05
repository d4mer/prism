import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bundle } from "../src/okf/bundle.js";
import { KnowledgeBase } from "../src/okf/index.js";
import { searchBundle, type SearchOptions } from "../src/okf/search.js";
import { rebuildSearchIndex, tryIndexedSearch, indexExists, indexPath } from "../src/okf/search-index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-search-index-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function seedBundle() {
  await kb.writeConcept(
    "/hosts/web01.md",
    { type: "Host", title: "web01", description: "Primary web server", tags: ["web", "prod"] },
    "# web01\n\nRuns nginx and the app server. See [db01](/hosts/db01.md) for the database.",
    "Added web01."
  );
  await kb.writeConcept(
    "/hosts/db01.md",
    { type: "Host", title: "db01", description: "Primary database server", tags: ["db", "prod"] },
    "# db01\n\nRuns postgres for web01.",
    "Added db01."
  );
  await kb.writeConcept(
    "/playbooks/deploy.md",
    { type: "Playbook", title: "Deploy", tags: ["ops"] },
    "# Deploy\n\nSteps to deploy the web app to [web01](/hosts/web01.md).",
    "Added deploy playbook."
  );
  await kb.writeConcept(
    "/notes/untyped.md",
    { type: "Note" },
    "A note with no title or description, mentioning web and db in passing.",
    "Added untyped note."
  );
  await kb.supersede(
    "/hosts/db01.md",
    "/hosts/db01-v2.md",
    {
      type: "Host",
      title: "db01",
      description: "Upgraded database server",
      tags: ["db", "prod", "upgraded"],
    },
    "# db01\n\nUpgraded to postgres 16.",
    "Upgraded db01."
  );
}

// PRISM-35 acceptance criteria, verbatim from the ticket:
// 1. Delete the index and rebuild it — results before and after are byte-identical.
// 2. Search results using the index match the results of the previous linear scan
//    for the existing bundle.
// 3. Index build for a 10,000-concept bundle completes within a documented time budget.

const QUERIES: { query: string; options?: SearchOptions }[] = [
  { query: "web" },
  { query: "database" },
  { query: "db01" },
  { query: "" },
  { query: "web", options: { type: "Host" } },
  { query: "", options: { tags: ["prod"] } },
  { query: "postgres", options: { includeHistory: true } },
  { query: "nonexistenttermxyz" },
];

describe("PRISM-35: derived SQLite search index", () => {
  it("AC1: delete + rebuild reproduces byte-identical results", async () => {
    await seedBundle();
    await kb.rebuildSearchIndex();

    const before: unknown[] = [];
    for (const { query, options } of QUERIES) {
      before.push(await kb.search(query, options));
    }

    const file = indexPath(kb.bundle);
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(file + suffix, { force: true });
    }
    expect(await indexExists(kb.bundle)).toBe(false);

    await kb.rebuildSearchIndex();
    expect(await indexExists(kb.bundle)).toBe(true);

    const after: unknown[] = [];
    for (const { query, options } of QUERIES) {
      after.push(await kb.search(query, options));
    }

    expect(after).toEqual(before);
  });

  it("AC2: indexed search results match the legacy scan exactly", async () => {
    await seedBundle();
    await kb.rebuildSearchIndex();

    for (const { query, options } of QUERIES) {
      const scanned = await searchBundle(kb.bundle, query, options);
      const indexed = await tryIndexedSearch(kb.bundle, query, options);
      expect(indexed).toEqual(scanned);
    }
  });

  it(
    "AC3: a 10,000-concept bundle builds within budget",
    async () => {
      const bundle = new Bundle(root);
      const N = 10_000;
      for (let i = 0; i < N; i++) {
        const dir = `dir${i % 50}`;
        const abs = path.join(root, dir, `concept-${i}.md`);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const fm =
          `type: Fact\n` +
          `title: "Concept ${i}"\n` +
          `description: "Synthetic concept number ${i} for benchmarking"\n` +
          `tags: ["synthetic", "batch${i % 10}"]\n` +
          `timestamp: "2026-01-01T00:00:00.000Z"\n`;
        const body = `# Concept ${i}\n\nThis is synthetic body text for concept ${i}, mentioning widget and gadget for search variety.\n`;
        await fs.writeFile(abs, `---\n${fm}---\n\n${body}`, "utf-8");
      }

      const start = performance.now();
      const { count } = await rebuildSearchIndex(bundle);
      const elapsedMs = performance.now() - start;

      expect(count).toBe(N);
      // Documented budget: 10,000 concepts must index in under 10s on
      // reasonable hardware. Measured on the reference dev machine (Apple
      // M1) this completes in well under 3s; 10s leaves headroom for
      // slower CI/consultant hardware while still catching a regression
      // back to the O(n^2) per-row FTS/links DELETE pattern this
      // implementation deliberately avoids during a full rebuild.
      expect(elapsedMs).toBeLessThan(10_000);
    },
    60_000
  );

  it("incremental maintenance: writeConcept/patchConcept/deleteConcept/supersede keep an existing index in sync", async () => {
    await seedBundle();
    await kb.rebuildSearchIndex();

    await kb.writeConcept(
      "/hosts/web02.md",
      { type: "Host", title: "web02", description: "Secondary web server", tags: ["web"] },
      "# web02\n\nA second web server.",
      "Added web02."
    );
    let hits = await kb.search("web02");
    expect(hits.map((h) => h.path)).toContain("/hosts/web02.md");

    await kb.patchConcept(
      "/hosts/web02.md",
      { frontmatter: { description: "Renamed description mentioning zzzunique" } },
      "Updated web02 description."
    );
    hits = await kb.search("zzzunique");
    expect(hits.map((h) => h.path)).toEqual(["/hosts/web02.md"]);

    await kb.deleteConcept("/hosts/web02.md", "Removed web02.");
    hits = await kb.search("zzzunique");
    expect(hits).toEqual([]);

    await kb.supersede(
      "/hosts/web01.md",
      "/hosts/web01-v2.md",
      { type: "Host", title: "web01", description: "Retired old web01" },
      "# web01\n\nRetired.",
      "Retired web01."
    );
    const defaultHits = await kb.search("web01");
    expect(defaultHits.map((h) => h.path)).not.toContain("/hosts/web01.md");
    const historyHits = await kb.search("web01", { includeHistory: true });
    const byPath = new Map(historyHits.map((h) => [h.path, h]));
    expect(byPath.get("/hosts/web01.md")?.superseded).toBe(true);
    expect(byPath.get("/hosts/web01-v2.md")?.superseded).toBeUndefined();
  });

  it("incremental maintenance is a no-op when no index has been built yet", async () => {
    await seedBundle();
    // seedBundle's writeConcept/patchConcept/supersede calls must not have
    // implicitly created an index file — building the index stays an
    // explicit, opt-in action (rebuildSearchIndex was never called here).
    expect(await indexExists(kb.bundle)).toBe(false);
  });

  it("falls back to the scan when the index file is corrupt", async () => {
    await seedBundle();
    await kb.rebuildSearchIndex();

    const file = indexPath(kb.bundle);
    await fs.writeFile(file, "not a sqlite file", "utf-8");

    const indexed = await tryIndexedSearch(kb.bundle, "web");
    expect(indexed).toBeUndefined();

    const hits = await kb.search("web");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("ensureBundleGitignore: adds a .prism/ entry idempotently, preserving existing content", async () => {
    await seedBundle();
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf-8");

    await kb.rebuildSearchIndex();
    let gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules/");
    let occurrences = gitignore.split("\n").filter((l) => l.trim() === ".prism/").length;
    expect(occurrences).toBe(1);

    await kb.rebuildSearchIndex();
    gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    occurrences = gitignore.split("\n").filter((l) => l.trim() === ".prism/").length;
    expect(occurrences).toBe(1);
  });

  it("matches search.ts's 'unknown' type default for a concept missing a type field", async () => {
    await seedBundle();
    // Bypass Bundle.writeConcept's type-required validation to simulate a
    // hand-authored or legacy file missing a type — permissive parsing
    // (spec §9) must still surface it identically in both search paths.
    const raw = "---\ntitle: Legacy Note\n---\n\nSome body mentioning zzzlegacy.\n";
    await fs.writeFile(path.join(root, "notes", "legacy.md"), raw, "utf-8");

    await kb.rebuildSearchIndex();

    const scanned = await searchBundle(kb.bundle, "zzzlegacy");
    const indexed = await tryIndexedSearch(kb.bundle, "zzzlegacy");
    expect(indexed).toEqual(scanned);
    expect(scanned[0]?.type).toBe("unknown");
  });

  it("the index file itself is invisible to bundle walking (dot-directory convention)", async () => {
    await seedBundle();
    await kb.rebuildSearchIndex();

    const paths = await kb.bundle.listConceptPaths();
    expect(paths.some((p) => p.includes(".prism"))).toBe(false);

    const tree = await kb.listTree();
    const names = tree.children?.map((c) => c.name) ?? [];
    expect(names).not.toContain(".prism");
  });
});
