# Update Prism on sigma to fe4aa1a and verify PRISM-67 (stopword query noise)

Audience: the agent that manages sigma. Target: `fe4aa1a` on `main` of `d4mer/prism`. Same procedure and safeguards as `docs/sigma-prism-update-daf17b9.md` (preflight, manifest before/after, tag the running image for rollback, ff-only pull, `build --no-cache`, `up -d`, no commits or pushes from sigma). **Never print the auth token or the embedding key.**

What changed: query terms now drop a small English stopword list (and single characters) in one shared function used by both the scan and the derived index. A query made only of stopwords falls back to the unfiltered terms. `SEMANTIC_WEIGHT` is unchanged. No schema or markdown change; no reindex needed.

## Verify
1. Healthy, concept count unchanged, `conformant: true`.
2. **The ticket's query.** Recreate the PRISM-37 fixture (target "reducing inventory buffers at a distribution centre", an unrelated decoy, both under `/tests/embed67/`), run `maintain --only=embed`, then `concept_search` for `cutting safety stock in the warehouse`. **Pass:** target ranks first. Record the ordered paths and scores. Also run `reduce safety stock warehouse` and confirm it still ranks the target first.
3. **Non-embedding ranking undisturbed.** Run 3 known-term queries on the real concepts and confirm top results are sensible; with `EMBEDDING_API_BASE_URL` pointed at a dead port, confirm the keyword path still returns results.
4. Delete the fixture through Prism and confirm the count is back.
5. Report in `docs/sigma-prism-update-fe4aa1a-result.md`: commit/image before and after, the ordered results from step 2 (old build too if you ran it first), pass/fail per step, anomalies.
