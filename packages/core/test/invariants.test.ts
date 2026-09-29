/**
 * PRISM-42: the core invariants, as named gates.
 *
 * These are the properties that distinguish Prism from an ordinary app with
 * a database, and the ones a future change is most likely to break quietly.
 * Each describe block is one invariant; each failure message says which
 * property broke and why it matters. CI runs this file as its own job
 * ("Invariants") on every push and pull request, so a violation is a red
 * check with the invariant's name on it, not a mystery failure somewhere in
 * a 300-test suite.
 *
 * The suites are TABLE-DRIVEN OVER THE REGISTRY. Every gate iterates
 * CORE_TOOLS, and a meta-test fails if a tool exists without a fixture. So a
 * contributor who adds a tool cannot skip the invariants: the gate goes red
 * until the new tool is covered by purity, sandbox and parity.
 *
 * Adapter parity (MCP vs REST vs direct) needs the server package and lives
 * in packages/server/test/invariants-parity.test.ts. Its CLI leg arrives
 * with PRISM-20.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZodTypeAny } from "zod";
import { KnowledgeBase, Bundle, type SearchOptions } from "../src/okf/index.js";
import { searchBundle } from "../src/okf/search.js";
import { tryIndexedSearch, indexPath } from "../src/okf/search-index.js";
import { CORE_TOOLS, type ToolDefinition } from "../src/registry/index.js";

// ── shared fixtures ──────────────────────────────────────────────────

let outer: string; // parent dir: anything that escapes the bundle lands here or below
let root: string; // the bundle
let outside: string; // a sibling directory holding a secret
let kb: KnowledgeBase;

const TODAY = new Date().toISOString();
const PAST_DUE = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);

async function seed(target: KnowledgeBase) {
  await target.writeConcept(
    "/emea/cmo/policy.md",
    {
      type: "Decision",
      title: "Safety stock policy",
      description: "Fixed banding for CMO",
      tags: ["cmo", "inventory"],
      aliases: ["SSTK"],
      status: "open",
      owner: "Priya",
      due: PAST_DUE,
      confidence: 0.4,
    },
    "# Context\n\nMoves from dynamic to fixed banding. See [config](/emea/cmo/config.md).\n",
    "Added [policy](/emea/cmo/policy.md)."
  );
  await target.writeConcept(
    "/emea/cmo/config.md",
    { type: "Config Item", title: "Planning book parameters", tags: ["cmo"] },
    "Parameters for the planning book.\n",
    "Added [config](/emea/cmo/config.md)."
  );
  await target.writeConcept(
    "/latam/notes.md",
    { type: "Note", title: "LATAM lead times", tags: ["latam"] },
    "Lead times collected from sites.\n",
    "Added [notes](/latam/notes.md)."
  );
  await target.capture({ text: "Cutover risks\n\nFreeze APO writes 48h before go-live." });
}

/** One valid call per registry tool. The meta-test below fails when a tool has no entry. */
const FIXTURES: Record<string, (t: KnowledgeBase) => unknown> = {
  concept_search: () => ({ query: "safety" }),
  concept_read: () => ({ path: "/emea/cmo/policy.md" }),
  concept_list: () => ({}),
  graph_lint: () => ({}),
  concept_related: () => ({ path: "/emea/cmo/policy.md", hops: 2 }),
  concept_write: () => ({
    path: "/emea/written.md",
    frontmatter: { type: "Note", title: "Written" },
    body: "body",
    log_summary: "Added written.",
  }),
  concept_patch: () => ({
    path: "/latam/notes.md",
    frontmatter: { tags: ["latam", "patched"] },
    log_summary: "Patched notes.",
  }),
  concept_delete: () => ({ path: "/latam/notes.md", log_summary: "Removed notes." }),
  link_add: () => ({ source: "/latam/notes.md", target: "/emea/cmo/config.md", log_summary: "Linked." }),
  concept_supersede: () => ({
    old_path: "/emea/cmo/policy.md",
    new_path: "/emea/cmo/policy-v2.md",
    frontmatter: { type: "Decision", title: "Safety stock policy v2" },
    body: "v2",
    log_summary: "Superseded policy.",
  }),
  concept_as_of: () => ({ as_of: TODAY }),
  concept_capture: () => ({ text: "A quick thought", tags: ["x"] }),
  changes_since: () => ({ since: "7d" }),
  open_items: () => ({}),
  concept_template: () => ({ name: "decision" }),
  review_queue: () => ({}),
};

beforeEach(async () => {
  outer = await fs.mkdtemp(path.join(os.tmpdir(), "prism42-inv-"));
  root = path.join(outer, "bundle");
  outside = path.join(outer, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.md"), "---\ntype: Secret\n---\nDO NOT LEAK", "utf-8");
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["EMBEDDING_API_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"]) delete process.env[k];
  await fs.rm(outer, { recursive: true, force: true });
});

const shape = (def: ToolDefinition): Record<string, ZodTypeAny> =>
  ((def.inputSchema as unknown as { shape?: Record<string, ZodTypeAny> }).shape ?? {}) as Record<string, ZodTypeAny>;

// ── the registry itself must be fully covered ────────────────────────

describe("INVARIANT registry-coverage: no tool escapes the invariant suites", () => {
  it("every CORE_TOOLS entry has a fixture", () => {
    const missing = CORE_TOOLS.map((t) => t.name).filter((n) => !(n in FIXTURES));
    expect(
      missing,
      `Registry tool(s) ${missing.join(", ")} have no entry in FIXTURES (packages/core/test/invariants.test.ts) ` +
        `and no case in packages/server/test/invariants-parity.test.ts. Add them, so the purity, sandbox and parity ` +
        `invariants cover the new tool.`
    ).toEqual([]);
    const stale = Object.keys(FIXTURES).filter((n) => !CORE_TOOLS.some((t) => t.name === n));
    expect(stale, `FIXTURES names tools that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});

// ── 1. Tier 0 purity ─────────────────────────────────────────────────

describe("INVARIANT tier0-purity: deterministic tools never call a model provider", () => {
  it.each(CORE_TOOLS.map((t) => [t.name] as const))("%s makes zero network requests when no provider is configured", async (name) => {
    await seed(kb);
    await kb.rebuildSearchIndex();
    const def = CORE_TOOLS.find((t) => t.name === name)!;
    const calls: string[] = [];
    vi.stubGlobal("fetch", (...args: unknown[]) => {
      calls.push(String(args[0]));
      throw new Error("network call attempted");
    });
    for (const fn of ["request", "get"] as const) {
      vi.spyOn(http, fn).mockImplementation((() => {
        calls.push(`http.${fn}`);
        throw new Error("network call attempted");
      }) as never);
      vi.spyOn(https, fn).mockImplementation((() => {
        calls.push(`https.${fn}`);
        throw new Error("network call attempted");
      }) as never);
    }
    await def.handler(kb, def.inputSchema.parse(FIXTURES[name](kb)));
    expect(calls, `${name} reached for the network (${calls.join(", ")}). Registry tools are Tier 0/1: no LLM, no provider.`).toEqual([]);
  });

  it("with embeddings configured, ONLY concept_search may make a request, and only to the embeddings endpoint", async () => {
    await seed(kb);
    await kb.rebuildSearchIndex();
    const base = "http://embeddings.invalid/v1";
    process.env.EMBEDDING_API_BASE_URL = base;
    process.env.EMBEDDING_API_KEY = "k";
    process.env.EMBEDDING_MODEL = "m";
    const requests: { tool: string; url: string }[] = [];
    let current = "";
    vi.stubGlobal("fetch", async (url: unknown) => {
      requests.push({ tool: current, url: String(url) });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    for (const def of CORE_TOOLS) {
      current = def.name;
      await seed(kb).catch(() => {}); // reset state some tools consume; ignore "already exists" style failures
      await def.handler(kb, def.inputSchema.parse(FIXTURES[def.name](kb))).catch(() => {});
    }
    const offenders = requests.filter((r) => r.tool !== "concept_search");
    expect(offenders, `Only concept_search may call the embeddings provider; got ${JSON.stringify(offenders)}`).toEqual([]);
    expect(requests.every((r) => r.url.startsWith(base)), "the search request must go to the configured embeddings endpoint only").toBe(true);
  });
});

// ── 2. Sandbox ───────────────────────────────────────────────────────

/** Every path-like tool input, and how to put a hostile value into it. */
const SANDBOX_FIELDS: { tool: string; field: string; build: (v: string) => unknown }[] = [
  { tool: "concept_read", field: "path", build: (v) => ({ path: v }) },
  { tool: "concept_write", field: "path", build: (v) => ({ path: v, frontmatter: { type: "T" }, body: "x", log_summary: "x" }) },
  { tool: "concept_write", field: "frontmatter.supersedes", build: (v) => ({ path: "/n.md", frontmatter: { type: "T", supersedes: v }, body: "x", log_summary: "x" }) },
  { tool: "concept_patch", field: "path", build: (v) => ({ path: v, frontmatter: { tags: ["x"] }, log_summary: "x" }) },
  { tool: "concept_delete", field: "path", build: (v) => ({ path: v, log_summary: "x" }) },
  { tool: "link_add", field: "source", build: (v) => ({ source: v, target: "/emea/cmo/config.md", log_summary: "x" }) },
  { tool: "link_add", field: "target", build: (v) => ({ source: "/emea/cmo/config.md", target: v, log_summary: "x" }) },
  {
    tool: "concept_supersede",
    field: "old_path",
    build: (v) => ({ old_path: v, new_path: "/n2.md", frontmatter: { type: "T" }, body: "x", log_summary: "x" }),
  },
  {
    tool: "concept_supersede",
    field: "new_path",
    build: (v) => ({ old_path: "/emea/cmo/config.md", new_path: v, frontmatter: { type: "T" }, body: "x", log_summary: "x" }),
  },
  { tool: "concept_related", field: "path", build: (v) => ({ path: v }) },
  { tool: "concept_list", field: "prefix", build: (v) => ({ prefix: v }) },
  { tool: "concept_search", field: "scope", build: (v) => ({ query: "", scope: v }) },
  { tool: "changes_since", field: "scope", build: (v) => ({ since: "7d", scope: v }) },
  { tool: "open_items", field: "scope", build: (v) => ({ scope: v }) },
  { tool: "review_queue", field: "scope", build: (v) => ({ scope: v }) },
  { tool: "concept_capture", field: "folder", build: (v) => ({ text: "x", folder: v }) },
];

const PATHISH = /path|prefix|scope|folder|source|target/i;

/** An enum field (e.g. capture's provenance `source`) can't carry a path, whatever it is called. */
function isEnumField(schema: ZodTypeAny): boolean {
  let current: ZodTypeAny = schema;
  for (;;) {
    const typeName = (current as unknown as { _def: { typeName?: string; innerType?: ZodTypeAny } })._def.typeName;
    if (typeName === "ZodEnum") return true;
    const inner = (current as unknown as { _def: { innerType?: ZodTypeAny } })._def.innerType;
    if (!inner) return false;
    current = inner;
  }
}

describe("INVARIANT sandbox: no input to any tool can read or write outside the bundle root", () => {
  it("every path-like field of every registry tool has a sandbox case", () => {
    const covered = new Set(SANDBOX_FIELDS.map((f) => `${f.tool}.${f.field}`));
    const uncovered: string[] = [];
    for (const def of CORE_TOOLS) {
      for (const [key, schema] of Object.entries(shape(def))) {
        if (PATHISH.test(key) && !isEnumField(schema) && !covered.has(`${def.name}.${key}`)) uncovered.push(`${def.name}.${key}`);
      }
    }
    expect(
      uncovered,
      `Path-like input(s) ${uncovered.join(", ")} have no sandbox test. Add them to SANDBOX_FIELDS in ` +
        `packages/core/test/invariants.test.ts (and prove a hostile value cannot escape).`
    ).toEqual([]);
  });

  const HOSTILE = (): string[] => [
    "../escape.md",
    "../../escape.md",
    "/../escape.md",
    "/a/../../escape.md",
    "..",
    path.join(outside, "planted.md"), // an absolute OS path outside the bundle
    "/link/secret.md", // through a symlink that points outside (created per test)
  ];

  it.each(SANDBOX_FIELDS.map((f) => [`${f.tool}.${f.field}`, f] as const))("%s rejects hostile values without touching anything outside the bundle", async (_label, f) => {
    await seed(kb);
    await fs.symlink(outside, path.join(root, "link"), "dir");
    const def = CORE_TOOLS.find((t) => t.name === f.tool)!;
    const before = await snapshotOutside();

    for (const value of HOSTILE()) {
      let result: unknown;
      try {
        result = await def.handler(kb, def.inputSchema.parse(f.build(value)));
      } catch {
        continue; // rejected: exactly right
      }
      // Not rejected: it may only have operated INSIDE the bundle. It must never surface the secret.
      expect(JSON.stringify(result ?? null), `${f.tool}.${f.field}=${value} leaked the outside secret`).not.toContain("DO NOT LEAK");
    }
    expect(await snapshotOutside(), `${f.tool}.${f.field} changed files outside the bundle root`).toEqual(before);
  });

  async function snapshotOutside(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (abs === root) continue; // the bundle itself may change; only its surroundings are guarded
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out[path.relative(outer, abs)] = await fs.readFile(abs, "utf-8");
      }
    };
    await walk(outer);
    return out;
  }
});

// ── 3. Conformance ───────────────────────────────────────────────────

describe("INVARIANT conformance: no sequence of writes yields a non-conformant bundle", () => {
  it("a seeded random sequence over every mutating tool leaves a conformant bundle with a complete log", async () => {
    let s = 0x5eed42;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const paths = Array.from({ length: 14 }, (_, i) => `/${pick(["emea", "latam", "apac"])}/${pick(["cmo", "l2l"])}/c${i}.md`);
    const mutators = CORE_TOOLS.filter((t) => t.mutates);
    expect(mutators.length, "expected several mutating tools").toBeGreaterThanOrEqual(6);

    const inputFor = (name: string): unknown => {
      const p = pick(paths);
      const q = pick(paths);
      switch (name) {
        case "concept_write":
          return { path: p, frontmatter: { type: pick(["Note", "Decision"]), title: `t${Math.floor(rnd() * 99)}`, ...(rnd() < 0.3 ? { status: "open", due: "2030-01-01" } : {}) }, body: `b ${rnd()}`, log_summary: `Wrote [x](${p}).` };
        case "concept_patch":
          return { path: p, frontmatter: { tags: [pick(["a", "b"])] }, log_summary: "Patched." };
        case "concept_delete":
          return { path: p, log_summary: "Deleted." };
        case "link_add":
          return { source: p, target: q, log_summary: "Linked." };
        case "concept_supersede":
          return { old_path: p, new_path: q.replace(".md", `-v${Math.floor(rnd() * 9)}.md`), frontmatter: { type: "Decision" }, body: "v", log_summary: "Superseded." };
        case "concept_capture":
          return { text: `note ${Math.floor(rnd() * 9)}`, ...(rnd() < 0.5 ? { folder: pick(["/inbox", "/emea"]) } : {}), ...(rnd() < 0.4 ? { template: "decision" } : {}) };
        default:
          throw new Error(`conformance sequence has no input generator for mutating tool ${name}; add one`);
      }
    };

    let succeeded = 0;
    for (let i = 0; i < 160; i++) {
      const def = pick(mutators);
      try {
        await def.handler(kb, def.inputSchema.parse(inputFor(def.name)));
        succeeded++;
      } catch {
        // Expected for invalid combinations (missing targets, self-links, cycles). Rejection is fine; corruption is not.
      }
    }
    expect(succeeded, "sequence should actually perform writes").toBeGreaterThan(40);
    const report = await kb.validate();
    const errors = report.issues.filter((i) => i.severity === "error");
    expect(errors, `Bundle became non-conformant: ${JSON.stringify(errors.slice(0, 3))}`).toEqual([]);
    expect(report.conformant).toBe(true);
    expect((await kb.readLog()).length, "every successful mutation must leave a log.md entry").toBeGreaterThanOrEqual(succeeded);
  });
});

// ── 4. Rebuild identity ──────────────────────────────────────────────

const QUERIES: { query: string; options?: SearchOptions }[] = [
  { query: "safety" },
  { query: "SSTK" },
  { query: "banding" },
  { query: "" },
  { query: "lead times", options: { scope: "/latam" } },
  { query: "", options: { type: "Decision" } },
  { query: "", options: { tags: ["cmo"] } },
  { query: "safety", options: { includeHistory: true } },
  { query: "zzz-no-match" },
];

describe("INVARIANT rebuild-identity: the index is derived data; markdown alone reproduces it exactly", () => {
  it("deleting the index and rebuilding gives identical results, identical rows, and matches the plain scan", async () => {
    await seed(kb);
    await kb.supersede("/emea/cmo/policy.md", "/emea/cmo/policy-v2.md", { type: "Decision", title: "Safety stock policy v2", aliases: ["SSTK2"] }, "Fixed banding v2", "Superseded.");
    await kb.rebuildSearchIndex();

    const answers = async () => Promise.all(QUERIES.map(({ query, options }) => kb.search(query, options)));
    const rows = () => {
      const db = new DatabaseSync(indexPath(kb.bundle), { readOnly: true });
      try {
        return db.prepare("SELECT path, type, title, description, tags_joined, body, superseded, content_hash, frontmatter_json FROM concepts ORDER BY path").all();
      } finally {
        db.close();
      }
    };
    const beforeAnswers = await answers();
    const beforeRows = rows();

    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(indexPath(kb.bundle) + suffix, { force: true });
    await kb.rebuildSearchIndex();

    expect(await answers(), "query results changed after delete-and-rebuild: the index is holding state that markdown does not").toEqual(beforeAnswers);
    expect(rows(), "index rows changed after delete-and-rebuild").toEqual(beforeRows);

    for (const { query, options } of QUERIES) {
      expect(await tryIndexedSearch(kb.bundle, query, options), `indexed search diverged from the plain scan for ${JSON.stringify({ query, options })}`).toEqual(
        await searchBundle(kb.bundle, query, options)
      );
    }
  });
});

// ── 5. Concurrency ───────────────────────────────────────────────────

describe("INVARIANT concurrency: interleaved writers never lose a write", () => {
  it("two independent KnowledgeBase instances writing at once lose nothing (the cross-process lock is what serialises them)", async () => {
    const a = new KnowledgeBase(root);
    const b = new KnowledgeBase(root);
    const N = 25;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => a.writeConcept(`/a/c${i}.md`, { type: "Note" }, "a", `Added [a${i}](/a/c${i}.md).`)),
      ...Array.from({ length: N }, (_, i) => b.writeConcept(`/b/c${i}.md`, { type: "Note" }, "b", `Added [b${i}](/b/c${i}.md).`)),
    ]);
    expect((await a.readLog()).length, "log.md lost entries: writers are not serialised across instances/processes").toBe(2 * N);
    for (const dir of ["a", "b"]) {
      const files = (await fs.readdir(path.join(root, dir))).filter((f) => f !== "index.md");
      expect(files, `/${dir} lost concept files`).toHaveLength(N);
    }
    expect((await a.validate()).conformant).toBe(true);
    await expect(fs.readdir(path.join(root, ".prism", "locks")), "a write lock was left behind").resolves.toEqual([]);
  });

  it("a stale write from an agent run that read an older version is refused, not silently applied", async () => {
    await kb.writeConcept("/x.md", { type: "Note" }, "v1", "add");
    const readVersions = new Map<string, string>();
    const read = CORE_TOOLS.find((t) => t.name === "concept_read")!;
    const write = CORE_TOOLS.find((t) => t.name === "concept_write")!;
    await read.handler(kb, { path: "/x.md" }, { readVersions });
    await kb.patchConcept("/x.md", { replaceBody: "LIVE EDIT" }, "live");
    await expect(
      write.handler(kb, { path: "/x.md", frontmatter: { type: "Note" }, body: "based on v1", log_summary: "x" }, { readVersions }),
      "an agent overwrote a concept that changed after it read it (lost update)"
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

void Bundle;
