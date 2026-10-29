# Cutover day — Legacy server (thinkpad) → Prism (sigma), PRISM-46 phase H

Executed 2026-10-29, 14:56–15:17 Europe/Madrid, per `docs/cutover-to-prism-runbook.md` phase H with Jim's go decisions (dreaming off, carry `.traces/`, fresh production token in 0600 file, orphans untouched, bundle outside checkout by step 5). **Cutover complete; H.8 first-use check pending on Jim.** No commits or pushes from sigma. No token or key printed anywhere this run.

## H.1 freeze / H.2 SOURCE stopped

- Freeze confirmed by check: SOURCE `log.md` and `index.md` byte-identical to the rehearsal manifest (mtimes 2026-10-27 22:41) — no writes since rehearsal.
- `docker stop <legacy container>` at ~14:56 (Exited 137; container, image and bind-mounted bundle all preserved, nothing removed — this is the fallback).

## H.3 final copy

- `rsync -a` → `sigma:~/prism-cutover/final-bundle` (later staged to production path; `.traces/` carried, 50 files).
- Manifest (159 content files) **byte-identical to `source-manifest.sha256`** — zero drift since rehearsal; no write list needed.

## H.4 replay E on the fresh copy

- **E.1:** dry-run only, per go (no real dream). Output identical to what Jim reviewed: 3 signals (orphans, oversized, consolidationInsights), repair+consolidate passes. Recorded, not executed. The 8 orphans remain (accepted decision).
- **E.2:** backfill dry → apply: 139 scanned, 70 `asserted` dates from log.md, 69 `source: document`. Re-run confirmed no-op. Matches rehearsal exactly.
- **E.3:** `maintain --only=embed`: 139/139 embedded, 0 failures, `bge-m3-mlx-fp16`.

## H.5 staging

- Sample bundle moved aside: `~/prism/sample-bundle` → `~/prism-data/bundle-sample-20261029` (preserved).
- Final bundle → production path `~/prism-data/bundle` (outside the checkout); `.env` `BUNDLE_HOST_PATH=/home/maverick/prism-data/bundle`.
- **Fresh production AUTH_TOKEN**: 48 chars, stored `~/prism-data/prism-auth-token.local` (0600) and `.env` (0600). Path + length only, never printed. All previously leaked tokens (legacy bearer, old Prism bearer) are now dead — Prism accepts only the new one (verified: unauthenticated probe → 401).
- `DREAM_INTERVAL=` (empty) → dreaming off on TARGET, per go.
- LLM + embeddings restored unchanged (oMLX on macbookm1).
- `docker compose up -d` → healthy.

## H.6 smoke test (production token from file) — PASS

- `memory_status`: **139 concepts, conformant true**, index 139 concepts, not stale, watcher on, 0 jobs.
- 5 searches, all relevant tops: headscale control plane → `/projects/headscale.md`; saturn ios deploy → saturn build-fixes; llama.cpp vulkan build → vulkan/rocm build docs; glucolog modern → `/projects/glucolog-modern.md`; openclaw routing → routing pitfalls + rebalance.
- 5 reads: `headscale-vps`, `saturn-ios-release-bundle-deploy-path`, `prism` (13 KB), `menarini-glucolog`, `headscale-v0.29-config` — all correct, 4/5 carrying `asserted` provenance (the fifth has `source: document`).
- Throwaway `/tests/cutover-smoke.md` written then deleted; count returned to 139.
- `memory_query` (Headscale): answered inline with correct facts (first attempt went through the async `Accepted`/`memory_job` path on a cold model — expected PRISM behaviour, documented as client difference #1). Embeddings coverage complete.
- Result matches the rehearsal across the board.

## H.7 client switches (name `prism` kept everywhere)

| # | client | time | change | real-call verification |
|---|---|---|---|---|
| 1 | **OpenClaw** (thinkpad) | 15:11 | `mcp.servers.prism.url` → `http://192.168.1.195:3800/mcp`; header → `Bearer ${PRISM_MCP_TOKEN}` (SecretRef; value in `~/.openclaw/gateway.systemd.env`, 0600); gateway restarted (verified by fresh PID/etime) | end-to-end through the gateway API: `openclaw/main` called `prism__memory_query` and returned Prism's verbatim answer |
| 2 | **Hermes** (thinkpad) | 15:15 | `mcp_servers.prism.url` → sigma + `Authorization: Bearer ${MCP_PRISM_API_KEY_NEW}` (`.env`, 0600); `MCP_PRISM_API_KEY` updated to the new token so the existing `prism` entry stays live | `hermes mcp test prism` → connected, 22 Prism tools incl. `memory_job` |
| 3 | **Claude Desktop** (macbookm1) | 15:17 | `prism` args → `http://192.168.1.195:3800/mcp --allow-http` (was broken: pointed at `127.0.0.1:3800`); token in env `PRISM_AUTH` only; duplicate `prism-sigma` entry's stale token refreshed | real MCP `initialize` from the mac with the stored header → HTTP 200. **App restart needed to pick the config up — Jim.** |

Nothing points at thinkpad anymore. Open WebUI has no MCP server configured and was not switched (not a current client); if Jim wants it in the H.8 check, Admin Settings → Connections → MCP Servers: name `prism`, streamable HTTP `http://192.168.1.195:3800/mcp`, auth Bearer with the token from `~/prism-data/prism-auth-token.local`.

## State and rollback posture

- **TARGET live:** Prism on sigma :3800, 139-concept real bundle at `~/prism-data/bundle`, dreaming off, LLM+embeddings on.
- **Fallback intact:** SOURCE container (`docker start <legacy container>`), image, and untouched thinkpad bundle all preserved.
- Prism has already taken writes (smoke fixture + log entries), so rollback would follow the phase-F procedure (copy back excluding `.prism/`, `.traces/` may ride, manifest verify, start SOURCE, repoint clients) — rehearsed at 8.8 s to first answer.
- Bundle provenance on the TARGET: 70 dated `asserted`, 69 `source: document`, orphans 8 (untouched per decision).

## Open items

1. **H.8**: Jim confirms a real end-to-end task on one MCP client (+ Open WebUI if added).
2. Claude Desktop app restart on macbookm1.
3. Dreaming is off — remember to set `DREAM_INTERVAL` when Jim wants consolidation running.
4. Plane PAT rotation still outstanding (unrelated to this cutover but leaked earlier).
5. Current Hermes chat session still holds the pre-cutover tool snapshot; next session picks up the switched `prism` (this session's `mcp__prism__*` calls would hit the stopped SOURCE).
6. Uncommitted on sigma: this file, plus the previous result docs Ed has not yet committed.
