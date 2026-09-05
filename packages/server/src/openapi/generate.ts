import { zodToJsonSchema } from "zod-to-json-schema";
import { CORE_TOOLS } from "@prism/core";
import { ROUTES } from "./routes.js";

const API_VERSION = "1.0.0";

/**
 * Build the OpenAPI 3.0 document for the versioned REST API. Generated, not
 * hand-maintained: every path/operation for a registry-backed route comes
 * from CORE_TOOLS + its own Zod inputSchema via zod-to-json-schema — add an
 * operation to CORE_TOOLS and a line to ROUTES, and it appears here with no
 * other edit (PRISM-17 acceptance criterion 2). The small set of pre-existing
 * read-only "browse" endpoints (tree/log/graph/traces/config/...) predate the
 * registry and aren't schema-registry-backed, so they're documented with a
 * short hand-authored block below rather than claimed as generated.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    Error: {
      type: "object",
      properties: { error: { type: "string" }, code: { type: "string" } },
      required: ["error"],
    },
    ValidationError: {
      type: "object",
      properties: {
        error: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, message: { type: "string" } },
          },
        },
      },
      required: ["error", "issues"],
    },
  };

  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const def = CORE_TOOLS.find((t) => t.name === route.tool);
    if (!def) throw new Error(`buildOpenApiDocument: no CORE_TOOLS entry named "${route.tool}"`);

    const schemaName = toPascalCase(def.name) + "Input";
    schemas[schemaName] = zodToJsonSchema(def.inputSchema, { target: "openApi3", $refStrategy: "none" });

    const operation: Record<string, unknown> = {
      operationId: def.name,
      summary: def.title,
      description: def.description,
      tags: [def.mutates ? "Write" : "Read"],
      responses: {
        [String(route.successStatus ?? 200)]: { description: "Success" },
        "400": {
          description: "Invalid input or a rejected mutation (e.g. path escapes the bundle, missing required field)",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationError" } } },
        },
        "404": {
          description: "Concept not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };

    if (route.style === "query") {
      operation.parameters = buildQueryParameters(def.inputSchema);
    } else {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
      };
    }

    paths[route.path] ??= {};
    paths[route.path][route.method] = operation;
  }

  // Fixed set of pre-existing read-only browse endpoints, still served
  // unversioned at /api/* and aliased here at /api/v1/* — hand-documented
  // since they predate the tool registry and carry no Zod schema to derive
  // from. See README/browse.ts for the source of truth on their behavior.
  const browsePaths: Record<string, Record<string, unknown>> = {
    "/tree": { get: browseOp("Full bundle directory tree", "Read") },
    "/log": { get: browseOp("Update log entries, newest first", "Read") },
    "/validate": { get: browseOp("OKF conformance report", "Read") },
    "/graph": { get: browseOp("Inter-concept link graph (nodes + edges)", "Read") },
    "/traces": { get: browseOp("List of past agent runs (summary view)", "Read") },
    "/trace": { get: browseOp("One agent run's full trace, by id", "Read") },
    "/types": { get: browseOp("Concept types currently in use", "Read") },
    "/config": { get: browseOp("Whether an LLM provider is configured", "Read") },
  };
  Object.assign(paths, browsePaths);

  return {
    // 3.0.3, not 3.1: zod-to-json-schema's "openApi3" target emits OpenAPI
    // 3.0 schema conventions (boolean exclusiveMinimum/Maximum alongside
    // minimum/maximum, no top-level "type" arrays) — declaring 3.1 here
    // while emitting 3.0-shaped schemas would itself be a validation gap.
    openapi: "3.0.3",
    info: {
      title: "Prism API",
      version: API_VERSION,
      description:
        "REST surface over the Prism knowledge base. Read operations never touch an LLM. " +
        "Write operations (tag: Write) enforce the same conformance guarantees as every other adapter — " +
        "frontmatter validation, path sandboxing, index/log maintenance — see the project's PRISM-16 notes. " +
        "Optional bearer-token auth: when the server has AUTH_TOKEN set, every request under /api/v1 " +
        "requires `Authorization: Bearer <token>`; unset, the API is open (homelab default).",
    },
    servers: [{ url: "/api/v1", description: "Versioned API (this document)" }],
    security: [{ bearerAuth: [] }],
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Required only when the server is started with AUTH_TOKEN set.",
        },
      },
    },
    paths,
  };
}

function browseOp(summary: string, tag: string): Record<string, unknown> {
  return {
    summary,
    tags: [tag, "Browse (legacy, also served unversioned at /api)"],
    responses: { "200": { description: "Success" } },
  };
}

function buildQueryParameters(inputSchema: unknown): unknown[] {
  const jsonSchema = zodToJsonSchema(inputSchema as never, { target: "openApi3", $refStrategy: "none" }) as {
    properties?: Record<string, { type?: string; description?: string; items?: unknown }>;
    required?: string[];
  };
  const props = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  return Object.entries(props).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    description: schema.description,
    schema: schema.type === "array" ? { type: "string", description: "Comma-separated list" } : schema,
  }));
}

function toPascalCase(snake: string): string {
  return snake
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
