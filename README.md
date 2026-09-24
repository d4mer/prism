# Prism 🌱

**Memory that grows.**

The layer beneath your agents: a self-wiring, plain-markdown memory. Every fact your agents learn is filed as a markdown concept, cross-linked into a living knowledge graph, and kept healthy by the agent itself — searchable, diffable, and entirely yours. Runs great on local models.

Bundles follow the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — plain markdown files with YAML frontmatter, readable by humans, diffable in git, portable across tools.

**Three ways in, one agent — and a granular tool surface that needs no agent at all:**

- **MCP server** — two tiers of tools over stdio or streamable HTTP, no LLM required to start the server or use the first tier:
  - **Granular (zero LLM, ever):** `concept_search` / `concept_read` / `concept_list` / `graph_lint` / `concept_related` / `concept_write` / `concept_patch` / `concept_delete` / `link_add` / `concept_supersede` / `concept_as_of` / `concept_capture` / `changes_since` / `open_items` / `concept_template` / `review_queue`. A capable calling agent files knowledge itself, one round trip per action — no server-side model involved at any point.
  - **Coarse (needs a provider):** `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain`. Convenience for weaker clients — each call drives an internal LLM agent (with the OKF spec in its system prompt) that ends up calling the same granular tools above. `memory_status` is deterministic and needs no provider.
- **Web UI** — browse the bundle (tree, concept viewer, update log, conformance badge), see the memory as an Obsidian-style **force-directed graph** (drag/pan/zoom, colored by type, sized by connections, orphans ringed red, click to open), and chat with the same agent to test it. Tool calls render inline so you can watch it work.
- **Query-path replay** — every agent run (query/mutation/chat) records its traversal (searches → reads → writes) as a compact notation, persisted under `<bundle>/.traces/`. The graph view lists recent runs; selecting one replays the path as numbered directed hops over the graph — visited concepts ringed, search hits dotted, everything else faded.
- **CLI** — `pnpm agent:query "..."` / `pnpm agent:mutate "..."` smoke entries.

**Design rule: conformance is enforced in code, not prompts.** The deterministic bundle layer validates frontmatter (`type` required), regenerates `index.md` files, appends `log.md` entries (newest-first, spec §7), and sandboxes all paths to the bundle root. The LLM decides *what* to change; the code guarantees the result is a conformant bundle.

## Quick start (Docker)

**Prerequisites: Docker only** — no Node, no pnpm, nothing else installed on your machine. Docker itself does the build.

```bash
git clone https://github.com/d4mer/prism.git
cd prism
docker compose up --build -d
```

That single command builds the image from source (the multi-stage [Dockerfile](Dockerfile) — pnpm install/build happens inside the container) and starts it with no required environment variables: every `LLM_*` and `EMBEDDING_*` var in [docker-compose.yml](docker-compose.yml) defaults to empty, and the instance comes up fully usable — search, read, write, the web UI, the graph view — with zero external API keys configured (LLM/embeddings only add the agent-chat and semantic-search layers on top). `docker compose ps` reports it `healthy` once `/` answers (see the Dockerfile's `HEALTHCHECK`).

Then open **http://localhost:3800**.

**Where your data lives**: the default compose file mounts `./sample-bundle` from the repo into the container at `/bundle` — edit that path in `docker-compose.yml` to point at your own folder (or swap it for a named volume, as `docker-compose.portainer.yml` does) before you start filing real knowledge into it. Whatever you land on, that host path/volume is the actual knowledge base — markdown files, readable and diffable outside Docker entirely.

**Restarting or upgrading**: `docker compose restart` restarts in place. To upgrade to a newer version of Prism itself: `git pull && docker compose up --build -d` (rebuilds from source) for this file, or `docker compose pull && docker compose up -d` (pulls a newer image) for the prebuilt image below — either way the bundle in your mounted volume is untouched.

**Add a model later, no rebuild**: set `LLM_API_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (chat) and/or `EMBEDDING_API_BASE_URL`/`EMBEDDING_MODEL` (semantic search) as environment variables — a `.env` file next to `docker-compose.yml` is picked up automatically — then `docker compose up -d` again. Same image, no rebuild needed, since these are read at container start, not build time.

No clone needed once a release exists: `docker-compose.portainer.yml` pulls the prebuilt `ghcr.io/d4mer/prism:latest` image instead of building locally (published by [.github/workflows/docker.yml](.github/workflows/docker.yml) on every push to `main` and on version tags) — same environment variables, a named volume instead of a bind mount. Point Portainer's Stacks → Add stack → Repository at it, or run it directly:

```bash
docker compose -f docker-compose.portainer.yml up -d
```

### Choosing a provider

The generic provider system supports any OpenAI-compatible or Anthropic-compatible API.
Set `LLM_API_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` and leave `LLM_PROVIDER` unset.

**DeepSeek:**
```bash
LLM_API_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... LLM_MODEL=deepseek-chat
```

**OpenAI:**
```bash
LLM_API_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o
```

**Anthropic (Claude):**
```bash
LLM_API_BASE_URL=https://api.anthropic.com/v1 LLM_API_KEY=sk-ant-... LLM_API_FORMAT=anthropic LLM_MODEL=claude-sonnet-5
```

**Groq:**
```bash
LLM_API_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=gsk_... LLM_MODEL=llama-3.3-70b-versatile
```

**Local llama.cpp:**
```bash
LLM_API_BASE_URL=http://host.docker.internal:8080/v1 LLM_MODEL=
```

> When prism runs in Docker, `localhost` is the container itself, not the
> host — so a llama-server on the host is reached at `host.docker.internal`
> (the compose files above already map it via `extra_hosts`). Running from
> source on the same box as llama-server, use `http://localhost:8080/v1`.

**Local llama.cpp with DeepSeek fallback:**
```bash
LLM_API_BASE_URL=http://host.docker.internal:8080/v1 LLM_MODEL= \
LLM_FALLBACK_API_BASE_URL=https://api.deepseek.com/v1 LLM_FALLBACK_API_KEY=sk-... LLM_FALLBACK_MODEL=deepseek-chat
```

The old `LLM_PROVIDER` + per-provider key env vars still work (backward-compatible) but are deprecated.

Then:

- **Web UI** → http://localhost:3800 — browse the memory, watch the graph, chat with the agent
- **MCP endpoint** → `http://localhost:3800/mcp` (streamable HTTP) — register it in any MCP client:
  ```bash
  claude mcp add --transport http prism http://localhost:3800/mcp
  ```
- Your agent now has `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain`, and gets a seed overview of the memory at every session start.

Teach it something (`memory_add`: "We deploy on Fridays, never Mondays"), then open the graph and watch the concept wire itself in.

## Stack

pnpm monorepo:

| Package | What |
|---|---|
| `packages/core` | OKF bundle layer (zero LLM) + agent (Vercel AI SDK tool loop: search/read/list/write/patch/delete) + provider registry |
| `packages/server` | Express: MCP streamable-HTTP at `/mcp`, stdio bin, REST browse API at `/api/*`, versioned REST + OpenAPI spec + Swagger docs at `/api/v1/*`, streaming chat at `/api/chat`, serves the web build |
| `packages/web` | Vite + React + TS + Tailwind: bundle browser + agent chat (`useChat`) |

Providers are configured through `LLM_API_BASE_URL`, `LLM_API_KEY`, `LLM_API_FORMAT` (`openai` or `anthropic`), and `LLM_MODEL`. Any OpenAI-compatible endpoint (DeepSeek, OpenAI, Groq, OpenRouter, llama.cpp, etc.) works with `LLM_API_FORMAT=openai`; Anthropic-compatible endpoints use `LLM_API_FORMAT=anthropic`. Optional fallback uses the matching `LLM_FALLBACK_*` variables.

### llama.cpp

```bash
# on the inference box — --jinja enables OpenAI-style tool calling
llama-server -m model.gguf --jinja --host 0.0.0.0 --port 8080

# here — no model id needed, it's discovered for llama-server-like local endpoints
LLM_API_BASE_URL=http://inference-box:8080/v1 LLM_API_FORMAT=openai LLM_MODEL= \
BUNDLE_ROOT=./sample-bundle node packages/server/dist/index.js
```

Works behind llama-swap too: discovery prefers the currently **loaded** model so a query doesn't trigger a multi-minute model swap. Pin a specific model with `LLM_MODEL=`.

## From source

```bash
pnpm install
pnpm build
cp .env.example .env   # add your API key

BUNDLE_ROOT=./sample-bundle \
LLM_API_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=sk-... \
LLM_API_FORMAT=openai \
LLM_MODEL=deepseek-chat \
node packages/server/dist/index.js
# → http://localhost:3800  (web UI + /api + /mcp)
```

Or build the container yourself: `docker compose up --build` (the repo's [docker-compose.yml](docker-compose.yml) builds from source and mounts `./sample-bundle`).

Dev mode (server on :3800, Vite HMR on :5180 with proxy):

```bash
BUNDLE_ROOT=./sample-bundle pnpm --filter @prism/server dev
pnpm --filter @prism/web dev
```

## MCP registration (Claude Code / Desktop)

```bash
claude mcp add prism \
  -e BUNDLE_ROOT=/path/to/your/bundle \
  -e LLM_API_BASE_URL=https://api.deepseek.com/v1 \
  -e LLM_API_KEY=sk-... \
  -e LLM_API_FORMAT=openai \
  -e LLM_MODEL=deepseek-chat \
  -- node /path/to/prism/packages/server/dist/mcp/stdio.js
```

Or point an HTTP MCP client at `http://host:3800/mcp`.

### Auth

By default the server is open — fine on localhost or a trusted LAN. Before exposing it anywhere else, set `AUTH_TOKEN`:

```bash
AUTH_TOKEN=$(openssl rand -hex 24)
```

With it set, `/mcp` and `/api` require `Authorization: Bearer <token>` (the web UI stays reachable and prompts for the token). Register authenticated MCP clients with a header:

```bash
claude mcp add --transport http prism http://host:3800/mcp \
  --header "Authorization: Bearer <token>"
```

The stdio transport needs no token — it's a local process spawned by the client, never exposed over the network.

If the server is reachable from outside the machine it's running on (the default `HOST=0.0.0.0` bind) with no `AUTH_TOKEN` set, it logs a loud startup warning — anyone who can reach that address can read *and write* the knowledge base with no credentials. Set `AUTH_TOKEN`, or set `HOST=127.0.0.1` for a setup that's never reachable off-box in the first place.

**Open WebUI auth options** (registering Prism as its MCP server or OpenAPI tool server — see the next section): with no `AUTH_TOKEN` set, register with no auth. With `AUTH_TOKEN` set, use Open WebUI's bearer-token auth field. Prism does not implement OAuth 2.1 itself — if a deployment needs it (e.g. Open WebUI itself is exposed to untrusted users and its admin wants per-user delegated auth rather than one shared bearer token), put an OAuth-aware reverse proxy in front of Prism; a shared bearer token is the supported mode Prism speaks natively.

### Open WebUI

Open WebUI added **native MCP support in v0.6.31**, over **streamable HTTP only** — the exact transport already served at `/mcp` — so registering Prism needs no proxy or adapter of any kind. `mcpo` (the stdio/SSE→OpenAPI bridge) is not relevant here; it only matters for MCP servers that *don't* speak streamable HTTP.

**Admin setup** — Settings → Admin → Integrations → External Tool Servers (admin-only; see below for non-admins):

1. Add server, URL `http://host:3800/mcp`.
2. Auth: `None` if the server has no `AUTH_TOKEN` set (open LAN), or `Bearer` with the token in the Key field if it does — the same `AUTH_TOKEN` used everywhere else in this README, checked by the identical middleware every other adapter goes through (see [Auth](#auth)). Don't pick `Bearer` with an empty Key — Prism, like most MCP servers, rejects that immediately rather than treating it as no auth.
3. Save. Open WebUI discovers the granular tools (`concept_search`, `concept_read`, `concept_list`, `graph_lint`, `concept_related`, `concept_write`, `concept_patch`, `concept_delete`, `link_add`, `concept_supersede`, `concept_as_of`, `concept_capture`, `changes_since`, `open_items`, `concept_template`, `review_queue`) via `tools/list` and can call them directly from a chat — no separate LLM hop on Prism's side, since these are plain deterministic registry operations, not the agent-backed `memory_*` tools.

**Non-admin users**: Open WebUI restricts registering MCP servers to admins. A user granted the **Direct Tool Servers** permission can add their *own* tool server under Settings → Integrations, but only as an **OpenAPI** connection — the connection type is locked, with no MCP option, for personal servers. Point that at `http://host:3800/api/v1/openapi.json` instead (see [REST API & OpenAPI](#rest-api--openapi-apiv1) below) — same registry operations, same auth, just the REST surface rather than MCP.

**Minimum version**: 0.6.31 (native MCP support). Anything older needs `mcpo` in front regardless of what this README says about not needing it.

### REST API & OpenAPI (`/api/v1`)

Every deterministic registry operation (search/read/list/write/patch/delete/link/lint — the same ones MCP exposes) is also available as a plain REST endpoint under `/api/v1`, generated from the tool registry rather than hand-maintained:

```
GET    /api/v1/concepts?prefix=/apis         # concept_list
GET    /api/v1/concepts/search?query=...     # concept_search    (also: type, tags, limit, include_history, scope)
GET    /api/v1/concepts/one?path=...         # concept_read
GET    /api/v1/graph/lint                    # graph_lint
GET    /api/v1/concepts/related?path=...     # concept_related   (also: hops, include_history)
POST   /api/v1/concepts                      # concept_write     (body: path, frontmatter, body, log_summary)
PATCH  /api/v1/concepts                      # concept_patch     (body: path, frontmatter?, replace_section?, replace_body?, log_summary)
DELETE /api/v1/concepts                      # concept_delete    (body: path, log_summary)
POST   /api/v1/links                         # link_add          (body: source, target, label?, log_summary)
POST   /api/v1/concepts/supersede            # concept_supersede (body: old_path, new_path, frontmatter, body, log_summary)
GET    /api/v1/concepts/as-of?as_of=...      # concept_as_of
POST   /api/v1/concepts/capture              # concept_capture   (just {"text"}; files to /inbox — triage with GET /concepts/search?query=&tags=inbox)
GET    /api/v1/changes?since=7d             # changes_since     (also: scope, limit; since = ISO date/date-time or 24h/7d/2w)
GET    /api/v1/items/open                   # open_items        (also: status, owner, scope, overdue_only, limit)
GET    /api/v1/templates?name=decision      # concept_template  (omit name to list; bundle overrides live in /.templates/<name>.md)
GET    /api/v1/review                       # review_queue      (also: scope, inbox_days, stale_days, min_confidence, limit)
```

The spec itself is at `GET /api/v1/openapi.json`; browse it interactively at `/api/v1/docs`. Adding an operation to the registry adds it to both the REST surface and the spec with no separate edit — see `packages/server/src/openapi/`. Regenerate the static file (e.g. for CI diffing) with `pnpm --filter @prism/server run openapi:generate`. The pre-existing read-only browse endpoints (`/tree`, `/search`, `/log`, `/graph`, ...) keep working unversioned at `/api/*` and are also aliased at `/api/v1/*`.

### Seed memory

A client LLM that only sees four bare tool names never gets the instinct to check memory. So at **session start** the server injects a compact overview of what the knowledge base contains (directories, concepts with types + descriptions, recent activity) through both channels that reach the model:

1. the MCP initialize **`instructions`** field (clients like Claude put it in the system prompt), and
2. the **`memory_query` tool description** — the universal fallback every tool-calling client loads.

The seed regenerates fresh for every new session. After `memory_add` / `memory_update` in a long-lived (stdio) session, the tool description refreshes via `tools/list_changed`, so the session sees its own writes. Out-of-band edits (hand edits, other clients) are picked up on the next session.

### Graph health & maintenance

Memory is a graph, not a pile of notes, and graphs rot: concepts go **orphaned** (nothing links to them) and links go **broken**. Two mechanisms keep it healthy:

- **Write-time linking** — new knowledge either enriches the concept it belongs to (an attribute of an existing entity is patched in, not filed separately) or, when it's a distinct entity, is created *and* back-linked from related concepts. Contradictions are superseded in place, never left standing alongside the old value.
- **`memory_maintain`** — a deterministic lint (orphans + broken links, surfaced in `memory_status` under `graph`) drives an internal agent to wire orphans into related concepts and fix dangling links. Run it periodically to counter drift; it's a no-op when the graph is already healthy.

This design mirrors the pattern in Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (index.md + log.md, create-vs-enrich, lint for orphans). Deferred from that pattern until scale warrants: an explicit page-type schema. Search itself now has both halves the original note called out — a derived index and optional hybrid embedding ranking — described next.

### `prism maintain` (cron-drivable, no server required)

`prism maintain <bundle-path>` runs the same graph-repair/consolidation logic as `memory_maintain` plus embedding generation, as a one-shot process any external scheduler can drive — no running server, no LLM required unless a repair/consolidation signal actually fires:

```bash
prism maintain ./my-bundle --dry-run              # preview only, changes nothing
prism maintain ./my-bundle                        # repair + consolidate + embed (default: all three)
prism maintain ./my-bundle --only=embed            # embeddings only
prism maintain ./my-bundle --only=repair,consolidate
```

Exit codes mirror `diff`: `0` no-op (healthy, or nothing stale), `1` changes made (or, for `--dry-run`, changes *would* be made), `2` failure. Output is JSON: `{ dream, embeddings }`, either key present only if its passes were selected.

### Consultant workflow

Tools for someone juggling workshops, workstreams and clients. All of them are deterministic (no model call) and available over MCP, REST and the built-in agent:

- **Capture now, file later.** `concept_capture` takes just the text and files it as `/inbox/YYYY-MM-DD-<slug>.md`, tagged `inbox`. Add `template: "decision"` (or `meeting-note`, `fit-gap`, `requirement`, `interface`, `config-item`) to get that document's structure. `concept_template` lists them, and a bundle can override or add its own in `/.templates/<name>.md`.
- **Get your bearings.** `changes_since` with `since: "7d"` (or a date) reports what was created, updated, superseded or deleted, optionally for one area with `scope: "/emea"`.
- **Keep clients and workstreams apart.** `concept_search` takes `scope: "/clients/acme"`. It matches whole folders, so `/clients/acme-corp` never leaks in.
- **Acronyms.** Add `aliases: ["L2L", "local-to-local"]` to a concept's frontmatter. Either name finds it, and an exact alias match ranks first.
- **Action log.** Give any concept `status` (open | in_progress | blocked | decided | closed), plus optional `owner` and `due`. `open_items` lists what's unresolved, overdue first, filterable by owner or area.
- **Weekly tidy-up.** `review_queue` gives one prioritised list: overdue items, inbox captures left untriaged, low-confidence beliefs, and notes left behind while the rest of their folder moved on.

### Semantic search (optional)

Keyword search (the derived SQLite+FTS index, or the plain scan as a fallback) is the default and requires no configuration. Setting `EMBEDDING_API_BASE_URL` + `EMBEDDING_MODEL` (any OpenAI-compatible `/embeddings` endpoint — OpenAI, Voyage, etc.) turns on hybrid ranking: a query can then surface concepts that share **no literal keywords** with it, the common case for client-specific jargon vs. standard terminology meaning the same thing. Embeddings are generated only by `prism maintain` (never on a search request), are content-hash-gated so an unchanged concept is never re-embedded, and are reported (`embedded` / `failed` / `coverage`) rather than silently assumed — a batch failure shows up in the `prism maintain` output instead of quietly degrading search quality. Leave `EMBEDDING_API_BASE_URL` unset and everything works exactly as it did before — hybrid ranking is strictly additive on top of keyword search, never a replacement for it.

### Concurrent writers and maintenance

The server, a cron-driven `prism maintain` and a second Prism on the same folder can all write to one bundle safely:

- **Every write holds the bundle write lock** (`.prism/locks/write.lock`) for the few milliseconds it takes to write the file, update `index.md` and `log.md`, the index and the optional git commit. Before this, three processes writing at once lost `log.md` entries. The lock costs about 1 ms per write. A write waits up to 15 s for another process, then fails with `LOCKED` (HTTP 503 with `Retry-After`). It is never silently dropped.
- **Maintenance runs never overlap.** `prism maintain`, the server's `DREAM_INTERVAL` dream and `memory_maintain` hold the maintenance lock (`.prism/locks/maintain.lock`) for the whole run. A second run skips straight away, with exit code 0 and `{"skipped": true, "holder": …}` naming who holds it. Maintenance does not block live writes: those still go through between its individual writes. `--dry-run` only reads and takes no lock.
- **Crashed runs don't block anything.** A lock whose process has died on the same machine is taken over immediately. Otherwise a lock counts as abandoned once its heartbeat is older than 10 minutes (maintenance) or 30 seconds (write). Holders refresh the heartbeat while they work. Acquisitions, releases and takeovers of the maintenance lock are logged.
- **No lost updates.** When the built-in agent (memory_add, memory_update, maintenance) reads a concept and later writes it, the write is refused with `CONFLICT` (HTTP 409) if someone else changed the file in between. The agent re-reads and re-applies its change instead of overwriting yours. `link_add` guards its own read-and-rewrite of the source concept in the same way.

### Editing files outside Prism

Concepts are plain markdown, so edit them in Obsidian or VS Code, or `git pull` a colleague's changes. Nothing needs restarting. The search index checks the files against content hashes: once at startup (catching anything changed while Prism was down), then continuously through a file watcher. A burst of changes such as a large checkout is batched into one reindex. Unchanged files are never rewritten, and a periodic safety pass covers setups where file events don't arrive. `GET /api/v1/index/status` (also inside `memory_status`) shows whether the index matches the files right now. Where the watcher can't work, `INDEX_WATCH=false` switches to polling every `INDEX_POLL_INTERVAL` (default `60s`).

## Tests

```bash
pnpm install                               # first run on a mounted/FUSE filesystem? see .npmrc — package-import-method=copy avoids an EPERM on install there
pnpm test                                  # core (262 tests) + server (29 tests): spec, registry, sandbox (incl. symlink escapes), search + hybrid embedding ranking, graph-neighbor retrieval, quick capture, what-changed digest, workstream-scoped search, alias/acronym search, open items, templates, review queue, index freshness under external edits, cross-process locking, temporal/supersession, derived index, maintain CLI, concurrency, conformance property tests, OpenAPI, unified auth, streamable-HTTP MCP client (Open WebUI-equivalent)

# Manual/exploratory checks — no LLM required for either of these:
pnpm --filter @prism/server exec tsx scripts/registry-smoke.mts   # CORE_TOOLS registry CRUD round-trip against a throwaway bundle copy
SMOKE_BUNDLE=/path/to/bundle pnpm --filter @prism/server exec tsx scripts/mcp-smoke.mts   # MCP stdio round-trip; runs fully with no provider configured (memory_query is skipped unless OPENROUTER_API_KEY is set)
```

Starting the server itself needs only `BUNDLE_ROOT`:

```bash
pnpm --filter @prism/server build
BUNDLE_ROOT=./sample-bundle PORT=3800 pnpm --filter @prism/server start
# → http://localhost:3800  (web UI + /api + /mcp) — Tier 0/1 tools (memory_status,
#   a healthy memory_maintain, and the registry ops) work immediately; memory_query/
#   memory_add/memory_update return a clear "no LLM configured" result per-call until
#   LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL are set.
```

## Environment

See [.env.example](.env.example). `BUNDLE_ROOT` is required; `GIT_AUTOCOMMIT=true` commits every mutation.
