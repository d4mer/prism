import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { tryIndexedSearch, indexExists } from "../src/okf/search-index.js";
import { runReindexCli } from "../src/agent/reindex-cli.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prism35-reindex-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-35 contract: "A rebuild command that wipes and repopulates from the
// markdown files alone." This is that command's operator-facing entry point.
describe("prism reindex", () => {
  it("builds an index from the markdown alone and reports how many concepts it holds", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/a.md", { type: "Note", title: "Alpha" }, "one", "add");
    await kb.writeConcept("/b/c.md", { type: "Note", title: "Beta" }, "two", "add");
    expect(await indexExists(kb.bundle)).toBe(false);

    const out = await runReindexCli([root]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.output)).toMatchObject({ reindexed: 2 });
    expect((await tryIndexedSearch(kb.bundle, "beta"))?.map((h) => h.path)).toEqual(["/b/c.md"]);
  });

  it("wipes stale rows: a file removed behind the index's back is gone after a reindex, and a second run changes nothing", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/a.md", { type: "Note", title: "Alpha" }, "one", "add");
    await kb.writeConcept("/b.md", { type: "Note", title: "Beta" }, "two", "add");
    await runReindexCli([root]);
    await fs.rm(path.join(root, "b.md"));
    expect((await tryIndexedSearch(kb.bundle, "beta"))?.length).toBe(1); // stale on purpose

    await runReindexCli([root]);
    expect((await tryIndexedSearch(kb.bundle, "beta"))?.length).toBe(0);
    const first = await kb.search("alpha");
    await runReindexCli([root]);
    expect(await kb.search("alpha")).toEqual(first);
  });

  it("fails clearly on bad arguments and bad paths, with exit code 2", async () => {
    for (const argv of [[], ["a", "b"], ["--nope", root], [path.join(root, "missing")]]) {
      const out = await runReindexCli(argv);
      expect(out.exitCode, JSON.stringify(argv)).toBe(2);
      expect(JSON.parse(out.output).error).toBeTruthy();
    }
    await fs.writeFile(path.join(root, "file.txt"), "x");
    expect((await runReindexCli([path.join(root, "file.txt")])).exitCode).toBe(2);
  });

  it("waits for a held write lock instead of pulling the index out from under a writer", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/a.md", { type: "Note" }, "one", "add");
    const { acquireLock } = await import("../src/okf/index.js");
    const held = await acquireLock(kb.bundle, "write", { log: () => {} });
    let finished = false;
    const pending = runReindexCli([root]).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished, "reindex ran while another process held the write lock").toBe(false);
    await held.release();
    expect((await pending).exitCode).toBe(0);
  });
});
