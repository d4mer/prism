export type { ToolContext, ToolDefinition } from "./types.js";
export { conceptPathSchema, frontmatterSchema, logSummarySchema } from "./schemas.js";
export {
  changesSinceTool,
  conceptAsOfTool,
  conceptCaptureTool,
  conceptDeleteTool,
  conceptListTool,
  conceptPatchTool,
  conceptReadTool,
  conceptRelatedTool,
  conceptSearchTool,
  conceptSupersedeTool,
  conceptTemplateTool,
  conceptWriteTool,
  graphLintTool,
  linkAddTool,
  openItemsTool,
  reviewQueueTool,
} from "./operations.js";

import type { ToolDefinition } from "./types.js";
import {
  changesSinceTool,
  conceptAsOfTool,
  conceptCaptureTool,
  conceptDeleteTool,
  conceptListTool,
  conceptPatchTool,
  conceptReadTool,
  conceptRelatedTool,
  conceptSearchTool,
  conceptSupersedeTool,
  conceptTemplateTool,
  conceptWriteTool,
  graphLintTool,
  linkAddTool,
  openItemsTool,
  reviewQueueTool,
} from "./operations.js";

/**
 * Every deterministic (Tier 0/1) operation over the OKF core, in one place.
 * Every adapter — the internal agent tool loop today, MCP (PRISM-13) then
 * REST/CLI to follow (PRISM-17/20) — renders this same list into its own
 * protocol. Add an operation here once; it becomes available everywhere an
 * adapter iterates CORE_TOOLS. No entry here ever calls an LLM provider.
 */
export const CORE_TOOLS: readonly ToolDefinition[] = [
  conceptSearchTool,
  conceptReadTool,
  conceptListTool,
  graphLintTool,
  conceptRelatedTool,
  conceptWriteTool,
  conceptPatchTool,
  conceptDeleteTool,
  linkAddTool,
  conceptSupersedeTool,
  conceptAsOfTool,
  conceptCaptureTool,
  changesSinceTool,
  openItemsTool,
  conceptTemplateTool,
  reviewQueueTool,
];

/** Read-only subset — safe for any caller, any tier. */
export const READ_TOOL_NAMES = [
  conceptSearchTool.name,
  conceptReadTool.name,
  conceptListTool.name,
  graphLintTool.name,
  conceptRelatedTool.name,
  conceptAsOfTool.name,
  changesSinceTool.name,
  openItemsTool.name,
  conceptTemplateTool.name,
  reviewQueueTool.name,
] as const;

/** Mutating subset — still zero-LLM; conformance is enforced beneath these by the OKF layer. */
export const WRITE_TOOL_NAMES = [
  conceptWriteTool.name,
  conceptPatchTool.name,
  conceptDeleteTool.name,
  linkAddTool.name,
  conceptSupersedeTool.name,
  conceptCaptureTool.name,
] as const;

export function getTool(name: string): ToolDefinition | undefined {
  return CORE_TOOLS.find((t) => t.name === name);
}
