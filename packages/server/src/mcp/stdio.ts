#!/usr/bin/env node
/**
 * MCP over stdio — register in Claude Code / Claude Desktop:
 *   claude mcp add okf-kb -e BUNDLE_ROOT=/path/to/bundle -e OPENROUTER_API_KEY=... \
 *     -e LLM_PROVIDER=openrouter -- node <repo>/packages/server/dist/mcp/stdio.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase, resolveFallbackConfig, resolveModelConfig } from "@prism/core";
import { buildMcpServer } from "./server.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

// Validate LLM config at startup — log to stderr, but don't crash. Tier 0/1
// tools (memory_status, deterministic memory_maintain, and the registry's
// search/read/list/lint/write/patch/delete operations) work with no LLM at
// all; only Tier 2 operations need one, and they already fail per-request
// with a clear error via agent.ts's own try/catch. stdio's only output
// channel to the user is stderr; stdout is reserved for the MCP protocol
// stream.
try {
  const primaryConfig = resolveModelConfig();
  console.error(
    `[prism] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.error(
      `[prism] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[prism] no LLM configured: ${(err as Error).message}`);
  console.error(
    "[prism] starting anyway — Tier 0/1 tools (status, lint, search, read, write, patch, delete) work without one. " +
      "Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL to enable memory_query/memory_add/memory_update."
  );
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const server = await buildMcpServer(kb);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(`[prism] serving bundle ${bundleRoot} over stdio`);
