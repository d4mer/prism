import { z } from "zod";

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
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

export const logSummarySchema = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );
