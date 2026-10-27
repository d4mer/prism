import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeBase } from "@prism/core";
import { JobRegistry, jobReply, runWithBudget, syncBudgetMs } from "../../src/mcp/jobs.js";

// The LLM agent is the slow part; replace it with a stub whose duration the
// test controls. Everything else in @prism/core stays real.
const mutation = vi.hoisted(() => ({ runs: 0, delayMs: 0, fail: false }));
vi.mock("@prism/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prism/core")>();
  return {
    ...actual,
    runQueryCached: async () => {
      await new Promise((r) => setTimeout(r, mutation.delayMs));
      return { answer: "It retries three times.", source: "agent" };
    },
    runMutation: async () => {
      mutation.runs++;
      await new Promise((r) => setTimeout(r, mutation.delayMs));
      if (mutation.fail) throw new Error("model exploded");
      return { ok: true, result: { summary: "Filed the note.", filesChanged: ["/notes/x.md"] } };
    },
  };
});
const { mcpRouter } = await import("../../src/mcp/http.js");

const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0].text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("JobRegistry / runWithBudget (unit)", () => {
  it("returns the work's own result when it finishes inside the budget", async () => {
    const reg = new JobRegistry();
    const res = await runWithBudget(reg, "t", { a: 1 }, async () => ({ content: [{ type: "text", text: "hello" }] }), 500);
    expect(text(res)).toBe("hello");
    expect(reg.list()[0].state).toBe("done");
  });

  it("returns an Accepted reply with a job id past the budget, and the job still finishes", async () => {
    const reg = new JobRegistry();
    const res = await runWithBudget(reg, "t", {}, async () => { await sleep(80); return { content: [{ type: "text", text: "late" }] }; }, 10);
    expect(text(res)).toMatch(/Accepted: t is still running .*\(job ([0-9a-f]{8})/);
    const id = /job ([0-9a-f]{8})/.exec(text(res))![1];
    expect(jobReply(reg.get(id), id).content[0].text).toMatch(/still running/);
    await sleep(150);
    expect(text(jobReply(reg.get(id), id))).toBe("late");
  });

  it("joins an identical running job instead of starting a second one", async () => {
    const reg = new JobRegistry();
    let runs = 0;
    const work = async () => { runs++; await sleep(60); return { content: [{ type: "text" as const, text: "once" }] }; };
    const [a, b] = await Promise.all([runWithBudget(reg, "t", { x: 1 }, work, 10), runWithBudget(reg, "t", { x: 1 }, work, 10)]);
    expect(runs).toBe(1);
    expect(/job ([0-9a-f]{8})/.exec(text(a))![1]).toBe(/job ([0-9a-f]{8})/.exec(text(b))![1]);
    // different arguments are a different job
    await runWithBudget(reg, "t", { x: 2 }, work, 500);
    expect(runs).toBe(2);
  });

  it("records a thrown error as a failed job with an error result", async () => {
    const reg = new JobRegistry();
    const res = await runWithBudget(reg, "t", {}, async () => { throw new Error("boom"); }, 500);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/boom/);
    expect(reg.list()[0].state).toBe("failed");
  });

  it("reports an unknown job id as an error", () => {
    expect(jobReply(undefined, "deadbeef").isError).toBe(true);
  });

  it("reads the sync budget from PRISM_MCP_SYNC_WAIT_MS, falling back on bad values", () => {
    const old = process.env.PRISM_MCP_SYNC_WAIT_MS;
    process.env.PRISM_MCP_SYNC_WAIT_MS = "1234";
    expect(syncBudgetMs()).toBe(1234);
    process.env.PRISM_MCP_SYNC_WAIT_MS = "nope";
    expect(syncBudgetMs()).toBe(20_000);
    if (old === undefined) delete process.env.PRISM_MCP_SYNC_WAIT_MS; else process.env.PRISM_MCP_SYNC_WAIT_MS = old;
  });
});

describe("memory_* tools as background jobs, over real streamable HTTP", () => {
  let root: string;
  let server: http.Server;
  let client: Client;
  const oldBudget = process.env.PRISM_MCP_SYNC_WAIT_MS;

  beforeEach(async () => {
    process.env.PRISM_MCP_SYNC_WAIT_MS = "150";
    Object.assign(mutation, { runs: 0, delayMs: 0, fail: false });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prism-jobs-"));
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpRouter(new KnowledgeBase(root)));
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    client = new Client({ name: "job-test", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterEach(async () => {
    if (oldBudget === undefined) delete process.env.PRISM_MCP_SYNC_WAIT_MS; else process.env.PRISM_MCP_SYNC_WAIT_MS = oldBudget;
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists memory_job alongside the existing memory tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["memory_query", "memory_add", "memory_update", "memory_status", "memory_maintain", "memory_job"]) expect(names).toContain(n);
  });

  it("a fast memory_add still answers inline, exactly as before", async () => {
    mutation.delayMs = 10;
    const res = await client.callTool({ name: "memory_add", arguments: { content: "a fact" } });
    expect(text(res)).toBe("Filed the note.\n\nFiles changed:\n- /notes/x.md");
    expect(res.isError).toBeFalsy();
  });

  it("a slow memory_add answers within the budget with a job id; memory_job returns the real result later; a retry does not file it twice", async () => {
    mutation.delayMs = 700;
    const t0 = Date.now();
    const first = await client.callTool({ name: "memory_add", arguments: { content: "slow fact" } });
    expect(Date.now() - t0).toBeLessThan(600); // far under the 700ms work
    expect(text(first)).toMatch(/Accepted: memory_add is still running/);
    const id = /job ([0-9a-f]{8})/.exec(text(first))![1];

    // The client "times out and retries" the identical call: same job, no second run.
    const retry = await client.callTool({ name: "memory_add", arguments: { content: "slow fact" } });
    expect(text(retry)).toContain(id);
    expect(mutation.runs).toBe(1);

    expect(text(await client.callTool({ name: "memory_job", arguments: { job_id: id } }))).toMatch(/still running/);
    const status = JSON.parse(text(await client.callTool({ name: "memory_status", arguments: {} })));
    expect(status.jobs.running).toBe(1);

    await sleep(800);
    const done = await client.callTool({ name: "memory_job", arguments: { job_id: id } });
    expect(text(done)).toBe("Filed the note.\n\nFiles changed:\n- /notes/x.md");
    const after = JSON.parse(text(await client.callTool({ name: "memory_status", arguments: {} })));
    expect(after.jobs.running).toBe(0);
    expect(after.jobs.recent[0]).toMatchObject({ id, tool: "memory_add", state: "done" });
  });

  it("a slow memory_query becomes a job too, and memory_job returns the answer with its original formatting", async () => {
    mutation.delayMs = 500;
    const first = await client.callTool({ name: "memory_query", arguments: { question: "how do retries work?" } });
    expect(text(first)).toMatch(/Accepted: memory_query is still running/);
    const id = /job ([0-9a-f]{8})/.exec(text(first))![1];
    await sleep(600);
    expect(text(await client.callTool({ name: "memory_job", arguments: { job_id: id } }))).toBe("It retries three times.");
  });

  it("a failing job surfaces as an error through memory_job", async () => {
    mutation.delayMs = 400;
    mutation.fail = true;
    const first = await client.callTool({ name: "memory_update", arguments: { instruction: "change it" } });
    const id = /job ([0-9a-f]{8})/.exec(text(first))![1];
    await sleep(500);
    const res = await client.callTool({ name: "memory_job", arguments: { job_id: id } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/model exploded/);
  });

  it("memory_job with an unknown id is a clear error, and with no id lists recent jobs", async () => {
    const bad = await client.callTool({ name: "memory_job", arguments: { job_id: "00000000" } });
    expect(bad.isError).toBe(true);
    mutation.delayMs = 5;
    await client.callTool({ name: "memory_add", arguments: { content: "x" } });
    const list = JSON.parse(text(await client.callTool({ name: "memory_job", arguments: {} })));
    expect(list.jobs[0]).toMatchObject({ tool: "memory_add", state: "done" });
  });
});
