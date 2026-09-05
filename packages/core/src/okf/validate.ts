import { parseDoc, hasNonEmptyType } from "./frontmatter.js";
import { isValidIsoDate, BELIEF_SOURCES } from "./temporal.js";
import type { Bundle } from "./bundle.js";
import type { ConformanceIssue, ConformanceReport } from "./types.js";

/**
 * Conformance check per spec §9. Errors make the bundle non-conformant;
 * warnings (broken links, missing recommended fields) never do — the spec
 * requires consumers to tolerate them.
 */
export async function validateBundle(bundle: Bundle): Promise<ConformanceReport> {
  const issues: ConformanceIssue[] = [];
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);
  let directoryCount = 0;

  const countDirs = async (dir: string): Promise<void> => {
    directoryCount++;
    for (const sub of await bundle.listSubdirectories(dir)) await countDirs(sub);
  };
  await countDirs("/");

  for (const conceptPath of paths) {
    let raw: string;
    try {
      raw = await bundle.readFileRaw(conceptPath);
    } catch {
      continue;
    }
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseDoc(raw));
    } catch {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: "Frontmatter is not parseable YAML (spec §9.1)",
      });
      continue;
    }
    if (!hasNonEmptyType(frontmatter)) {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: 'Missing non-empty "type" frontmatter field (spec §9.2)',
      });
    }
    if (!frontmatter.title) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "title" field',
      });
    }
    if (!frontmatter.description) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "description" field',
      });
    }
    // Broken bundle-relative links → warnings only (spec: MUST tolerate).
    for (const match of body.matchAll(/\]\((\/[^)#?\s]+\.md)\)/g)) {
      if (!known.has(match[1])) {
        issues.push({
          path: conceptPath,
          severity: "warning",
          message: `Broken bundle-relative link: ${match[1]}`,
        });
      }
    }

    // PRISM-22: temporal/provenance fields are optional and additive, so a
    // malformed value here is a warning, never a conformance error — these
    // are already rejected at write time by Bundle.writeConcept; this only
    // catches a bundle that was hand-edited or written before validation
    // existed.
    const { asserted, source, confidence, supersedes, superseded_by } = frontmatter;
    if (asserted !== undefined && !isValidIsoDate(asserted)) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: `Malformed "asserted" date: ${JSON.stringify(asserted)} (expected ISO 8601)`,
      });
    }
    if (source !== undefined && !(BELIEF_SOURCES as readonly string[]).includes(source as string)) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: `Unknown "source": ${JSON.stringify(source)} (expected one of: ${BELIEF_SOURCES.join(", ")})`,
      });
    }
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: `Out-of-range "confidence": ${JSON.stringify(confidence)} (expected a number between 0 and 1)`,
      });
    }
    for (const [field, value] of [
      ["supersedes", supersedes],
      ["superseded_by", superseded_by],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== "string" || !known.has(value)) {
        issues.push({
          path: conceptPath,
          severity: "warning",
          message: `Dangling "${field}" reference: ${JSON.stringify(value)}`,
        });
      }
    }
  }

  return {
    conformant: !issues.some((i) => i.severity === "error"),
    conceptCount: paths.length,
    directoryCount,
    issues,
  };
}
