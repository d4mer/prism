import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CORE_TOOLS, KnowledgeBase, runMutation, runQueryCached, withMaintenanceLock, type MutationOutcome, type ToolDefinition } from "@prism/core";
import { freshSeedMemory, getSeedMemory, seedInstructions } from "./seed.js";
import { linkHintFor } from "./link-hints.js";
import { jobReply, jobsFor, jobSummary, runWithBudget, type McpToolResult } from "./jobs.js";

/**
 * Build the OKF MCP server. Each knowledge tool internally drives the LLM
 * agent (OKF spec in its system prompt) against the bundle.
 * Transport-agnostic — used by both the stdio bin and the HTTP endpoint.
 *
 * Seed memory: a session-start overview of what the KB contains, injected via
 * BOTH channels that reach the client LLM — the initialize `instructions`
 * field (standards channel) and the memory_query tool description (universal
 * fallback; every tool-calling client loads descriptions). Without it the
 * client model has no signal that memory might hold an answer.
 */
export interface McpServerOptions {
  /**
   * PRISM-59: true for a long-lived session (stdio), where it's worth
   * pushing a refreshed overview into memory_query's description after a
   * write. The stateless HTTP endpoint builds a new server per request, so
   * there the refresh would be wasted work on every write.
   */
  longLived?: boolean;
}

/** Direct write tools that create or rewrite a concept, and which input field names it. */
const HINTED_WRITES: Record<string, (input: Record<string, unknown>) => string | undefined> = {
  concept_write: (i) => (typeof i.path === "string" ? i.path : undefined),
  concept_patch: (i) => (typeof i.path === "string" ? i.path : undefined),
  concept_supersede: (i) => (typeof i.new_path === "string" ? i.new_path : undefined),
};

export async function buildMcpServer(kb: KnowledgeBase, options: McpServerOptions = {}): Promise<McpServer> {
  // Seed generation must never prevent the server from starting — a missing
  // or empty bundle root degrades to a minimal seed, not a crash. PRISM-59:
  // cached per knowledge base (see seed.ts), no longer rebuilt per request.
  const seed = await getSeedMemory(kb).catch((err: Error) => {
    console.error(`[prism] seed generation failed: ${err.message}`);
    return "(memory overview unavailable — the bundle may be empty or unreadable; memory_status can diagnose)";
  });

  const jobs = jobsFor(kb);

  const queryDescription = (s: string) =>
    `FALLBACK for open-ended questions that need synthesis across many concepts: an internal ` +
    `LLM agent searches the OKF knowledge base, reads relevant concepts, and answers with cited ` +
    `bundle paths (can take 10 to 60s; may return a job id, see memory_job). For lookups, ` +
    `use concept_search / concept_read / concept_list instead: instant, no LLM, structured results.\n\n` +
    `CURRENT MEMORY OVERVIEW:\n${s}`;

  const server = new McpServer(
    { name: "prism", version: "0.1.0" },
    { instructions: seedInstructions(seed) }
  );

  const queryTool = server.registerTool(
    "memory_query",
    {
      title: "Query the knowledge base",
      description: queryDescription(seed),
      inputSchema: { question: z.string().describe("The question to answer") },
    },
    async ({ question }) =>
      runWithBudget(jobs, "memory_query", { question }, async () => {
        const { answer, source } = await runQueryCached(kb, question);
        const marker = source === "cache" ? "\n\n(cached answer)" : source === "hot" ? "\n\n(hot memory)" : "";
        return { content: [{ type: "text" as const, text: `${answer}${marker}` }] };
      })
  );

  /**
   * Re-derive the seed after a mutation and push it into memory_query's
   * description; RegisteredTool.update() emits tools/list_changed so
   * long-lived (stdio) sessions see the fresh overview. Best-effort — a
   * refresh failure must never fail the mutation that triggered it.
   * (Instructions can't be updated mid-session; they refresh per session.)
   */
  const refreshSeed = async () => {
    if (!options.longLived) return; // stateless HTTP: the next request reads the cache
    // Never make the caller wait for a whole-bundle read after a write.
    void freshSeedMemory(kb)
      .then((fresh) => queryTool.update({ description: queryDescription(fresh) }))
      .catch((err: Error) => console.error(`[prism] seed refresh failed: ${err.message}`));
  };

  // ── Granular tool surface (PRISM-13) ──────────────────────────────────
  // Every CORE_TOOLS entry, registered as its own first-class MCP tool. A
  // capable client agent can now file knowledge itself in one round trip
  // per action, with no LLM on this side of the connection at all — these
  // handlers are the exact same functions the internal agent's own tool
  // loop calls (buildReadTools/buildWriteTools in agent/tools.ts), so the
  // two surfaces are provably consistent, not parallel implementations.
  // Includes concept_delete, which PRISM-13's minimum tool list didn't
  // name but which is already a safe, deterministic registry entry —
  // held back from no adapter.
  for (const def of CORE_TOOLS as readonly ToolDefinition[]) {
    const shape = (def.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: shape as any,
      },
      async (input: unknown) => {
        try {
          const result = await def.handler(kb, input);
          if (def.mutates) await refreshSeed();
          // Direct writes get a deterministic "this has no links yet" nudge so
          // agents wire concepts in themselves instead of leaving orphans. It
          // rides as a second content block: the first block stays the exact
          // registry result (adapter-parity invariant).
          const written = HINTED_WRITES[def.name]?.(input as Record<string, unknown>);
          const hint = written ? await linkHintFor(kb, written) : undefined;
          const content = [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
          if (hint) content.push({ type: "text" as const, text: `HINT: ${JSON.stringify(hint, null, 2)}` });
          return { content };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: (err as Error).message }],
            isError: true,
          };
        }
      }
    );
  }

  const mutationOutcomeResponse = (outcome: MutationOutcome) => {
    if (outcome.ok) {
      const { summary, filesChanged } = outcome.result;
      return {
        content: [
          {
            type: "text" as const,
            text: `${summary}\n\nFiles changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}`,
          },
        ],
      };
    }
    if (outcome.status === "partial") {
      return {
        content: [
          {
            type: "text" as const,
            text: `⚠ Partial mutation: ${outcome.filesChanged.length} file(s) written before failure.\nFiles: ${outcome.filesChanged.join(", ")}\nError: ${outcome.error}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Mutation failed: ${outcome.error}` }],
      isError: true,
    };
  };

  server.registerTool(
    "memory_add",
    {
      title: "Add knowledge",
      description:
        "FALLBACK — prefer concept_search then concept_patch / concept_write / link_add: instant, no LLM, and you control exactly where and how it is filed. Use this only if you cannot drive tools directly. It takes free-form knowledge (facts, docs, decisions, runbooks) and an internal LLM agent searches for overlap, then creates or extends OKF concepts (10 to 60s; may return a job id, see memory_job; never resend).",
      inputSchema: {
        content: z.string().describe("The knowledge to record, in any prose form"),
        suggested_path: z
          .string()
          .optional()
          .describe('Optional bundle path hint, e.g. "/apis/payments.md"'),
      },
    },
    async ({ content, suggested_path }) =>
      runWithBudget(jobs, "memory_add", { content, suggested_path }, async () => {
      // Wrap the payload as an explicit directive. Bare content (e.g. a plain
      // fact like "The user's name is Anirban Kar.") otherwise reads as a chat
      // message and the agent replies conversationally instead of persisting it.
      const instruction =
        `Persist the following knowledge into the knowledge base. First search for ` +
        `related or owning concepts. If this is an attribute or detail of an ` +
        `existing concept, patch it into that concept rather than creating a new ` +
        `one. Only a distinct stand-alone entity or substantial topic gets its own ` +
        `concept — and then you must also patch the related existing concepts to ` +
        `link back to it. This is content to store, not a message to answer — you ` +
        `must use the write tools.\n\n` +
        `KNOWLEDGE TO RECORD:\n${content}` +
        (suggested_path ? `\n\nIf it fits, place new content at ${suggested_path}.` : "");
      const outcome = await runMutation(kb, instruction);
      await refreshSeed();
      return mutationOutcomeResponse(outcome);
      })
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update knowledge",
      description:
        "FALLBACK — prefer concept_patch / concept_supersede / concept_delete / link_add: instant, no LLM, and you control exactly what changes. Use this only if you cannot drive tools directly. It takes a natural-language change (correct a fact, deprecate a concept, restructure) and an internal LLM agent locates the concepts and edits them (10 to 60s; may return a job id, see memory_job; never resend).",
      inputSchema: {
        instruction: z.string().describe("What to change, in natural language"),
      },
    },
    async ({ instruction }) =>
      runWithBudget(jobs, "memory_update", { instruction }, async () => {
        const outcome = await runMutation(kb, instruction);
        await refreshSeed();
        return mutationOutcomeResponse(outcome);
      })
  );

  server.registerTool(
    "memory_status",
    {
      title: "Knowledge base status",
      description:
        "Deterministic (no LLM): bundle statistics and OKF conformance report.",
      inputSchema: {},
    },
    async () => {
      const [report, lint, types, index] = await Promise.all([
        kb.validate(),
        kb.lint(),
        kb.listTypes(),
        kb.indexStatus(),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                conformant: report.conformant,
                concepts: report.conceptCount,
                directories: report.directoryCount,
                types,
                errors: report.issues.filter((i) => i.severity === "error"),
                warnings: report.issues.filter((i) => i.severity === "warning").length,
                graph: {
                  links: lint.linkCount,
                  orphans: lint.orphans.length,
                  brokenLinks: lint.brokenLinks.length,
                  healthy: lint.healthy,
                },
                // PRISM-36: whether the derived search index matches the files.
                searchIndex: index,
                // Background LLM jobs (memory_query/add/update/maintain); see memory_job.
                jobs: {
                  running: jobs.list().filter((j) => j.state === "running").length,
                  recent: jobs.list().slice(0, 10).map(jobSummary),
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "memory_maintain",
    {
      title: "Maintain / repair memory",
      description:
        "Health-check and repair the knowledge graph: an internal LLM agent wires orphaned concepts (nothing links to them) into related concepts and fixes broken links. Not normally needed: the server already does this on a schedule (DREAM_INTERVAL). No-op when the graph is already healthy. graph_lint finds the same issues with no LLM; you can repair them yourself with concept_patch / link_add.",
      inputSchema: {},
    },
    async () =>
      runWithBudget(jobs, "memory_maintain", {}, async (): Promise<McpToolResult> => {
      const before = await kb.lint();
      if (before.healthy) {
        return {
          content: [
            {
              type: "text",
              text: `Memory is healthy — ${before.conceptCount} concepts, ${before.linkCount} links, no orphans, no broken links. Nothing to repair.`,
            },
          ],
        };
      }

      const orphanList =
        before.orphans.map((o) => `- ${o.path}${o.title ? ` (${o.title})` : ""}`).join("\n") ||
        "(none)";
      const brokenList =
        before.brokenLinks.map((b) => `- ${b.path} → ${b.target} (missing)`).join("\n") ||
        "(none)";
      const instruction =
        `Repair the knowledge graph. This is a maintenance task — use the write tools.\n\n` +
        `ORPHANED CONCEPTS (no other concept links to them). For each, read it and the ` +
        `concepts it relates to, then wire it in: patch a genuinely related concept to ` +
        `reference it, and/or add outbound links from it to related concepts. Do NOT ` +
        `invent relationships that don't exist — if an orphan genuinely relates to ` +
        `nothing, leave it.\n${orphanList}\n\n` +
        `BROKEN LINKS (target does not exist). Fix the path if the target was renamed/moved, ` +
        `or remove the link if the target is gone.\n${brokenList}\n\n` +
        `Follow the enrich / link-both-ways rules. Read concepts before editing.`;

      // PRISM-27: repair is maintenance; never overlap another maintenance run.
      const locked = await withMaintenanceLock(kb.bundle, "memory_maintain (MCP)", () => runMutation(kb, instruction));
      if (!locked.ran) {
        return {
          content: [
            {
              type: "text",
              text: `Another maintenance run is in progress, so nothing was changed. ${locked.reason}. Try again once it finishes.`,
            },
          ],
        };
      }
      const outcome = locked.result;
      await refreshSeed();
      if (!outcome.ok) return mutationOutcomeResponse(outcome);
      const { summary, filesChanged } = outcome.result;
      const after = await kb.lint();
      return {
        content: [
          {
            type: "text",
            text:
              `${summary}\n\n` +
              `Graph health: orphans ${before.orphans.length} → ${after.orphans.length}, ` +
              `broken links ${before.brokenLinks.length} → ${after.brokenLinks.length}.\n` +
              `Files changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}`,
          },
        ],
      };
      })
  );

  server.registerTool(
    "memory_job",
    {
      title: "Check a background job",
      description:
        "Deterministic (no LLM). memory_query / memory_add / memory_update / memory_maintain return a job id instead of a result when they run longer than a few seconds; the work continues server-side, so do not resend it. Pass that job_id to get the status or the finished result, in the same form the original tool would have returned. Omit job_id to list recent jobs.",
      inputSchema: { job_id: z.string().optional().describe("Job id from an \"Accepted\" reply") },
    },
    async ({ job_id }) => {
      if (!job_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ jobs: jobs.list().slice(0, 20).map(jobSummary) }, null, 2) }] };
      }
      return jobReply(jobs.get(job_id), job_id);
    }
  );

  return server;
}
