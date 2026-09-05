import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import { BundleError, CORE_TOOLS, type KnowledgeBase, type ToolDefinition } from "@prism/core";
import { ROUTES } from "../openapi/routes.js";
import { coerceQuery } from "../openapi/query-coerce.js";

/**
 * REST rendering of the registry (PRISM-17) — the third adapter over
 * CORE_TOOLS after the internal agent-loop render (tools.ts) and MCP
 * (mcp/server.ts). Every route here is generated from ROUTES + the tool's
 * own Zod inputSchema; there is no per-tool business logic, only per-tool
 * routing (method/path) and input transport (query vs body).
 */
export function registryRestRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  for (const route of ROUTES) {
    const def = CORE_TOOLS.find((t) => t.name === route.tool);
    if (!def) {
      // Fails loudly at startup, not per-request, if routes.ts drifts from CORE_TOOLS.
      throw new Error(`registryRestRouter: no CORE_TOOLS entry named "${route.tool}"`);
    }
    const handler = makeHandler(kb, def, route.style, route.successStatus ?? 200);
    switch (route.method) {
      case "get":
        router.get(route.path, handler);
        break;
      case "post":
        router.post(route.path, handler);
        break;
      case "patch":
        router.patch(route.path, handler);
        break;
      case "delete":
        router.delete(route.path, handler);
        break;
    }
  }

  return router;
}

function makeHandler(
  kb: KnowledgeBase,
  def: ToolDefinition,
  style: "query" | "body",
  successStatus: number
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = style === "query" ? coerceQuery(def.inputSchema, req.query as Record<string, unknown>) : req.body;
      const input = def.inputSchema.parse(raw ?? {});
      const result = await def.handler(kb, input);
      res.status(successStatus).json(result);
    } catch (err) {
      sendToolError(res, err, next);
    }
  };
}

/** Never a stack trace: every error a tool handler can throw maps to a clean JSON shape. */
function sendToolError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Invalid input",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof BundleError) {
    const status = err.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof Error) {
    // A tool handler's own thrown Error (e.g. link_add's "already exists" /
    // "must be a different concept") — deterministic, not a provider fault.
    res.status(400).json({ error: err.message });
    return;
  }
  next(err); // truly unexpected shape — let Express's default handler log it
}
