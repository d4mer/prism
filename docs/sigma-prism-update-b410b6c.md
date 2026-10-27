# Update Prism on sigma to b410b6c (PRISM-62 date fix, Node >=22.5)

Audience: the agent that manages sigma. Sigma currently runs `1afc29d`. The target is `b410b6c` on `main` of `d4mer/prism`.

What changed: bare dates in frontmatter (`due: 2026-10-05`, date tags) are no longer rewritten as `2026-10-05T00:00:00.000Z` on save, and hand-typed dates are now seen as text by the due-date and age checks. Nothing else. No schema or index change, so no reindex is needed.

**Never print, log, echo or commit the auth token.** Read it from the environment or the existing `.env`, use it only in request headers, and never paste it into reports.

## 0. Preflight (do not skip)

1. Work in the sigma checkout of prism. `git status` must be clean. If it is dirty, stop and report the diff; do not stash or discard it.
2. Record the starting state to compare against later:
   - `git rev-parse --short HEAD` (expect `1afc29d`)
   - `docker compose ps` (the prism container should be healthy)
   - the concept count from `memory_status` (or `GET /api/v1/...` equivalent). Write the number down. Do not assume 4 or 10.
3. Tag the running image for rollback:
   `docker tag "$(docker compose images -q prism)" prism:pre-update-b410b6c`

## 1. Pull

```
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse --short HEAD    # must print b410b6c (or a descendant)
```

If `--ff-only` fails, stop and report. Do not merge or reset.

## 2. Build and restart

The build takes a few minutes. Run it detached or with a long timeout, and write output to a log file you can read back.

```
docker compose build --no-cache
docker compose up -d
docker compose ps        # wait until the prism container reports healthy
```

`indexed:false` in `memory_status` is expected while the bundle has fewer than 500 concepts. It is not a failure.

## 3. Verify

Use the token from the environment; never print it.

1. **Health and count:** the container is healthy, the commit/image is the new one, and the concept count equals the number recorded in step 0.
2. **Search still works:** run one `concept_search` for a term you know exists and confirm a hit.
3. **Date fix, end to end** (cleans up after itself):
   1. Write a file straight into the bundle, bypassing the API:
      ```
      docker compose exec prism sh -c 'mkdir -p /bundle/tests && printf "%s\n" "---" "type: Note" "title: Date check" "status: open" "due: 2026-10-05" "tags:" "  - 2026-09-30" "---" "first body" > /bundle/tests/date-check.md'
      ```
   2. Wait about 5 seconds for the file watcher, then `concept_patch` (or `concept_write`) that concept, changing only the body text.
   3. Read the file back:
      `docker compose exec prism cat /bundle/tests/date-check.md`
   4. **Pass:** it still contains `due: 2026-10-05` and `- 2026-09-30`, and does NOT contain `T00:00:00.000Z`. `open_items` should list the item with `due` of 2026-10-05.
   5. Delete the test concept with `concept_delete` (through Prism, so `log.md` records it). Confirm the concept count is back to the recorded number.
4. Optional: `docker compose exec prism node packages/server/bin/prism reindex /bundle` should succeed and print `{"reindexed": N, ...}` where N is the concept count.

## 4. Rollback (only if one of these happens)

- the build fails
- the container is not healthy within about 2 minutes of `up -d`
- the concept count differs from step 0
- search fails
- the date check shows `T00:00:00.000Z` was written

Rollback:

```
docker tag prism:pre-update-b410b6c <the image name compose uses>
git checkout 1afc29d     # detached is fine; report it
docker compose up -d
```

Then re-run verification steps 1 and 2 and report what failed, with the relevant log lines (no secrets).

## 5. Report back

Write a short report to `docs/sigma-prism-update-b410b6c-result.md` containing: starting and ending commit, concept count before and after, pass/fail for each verification step, and any anomalies. Do not include the token, and do not commit or push from sigma.
