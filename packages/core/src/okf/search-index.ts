import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import { cosineSimilarity } from "ai";
import type { Bundle } from "./bundle.js";
import type { Concept, ConceptFrontmatter, SearchHit } from "./types.js";
import type { SearchOptions } from "./search.js";
import { resolveEmbeddingConfig, embedQuery } from "../providers/embeddings.js";
import { inScope, normalizeScope } from "./scope.js";
import { aliasesOf, aliasScore } from "./fields.js";

/**
 * PRISM-37: additive weight given to a semantic (embedding) match, on the
 * same scale as the keyword scoring below (title +10, path +6,
 * description/tags +5, body +2). Tunable: raise to let a strong semantic
 * match outrank a weak keyword match more often; lower to make embeddings
 * a tie-breaker only. Exported so okf/embeddings.ts's maintenance pass and
 * this module's own tests share one definition instead of two.
 */
export const SEMANTIC_WEIGHT = 20;

/**
 * Cosine similarities below this are treated as "not a match" (contribute
 * zero score) rather than a weak positive — keeps unrelated concepts out of
 * results when nothing meaningfully relates to the query.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.2;

const INDEX_DIRNAME = ".prism";
const INDEX_FILENAME = "search.sqlite3";

// Bundle-relative links to concepts: [text](/dir/concept.md) — kept in sync
// with the identical regex in graph.ts (duplicated rather than imported to
// avoid coupling this derived-data module to graph.ts's internals).
const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;

/** Absolute path to this bundle's derived search index file (never the source of truth). */
export function indexPath(bundle: Bundle): string {
  return path.join(bundle.root, INDEX_DIRNAME, INDEX_FILENAME);
}

/** True if a search index file exists for this bundle. Does not open or validate it. */
export async function indexExists(bundle: Bundle): Promise<boolean> {
  try {
    await fs.access(indexPath(bundle));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a concept known to have come from this bundle's own filesystem walk
 * (bundle.listConceptPaths()) — NOT from external/caller-supplied input.
 * Skips Bundle.readConcept()'s resolveSafe() symlink-escape defense, which
 * exists specifically to guard caller-supplied paths (e.g. from a tool
 * call); resolve() alone still rejects any string-level path escape. This
 * matters at scale: resolveSafe's extra lstat+realpath per file roughly
 * doubles per-file read cost across a full-bundle rebuild.
 */
async function readConceptTrusted(bundle: Bundle, bundlePath: string): Promise<Concept> {
  const abs = bundle.resolve(bundlePath);
  const raw = await fs.readFile(abs, "utf-8");
  const { frontmatter, body } = parseDoc(raw);
  return { path: bundlePath, frontmatter: frontmatter as ConceptFrontmatter, body, raw };
}

function contentHashOf(concept: Concept): string {
  return createHash("sha256").update(concept.raw).digest("hex");
}

function isSuperseded(fm: ConceptFrontmatter): boolean {
  return typeof fm.superseded_by === "string" && fm.superseded_by.length > 0;
}

function tagsJoined(fm: ConceptFrontmatter): string {
  return (Array.isArray(fm.tags) ? fm.tags : []).map(String).join(" ");
}

export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      path TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      description TEXT,
      tags_joined TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      superseded INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      embedding TEXT,
      embedding_hash TEXT,
      embedding_model TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
      path UNINDEXED,
      title,
      description,
      tags_joined,
      body,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS links (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS links_source_idx ON links(source);
    CREATE INDEX IF NOT EXISTS links_target_idx ON links(target);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // PRISM-37: upgrade an index built before embeddings existed. node:sqlite's
  // bundled SQLite doesn't support "ADD COLUMN IF NOT EXISTS" (verified: it's
  // a syntax error there), so we just try the plain form and swallow the
  // "duplicate column" error on a table that already has it — cheap, and
  // ensureSchema already runs on every db-open.
  for (const col of ["embedding TEXT", "embedding_hash TEXT", "embedding_model TEXT"]) {
    try {
      db.exec(`ALTER TABLE concepts ADD COLUMN ${col}`);
    } catch {
      // Column already exists (the common case) — nothing to do. Any other
      // ALTER failure would also surface on the CREATE TABLE above or the
      // first real query, so it's safe to ignore here specifically.
    }
  }
}

/** Open the index for writing (rebuild/incremental maintenance). Creates the file/schema if absent. */
function openForWrite(bundle: Bundle): DatabaseSync {
  const db = new DatabaseSync(indexPath(bundle));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  ensureSchema(db);
  return db;
}

interface WriteStatements {
  insertConcept: StatementSync;
  deleteConcept: StatementSync;
  deleteFts: StatementSync;
  insertFts: StatementSync;
  deleteLinks: StatementSync;
  insertLink: StatementSync;
}

/**
 * Prepare every write statement once per db-open rather than per row — with
 * thousands of concepts, re-parsing the same SQL text on every call is
 * measurable overhead for no benefit (see rebuildSearchIndex/insertRow).
 */
function prepareWriteStatements(db: DatabaseSync): WriteStatements {
  return {
    insertConcept: db.prepare(
      `INSERT INTO concepts (path, type, title, description, tags_joined, body, superseded, content_hash, frontmatter_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         type = excluded.type,
         title = excluded.title,
         description = excluded.description,
         tags_joined = excluded.tags_joined,
         body = excluded.body,
         superseded = excluded.superseded,
         content_hash = excluded.content_hash,
         frontmatter_json = excluded.frontmatter_json,
         updated_at = excluded.updated_at`
    ),
    deleteConcept: db.prepare(`DELETE FROM concepts WHERE path = ?`),
    deleteFts: db.prepare(`DELETE FROM concepts_fts WHERE path = ?`),
    insertFts: db.prepare(
      `INSERT INTO concepts_fts (path, title, description, tags_joined, body) VALUES (?, ?, ?, ?, ?)`
    ),
    deleteLinks: db.prepare(`DELETE FROM links WHERE source = ?`),
    insertLink: db.prepare(`INSERT INTO links (source, target, kind) VALUES (?, ?, ?)`),
  };
}

function extractLinks(source: string, concept: Concept): { target: string; kind: string }[] {
  const out: { target: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const m of concept.body.matchAll(LINK_RE)) {
    const target = m[1];
    if (target === source || seen.has(target)) continue;
    seen.add(target);
    out.push({ target, kind: "body" });
  }
  for (const field of ["supersedes", "superseded_by"] as const) {
    const v = concept.frontmatter[field];
    if (typeof v === "string" && v.length > 0 && v !== source && !seen.has(v)) {
      seen.add(v);
      out.push({ target: v, kind: field });
    }
  }
  return out;
}

function computeFields(concept: Concept) {
  const fm = concept.frontmatter;
  return {
    fm,
    title: typeof fm.title === "string" ? fm.title : "",
    description: typeof fm.description === "string" ? fm.description : "",
    tags: tagsJoined(fm),
    body: concept.body,
    superseded: isSuperseded(fm) ? 1 : 0,
    hash: contentHashOf(concept),
    fmJson: JSON.stringify(fm),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Pure insert — no pre-delete of any kind. Only safe when the caller has
 * already guaranteed no row for this path can exist yet (concepts/
 * concepts_fts/links all wiped at the start of a rebuild, and each bundle
 * path visited exactly once). See upsertRow() for the incremental,
 * may-already-be-indexed case.
 */
function insertRow(stmts: WriteStatements, concept: Concept): void {
  const f = computeFields(concept);
  stmts.insertConcept.run(
    concept.path,
    typeof f.fm.type === "string" ? f.fm.type : "",
    f.title,
    f.description,
    f.tags,
    f.body,
    f.superseded,
    f.hash,
    f.fmJson,
    f.updatedAt
  );
  stmts.insertFts.run(concept.path, f.title, f.description, f.tags, f.body);
  for (const { target, kind } of extractLinks(concept.path, concept)) {
    stmts.insertLink.run(concept.path, target, kind);
  }
}

/**
 * Incremental upsert: the concept may already be indexed. `concepts` has a
 * real PRIMARY KEY so insertConcept's ON CONFLICT handles replace-in-place,
 * but concepts_fts and links have no unique constraint to UPSERT against —
 * both need their old rows deleted first or a re-indexed concept would
 * accumulate duplicates.
 */
function upsertRow(stmts: WriteStatements, concept: Concept): void {
  const f = computeFields(concept);
  stmts.insertConcept.run(
    concept.path,
    typeof f.fm.type === "string" ? f.fm.type : "",
    f.title,
    f.description,
    f.tags,
    f.body,
    f.superseded,
    f.hash,
    f.fmJson,
    f.updatedAt
  );
  stmts.deleteFts.run(concept.path);
  stmts.insertFts.run(concept.path, f.title, f.description, f.tags, f.body);
  stmts.deleteLinks.run(concept.path);
  for (const { target, kind } of extractLinks(concept.path, concept)) {
    stmts.insertLink.run(concept.path, target, kind);
  }
}

function removeRow(stmts: WriteStatements, conceptPath: string): void {
  stmts.deleteConcept.run(conceptPath);
  stmts.deleteFts.run(conceptPath);
  stmts.deleteLinks.run(conceptPath);
}

/**
 * PRISM-35: wipe and fully repopulate the derived index from the markdown
 * bundle alone — the .md files are the only source of truth. Deleting the
 * index file and calling this again must reproduce byte-identical rows
 * (enforced by a test), since every column is a pure function of the
 * concept file's own content.
 */
export async function rebuildSearchIndex(bundle: Bundle): Promise<{ count: number }> {
  const file = indexPath(bundle);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.rm(file + suffix, { force: true });
  }
  await ensureBundleGitignore(bundle);

  const db = openForWrite(bundle);
  try {
    db.exec("DELETE FROM concepts");
    db.exec("DELETE FROM concepts_fts");
    db.exec("DELETE FROM links");
    const paths = await bundle.listConceptPaths();
    const stmts = prepareWriteStatements(db);
    db.exec("BEGIN");
    try {
      for (const p of paths) {
        try {
          const concept = await readConceptTrusted(bundle, p);
          // Tables were just wiped above and each path is visited exactly
          // once, so the plain insert path is safe and avoids the
          // per-row FTS/links DELETE cost that upsertRow() needs for the
          // incremental (may-already-exist) case.
          insertRow(stmts, concept);
        } catch {
          // Permissive: unreadable concept is skipped, same as search/graph/validate.
        }
      }
      db.prepare(`INSERT INTO meta (key, value) VALUES ('rebuilt_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { count: paths.length };
  } finally {
    db.close();
  }
}

/** Best-effort incremental maintenance: no-op if the index hasn't been built yet. */
export async function indexUpsertConcept(bundle: Bundle, concept: Concept): Promise<void> {
  if (!(await indexExists(bundle))) return;
  const db = openForWrite(bundle);
  try {
    upsertRow(prepareWriteStatements(db), concept);
  } finally {
    db.close();
  }
}

/** Best-effort incremental maintenance: no-op if the index hasn't been built yet. */
export async function indexRemoveConcept(bundle: Bundle, conceptPath: string): Promise<void> {
  if (!(await indexExists(bundle))) return;
  const db = openForWrite(bundle);
  try {
    removeRow(prepareWriteStatements(db), conceptPath);
  } finally {
    db.close();
  }
}

/**
 * Ensure the bundle's own .gitignore excludes the derived index — it must
 * never be committed (PRISM-35 contract). Idempotent; a no-op if the entry
 * is already present. Written even if the bundle isn't a git repo (yet) —
 * cheap insurance for when it becomes one (PRISM-39).
 */
export async function ensureBundleGitignore(bundle: Bundle): Promise<void> {
  const gitignorePath = path.join(bundle.root, ".gitignore");
  const entry = `${INDEX_DIRNAME}/`;
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — will be created below.
  }
  if (existing.split("\n").some((line) => line.trim() === entry || line.trim() === INDEX_DIRNAME)) {
    return;
  }
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${existing}${separator}${entry}\n`, "utf-8");
}

/**
 * PRISM-35: FTS5-backed replacement for the linear scan in search.ts.
 * Candidate rows are read from the derived index (no per-search disk I/O or
 * YAML parsing), but scoring reproduces the EXACT additive formula from
 * searchBundle() field-for-field so results are indistinguishable from the
 * scan implementation — this is what makes the index provably safe to swap
 * in: same inputs, same outputs, just faster.
 */
export function searchIndexed(
  db: DatabaseSync,
  query: string,
  options: SearchOptions = {},
  // PRISM-37: the query's own embedding, precomputed by tryIndexedSearch
  // (the one call in this feature that has to happen on the request path —
  // see providers/embeddings.ts). Undefined whenever embeddings aren't
  // configured, aren't available for this row, or the provider call failed;
  // every one of those cases must reproduce keyword-only scoring exactly,
  // which is what makes this optional rather than a rewrite.
  queryEmbedding?: number[]
): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const rows = db.prepare(`SELECT * FROM concepts ORDER BY path`).all() as Array<{
    path: string;
    type: string;
    title: string;
    description: string;
    tags_joined: string;
    body: string;
    superseded: number;
    content_hash: string;
    frontmatter_json: string;
    embedding: string | null;
    embedding_hash: string | null;
  }>;

  const scope = normalizeScope(options.scope);
  const hits: SearchHit[] = [];
  for (const row of rows) {
    // PRISM-54: same directory-aligned test as searchBundle(), so the two
    // paths stay result-identical (AC2 parity) — including for the hybrid
    // embedding ranking below, which only ever sees in-scope rows.
    if (!inScope(row.path, scope)) continue;
    if (row.superseded && !options.includeHistory) continue;
    if (options.type && row.type.toLowerCase() !== options.type.toLowerCase()) continue;

    // Tag filtering needs the concept's real tag array, not tags_joined —
    // that column is a space-joined flattening kept for scoring/FTS only,
    // and can't tell a multi-word tag ("on call") apart from two separate
    // tags (["on", "call"]) once re-split. Parse frontmatter_json lazily,
    // only when a tags filter is actually requested, to match searchBundle()
    // exactly without paying JSON.parse cost on every row of every search.
    let fm: ConceptFrontmatter | undefined;
    if (options.tags?.length) {
      fm = JSON.parse(row.frontmatter_json) as ConceptFrontmatter;
      const conceptTags = (Array.isArray(fm.tags) ? fm.tags : []).map((t) => String(t).toLowerCase());
      if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) continue;
    }

    const title = row.title.toLowerCase();
    const description = row.description.toLowerCase();
    const tags = row.tags_joined.toLowerCase();
    const body = row.body.toLowerCase();
    const pathLower = row.path.toLowerCase();

    // PRISM-55: aliases are read from frontmatter_json — present in every
    // row of every index, old or new — so no schema bump or rebuild is
    // needed for alias search to be correct. The substring guard skips the
    // JSON.parse for the (typical) row that has no aliases at all.
    let score = 0;
    if (terms.length > 0 && row.frontmatter_json.includes('"aliases"')) {
      fm ??= JSON.parse(row.frontmatter_json) as ConceptFrontmatter;
      score = aliasScore(aliasesOf(fm), terms, query);
    }
    let firstBodyMatch = -1;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      if (pathLower.includes(term)) score += 6;
      if (description.includes(term)) score += 5;
      if (tags.includes(term)) score += 5;
      const bodyIdx = body.indexOf(term);
      if (bodyIdx !== -1) {
        score += 2;
        if (firstBodyMatch === -1) firstBodyMatch = bodyIdx;
      }
    }
    if (terms.length === 0) score = 1;

    // PRISM-37: hybrid ranking. A row with zero keyword overlap but a
    // strong semantic match must still surface (the "vocabulary mismatch"
    // case — client jargon vs. SAP-standard terms sharing no keywords) —
    // so this is added AFTER the keyword score, not folded into the
    // score===0 check above. When queryEmbedding is undefined (embeddings
    // not configured, or the live query-embed call failed) or this row has
    // no valid embedding of its own, semanticScore stays exactly 0 and the
    // total is identical to the pre-PRISM-37 keyword-only score — this is
    // what keeps "embeddings disabled ⇒ behaves exactly like the scan" true
    // by construction rather than by a separate code path.
    let semanticScore = 0;
    if (queryEmbedding && row.embedding && row.embedding_hash === row.content_hash) {
      const similarity = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]);
      if (similarity >= SEMANTIC_MIN_SIMILARITY) semanticScore = similarity * SEMANTIC_WEIGHT;
    }
    const total = score + semanticScore;
    if (total === 0) continue;

    fm ??= JSON.parse(row.frontmatter_json) as ConceptFrontmatter;
    hits.push({
      path: row.path,
      // Match searchBundle()'s display default exactly (row.type is "" for
      // an untyped concept, stored that way for cheap SQL filtering above).
      type: (fm.type as string | undefined) ?? "unknown",
      title: fm.title as string | undefined,
      description: fm.description as string | undefined,
      snippet:
        firstBodyMatch >= 0
          ? row.body
              .slice(Math.max(0, firstBodyMatch - 60), firstBodyMatch + 120)
              .replace(/\s+/g, " ")
              .trim()
          : undefined,
      superseded: row.superseded ? true : undefined,
      score: total,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}

/**
 * Try the derived index; fall back to nothing (caller decides what to do)
 * if it's missing or any error occurs opening/querying it. Never throws.
 */
export async function tryIndexedSearch(
  bundle: Bundle,
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[] | undefined> {
  if (!(await indexExists(bundle))) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(indexPath(bundle), { readOnly: true });

    // PRISM-37: the one embedding call on the search request path — the
    // query's own vector, needed to compare against concepts' precomputed
    // ones. Deliberately isolated from the DB-level catch below: a slow or
    // broken embeddings provider must degrade this one search to
    // keyword-only, never take down indexed search entirely (an empty
    // query has nothing meaningful to embed, so it's skipped outright).
    let queryEmbedding: number[] | undefined;
    const embeddingConfig = query.trim().length > 0 ? resolveEmbeddingConfig() : undefined;
    if (embeddingConfig) {
      try {
        queryEmbedding = await embedQuery(embeddingConfig, query);
      } catch (err) {
        console.error(`[prism] query embedding failed, falling back to keyword-only: ${(err as Error).message}`);
      }
    }

    return searchIndexed(db, query, options, queryEmbedding);
  } catch {
    // Corrupt/incompatible index file, or a DB-level error — never fail the
    // caller's search over this; they fall back to the direct scan instead.
    return undefined;
  } finally {
    db?.close();
  }
}

// ── PRISM-36: keep the index honest under out-of-band edits ───────────
//
// Concepts are plain files: people edit them in Obsidian or VS Code, pull
// them with git, or write them from another tool. In-band writes already
// maintain the index incrementally (afterMutation). Reconciliation covers
// everything else by comparing each file's content hash against the stored
// content_hash:
//   - new file on disk, no row  -> added
//   - hash differs              -> updated (re-parsed, re-linked; its
//                                  embedding goes stale via embedding_hash,
//                                  so semantic scoring skips it until the
//                                  next `prism maintain --embed`)
//   - row with no file          -> removed
//   - hash equal                -> untouched (never rewritten)

export interface ReconcileReport {
  /** False when there is no index to reconcile (search is scanning the files directly, so it is never stale). */
  indexed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  dryRun: boolean;
  durationMs: number;
}

export interface ReconcileOptions {
  /** Only these bundle paths (from a file watcher). Omit for a full pass. */
  paths?: string[];
  /** Report what would change without touching the index (used for status). */
  dryRun?: boolean;
}

async function readRawIfPresent(bundle: Bundle, bundlePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(bundle.resolve(bundlePath), "utf-8");
  } catch {
    return undefined;
  }
}

export async function reconcileSearchIndex(bundle: Bundle, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const started = Date.now();
  const empty = (indexed: boolean): ReconcileReport => ({
    indexed,
    added: [],
    updated: [],
    removed: [],
    unchanged: 0,
    dryRun: !!options.dryRun,
    durationMs: Date.now() - started,
  });
  if (!(await indexExists(bundle))) return empty(false);

  const db = options.dryRun ? new DatabaseSync(indexPath(bundle), { readOnly: true }) : openForWrite(bundle);
  try {
    const stored = new Map(
      (db.prepare(`SELECT path, content_hash FROM concepts`).all() as { path: string; content_hash: string }[]).map(
        (r) => [r.path, r.content_hash]
      )
    );

    // Which paths to look at: the watcher's list, or everything on disk plus
    // everything the index remembers (so deletions are seen).
    let candidates: string[];
    if (options.paths) {
      candidates = [...new Set(options.paths)];
    } else {
      candidates = [...new Set([...(await bundle.listConceptPaths()), ...stored.keys()])];
    }

    const report = empty(true);
    const upserts: Concept[] = [];
    for (const p of candidates.sort()) {
      const raw = await readRawIfPresent(bundle, p);
      if (raw === undefined) {
        if (stored.has(p)) report.removed.push(p);
        continue;
      }
      const hash = createHash("sha256").update(raw).digest("hex");
      const known = stored.get(p);
      if (known === hash) {
        report.unchanged++;
        continue;
      }
      try {
        const { frontmatter, body } = parseDoc(raw);
        upserts.push({ path: p, frontmatter: frontmatter as ConceptFrontmatter, body, raw });
        (known === undefined ? report.added : report.updated).push(p);
      } catch {
        // Unparseable right now (e.g. an editor mid-save): leave the old row
        // alone; the next change event or pass will pick it up.
      }
    }

    if (!options.dryRun && (upserts.length > 0 || report.removed.length > 0)) {
      const stmts = prepareWriteStatements(db);
      db.exec("BEGIN");
      try {
        for (const c of upserts) upsertRow(stmts, c);
        for (const p of report.removed) removeRow(stmts, p);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    if (!options.dryRun && !options.paths) {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('reconciled_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        new Date().toISOString()
      );
    }
    report.durationMs = Date.now() - started;
    return report;
  } finally {
    db.close();
  }
}

export interface IndexStatus {
  /** Whether a derived index exists. Without one, search scans the files and is always current. */
  indexed: boolean;
  concepts?: number;
  rebuilt_at?: string;
  reconciled_at?: string;
  /** Files whose content differs from the index right now (dry-run reconcile). 0 = fresh. */
  pending_changes: number;
  stale: boolean;
  pending_sample?: string[];
}

/** Cheap, read-only freshness check for status endpoints. */
export async function searchIndexStatus(bundle: Bundle): Promise<IndexStatus> {
  if (!(await indexExists(bundle))) return { indexed: false, pending_changes: 0, stale: false };
  const dry = await reconcileSearchIndex(bundle, { dryRun: true });
  const db = new DatabaseSync(indexPath(bundle), { readOnly: true });
  try {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n;
    const meta = new Map(
      (db.prepare(`SELECT key, value FROM meta`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
    );
    const pending = [...dry.added, ...dry.updated, ...dry.removed];
    return {
      indexed: true,
      concepts: count,
      rebuilt_at: meta.get("rebuilt_at"),
      reconciled_at: meta.get("reconciled_at"),
      pending_changes: pending.length,
      stale: pending.length > 0,
      ...(pending.length > 0 ? { pending_sample: pending.slice(0, 10) } : {}),
    };
  } finally {
    db.close();
  }
}
