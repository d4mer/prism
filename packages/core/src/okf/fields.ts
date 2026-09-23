/**
 * Consultant-workflow frontmatter fields (PRISM-55 onward). Like the
 * PRISM-22 temporal fields: all optional and additive — a concept that never
 * sets them stays fully valid — but when present they must be well-formed,
 * enforced at write time by Bundle.writeConcept (and reported as warnings by
 * validateBundle for hand-edited files).
 */
import type { ConceptFrontmatter } from "./types.js";
import { isValidIsoDate } from "./temporal.js";

export class FieldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldValidationError";
  }
}

/** Every malformed consultant field in `fm`, as human-readable messages. */
export function fieldProblems(fm: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { aliases } = fm;
  if (
    aliases !== undefined &&
    !(Array.isArray(aliases) && aliases.every((a) => typeof a === "string" && a.trim().length > 0))
  ) {
    problems.push(`"aliases" must be a list of non-empty strings, got ${JSON.stringify(aliases)}`);
  }
  // PRISM-56: open-item fields.
  const { status, owner, due } = fm;
  if (status !== undefined && !(ITEM_STATUSES as readonly unknown[]).includes(status)) {
    problems.push(`"status" must be one of ${ITEM_STATUSES.join(", ")}, got ${JSON.stringify(status)}`);
  }
  if (owner !== undefined && !(typeof owner === "string" && owner.trim().length > 0)) {
    problems.push(`"owner" must be a non-empty string, got ${JSON.stringify(owner)}`);
  }
  if (due !== undefined && !isValidIsoDate(due)) {
    problems.push(`"due" must be an ISO 8601 date, e.g. 2026-10-01, got ${JSON.stringify(due)}`);
  }
  return problems;
}

// ── PRISM-56: open items ──────────────────────────────────────────────

/** Lifecycle of a tracked item (action, open question, decision awaiting sign-off). */
export const ITEM_STATUSES = ["open", "in_progress", "blocked", "decided", "closed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** Statuses that mean "nothing left to do" — excluded from open_items by default, never overdue. */
export const RESOLVED_STATUSES: readonly ItemStatus[] = ["decided", "closed"];

export function validateConsultantFields(fm: ConceptFrontmatter): void {
  const problems = fieldProblems(fm);
  if (problems.length > 0) throw new FieldValidationError(`Invalid frontmatter: ${problems.join("; ")}`);
}

// ── PRISM-55: aliases ─────────────────────────────────────────────────

/** A concept's aliases, lowercased and trimmed; tolerant of malformed values (read path). */
export function aliasesOf(fm: ConceptFrontmatter): string[] {
  return Array.isArray(fm.aliases)
    ? fm.aliases.filter((a): a is string => typeof a === "string").map((a) => a.trim().toLowerCase()).filter(Boolean)
    : [];
}

/** Per-term weight: same as a title hit — an alias IS another name for the concept. */
export const ALIAS_TERM_WEIGHT = 10;
/** Whole-query exact alias match: large enough to outrank any keyword-only score. */
export const EXACT_ALIAS_BOOST = 100;

/**
 * Alias contribution to a concept's keyword score. Shared verbatim by the
 * bundle scan (search.ts) and the derived index (search-index.ts) so the two
 * paths cannot drift (PRISM-35 AC2 parity).
 */
export function aliasScore(aliases: string[], terms: string[], query: string): number {
  if (aliases.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    if (aliases.some((a) => a.includes(term))) score += ALIAS_TERM_WEIGHT;
  }
  const whole = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (whole.length > 0 && aliases.includes(whole)) score += EXACT_ALIAS_BOOST;
  return score;
}
