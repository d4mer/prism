import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { KnowledgeBase, resolveFallbackConfig, resolveModelConfig } from "@prism/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { bearerAuth } from "./auth.js";
import { startDreamer } from "./dreamer.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

startDreamer(kb);

const app = express();

// Validate LLM config at startup — log clearly, but don't crash. Tier 0/1
// tools (memory_status, deterministic memory_maintain, and the registry's
// search/read/list/lint/write/patch/delete operations) work with no LLM at
// all. Only Tier 2 operations (memory_query's deep-agent fallback,
// memory_add, memory_update, an unhealthy memory_maintain) need one, and
// they already fail per-request with a clear error via agent.ts's own
// try/catch — they do not need the process to refuse to start.
// TODO(PRISM-14): surface this state to clients (e.g. an MCP resource or
// memory_status field) instead of only a startup log line.
try {
  const primaryConfig = resolveModelConfig();
  console.log(
    `[prism] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.log(
      `[prism] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.warn(`[prism] no LLM configured: ${(err as Error).message}`);
  console.warn(
    "[prism] starting anyway — Tier 0/1 tools (status, lint, search, read, write, patch, delete) work without one. " +
      "Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL to enable memory_query/memory_add/memory_update."
  );
}

// Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
// read it back off the initialize response.
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json({ limit: "4mb" }));

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
const authToken = process.env.AUTH_TOKEN;
if (authToken) {
  app.use(["/mcp", "/api"], bearerAuth(authToken));
  console.log("[prism] auth: bearer token required for /mcp and /api");
} else {
  console.log("[prism] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
}

app.use("/mcp", mcpRouter(kb));
app.use("/api", browseRouter(kb));
app.use("/api", chatRouter(kb));

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 3800);
app.listen(port, "0.0.0.0", () => {
  console.log(`prism serving bundle ${bundleRoot} on :${port} (web + /api + /mcp)`);
});
