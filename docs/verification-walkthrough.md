# Prism verification walkthrough

About 25 minutes, in two parts: a **quick pass** (about 12 minutes, 14 tickets) and **deeper checks** (about 13 minutes). Each check ends with a *Passes if* line. When a check passes, move its ticket from **Awaiting Verification** to **Done** in Plane. If something differs from what it says, leave the ticket where it is and add a comment saying what you saw.

Everything runs against a **throwaway sample bundle** that a helper script builds in your temp folder (an "APO to OMP" engagement with decisions, actions, a belief that changed, a stale note and an untriaged capture). None of your own bundles are touched.

| Check | Tickets | Time |
|---|---|---|
| 1. Tests and CI | 42, 43 | 1 min |
| 2. Works with no model configured | 11, 14 | 1 min |
| 3. Belief history | 22, 23, 24 | 2 min |
| 4. Related concepts | 47 | 30 s |
| 5. Quick capture | 52 | 1 min |
| 6. What changed | 53 | 30 s |
| 7. Search by workstream | 54 | 30 s |
| 8. Acronyms | 55 | 30 s |
| 9. Open items | 56 | 1 min |
| 10. Templates | 57 | 1 min |
| 11. Review queue | 58 | 30 s |
| 12. The search index | 35, 36 | 3 min |
| 13. Maintenance and locking | 26, 27 | 3 min |
| 14. Provenance backfill | 25 | 2 min |
| 15. Speed | 59, 43 | 2 min |
| 16. Embeddings (optional, needs an API key) | 37 | 3 min |
| 17. Docker (only on a machine with Docker) | 49 | 3 min |

## Setup (3 minutes)

You need Node 22.5 or newer, `curl` and `python3` (python is only used to pretty-print JSON). From the repo folder:

```bash
pnpm install && pnpm -r build
node scripts/verify-walkthrough.mjs start
```

The last command prints two `export` lines. Paste them into the terminal you'll use for the checks, then define a small helper for readable output:

```bash
pj() { python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin), indent=1))'; }
```

The sample server listens on port 3899 (`PRISM_VERIFY_PORT` changes it). `node scripts/verify-walkthrough.mjs stop` stops it, and `start` always builds a fresh sample.

---

# Part 1: Quick pass

## 1. Tests and CI (PRISM-42, PRISM-43)

```bash
pnpm test
```

**Passes if** it ends with core `310 passed` and server `34 passed` (the numbers grow as tests are added; there must be no failures).

Then open the repo's **Actions** tab on GitHub. If it offers a button saying *I understand my workflows, go ahead and enable them*, click it (Actions is off on forks until you do). After enabling, the **CI** workflow should run on the next push and show two jobs: **Invariants** and **Tests**.

**Passes if** `pnpm test` is green here. The CI workflow itself has never run on GitHub; its first run on macOS and Windows is informational.

## 2. Works with no model configured (PRISM-11, PRISM-14)

```bash
S=${B%/api/v1}
H='-H content-type:application/json -H accept:application/json,text/event-stream'
time curl -s $H -X POST $S/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}' | pj | head -20
curl -s $H -X POST $S/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_query","arguments":{"question":"what is the safety stock policy?"}}}' | pj | grep -i "llm"
```

**Passes if** `memory_status` answers instantly (well under a second) with `"conformant": true`, and `memory_query` replies with a plain **"No LLM configured…"** message instead of hanging or crashing. The sample server has no model set up, so this is the "no configuration needed" promise. (The status output also says `"healthy": false` with one orphan: that is the untriaged inbox capture in the sample, on purpose. `warnings: 1` is the same thing.)

The audit itself (PRISM-11) is the `llm-dependency-audit` page in your *Memory Graph* project in Claude. Skim its table: every request path should be classified, with `memory_status` marked **Never** (no model).

## 3. Belief history (PRISM-22, PRISM-23, PRISM-24)

The sample has a decision that changed: *Service level target: 95%* was replaced by *98%*.

```bash
# Default search shows only the current belief
curl -s "$B/concepts/search?query=service%20level" | pj | grep -E '"path"|superseded'
# Ask for history: the old one appears, marked superseded
curl -s "$B/concepts/search?query=service%20level&include_history=true" | pj | grep -E '"path"|superseded'
# What did we believe in April? (the old one)
curl -s "$B/concepts/as-of?as_of=2026-04-01" | pj | grep '"path"' | grep service
# Following the chain: the old concept points at its replacement
curl -s "$B/concepts/one?path=/emea/cmo/service-level-target.md" | pj | grep -E 'superseded_by|asserted'
# Superseding was logged as its own kind of entry
grep -n Supersession "$V/log.md"
# The old belief is not counted as an orphan
curl -s "$B/graph/lint" | pj | grep -c service-level
```

**Passes if** the default search returns only `service-level-target-v2.md`; the history search adds `service-level-target.md` with `"superseded": true`; the April query returns the old one; `superseded_by` points at `-v2`; the log has a `Supersession` line; and the last command prints `0`.

Now the validation rules (each should be **rejected with a specific message**):

```bash
curl -s -X POST $B/concepts -H 'content-type: application/json' -d '{"path":"/t1.md","frontmatter":{"type":"Note","asserted":"next tuesday"},"body":"x","log_summary":"x"}'; echo
curl -s -X POST $B/concepts -H 'content-type: application/json' -d '{"path":"/t2.md","frontmatter":{"type":"Note","source":"gossip"},"body":"x","log_summary":"x"}'; echo
curl -s -X POST $B/concepts -H 'content-type: application/json' -d '{"path":"/t3.md","frontmatter":{"type":"Note","supersedes":"/nope.md"},"body":"x","log_summary":"x"}'; echo
curl -s -X PATCH $B/concepts -H 'content-type: application/json' -d '{"path":"/emea/cmo/service-level-target.md","frontmatter":{"supersedes":"/emea/cmo/service-level-target-v2.md"},"log_summary":"x"}'; echo
```

**Passes if** you get four errors: a malformed date (*must be an ISO 8601 date*), an unknown source (*Expected 'session' | 'agent' | 'human' | 'document'*), a dangling reference (*target does not exist*), and a cycle (*would create a supersession cycle*).

## 4. Related concepts (PRISM-47)

```bash
curl -s "$B/concepts/related?path=/emea/cmo/safety-stock-policy.md" | pj | grep -E '"path"|distance'
curl -s "$B/concepts/related?path=/emea/cmo/safety-stock-policy.md&hops=2" | pj | grep -E '"path"|distance'
```

**Passes if** one hop returns exactly the three notes the decision links to (freeze window, master data interface, planning book parameters), all at `distance: 1`, and two hops adds the *Local-to-local supply network* at `distance: 2`, with no duplicates and not the decision itself.

## 5. Quick capture (PRISM-52)

```bash
curl -s -X POST $B/concepts/capture -H 'content-type: application/json' -d '{"text":"Cutover risks\n\nFreeze APO writes 48h before go-live."}'; echo
curl -s -X POST $B/concepts/capture -H 'content-type: application/json' -d '{"text":"Cutover risks\n\nSecond workshop: also freeze master data."}'; echo
curl -s "$B/concepts/search?query=&tags=inbox" | pj | grep '"path"'
```

**Passes if** the two captures return paths like `/inbox/<today>-cutover-risks.md` and `/inbox/<today>-cutover-risks-2.md` (the second did not overwrite the first), and the inbox search lists both (plus the older capture from the sample). Open one in your editor: it should have a title, `source: human`, an `asserted` time, and the tag `inbox`.

## 6. What changed (PRISM-53)

```bash
curl -s "$B/changes?since=1d" | pj | head -40
curl -s "$B/changes?since=30d&scope=/latam" | pj | grep -E '"path"|counts' -A6 | head -12
```

**Passes if** the first call lists what you just did (captures as `created`, the old service level as `superseded` with a pointer to its replacement) newest first, with a `counts` summary; and the scoped call returns only `/latam/lead-times.md`. (The sample's own notes also show as `created`, because the sample was built a moment ago.)

## 7. Search by workstream (PRISM-54)

```bash
curl -s "$B/concepts/search?query=lead%20times" | pj | grep '"path"'
curl -s "$B/concepts/search?query=lead%20times&scope=/latam" | pj | grep '"path"'
```

**Passes if** the first search finds several notes across folders and the scoped one finds only `/latam/lead-times.md`.

## 8. Acronyms (PRISM-55)

```bash
curl -s "$B/concepts/search?query=L2L" | pj | grep -E '"path"|score'
curl -s "$B/concepts/search?query=SSTK" | pj | grep -E '"path"|score'
```

**Passes if** `L2L` puts *Local-to-local supply network* first (its title never contains "L2L"; it is an alias) and `SSTK` finds the safety stock decision, each with a much higher score than any other hit.

## 9. Open items (PRISM-56)

```bash
curl -s "$B/items/open" | pj
curl -s -X POST $B/concepts -H 'content-type: application/json' -d '{"path":"/t.md","frontmatter":{"type":"Action","status":"done"},"body":"x","log_summary":"x"}'; echo
```

**Passes if** two items are listed, **overdue first** (the safety stock decision, owner Priya S., about nine days overdue, then the freeze window, still in progress and not overdue), with a `counts` summary; and `status: done` is rejected with *Expected 'open' | 'in_progress' | 'blocked' | 'decided' | 'closed'*.

## 10. Templates (PRISM-57)

```bash
curl -s "$B/templates" | pj | grep -E '"name"|"source"'
curl -s -X POST $B/concepts/capture -H 'content-type: application/json' -d '{"text":"Go with fixed banding for CMO","template":"decision","folder":"/emea/cmo"}'; echo
```

Open the new file it reports (under `$V/emea/cmo/`).

**Passes if** six built-in templates are listed (config-item, decision, fit-gap, interface, meeting-note, requirement); and the new note is a `Decision` with `status: open`, your text at the top, and the sections *Context*, *Options considered*, *Decision*, *Rationale*, *Consequences* and *Related* below it. Bonus: create `$V/.templates/risk.md` with your own sections and re-run the first command; it should appear with source `bundle` and never show up in search.

## 11. Review queue (PRISM-58)

```bash
curl -s "$B/review" | pj
```

**Passes if** three notes are listed with the highest priority first: the safety stock decision (`overdue` and `low_confidence`), the ten-day-old inbox capture (`untriaged`), and *Old CMO lead time note* (`stale`: untouched for 120 days while its folder has had recent changes). The *2026-09-…-cutover-risks* captures you made a minute ago are **not** listed; they are too fresh.

---

# Part 2: Deeper checks

## 12. The search index (PRISM-35, PRISM-36)

```bash
curl -s "$B/index/status" | pj
```

**Passes if** `indexed` is `true`, `stale` is `false`, `pending_changes` is `0` and `watcher` is `"watch"`.

**Edits outside Prism show up without a restart.** Either open `$V/latam/lead-times.md` in your editor and add the word *zebra*, or run:

```bash
printf '\nLead times now include the zebra corridor.\n' >> "$V/latam/lead-times.md"
sleep 2; curl -s "$B/concepts/search?query=zebra" | pj | grep '"path"'
printf -- '---\ntype: Note\ntitle: Hand written\naliases: [HWN]\n---\nnarwhal corridor\n' > "$V/emea/hand-written.md"
sleep 2; curl -s "$B/concepts/search?query=HWN" | pj | grep '"path"'
```

**Passes if** both are found within a couple of seconds (`/latam/lead-times.md`, then `/emea/hand-written.md`), with no restart. (`reindex` also prints a Node `ExperimentalWarning: SQLite` line. That is harmless noise from Node, not a failure.)

**Delete and rebuild changes nothing.**

```bash
curl -s "$B/concepts/search?query=safety" > /tmp/before.json
rm -rf "$V/.prism"                                   # delete the whole index
curl -s "$B/concepts/search?query=safety" > /tmp/during.json   # still works: reads the files directly
node packages/server/bin/prism reindex "$V"          # rebuild from the markdown alone
curl -s "$B/concepts/search?query=safety" > /tmp/after.json
diff /tmp/before.json /tmp/during.json && diff /tmp/before.json /tmp/after.json && echo IDENTICAL
```

**Passes if** it prints `IDENTICAL`, and `reindex` reported `{"reindexed": …, "ms": …}`. (`prism reindex` is new: the ticket promised a rebuild command but there wasn't one you could run.)

## 13. Maintenance and locking (PRISM-26, PRISM-27)

```bash
P="node packages/server/bin/prism"
# Preview only. The inbox captures are orphans, so this reports something to do:
$P maintain "$V" --only=repair --dry-run 2>/dev/null | pj | grep -E 'dryRun|signalCategories' -A2
# A healthy area is a no-op that needs no model (this is a real run, not a dry run):
DREAM_INSIGHTS=false $P maintain "$V" --only=consolidate 2>/dev/null | pj | grep -E '"ran"|reason'
```

**Passes if** the dry run lists `orphans` and says one signal would trigger a run; the consolidate run says `"ran": false` with *memory healthy* and needs no model. Exit codes are meaningful: run `$P maintain "$V" --only=repair --dry-run >/dev/null 2>&1; echo $?` and it prints `1` ("changes would be made"); the same for the consolidate run prints `0`.

**Two maintenance runs can't overlap** (this pretends another run is in progress):

```bash
node packages/core/test/fixtures/lock-holder.mjs "$V" maintain 8000 > /dev/null &
sleep 1.5
$P maintain "$V" --only=repair 2>/dev/null | pj | head -8; $P maintain "$V" --only=repair > /dev/null 2>&1; echo "exit=$?"
wait
```

**Passes if** you see `"skipped": true` with a reason naming who holds the lock, and `exit=0` (skipping is not a failure).

**Nothing is lost when several things write at once** (two extra writer processes plus 30 simultaneous captures):

```bash
before=$(grep -c '^\* \*\*' "$V/log.md")
node packages/core/test/fixtures/writer-child.mjs "$V" w1 30 > /dev/null 2>&1 &
node packages/core/test/fixtures/writer-child.mjs "$V" w2 30 > /dev/null 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -X POST $B/concepts/capture -H 'content-type: application/json' -d "{\"text\":\"live $i\"}" & done
wait
echo "log entries added: $(( $(grep -c '^\* \*\*' "$V/log.md") - before )) (should be 90)"; ls "$V/.prism/locks" | wc -l
```

**Passes if** it reports 90 entries added and `0` lock files left behind.

## 14. Provenance backfill (PRISM-25)

This one uses your real export, on a copy.

```bash
rm -rf /tmp/real && mkdir /tmp/real && unzip -q understory-bundle-2026-08-30.zip -d /tmp/real
R=/tmp/real/sample-bundle
node packages/core/scripts/backfill-provenance.mjs "$R" > /tmp/backfill-plan.txt; head -12 /tmp/backfill-plan.txt
node packages/core/scripts/backfill-provenance.mjs "$R" --apply | tail -2
node packages/core/scripts/backfill-provenance.mjs "$R" --apply | tail -3
```

**Passes if** the first run (a preview that changes nothing) says 63 concepts were scanned, 15 have a date recoverable from `log.md` and the other 48 get `source: document` with **no invented date**; `--apply` writes the changes; and the second `--apply` says *No changes needed*. Skim `/tmp/backfill-plan.txt`: any `asserted=` date should match the date in that concept's `log.md` entry. The diffs in the plan will also show some cosmetic YAML re-wrapping (long descriptions folded, quote style) because Prism rewrites front matter in its own format; that is expected. One thing to know: a tag written as a bare date (`- 2026-08-26` in `understory-dockerd-recovery.md`) is re-saved as `2026-08-26T00:00:00.000Z`. That is a real wart in how dates are round-tripped, tracked as its own ticket, and is why this runs on a copy.

## 15. Speed (PRISM-59, PRISM-43)

```bash
S=${B%/api/v1}
H='-H content-type:application/json -H accept:application/json,text/event-stream'
for i in 1 2 3; do ( time curl -s -o /dev/null $H -X POST $S/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"concept_search","arguments":{"query":"safety stock"}}}' ) 2>&1 | grep real; done
node scripts/bench-scale.mjs --size=1000 --no-server 2>/dev/null | python3 -c 'import sys,json;t=sys.stdin.read();d=json.loads(t[t.index("{"):]);print("write p50:",d["write"]["p50"],"ms | capture p50:",d["capture"]["p50"],"ms | indexed search p50:",d["search_indexed"]["p50"],"ms | scan search p50:",d["search_scan"]["p50"],"ms")'
```

**Passes if** each MCP search takes well under 100 ms, and on a 1,000-concept bundle a write is roughly under 100 ms and indexed search under 20 ms. Your Mac may differ from my numbers (write about 30 ms, indexed search about 7 ms, plain scan about 330 ms), but a write taking seconds would be the old, slow behaviour. The full tables are in `bench/README.md`.

## 16. Embeddings (PRISM-37) — optional, needs an embeddings API key

Skip this if you don't have a key; it is covered by tests with a stand-in provider. To try it for real, restart the sample with your settings passed through:

```bash
export EMBEDDING_API_BASE_URL=https://api.openai.com/v1   # or Voyage, etc.
export EMBEDDING_API_KEY=sk-...
export EMBEDDING_MODEL=text-embedding-3-small
PRISM_VERIFY_EMBEDDINGS=1 node scripts/verify-walkthrough.mjs start     # then re-export B and V
P="node packages/server/bin/prism"
$P maintain "$V" --only=embed --dry-run 2>/dev/null | pj | grep -E 'stale|coverage' -A3
$P maintain "$V" --only=embed 2>/dev/null | pj | grep -E '"embedded"|"failed"|coverage' -A2
$P maintain "$V" --only=embed 2>/dev/null | pj | grep -E '"ran"|"embedded"'
curl -s "$B/concepts/search?query=cushion%20outsourced%20production" | pj | grep -E '"path"|score' | head -6
```

**Passes if** the dry run reports the concepts as stale without calling the provider; the real run reports `embedded` equal to the concept count with `failed: 0`; the second real run says `"ran": false, "embedded": 0` (nothing changed, so **no provider calls**); and the last search, whose words appear nowhere in any note, still surfaces the safety stock decision. Your search results with no `EMBEDDING_*` settings (start the sample without the flag) fall back to plain keyword search and nothing errors.

## 17. Docker (PRISM-49) — only where Docker is installed

Your Mac has no Docker and the machine I work in can't reach the image registries, so the image build has **not** been run end to end anywhere. If your homelab machine has Docker:

```bash
docker compose config > /dev/null && echo "compose file valid"
docker compose up --build -d
sleep 20; curl -s http://localhost:3800/api/v1/index/status; docker ps --format '{{.Names}} {{.Status}}'
docker compose down
```

**Passes if** the container builds, `docker ps` shows it as `(healthy)`, and the status call answers with no API keys configured. Since the plan is a desktop app rather than Docker, it is fine to leave PRISM-49 in Awaiting Verification for now.

---

## Finish

```bash
node scripts/verify-walkthrough.mjs stop
```

Then update Plane: each check that passed, move its ticket to **Done**. Anything odd, add a comment on the ticket with what you saw.
