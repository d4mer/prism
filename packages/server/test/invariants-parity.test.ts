/**
 * PRISM-42 invariant: adapter parity.
 *
 * The same operations, sent through the registry directly, through REST and
 * through MCP, must produce the same results and the same bundle state. The
 * registry is the single source of truth for behaviour; each adapter is only
 * a rendering. If an adapter starts transforming input, dropping a field,
 * or re-implementing a tool, this goes red.
 *
 * Driven by CORE_TOOLS and ROUTES like the core invariants: a tool with no
 * case here fails the coverage check below. The CLI leg (PRISM-20) is not
 * built yet; when it lands, add it to ADAPTERS.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CORE_TOOLS, KnowledgeBase } from "@prism/core";
import { registryRestRouter } from "../src/api/registry-rest.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { ROUTES } from "../src/openapi/routes.js";

type Call = (tool: string, input: Record<string, unknown>) => Promise<unknown>;
interface Backend {
  name: string;
  root: string;
  call: Call;
  close(): Promise<void>;
}

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

async function freshRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prism42-parity-"));
  roots.push(root);
  return root;
}

async function direct(): Promise<Backend> {
  const root = await freshRoot();
  const kb = new KnowledgeBase(root);
  return {
    name: "registry",
    root,
    call: async (tool, input) => {
      const def = CORE_TOOLS.find((t) => t.name === tool)!;
      return def.handler(kb, def.inputSchema.parse(input));
    },
    close: async () => {},
  };
}

async function rest(): Promise<Backend> {
  const root = await freshRoot();
  const app = express();
  app.use(express.json());
  app.use("/api/v1", registryRestRouter(new KnowledgeBase(root)));
  return {
    name: "rest",
    root,
    call: async (tool, input) => {
      const route = ROUTES.find((r) => r.tool === tool);
      if (!route) throw new Error(`no REST route for ${tool}`);
      const url = `/api/v1${route.path}`;
      const res =
        route.style === "query"
          ? await request(app)[route.method](url).query(
              Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]))
            )
          : await request(app)[route.method](url).send(input);
      if (res.status >= 400) throw new Error(`REST ${tool} -> ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    close: async () => {},
  };
}

async function mcp(): Promise<Backend> {
  const root = await freshRoot();
  const server = await buildMcpServer(new KnowledgeBase(root));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "parity", version: "1" });
  await client.connect(clientTransport);
  return {
    name: "mcp",
    root,
    call: async (tool, input) => {
      const res = (await client.callTool({ name: tool, arguments: input })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      const text = res.content[0]?.text ?? "";
      if (res.isError) throw new Error(`MCP ${tool} -> ${text}`);
      return JSON.parse(text);
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Adapters under test. The CLI (PRISM-20) joins this list when it exists. */
const ADAPTERS = [direct, rest, mcp];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

// The operations, in order. Mutating tools first, then reads over the result.
const TODAY = new Date().toISOString().slice(0, 10);
const STEPS: { tool: string; input: Record<string, unknown> }[] = [
  { tool: "concept_capture", input: { text: "Cutover risks\n\nFreeze APO writes 48h before go-live." } },
  {
    tool: "concept_write",
    input: {
      path: "/emea/cmo/policy.md",
      frontmatter: { type: "Decision", title: "Safety stock policy", aliases: ["SSTK"], status: "open", owner: "Priya", due: "2026-12-01", tags: ["cmo"] },
      body: "# Context\n\nFixed banding.\n",
      log_summary: "Added [policy](/emea/cmo/policy.md).",
    },
  },
  {
    tool: "concept_write",
    input: { path: "/emea/cmo/config.md", frontmatter: { type: "Config Item", title: "Planning book" }, body: "Parameters.\n", log_summary: "Added [config](/emea/cmo/config.md)." },
  },
  { tool: "concept_write", input: { path: "/latam/notes.md", frontmatter: { type: "Note", title: "Lead times" }, body: "Collected.\n", log_summary: "Added notes." } },
  {
    tool: "concept_patch",
    input: { path: "/emea/cmo/policy.md", frontmatter: { tags: ["cmo", "inventory"] }, replace_section: { heading: "Rationale", content: "Because." }, log_summary: "Patched policy." },
  },
  { tool: "link_add", input: { source: "/emea/cmo/policy.md", target: "/emea/cmo/config.md", log_summary: "Linked policy to config." } },
  {
    tool: "concept_supersede",
    input: {
      old_path: "/emea/cmo/policy.md",
      new_path: "/emea/cmo/policy-v2.md",
      frontmatter: { type: "Decision", title: "Safety stock policy v2", status: "decided" },
      body: "v2\n",
      log_summary: "Superseded policy.",
    },
  },
  { tool: "concept_capture", input: { text: "Go with fixed banding", template: "decision", folder: "/emea" } },
  { tool: "concept_delete", input: { path: "/latam/notes.md", log_summary: "Removed notes." } },
  // reads over the resulting state
  { tool: "concept_search", input: { query: "safety", scope: "/emea" } },
  { tool: "concept_search", input: { query: "SSTK" } },
  { tool: "concept_read", input: { path: "/emea/cmo/policy-v2.md" } },
  { tool: "concept_list", input: { prefix: "/emea" } },
  { tool: "concept_related", input: { path: "/emea/cmo/config.md", hops: 2 } },
  { tool: "open_items", input: {} },
  { tool: "graph_lint", input: {} },
  { tool: "concept_template", input: { name: "fit-gap" } },
  { tool: "concept_as_of", input: { as_of: `${TODAY}T23:59:59Z` } },
  // volatile by nature (timestamps of "now"); compared with timestamps stripped
  { tool: "changes_since", input: { since: "1d" } },
  { tool: "review_queue", input: {} },
];

/** Drop values that are legitimately different between runs: write-time stamps. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (["timestamp", "asserted", "since", "last_touched", "raw"].includes(k)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>");
  return value;
}

/** Every file in the bundle, frontmatter minus stamps, keyed by path. Dates in log headings are neutralised. */
async function bundleState(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else {
        let text = await fs.readFile(abs, "utf-8");
        text = text
          .replace(/^(timestamp|asserted): .*\n/gm, "")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>")
          .replace(/^## \d{4}-\d{2}-\d{2}$/gm, "## <date>");
        out["/" + path.relative(root, abs).split(path.sep).join("/")] = text;
      }
    }
  };
  await walk(root);
  return out;
}

describe("INVARIANT adapter-parity: registry, REST and MCP are the same behaviour", () => {
  it("every registry tool has a REST route and a parity step", () => {
    const routed = new Set(ROUTES.map((r) => r.tool));
    const stepped = new Set(STEPS.map((s) => s.tool));
    const noRoute = CORE_TOOLS.map((t) => t.name).filter((n) => !routed.has(n));
    const noStep = CORE_TOOLS.map((t) => t.name).filter((n) => !stepped.has(n));
    expect(noRoute, `Tool(s) ${noRoute.join(", ")} have no REST route in openapi/routes.ts`).toEqual([]);
    expect(noStep, `Tool(s) ${noStep.join(", ")} have no step in STEPS (invariants-parity.test.ts): add one so REST/MCP parity covers it`).toEqual([]);
  });

  it("the same operations return the same results and leave identical bundles through every adapter", async () => {
    const backends: Backend[] = [];
    for (const make of ADAPTERS) {
      const b = await make();
      closers.push(b.close);
      backends.push(b);
    }

    const results: Record<string, unknown[]> = Object.fromEntries(backends.map((b) => [b.name, []]));
    for (const step of STEPS) {
      for (const b of backends) results[b.name].push(normalize(await b.call(step.tool, step.input)));
    }

    const [reference, ...others] = backends;
    for (const other of others) {
      STEPS.forEach((step, i) => {
        expect(
          results[other.name][i],
          `${step.tool} returned a different result through ${other.name} than through ${reference.name}`
        ).toEqual(results[reference.name][i]);
      });
    }

    const referenceState = await bundleState(reference.root);
    expect(Object.keys(referenceState).length, "the sequence should leave a real bundle").toBeGreaterThan(8);
    for (const other of others) {
      const state = await bundleState(other.root);
      expect(Object.keys(state).sort(), `${other.name} left a different set of files than ${reference.name}`).toEqual(Object.keys(referenceState).sort());
      for (const file of Object.keys(referenceState)) {
        expect(state[file], `${file} differs between ${other.name} and ${reference.name}`).toBe(referenceState[file]);
      }
    }
  }, 60_000);
});
