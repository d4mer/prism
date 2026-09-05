import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeBase } from "@prism/core";
import { bearerAuth } from "../src/auth.js";
import { mcpRouter } from "../src/mcp/http.js";

/**
 * PRISM-18: proves the exact wire protocol Open WebUI's native MCP client
 * speaks (streamable HTTP, real @modelcontextprotocol/sdk client — not a
 * hand-rolled JSON-RPC POST via supertest) round-trips against /mcp end to
 * end: list tools, call a granular registry tool, read the result back.
 * Covers both configurations the ticket calls for — an open LAN server and
 * one behind AUTH_TOKEN — against a real listening HTTP server (Express's
 * request/response objects, not supertest's in-memory ones), since that's
 * what a real external client like Open WebUI actually connects to.
 */
describe("streamable-HTTP MCP client end-to-end (PRISM-18)", () => {
  let root: string;
  let server: http.Server;
  let baseUrl: URL;

  async function startServer(authToken?: string) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prism18-http-mcp-"));
    const kb = new KnowledgeBase(root);
    const app = express();
    app.use(express.json());
    if (authToken) app.use("/mcp", bearerAuth(authToken));
    app.use("/mcp", mcpRouter(kb));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no port assigned");
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("unauthenticated LAN setup (no AUTH_TOKEN)", () => {
    beforeEach(() => startServer());

    it("a real MCP client lists tools and completes a write→read round trip with no LLM involved server-side", async () => {
      const client = new Client({ name: "open-webui-stand-in", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(baseUrl);
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      // Granular tools discoverable and callable (implementation contract,
      // bullet 2) — the same registry surface every other adapter renders.
      for (const t of ["concept_write", "concept_read", "concept_list", "concept_search", "graph_lint"]) {
        expect(names).toContain(t);
      }

      // "Open WebUI's own model performs the filing with no second inference
      // hop": concept_write is a plain registry tool call — it never touches
      // an LLM on Prism's side, so this succeeding with zero LLM configured
      // in this test process *is* that property, not just a proxy for it.
      const write = await client.callTool({
        name: "concept_write",
        arguments: {
          path: "/tables/owui-smoke.md",
          frontmatter: { type: "Test" },
          body: "# From Open WebUI\n\nFiled directly via the granular registry tool.\n",
          log_summary: "PRISM-18 smoke: create from stand-in MCP client",
        },
      });
      expect((write as { isError?: boolean }).isError).not.toBe(true);

      const read = await client.callTool({
        name: "concept_read",
        arguments: { path: "/tables/owui-smoke.md" },
      });
      const readText = (read.content as { text: string }[])[0].text;
      expect(readText).toContain("Filed directly via the granular registry tool.");

      // And it really did land in the bundle on disk — not just echoed back.
      const onDisk = await fs.readFile(path.join(root, "tables", "owui-smoke.md"), "utf-8");
      expect(onDisk).toContain("Filed directly via the granular registry tool.");

      await client.close();
    });
  });

  describe("bearer-token setup (AUTH_TOKEN set)", () => {
    const TOKEN = "owui-s3cret";
    beforeEach(() => startServer(TOKEN));

    it("rejects a client with no token", async () => {
      const client = new Client({ name: "open-webui-stand-in", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(baseUrl);
      await expect(client.connect(transport)).rejects.toThrow();
    });

    it("a client configured with the bearer token (as Open WebUI's Key field would be) connects and calls a tool", async () => {
      const client = new Client({ name: "open-webui-stand-in", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("concept_list");

      const result = await client.callTool({ name: "concept_list", arguments: { path: "/" } });
      expect((result as { isError?: boolean }).isError).not.toBe(true);

      await client.close();
    });
  });
});
