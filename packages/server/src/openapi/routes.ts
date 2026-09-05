import type { ToolDefinition } from "@prism/core";

/**
 * Single source of truth for how each CORE_TOOLS entry is exposed over
 * REST — shared by the router (api/registry-rest.ts) and the OpenAPI
 * generator (openapi/generate.ts) so the two can never drift from each
 * other. A tool's HTTP method/path/param-style is the only thing hand-
 * mapped here; the actual request/response SCHEMA for every route is
 * derived from the tool's own Zod inputSchema (PRISM-17 acceptance
 * criterion: "generated from registry entries and their Zod schemas —
 * never hand-maintained, so it cannot drift"). Adding a new CORE_TOOLS
 * entry without adding a line here simply leaves it unexposed over REST
 * (still available over MCP) — an intentional, visible omission rather
 * than a silent schema mismatch.
 */
export type ParamStyle = "query" | "body";

export interface RouteDef {
  /** Must match a CORE_TOOLS entry's `name` exactly. */
  tool: string;
  method: "get" | "post" | "patch" | "delete";
  /** Relative to the /api/v1 mount point. */
  path: string;
  /** GET routes read input from the query string; everything else from a JSON body. */
  style: ParamStyle;
  /** HTTP status for a successful mutating call (reads always 200). */
  successStatus?: number;
}

export const ROUTES: readonly RouteDef[] = [
  { tool: "concept_list", method: "get", path: "/concepts", style: "query" },
  { tool: "concept_search", method: "get", path: "/concepts/search", style: "query" },
  { tool: "concept_read", method: "get", path: "/concepts/one", style: "query" },
  { tool: "graph_lint", method: "get", path: "/graph/lint", style: "query" },
  { tool: "concept_write", method: "post", path: "/concepts", style: "body", successStatus: 201 },
  { tool: "concept_patch", method: "patch", path: "/concepts", style: "body" },
  { tool: "concept_delete", method: "delete", path: "/concepts", style: "body" },
  { tool: "link_add", method: "post", path: "/links", style: "body", successStatus: 201 },
  { tool: "concept_supersede", method: "post", path: "/concepts/supersede", style: "body", successStatus: 201 },
];

export function routeFor(tools: readonly ToolDefinition[], tool: string): ToolDefinition {
  const def = tools.find((t) => t.name === tool);
  if (!def) throw new Error(`openapi/routes: no CORE_TOOLS entry named "${tool}" (routes.ts is out of sync)`);
  return def;
}
