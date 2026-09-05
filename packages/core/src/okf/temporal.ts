import type { Bundle } from "./bundle.js";
import type { ConceptFrontmatter } from "./types.js";

/**
 * PRISM-22: temporal & provenance frontmatter fields. All optional and
 * additive — a concept written before these existed, or one that never
 * sets them, stays fully valid (spec §9: consumers must not require
 * unknown/absent fields).
 */
export const BELIEF_SOURCES = ["session", "agent", "human", "document"] as const;
export type BeliefSource = (typeof BELIEF_SOURCES)[number];

/**
 * Thrown by validateTemporalFrontmatter. Kept distinct from BundleError
 * (defined in bundle.ts) to avoid a value-level circular import between
 * this module and bundle.ts, which imports validateTemporalFrontmatter;
 * bundle.ts catches this and re-throws it as its own BundleError with the
 * same message and code "INVALID_FRONTMATTER".
 */
export class TemporalFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalFrontmatterError";
  }
}

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** True for a well-formed, calendar-valid ISO 8601 date or date-time string. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject e.g. "2026-02-30" — Date rolls it into March, so cross-check the
  // calendar fields survived the round trip (using UTC since a bare date
  // like "2026-09-05" parses as UTC midnight).
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d
  );
}

function isBundleRelativeConceptPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.endsWith(".md");
}

/**
 * Walk a supersession chain (following `field` from `from`) looking for a
 * path back to `origin`. Bounded by the bundle's own concept count so a
 * pre-existing cycle in hand-edited data can't spin forever.
 */
async function chainReaches(
  bundle: Bundle,
  field: "supersedes" | "superseded_by",
  from: string,
  origin: string,
  maxSteps: number
): Promise<boolean> {
  let current = from;
  const visited = new Set<string>();
  for (let i = 0; i < maxSteps; i++) {
    if (current === origin) return true;
    if (visited.has(current)) return false; // an unrelated pre-existing cycle; not this write's problem
    visited.add(current);
    let next: unknown;
    try {
      next = (await bundle.readConcept(current)).frontmatter[field];
    } catch {
      return false; // dangling/unreadable — a separate, already-surfaced problem
    }
    if (!isBundleRelativeConceptPath(next)) return false;
    current = next;
  }
  return false;
}

/**
 * Deep validation for the temporal/provenance fields, called from
 * Bundle.writeConcept (so it covers both concept_write and concept_patch,
 * since patch resolves to a writeConcept call) — the one write path per
 * PRISM-16/tenet-2. Throws TemporalFrontmatterError naming the offending
 * field (PRISM-22 acceptance criterion 2); bundle.ts rewraps it as a
 * BundleError("INVALID_FRONTMATTER").
 */
export async function validateTemporalFrontmatter(
  bundle: Bundle,
  canonicalPath: string,
  frontmatter: ConceptFrontmatter
): Promise<void> {
  const { asserted, source, confidence, supersedes, superseded_by } = frontmatter;

  if (asserted !== undefined && !isValidIsoDate(asserted)) {
    throw new TemporalFrontmatterError(
      `Invalid "asserted" date: ${JSON.stringify(asserted)} (expected ISO 8601, e.g. "2026-09-05" or "2026-09-05T14:30:00Z")`
    );
  }

  if (source !== undefined && !(BELIEF_SOURCES as readonly string[]).includes(source as string)) {
    throw new TemporalFrontmatterError(
      `Invalid "source": ${JSON.stringify(source)} (must be one of: ${BELIEF_SOURCES.join(", ")})`
    );
  }

  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new TemporalFrontmatterError(
      `Invalid "confidence": ${JSON.stringify(confidence)} (must be a number between 0 and 1)`
    );
  }

  const maxSteps = (await bundle.listConceptPaths()).length + 1;

  for (const [field, value] of [
    ["supersedes", supersedes],
    ["superseded_by", superseded_by],
  ] as const) {
    if (value === undefined) continue;
    if (!isBundleRelativeConceptPath(value)) {
      throw new TemporalFrontmatterError(
        `Invalid "${field}": ${JSON.stringify(value)} (must be a bundle-relative concept path ending in .md)`
      );
    }
    const target = bundle.toBundlePath(value);
    if (target === canonicalPath) {
      throw new TemporalFrontmatterError(
        `"${field}" cannot reference the concept's own path (${canonicalPath})`
      );
    }
    if (!(await bundle.exists(target))) {
      throw new TemporalFrontmatterError(`"${field}" target does not exist: ${target}`);
    }
    if (await chainReaches(bundle, field, target, canonicalPath, maxSteps)) {
      throw new TemporalFrontmatterError(
        `"${field}" would create a supersession cycle through ${target}`
      );
    }
  }
}
