# Legacy server → Prism cutover — rehearsal result (PRISM-46)

Executed 2026-10-29 on the runbook `docs/cutover-to-prism-runbook.md`.
**Gates: G1 PASS (one noted caveat), G2 PASS. Phase H not started — awaiting Jim's go.**

All rehearsal work happened in `~/prism-cutover/` on sigma and `~/prism-cutover/` on thinkpad. The SOURCE on thinkpad was never written to; the only change made to it during this exercise was the removal of an empty scratch dir an errant `mkdir` of mine created inside it (no bundle file was added, changed, or deleted).

---

## Phase A — What we have

**SOURCE:** `<legacy container>` (image `<legacy image>`, ID `49a430a74ea5`), thinkpad, port 3800, bind-mount `./sample-bundle:/bundle`, compose at `~/memory-stack/legacy-fork/docker-compose.yml`. `GIT_AUTOCOMMIT=false`, bundle is **not** a git repo (no history to carry).

**Bundle:** 1.1 MB, 159 content files, **139 concepts**, 100 `Creation` entries in `log.md`, plus 50 `.traces/*.json` (runtime query/mutation traces, newest 2026-10-27 — i.e. the KB is live).

**Baseline (`memory_status` on the SOURCE):** 139 concepts, 19 dirs, 323 links, 8 orphans, 0 broken links, types: Build Gotchas, Device, Gotcha, Gotchas, Host, Playbook, Project, Runbook, Test.

**Auth reality (important):** legacy's runtime `AUTH_TOKEN` is **empty** — the server does not require a token today (verified: 200 without one). A 48-char token exists in `~/memory-stack/.env` (`LEGACY_AUTH_TOKEN`) but is only consumed by some clients, not enforced by the server. Prism enforces its bearer token, so **every client must learn a token at cutover** (Gate G.4 = yes).

**Clients found (A.6):**

| Client | Where | Current config | Writes to KB? |
|---|---|---|---|
| Hermes (this profile) | thinkpad | MCP `prism` → `http://192.168.1.185:3800/mcp`, no auth | yes (memory_add/update) |
| OpenClaw | thinkpad | MCP `prism` → `http://localhost:3800/mcp`, allow-list `prism__memory_query/add/update/status` | **yes — heaviest writer** |
| Claude Desktop | macbookm1 | mcp-remote bridge → **`http://127.0.0.1:3800/mcp`** with a bearer header | reads |
| Open WebUI | macbookm1 | **no MCP servers configured at all** | no |
| (REST) | — | no programmatic REST clients found on the LAN | — |

**Defect found now:** the macbookm1 Claude Desktop entry points at `127.0.0.1:3800` and **nothing listens on that port on the mac** (no tunnel in launchctl/ps). That client's legacy access is already broken today.

**Trace usage stats (last 50):** all `query` kind on the SOURCE; modelChain = oMLX `qwen3.5-9b`; active through 2026-10-27.

---

## Phase B — Backup

- Tar archive: `~/prism-cutover/source-bundle-20261029.tgz` (thinkpad) + copy at sigma `/tmp/source-bundle-20261029.tgz`.
- Manifest: `~/prism-cutover/source-manifest.sha256` — 159 files (excludes derived `.traces`).
- Restore drill on thinkpad: extraction re-hashed **byte-identical** to the source manifest. No volumes involved (bind mount), so tar+manifest is the complete backup.

## Phase C — Rehearsal target

- `rsync -a --checksum` copy at sigma `~/prism-cutover/bundle-copy`; receiving-side manifest equal to source (only sort-order/locale artifacts).
- Throwaway Prism: `prism-prism:latest` (image `fae615fde739`, = `daf17b9` build, same as production), compose project **prism-rehearsal**, port **3801**, fresh bearer token (in `~/prism-cutover/rehearsal/.env`, 0600, never printed), `DREAM_INTERVAL` empty, LLM+embeddings initially OFF.
- **Pitfall found (matters for H):** a hand-written compose omits the `LLM_API_FORMAT` default and the `LLM_*`/`EMBEDDING_*` passthrough mappings that prod `docker-compose.yml` has. With those missing, `maintain` fails with "No LLM configured" even with a populated `.env`. Rehearsal compose was fixed by adding the passthroughs; production compose already has them.

## Phase D — Did it land intact (GATE G1)

- **D.1 startup delta:** Prism's startup pruned two empty segment-index stubs — `apis/index.md` and `tables/index.md` (both directories held only an `index.md`, zero concepts) — and rewrote root `index.md` accordingly. 159→157 files. **No concept file changed.** Not repaired manually, per runbook.
- **D.2 counts:** concepts 139=139, links 323=323, orphans 8=8, broken 0=0, type distribution identical. Directories 19→17: fully explained by the two pruned index stubs (definitional: legacy counts dirs holding any `.md`, Prism counts concept dirs).
- **D.3 read parity:** 25 concepts (5 largest + spread across every top-level dir) — body text compared against files on disk: **25/25 exact**.
- **D.4 retrieval (keyword, no embeddings yet):** 10 questions built from real concept titles. Legacy server `memory_query` cited 1–6 concepts each; Prism `concept_search` top-5 contained **the primary concept for all 10**, and 13/28 of legacy's secondary citations. Secondary misses are concepts the legacy LLM wandered into, not lost data.
- **D.5 tool surface:** 22 tools live on the copy (21 + `memory_job`); all five legacy tools present with same names; `memory_status` carries the `jobs` object; without an LLM, `memory_query/add/update/maintain` fail **cleanly** with a configuration message (no crash, no partial write).

**G1: PASS.** Caveat for Jim: the two pruned index stubs are the only deletions, and they were empty sections.

## Phase E — Replayable enrichment (scripts saved)

Scripts: `~/prism-cutover/steps/e1-graph-repair.sh`, `e2-provenance.sh`, `e3-embeddings.sh` (contents in appendix). All were written to be re-runnable; H re-runs them in this order on the final copy.

- **E.1 graph repair:** dry-run flagged 3 signals (orphans, oversized, consolidationInsights). Real dream ran on oMLX `qwen3.6-35b`: succeeded, 390 s, 75k in / 32k tokens, 10 steps — **the LLM chose to make no writes** (its orphan candidates included known decoys, e.g. `saturn-phonetic-candidates-decoy.md`). Graph metrics unchanged (still 8 orphans, `healthy: false`). This is honest output, not a failure: automatic linking was possible and declined. If Jim wants the 8 orphans linked, that's a manual/link_add pass, not a maintenance run.
- **E.2 provenance backfill (PRISM-25):** dry-run first: 139 scanned, **0 already provenanced**, 70 get a recoverable `asserted:` date from `log.md` Creation entries, 69 get `source: document` (never guessed). Applied. Re-run = **no-op ("already fully provenanced")**. Body-integrity check vs the untouched tarball: **all 139 concept bodies byte-identical**; only `index.md` differs (derived). Removed diff lines were YAML re-quoting (cosmetic, as the script documents).
- **E.3 embeddings:** `maintain --only=embed`: 139/139 embedded, 0 failures, model `bge-m3-mlx-fp16`, derived index `bundle-copy/.prism/search.sqlite3` (4.6 MB).
- **E.4 retrieval re-run (semantic on):** trace-level comparison of the same 10 questions through Prism `memory_query`: Prism read 1–6 concepts per question, **always including the primary**, sharing 1–5 with legacy's cited set; factual answers equivalent (spot-checked LightRAG: host, container, port 9621, store paths all correct). Note: Prism's answer prose cites by title, not `/path.md`; retrieval truth comes from `.traces`, first run's "0 overlap" was a citation-format artifact.
- Behavior learned the hard way: on this hardware a slow `memory_query` returns `Accepted: … (job <id>)` after ~20 s — clients must poll `memory_job`. (This is Phase G difference #1, confirmed live.)

## Phase F — Rollback proof (GATE G2)

- Post-E bundle copied (`~/prism-cutover/bundle-rollback`, with `asserted`/`source` front matter, `.prism/`, `.traces/` including the new Prism traces).
- Legacy server image shipped `docker save | ssh sigma docker load` → **same image ID** `49a430a74ea5` on sigma.
- Throwaway legacy on **3802**, same compose shape and env mapping (LLM values piped from the thinkpad `.env`, AUTH_TOKEN empty to match the SOURCE's actual runtime): **`memory_status` 139 concepts**; no complaints, warnings, or parse errors in its logs reading Prism-modified front matter — it silently ignores `.prism/` and reads its own `.traces` as before.
- A query cited a backfilled concept (`/deltahome/llama-rocm2-build-and-tuning.md`) correctly; `memory_add` through legacy wrote `/tests/prism-backfill-legacy-write-probe.md` cleanly into the backfilled bundle.
- Reverse direction: Prism started on the same files (3803) read the legacy-written concept: 139→**140 concepts**. Round-trip proven both ways.
- **Exclusions on the way back:** `.prism/` is Prism-derived and should be excluded from any rollback copy (legacy ignores it, but a stale 4.6 MB index has no business on the thinkpad). `.traces/` can ride along — legacy coexisted with Prism's trace files happily.
- **F.5 timing:** stop → legacy answering on the endpoint: **0.5 s listener-ready, 8.8 s first full answer** (incl. oMLX cold model load). Target was "minutes" — passed with two orders of magnitude.

**G2: PASS.**

## Phase G — Client table (nothing changed yet; name `prism` kept)

| Client | Today | Cutover change | Notes |
|---|---|---|---|
| Hermes (thinkpad) | MCP `prism` → `http://192.168.1.185:3800/mcp`, no auth | URL → `http://192.168.1.195:3800/mcp` + `Authorization: Bearer <prism-token>` (env-var indirection, as `prism` entry already does) | Same name keeps `mcp__prism__*` tool names working; the duplicate `prism` entry should then be removed or repurposed |
| OpenClaw (thinkpad) | MCP `prism` → `http://localhost:3800/mcp`, allow-list 4 tools | URL → sigma + bearer header; allow-list names unchanged | Heaviest writer; switch it early in H.7 order |
| Claude Desktop (macbookm1) | mcp-remote → `127.0.0.1:3800` (**broken today**) | args → sigma URL + `--allow-http`; token only in env `PRISM_AUTH` as `Bearer <token>` | Fixing this is an improvement, not a regression risk |
| Open WebUI (macbookm1) | no MCP config | optional: add streamable-HTTP MCP `prism` → `http://192.168.1.195:3800/mcp`, Bearer key field | Only if Jim wants Open WebUI in scope for H.8 |
| REST | none | `http://192.168.1.195:3800/api/v1/openapi.json`, same bearer | reference only |

Behaviour differences every owner must be told (runbook G.1–G.6), all confirmed live during rehearsal: async `Accepted`/`memory_job` after ~20 s; direct-tools-first session instructions with `memory_*` marked fallback; `HINT:` no-links warnings appended to MCP writes; one shared bearer token for everything; keyword+embeddings search with the stopword-ranking weakness (PRISM-67); multi-writer KB with no per-agent attribution in `log.md` (PRISM-38 parked).

## Risks & open questions for Jim

1. **8 orphans remain** — Prism's dream declined to auto-link them. Link manually or accept `healthy: false`.
2. **Token rotation**: the legacy token (screenshot leak) and Plane PATs (echo leak) are compromised regardless of cutover; the new Prism production token should be generated fresh at H and the leaked ones killed.
3. **Server-name decision**: keep `prism` as the MCP name on Prism (recommended; rename later is cosmetic but breaks tool-name references).
4. **macbookm1 Claude Desktop is already broken** (127.0.0.1:3800). Cutover fixes it; no fallback exists for that client today.
5. **`.traces/` migration decision**: rehearsal carried them over; they show in the bundle but are runtime artifacts, not beliefs. Alternative is archive-and-drop. (Rehearsal default: carry.)
6. **`/tests/` probes** (3 concepts from old diagnostic runs) migrated as-is; deletable later through Prism.
7. **H.5 staging**: production bundle path per `docs/sigma-bundle-move.md` with `BUNDLE_HOST_PATH`; current prod bundle is still the 4-concept sample inside the git checkout — H moves it aside, never deletes.
8. **DREAM_INTERVAL on production**: dream ran during rehearsal on the 3c2cd5e default (every 6 h) before being pinned off for the rehearsal container; Jim decides the production cadence. Note dreams write `.traces` and occasionally concepts; freeze (H.1) must also mean the production dreamer is off until cutover completes.
9. **Quiet window + write freeze** are prerequisites for H and only Jim can announce them (OpenClaw on this machine keeps writing through its MCP entry).

## Appendix — saved step scripts

`~/prism-cutover/steps/` on sigma (all executable, replay order e1 → e2 → e3; for H, run against the final bundle path and use `-p prism` for the production compose):

- `e1-graph-repair.sh` — `prism maintain /bundle --dry-run` then real, inside rehearsal container (`docker compose -p prism-rehearsal exec -T prism node packages/server/bin/prism maintain /bundle`)
- `e2-provenance.sh` — `node packages/core/scripts/backfill-provenance.mjs <bundle>` dry → `--apply` → re-run expect no-op
- `e3-embeddings.sh` — `prism maintain /bundle --only=embed` in-container

Artifacts: manifests `source-manifest.sha256`, `/tmp/copy-manifest.sha256`, `/tmp/pre-e2.md5`; runs `~/prism-cutover/scratch/e1-run3.log`, `e2-run.log`, `e3-run.log`, `e4b-run.log`, `e4-parity2.json`; backups `source-bundle-20261029.tgz` (thinkpad + sigma `/tmp`).
