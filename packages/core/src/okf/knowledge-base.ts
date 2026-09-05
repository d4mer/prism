import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { Bundle } from "./bundle.js";
import { pruneEmptyDirs, regenerateIndexChain } from "./indexer.js";
import { appendLog, readLog } from "./logger.js";
import { searchBundle, listTypes, type SearchOptions } from "./search.js";
import { validateBundle } from "./validate.js";
import { lintBundle, type LintReport } from "./lint.js";
import { buildGraph, type GraphData } from "./graph.js";
import type {
  Concept,
  ConceptFrontmatter,
  ConformanceReport,
  LogAction,
  LogEntry,
  SearchHit,
  TreeNode,
} from "./types.js";

export interface KnowledgeBaseOptions {
  /** Commit after each mutation. Requires the bundle to be inside a git repo. */
  gitAutocommit?: boolean;
}

/**
 * The one write-path into the bundle. Spec conformance (index.md, log.md,
 * frontmatter validation, timestamps) is enforced HERE, deterministically —
 * never delegated to the LLM. Mutations are serialized through a queue.
 */
export class KnowledgeBase {
  readonly bundle: Bundle;
  private readonly git: SimpleGit | null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(bundleRoot: string, private readonly options: KnowledgeBaseOptions = {}) {
    this.bundle = new Bundle(bundleRoot);
    this.git = options.gitAutocommit ? simpleGit(this.bundle.root) : null;
  }

  // ── Reads (no queue) ────────────────────────────────────────────────

  readConcept(conceptPath: string): Promise<Concept> {
    return this.bundle.readConcept(conceptPath);
  }

  listTree(dir?: string): Promise<TreeNode> {
    return this.bundle.listTree(dir);
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return searchBundle(this.bundle, query, options);
  }

  listTypes(): Promise<string[]> {
    return listTypes(this.bundle);
  }

  readLog(): Promise<LogEntry[]> {
    return readLog(this.bundle);
  }

  validate(): Promise<ConformanceReport> {
    return validateBundle(this.bundle);
  }

  /** Graph health: orphaned concepts + broken links (deterministic, no LLM). */
  lint(): Promise<LintReport> {
    return lintBundle(this.bundle);
  }

  /** Inter-concept link graph (nodes + edges) for visualization. */
  graph(): Promise<GraphData> {
    return buildGraph(this.bundle);
  }

  // ── Mutations (serialized; auto index + log + optional commit) ──────

  writeConcept(
    conceptPath: string,
    frontmatter: ConceptFrontmatter,
    body: string,
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const existed = await this.bundle.exists(conceptPath);
      const concept = await this.bundle.writeConcept(conceptPath, frontmatter, body);
      await this.afterMutation(concept.path, existed ? "Update" : "Creation", logSummary);
      return concept;
    });
  }

  patchConcept(
    conceptPath: string,
    changes: Parameters<Bundle["patchConcept"]>[1],
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const concept = await this.bundle.patchConcept(conceptPath, changes);
      await this.afterMutation(concept.path, "Update", logSummary);
      return concept;
    });
  }

  deleteConcept(conceptPath: string, logSummary: string): Promise<void> {
    return this.enqueue(async () => {
      const canonical = this.bundle.toBundlePath(conceptPath);
      await this.bundle.deleteConcept(canonical);
      await this.afterMutation(canonical, "Deletion", logSummary);
    });
  }

  /**
   * PRISM-23: retire a belief and replace it with a new version, atomically.
   * Writes the new concept with `supersedes` pointing at the old one, then
   * patches `superseded_by` onto the old concept pointing at the new one —
   * both PRISM-22 fields, both sides, enforced by the same
   * Bundle.writeConcept validation (existence, self-reference, cycles) that
   * concept_write/concept_patch already go through. Deliberately not built
   * on the generic single-file afterMutation(): this mutation touches two
   * concepts under one log entry, so it does its own bookkeeping pass
   * instead of two separate index/log/commit passes.
   */
  supersede(
    oldPath: string,
    newPath: string,
    newFrontmatter: ConceptFrontmatter,
    newBody: string,
    logSummary: string
  ): Promise<{ old: Concept; new: Concept }> {
    return this.enqueue(async () => {
      // Confirms old exists (throws BundleError NOT_FOUND otherwise) and
      // resolves it to its canonical path.
      const oldConcept = await this.bundle.readConcept(oldPath);
      const created = await this.bundle.writeConcept(
        newPath,
        { ...newFrontmatter, supersedes: oldConcept.path },
        newBody
      );
      const updatedOld = await this.bundle.patchConcept(oldConcept.path, {
        frontmatter: { superseded_by: created.path },
      });

      await pruneEmptyDirs(this.bundle);
      const newDir = path.posix.dirname(created.path);
      const oldDir = path.posix.dirname(updatedOld.path);
      await regenerateIndexChain(this.bundle, newDir);
      if (oldDir !== newDir) await regenerateIndexChain(this.bundle, oldDir);

      const oldLink = `[${updatedOld.path.split("/").pop()}](${updatedOld.path})`;
      const newLink = `[${created.path.split("/").pop()}](${created.path})`;
      await appendLog(this.bundle, "Supersession", logSummary || `${newLink} supersedes ${oldLink}.`);
      if (this.git) {
        try {
          await this.git.add(".");
          await this.git.commit(
            `supersession: ${logSummary || `${created.path} supersedes ${updatedOld.path}`}`
          );
        } catch (err) {
          // Autocommit is best-effort; the KB write itself already succeeded.
          console.error(`[prism] git autocommit failed: ${(err as Error).message}`);
        }
      }
      return { old: updatedOld, new: created };
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async afterMutation(
    conceptPath: string,
    action: LogAction,
    logSummary: string
  ): Promise<void> {
    // Sweep husks first (dirs holding only their auto-generated index.md) so
    // the reindex below never resurrects a pruned directory. Whole-bundle:
    // cheap at this scale, and it also heals husks from before this feature.
    await pruneEmptyDirs(this.bundle);
    await regenerateIndexChain(this.bundle, path.posix.dirname(conceptPath));
    const linked = `[${conceptPath.split("/").pop()}](${conceptPath})`;
    await appendLog(this.bundle, action, logSummary || `${action} of ${linked}.`);
    if (this.git) {
      try {
        await this.git.add(".");
        await this.git.commit(`${action.toLowerCase()}: ${logSummary || conceptPath}`);
      } catch (err) {
        // Autocommit is best-effort; the KB write itself already succeeded.
        console.error(`[prism] git autocommit failed: ${(err as Error).message}`);
      }
    }
  }
}
