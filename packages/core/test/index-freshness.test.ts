import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, startIndexWatcher, classifyWatchEvent, type IndexWatcher, type ReconcileReport } from "../src/okf/index.js";
import { tryIndexedSearch } from "../src/okf/search-index.js";
import { searchBundle } from "../src/okf/search.js";

let root: string;
let kb: KnowledgeBase;
let watcher: IndexWatcher | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-freshness-test-"));
  kb = new KnowledgeBase(root);
  watcher = undefined;
});

afterEach(async () => {
  watcher?.stop();
  await fs.rm(root, { recursive: true, force: true });
});

const doc = (title: string, body: string) => `---\ntype: Note\ntitle: ${title}\n---\n${body}\n`;
const indexedPaths = async (q: string) => (await tryIndexedSearch(kb.bundle, q))?.map((h) => h.path) ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await pred()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

// PRISM-36 acceptance criteria:
// 1. Editing a concept in an external editor makes it searchable without restarting Prism.
// 2. A git checkout of many files produces one debounced reindex.
// 3. Changes made while the process was stopped are picked up at startup.

describe("reconcileSearchIndex", () => {
  it("is a no-op without an index (search scans the files and is never stale)", async () => {
    await fs.writeFile(path.join(root, "a.md"), doc("A", "x"));
    const r = await kb.reconcileSearchIndex();
    expect(r.indexed).toBe(false);
    expect((await kb.indexStatus()).stale).toBe(false);
  });

  it("adds, updates and removes out-of-band changes; unchanged files are never rewritten", async () => {
    await kb.writeConcept("/keep.md", { type: "Note", title: "Keep" }, "steady", "add");
    await kb.writeConcept("/edit.md", { type: "Note", title: "Edit" }, "before", "add");
    await kb.writeConcept("/gone.md", { type: "Note", title: "Gone" }, "bye", "add");
    await kb.rebuildSearchIndex();

    await fs.writeFile(path.join(root, "new.md"), doc("New", "handwritten zebra"));
    const editRaw = await fs.readFile(path.join(root, "edit.md"), "utf-8");
    await fs.writeFile(path.join(root, "edit.md"), editRaw.replace("before", "after giraffe"));
    await fs.rm(path.join(root, "gone.md"));

    // Stale before reconcile: the index still believes the old world.
    expect(await indexedPaths("zebra")).toEqual([]);
    expect(await indexedPaths("bye")).toEqual(["/gone.md"]);
    const status = await kb.indexStatus();
    expect(status).toMatchObject({ indexed: true, stale: true, pending_changes: 3 });

    const r = await kb.reconcileSearchIndex();
    expect(r).toMatchObject({ indexed: true, added: ["/new.md"], updated: ["/edit.md"], removed: ["/gone.md"], unchanged: 1 });
    expect(await indexedPaths("zebra")).toEqual(["/new.md"]);
    expect(await indexedPaths("giraffe")).toEqual(["/edit.md"]);
    expect(await indexedPaths("bye")).toEqual([]);

    // Now fresh, and a second pass changes nothing.
    expect((await kb.indexStatus()).stale).toBe(false);
    const again = await kb.reconcileSearchIndex();
    expect(again.added.length + again.updated.length + again.removed.length).toBe(0);
    expect(again.unchanged).toBe(3);
  });

  it("after reconcile, indexed search matches a fresh scan exactly", async () => {
    await kb.writeConcept("/a.md", { type: "Note", title: "Alpha" }, "one", "add");
    await kb.rebuildSearchIndex();
    await fs.mkdir(path.join(root, "deep", "er"), { recursive: true });
    await fs.writeFile(path.join(root, "deep", "er", "b.md"), doc("Beta", "two [Alpha](/a.md)"));
    await kb.reconcileSearchIndex();
    for (const q of ["alpha", "beta", "two", ""]) {
      expect(await tryIndexedSearch(kb.bundle, q)).toEqual(await searchBundle(kb.bundle, q));
    }
  });

  it("targeted reconcile only looks at the given paths", async () => {
    await kb.writeConcept("/a.md", { type: "Note" }, "x", "add");
    await kb.rebuildSearchIndex();
    await fs.writeFile(path.join(root, "b.md"), doc("B", "bee"));
    await fs.writeFile(path.join(root, "c.md"), doc("C", "sea"));
    const r = await kb.reconcileSearchIndex({ paths: ["/b.md"] });
    expect(r.added).toEqual(["/b.md"]);
    expect(await indexedPaths("sea")).toEqual([]);
  });

  it("leaves an unparseable (mid-save) file's old row alone", async () => {
    await kb.writeConcept("/a.md", { type: "Note", title: "Alpha" }, "one", "add");
    await kb.rebuildSearchIndex();
    await fs.writeFile(path.join(root, "a.md"), "---\ntype: [broken\n---\nhalf-writ");
    const r = await kb.reconcileSearchIndex();
    expect(r.updated).toEqual([]);
    expect(await indexedPaths("alpha")).toEqual(["/a.md"]);
  });
});

describe("classifyWatchEvent", () => {
  it("maps concept files, ignores Prism's own and hidden files, and escalates the unattributable", () => {
    expect(classifyWatchEvent(path.join("emea", "a.md"))).toBe("/emea/a.md");
    expect(classifyWatchEvent("index.md")).toBeNull();
    expect(classifyWatchEvent(path.join("emea", "log.md"))).toBeNull();
    expect(classifyWatchEvent(path.join(".prism", "search.sqlite3-wal"))).toBeNull();
    expect(classifyWatchEvent(path.join(".git", "index"))).toBeNull();
    expect(classifyWatchEvent(path.join("emea", ".a.md.swp"))).toBeNull();
    expect(classifyWatchEvent("emea")).toBe("full");
    expect(classifyWatchEvent(null)).toBe("full");
  });
});

describe("startIndexWatcher", () => {
  it("AC3: startup reconcile picks up changes made while Prism was stopped", async () => {
    await kb.writeConcept("/a.md", { type: "Note" }, "x", "add");
    await kb.rebuildSearchIndex();
    // "Process down": edit files with nothing watching.
    await fs.writeFile(path.join(root, "offline.md"), doc("Offline", "written while stopped"));
    const reports: [ReconcileReport, string][] = [];
    watcher = await startIndexWatcher(kb, { watch: false, pollIntervalMs: 60_000, log: () => {}, onReconcile: (r, t) => reports.push([r, t]) });
    expect(reports[0][1]).toBe("startup");
    expect(reports[0][0].added).toEqual(["/offline.md"]);
    expect(await indexedPaths("stopped")).toEqual(["/offline.md"]);
    expect((await kb.indexStatus()).watcher).toBe("poll");
  });

  it("AC1: an external edit becomes searchable without a restart", async () => {
    await kb.writeConcept("/a.md", { type: "Note", title: "Alpha" }, "one", "add");
    await kb.rebuildSearchIndex();
    watcher = await startIndexWatcher(kb, { debounceMs: 100, safetyIntervalMs: 0, log: () => {} });
    expect(watcher.mode).toBe("watch");
    expect((await kb.indexStatus()).watcher).toBe("watch");

    await fs.writeFile(path.join(root, "a.md"), doc("Alpha", "now mentions okapi"));
    await waitFor(async () => (await indexedPaths("okapi"))?.[0] === "/a.md");

    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", "fresh.md"), doc("Fresh", "a narwhal note"));
    await waitFor(async () => (await indexedPaths("narwhal"))?.[0] === "/notes/fresh.md");

    await fs.rm(path.join(root, "notes", "fresh.md"));
    await waitFor(async () => (await indexedPaths("narwhal"))?.length === 0);
  });

  it("AC2: a burst of many file changes (a git checkout) produces one debounced reconcile", async () => {
    await kb.writeConcept("/seed.md", { type: "Note" }, "x", "add");
    await kb.rebuildSearchIndex();
    const reports: ReconcileReport[] = [];
    watcher = await startIndexWatcher(kb, {
      debounceMs: 300,
      maxWaitMs: 10_000,
      safetyIntervalMs: 0,
      log: () => {},
      onReconcile: (r, t) => {
        if (t === "watch") reports.push(r);
      },
    });
    await fs.mkdir(path.join(root, "checkout"), { recursive: true });
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => fs.writeFile(path.join(root, "checkout", `c${i}.md`), doc(`C${i}`, `bulk ${i}`)))
    );
    await waitFor(() => reports.length > 0);
    await sleep(600); // give any straggling second flush the chance to happen
    expect(reports).toHaveLength(1);
    expect(reports[0].added.length).toBe(60);
    expect((await tryIndexedSearch(kb.bundle, "bulk"))?.length).toBe(20); // default limit, all indexed
  });

  it("in-band writes don't cause redundant index rewrites via the watcher", async () => {
    await kb.writeConcept("/a.md", { type: "Note" }, "x", "add");
    await kb.rebuildSearchIndex();
    const reports: ReconcileReport[] = [];
    watcher = await startIndexWatcher(kb, {
      debounceMs: 100,
      safetyIntervalMs: 0,
      log: () => {},
      onReconcile: (r, t) => {
        if (t === "watch") reports.push(r);
      },
    });
    await kb.writeConcept("/b.md", { type: "Note", title: "Bee" }, "in band", "add");
    await sleep(500);
    await watcher.flush();
    const changed = reports.reduce((n, r) => n + r.added.length + r.updated.length + r.removed.length, 0);
    expect(changed).toBe(0); // afterMutation already indexed it; the watcher saw an identical hash
    expect(await indexedPaths("band")).toEqual(["/b.md"]);
  });
});
