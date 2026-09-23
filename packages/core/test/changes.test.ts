import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, resolveSince, inScope, normalizeScope } from "../src/okf/index.js";
import { changesSinceTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-changes-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Rewrite a concept's write-time stamp, simulating one last touched long ago. */
async function backdate(bundlePath: string, iso: string) {
  const abs = path.join(root, bundlePath);
  const raw = await fs.readFile(abs, "utf-8");
  await fs.writeFile(abs, raw.replace(/^timestamp: .*$/m, `timestamp: '${iso}'`), "utf-8");
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// PRISM-53 acceptance criteria:
// 1. Written after `since` appears; last written before it does not.
// 2. Superseded concept reported as superseded, pointing at its replacement.
// 3. A deletion logged after `since` is reported.
// 4. `scope` restricts results to that subtree.

describe("resolveSince", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("accepts relative windows in hours, days and weeks", () => {
    expect(resolveSince("24h", now).toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(resolveSince("7d", now).toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect(resolveSince("2w", now).toISOString()).toBe("2026-09-09T12:00:00.000Z");
  });
  it("accepts ISO dates and date-times, rejects anything else clearly", () => {
    expect(resolveSince("2026-09-01", now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(resolveSince("2026-09-01T09:30:00Z", now).toISOString()).toBe("2026-09-01T09:30:00.000Z");
    expect(() => resolveSince("last tuesday", now)).toThrow(/Invalid "since"/);
    expect(() => resolveSince("2026-02-30", now)).toThrow(/Invalid "since"/);
  });
});

describe("scope helpers", () => {
  it("normalizes and matches directory-aligned, with no sibling-prefix bleed", () => {
    expect(normalizeScope("/emea/cmo/")).toBe("/emea/cmo");
    expect(normalizeScope("/")).toBeUndefined();
    expect(() => normalizeScope("/../x")).toThrow();
    expect(inScope("/clients/acme/a.md", "/clients/acme")).toBe(true);
    expect(inScope("/clients/acme-corp/a.md", "/clients/acme")).toBe(false);
    expect(inScope("/anything.md", undefined)).toBe(true);
  });
});

describe("KnowledgeBase.changesSince", () => {
  it("AC1: reports what was written in the window and omits what was not", async () => {
    await kb.writeConcept("/old.md", { type: "Note", title: "Old" }, "x", "Added [Old](/old.md).");
    await backdate("/old.md", "2026-01-15T10:00:00.000Z");
    await kb.writeConcept("/new.md", { type: "Note", title: "New" }, "y", "Added [New](/new.md).");

    const report = await kb.changesSince("2026-06-01");
    expect(report.changes.map((c) => c.path)).toEqual(["/new.md"]);
    expect(report.changes[0]).toMatchObject({ kind: "created", title: "New", type: "Note", timestamp_source: "frontmatter" });
    expect(report.counts.created).toBe(1);

    // A window starting tomorrow contains nothing.
    const none = await kb.changesSince(tomorrow());
    expect(none.changes).toEqual([]);
  });

  it("distinguishes created vs changed from log.md evidence", async () => {
    await kb.writeConcept("/a.md", { type: "Note" }, "a", "Added [A](/a.md).");
    // Created and then edited inside the same window: still "created" — it is new.
    await kb.writeConcept("/b.md", { type: "Note" }, "b", "Added [B](/b.md).");
    await kb.patchConcept("/b.md", { frontmatter: { title: "B2" } }, "Retitled [B](/b.md).");
    // A log summary that never links the path: created-vs-updated is unknowable.
    await kb.writeConcept("/c.md", { type: "Note" }, "c", "no link in this summary");

    const kinds = Object.fromEntries((await kb.changesSince("24h")).changes.map((c) => [c.path, c.kind]));
    expect(kinds).toEqual({ "/a.md": "created", "/b.md": "created", "/c.md": "changed" });
  });

  it("reports an update when the concept pre-dates the window's log", async () => {
    await kb.writeConcept("/d.md", { type: "Note" }, "d", "Added [D](/d.md).");
    // Rewrite log.md so the creation is recorded on an old date.
    const logPath = path.join(root, "log.md");
    const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(logPath, (await fs.readFile(logPath, "utf-8")).replace(`## ${today}`, "## 2026-01-02"), "utf-8");
    await kb.patchConcept("/d.md", { frontmatter: { title: "D" } }, "Retitled [D](/d.md).");
    const report = await kb.changesSince(today);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ path: "/d.md", kind: "updated" });
  });

  it("AC2: a superseded concept is reported as superseded, pointing at its replacement", async () => {
    await kb.writeConcept("/policy-v1.md", { type: "Decision", title: "Dynamic SS" }, "v1", "Added [v1](/policy-v1.md).");
    await kb.supersede("/policy-v1.md", "/policy-v2.md", { type: "Decision", title: "Fixed banding" }, "v2", "");
    const report = await kb.changesSince("24h");
    const byPath = Object.fromEntries(report.changes.map((c) => [c.path, c]));
    expect(byPath["/policy-v1.md"]).toMatchObject({ kind: "superseded", superseded_by: "/policy-v2.md" });
    expect(byPath["/policy-v2.md"].kind).toBe("created");
    expect(report.counts.superseded).toBe(1);
  });

  it("AC3: a deletion logged in the window is reported with its path", async () => {
    await kb.writeConcept("/gone.md", { type: "Note" }, "x", "Added [Gone](/gone.md).");
    await kb.deleteConcept("/gone.md", "Removed [Gone](/gone.md) — duplicate.");
    const report = await kb.changesSince("7d");
    expect(report.deleted).toHaveLength(1);
    expect(report.deleted[0]).toMatchObject({ path: "/gone.md" });
    expect(report.counts.deleted).toBe(1);
    expect((await kb.changesSince(tomorrow())).deleted).toEqual([]);
  });

  it("AC4: scope restricts changes and deletions to the subtree, directory-aligned", async () => {
    await kb.writeConcept("/emea/cmo/a.md", { type: "Note" }, "a", "Added [a](/emea/cmo/a.md).");
    await kb.writeConcept("/emea/l2l/b.md", { type: "Note" }, "b", "Added [b](/emea/l2l/b.md).");
    await kb.writeConcept("/emea-archive/c.md", { type: "Note" }, "c", "Added [c](/emea-archive/c.md).");
    await kb.writeConcept("/latam/d.md", { type: "Note" }, "d", "Added [d](/latam/d.md).");
    await kb.deleteConcept("/latam/d.md", "Removed [d](/latam/d.md).");

    const emea = await kb.changesSince("7d", { scope: "/emea" });
    expect(emea.changes.map((c) => c.path).sort()).toEqual(["/emea/cmo/a.md", "/emea/l2l/b.md"]);
    expect(emea.deleted).toEqual([]);
    const latam = await kb.changesSince("7d", { scope: "/latam/" });
    expect(latam.changes).toEqual([]);
    expect(latam.deleted.map((d) => d.path)).toEqual(["/latam/d.md"]);
    // A scope that doesn't exist is simply empty, not an error.
    expect((await kb.changesSince("7d", { scope: "/apac" })).changes).toEqual([]);
  });

  it("falls back to file mtime for hand-authored concepts without a timestamp", async () => {
    await fs.writeFile(path.join(root, "hand.md"), "---\ntype: Note\ntitle: Hand\n---\nwritten in an editor\n", "utf-8");
    const report = await kb.changesSince("1h");
    expect(report.changes[0]).toMatchObject({ path: "/hand.md", kind: "changed", timestamp_source: "mtime" });
  });

  it("orders newest first and truncates with complete counts", async () => {
    for (const n of [1, 2, 3]) await kb.writeConcept(`/n${n}.md`, { type: "Note" }, "x", `Added [n](/n${n}.md).`);
    await backdate("/n1.md", "2026-09-01T00:00:00.000Z");
    await backdate("/n2.md", "2026-09-02T00:00:00.000Z");
    await backdate("/n3.md", "2026-09-03T00:00:00.000Z");
    const report = await kb.changesSince("2026-08-01", { limit: 2 });
    expect(report.changes.map((c) => c.path)).toEqual(["/n3.md", "/n2.md"]);
    expect(report.truncated).toBe(true);
    expect(report.counts.created).toBe(3);
  });
});

describe("changes_since registry tool", () => {
  it("round-trips through schema and handler", async () => {
    await kb.capture({ text: "Cutover risks" });
    const out = await changesSinceTool.handler(kb, changesSinceTool.inputSchema.parse({ since: "24h" }));
    expect(out.counts.created).toBe(1);
    expect(out.changes[0].path).toMatch(/^\/inbox\//);
  });

  it("surfaces a bad window as a clear error", async () => {
    await expect(changesSinceTool.handler(kb, { since: "yesterday-ish" })).rejects.toThrow(/Invalid "since"/);
  });
});
