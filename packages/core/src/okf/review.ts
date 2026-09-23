/**
 * PRISM-58: the review queue — what a consultant should re-check, as a
 * short prioritised list instead of a whole-bundle audit. Deterministic,
 * zero LLM. Four signals, each an entry reason:
 *
 *  - overdue        an open item past its due date (PRISM-56)
 *  - untriaged      a quick capture still in the inbox after N days (PRISM-52)
 *  - low_confidence a belief whose `confidence` is below a threshold (PRISM-22)
 *  - stale          untouched for N days while other concepts in the SAME
 *                   directory changed within that window — "the rest of this
 *                   area moved on and this note didn't". Deliberately not
 *                   "everything older than N days": in a long-running bundle
 *                   that would bury the signal under settled reference
 *                   material nobody needs to touch.
 *
 * Superseded concepts are history, never reviewed; closed items are never
 * "stale" (nothing left to do). Entries are ranked by summed reason weight,
 * then oldest-touched first.
 */
import path from "node:path";
import type { Bundle } from "./bundle.js";
import { DEFAULT_CAPTURE_FOLDER, INBOX_TAG } from "./capture.js";
import { listOpenItems } from "./open-items.js";
import { inScope, normalizeScope } from "./scope.js";
import type { ConceptFrontmatter } from "./types.js";

export type ReviewReasonKind = "overdue" | "untriaged" | "low_confidence" | "stale";

export interface ReviewReason {
  kind: ReviewReasonKind;
  detail: string;
}

export interface ReviewEntry {
  path: string;
  title?: string;
  type?: string;
  reasons: ReviewReason[];
  /** ISO time the concept was last written. */
  last_touched?: string;
  priority: number;
}

export interface ReviewReport {
  entries: ReviewEntry[];
  counts: Record<ReviewReasonKind, number> & { total: number };
  truncated: boolean;
}

export interface ReviewOptions {
  scope?: string;
  /** Inbox captures older than this many days are "untriaged" (default 3). */
  inboxDays?: number;
  /** Untouched this many days in an active directory is "stale" (default 90). */
  staleDays?: number;
  /** Confidence strictly below this is "low_confidence" (default 0.5). */
  minConfidence?: number;
  limit?: number;
  now?: Date;
}

const WEIGHT: Record<ReviewReasonKind, number> = { overdue: 4, untriaged: 3, low_confidence: 2, stale: 1 };
const DAY_MS = 86_400_000;

function touchedAt(fm: ConceptFrontmatter): number | undefined {
  const t = typeof fm.timestamp === "string" ? Date.parse(fm.timestamp) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

export async function reviewQueue(bundle: Bundle, options: ReviewOptions = {}): Promise<ReviewReport> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const scope = normalizeScope(options.scope);
  const inboxDays = options.inboxDays ?? 3;
  const staleDays = options.staleDays ?? 90;
  const minConfidence = options.minConfidence ?? 0.5;
  const limit = options.limit ?? 50;

  // Load every in-scope, current (non-superseded) concept once.
  const concepts: { path: string; fm: ConceptFrontmatter }[] = [];
  for (const p of await bundle.listConceptPaths()) {
    if (!inScope(p, scope)) continue;
    try {
      const { frontmatter } = await bundle.readConcept(p);
      if (typeof frontmatter.superseded_by === "string" && frontmatter.superseded_by) continue;
      concepts.push({ path: p, fm: frontmatter });
    } catch {
      // permissive, as everywhere else
    }
  }

  // Directories with at least one concept written inside the stale window.
  const staleCutoff = nowMs - staleDays * DAY_MS;
  const activeDirs = new Set(
    concepts.filter((c) => (touchedAt(c.fm) ?? -Infinity) >= staleCutoff).map((c) => path.posix.dirname(c.path))
  );

  const overdue = new Map(
    (await listOpenItems(bundle, { scope, overdueOnly: true, now, limit: Number.MAX_SAFE_INTEGER })).items.map((i) => [
      i.path,
      i,
    ])
  );

  const entries: ReviewEntry[] = [];
  for (const { path: p, fm } of concepts) {
    const reasons: ReviewReason[] = [];
    const touched = touchedAt(fm);

    const item = overdue.get(p);
    if (item) {
      reasons.push({
        kind: "overdue",
        detail: `${item.status}, due ${item.due} (${item.days_overdue}d overdue)${item.owner ? `, owner ${item.owner}` : ""}`,
      });
    }

    const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).toLowerCase()) : [];
    const inInbox = tags.includes(INBOX_TAG) || inScope(p, DEFAULT_CAPTURE_FOLDER);
    const captured = typeof fm.asserted === "string" && !Number.isNaN(Date.parse(fm.asserted)) ? Date.parse(fm.asserted) : touched;
    if (inInbox && captured !== undefined && nowMs - captured > inboxDays * DAY_MS) {
      reasons.push({
        kind: "untriaged",
        detail: `in the inbox for ${Math.floor((nowMs - captured) / DAY_MS)}d — file it, link it, or delete it`,
      });
    }

    if (typeof fm.confidence === "number" && fm.confidence < minConfidence) {
      reasons.push({ kind: "low_confidence", detail: `confidence ${fm.confidence} < ${minConfidence}` });
    }

    if (
      touched !== undefined &&
      touched < staleCutoff &&
      fm.status !== "closed" &&
      activeDirs.has(path.posix.dirname(p))
    ) {
      reasons.push({
        kind: "stale",
        detail: `untouched for ${Math.floor((nowMs - touched) / DAY_MS)}d while ${path.posix.dirname(p)} has recent changes`,
      });
    }

    if (reasons.length === 0) continue;
    entries.push({
      path: p,
      title: typeof fm.title === "string" ? fm.title : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      reasons,
      last_touched: touched !== undefined ? new Date(touched).toISOString() : undefined,
      priority: reasons.reduce((sum, r) => sum + WEIGHT[r.kind], 0),
    });
  }

  entries.sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.last_touched ?? "").localeCompare(b.last_touched ?? "") ||
      a.path.localeCompare(b.path)
  );

  const counts = { overdue: 0, untriaged: 0, low_confidence: 0, stale: 0, total: entries.length };
  for (const e of entries) for (const r of e.reasons) counts[r.kind]++;
  return { entries: entries.slice(0, limit), counts, truncated: entries.length > limit };
}
