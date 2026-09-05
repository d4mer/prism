import { DatabaseSync } from "node:sqlite";
import type { Bundle } from "./bundle.js";
import type { ConceptFrontmatter } from "./types.js";
import { indexPath, indexExists, rebuildSearchIndex, ensureSchema, SEMANTIC_WEIGHT, SEMANTIC_MIN_SIMILARITY } from "./search-index.js";
import { resolveEmbeddingConfig, embedTexts, type EmbeddingConfig } from "../providers/embeddings.js";

// Re-exported for anything that imported the policy constants from here
// before this module existed — kept as a single source in search-index.ts.
export { SEMANTIC_WEIGHT, SEMANTIC_MIN_SIMILARITY };

// Bounds provider cost/latency per concept; a concept's own title/description
// carry most of the meaning anyway, so truncating the body long past this is
// a reasonable trade against embedding cost on very large concepts.
const MAX_EMBED_CHARS = 8000;

// Provider calls per generateEmbeddings() invocation; matches the write-side
// batch size embeddings-provider.ts already imposes per HTTP request, kept
// separate here as the unit this module reasons about (one DB transaction
// per batch).
const BATCH_SIZE = 64;

function embeddingText(fm: ConceptFrontmatter, body: string): string {
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String).join(", ") : "";
  const parts = [
    typeof fm.title === "string" ? fm.title : "",
    typeof fm.description === "string" ? fm.description : "",
    tags,
    body,
  ].filter((p) => p.length > 0);
  return parts.join("\n\n").slice(0, MAX_EMBED_CHARS);
}

export interface EmbeddingsReport {
  /** False when no EMBEDDING_* config is set — an opt-in feature sitting idle, not a failure. */
  configured: boolean;
  /** True once embedding generation actually ran (regardless of whether every concept succeeded). */
  ran: boolean;
  dryRun?: boolean;
  reason?: string;
  model?: string;
  /** Total concepts in the derived index. */
  total: number;
  /** Concepts whose embedding was missing or stale (wrong content hash or wrong model) before this call. */
  stale: number;
  /** Concepts (re)embedded by this call. */
  embedded: number;
  failed: number;
  failedPaths: string[];
  /** Valid-embedding coverage as of right now (after this call, or unchanged if dry-run/no-op). */
  coverage?: { embedded: number; total: number };
}

interface EmbeddingRow {
  path: string;
  content_hash: string;
  frontmatter_json: string;
  body: string;
  embedding_hash: string | null;
  embedding_model: string | null;
}

/**
 * PRISM-37: keep the derived index's embeddings in sync with the bundle.
 * Deterministic and content-hash-gated (plus model-gated — switching
 * EMBEDDING_MODEL invalidates prior vectors) — the only network calls this
 * makes are to the embeddings provider, and only for concepts that actually
 * need it. Never called from the request path; `prism maintain` only.
 */
export async function generateEmbeddings(
  bundle: Bundle,
  options: { dryRun?: boolean; config?: EmbeddingConfig } = {}
): Promise<EmbeddingsReport> {
  const config = options.config ?? resolveEmbeddingConfig();
  if (!config) {
    return {
      configured: false,
      ran: false,
      reason: "embeddings not configured (set EMBEDDING_API_BASE_URL + EMBEDDING_MODEL)",
      total: 0,
      stale: 0,
      embedded: 0,
      failed: 0,
      failedPaths: [],
    };
  }

  if (!(await indexExists(bundle))) {
    // A real run builds the index first (embeddings live inside it); a
    // dry-run must change nothing, so it estimates from the bundle walk —
    // with no index yet, every concept is trivially "stale".
    if (options.dryRun) {
      const paths = await bundle.listConceptPaths();
      return {
        configured: true,
        ran: false,
        dryRun: true,
        reason: "no search index built yet — a real run builds one first",
        model: config.model,
        total: paths.length,
        stale: paths.length,
        embedded: 0,
        failed: 0,
        failedPaths: [],
      };
    }
    await rebuildSearchIndex(bundle);
  }

  const db = new DatabaseSync(indexPath(bundle));
  try {
    ensureSchema(db); // upgrade an index built before PRISM-37 existed
    const rows = db
      .prepare(
        `SELECT path, content_hash, frontmatter_json, body, embedding_hash, embedding_model FROM concepts`
      )
      .all() as unknown as EmbeddingRow[];

    const stale = rows.filter(
      (r) => r.embedding_hash !== r.content_hash || r.embedding_model !== config.model
    );

    if (stale.length === 0) {
      return {
        configured: true,
        ran: false,
        reason: "embeddings up to date",
        model: config.model,
        total: rows.length,
        stale: 0,
        embedded: 0,
        failed: 0,
        failedPaths: [],
        coverage: { embedded: rows.length, total: rows.length },
      };
    }

    if (options.dryRun) {
      return {
        configured: true,
        ran: false,
        dryRun: true,
        reason: `${stale.length} concept(s) need embedding`,
        model: config.model,
        total: rows.length,
        stale: stale.length,
        embedded: 0,
        failed: 0,
        failedPaths: [],
        coverage: { embedded: rows.length - stale.length, total: rows.length },
      };
    }

    const update = db.prepare(
      `UPDATE concepts SET embedding = ?, embedding_hash = ?, embedding_model = ? WHERE path = ?`
    );
    const failedPaths: string[] = [];

    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const batch = stale.slice(i, i + BATCH_SIZE);
      const texts = batch.map((r) => embeddingText(JSON.parse(r.frontmatter_json) as ConceptFrontmatter, r.body));
      try {
        const vectors = await embedTexts(config, texts);
        db.exec("BEGIN");
        try {
          for (let j = 0; j < batch.length; j++) {
            update.run(JSON.stringify(vectors[j]), batch[j].content_hash, config.model, batch[j].path);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        // A batch failing (bad key, rate limit, network) must not abort the
        // whole run — other batches may still succeed — but it must show up
        // in the report, never be silently swallowed as full coverage.
        console.error(`[prism] embedding batch failed: ${(err as Error).message}`);
        failedPaths.push(...batch.map((r) => r.path));
      }
    }

    return {
      configured: true,
      ran: true,
      model: config.model,
      total: rows.length,
      stale: stale.length,
      embedded: stale.length - failedPaths.length,
      failed: failedPaths.length,
      failedPaths,
      coverage: { embedded: rows.length - failedPaths.length, total: rows.length },
    };
  } finally {
    db.close();
  }
}
