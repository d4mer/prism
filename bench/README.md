# Scale baseline (PRISM-43)

Measured, not assumed. `scripts/bench-scale.mjs` generates a realistic synthetic bundle, then times every core operation in-process and against the real server over REST and MCP. The bundle has nested region and workstream folders, about four links per concept, aliases, open items and mixed types. The generator is seeded, so runs are comparable across commits.

```bash
pnpm -r build
node scripts/bench-scale.mjs --size=1000 --out=bench/results/<name>.json          # one size per run
node scripts/bench-scale.mjs --size=10000 --no-server --out=bench/results/<name>.json
```

The results file accumulates sizes and records the commit, Node version and machine. Compare a new run against `bench/results/baseline.json`.

## Baseline

Commit `25ce6d8`, Node 22.23.2, Linux arm64 VM with 4 vCPU on Jim's Mac. The 10,000-concept server run was skipped because it doesn't fit the 3-minute tool window; the in-process numbers cover it.

### Core operations (in-process)

| Operation (ms) | 100 concepts | 1,000 concepts | 5,000 concepts | 10,000 concepts |
|---|---|---|---|---|
| Search, no index (scan), p50 | 38 | 334 | 1,681 | 3,555 |
| Search, no index (scan), p95 | 40 | 354 | 1,703 | 3,672 |
| Build the search index | 64 | 319 | 1,462 | 3,411 |
| Search with index, p50 | 1.0 | 7.1 | 37 | 78 |
| Search with index, p95 | 1.4 | 9.2 | 48 | 94 |
| Search with index, scoped to one folder, p50 | 0.4 | 2.6 | 12 | 33 |
| Index freshness check (no-op reconcile) | 33 | 221 | 1,067 | 2,252 |
| Graph | 39 | 333 | 1,661 | 3,663 |
| Lint | 41 | 339 | 1,668 | 3,454 |
| Validate | 40 | 346 | 1,691 | 3,323 |
| concept_related, 2 hops | 40 | 334 | 1,679 | 3,353 |
| changes_since 7d | 37 | 327 | 1,662 | 3,396 |
| open_items | 38 | 323 | 1,661 | 3,218 |
| review_queue | 74 | 659 | 3,314 | 6,750 |
| Maintenance dry run (signal detection) | 88 | 908 | 7,728 | 24,040 |
| Write one concept, p50 | 46 | 292 | 1,437 | 2,811 |
| Write one concept, p95 | 59 | 307 | 1,512 | 2,902 |
| Quick capture, p50 | 38 | 235 | 1,146 | 2,221 |

### Server (REST and MCP over HTTP)

| Operation (ms) | 100 concepts | 1,000 concepts | 5,000 concepts | 10,000 concepts |
|---|---|---|---|---|
| Cold start to ready | 1,087 | 1,346 | 2,402 | — |
| REST search, one at a time, p50 | 3.9 | 12 | 44 | — |
| REST search, 50 concurrent, p50 | 60 | 222 | 1,026 | — |
| REST search, 50 concurrent, p95 | 162 | 818 | 3,880 | — |
| REST capture, 10 concurrent, p50 | 261 | 1,260 | 5,796 | — |
| MCP concept_search, one at a time, p50 | 61 | 421 | 2,020 | — |
| MCP concept_search, 20 concurrent, p50 | 456 | 3,060 | 14,700 | — |

## What the numbers say

**Everything except indexed search is linear in bundle size**, at about 0.33 ms per concept per operation. Almost every operation reads every concept file from disk: graph, lint, validate, related, changes_since, open_items, the index freshness check, and each write. That's fine at a few hundred concepts, noticeable at 1,000, and painful at 5,000+.

**When the index becomes necessary (tenet 8, acceptance criterion 2).** Scan search stays under 200 ms, the interactive threshold, up to about **500 concepts**. It is 334 ms at 1,000 and 3.6 s at 10,000. With the index, search is 7 ms at 1,000 and 78 ms at 10,000, about 45× faster. So a bundle past roughly 500 concepts should always have an index. Today nothing builds one automatically; only `prism maintain` or an explicit rebuild does.

**Blockers found, ranked by how much a consultant would feel them:**

1. **Every MCP request re-reads the whole bundle.** The HTTP MCP endpoint is stateless and builds a fresh server per request. Building it recomputes the "memory overview" seed, and that reads every concept twice. A single `concept_search` over MCP takes 2.0 s at 5,000 concepts, against 44 ms for the same search over REST. Twenty parallel tool calls take 15 s. MCP is how Claude talks to Prism, so this is the first thing a user would notice.
2. **Every write re-reads the whole bundle.** Each save prunes empty folders by walking the entire tree, then regenerates `index.md` up to the root. The root index summarises every subfolder by reading every concept in it. A save takes 1.4 s at 5,000 and 2.8 s at 10,000, and ten concurrent captures take 5.8 s at 5,000.
3. **Tools that could use the index don't.** `concept_related`, `open_items`, `changes_since` and the freshness check all scan files (3.2–3.4 s at 10,000), although the derived index already holds every concept's frontmatter and links. `review_queue` is two scans (6.7 s).
4. **Maintenance signal detection is O(n²).** The duplicate-title comparison takes 24 s at 10,000. It runs in the background, so it's tolerable, but it grows fast.

Memory stays modest: under 300 MB of RSS at 10,000 concepts.
