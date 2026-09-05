import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { runDream } from "../src/agent/dream.js";
import { parseMaintainArgs, runMaintainCli, exitCodeFor, USAGE } from "../src/agent/maintain-cli.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-maintain-cli-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-26 acceptance criteria, verbatim from the ticket:
// 1. A cron entry can run maintenance unattended against a bundle path.
// 2. A healthy graph produces a no-op with zero provider calls.
// 3. Dry-run output matches what a real run subsequently does.

describe("parseMaintainArgs", () => {
  it("parses a bare bundle path", () => {
    const parsed = parseMaintainArgs(["/some/bundle"]);
    expect(parsed).toEqual({ options: { bundlePath: "/some/bundle", dryRun: false, passes: undefined } });
  });

  it("parses --dry-run and --only= in any order", () => {
    const parsed = parseMaintainArgs(["--dry-run", "/some/bundle", "--only=repair"]);
    expect(parsed).toEqual({
      options: { bundlePath: "/some/bundle", dryRun: true, passes: ["repair"] },
    });
  });

  it("parses a comma-separated --only=", () => {
    const parsed = parseMaintainArgs(["/b", "--only=repair,consolidate"]);
    expect(parsed).toEqual({
      options: { bundlePath: "/b", dryRun: false, passes: ["repair", "consolidate"] },
    });
  });

  it("rejects a missing bundle path", () => {
    const parsed = parseMaintainArgs(["--dry-run"]);
    expect(parsed).toEqual({ error: USAGE });
  });

  it("rejects an unknown pass", () => {
    const parsed = parseMaintainArgs(["/b", "--only=bogus"]);
    expect("error" in parsed && parsed.error).toMatch(/Unknown pass "bogus"/);
  });

  it("rejects an unknown flag", () => {
    const parsed = parseMaintainArgs(["/b", "--verbose"]);
    expect("error" in parsed && parsed.error).toMatch(/Unknown flag: --verbose/);
  });

  it("rejects an unexpected extra positional argument", () => {
    const parsed = parseMaintainArgs(["/b", "/c"]);
    expect("error" in parsed && parsed.error).toMatch(/Unexpected extra argument/);
  });
});

describe("runMaintainCli", () => {
  it("AC1/AC2: a healthy bundle is a no-op with exit code 0", async () => {
    await kb.writeConcept(
      "/a.md",
      { type: "T", title: "Alpha", description: "first" },
      "See [B](/b.md).",
      "add a"
    );
    await kb.writeConcept(
      "/b.md",
      { type: "T", title: "Beta", description: "second" },
      "See [A](/a.md).",
      "add b"
    );

    const { exitCode, output } = await runMaintainCli([root]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output);
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/healthy/);
  });

  it("fails loudly (exit 2) on a missing bundle path rather than reporting a false no-op", async () => {
    const missing = path.join(root, "does-not-exist");
    const { exitCode, output } = await runMaintainCli([missing]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(output).error).toMatch(/not found/);
  });

  it("fails on bad arguments before touching any bundle", async () => {
    const { exitCode, output } = await runMaintainCli(["/b", "--only=bogus"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(output).error).toMatch(/Unknown pass/);
  });

  it("end-to-end --dry-run through the CLI exits 1 when signals are present, never calling the agent", async () => {
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub", description: "main" }, "core", "add");
    await kb.writeConcept("/stray.md", { type: "T", title: "Stray", description: "unconnected" }, "alone", "add");

    const { exitCode, output } = await runMaintainCli([root, "--dry-run"]);
    const report = JSON.parse(output);
    expect(report.dryRun).toBe(true);
    expect(report.signalCategories).toContain("orphans");
    expect(exitCode).toBe(1);
  });

  it("AC3: dry-run output matches what a real run subsequently does", async () => {
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub", description: "main" }, "core", "add");
    await kb.writeConcept("/stray.md", { type: "T", title: "Stray", description: "unconnected" }, "alone", "add");

    const dry = await runDream(kb, {}, vi.fn(), { dryRun: true });
    expect(dry.ran).toBe(false);
    expect(dry.dryRun).toBe(true);
    expect(dry.signalCategories).toContain("orphans");

    const runner = vi.fn(async () => ({
      summary: "wired stray into hub",
      filesChanged: ["/hub.md"],
      steps: 2,
      traceId: "t1",
    }));
    const real = await runDream(kb, {}, runner);
    expect(real.ran).toBe(true);
    // Same signal detection fired for both — dry-run's preview matches the real run's decision.
    expect(real.signalCategories).toEqual(dry.signalCategories);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("--only=repair runs the repair pass only, ignoring consolidation-only signals", async () => {
    // Duplicate-title pair (a consolidate-only signal) with no orphans/broken links.
    await kb.writeConcept(
      "/a.md",
      { type: "T", title: "Billing API rate limits", description: "100 requests per minute per client" },
      "See [B](/b.md).",
      "add a"
    );
    await kb.writeConcept(
      "/b.md",
      { type: "T", title: "API rate limits for billing", description: "per client limit of 100 requests per minute" },
      "See [A](/a.md).",
      "add b"
    );

    const repairOnly = await runDream(kb, {}, vi.fn(), { dryRun: true, passes: ["repair"] });
    expect(repairOnly.ran).toBe(false);
    expect(repairOnly.signalCategories).toEqual([]);

    const consolidateOnly = await runDream(kb, {}, vi.fn(), { dryRun: true, passes: ["consolidate"] });
    expect(consolidateOnly.dryRun).toBe(true);
    expect(consolidateOnly.signalCategories).toContain("duplicates");
  });

  it("reports token usage from the saved trace after a real run", async () => {
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub", description: "main" }, "core", "add");
    await kb.writeConcept("/stray.md", { type: "T", title: "Stray", description: "unconnected" }, "alone", "add");

    // Simulate what runMutation does: save a trace, then return its id.
    const { TraceStore } = await import("../src/agent/trace.js");
    await new TraceStore(root).save({
      id: "trace-1",
      kind: "mutation",
      input: "dream",
      startedAt: new Date().toISOString(),
      durationMs: 10,
      steps: [],
      answer: "done",
      notation: "✓",
      outcome: "success",
      modelChain: ["test:model"],
      usage: { inputTokens: 123, outputTokens: 45 },
    });
    const runner = vi.fn(async () => ({
      summary: "wired stray into hub",
      filesChanged: ["/hub.md"],
      steps: 2,
      traceId: "trace-1",
    }));

    const report = await runDream(kb, {}, runner);
    expect(report.ran).toBe(true);
    expect(report.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it("runDream reports succeeded:false when the underlying agent run itself fails", async () => {
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub", description: "main" }, "core", "add");
    await kb.writeConcept("/stray.md", { type: "T", title: "Stray", description: "unconnected" }, "alone", "add");

    const runner = vi.fn(async () => ({ ok: false as const, status: "failed" as const, error: "model unavailable" }));
    const report = await runDream(kb, {}, runner);
    expect(report.ran).toBe(true);
    expect(report.succeeded).toBe(false);
  });
});

describe("exitCodeFor", () => {
  const base = { passes: ["repair", "consolidate"] as const, signalCategories: [] as string[], succeeded: true };

  it("no-op (ran=false, healthy) exits 0", () => {
    expect(exitCodeFor({ ...base, ran: false, passes: [...base.passes] })).toBe(0);
  });

  it("a dry-run with no signals exits 0", () => {
    expect(exitCodeFor({ ...base, ran: false, dryRun: true, signalCategories: [], passes: [...base.passes] })).toBe(
      0
    );
  });

  it("a dry-run with signals exits 1 (changes WOULD be made)", () => {
    expect(
      exitCodeFor({ ...base, ran: false, dryRun: true, signalCategories: ["orphans"], passes: [...base.passes] })
    ).toBe(1);
  });

  it("a successful real run exits 1 (changes made)", () => {
    expect(exitCodeFor({ ...base, ran: true, succeeded: true, passes: [...base.passes] })).toBe(1);
  });

  it("a failed real run exits 2", () => {
    expect(exitCodeFor({ ...base, ran: true, succeeded: false, passes: [...base.passes] })).toBe(2);
  });
});
