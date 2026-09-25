import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Bundle } from "./bundle.js";

/**
 * Regenerate a directory's index.md per spec §6:
 * bullet list of `[Title](relative-url) - description`, subdirectories included.
 * The root index.md carries the only frontmatter allowed in an index: okf_version.
 */
export async function regenerateIndex(bundle: Bundle, dir = "/"): Promise<string> {
  const absDir = bundle.resolve(dir);
  const isRoot = absDir === bundle.root;
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const conceptLines: string[] = [];
  const dirLines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const summary = formatSummary(await summarize(bundle.root, path.join(absDir, entry.name)));
      dirLines.push(`* [${entry.name}](${entry.name}/) - ${summary}`);
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_FILENAMES.has(entry.name)) continue;
    let title = entry.name.replace(/\.md$/, "");
    let description = "";
    try {
      const { frontmatter } = parseDoc(
        await fs.readFile(path.join(absDir, entry.name), "utf-8")
      );
      if (typeof frontmatter.title === "string" && frontmatter.title) title = frontmatter.title;
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Permissive: index unparseable files by filename.
    }
    conceptLines.push(`* [${title}](${entry.name})${description ? ` - ${description}` : ""}`);
  }

  const dirName = isRoot ? "Knowledge Base" : path.basename(absDir);
  const sections: string[] = [];
  if (isRoot) sections.push(`---\nokf_version: "0.1"\n---\n`);
  sections.push(`# ${capitalize(dirName)}\n`);
  if (conceptLines.length > 0) sections.push(conceptLines.join("\n") + "\n");
  if (dirLines.length > 0) {
    const heading = isRoot ? "Memory Segments" : "Subdirectories";
    sections.push(`## ${heading}\n\n${dirLines.join("\n")}\n`);
  }

  const content = sections.join("\n");
  await fs.writeFile(path.join(absDir, "index.md"), content, "utf-8");
  return content;
}

/** Regenerate index.md for a directory and every ancestor up to the root. */
export async function regenerateIndexChain(bundle: Bundle, dir: string): Promise<void> {
  let current = bundle.resolve(dir);
  // If given a file path, start from its directory.
  if (current.endsWith(".md")) current = path.dirname(current);
  // PRISM-59: everything on this chain may have changed; siblings haven't.
  invalidateChain(bundle.root, current);
  // The directory may have been pruned away — start from the nearest ancestor
  // that still exists (the root always exists).
  while (current !== bundle.root) {
    try {
      await fs.access(current);
      break;
    } catch {
      current = path.dirname(current);
    }
  }
  while (true) {
    await regenerateIndex(bundle, bundle.toBundlePath(current));
    if (current === bundle.root) break;
    current = path.dirname(current);
  }
}

/**
 * Remove directories whose only content is the auto-generated index.md
 * (issue #10: agents move/merge concepts and leave undeletable husks —
 * concept_delete refuses reserved filenames by design, so cleanup must be
 * deterministic). Bottom-up over the whole bundle; a directory emptied by
 * pruning its children is pruned too. The root and dot-directories
 * (.traces etc.) are never touched. Returns removed bundle paths.
 */
export async function pruneEmptyDirs(bundle: Bundle): Promise<string[]> {
  const removed: string[] = [];

  async function visit(absDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await visit(path.join(absDir, entry.name));
      }
    }
    if (absDir === bundle.root) return;
    // Re-read: children may have been pruned during the recursion above.
    const remaining = await fs.readdir(absDir);
    const onlyIndex =
      remaining.length === 0 || (remaining.length === 1 && remaining[0] === "index.md");
    if (onlyIndex) {
      await fs.rm(absDir, { recursive: true, force: true });
      removed.push(bundle.toBundlePath(absDir));
    }
  }

  await visit(bundle.root);
  for (const r of removed) invalidateChain(bundle.root, bundle.resolve(r));
  return removed;
}

/**
 * PRISM-59: prune husks along ONE directory chain: the folder a write or
 * delete touched and its ancestors, stopping at the first folder that still
 * has content. This is what a single mutation can create; the whole-bundle
 * sweep (pruneEmptyDirs) now runs at startup instead of on every write,
 * where it cost a walk of every folder.
 */
export async function pruneEmptyChain(bundle: Bundle, dir: string): Promise<string[]> {
  const removed: string[] = [];
  let current = bundle.resolve(dir);
  if (current.endsWith(".md")) current = path.dirname(current);
  while (current !== bundle.root && current.startsWith(bundle.root)) {
    let remaining: string[];
    try {
      remaining = await fs.readdir(current);
    } catch {
      current = path.dirname(current); // already gone: keep checking upward
      continue;
    }
    const onlyIndex = remaining.length === 0 || (remaining.length === 1 && remaining[0] === "index.md");
    if (!onlyIndex) break;
    await fs.rm(current, { recursive: true, force: true });
    removed.push(bundle.toBundlePath(current));
    invalidateChain(bundle.root, current);
    current = path.dirname(current);
  }
  return removed;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * PRISM-59: directory summaries for index listings (concept count, distinct
 * types, first few titles), computed hierarchically and cached.
 *
 * Before, every index.md regeneration walked and parsed every concept under
 * each subdirectory, so regenerating the root index on any write read the
 * whole bundle (2.8s per write at 10k concepts). Now a directory's summary
 * is its own direct concepts combined with its subdirectories' cached
 * summaries, in the same sorted walk order, so the result is byte-identical
 * to the full walk. A write only invalidates its own directory chain
 * (regenerateIndexChain), so a write reads its own folder plus one level
 * per ancestor.
 *
 * Staleness: a summary only goes stale when something outside this
 * process's write path changes a folder (another process, an external
 * editor). The index watcher's reconcile invalidates those paths, and every
 * entry also expires after SUMMARY_TTL_MS as a backstop. Summaries are
 * navigation text in index.md, never data.
 */
interface DirSummary {
  count: number;
  types: Set<string>;
  titles: string[];
  at: number;
}

const SUMMARY_TTL_MS = 10 * 60_000;
const summaryCaches = new Map<string, Map<string, DirSummary>>();

function cacheFor(root: string): Map<string, DirSummary> {
  let cache = summaryCaches.get(root);
  if (!cache) {
    cache = new Map();
    summaryCaches.set(root, cache);
  }
  return cache;
}

/** Drop cached summaries for absDir and every ancestor up to the bundle root. */
function invalidateChain(root: string, absDir: string): void {
  const cache = summaryCaches.get(root);
  if (!cache) return;
  let current = absDir;
  for (;;) {
    cache.delete(current);
    if (current === root || !current.startsWith(root)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Invalidate the cached summaries affected by changes to these bundle paths
 * (from the index watcher's reconcile, i.e. edits made outside Prism).
 */
export function invalidateIndexSummaries(bundle: Bundle, bundlePaths: string[]): void {
  for (const p of bundlePaths) {
    try {
      invalidateChain(bundle.root, path.dirname(bundle.resolve(p)));
    } catch {
      // unresolvable path: nothing cached for it
    }
  }
}

/** Forget every cached summary for a bundle (tests, or after bulk external changes). */
export function clearIndexSummaryCache(bundle: Bundle): void {
  summaryCaches.delete(bundle.root);
}

async function summarize(root: string, absDir: string): Promise<DirSummary> {
  const cache = cacheFor(root);
  const hit = cache.get(absDir);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit;

  const summary: DirSummary = { count: 0, types: new Set(), titles: [], at: Date.now() };
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await summarize(root, child);
      summary.count += sub.count;
      for (const t of sub.types) summary.types.add(t);
      for (const t of sub.titles) if (summary.titles.length < 3) summary.titles.push(t);
    } else if (entry.name.endsWith(".md") && !RESERVED_FILENAMES.has(entry.name)) {
      summary.count++;
      try {
        const { frontmatter } = parseDoc(await fs.readFile(child, "utf-8"));
        if (typeof frontmatter.type === "string" && frontmatter.type) summary.types.add(frontmatter.type);
        if (summary.titles.length < 3) {
          summary.titles.push(
            typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : entry.name.replace(/\.md$/, "")
          );
        }
      } catch {
        if (summary.titles.length < 3) summary.titles.push(entry.name.replace(/\.md$/, ""));
      }
    }
  }
  cache.set(absDir, summary);
  return summary;
}

function formatSummary(s: DirSummary): string {
  if (s.count === 0) return "empty";
  const typeList = [...s.types].sort().join(", ");
  const titleList = s.titles.join(", ") + (s.count > s.titles.length ? ", …" : "");
  return `${s.count} concept${s.count === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}: ${titleList}`;
}
