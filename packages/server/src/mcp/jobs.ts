import { randomBytes } from "node:crypto";
import type { KnowledgeBase } from "@prism/core";

/**
 * Background jobs for the LLM-backed MCP tools (memory_query / memory_add /
 * memory_update / memory_maintain). Their agent loop can run for a minute or
 * more on a large bundle, longer than many MCP clients wait. A call therefore
 * runs as a job: if it finishes within the sync budget the caller gets the
 * normal inline reply, otherwise it gets a job id immediately while the work
 * carries on server-side, and collects the result with memory_job.
 *
 * Jobs live in process memory, keyed per KnowledgeBase, because the HTTP
 * endpoint builds a fresh McpServer for every request. A restart drops them
 * (a mutation interrupted mid-run is the same as before: files already
 * written stay written).
 */
export interface McpToolResult {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export type JobState = "running" | "done" | "failed";

export interface Job {
  id: string;
  tool: string;
  key: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  result?: McpToolResult;
}

const MAX_FINISHED = 50;
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SYNC_BUDGET_MS = 20_000;

export function syncBudgetMs(): number {
  const raw = process.env.PRISM_MCP_SYNC_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SYNC_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SYNC_BUDGET_MS;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private settled = new Map<string, Promise<void>>();

  /**
   * Start `work`, or join an identical job (same tool + key) that is still
   * running, so a client retrying after a timeout cannot file the same note
   * twice. Returns the job and a promise that resolves when it has settled.
   */
  submit(tool: string, key: string, work: () => Promise<McpToolResult>): { job: Job; done: Promise<void> } {
    this.prune();
    for (const job of this.jobs.values()) {
      if (job.state === "running" && job.tool === tool && job.key === key) {
        return { job, done: this.settled.get(job.id)! };
      }
    }
    const job: Job = { id: randomBytes(4).toString("hex"), tool, key, state: "running", startedAt: Date.now() };
    this.jobs.set(job.id, job);
    const done = work().then(
      (result) => {
        job.result = result;
        job.state = result.isError ? "failed" : "done";
        job.finishedAt = Date.now();
      },
      (err: Error) => {
        job.result = { content: [{ type: "text", text: `${tool} failed: ${err.message}` }], isError: true };
        job.state = "failed";
        job.finishedAt = Date.now();
      }
    );
    this.settled.set(job.id, done);
    return { job, done };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private prune(): void {
    const now = Date.now();
    const finished = [...this.jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    finished.forEach((j, i) => {
      if (i >= MAX_FINISHED || now - (j.finishedAt ?? now) > FINISHED_TTL_MS) {
        this.jobs.delete(j.id);
        this.settled.delete(j.id);
      }
    });
  }
}

const registries = new WeakMap<KnowledgeBase, JobRegistry>();

export function jobsFor(kb: KnowledgeBase): JobRegistry {
  let r = registries.get(kb);
  if (!r) {
    r = new JobRegistry();
    registries.set(kb, r);
  }
  return r;
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

/**
 * Run `work` as a job and wait up to `budgetMs`. Finished in time: return its
 * result unchanged. Otherwise return an "accepted" reply carrying the job id.
 */
export async function runWithBudget(
  registry: JobRegistry,
  tool: string,
  args: unknown,
  work: () => Promise<McpToolResult>,
  budgetMs: number = syncBudgetMs()
): Promise<McpToolResult> {
  const { job, done } = registry.submit(tool, JSON.stringify(args ?? {}), work);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  const winner = await Promise.race([done.then(() => "done" as const), timedOut]);
  if (timer) clearTimeout(timer);
  if (winner === "done" && job.result) return job.result;
  return {
    content: [
      {
        type: "text",
        text:
          `Accepted: ${tool} is still running in the background (job ${job.id}, ${seconds(Date.now() - job.startedAt)}s so far) ` +
          `and will finish on its own. Do not resend it. Call memory_job with job_id "${job.id}" for the result.`,
      },
    ],
  };
}

export function jobSummary(job: Job) {
  return {
    id: job.id,
    tool: job.tool,
    state: job.state,
    started_at: new Date(job.startedAt).toISOString(),
    ...(job.finishedAt ? { finished_at: new Date(job.finishedAt).toISOString() } : {}),
  };
}

/** memory_job reply: the original tool result once finished, a status line while running. */
export function jobReply(job: Job | undefined, id: string): McpToolResult {
  if (!job) {
    return {
      content: [{ type: "text", text: `No job ${id}. Jobs are kept in memory for up to 24h (last ${MAX_FINISHED} finished) and are lost on a server restart.` }],
      isError: true,
    };
  }
  if (job.state === "running") {
    return {
      content: [{ type: "text", text: `Job ${job.id} (${job.tool}) is still running, ${seconds(Date.now() - job.startedAt)}s so far. Check again shortly.` }],
    };
  }
  return job.result!;
}
