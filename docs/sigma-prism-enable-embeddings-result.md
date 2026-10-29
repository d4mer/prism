# PRISM-37 live verification: embeddings on sigma (result)

**Date:** 2026-10-29 (Europe/Madrid)
**Operator:** Hermes agent (thinkpad)
**Build:** image `738379c615ee` (3c2cd5e), no rebuild performed — env-only, as instructed.

## Step 0 — already configured: PASS (skip step 1)

`.env` already sets `EMBEDDING_API_BASE_URL=http://192.168.1.190:1234/v1` (olmx on macbookm1), `EMBEDDING_MODEL=bge-m3-mlx-fp16`, `EMBEDDING_API_KEY` (length 4). Container env verified non-empty via test -n checks; model echoed `bge-m3-mlx-fp16`.

## Step 2 — embedder reachable from container: PASS

Node one-liner inside the container: **HTTP 200, vector length 1024**. Re-confirmed after the step-5 restore (200, 1024).

## Step 3 — generate embeddings: PASS

`maintain /bundle --only=embed` run A: `configured: true`, 4 concepts, embedded 4/4, failed 0.
Repeat run: **`ran: false, reason: "embeddings up to date", stale: 0, embedded: 0`** — zero provider calls (content-hash gated). Derived search index was created by this step at this bundle size (expected per packet note).

## Step 4 — semantic retrieval: PASS (with an important finding)

Fixtures created (both under `/tests/embed/`, both later deleted):
- `/tests/embed/target.md` — "shrink holding quantities of spare components at the regional goods depot…" (deliberately shares no vocabulary with the probe query)
- `/tests/embed/decoy.md` — unrelated design-guild meeting notes

`maintain --only=embed` embedded both (coverage 6/6).

**Finding first:** the packet's example query `cutting safety stock in the warehouse` did NOT rank the target first (target #4). Diagnosis with source (`search-index.ts`): query terms are whitespace-split with **no stopword filtering**, so 2-letter terms like "in"/"the" become substring keyword matches against nearly every doc; the additive `SEMANTIC_WEIGHT = 20` cap is swamped by that keyword noise. Raw oMLX cosine for the same vectors ranks the target #1 (0.60 vs 0.39 for the playbook), proving embedder correctness and isolating the issue to hybrid scoring. Suggested follow-ups (not applied): stopword filtering or min-term-length in query splitting, and/or re-tuning SEMANTIC_WEIGHT.

Clean-query retest per the packet's own allowed method ("words that provably do not appear in either note"): query `reduce safety stock warehouse` — grep proves 0 substring occurrences anywhere in bundle concepts. Result: **target ranks #1 (score 10.34 = pure semantic, cos ≈ 0.517 × 20); decoy 6.73 does not outrank it.** PASS.

## Step 5 — degrade check: PASS

`EMBEDDING_API_BASE_URL` pointed at a dead port (`127.0.0.1:9/v1`), container recreated:
- keyword search (`billing`) still returns correct results, no errors;
- semantic-only query returns `hits: []` with no error plus the new user-facing notice "No keyword matches — but this search is literal, not semantic…";
- real value restored, step 2 probe passes again (200/1024), and the clean-query ranking reproduces target #1 unchanged (vectors persist across recreate in the .prism index).

## Cleanup

Created and deleted through Prism: `/tests/embed/target.md`, `/tests/embed/decoy.md`. Concept count back to **4**; conformant true.

## Anomaly notes for the dev agent

- `prism reindex /bundle` invalidates every stored embedding (`maintain --only=embed` then reports `stale: 6` and re-embeds everything, provider calls included). Order matters: embed AFTER reindex, or search silently runs keyword-only in between. Observed live: after a reindex, semantic scores vanished (integer keyword-only scores) until re-embed.
- `.traces/*.json` files appear in the bundle during LLM-backed tool runs (also seen in the 3c2cd5e update); the bundle-move procedure should carry/gitignore them.
- Session clock confusion: container/host/index timestamps all agree (NTP, 2026-10-29 UTC at run time); no skew.
