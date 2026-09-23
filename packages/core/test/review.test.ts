import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { reviewQueueTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-review-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function backdate(bundlePath: string, days: number) {
  const abs = path.join(root, bundlePath);
  const raw = await fs.readFile(abs, "utf-8");
  await fs.writeFile(abs, raw.replace(/^timestamp: .*$/m, `timestamp: '${daysAgo(days).toISOString()}'`), "utf-8");
}

const reasonsOf = (r: Awaited<ReturnType<KnowledgeBase["reviewQueue"]>>, p: string) =>
  r.entries.find((e) => e.path === p)?.reasons.map((x) => x.kind) ?? [];

describe("KnowledgeBase.reviewQueue", () => {
  it("flags overdue open items with owner and days in the detail", async () => {
    await kb.writeConcept("/emea/a.md", { type: "Action", status: "open", owner: "Priya", due: daysAgo(5).toISOString().slice(0, 10) }, "", "add");
    const r = await kb.reviewQueue();
    expect(reasonsOf(r, "/emea/a.md")).toEqual(["overdue"]);
    expect(r.entries[0].reasons[0].detail).toMatch(/open, due .* \(5d overdue\), owner Priya/);
  });

  it("flags inbox captures older than inbox_days as untriaged, but not fresh ones", async () => {
    const old = await kb.capture({ text: "Old thought", now: daysAgo(10) });
    const fresh = await kb.capture({ text: "Fresh thought" });
    const r = await kb.reviewQueue();
    expect(reasonsOf(r, old.path)).toEqual(["untriaged"]);
    expect(reasonsOf(r, fresh.path)).toEqual([]);
    expect(r.entries.find((e) => e.path === old.path)?.reasons[0].detail).toMatch(/inbox for 10d/);
    // Threshold is configurable.
    expect(reasonsOf(await kb.reviewQueue({ inboxDays: 30 }), old.path)).toEqual([]);
  });

  it("flags low confidence below the threshold", async () => {
    await kb.writeConcept("/x/low.md", { type: "Note", confidence: 0.3 }, "", "add");
    await kb.writeConcept("/x/ok.md", { type: "Note", confidence: 0.8 }, "", "add");
    const r = await kb.reviewQueue();
    expect(reasonsOf(r, "/x/low.md")).toEqual(["low_confidence"]);
    expect(reasonsOf(r, "/x/ok.md")).toEqual([]);
    expect(reasonsOf(await kb.reviewQueue({ minConfidence: 0.9 }), "/x/ok.md")).toEqual(["low_confidence"]);
  });

  it("stale only where the area moved on: old note in an active directory, not settled reference elsewhere", async () => {
    await kb.writeConcept("/emea/cmo/recent.md", { type: "Note" }, "", "add");
    await kb.writeConcept("/emea/cmo/old.md", { type: "Note", title: "Old CMO note" }, "", "add");
    await backdate("/emea/cmo/old.md", 120);
    await kb.writeConcept("/reference/glossary.md", { type: "Reference" }, "", "add");
    await backdate("/reference/glossary.md", 400);
    await kb.writeConcept("/emea/cmo/closed.md", { type: "Action", status: "closed" }, "", "add");
    await backdate("/emea/cmo/closed.md", 200);

    const r = await kb.reviewQueue();
    expect(reasonsOf(r, "/emea/cmo/old.md")).toEqual(["stale"]);
    expect(r.entries.find((e) => e.path === "/emea/cmo/old.md")?.reasons[0].detail).toMatch(/untouched for 120d while \/emea\/cmo has recent changes/);
    expect(reasonsOf(r, "/reference/glossary.md")).toEqual([]); // settled, nothing around it moved
    expect(reasonsOf(r, "/emea/cmo/closed.md")).toEqual([]); // closed: nothing left to do
    expect(reasonsOf(r, "/emea/cmo/recent.md")).toEqual([]);
  });

  it("ranks by summed reason weight, excludes superseded, respects scope, limit keeps counts", async () => {
    // overdue + low confidence (4+2) beats untriaged (3) beats low confidence alone (2)
    await kb.writeConcept("/emea/both.md", { type: "Action", status: "open", due: "2000-01-01", confidence: 0.2 }, "", "add");
    await kb.capture({ text: "Untriaged", now: daysAgo(20) });
    await kb.writeConcept("/latam/low.md", { type: "Note", confidence: 0.1 }, "", "add");
    await kb.writeConcept("/emea/old-belief.md", { type: "Note", confidence: 0.1 }, "", "add");
    await kb.supersede("/emea/old-belief.md", "/emea/new-belief.md", { type: "Note", confidence: 0.9 }, "", "");

    const r = await kb.reviewQueue();
    expect(r.entries.map((e) => e.priority)).toEqual([6, 3, 2]);
    expect(r.entries[0].path).toBe("/emea/both.md");
    expect(r.entries.map((e) => e.path)).not.toContain("/emea/old-belief.md");
    expect(r.counts).toEqual({ overdue: 1, untriaged: 1, low_confidence: 2, stale: 0, total: 3 });

    expect((await kb.reviewQueue({ scope: "/latam" })).entries.map((e) => e.path)).toEqual(["/latam/low.md"]);
    const limited = await kb.reviewQueue({ limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.counts.total).toBe(3);
  });

  it("an empty or healthy bundle has an empty queue", async () => {
    expect((await kb.reviewQueue()).entries).toEqual([]);
    await kb.writeConcept("/fine.md", { type: "Note", confidence: 1 }, "", "add");
    expect((await kb.reviewQueue()).counts.total).toBe(0);
  });
});

describe("review_queue registry tool", () => {
  it("maps snake_case options and rejects out-of-range values", async () => {
    await kb.writeConcept("/x.md", { type: "Note", confidence: 0.6 }, "", "add");
    const out = await reviewQueueTool.handler(kb, reviewQueueTool.inputSchema.parse({ min_confidence: 0.7 }));
    expect(out.entries.map((e) => e.path)).toEqual(["/x.md"]);
    expect(() => reviewQueueTool.inputSchema.parse({ min_confidence: 2 })).toThrow();
  });
});
