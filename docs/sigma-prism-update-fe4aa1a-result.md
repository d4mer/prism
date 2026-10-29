# sigma Prism update fe4aa1a — result (PRISM-67 verification)

Executed 2026-10-29 per `docs/sigma-prism-update-fe4aa1a.md`. **All steps PASS.** No commits or pushes made from sigma.

## Commits and images

| | before | after |
|---|---|---|
| checkout | `aa1dcbb` (already pulled — `fe4aa1a` + docs on top; ff to origin/main, working tree clean apart from `sample-bundle/` and my uncommitted result docs) | unchanged `aa1dcbb` |
| running image | `fae615fde739` (daf17b9 build) | `0ee607713bb5` (aa1dcbb build, `--no-cache`) |
| rollback tag | `prism:pre-update-fe4aa1a` → `fae615fde739` | — |

Note: sigma's checkout was already at `aa1dcbb` before this run (Ed's pull), so no pull step was needed; the running container was still the old build. Build took ~100 s.

## 1. Healthy after recreate — PASS
`prism-prism-1 Up (healthy)`; `memory_status`: conformant true, 0 warnings, index `stale:false`, watcher `watch`, 4 concepts (6 during the fixture window). Unauth probe → 401 (auth intact across recreate; token never printed).

## 2. The ticket query — PASS
Fixture created through Prism: target `/tests/embed67/safety-stock-policy.md` ("Reducing inventory buffers at a distribution centre") + unrelated decoy `/tests/embed67/decoy-espresso-grinder.md`. `maintain --only=embed`: 2/2 embedded, 6/6 coverage.

`concept_search "cutting safety stock in the warehouse"` — **target first on both builds; the fix is visible in the scores** (every document lost exactly 24.0 points of stopword noise):

| path | OLD build score | NEW build score |
|---|---|---|
| /tests/embed67/safety-stock-policy.md | 73.77 | **49.77 (1st)** |
| /playbooks/oncall-billing.md | 38.14 | 8.14 |
| /apis/billing-api.md | 37.38 | 7.38 |
| /fun-facts/roman-empire-concrete.md | 35.79 | 6.79 |
| /tests/embed67/decoy-espresso-grinder.md | 32.94 | 7.94 |
| /tables/customers.md | 12.08 | 8.08 |

On the old build the decoy scored 32.9 with **zero** real query terms (pure `in`/`the` substring noise) — the PRISM-67 symptom, measured. Gap to #2 widened 35.6 → 41.6.

Caveat on reproduction: this recreation of the PRISM-37 fixture ranks first even on the old build (the original PRISM-37 fixture body evidently matched fewer query terms; the packet's "target ranks 4th on old build" was not reproduced verbatim). The fix is proven by the noise collapse above rather than by a rank change.

`"reduce safety stock warehouse"` (stopword-free): target first, scores **byte-identical old vs new** (49.566894864637064 / 7.30 / 6.67) — non-stopword queries provably undisturbed.

All-stopword fallback: `"in the of"` returns results (fallback to unfiltered terms), no empty/error.

## 3. Known-term queries + embedder degradation — PASS
- `billing charge failures on-call` → oncall-billing (68.8) > billing-api (43.8) ✓
- `roman concrete seawater` → roman-empire-concrete (65.9) ✓
- `customers dimension table partitioning` → customers (52.1) ✓
- `EMBEDDING_API_BASE_URL` → dead port `127.0.0.1:59999`, recreate: keyword search returns correctly (roman concrete, score 53, clean error-free). Restored URL, recreated: semantic scores identical to pre-degradation (49.566894864637064) — vectors survived both recreates (daf17b9 behaviour holding).

## 4. Cleanup — PASS
Both fixtures deleted through Prism; `/tests/embed67/` pruned; count back to **4**, conformant true.

## 5. Bundle integrity
Manifest `~/bundle-before-fe4aa1a.sha256` (33 files) vs after: **only `log.md` differs** (fixture audit entries). No concept or index content change; `.prism/` excluded as derived.

## Anomalies / notes
- Bundle had pre-existing drift from earlier test sessions (`apis/index.md` pruned by startup, `zz-prismtest/` removed earlier, `fun-facts/` untracked) — nothing this run introduced.
- Dream scheduler remains active on prod (bundle baseline `.traces` grow between runs); relevant for the cutover freeze (H.1), noted in the rehearsal report.
- PRISM-67 can move to Done on the Plane board; the stopword weakness in the client-facing notes (cutover G difference #5) should be amended: natural-language queries now rank correctly.
