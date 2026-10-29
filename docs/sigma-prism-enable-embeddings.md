# Enable embeddings on sigma (PRISM-37 live verification)

Audience: the agent on sigma. Goal: turn on the optional embeddings path using the existing olmx embedder, generate vectors, and prove a keyword-disjoint query finds the right concept. Report back in `docs/sigma-prism-enable-embeddings-result.md`.

Rules for this run:

- Never print, log or paste the API key or the Prism auth token. Report only their lengths if needed.
- Do not rebuild the image. Embeddings are configured purely through environment variables.
- Test data you create must be deleted through Prism afterwards (`concept_delete`), and you must list what you created in the result file.

## Placeholders

Fill these from the existing `.env` in the repo root, or from the user if absent. Do not invent values.

Confirmed by Jim (2026-10-29): the embedder is the olmx one, and `.env` on sigma already points at it (`EMBEDDING_API_BASE_URL=http://192.168.1.190:1234/v1`, `EMBEDDING_MODEL=bge-m3-mlx-fp16`). So `.env` probably needs no edit; the work is confirming the container picked the values up and that olmx is reachable from inside it.

| Placeholder | Meaning |
|---|---|
| `<EMBED_BASE_URL>` | OpenAI-compatible base URL of the olmx embedder, ending in `/v1` |
| `<EMBED_MODEL>` | Embedding model name served there |
| `<EMBED_KEY>` | API key, only if olmx requires one (a dummy value is fine if it does not check) |

## Step 0: Check what is already configured

1. In the repo root, check whether `.env` already sets `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_API_KEY` (show variable names and the base URL and model only, not the key). If they are already set to the olmx values, skip step 1.
2. Confirm the running container actually received them. Use a check that does not print the key, for example: `docker compose exec prism sh -c 'test -n "$EMBEDDING_API_BASE_URL" && echo base-set; test -n "$EMBEDDING_MODEL" && echo model-set; echo "$EMBEDDING_MODEL"'`.

## Step 1: Set the variables (only if missing)

Edit `.env`:

```
EMBEDDING_API_BASE_URL=<EMBED_BASE_URL>
EMBEDDING_MODEL=<EMBED_MODEL>
EMBEDDING_API_KEY=<EMBED_KEY>
```

`docker-compose.yml` already passes these three through to the service. Apply with `docker compose up -d` (recreates the container, keeps the bundle volume).

## Step 2: Check the embedder is reachable from the container

From inside the container, request one embedding straight from olmx:

```
docker compose exec prism node -e '
fetch(process.env.EMBEDDING_API_BASE_URL.replace(/\/$/,"")+"/embeddings",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.EMBEDDING_API_KEY},body:JSON.stringify({model:process.env.EMBEDDING_MODEL,input:"ping"})}).then(async r=>{const j=await r.json();console.log(r.status, j.data&&j.data[0]&&j.data[0].embedding.length)})'
```

Pass: HTTP 200 and a vector length printed (record it). If it fails, stop and report the exact error. Likely causes are the host being unreachable from the Docker network, a wrong `/v1` suffix, or a wrong model name. Do not continue to step 3.

## Step 3: Generate embeddings

```
docker compose exec prism node packages/server/bin/prism maintain /bundle --only=embed
```

Expect a JSON report with `embeddings.configured: true` and a non-zero embedded count roughly equal to the concept count (the bundle is small, so this should take seconds). Then run it a second time: the second run must make zero provider calls and report nothing newly embedded (content-hash gated).

Note: `maintain --only=embed` builds the derived search index first if it does not exist. At this bundle size the index is not auto-built, so this step creates it. That is expected.

## Step 4: Prove semantic retrieval

1. Through the `prism-sigma` MCP connector (or REST with the token read from `.env` without printing it), write two test concepts under `/tests/embed/`:
   - Target: a short note about one topic, using distinctive vocabulary (for example, about "reducing inventory buffers at a distribution centre").
   - Decoy: a short note about something unrelated.
2. Run `prism maintain /bundle --only=embed` again so both are embedded.
3. Search with a phrase that means the same as the target but shares no words with it (for example "cutting safety stock in the warehouse" against a target that only says "reducing inventory buffers at a distribution centre"). Confirm the keyword scan alone would return nothing for that phrase, by checking the same query with embeddings disabled or by choosing words that provably do not appear in either note.
4. Pass: the target ranks first for the semantic query, and the decoy does not outrank it.
5. Delete both test concepts through Prism.

## Step 5: Degrade check

Briefly point `EMBEDDING_API_BASE_URL` at a dead port (or stop the embedder if the user allows), restart, and confirm keyword search still works and returns results with no error. Restore the real value afterwards and confirm step 2 passes again.

## Pass criteria and report

PRISM-37 can close if: step 2 passes, step 3 embeds all concepts and the repeat run makes zero calls, step 4 ranks the target first on a keyword-disjoint query, and step 5 shows clean degradation. Write the result file with each step's outcome, the vector length, concept and embedded counts, the queries used, and the cleanup done. If anything fails, roll back to the previous `.env` and report the exact error text.
