import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { KnowledgeBase } from "../src/okf/index.js";
import { Bundle } from "../src/okf/bundle.js";
import { searchBundle } from "../src/okf/search.js";
import { tryIndexedSearch } from "../src/okf/search-index.js";
import { generateEmbeddings } from "../src/okf/embeddings.js";
import type { EmbeddingConfig } from "../src/providers/embeddings.js";

// PRISM-37 acceptance criteria, verbatim from the ticket:
// 1. Semantic search finds relevant concepts that share no keywords with the
//    query — the "vocabulary mismatch" case for consultant jargon.
// 2. With embeddings disabled, all retrieval still works via FTS.
// 3. Re-running generation over an unchanged bundle makes no provider calls.

/**
 * A fake OpenAI-compatible /v1/embeddings endpoint. Deterministic, no real
 * ML: text is bucketed into one of a few "topics" by substring match, and
 * each topic gets its own orthogonal one-hot vector — so two texts sharing
 * a topic score cosine similarity 1 regardless of literal wording (the
 * "vocabulary mismatch" case), and two texts in different topics score 0.
 */
const TOPIC_MARKERS: [string, number][] = [
  ["chronoflux", 0],
  ["parsec-7", 0], // a totally different literal string for the SAME topic
  ["widget", 1],
  ["gadget", 1],
];
const VECTOR_DIM = TOPIC_MARKERS.length + 1; // + a catch-all "no topic" dim

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const match = TOPIC_MARKERS.find(([marker]) => lower.includes(marker));
  const vec = new Array(VECTOR_DIM).fill(0);
  vec[match ? match[1] : VECTOR_DIM - 1] = 1;
  return vec;
}

let server: http.Server;
let callCount: number;
let failNextCalls: number;
let config: EmbeddingConfig;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount++;
      if (failNextCalls > 0) {
        failNextCalls--;
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: "synthetic failure" } }));
        return;
      }
      const { input } = JSON.parse(body) as { input: string[] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: input.map((text) => ({ embedding: fakeVector(text) })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  config = { baseURL: `http://127.0.0.1:${port}`, apiKey: "test", model: "fake-embed-v1" };
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-embeddings-test-"));
  kb = new KnowledgeBase(root);
  callCount = 0;
  failNextCalls = 0;
  // Defensive baseline: search-index.ts's tryIndexedSearch() resolves
  // embedding config from process.env (it has no override parameter, unlike
  // generateEmbeddings' explicit `config` option) — tests that rely on
  // embeddings being *unconfigured* (AC2) must not inherit env from a test
  // that forgot to clean up.
  delete process.env.EMBEDDING_API_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_API_KEY;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.EMBEDDING_API_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_API_KEY;
});

/**
 * tryIndexedSearch() reads embedding config from process.env (that's the
 * one call on the live search path, per providers/embeddings.ts) —
 * generateEmbeddings() takes an explicit override instead. Tests that need
 * a real query-embedding round trip through the mock server go through
 * this helper so process.env is always restored afterward.
 */
async function withEmbeddingEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.EMBEDDING_API_BASE_URL = config.baseURL;
  process.env.EMBEDDING_MODEL = config.model;
  process.env.EMBEDDING_API_KEY = config.apiKey;
  try {
    return await fn();
  } finally {
    delete process.env.EMBEDDING_API_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_API_KEY;
  }
}

describe("PRISM-37: embeddings and hybrid ranking", () => {
  it("AC1: semantic search surfaces a concept sharing no keywords with the query", async () => {
    await kb.writeConcept(
      "/apis/chronoflux.md",
      { type: "API", title: "ChronoFlux throttling", description: "Client-specific rate limiting for the legacy gateway" },
      "ChronoFlux enforces a hard cap on request bursts.",
      "add"
    );
    await kb.writeConcept(
      "/misc/widget.md",
      { type: "Note", title: "Widget catalog", description: "Unrelated inventory notes" },
      "A gadget and a widget, nothing to do with APIs.",
      "add"
    );
    await kb.rebuildSearchIndex();
    const gen = await generateEmbeddings(kb.bundle, { config });
    expect(gen.ran).toBe(true);
    expect(gen.embedded).toBe(2);

    // "PARSEC-7" shares zero literal characters with "ChronoFlux" but the
    // fake embedder puts both in topic 0 — simulating the SAP-standard term
    // vs. client jargon for the same underlying thing.
    const scanned = await searchBundle(kb.bundle, "PARSEC-7");
    expect(scanned).toEqual([]); // proves there is genuinely no keyword overlap

    const indexed = await withEmbeddingEnv(() => tryIndexedSearch(kb.bundle, "PARSEC-7"));
    expect(indexed?.map((h) => h.path)).toEqual(["/apis/chronoflux.md"]);
  });

  it("PRISM-55: aliases feed the embedding text, so jargon living only in an alias is semantically findable", async () => {
    await kb.writeConcept("/apis/gateway.md", { type: "API", title: "Legacy gateway", aliases: ["ChronoFlux"] }, "Rate limits.", "add");
    await kb.writeConcept("/misc/other.md", { type: "Note", title: "Other" }, "Unrelated.", "add");
    await kb.rebuildSearchIndex();
    await generateEmbeddings(kb.bundle, { config });
    const hits = await withEmbeddingEnv(() => tryIndexedSearch(kb.bundle, "PARSEC-7"));
    expect(hits?.map((h) => h.path)).toEqual(["/apis/gateway.md"]);
  });

  it("PRISM-54: a semantic-only match outside the scope is never surfaced", async () => {
    await kb.writeConcept("/clients/acme/throttle.md", { type: "API", title: "ChronoFlux at Acme" }, "ChronoFlux caps bursts.", "add");
    await kb.writeConcept("/clients/globex/throttle.md", { type: "API", title: "ChronoFlux at Globex" }, "ChronoFlux caps bursts.", "add");
    await kb.rebuildSearchIndex();
    await generateEmbeddings(kb.bundle, { config });
    // Unscoped, the semantic match finds both clients' notes...
    const all = await withEmbeddingEnv(() => tryIndexedSearch(kb.bundle, "PARSEC-7"));
    expect(all?.map((h) => h.path).sort()).toEqual(["/clients/acme/throttle.md", "/clients/globex/throttle.md"]);
    // ...scoped to one client, the other client's note never leaks in.
    const acme = await withEmbeddingEnv(() => tryIndexedSearch(kb.bundle, "PARSEC-7", { scope: "/clients/acme" }));
    expect(acme?.map((h) => h.path)).toEqual(["/clients/acme/throttle.md"]);
  });

  it("AC2: with no EMBEDDING_* config, indexed search matches the legacy scan exactly (unaffected by any embeddings present)", async () => {
    await kb.writeConcept(
      "/apis/chronoflux.md",
      { type: "API", title: "ChronoFlux throttling", description: "rate limiting" },
      "ChronoFlux enforces a hard cap.",
      "add"
    );
    await kb.writeConcept("/misc/other.md", { type: "Note", title: "Other", description: "keyword: chronoflux" }, "body", "add");
    await kb.rebuildSearchIndex();
    await generateEmbeddings(kb.bundle, { config }); // embeddings exist in the index...

    // ...but tryIndexedSearch resolves config from process.env, which has no
    // EMBEDDING_* set in this test process — so this call must behave
    // exactly like pure keyword search, byte-for-byte against the scan.
    const scanned = await searchBundle(kb.bundle, "chronoflux");
    const indexed = await tryIndexedSearch(kb.bundle, "chronoflux");
    expect(indexed).toEqual(scanned);
  });

  it("AC3: re-running generation over an unchanged bundle makes no provider calls", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    await kb.writeConcept("/b.md", { type: "T", title: "Beta", description: "second" }, "body b", "add");
    await kb.rebuildSearchIndex();

    const first = await generateEmbeddings(kb.bundle, { config });
    expect(first.ran).toBe(true);
    expect(first.embedded).toBe(2);
    const callsAfterFirst = callCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await generateEmbeddings(kb.bundle, { config });
    expect(second.ran).toBe(false);
    expect(second.reason).toMatch(/up to date/);
    expect(callCount).toBe(callsAfterFirst); // zero additional provider calls
  });

  it("dry-run reports staleness without ever calling the provider", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    await kb.rebuildSearchIndex();

    const dry = await generateEmbeddings(kb.bundle, { config, dryRun: true });
    expect(dry.ran).toBe(false);
    expect(dry.dryRun).toBe(true);
    expect(dry.stale).toBe(1);
    expect(callCount).toBe(0);
  });

  it("dry-run against a bundle with no index yet estimates from the bundle walk, still with zero provider calls", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    await kb.writeConcept("/b.md", { type: "T", title: "Beta", description: "second" }, "body b", "add");
    // Deliberately no rebuildSearchIndex() call.

    const dry = await generateEmbeddings(kb.bundle, { config, dryRun: true });
    expect(dry.ran).toBe(false);
    expect(dry.dryRun).toBe(true);
    expect(dry.total).toBe(2);
    expect(dry.stale).toBe(2);
    expect(callCount).toBe(0);
  });

  it("a real run builds the derived index first when one doesn't exist yet", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    // No rebuildSearchIndex() call — generateEmbeddings must build one.

    const report = await generateEmbeddings(kb.bundle, { config });
    expect(report.ran).toBe(true);
    expect(report.embedded).toBe(1);

    const hits = await tryIndexedSearch(new Bundle(root), "Alpha");
    expect(hits).toBeDefined();
  });

  it("editing one concept invalidates only that concept's embedding, not the whole bundle", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    await kb.writeConcept("/b.md", { type: "T", title: "Beta", description: "second" }, "body b", "add");
    await kb.rebuildSearchIndex();
    await generateEmbeddings(kb.bundle, { config });
    const callsAfterFirst = callCount;

    await kb.patchConcept("/a.md", { frontmatter: { description: "changed" } }, "edit a");

    const dry = await generateEmbeddings(kb.bundle, { config, dryRun: true });
    expect(dry.stale).toBe(1); // only /a.md, not /b.md

    const report = await generateEmbeddings(kb.bundle, { config });
    expect(report.embedded).toBe(1);
    expect(callCount).toBeGreaterThan(callsAfterFirst);
  });

  it("switching EMBEDDING_MODEL invalidates every existing embedding", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    await kb.writeConcept("/b.md", { type: "T", title: "Beta", description: "second" }, "body b", "add");
    await kb.rebuildSearchIndex();
    await generateEmbeddings(kb.bundle, { config });

    const newModelConfig = { ...config, model: "fake-embed-v2" };
    const dry = await generateEmbeddings(kb.bundle, { config: newModelConfig, dryRun: true });
    expect(dry.stale).toBe(2); // both concepts, despite content being unchanged
  });

  it(
    "a provider failure is reported loudly, not silently tolerated as full coverage",
    async () => {
      await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
      await kb.rebuildSearchIndex();
      // A large number, not 1 — embedMany() retries transient failures by
      // default (with backoff), so a single failure could succeed on retry
      // and this test would end up proving nothing about the failure path.
      // The retries are also why this test gets a longer-than-default
      // timeout below.
      failNextCalls = 10;

      const report = await generateEmbeddings(kb.bundle, { config });
      expect(report.ran).toBe(true);
      expect(report.failed).toBe(1);
      expect(report.failedPaths).toEqual(["/a.md"]);
      expect(report.coverage).toEqual({ embedded: 0, total: 1 });
    },
    15_000
  );

  it("not configured (no EMBEDDING_* and no override) reports configured:false and touches nothing", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha", description: "first" }, "body a", "add");
    const report = await generateEmbeddings(kb.bundle); // no config override; env has none set
    expect(report.configured).toBe(false);
    expect(report.ran).toBe(false);
    expect(callCount).toBe(0);
  });
});
