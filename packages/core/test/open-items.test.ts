import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { openItemsTool, conceptWriteTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;
const NOW = new Date("2026-09-23T10:00:00Z");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-open-items-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-56 acceptance criteria:
// 1. An item with a past `due` and status open is flagged overdue and sorts first.
// 2. Closed/decided items are excluded by default.
// 3. Invalid status or due values are rejected on write.

async function seed() {
  const w = (p: string, fm: Record<string, unknown>) => kb.writeConcept(p, { type: "Action", ...fm }, "body", "add");
  await w("/emea/confirm-freeze.md", { title: "Confirm CMO freeze window", status: "open", owner: "Priya S.", due: "2026-10-01" });
  await w("/emea/sign-off-banding.md", { title: "Sign off fixed banding", status: "blocked", owner: "Client IT", due: "2026-09-10" });
  await w("/emea/very-late.md", { title: "Very late", status: "in_progress", owner: "Jim", due: "2026-09-01" });
  await w("/latam/lead-times.md", { title: "Collect LATAM lead times", status: "open", owner: "priya" });
  await w("/emea/done.md", { title: "Done thing", status: "closed", owner: "Jim", due: "2026-08-01" });
  await w("/emea/decided.md", { title: "Decided thing", status: "decided", due: "2026-08-01" });
  await w("/emea/not-an-item.md", { title: "Just a note", due: "2026-01-01" });
}

describe("KnowledgeBase.openItems", () => {
  it("AC1: overdue items are flagged and sort first (most overdue first), then by due, undated last", async () => {
    await seed();
    const { items, counts } = await kb.openItems({ now: NOW });
    expect(items.map((i) => i.path)).toEqual([
      "/emea/very-late.md",
      "/emea/sign-off-banding.md",
      "/emea/confirm-freeze.md",
      "/latam/lead-times.md",
    ]);
    expect(items[0]).toMatchObject({ overdue: true, days_overdue: 22, status: "in_progress", owner: "Jim" });
    expect(items[1]).toMatchObject({ overdue: true, days_overdue: 13 });
    expect(items[2]).toMatchObject({ overdue: false, due: "2026-10-01" });
    expect(items[2].days_overdue).toBeUndefined();
    expect(counts).toEqual({ total: 4, overdue: 2, by_status: { in_progress: 1, blocked: 1, open: 2 } });
  });

  it("AC2: decided/closed excluded by default, included when asked for; a concept without status is never an item", async () => {
    await seed();
    const all = (await kb.openItems({ now: NOW })).items.map((i) => i.path);
    expect(all).not.toContain("/emea/done.md");
    expect(all).not.toContain("/emea/decided.md");
    expect(all).not.toContain("/emea/not-an-item.md");
    const resolved = await kb.openItems({ now: NOW, status: ["closed", "decided"] });
    expect(resolved.items.map((i) => i.path).sort()).toEqual(["/emea/decided.md", "/emea/done.md"]);
    // A resolved item is never overdue, even with a past due date.
    expect(resolved.items.every((i) => !i.overdue)).toBe(true);
  });

  it("filters by owner (case-insensitive substring), scope and overdue_only", async () => {
    await seed();
    expect((await kb.openItems({ now: NOW, owner: "PRIYA" })).items.map((i) => i.path)).toEqual([
      "/emea/confirm-freeze.md",
      "/latam/lead-times.md",
    ]);
    expect((await kb.openItems({ now: NOW, scope: "/latam" })).items.map((i) => i.path)).toEqual(["/latam/lead-times.md"]);
    expect((await kb.openItems({ now: NOW, overdueOnly: true })).items.map((i) => i.path)).toEqual([
      "/emea/very-late.md",
      "/emea/sign-off-banding.md",
    ]);
  });

  it("an item due today is not yet overdue", async () => {
    await kb.writeConcept("/t.md", { type: "Action", status: "open", due: "2026-09-23" }, "", "add");
    expect((await kb.openItems({ now: NOW })).items[0].overdue).toBe(false);
  });

  it("excludes superseded items (current beliefs only)", async () => {
    await kb.writeConcept("/q-v1.md", { type: "Question", status: "open", due: "2026-09-01" }, "v1", "add");
    await kb.supersede("/q-v1.md", "/q-v2.md", { type: "Question", status: "open", due: "2026-10-15" }, "v2", "");
    expect((await kb.openItems({ now: NOW })).items.map((i) => i.path)).toEqual(["/q-v2.md"]);
  });

  it("AC3: invalid status, owner or due is rejected on write; closing an item via patch works", async () => {
    await expect(kb.writeConcept("/x.md", { type: "A", status: "done" as never }, "", "x")).rejects.toThrow(/status/);
    await expect(kb.writeConcept("/x.md", { type: "A", status: "open", due: "next friday" }, "", "x")).rejects.toThrow(/due/);
    await expect(kb.writeConcept("/x.md", { type: "A", status: "open", due: "2026-02-30" }, "", "x")).rejects.toThrow(/due/);
    await expect(kb.writeConcept("/x.md", { type: "A", status: "open", owner: "  " }, "", "x")).rejects.toThrow(/owner/);
    expect(() =>
      conceptWriteTool.inputSchema.parse({ path: "/x.md", frontmatter: { type: "A", status: "done" }, body: "", log_summary: "x" })
    ).toThrow();

    await kb.writeConcept("/ok.md", { type: "A", status: "open" }, "", "add");
    await kb.patchConcept("/ok.md", { frontmatter: { status: "closed" } }, "closed");
    expect((await kb.openItems({ now: NOW })).items).toEqual([]);
  });

  it("tolerates hand-edited malformed items: skipped from the list, flagged by validate", async () => {
    await fs.writeFile(path.join(root, "hand.md"), "---\ntype: A\nstatus: someday\ndue: soon\n---\nx\n", "utf-8");
    expect((await kb.openItems({ now: NOW })).items).toEqual([]);
    const report = await kb.validate();
    const msgs = report.issues.filter((i) => i.path === "/hand.md" && i.severity === "warning").map((i) => i.message);
    expect(msgs.some((m) => /status/.test(m))).toBe(true);
    expect(msgs.some((m) => /due/.test(m))).toBe(true);
  });

  it("limit trims the list but counts stay complete", async () => {
    await seed();
    const r = await kb.openItems({ now: NOW, limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.counts.total).toBe(4);
  });
});

describe("open_items registry tool", () => {
  it("round-trips through schema and handler, with snake_case overdue_only", async () => {
    await kb.writeConcept("/late.md", { type: "Action", status: "open", due: "2000-01-01" }, "", "add");
    await kb.writeConcept("/fine.md", { type: "Action", status: "open", due: "2999-01-01" }, "", "add");
    const out = await openItemsTool.handler(kb, openItemsTool.inputSchema.parse({ overdue_only: true }));
    expect(out.items.map((i) => i.path)).toEqual(["/late.md"]);
    expect(() => openItemsTool.inputSchema.parse({ status: ["someday"] })).toThrow();
  });
});
