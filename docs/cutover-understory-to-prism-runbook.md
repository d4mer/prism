# Runbook: cut over from understory to Prism (PRISM-46)

Audience: the agent that manages sigma and thinkpad. Owner and decision-maker: Jim.

## What this is

The live knowledge base is served today by **understory** (the upstream project this fork came from), running on **thinkpad** (confirmed by Jim; discover its address and port, do not assume 3800). **Prism** is the fork, currently deployed on sigma with a small sample bundle (4 concepts). **Decided: Prism on sigma, port 3800, replaces sigma's sample bundle.** The live bundle therefore moves from thinkpad to sigma, and every client's endpoint changes from thinkpad's address to sigma's. The goal is to move the real bundle and every client over to Prism, with nothing lost and a rehearsed way back.

Words used below:

- **SOURCE**: the live understory instance and its bundle. Treated as read-only except where a step says otherwise.
- **TARGET**: the Prism on sigma that will become the live endpoint (port 3800).
- **COPY**: a rehearsal copy of the SOURCE bundle served by a throwaway Prism on a different port.

Why this is not just a Prism update. It is a change of software, not a version bump:

- understory and Prism are different codebases that share the OKF bundle format. Prism adds optional front matter (`asserted`, `source`, `confidence`, `supersedes`, `superseded_by`, `aliases`, `status`, `owner`, `due`), a derived `.prism/` folder (search index, locks), and runtime `.traces/`. **Nothing guarantees understory tolerates those**, so the way back has to be tested, not assumed (phase F).
- Prism keeps understory's five tools (`memory_status`, `memory_query`, `memory_add`, `memory_update`, `memory_maintain`) and adds granular `concept_*` tools, `memory_job` and others. Clients should work with an endpoint and token change only, but **behaviour differs** where it matters (phase G).
- Prism rewrites front matter in its own format whenever it saves a concept, so byte-identical hashes only hold while Prism has not written to a concept. Parity is therefore checked before anything writes, and later improvements are separate, reviewable steps.

## Rules for the whole run

1. **Never print, log, echo or commit any token or API key**, from understory, Prism, olmx or anywhere else. Read them from the environment or existing `.env`, use them only in request headers, and report only lengths or that they are set.
2. Do not modify, restart, stop or delete the SOURCE until phase H, and only when Jim has said go. Reading its bundle, running read-only tools against it, and copying files out are all fine.
3. Do not touch sigma's currently running Prism container or its bundle during phases A to G. The rehearsal uses its own compose project, port and folders.
4. Where this document says "discover", find the real value on the machine and write it in the report. Do not guess hosts, paths, versions or client lists.
5. Stop and report at any "STOP" marker. Phases A to G need no approval and can be run now. **Phase H needs Jim's explicit go in the conversation; there is no standing approval.**
6. Do not commit or push from sigma or thinkpad.
7. SOURCE and TARGET are on different machines. Copy the bundle between them over the LAN with a method that preserves permissions and timestamps and can be verified (for example `rsync -a --checksum` or `tar | ssh`), and verify the manifest on the receiving side. Never mount or share the SOURCE bundle into a Prism container directly.

Working folder for everything this run creates: `$HOME/prism-cutover/` (outside any git checkout).

## Phase A: Inventory the SOURCE (read-only)

Write the answers into `docs/cutover-rehearsal-result.md` as you go.

1. How understory runs: host, container or process, image or commit, how it is started (compose file path, Portainer stack, systemd). `docker inspect` output for the container, with environment values for any name containing TOKEN, KEY or SECRET removed.
2. **Where the bundle lives** (docker volume or host path), its total size, file count, and concept count. Is the bundle a git repository (`.git` present)? Is `GIT_AUTOCOMMIT` on? If it is a repo, history must travel with the data.
3. **Everything in the bundle that is not a `.md` concept**: hidden folders, caches, index files, anything understory itself generates. List them. Decide per item in the report: copy, regenerate, or ignore. Do not delete any of it.
4. Auth: does understory require a token? Which variable name? (Name only.) How many distinct values appear to be in use across clients, if you can tell.
5. LLM settings understory uses (variable names, base URL, model name; not keys). The same provider details carry over to Prism; the variable names `LLM_API_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and the legacy ones are supported by Prism.
6. **Client inventory.** Who talks to the SOURCE? Use understory's logs, the access list, and ask Jim for anything not visible. For each client record: name, transport (MCP over mcp-remote, native MCP, REST), where its config lives, and what MCP server *name* it registers (this matters: see phase G). Expected candidates, to be confirmed not assumed: Claude Desktop and Claude Code sessions, Open WebUI, the other agents that write to the knowledge base, any cron or scheduled jobs.
7. Current usage: which tools are actually called, from logs or traces, and roughly how often. This decides which compatibility checks matter most.

STOP if the bundle location cannot be determined or the SOURCE is not what is described above. Report and wait.

## Phase B: Back up and baseline (read-only on the SOURCE)

1. Archive the bundle: `tar -czf $HOME/prism-cutover/source-bundle-<date>.tgz` of the whole bundle folder, `.git` included. Also record the docker volume backup command that works for the volume type and run it. Verify each backup restores: extract to a scratch folder and compare file counts.
2. Baseline manifest, excluding only derived folders you identified in phase A.3:
   ```
   cd <bundle> && find . -path ./.git -prune -o -path ./<derived> -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > $HOME/prism-cutover/source-manifest.sha256
   ```
3. Baseline numbers from understory's own `memory_status` (a read-only call): concept count, links, orphans, broken links, type distribution. These replace the stale August figures in PRISM-46.

## Phase C: Stand up the COPY

1. Copy the bundle (not move) from thinkpad to `$HOME/prism-cutover/bundle-copy` on **sigma**, verifying the manifest after the transfer (rule 7), same ownership concerns as the move procedure (`docs/sigma-bundle-move.md`): the Prism container runs as root and will own `.prism/`.
2. In `$HOME/prism-cutover/`, bring up a second Prism with its own compose project name so it cannot collide with sigma's running one:
   - project name `prism-rehearsal`, host port **3801**
   - `BUNDLE_HOST_PATH` pointing at the copy
   - its own `AUTH_TOKEN`, generated fresh and kept only in that folder's `.env`
   - **`DREAM_INTERVAL=` (empty)**, and no LLM and no embeddings settings yet, so nothing can write to the copy on its own
   - use the same image sigma's Prism currently runs (check `git rev-parse --short HEAD` in the checkout; it should be at or after `daf17b9`)
3. Confirm it is healthy and that `memory_status` answers.

## Phase D: Parity (the copy must not have been written to by Prism yet)

1. **Hash parity.** Regenerate the manifest of the copy, excluding `.prism/`, `.traces/` and whatever phase A decided to ignore. It must equal `source-manifest.sha256` exactly. If Prism's startup cleanup removed an empty folder or changed anything, report exactly which path and why, do not fix it by hand.
2. **Count parity.** Prism's `memory_status` against understory's baseline: concept count, links, orphans, broken links, type distribution. Differences must be explained (for example an orphan count that depends on definition) or the gate fails.
3. **Read parity.** Pick at least 25 concepts spread across types and folders, including the largest and any with unusual characters or long descriptions. For each, `concept_read` through Prism must return a body identical to the file on disk. Record any mismatch.
4. **Retrieval parity.** Understory only exposes `memory_query`, Prism has `concept_search`. Take at least 10 realistic questions (ask Jim for some; add ones taken from concept titles and from recent real usage in the logs). For each, compare what understory's `memory_query` cites against Prism's `concept_search` top 5. Note misses where understory found a concept Prism's keyword search did not. Embeddings are not on yet; this is the keyword baseline.
5. **Tool surface.** From the copy, call each of understory's five tools once where it is safe to do so (`memory_status` always; `memory_query` and `memory_maintain` only if an LLM is configured on the copy, otherwise record the clean "No LLM configured" response). Confirm `memory_job` exists and that a `memory_status` result contains a `jobs` object.

**GATE G1: parity.** Pass only if D.1, D.2 and D.3 are clean. D.4 is a judgement call for Jim: report the evidence and let him decide. STOP and report.

## Phase E: Improvements, as repeatable scripted steps on the copy

These change the data on purpose, so hashes will no longer match the source afterwards. Each step must be a script or exact command list saved in `$HOME/prism-cutover/steps/` so the identical sequence can be replayed on the final bundle in phase H. Record the diff each one produces.

1. **Graph repair** (the known orphans and broken link): `prism maintain <bundle> --dry-run` first and save the output; then, only if an LLM is configured for it, the real run. Review what it changed.
2. **Provenance backfill (PRISM-25)**: `packages/core/scripts/backfill-provenance.mjs` in dry-run first. **Check first whether it has already been applied to this bundle** (look for `asserted` or `source: document` in front matter) and report. Then apply to the copy, re-run to confirm "No changes needed", and run `validate`/`lint`. The diff will show cosmetic YAML re-wrapping; list any change that is not cosmetic.
3. **Embeddings**: configure `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL` and key on the copy from sigma's existing `.env` (olmx, `bge-m3-mlx-fp16`), run `maintain --only=embed`, record the concept count, time and any failures, then a second run must say "up to date". Run `reindex` and confirm `embeddingsKept` equals the concept count.
4. Re-run the retrieval questions from D.4 with embeddings on and record the difference.

## Phase F: Prove the way back (the part specific to understory)

Rollback means putting the bundle, now with Prism's additions, back under understory. Test that now.

1. Take a copy of the bundle *after* phase E (it has the new front matter, `.prism/`, `.traces/`).
2. Start a **throwaway understory** on **sigma**, from the same image and configuration as the SOURCE (move the image across with `docker save | ssh sigma docker load`, or rebuild from the same upstream commit and say which), on port 3802, against that copy. It must not share a volume with the SOURCE and must not reach the SOURCE's address.
3. Check it starts, `memory_status` reports the same concept count, and a sample of 25 concepts reads correctly, including ones that gained `asserted`, `source` or `aliases`. Also write one test concept through understory and confirm Prism, started against the same files afterwards, reads it.
4. Record exactly what, if anything, understory complains about or ignores, and whether `.prism/` and `.traces/` need to be excluded when copying back.
5. Time the whole procedure from "stop Prism" to "understory answering on the original endpoint with the bundle restored". Target is minutes.

**GATE G2: rollback.** Pass only if the throwaway understory reads the Prism-modified bundle without loss and the restore is timed. If understory cannot read it, STOP: the options (strip the new fields on the way back with a script, or accept no rollback after the first Prism write) are Jim's decision.

## Phase G: Client changes and what behaves differently

Write this as a table in the report, one row per client from phase A.6. Nothing is changed on any client yet.

For each client the change is the **endpoint and the token**, nothing else, assuming the MCP server *name* is kept. Keep the registered server name `understory` at first, even though it now points at Prism: agents and prompts reference tool names like `mcp__understory__memory_query`, so a rename would silently break them. Whether to rename later is a separate decision for Jim.

How each type of client registers Prism:

- **Open WebUI**: native MCP, streamable HTTP, auth type Bearer with the token in the Key field, or None if the server has no token. Never Bearer with an empty key. See the Open WebUI section of the README.
- **Claude Desktop / mcp-remote bridge**: the token goes only in the environment variable `PRISM_AUTH` as `Bearer <token>`, never in the args; `--allow-http` is needed for a plain-http LAN endpoint.
- **REST/OpenAPI clients**: `http://<host>:3800/api/v1/openapi.json`, same bearer token.

Behaviour differences to tell every client owner about:

1. A slow `memory_query`, `memory_add`, `memory_update` or `memory_maintain` call can return `Accepted: ... (job <id>)` after about 20 seconds instead of waiting; the answer is fetched with `memory_job`. Clients that assumed a blocking answer must handle this.
2. The session instructions now prefer the direct tools (`concept_search`, `concept_read`, `concept_patch`, `concept_write` plus `link_add`) and label `memory_query/add/update` as fallback only.
3. `concept_write`, `concept_patch` and `concept_supersede` over MCP append a second text block starting `HINT:` when the concept just written has no links.
4. Prism authentication is one shared bearer token. If understory had none, every client now needs one; if it had several, they collapse into one.
5. Search is keyword plus embeddings (olmx). Stopword noise in natural-language queries was fixed in fe4aa1a (PRISM-67); queries like "cutting safety stock in the warehouse" no longer pick up "in"/"the" noise.
6. Several agents write to this one knowledge base. Writes are locked, but `log.md` does not record which agent wrote what (PRISM-38 is parked).

## STOP: report phases A to G

Write `docs/cutover-rehearsal-result.md` containing: the full phase A inventory, the baseline numbers, each gate result with the evidence, the client table, the saved step scripts and their diffs, and a list of risks and open questions. Then wait. Do not start phase H.

---

## Phase H: Cutover day (only after Jim says go)

Preconditions, all confirmed by Jim in the conversation: G1 and G2 passed, the client table is accepted, and a quiet window is agreed. The endpoint is decided: **TARGET is Prism on sigma, port 3800, replacing sigma's current sample bundle.** Because Prism is on a different machine, every client gets a new address; nothing can be left pointing at thinkpad.

**Jim's go: 2026-10-29. Decisions that replace "as Jim decides" below:**

- `DREAM_INTERVAL=` (empty, dreaming off) on the TARGET. Jim will turn it on later.
- Carry `.traces/` over with the bundle.
- Generate a **fresh production AUTH_TOKEN**. Write it to a 0600 file on sigma (e.g. `$HOME/prism-data/prism-auth-token.local`, never inside the checkout), tell Jim the path and length only, and never print it. Client config uses it by environment variable, not pasted into files that get committed.
- The 8 orphans are **not** repaired at cutover. Replay E.2 (provenance) and E.3 (embeddings) from the saved scripts. For E.1 run only the dry-run and record the output; do not run the real dream (the rehearsal showed it spends about 6 minutes and changes nothing).
- Moving the bundle out of the git checkout is done by step 5 (production bundle path via `BUNDLE_HOST_PATH`); `docs/sigma-bundle-move.md` is not a separate job.
- Jim announces the freeze (step 1) by starting this phase; he has stopped or will stop OpenClaw and Hermes writing to the SOURCE. Confirm with a `log.md` check on the SOURCE that nothing new appears before step 2.

1. **Announce the freeze** to anyone writing (Jim does this; agents must stop calling the SOURCE).
2. **Stop the SOURCE on thinkpad with `docker stop` (or the equivalent), never remove it.** This is the only way to guarantee no write lands after the final copy. The container, image and volume stay exactly as they are; this is the fallback.
3. **Final copy.** Re-copy the bundle from the stopped SOURCE on thinkpad to a fresh folder on sigma. Build a manifest and confirm it equals the source's own manifest. Compare against `source-manifest.sha256`: differences are exactly the writes made since the rehearsal copy, and are expected, but list them.
4. **Replay phase E** from the saved scripts on this fresh copy, in the same order. Re-do the dry-run reviews; if the dry-run output differs materially from what Jim reviewed, STOP and show him.
5. **Stage the TARGET.** Move sigma's current sample bundle aside to `$HOME/prism-data/bundle-sample-<date>` (do not delete it), put the final bundle at the production bundle path (outside the git checkout, per `docs/sigma-bundle-move.md`), set `BUNDLE_HOST_PATH` and restore the production settings: real `AUTH_TOKEN`, LLM, embeddings, and `DREAM_INTERVAL` as Jim decides. `docker compose up -d`, wait for healthy.
6. **Smoke test the TARGET** with the production token: `memory_status` (count and conformance match step 4), `concept_search` for 5 known terms, `concept_read` for 5 concepts, one `concept_write` plus `concept_delete` of a throwaway under `/tests/`, one `memory_query` (inline or `Accepted` then `memory_job`), embeddings coverage complete. Compare against the rehearsal results.
7. **Switch clients**, one at a time, in the order agreed with Jim, verifying each with a real call before moving on. Keep the MCP server name unchanged. Record the time each client switched.
8. **Hold for a first-use check**: Jim confirms a real task works end to end on at least one MCP client and Open WebUI.

### Rollback triggers and procedure

Roll back if the final-copy manifest is wrong, the TARGET is not healthy, the smoke test fails, a client that matters cannot work after one fix attempt, or Jim says so.

- **Before any client has written to Prism**: stop the TARGET, `docker start` the SOURCE container on thinkpad, point clients back at thinkpad. The SOURCE data is untouched.
- **After Prism has taken writes**: stop the TARGET; copy the bundle from sigma back over the SOURCE volume on thinkpad by the exact method rehearsed in phase F (with `.prism/` and `.traces/` handled as phase F found, and the manifest verified on arrival); start the SOURCE; point clients back. Take a safety archive of the SOURCE volume first. Report the elapsed time against the rehearsed figure.

## Phase I: After the cutover

1. Run the embedding pass if any concept lacks a vector; confirm "up to date".
2. Watch for 24 hours: container health, `memory_status` each few hours, `log.md` growth, any `LOCKED` or `CONFLICT` errors, the first scheduled maintenance pass (about one interval after boot) and what it changed.
3. Keep the SOURCE stopped, not removed, for a period Jim sets (suggest at least two weeks). Do not delete the volume, image or the backups until he says so.
4. Report, then PRISM-46 can move to Done.

## Report files

- After phases A to G: `docs/cutover-rehearsal-result.md`.
- After phases H and I: `docs/cutover-day-result.md`, with timestamps for each step, the manifests' comparison, client switch times, smoke test results, anomalies and the rollback decision.

No tokens or keys in either. Do not commit or push from sigma or thinkpad.
