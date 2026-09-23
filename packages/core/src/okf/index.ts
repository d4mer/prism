export * from "./types.js";
export { parseDoc, serializeDoc, hasNonEmptyType } from "./frontmatter.js";
export { Bundle, BundleError, replaceSection } from "./bundle.js";
export { regenerateIndex, regenerateIndexChain, pruneEmptyDirs } from "./indexer.js";
export { appendLog, readLog } from "./logger.js";
export { searchBundle, listTypes, type SearchOptions } from "./search.js";
export { validateBundle } from "./validate.js";
export { lintBundle } from "./lint.js";
export type { LintReport, LintFinding, BrokenLink } from "./lint.js";
export { buildGraph, scanGraph } from "./graph.js";
export type { GraphData, GraphNode, GraphEdge, BuildGraphOptions } from "./graph.js";
export { findRelated } from "./related.js";
export type { RelatedHit, RelatedOptions } from "./related.js";
export { queryAsOf } from "./asof.js";
export {
  planCapture,
  deriveTitle,
  slugify,
  DEFAULT_CAPTURE_FOLDER,
  DEFAULT_CAPTURE_TYPE,
  INBOX_TAG,
} from "./capture.js";
export type { CaptureOptions, CapturePlan } from "./capture.js";
export { KnowledgeBase, type KnowledgeBaseOptions } from "./knowledge-base.js";
export { changesSince, resolveSince } from "./changes.js";
export type { ChangesReport, ChangeEntry, ChangeKind, DeletionEntry, ChangesOptions } from "./changes.js";
export { normalizeScope, inScope } from "./scope.js";
export {
  aliasesOf,
  aliasScore,
  fieldProblems,
  validateConsultantFields,
  FieldValidationError,
  ITEM_STATUSES,
  RESOLVED_STATUSES,
} from "./fields.js";
export type { ItemStatus } from "./fields.js";
export { listOpenItems } from "./open-items.js";
export type { OpenItem, OpenItemsReport, OpenItemsOptions } from "./open-items.js";
