import { z } from "zod";
import { isValidIsoDate, BELIEF_SOURCES } from "../okf/temporal.js";

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
export const conceptPathSchema = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

export const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
    // PRISM-22: temporal & provenance. All optional/additive — a concept
    // that never sets these stays fully valid. Deep checks (existence,
    // cycle detection) happen in Bundle.writeConcept; these are the
    // shape-level checks for concept_write's up-front validation.
    asserted: z
      .string()
      .refine(isValidIsoDate, { message: "must be an ISO 8601 date or date-time, e.g. 2026-09-05" })
      .optional()
      .describe("When this belief was asserted true (ISO 8601 date or date-time)"),
    source: z
      .enum(BELIEF_SOURCES)
      .optional()
      .describe(`Provenance of this belief: one of ${BELIEF_SOURCES.join(", ")}`),
    confidence: z.number().min(0).max(1).optional().describe("Confidence in this belief, 0-1"),
    supersedes: conceptPathSchema
      .optional()
      .describe("Bundle-relative path of the concept this one supersedes"),
    superseded_by: conceptPathSchema
      .optional()
      .describe("Bundle-relative path of the concept that superseded this one"),
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

export const logSummarySchema = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );
