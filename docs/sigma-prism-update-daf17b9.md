# Update Prism on sigma to daf17b9 and verify PRISM-68 (reindex keeps embeddings)

Audience: the agent that manages sigma. Sigma currently runs image `738379c615ee` (built from `3c2cd5e`). The target is `daf17b9` on `main` of `d4mer/prism`.

What changed: `prism reindex` (and any rebuild of the derived search index) used to delete the index file and with it every stored embedding. Search then ran keyword-only until `maintain --only=embed` was run again, and that pass re-embedded the whole bundle and paid the provider for it. Now a rebuild reads the still-valid vectors out of the old index first and restores each onto the row whose content is unchanged. An edited or removed concept loses only its own vector. `prism reindex` now prints `embeddingsKept` and `embeddingsDropped`. No schema change, no markdown change, no new settings.

**Never print, log, echo or commit the auth token or the embedding API key.** Read them from the environment or the existing `.env`, use them only in request headers, and never paste them into reports.

## 0. Preflight

1. Work in the sigma checkout of prism.
2. `git status --short`. Expected dirty paths: only under `sample-bundle/` (and untracked backup files such as `.env.bak-*`, which must never be committed). Anything dirty outside those, in particular `packages/` or `docker-compose.yml`, means stop and report; do not stash, discard or edit.
3. `git fetch origin`, then `git diff --name-only HEAD..origin/main`. Expected: files under `packages/core/` and `docs/`. If anything under `sample-bundle/` appears, stop and report.
4. The bundle may already have been moved out of the checkout. Check with `grep '^BUNDLE_HOST_PATH=' .env`; if it is set, that path (a folder path, not a secret) is the bundle directory wherever this document says `sample-bundle`.
5. Record the starting state:
   - `git rev-parse --short HEAD`
   - `docker compose ps` (prism healthy) and the image id
   - concept count from `memory_status` (write it down, do not assume)
   - a checksum manifest of the bundle:
     ```
     cd <bundle dir> && find . -path ./.prism -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > "$HOME/bundle-before-daf17b9.sha256"; cd -
     ```
6. Tag the running image for rollback:
   `docker tag "$(docker compose images -q prism)" prism:pre-update-daf17b9`

## 1. Establish the embedding baseline BEFORE updating

The old build is the one that loses vectors on reindex, so first confirm the vectors exist.

1. `docker compose exec prism node packages/server/bin/prism maintain /bundle --only=embed`. Expect either `embeddings up to date` or a full embed of every concept. Run it twice if the first one embedded; the second must say up to date. Record `total`, `embedded`, and `coverage`.
2. Save a fingerprint of the stored vectors (this prints hashes only, not vectors):
   ```
   docker compose exec -T prism node -e '
   const {DatabaseSync}=require("node:sqlite");const c=require("crypto");
   const db=new DatabaseSync("/bundle/.prism/search.sqlite3",{readOnly:true});
   const rows=db.prepare("SELECT path,content_hash,embedding_hash,embedding_model,embedding FROM concepts ORDER BY path").all();
   for(const r of rows)console.log([r.path,r.embedding?c.createHash("sha256").update(r.embedding).digest("hex").slice(0,16):"NONE",r.embedding_hash===r.content_hash?"valid":"STALE",r.embedding_model].join("  "));
   ' 2>/dev/null | tee "$HOME/vectors-before-daf17b9.txt"
   ```
   Every line should say `valid`. If any say `NONE` or `STALE`, re-run the embed pass in step 1.1 until they do.
3. (Optional but useful) Confirm the OLD behaviour so the fix is demonstrable: `docker compose exec prism node packages/server/bin/prism reindex /bundle`, re-run the fingerprint, and expect every line to read `NONE`. Then run `maintain --only=embed` again and confirm the fingerprint matches `vectors-before-daf17b9.txt` (same model, same text, so identical vectors). If you skip this step, say so in the report.

## 2. Pull, build, restart

```
git checkout main
git pull --ff-only origin main
git rev-parse --short HEAD    # must print daf17b9 (or a descendant)
docker compose build --no-cache    # about 75 s; log to a file you can read back
docker compose up -d
docker compose ps    # wait for healthy
```

If `--ff-only` fails, stop and report. Do not merge, reset or stash.

## 3. Verify

1. **Health:** container healthy, concept count equals step 0, `conformant: true`, one `concept_search` for a known term returns a hit.
2. **Vectors survived the restart:** re-run the fingerprint into `$HOME/vectors-after-restart.txt`; it must equal `vectors-before-daf17b9.txt`.
3. **The fix: reindex keeps vectors.**
   ```
   docker compose exec prism node packages/server/bin/prism reindex /bundle
   ```
   - **Pass:** the JSON has `embeddingsKept` equal to the concept count and `embeddingsDropped: 0` (the new fields are the proof you are on the new build; if they are absent you are still on the old image, stop).
   - Re-run the fingerprint into `$HOME/vectors-after-reindex.txt`. **Pass:** identical to `vectors-before-daf17b9.txt`, every line `valid`.
   - `maintain --only=embed`. **Pass:** `ran: false`, reason `embeddings up to date`, `stale: 0`, `embedded: 0`.
4. **Search is unchanged by a reindex:** run one `concept_search` for a known term before and after step 3.3 (REST or MCP, token from the environment) and compare the ordered `path` and `score` lists. They must be identical, and the scores must not be pure integers (integer-only scores mean the semantic part is missing).
5. **Edited and removed concepts lose only their own vector.** Use throwaway concepts and clean up through Prism.
   1. `concept_write` two concepts: `/tests/reindex68/a.md` and `/tests/reindex68/b.md` (type `Test`, short distinct bodies, `log_summary` "PRISM-68 check"). Note the concept count N+2.
   2. `maintain --only=embed`; it should embed 2 and report coverage N+2 of N+2.
   3. Edit `a.md` out of band so the index is not told: `docker compose exec prism sh -c 'printf "\nout-of-band edit\n" >> /bundle/tests/reindex68/a.md'`.
   4. `reindex`. **Pass:** `reindexed` is N+2, `embeddingsKept` is N+1, `embeddingsDropped` is 1.
   5. `maintain --only=embed`. **Pass:** `stale: 1`, `embedded: 1` (only `a.md`).
   6. Delete both concepts with `concept_delete` (log_summary "remove PRISM-68 check"). Confirm the count is back to N and `reindex` reports `embeddingsKept` N, `embeddingsDropped` 0.
6. **Degrade case:** with the embedder unreachable, a reindex must still succeed and search must still return keyword results. Point `EMBEDDING_API_BASE_URL` at a dead port in `.env` (for example `http://127.0.0.1:9/v1`), `docker compose up -d`, run `reindex` (expect `embeddingsKept` N, the vectors are simply carried over), run a keyword `concept_search`, then restore the real value, `docker compose up -d`, and confirm the olmx probe from the earlier embeddings run (HTTP 200, 1024 dimensions) still passes. Record the `.env` diff before and after (names and URLs only, never the key).
7. **Nothing unexpected written:** regenerate the checksum manifest into `$HOME/bundle-after-daf17b9.sha256` and diff against the before one. `log.md` and `index.md` will differ (the steps above are logged), and `.traces/` may gain files. Any other concept file changing is an anomaly: report which file, do not revert it.

## 4. Rollback (only if one of these happens)

- the build fails
- the container is not healthy within about 2 minutes of `up -d`
- the concept count differs from step 0
- search fails
- `reindex` output has no `embeddingsKept` field after the update (wrong image)
- `reindex` drops vectors that should have been kept (`embeddingsKept` is less than the concept count on an unchanged bundle), or `vectors-after-reindex.txt` differs from the before file

Rollback:

```
docker tag prism:pre-update-daf17b9 <the image name compose uses>
git checkout 6cbaf03    # detached is fine; report it
docker compose up -d
```

Then re-run step 3.1 and report what failed, with the relevant log lines (no secrets). Note that rolling back restores the old behaviour where a reindex drops vectors, so after any rollback run `maintain --only=embed` once more to restore coverage.

## 5. Report back

Write a short report to `docs/sigma-prism-update-daf17b9-result.md` containing: starting and ending commit and image id, concept count before and after, the embed baseline (total, embedded, coverage), pass or fail for each step in section 3 with the `reindex` JSON output pasted verbatim, whether the fingerprint files matched, the search before and after comparison, the degrade-case outcome, the checksum diff result, and any anomalies. State whether you ran the optional old-behaviour demonstration in step 1.3. Do not include the token or API key, and do not commit or push from sigma.

If everything passes, PRISM-68 can move to Done.
