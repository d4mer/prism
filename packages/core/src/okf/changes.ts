/**
 * PRISM-53: "what changed since…" — one deterministic call to re-orient
 * after a context switch (Monday morning, back from leave, back from the
 * other workstream). Zero LLM: the calling agent or the UI does any
 * summarising on top of this.
 *
 * Sources of truth, and their limits (stated rather than papered over):
 *  - Every live concept carries a write-time `timestamp`, stamped by
 *    Bundle.writeConcept on each create/write/patch — that is what decides
 *    whether it changed in the window. A file that never went through
 *    Prism (hand-authored, no timestamp) falls back to its file mtime and
 *    is flagged timestamp_source:"mtime".
 *  - Created vs updated is read from log.md, which records the action but
 *    only links the path when the log summary did. When no log entry in
 *    the window names the path, the change is reported as "changed".
 *  - Deletions only survive in log.md, which has day granularity: every
 *    Deletion logged on or after the `since` DATE is reported.
 */
import { promises as fs } from "node:fs";
import type { Bundle } from "./bundle.js";
import { readLog } from "./logger.js";
import { inScope, normalizeScope } from "./scope.js";
import { isValidIsoDate } from "./temporal.js";
import type { Concept } from "./types.js";

export type ChangeKind = "created" | "updated" | "changed" | "superseded";

export interface ChangeEntry {
  kind: ChangeKind;
  path: string;
  title?: string;
  type?: string;
  /** ISO time of the last write. */
  timestamp: string;
  timestamp_source: "frontmatter" | "mtime";
  /** Present when kind === "superseded". */
  superseded_by?: string;
}

export interface DeletionEntry {
  /** YYYY-MM-DD from log.md. */
  date: string;
  /** Deleted concept's path, when the log summary linked it. */
  path?: string;
  summary: string;
}

export interface ChangesReport {
  /** The resolved window start, ISO. */
  since: string;
  scope?: string;
  counts: Record<ChangeKind | "deleted", number>;
  /** Newest first. */
  changes: ChangeEntry[];
  /** Newest first. */
  deleted: DeletionEntry[];
  /** True when `limit` cut the changes list short (counts are always complete). */
  truncated: boolean;
}

export interface ChangesOptions {
  scope?: string;
  limit?: number;
  /** Injected clock for relative windows in tests. */
  now?: Date;
}

const RELATIVE_RE = /^(\d+(?:\.\d+)?)\s*(h|d|w)$/i;
const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;

/** Resolve "24h" | "7d" | "2w" | ISO date/date-time into an absolute Date. */
export function resolveSince(since: string, now: Date = new Date()): Date {
  const raw = since.trim();
  const rel = raw.match(RELATIVE_RE);
  if (rel) {
    const unit = rel[2].toLowerCase() as keyof typeof UNIT_MS;
    return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[unit]);
  }
  if (isValidIsoDate(raw)) return new Date(raw);
  throw new Error(
    `Invalid "since": ${JSON.stringify(since)} — use an ISO date/date-time (2026-09-01, 2026-09-01T09:00:00Z) or a window like 24h, 7d, 2w`
  );
}

const LINK_RE = /\]\((\/[^)\s]+\.md)\)/g;

function linkedPaths(summary: string): string[] {
  return [...summary.matchAll(LINK_RE)].map((m) => m[1]);
}

export async function changesSince(
  bundle: Bundle,
  since: string,
  options: ChangesOptions = {}
): Promise<ChangesReport> {
  const sinceDate = resolveSince(since, options.now);
  const sinceMs = sinceDate.getTime();
  const sinceDay = sinceDate.toISOString().slice(0, 10);
  const scope = normalizeScope(options.scope);
  const limit = options.limit ?? 100;

  // log.md evidence within the window, newest-first as stored.
  const log = (await readLog(bundle)).filter((e) => e.date >= sinceDay);
  const createdInWindow = new Set<string>();
  const updatedInWindow = new Set<string>();
  const deleted: DeletionEntry[] = [];
  for (const entry of log) {
    const paths = linkedPaths(entry.summary);
    // A supersession creates the new version in the same log entry that
    // retires the old one; the retired side is classified "superseded"
    // first below, so marking every linked path here only affects the new one.
    if (entry.action === "Creation" || entry.action === "Supersession") paths.forEach((p) => createdInWindow.add(p));
    else if (entry.action === "Update") paths.forEach((p) => updatedInWindow.add(p));
    else if (entry.action === "Deletion") {
      const target = paths[0];
      if (scope && !(target && inScope(target, scope))) continue;
      deleted.push({ date: entry.date, path: target, summary: entry.summary });
    }
  }

  const changes: ChangeEntry[] = [];
  for (const p of await bundle.listConceptPaths(scope ?? "/").catch(() => [] as string[])) {
    if (!inScope(p, scope)) continue;
    let concept: Concept;
    try {
      concept = await bundle.readConcept(p);
    } catch {
      continue; // permissive, same as search/validate
    }
    const fm = concept.frontmatter;
    let timestamp: string | undefined =
      typeof fm.timestamp === "string" && !Number.isNaN(Date.parse(fm.timestamp)) ? fm.timestamp : undefined;
    let source: ChangeEntry["timestamp_source"] = "frontmatter";
    if (!timestamp) {
      const stat = await fs.stat(bundle.resolve(p));
      timestamp = stat.mtime.toISOString();
      source = "mtime";
    }
    if (Date.parse(timestamp) < sinceMs) continue;

    const supersededBy = typeof fm.superseded_by === "string" && fm.superseded_by ? fm.superseded_by : undefined;
    const kind: ChangeKind = supersededBy
      ? "superseded"
      : createdInWindow.has(concept.path)
        ? "created"
        : updatedInWindow.has(concept.path)
          ? "updated"
          : "changed";
    const entry: ChangeEntry = {
      kind,
      path: concept.path,
      title: typeof fm.title === "string" ? fm.title : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      timestamp,
      timestamp_source: source,
    };
    if (supersededBy) entry.superseded_by = supersededBy;
    changes.push(entry);
  }

  changes.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.path.localeCompare(b.path));
  const counts = { created: 0, updated: 0, changed: 0, superseded: 0, deleted: deleted.length };
  for (const c of changes) counts[c.kind]++;

  return {
    since: sinceDate.toISOString(),
    scope,
    counts,
    changes: changes.slice(0, limit),
    deleted,
    truncated: changes.length > limit,
  };
}
