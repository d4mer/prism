#!/usr/bin/env node
/**
 * PRISM-43: scale baseline. Generates a realistic synthetic bundle per size,
 * then measures core operations in-process and the real server over REST and
 * MCP. Deterministic (seeded) so runs are comparable across commits.
 *
 *   node scripts/bench-scale.mjs --size=1000 [--out=bench/results/<name>.json] [--no-server]
 *
 * Requires built packages (pnpm -r build). Each size is one invocation; the
 * results file accumulates sizes, keyed by size, alongside commit + machine.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(repo, "packages/core/dist/index.js"));
const { tryIndexedSearch } = await import(path.join(repo, "packages/core/dist/okf/search-index.js"));
const { searchBundle } = await import(path.join(repo, "packages/core/dist/okf/search.js"));
const { regenerateIndex } = core;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const SIZE = Number(args.size ?? 1000);
const OUT = args.out ? path.resolve(repo, args.out) : undefined;
const WITH_SERVER = args["no-server"] !== "true";

// ── deterministic generator ──────────────────────────────────────────
let seed = 0x5eed ^ SIZE;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const REGIONS = ["emea", "latam", "apac", "india"];
const STREAMS = ["cmo", "l2l", "inventory", "demand", "supply", "integration", "cutover", "master-data"];
const TYPES = ["Decision", "Meeting Note", "Fit-Gap Item", "Requirement", "Interface", "Config Item", "Reference", "note"];
const WORDS = (
  "safety stock planning book forecast consumption lead time sourcing rule cutover freeze interface batch " +
  "master data location product network supplier contract manufacturer allocation deployment horizon " +
  "parameter banding service level replenishment capacity constraint heuristic optimiser scenario " +
  "workshop decision owner approval risk mitigation dependency region site warehouse transport"
).split(" ");
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

async function generate(root, n) {
  // ~50 concepts per leaf folder: region/stream[/batchK]
  const paths = [];
  for (let i = 0; i < n; i++) {
    const region = REGIONS[i % REGIONS.length];
    const stream = STREAMS[Math.floor(i / REGIONS.length) % STREAMS.length];
    const batch = Math.floor(i / (REGIONS.length * STREAMS.length * 50));
    paths.push(`/${region}/${stream}${batch ? `/b${batch}` : ""}/c${i}.md`);
  }
  const today = Date.now();
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const type = pick(TYPES);
    const fm = [
      "---",
      `type: ${type}`,
      `title: ${sentence(4)} ${i}`,
      `description: ${sentence(10)}`,
      `tags: [${pick(STREAMS)}, ${pick(REGIONS)}]`,
      `timestamp: '${new Date(today - Math.floor(rnd() * 200) * 86_400_000).toISOString()}'`,
    ];
    if (rnd() < 0.1) fm.push(`aliases: [${pick(["APO", "OMP", "L2L", "CMO", "SSTK"])}${i}]`);
    if (rnd() < 0.15) {
      fm.push(`status: ${pick(["open", "in_progress", "blocked", "decided", "closed"])}`, `owner: ${pick(["Priya", "Jim", "Client IT"])}`);
      if (rnd() < 0.7) fm.push(`due: '${new Date(today + (Math.floor(rnd() * 60) - 30) * 86_400_000).toISOString().slice(0, 10)}'`);
    }
    if (rnd() < 0.05) fm.push(`confidence: ${(rnd() * 0.5).toFixed(2)}`);
    fm.push("---");
    // ~4 links per concept to random others (realistic link density)
    const links = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
      const t = paths[Math.floor(rnd() * n)];
      return `[${path.posix.basename(t, ".md")}](${t})`;
    });
    const body = `# Summary\n\n${sentence(60)}\n\n# Detail\n\n${sentence(90)}\n\n# Related\n\n${links.map((l) => `- ${l}`).join("\n")}\n`;
    const text = fm.join("\n") + "\n" + body;
    bytes += text.length;
    const abs = path.join(root, paths[i]);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }
  // index.md for every directory, deepest first
  const dirs = new Set(["/"]);
  for (const p of paths) {
    let d = path.posix.dirname(p);
    while (d !== "/") {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }
  const bundle = new core.Bundle(root);
  for (const d of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) await regenerateIndex(bundle, d);
  return { paths, bytes, dirs: dirs.size };
}

// ── timing helpers ───────────────────────────────────────────────────
const now = () => performance.now();
async function time(fn) {
  const t = now();
  const result = await fn();
  return { ms: +(now() - t).toFixed(1), result };
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { n: s.length, p50: +q(50).toFixed(1), p95: +q(95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}
async function sample(k, fn) {
  const out = [];
  for (let i = 0; i < k; i++) out.push((await time(() => fn(i))).ms);
  return stats(out);
}
const QUERIES = ["safety stock", "cutover freeze", "L2L", "lead time sourcing", "interface batch", "optimiser scenario", "owner approval", "zzznomatch", "contract manufacturer", "service level"];

// ── run ──────────────────────────────────────────────────────────────
const root = await fs.mkdtemp(path.join(os.tmpdir(), `prism-bench-${SIZE}-`));
const r = { size: SIZE, at: new Date().toISOString() };
try {
  const gen = await time(() => generate(root, SIZE));
  Object.assign(r, { generate_ms: gen.ms, bytes: gen.result.bytes, directories: gen.result.dirs });
  const paths = gen.result.paths;

  // Cold start: new KB, first search with no index (plain scan).
  const kb = new core.KnowledgeBase(root);
  r.cold_first_search_scan_ms = (await time(() => kb.search("safety stock"))).ms;
  const scanRuns = SIZE >= 10_000 ? 10 : 20;
  r.search_scan = await sample(scanRuns, (i) => searchBundle(kb.bundle, QUERIES[i % QUERIES.length]));

  r.index_build_ms = (await time(() => kb.rebuildSearchIndex())).ms;
  r.search_indexed = await sample(40, (i) => tryIndexedSearch(kb.bundle, QUERIES[i % QUERIES.length]));
  r.search_indexed_scoped = await sample(20, (i) => tryIndexedSearch(kb.bundle, QUERIES[i % QUERIES.length], { scope: "/emea/cmo" }));
  r.reconcile_noop_ms = (await time(() => kb.reconcileSearchIndex())).ms;
  r.index_status_ms = (await time(() => kb.indexStatus())).ms;

  r.graph_ms = (await time(() => kb.graph())).ms;
  r.lint_ms = (await time(() => kb.lint())).ms;
  r.validate_ms = (await time(() => kb.validate())).ms;
  r.related_2hop_ms = (await time(() => kb.related(paths[0], { hops: 2 }))).ms;
  r.changes_since_7d_ms = (await time(() => kb.changesSince("7d"))).ms;
  r.open_items_ms = (await time(() => kb.openItems())).ms;
  r.review_queue_ms = (await time(() => kb.reviewQueue())).ms;
  r.maintenance_dry_run_ms = (await time(() => core.runDream(kb, {}, undefined, { dryRun: true }))).ms;

  // Writes into an existing deep folder, with the index present (the realistic steady state).
  const writes = SIZE >= 10_000 ? 5 : 10;
  r.write = await sample(writes, (i) =>
    kb.writeConcept(`/emea/cmo/bench-${i}.md`, { type: "note", title: `bench ${i}` }, sentence(40), `Added bench ${i}.`)
  );
  r.capture = await sample(writes, (i) => kb.capture({ text: `Bench capture ${i}\n\n${sentence(30)}` }));
  r.rss_mb = Math.round(process.memoryUsage().rss / 1e6);

  if (WITH_SERVER) r.server = await benchServer(root);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function benchServer(bundleRoot) {
  const port = 3900 + (SIZE % 97);
  const out = {};
  const t0 = now();
  const child = spawn("node", ["--no-warnings", path.join(repo, "packages/server/dist/index.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BUNDLE_ROOT: bundleRoot, PORT: String(port), INDEX_WATCH: "false" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (;;) {
      try {
        const res = await fetch(`${base}/api/v1/index/status`);
        if (res.ok) break;
      } catch {}
      if (now() - t0 > 60_000) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 25));
    }
    out.cold_start_to_ready_ms = +(now() - t0).toFixed(1);

    const timed = async (fn) => {
      const t = now();
      await fn();
      return now() - t;
    };
    const search = (q) => fetch(`${base}/api/v1/concepts/search?query=${encodeURIComponent(q)}`).then((r) => r.json());
    // Single-user reality first: one request at a time.
    const seq = [];
    for (let i = 0; i < 10; i++) seq.push(await timed(() => search(QUERIES[i % QUERIES.length])));
    out.rest_search_sequential = stats(seq);
    // Then a burst: 50 concurrent searches (an agent firing tools in parallel).
    const conc = await Promise.all(Array.from({ length: 50 }, (_, i) => timed(() => search(QUERIES[i % QUERIES.length]))));
    out.rest_search_50_concurrent = stats(conc);
    const caps = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        timed(() =>
          fetch(`${base}/api/v1/concepts/capture`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `concurrent capture ${i}` }),
          })
        )
      )
    );
    out.rest_capture_10_concurrent = stats(caps);

    // MCP over streamable HTTP: 20 concurrent concept_search tool calls on one session.
    const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "1" } } }),
    });
    const sid = init.headers.get("mcp-session-id");
    await init.text();
    const h = { ...mcpHeaders, "mcp-session-id": sid };
    await fetch(`${base}/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text());
    const mcpCall = (i) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "concept_search", arguments: { query: QUERIES[i % QUERIES.length] } } }),
      }).then((r) => r.text());
    const mseq = [];
    for (let i = 0; i < 5; i++) mseq.push(await timed(() => mcpCall(i)));
    out.mcp_search_sequential = stats(mseq);
    const mcp = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        timed(() =>
          fetch(`${base}/mcp`, {
            method: "POST",
            headers: h,
            body: JSON.stringify({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "concept_search", arguments: { query: QUERIES[i % QUERIES.length] } } }),
          }).then((r) => r.text())
        )
      )
    );
    out.mcp_search_20_concurrent = stats(mcp);
  } finally {
    child.kill("SIGTERM");
  }
  return out;
}

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
} catch {}
console.log(JSON.stringify(r, null, 2));
if (OUT) {
  let doc = { commit, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, sizes: {} };
  try {
    doc = { ...JSON.parse(await fs.readFile(OUT, "utf-8")), commit, node: process.version };
  } catch {}
  doc.sizes[String(SIZE)] = r;
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(doc, null, 2) + "\n");
}
