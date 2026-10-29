# Sigma update result: b410b6c -> 3c2cd5e (background jobs, direct-tools-first, link hints)

**Date:** 2026-10-27/28 (Europe/Madrid)
**Operator:** Hermes agent (thinkpad)

## Starting state (step 0)

- Preflight note: earlier `docker-compose.yml`/`.env.example` edits seen in the tree were byte-identical to the incoming 6b6b93e versions; after the repo fast-forward they resolved to clean. The packet's d323915 predecessor doc was superseded mid-flight; this run follows the 3c2cd5e packet only.
- Checkout: `main`, HEAD `ef6b98e` (contains `3c2cd5e`) — fast-forward had already been performed on sigma by the repo owner; `git pull --ff-only` was a no-op. Verified 3c2cd5e is an ancestor.
- Container before: healthy on image `583f2418e0f8` (b410b6c-era build).
- Concept count: **4**. Manifest: 25 files (`bundle-before-3c2cd5e.sha256`).
- Rollback tag: `prism:pre-update-3c2cd5e` -> `583f2418e0f8`.

## Build (step 2)

- `docker compose build --no-cache`: SUCCESS ~75s, log `/tmp/prism-build-3c2cd5e.log`.
- New image `738379c615ee`; healthy ~20s after `up -d`.
- `docker compose logs | grep dream`: `[prism] dreaming: every 6h` PRESENT.
- `docker compose config`: `DREAM_INTERVAL: 6h`, `DREAM_INSIGHTS: true`, volume source still `./sample-bundle`. (`PRISM_MCP_SYNC_WAIT_MS` shows as empty string in compose config; unset in `.env`, default applies.)

## Verification (step 3, raw JSON-RPC, token from .env never printed)

| Step | Result | Measurements |
|---|---|---|
| 1 health + count 4==4 + conformant + search hit | PASS | |
| 2 tools/list = 22 incl `memory_job`; status `jobs` obj; init instructions contain "FALLBACK ONLY: memory_query, memory_add and memory_update" and `concept_patch` before `memory_add` | PASS | |
| 3 link hint: `concept_write` /tests/hint-check.md -> 2 blocks, block1 exactly {"written":...}, block2 `HINT:` with no-links warning; deleted, count back to 4 | PASS | |
| 4 fast path `memory_query` | PASS | 18.9s inline cited answer (under 20s budget, under 25s cap) |
| 5 slow path `memory_maintain` | PASS | first call 20.1s -> Accepted (job 5e47bf4e); immediate duplicate 20.0s -> SAME job id, no second run |
| 5 `memory_job` poll to completion | PASS | server-side job started 21:20:31 finished 21:21:15 (~44s); final summary returned; status `running: 0`, `recent[0].state: done` |
| 6 checksum diff | PASS | only `log.md` (expected logging) + 3 NEW `.traces/*.json` (new agent-trace artifacts); zero concept-file changes |
| 7 `memory_job 00000000` error path | PASS | "No job 00000000. Jobs are kept in memory for up to 24h..." |
| 8 optional reindex | PASS | {"reindexed": 4, "ms": 78} |

## Anomalies / notes

- This bundle's LLM backend is oMLX on macbookm1 (qwen3.6-35b + bge-m3 embeddings, configured 2026-10-27). The maintain job invoked the LLM (its summary discusses the fun-facts orphan) — the scheduled dream pass will too.
- `.traces/` is a new runtime directory in the bundle; the upcoming bundle-move procedure should account for it (and gitignore it).
- First scheduled dream pass expected ~6h after restart (approx 2026-10-28 03:2x); log.md edits then are expected, not anomalies.
- No commits or pushes were made from sigma. Rollback available: `prism:pre-update-3c2cd5e`.
