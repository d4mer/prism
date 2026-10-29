# Sigma update result: daf17b9 (PRISM-68 — reindex keeps embeddings)

**Date:** 2026-10-29 (Europe/Madrid)
**Operator:** Hermes agent (thinkpad)

## Commits and images

- Start: checkout main `14a66b0` (contains daf17b9 — repo owner had already fast-forwarded sigma; `git pull --ff-only` no-op, ancestry verified via merge-base), running image `738379c615ee` (3c2cd5e build).
- End: HEAD `14a66b0` (descendant of daf17b9), new image `fae615fde739`, healthy ~20s after up -d.
- Rollback tag kept: `prism:pre-update-daf17b9` -> `738379c615ee`.

## Embed baseline (step 1, old build)

maintain --only=embed: `configured: true`, total 4, stale 0, embedded 0 ("embeddings up to date"), coverage 4/4.
Fingerprint (`vectors-before-daf17b9.txt`): 4 rows, all `valid`, model bge-m3-mlx-fp16, hashes c4a80c1d…/6b0ccf6a…/1ad97e8e…/508f1536….

**Step 1.3 (optional old-behaviour demo): RUN.** On the old build `prism reindex` output `reindexed: 4` and every fingerprint row became `NONE`/`STALE` — bug reproduced live. Re-embed (`stale: 4, embedded: 4`) reproduced the fingerprint byte-identically (deterministic embeddings for same model+text).

## Verification (step 3)

| Step | Result |
|---|---|
| 3.1 health, count 4==4, conformant, search hit | PASS |
| 3.2 vectors survived restart (after-restart == before) | PASS |
| 3.3 reindex keeps vectors | PASS |
| 3.4 search identical before/after reindex | PASS |
| 3.5 edited/removed lose only their own vector | PASS |
| 3.6 degrade: reindex + keyword search with dead embedder; restore | PASS |
| 3.7 checksum diff | PASS |

3.3 verbatim (new build):
```
{
  "reindexed": 4,
  "ms": 81,
  "embeddingsKept": 4,
  "embeddingsDropped": 0
}
```
`vectors-after-reindex.txt` identical to before, every line `valid`. `maintain --only=embed` afterwards: `ran: false`, `reason: "embeddings up to date"`, `stale: 0`, `embedded: 0` — zero provider calls (old build forced a full 4-vector re-embed at this point).

3.4 `concept_search "billing"` before and after reindex: identical ordered paths and scores to 14 decimal places (40.345105108755064 / 35.55296705563724 / 12.840370046388266 / 6.231846980553931) — non-integer, so the semantic component is present both times.

3.5 fixtures `/tests/reindex68/a.md` and `/tests/reindex68/b.md`: embed -> coverage 6/6 (2 new); out-of-band append to a.md; reindex: `reindexed: 6, embeddingsKept: 5, embeddingsDropped: 1`; embed: `stale: 1, embedded: 1` (only a.md). Both deleted via concept_delete; final reindex: `reindexed: 4, embeddingsKept: 4, embeddingsDropped: 0`.

3.6 with `EMBEDDING_API_BASE_URL=http://127.0.0.1:9/v1` (recreated): reindex still succeeds (`reindexed 4, kept 4, dropped 0` — carry-over needs no provider); keyword search returns correct hits, integer scores, no error. Real URL restored: olmx probe from container **200, 1024 dims**; fingerprint identical to before-file. Operational note: the fingerprint helper lives in the container's /tmp and vanishes on recreate — first restore check falsely reported a mismatch until the helper was re-copied; not a product issue.

## Bundle integrity

Checksum diff: only `log.md` changed (expected — each step logs its run). No concept files edited; no new `.traces/` files this run (no LLM-backed tools invoked).

## Anomalies

None beyond the 3.6 operational note. Optional step 1.3 was run, so the old bug and the fix are both demonstrated on the same bundle with byte-identical fingerprints. **PRISM-68: all pass criteria met — can move to Done.**
