# Update Prism on sigma to 3c2cd5e (background jobs, direct-tools-first, scheduled upkeep)

Audience: the agent that manages sigma. Sigma currently runs `b410b6c`. The target is `3c2cd5e` on `main` of `d4mer/prism`. This replaces the earlier draft for `d323915`; do not use that one.

What changed (three commits, one update):

1. **Background jobs** (`d323915`). `memory_query`, `memory_add`, `memory_update` and `memory_maintain` drive an LLM agent loop that takes 8 to 60+ seconds, longer than many MCP clients wait. Past a time budget (default 20 s) a call now returns at once with `Accepted: ... (job <id>)` and the work continues server-side; the new `memory_job` tool returns the result. An identical call made while one is running joins it (no duplicate notes after a client retry). `memory_status` gains a `jobs` field. Calls that finish inside the budget reply exactly as before.
2. **Direct tools first** (`6b6b93e`). The session instructions now tell agents to look up with `concept_search`/`concept_read` and file with `concept_patch`/`concept_write` + `link_add`; `memory_query/add/update` are labelled fallback only. The LLM instead runs on a schedule: `docker-compose.yml` now passes `DREAM_INTERVAL` (default **6h**), `DREAM_INSIGHTS` and `PRISM_MCP_SYNC_WAIT_MS` into the container. The periodic pass repairs orphans/broken links and merges duplicates; it only calls the LLM when cheap checks find something to fix, and the first run is one interval (6 h) after boot. Set `DREAM_INTERVAL=` (empty) in `.env` to turn it off. The same commit adds the optional `BUNDLE_HOST_PATH` volume override (default unchanged).
3. **Link hints** (`3c2cd5e`). `concept_write`/`concept_patch`/`concept_supersede` over MCP append a second text block `HINT: {...}` when the concept just written has no links, listing candidate concepts for `link_add`. The first block (the result) is unchanged.

No schema or index change, so no reindex is needed.

**Never print, log, echo or commit the auth token.** Read it from the environment or the existing `.env`, use it only in request headers, and never paste it into reports.

## 0. Preflight

1. Work in the sigma checkout of prism.
2. `git status --short`. The checkout is expected to be dirty ONLY under `sample-bundle/` (the live bundle is still bind-mounted from inside the checkout; `docs/sigma-bundle-move.md` fixes that in a separate step, do it after this update). Anything dirty outside `sample-bundle/`, in particular `docker-compose.yml` or `.env.example`, means stop and report; do not stash, discard or edit those files.
3. Check the incoming change does not touch your dirty files:
   ```
   git fetch origin
   git diff --name-only HEAD..origin/main
   ```
   Expected: `docker-compose.yml`, `.env.example`, `README.md`, files under `packages/server/` and `docs/`. If anything under `sample-bundle/` appears, stop and report.
4. Record the starting state:
   - `git rev-parse --short HEAD` (expect `b410b6c`)
   - `docker compose ps` (prism container healthy)
   - the concept count from `memory_status` (write it down; do not assume it)
   - a checksum manifest of the bundle:
     ```
     cd sample-bundle && find . -path ./.prism -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > "$HOME/bundle-before-3c2cd5e.sha256"; cd ..
     ```
5. Tag the running image for rollback:
   `docker tag "$(docker compose images -q prism)" prism:pre-update-3c2cd5e`

## 1. Pull

```
git checkout main
git pull --ff-only origin main
git rev-parse --short HEAD    # must print 3c2cd5e (or a descendant)
docker compose config | grep -E 'DREAM|SYNC_WAIT|source:'    # DREAM_INTERVAL: 6h, source: still the sample-bundle path
```

If `--ff-only` fails, stop and report. Do not merge, reset or stash.

## 2. Build and restart

The build takes a few minutes. Run it detached or with a long timeout, writing output to a log file you can read back.

```
docker compose build --no-cache
docker compose up -d
docker compose ps        # wait until the prism container reports healthy
docker compose logs prism | grep -i dream    # expect: "dreaming: every 6h"
```

## 3. Verify

Use the token from the environment; never print it. MCP calls are JSON-RPC POSTs to `http://<sigma>:3800/mcp` with headers `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`. The server is stateless (no session id needed). Time each call.

1. **Health and count:** container healthy, concept count equals step 0, `conformant: true`. Search works: one `concept_search` for a known term returns a hit.
2. **New surface present:**
   - `tools/list` includes `memory_job` (22 tools total, was 21).
   - `memory_status` contains a `jobs` object (`running: 0`, a `recent` array).
   - The `initialize` response's `instructions` text contains `FALLBACK ONLY: memory_query, memory_add and memory_update` and mentions `concept_patch` before `memory_add`.
3. **Link hint (direct write):** call `concept_write` with
   `{"path":"/tests/hint-check.md","frontmatter":{"type":"Test","title":"Hint check","description":"Throwaway update check"},"body":"update check","log_summary":"update check"}`.
   - **Pass:** the reply has two content blocks. Block 1 parses to exactly `{"written":"/tests/hint-check.md"}`; block 2 starts with `HINT:` and its `warning` says the concept has no links.
   - Then `concept_delete` it (path `/tests/hint-check.md`, log_summary "remove update check"). Confirm the concept count is back to the recorded number.
4. **Fast path unchanged:** call `memory_query` with `{"question":"What APIs are documented?"}`. Either outcome is a PASS: a normal cited answer inline, or `Accepted: memory_query ...(job <id>)` within about 21 s followed later by the answer from `memory_job`. It must not take more than about 25 s to respond, and must not error.
5. **Slow path, the point of the jobs change:** call `memory_maintain` with `{}` (normally about 60 s on this bundle).
   - **Pass:** the call returns within about 25 s with `Accepted: memory_maintain is still running in the background (job <id> ...)`.
   - Immediately call `memory_maintain` again with `{}`. **Pass:** the reply names the SAME job id and no second run starts.
   - Call `memory_job` with `{"job_id":"<id>"}`: while running it says `still running`; poll every 5 to 10 s (up to 5 minutes) until it returns the final maintenance summary. `memory_status` `jobs.recent[0]` should show `state: "done"` and `jobs.running` should be 0.
   - If maintain finishes inside the budget (inline result), that is also acceptable; record the elapsed time.
6. **Nothing unexpected written:** regenerate the checksum manifest into `$HOME/bundle-after-3c2cd5e.sha256` the same way as in step 0 and `diff` the two. `log.md` and `index.md` will differ (the steps above log their runs). Any change to another concept file means maintain edited it: report which file and the diff, do not revert it.
7. **memory_job error path:** `memory_job` with `{"job_id":"00000000"}` returns an error saying there is no such job.
8. Optional: `docker compose exec prism node packages/server/bin/prism reindex /bundle` succeeds.

Do not run a live `memory_add` test on this bundle: its agent decides where to file content and may patch an existing concept, which cannot be cleanly undone from here.

Note for the report: the scheduled pass makes its first run about 6 hours after the restart. If it edits the bundle then, `log.md` records it; that is expected, not an anomaly.

## 4. Rollback (only if one of these happens)

- the build fails
- the container is not healthy within about 2 minutes of `up -d`
- the concept count differs from step 0
- search fails
- the `concept_write` reply has no second `HINT:` block, or its first block differs from `{"written": ...}`
- the slow-path call does not return within about 30 s, or `memory_job` never reaches a final state within 5 minutes
- the duplicate call starts a second job

Rollback:

```
docker tag prism:pre-update-3c2cd5e <the image name compose uses>
git checkout b410b6c     # detached is fine; report it
docker compose up -d
```

Then re-run verification step 1 and report what failed, with the relevant log lines (no secrets).

## 5. Report back

Write a short report to `docs/sigma-prism-update-3c2cd5e-result.md` containing: starting and ending commit, concept count before and after, pass/fail for each verification step, the measured response times for steps 4 and 5 (first call, duplicate call, total time until the job finished), the checksum diff result, whether `dreaming: every 6h` appeared in the logs, and any anomalies. Do not include the token, and do not commit or push from sigma.
