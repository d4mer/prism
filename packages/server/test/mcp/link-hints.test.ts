import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeBase } from "@prism/core";
import { mcpRouter } from "../../src/mcp/http.js";

const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0].text;
const hintOf = (r: { content?: unknown }) => {
  const blocks = r.content as { text: string }[];
  const h = blocks.find((b) => b.text.startsWith("HINT: "));
  return h ? JSON.parse(h.text.slice(6)) : undefined;
};

describe("unlinked-write hint on direct MCP writes", () => {
  let root: string;
  let server: http.Server;
  let client: Client;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prism-hint-"));
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpRouter(new KnowledgeBase(root)));
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    client = new Client({ name: "hint-test", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });
  afterEach(async () => {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = (p: string, title: string, body: string) =>
    client.callTool({
      name: "concept_write",
      arguments: { path: p, frontmatter: { type: "Note", title, description: `${title} notes` }, body, log_summary: "test" },
    });

  it("warns about an unlinked concept and suggests related existing ones", async () => {
    await write("/apis/billing.md", "Billing retries", "Billing retries failed charges.");
    const raw = await write("/notes/billing-backoff.md", "Billing retries backoff", "Backoff for billing retries.");
    expect(JSON.parse(text(raw))).toEqual({ written: "/notes/billing-backoff.md" }); // result itself unchanged
    const hint = hintOf(raw);
    expect(hint.warning).toMatch(/no links/);
    expect(hint.link_candidates.map((c: { path: string }) => c.path)).toContain("/apis/billing.md");
    expect(hint.link_candidates.map((c: { path: string }) => c.path)).not.toContain("/notes/billing-backoff.md");
  });

  it("gives no hint once the concept is linked", async () => {
    await write("/apis/billing.md", "Billing retries", "Billing retries failed charges.");
    const raw = await write("/notes/linked.md", "Linked note", "See [Billing](/apis/billing.md).");
    expect(hintOf(raw)).toBeUndefined();
    expect(JSON.parse(text(raw)).written).toBe("/notes/linked.md");
  });

  it("concept_patch and concept_supersede carry the hint too; reads and link_add do not", async () => {
    await write("/apis/a.md", "Alpha thing", "alpha");
    const patched = await client.callTool({ name: "concept_patch", arguments: { path: "/apis/a.md", replace_body: "alpha two", log_summary: "t" } });
    expect(hintOf(patched)?.warning).toMatch(/no links/);
    const sup = await client.callTool({ name: "concept_supersede", arguments: { old_path: "/apis/a.md", new_path: "/apis/a2.md", frontmatter: { type: "Note", title: "Alpha thing v2" }, body: "alpha v2", log_summary: "t" } });
    expect(JSON.parse(text(sup)).created).toBe("/apis/a2.md");
    expect(hintOf(sup)?.warning).toContain("/apis/a2.md");
    const read = await client.callTool({ name: "concept_read", arguments: { path: "/apis/a2.md" } });
    expect(hintOf(read)).toBeUndefined();
    await write("/apis/b.md", "Beta thing", "beta");
    const link = await client.callTool({ name: "link_add", arguments: { source: "/apis/b.md", target: "/apis/a2.md", log_summary: "t" } });
    expect(hintOf(link)).toBeUndefined();
  });
});
