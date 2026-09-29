import { promises as fs } from "node:fs";
import { KnowledgeBase } from "../okf/index.js";

/**
 * `prism reindex <bundle-path>`: wipe the derived search index and rebuild
 * it from the markdown files alone (PRISM-35's operator-facing rebuild
 * command). Safe to run any time: the index is derived data, the markdown is
 * untouched, and searches fall back to scanning the files while it rebuilds.
 * Like every other write to the bundle it takes the cross-process write
 * lock (PRISM-27), so it can't collide with a running server.
 *
 * Never throws and never calls process.exit; the bin wrapper does that.
 */
export const REINDEX_USAGE = "Usage: prism reindex <bundle-path>";

export interface ReindexCliResult {
  /** 0 = rebuilt, 2 = failure (bad arguments, bad path, or the rebuild failed). */
  exitCode: number;
  output: string;
}

export async function runReindexCli(argv: string[]): Promise<ReindexCliResult> {
  const fail = (error: string): ReindexCliResult => ({ exitCode: 2, output: JSON.stringify({ error }, null, 2) });
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (flags.length > 0) return fail(`Unknown flag: ${flags[0]}\n${REINDEX_USAGE}`);
  if (positional.length !== 1) return fail(REINDEX_USAGE);
  const bundlePath = positional[0];

  try {
    if (!(await fs.stat(bundlePath)).isDirectory()) return fail(`Bundle path is not a directory: ${bundlePath}`);
  } catch {
    return fail(`Bundle path not found: ${bundlePath}`);
  }

  try {
    const started = Date.now();
    const { count } = await new KnowledgeBase(bundlePath).rebuildSearchIndex();
    return { exitCode: 0, output: JSON.stringify({ reindexed: count, ms: Date.now() - started }, null, 2) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
