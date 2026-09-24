import { tool } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import {
  CORE_TOOLS,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type ToolContext,
  type ToolDefinition,
} from "../registry/index.js";
import type { TraceRecorder } from "./trace.js";

// Public re-export: formatTree's home moved to registry/format-tree.ts
// (PRISM-12, so both the agent loop and future adapters share it), but the
// agent package's public import path is unchanged.
export { formatTree } from "../registry/format-tree.js";

/**
 * Render one registry definition into an `ai`-SDK tool bound to a bundle
 * and a call context. This is the ENTIRE adapter — a registry entry's
 * description and inputSchema pass straight through, and execute is a
 * direct call to the same handler every other adapter will call.
 */
function toAiTool(def: ToolDefinition, kb: KnowledgeBase, ctx: ToolContext) {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: (input: unknown) => def.handler(kb, input, ctx),
  });
}

function toolsByName(names: readonly string[], kb: KnowledgeBase, ctx: ToolContext) {
  const defs = CORE_TOOLS.filter((def) => names.includes(def.name));
  return Object.fromEntries(defs.map((def) => [def.name, toAiTool(def, kb, ctx)]));
}

/**
 * The internal agent's read-only tools. Every entry is a direct render of a
 * registry/index.ts definition (PRISM-12) — the agent tool loop and every
 * future external adapter are provably driven by the same definitions.
 */
export function buildReadTools(kb: KnowledgeBase, trace?: TraceRecorder, readVersions?: Map<string, string>) {
  return toolsByName(READ_TOOL_NAMES, kb, { trace, readVersions });
}

/**
 * The internal agent's write tools, rendered from the same registry. Pass
 * the SAME readVersions map given to buildReadTools so writes are guarded
 * against changes made by other writers since the agent read a concept
 * (PRISM-27).
 */
export function buildWriteTools(
  kb: KnowledgeBase,
  filesChanged: Set<string>,
  trace?: TraceRecorder,
  readVersions?: Map<string, string>
) {
  return toolsByName(WRITE_TOOL_NAMES, kb, { trace, filesChanged, readVersions });
}
