import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { KnowledgeBase } from "@prism/core";
import { bearerAuth } from "../src/auth.js";
import { mcpRouter } from "../src/mcp/http.js";
import { registryRestRouter } from "../src/api/registry-rest.js";

/**
 * PRISM-19: proves the single-middleware auth model end to end, mirroring
 * exactly how index.ts wires it — one bearerAuth() instance applied across
 * both adapters, not a per-adapter reimplementation.
 */
describe("unified auth across MCP and REST (PRISM-19)", () => {
  const TOKEN = "s3cret-token";
  let root: string;
  let app: express.Express;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prism19-auth-"));
    const kb = new KnowledgeBase(root);
    app = express();
    app.use(express.json());
    // Same shape as index.ts: one middleware, one array of protected prefixes.
    app.use(["/mcp", "/api/v1"], bearerAuth(TOKEN));
    app.use("/mcp", mcpRouter(kb));
    app.use("/api/v1", registryRestRouter(kb));
    app.get("/api/v1/openapi.json", (_req, res) => res.json({ ok: true }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects an unauthenticated MCP request and an unauthenticated REST request identically (acceptance criterion 1)", async () => {
    const mcpRes = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const restRes = await request(app).get("/api/v1/concepts");

    expect(mcpRes.status).toBe(401);
    expect(restRes.status).toBe(401);
    // Identical body — both went through the exact same middleware instance.
    expect(mcpRes.body).toEqual(restRes.body);
    expect(mcpRes.headers["www-authenticate"]).toBe(restRes.headers["www-authenticate"]);
  });

  it("accepts an identical valid-token request on both adapters", async () => {
    const mcpRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const restRes = await request(app)
      .get("/api/v1/concepts")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(mcpRes.status).not.toBe(401);
    expect(restRes.status).toBe(200);
  });

  it("leaves no endpoint under the protected prefixes reachable without a token (acceptance criterion 3)", async () => {
    const attempts = [
      request(app).get("/api/v1/concepts"),
      request(app).get("/api/v1/concepts/search").query({ query: "x" }),
      request(app).get("/api/v1/openapi.json"),
      request(app).post("/api/v1/concepts").send({}),
      request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ];
    const results = await Promise.all(attempts);
    for (const res of results) {
      expect(res.status).toBe(401);
    }
  });

  it("the auth failure message names no bundle path or filesystem detail", async () => {
    const res = await request(app).get("/api/v1/concepts");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/\/(home|Users|var|tmp)\//);
  });
});
