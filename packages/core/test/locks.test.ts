import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  KnowledgeBase,
  Bundle,
  acquireLock,
  withMaintenanceLock,
  LockBusyError,
  lockDir,
  contentVersion,
} from "../src/okf/index.js";
import { runMaintainCli } from "../src/agent/maintain-cli.js";
import { conceptReadTool, conceptWriteTool, conceptPatchTool, linkAddTool } from "../src/registry/index.js";

const run = promisify(execFile);
const FIXTURES = path.resolve(__dirname, "fixtures");
let root: string;
let bundle: Bundle;
let kb: KnowledgeBase;
const children: ChildProcess[] = [];
const quiet = { log: () => {} };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-locks-test-"));
  bundle = new Bundle(root);
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await fs.rm(root, { recursive: true, force: true });
});

/** Start a child that holds `name` for holdMs (<0 = until killed); resolves once it holds it. */
function holdInChild(name: string, holdMs: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--no-warnings", path.join(FIXTURES, "lock-holder.mjs"), root, name, String(holdMs)]);
    children.push(child);
    child.stdout.on("data", (d) => String(d).includes("locked") && resolve(child));
    child.on("error", reject);
    child.on("exit", (code) => code !== 0 && reject(new Error(`holder exited ${code}`)));
  });
}

describe("acquireLock", () => {
  it("is exclusive: a second acquire is busy and names the holder; release frees it", async () => {
    const a = await acquireLock(bundle, "maintain", { purpose: "first", ...quiet });
    const err = await acquireLock(bundle, "maintain", quiet).catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect(err.holder).toMatchObject({ pid: process.pid, purpose: "first", host: os.hostname() });
    await a.release();
    const b = await acquireLock(bundle, "maintain", quiet);
    await b.release();
    expect(await fs.readdir(lockDir(bundle))).toEqual([]);
  });

  it("waits for a lock that is released within waitMs", async () => {
    const a = await acquireLock(bundle, "write", quiet);
    setTimeout(() => void a.release(), 150);
    const b = await acquireLock(bundle, "write", { waitMs: 3000, ...quiet });
    expect(b.holder.token).not.toBe(a.holder.token);
    await b.release();
  });

  it("takes over a lock whose heartbeat is older than staleMs (e.g. a crashed run on another host)", async () => {
    await fs.mkdir(lockDir(bundle), { recursive: true });
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await fs.writeFile(
      path.join(lockDir(bundle), "maintain.lock"),
      JSON.stringify({ pid: 1, host: "some-other-host", purpose: "crashed", started_at: old, heartbeat_at: old, token: "t-old" })
    );
    const logs: string[] = [];
    const h = await acquireLock(bundle, "maintain", { log: (m) => logs.push(m) });
    expect(logs.some((l) => /taken over from pid 1 on some-other-host: no heartbeat/.test(l))).toBe(true);
    await h.release();
  });

  it("does NOT take over a fresh lock from another host (pid can't be checked there)", async () => {
    await fs.mkdir(lockDir(bundle), { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(lockDir(bundle), "maintain.lock"),
      JSON.stringify({ pid: 1, host: "some-other-host", purpose: "live elsewhere", started_at: now, heartbeat_at: now, token: "t" })
    );
    await expect(acquireLock(bundle, "maintain", quiet)).rejects.toBeInstanceOf(LockBusyError);
  });

  it("heartbeats keep a long-held lock fresh", async () => {
    const h = await acquireLock(bundle, "maintain", { heartbeatMs: 50, ...quiet });
    const first = h.holder.heartbeat_at;
    await new Promise((r) => setTimeout(r, 200));
    const onDisk = JSON.parse(await fs.readFile(path.join(lockDir(bundle), "maintain.lock"), "utf-8"));
    expect(Date.parse(onDisk.heartbeat_at)).toBeGreaterThan(Date.parse(first));
    // ...so a short staleMs still sees it as live.
    await expect(acquireLock(bundle, "maintain", { staleMs: 150, ...quiet })).rejects.toBeInstanceOf(LockBusyError);
    await h.release();
  });

  it("release never deletes a lock that now belongs to someone else", async () => {
    const h = await acquireLock(bundle, "write", quiet);
    const file = path.join(lockDir(bundle), "write.lock");
    const now = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify({ pid: 2, host: "x", purpose: "other", started_at: now, heartbeat_at: now, token: "theirs" }));
    await h.release();
    expect(JSON.parse(await fs.readFile(file, "utf-8")).token).toBe("theirs");
  });
});

describe("PRISM-27 acceptance criteria", () => {
  it("AC2: a killed maintenance process does not block future runs", async () => {
    const child = await holdInChild("maintain", -1);
    await expect(acquireLock(bundle, "maintain", quiet)).rejects.toBeInstanceOf(LockBusyError);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const logs: string[] = [];
    const h = await acquireLock(bundle, "maintain", { log: (m) => logs.push(m) });
    expect(logs.join("\n")).toMatch(new RegExp(`taken over from pid ${child.pid} .*no longer running`));
    await h.release();
  });

  it("AC3: two maintenance runs cannot execute simultaneously (in-process and across processes)", async () => {
    let inside = 0;
    let maxInside = 0;
    const job = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 200));
      inside--;
      return "done";
    };
    const results = await Promise.all([
      withMaintenanceLock(bundle, "a", job, quiet),
      withMaintenanceLock(bundle, "b", job, quiet),
    ]);
    expect(maxInside).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    const skipped = results.find((r) => !r.ran);
    expect(skipped && !skipped.ran && skipped.holder?.purpose).toMatch(/^[ab]$/);

    // A `prism maintain` while another PROCESS holds the lock: skipped, exit 0, holder reported.
    const child = await holdInChild("maintain", -1);
    const out = await runMaintainCli([root, "--only=repair"]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.output)).toMatchObject({ skipped: true, holder: { pid: child.pid } });
    // A dry-run only reads, so it runs regardless.
    const dry = await runMaintainCli([root, "--only=repair", "--dry-run"]);
    expect(JSON.parse(dry.output).skipped).toBeUndefined();
  });

  it(
    "AC1: interleaved writers in three processes leave a conformant bundle with no lost writes",
    async () => {
      const N = 40;
      const writer = path.join(FIXTURES, "writer-child.mjs");
      await Promise.all([
        run("node", ["--no-warnings", writer, root, "maint", String(N)]),
        run("node", ["--no-warnings", writer, root, "other", String(N)]),
        ...Array.from({ length: N }, (_, i) =>
          kb.writeConcept(`/live/c${i}.md`, { type: "Note" }, "live", `Added [l](/live/c${i}.md).`)
        ),
      ]);
      const log = await kb.readLog();
      expect(log).toHaveLength(3 * N); // before PRISM-27: 109–119 of 120
      for (const dir of ["maint", "other", "live"]) {
        const files = (await fs.readdir(path.join(root, dir))).filter((f) => f !== "index.md");
        expect(files).toHaveLength(N);
        const index = await fs.readFile(path.join(root, dir, "index.md"), "utf-8");
        for (const f of files) expect(index).toContain(`(${f})`);
      }
      const report = await kb.validate();
      expect(report.conformant).toBe(true);
      expect(await fs.readdir(lockDir(bundle))).toEqual([]); // every write lock released
    },
    60_000
  );

  it("a live write waits out a briefly-held write lock, and fails loudly (LOCKED, nothing written) if it can't get it", async () => {
    await holdInChild("write", 400);
    const t0 = Date.now();
    await kb.writeConcept("/waited.md", { type: "Note" }, "x", "add");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);

    await holdInChild("write", -1);
    const impatient = new KnowledgeBase(root, { writeLockWaitMs: 200 });
    await expect(impatient.writeConcept("/blocked.md", { type: "Note" }, "x", "add")).rejects.toMatchObject({ code: "LOCKED" });
    await expect(fs.access(path.join(root, "blocked.md"))).rejects.toThrow();
  });
});

describe("lost-update guard (optimistic concurrency)", () => {
  it("an agent-style run cannot overwrite a concept someone else changed after it was read", async () => {
    await kb.writeConcept("/policy.md", { type: "Decision", title: "Policy" }, "original", "add");
    const ctx = { readVersions: new Map<string, string>() };
    const seen = await conceptReadTool.handler(kb, { path: "/policy.md" }, ctx);

    // Meanwhile a live writer edits it.
    await kb.patchConcept("/policy.md", { replaceBody: "LIVE EDIT from the workshop" }, "live edit");

    // The run now tries to write its rewrite based on the stale read.
    await expect(
      conceptWriteTool.handler(
        kb,
        { path: "/policy.md", frontmatter: { type: "Decision", title: "Policy" }, body: seen.body + " (tidied)", log_summary: "tidy" },
        ctx
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await kb.readConcept("/policy.md")).body).toContain("LIVE EDIT");

    // Re-read, re-apply: succeeds, and the live edit is preserved in the result.
    const fresh = await conceptReadTool.handler(kb, { path: "/policy.md" }, ctx);
    await conceptPatchTool.handler(kb, { path: "/policy.md", replace_body: fresh.body.trim() + " (tidied)", log_summary: "tidy" }, ctx);
    expect((await kb.readConcept("/policy.md")).body).toContain("LIVE EDIT from the workshop (tidied)");
    // Its own consecutive writes don't conflict with themselves.
    await conceptPatchTool.handler(kb, { path: "/policy.md", frontmatter: { status: "open" }, log_summary: "x" }, ctx);
  });

  it("callers without a read history (MCP/REST single calls) behave exactly as before", async () => {
    await kb.writeConcept("/a.md", { type: "Note" }, "one", "add");
    await kb.patchConcept("/a.md", { replaceBody: "two" }, "edit");
    await conceptWriteTool.handler(kb, { path: "/a.md", frontmatter: { type: "Note" }, body: "three", log_summary: "x" });
    expect((await kb.readConcept("/a.md")).body.trim()).toBe("three");
  });

  it("KnowledgeBase guard: stale version -> CONFLICT and nothing written; deleted file -> CONFLICT", async () => {
    const c = await kb.writeConcept("/g.md", { type: "Note" }, "v1", "add");
    const v1 = contentVersion(c.raw);
    await kb.patchConcept("/g.md", { replaceBody: "v2" }, "edit");
    await expect(kb.patchConcept("/g.md", { replaceBody: "v3" }, "x", { expectedVersion: v1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await kb.readConcept("/g.md")).body.trim()).toBe("v2");
    const v2 = contentVersion((await kb.readConcept("/g.md")).raw);
    await kb.deleteConcept("/g.md", "gone");
    await expect(kb.writeConcept("/g.md", { type: "Note" }, "v3", "x", { expectedVersion: v2 })).rejects.toThrow(/deleted by another writer/);
  });

  it("link_add guards its own read-modify-write of the source concept", async () => {
    await kb.writeConcept("/src.md", { type: "Note" }, "source body", "add");
    await kb.writeConcept("/tgt.md", { type: "Note", title: "Target" }, "t", "add");
    // Simulate a write landing between link_add's read and its patch by
    // racing many live edits against many link_adds; no live edit may vanish.
    const edits = Array.from({ length: 10 }, (_, i) =>
      kb.patchConcept("/src.md", { frontmatter: { [`k${i}`]: i } }, `edit ${i}`)
    );
    const links = linkAddTool.handler(kb, { source: "/src.md", target: "/tgt.md", log_summary: "link" }).catch((e) => e);
    await Promise.all([...edits, links]);
    const final = await kb.readConcept("/src.md");
    for (let i = 0; i < 10; i++) expect(final.frontmatter[`k${i}`]).toBe(i);
    const outcome = await links;
    if (outcome instanceof Error) expect((outcome as { code?: string }).code).toBe("CONFLICT");
    else expect(final.body).toContain("[Target](/tgt.md)");
  });
});
