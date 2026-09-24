/**
 * PRISM-36: keeps the derived search index following the files when they
 * change outside Prism (an editor, a git pull, another tool).
 *
 *  - Startup: one full reconcile, catching anything changed while the
 *    process was down.
 *  - Watch mode: a recursive fs.watch on the bundle. Changed concept paths
 *    are collected and flushed after `debounceMs` of quiet (capped at
 *    `maxWaitMs` from the first event), so a git checkout of hundreds of
 *    files becomes ONE reconcile, not hundreds. Events Prism itself causes
 *    are harmless: index.md/log.md and dot-directories (.prism, .git,
 *    .templates) are ignored, and an in-band write reconciles to "unchanged"
 *    because its hash is already in the index.
 *  - Safety net: a periodic full reconcile even in watch mode, because file
 *    events are not guaranteed everywhere (some network shares and container
 *    bind mounts drop them). Unchanged files cost a read and a hash, never a
 *    write.
 *  - Poll mode: when watching is unavailable, disabled, or errors at
 *    runtime, periodic full reconciles only, at a shorter interval.
 *    Staleness is bounded; it is never silent.
 */
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { ReconcileReport } from "./search-index.js";
import { RESERVED_FILENAMES } from "./types.js";

export type IndexWatchMode = "watch" | "poll" | "off";

export interface IndexWatcherOptions {
  /** Try recursive fs.watch (default true). False = poll mode. */
  watch?: boolean;
  /** Quiet period before a batch of changes is flushed (default 750ms). */
  debounceMs?: number;
  /** Upper bound from the first queued change to its flush (default 5s). */
  maxWaitMs?: number;
  /** Full-reconcile interval in poll mode (default 60s). */
  pollIntervalMs?: number;
  /** Safety-net full-reconcile interval in watch mode (default 10m). 0 disables it. */
  safetyIntervalMs?: number;
  /** Called after every reconcile that ran (including ones that changed nothing). */
  onReconcile?: (report: ReconcileReport, trigger: "startup" | "watch" | "poll" | "safety") => void;
  log?: (message: string) => void;
}

export interface IndexWatcher {
  readonly mode: IndexWatchMode;
  /** Flush any queued changes now (tests, shutdown). */
  flush(): Promise<void>;
  stop(): void;
}

/** Map a watcher filename to a concept path, or "full" when it can't be attributed, or null to ignore. */
export function classifyWatchEvent(filename: string | null): string | "full" | null {
  if (!filename) return "full";
  const rel = filename.split(path.sep).join("/");
  const segments = rel.split("/");
  if (segments.some((s) => s.startsWith("."))) return null; // .prism, .git, .templates, editor swap files
  const base = segments[segments.length - 1];
  if (!base.endsWith(".md")) return "full"; // a directory rename/move: re-scan
  if (RESERVED_FILENAMES.has(base)) return null; // Prism writes these itself
  return "/" + rel;
}

export async function startIndexWatcher(kb: KnowledgeBase, options: IndexWatcherOptions = {}): Promise<IndexWatcher> {
  const log = options.log ?? ((m: string) => console.log(`[prism] ${m}`));
  const debounceMs = options.debounceMs ?? 750;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const safetyIntervalMs = options.safetyIntervalMs ?? 10 * 60_000;

  let mode: IndexWatchMode = "off";
  let fsWatcher: FSWatcher | undefined;
  let interval: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let firstQueuedAt: number | undefined;
  const pending = new Set<string>();
  let needFull = false;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const describe = (r: ReconcileReport) =>
    `+${r.added.length} ~${r.updated.length} -${r.removed.length} (${r.unchanged} unchanged, ${r.durationMs}ms)`;

  const reconcile = (trigger: "startup" | "watch" | "poll" | "safety", paths?: string[]) => {
    // Serialize: never two reconciles at once (the KB queue also serializes
    // against in-band writes).
    running = running.then(async () => {
      if (stopped) return;
      try {
        const report = await kb.reconcileSearchIndex(paths ? { paths } : {});
        if (report.added.length + report.updated.length + report.removed.length > 0) {
          log(`search index reconciled (${trigger}): ${describe(report)}`);
        }
        options.onReconcile?.(report, trigger);
      } catch (err) {
        log(`search index reconcile failed (${trigger}): ${(err as Error).message}`);
      }
    });
    return running;
  };

  const flushNow = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    firstQueuedAt = undefined;
    if (!needFull && pending.size === 0) return running;
    const paths = needFull ? undefined : [...pending];
    pending.clear();
    needFull = false;
    return reconcile("watch", paths);
  };

  const schedule = () => {
    const now = Date.now();
    firstQueuedAt ??= now;
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = Math.max(0, Math.min(debounceMs, firstQueuedAt + maxWaitMs - now));
    debounceTimer = setTimeout(() => void flushNow(), wait);
    debounceTimer.unref();
  };

  const startPolling = (why: string) => {
    fsWatcher?.close();
    fsWatcher = undefined;
    if (interval) clearInterval(interval);
    mode = "poll";
    kb.setIndexWatchMode(mode);
    interval = setInterval(() => void reconcile("poll"), pollIntervalMs);
    interval.unref();
    log(`search index: polling every ${Math.round(pollIntervalMs / 1000)}s (${why})`);
  };

  // AC3: pick up anything changed while we were down, before anything else.
  await reconcile("startup");

  if (options.watch === false) {
    startPolling("file watching disabled");
  } else {
    try {
      fsWatcher = watch(kb.bundle.root, { recursive: true }, (_event, filename) => {
        const target = classifyWatchEvent(filename ? filename.toString() : null);
        if (target === null) return;
        if (target === "full") needFull = true;
        else pending.add(target);
        schedule();
      });
      fsWatcher.on("error", (err) => {
        if (!stopped) startPolling(`file watcher failed: ${err.message}`);
      });
      mode = "watch";
      kb.setIndexWatchMode(mode);
      if (safetyIntervalMs > 0) {
        interval = setInterval(() => void reconcile("safety"), safetyIntervalMs);
        interval.unref();
      }
      log("search index: watching bundle for external edits");
    } catch (err) {
      startPolling(`file watching unavailable: ${(err as Error).message}`);
    }
  }

  return {
    get mode() {
      return mode;
    },
    flush: () => flushNow(),
    stop() {
      stopped = true;
      fsWatcher?.close();
      if (interval) clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      mode = "off";
      kb.setIndexWatchMode(mode);
    },
  };
}
