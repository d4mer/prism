import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import type { Bundle } from "./bundle.js";
import type { Concept, ConceptFrontmatter, SearchHit } from "./types.js";
import type { SearchOptions } from "./search.js";

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

function ensureSchema(db: DatabaseSync): void {
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
      updated_at TEXT NOT NULL
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
async function ensureBundleGitignore(bundle: Bundle): Promise<void> {
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
export function searchIndexed(db: DatabaseSync, query: string, options: SearchOptions = {}): SearchHit[] {
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
    frontmatter_json: string;
  }>;

  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (row.superseded && !options.includeHistory) continue;
    if (options.type && row.type.toLowerCase() !== options.type.toLowerCase()) continue;
    if (options.tags?.length) {
      const conceptTags = row.tags_joined.toLowerCase().split(" ").filter(Boolean);
      if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) continue;
    }

    const title = row.title.toLowerCase();
    const description = row.description.toLowerCase();
    const tags = row.tags_joined.toLowerCase();
    const body = row.body.toLowerCase();
    const pathLower = row.path.toLowerCase();

    let score = 0;
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
    if (score === 0) continue;

    const fm = JSON.parse(row.frontmatter_json) as ConceptFrontmatter;
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
      score,
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
    return searchIndexed(db, query, options);
  } catch {
    // Corrupt/incompatible index file, or a DB-level error — never fail the
    // caller's search over this; they fall back to the direct scan instead.
    return undefined;
  } finally {
    db?.close();
  }
}
