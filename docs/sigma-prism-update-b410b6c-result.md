# Sigma update result: 1afc29d -> b410b6c (via 19fbab6)

**Date:** 2026-10-27 (Europe/Madrid)
**Operator:** Hermes agent (thinkpad)

## Starting state (step 0)

- Checkout: branch `main`, already at `19fbab6` (docs commit on top of `b410b6c`) — code changes of `b410b6c` were present in the tree but the **running image was still the `1afc29d` build** (`600602e4df73`). Step 1 (pull) was therefore a no-op; `main` == `origin/main`.
- Running container `prism-prism-1`: healthy on image `600602e4df73`.
- Concept count (memory_status): **4** (conformant, 5 directories).
- Rollback tag created: `prism:pre-update-b410b6c` -> `600602e4df73741f...`.

## Deviations from the packet (reported, none destructive)

1. **Preflight git status was not clean:** dirty paths `sample-bundle/index.md`, `sample-bundle/log.md` (+271 lines of legitimate runtime audit log), untracked `sample-bundle/fun-facts/` (real user concept, 2026-09-29) and `sample-bundle/.gitignore`. Verified `git diff --name-only 1afc29d..origin/main` has **zero overlap** with those paths, so `--ff-only` updates could not touch them. Proceeded; nothing stashed or discarded. Root cause: the live bundle is bind-mounted from inside the git checkout (`./sample-bundle:/bundle`), so runtime writes always dirty the tree — consider decoupling bundle from the checkout.
2. **`git rev-parse --short main origin/main` failed inline** (ssh quoting), not a repo problem; branch state confirmed separately.

## Build (step 2)

- `docker compose build --no-cache`: SUCCESS in ~60s, log at `/tmp/prism-build-b410b6c.log`.
- New image: `583f2418e0f8` (`prism-prism:latest`).
- `docker compose up -d`: healthy after ~10s.

## Verification (step 3)

| Check | Result |
|---|---|
| Healthy + new image `583f2418e0f8` | PASS |
| Concept count 4 == 4 (before/after) | PASS |
| `concept_search "billing"` returns hits | PASS |
| Date fix: `/tests/date-check.md` written with bare `due: 2026-09-30` tag, `due: 2026-10-05`, patched via `concept_patch` | PASS |
| File after patch still has bare `due: 2026-10-05` + `- 2026-09-30`; zero `T00:00:00` occurrences | PASS |
| `open_items` saw the hand-typed date: due 2026-10-05, overdue 22 days | PASS |
| Cleanup: fixture deleted via `concept_delete`; `/tests/` auto-pruned; count back to 4 | PASS |
| Optional: `prism reindex /bundle` succeeded (75 ms); post-reindex status stale:false, pending_changes:0, watcher:watch | PASS |

Note: the patch added `timestamp: '2026-10-27T19:41:21.820Z'` — Prism's by-design change marker, not a frontmatter-date rewrite.

## Rollback

Not needed. Available: `docker tag prism:pre-update-b410b6c prism-prism:latest && docker compose up -d`.

No commits or pushes were made on sigma.
