import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { CORE_TOOLS, KnowledgeBase } from "@prism/core";
import { buildOpenApiDocument } from "../src/openapi/generate.js";
import { ROUTES } from "../src/openapi/routes.js";
import { registryRestRouter } from "../src/api/registry-rest.js";

describe("OpenAPI spec (PRISM-17)", () => {
  it("validates against the OpenAPI schema (acceptance criterion 1)", async () => {
    const doc = buildOpenApiDocument();
    // Throws on any structural violation — this is the same validator a CI
    // job would run against the file scripts/generate-openapi.mts writes.
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeTruthy();
  });

  it("every CORE_TOOLS entry has a route and appears in the generated spec (acceptance criterion 2)", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId?: string }>> };
    const operationIds = new Set(
      Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId).filter(Boolean))
    );
    for (const def of CORE_TOOLS) {
      expect(ROUTES.some((r) => r.tool === def.name)).toBe(true);
      expect(operationIds.has(def.name)).toBe(true);
    }
    // And nothing in ROUTES points at a tool CORE_TOOLS doesn't have —
    // routes.ts and CORE_TOOLS can't silently drift apart in either direction.
    for (const route of ROUTES) {
      expect(CORE_TOOLS.some((t) => t.name === route.tool)).toBe(true);
    }
  });

  it("documents auth, error shapes and every write operation's input schema", () => {
    const doc = buildOpenApiDocument() as {
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { requestBody?: unknown; tags?: string[] }>>;
    };
    expect(doc.components.securitySchemes.bearerAuth).toBeTruthy();
    expect(doc.components.schemas.ValidationError).toBeTruthy();
    expect(doc.components.schemas.Error).toBeTruthy();

    const writeRoutes = ROUTES.filter((r) => r.style === "body");
    for (const route of writeRoutes) {
      const op = doc.paths[route.path]?.[route.method];
      expect(op?.requestBody, `${route.method.toUpperCase()} ${route.path} should document a request body`).toBeTruthy();
    }
  });
});

describe("REST registry adapter: full create-read-patch-link-delete cycle (acceptance criterion 3)", () => {
  let root: string;
  let app: express.Express;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prism17-rest-"));
    const kb = new KnowledgeBase(root);
    app = express();
    app.use(express.json());
    app.use("/api/v1", registryRestRouter(kb));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("drives the entire lifecycle of two concepts and a link through HTTP alone", async () => {
    // create
    await request(app)
      .post("/api/v1/concepts")
      .send({
        path: "/tables/customers.md",
        frontmatter: { type: "Table", title: "Customers" },
        body: "Customer records.",
        log_summary: "Added customers table.",
      })
      .expect(201, { written: "/tables/customers.md" });

    await request(app)
      .post("/api/v1/concepts")
      .send({
        path: "/apis/billing.md",
        frontmatter: { type: "API", title: "Billing API" },
        body: "Charges customers.",
        log_summary: "Added billing API.",
      })
      .expect(201, { written: "/apis/billing.md" });

    // read
    const read = await request(app).get("/api/v1/concepts/one").query({ path: "/tables/customers.md" }).expect(200);
    expect(read.body.frontmatter.type).toBe("Table");
    expect(read.body.body.trim()).toBe("Customer records.");

    // search
    const search = await request(app).get("/api/v1/concepts/search").query({ query: "customers" }).expect(200);
    const paths = (search.body as Array<{ path: string }>).map((h) => h.path);
    expect(paths).toContain("/tables/customers.md");

    // list
    const list = await request(app).get("/api/v1/concepts").expect(200);
    expect(list.text).toContain("customers.md");

    // patch
    await request(app)
      .patch("/api/v1/concepts")
      .send({
        path: "/tables/customers.md",
        frontmatter: { description: "Core customer table" },
        log_summary: "Added description.",
      })
      .expect(200, { patched: "/tables/customers.md" });

    const reread = await request(app).get("/api/v1/concepts/one").query({ path: "/tables/customers.md" }).expect(200);
    expect(reread.body.frontmatter.description).toBe("Core customer table");

    // link
    const link = await request(app)
      .post("/api/v1/links")
      .send({
        source: "/apis/billing.md",
        target: "/tables/customers.md",
        log_summary: "Linked billing to customers.",
      })
      .expect(201);
    expect(link.body).toMatchObject({ source: "/apis/billing.md", target: "/tables/customers.md", added: true });

    // lint — the link should mean neither concept is an orphan
    const lint = await request(app).get("/api/v1/graph/lint").expect(200);
    expect(lint.body.orphans.map((o: { path: string }) => o.path)).not.toContain("/tables/customers.md");

    // delete
    await request(app)
      .delete("/api/v1/concepts")
      .send({ path: "/apis/billing.md", log_summary: "Removed." })
      .expect(200, { deleted: "/apis/billing.md" });

    await request(app).get("/api/v1/concepts/one").query({ path: "/apis/billing.md" }).expect(404);
  });

  it("rejects invalid input with a 400 naming the offending field, not a stack trace", async () => {
    const res = await request(app)
      .post("/api/v1/concepts")
      .send({ path: "/a.md", frontmatter: {}, body: "x", log_summary: "x" })
      .expect(400);
    expect(res.body.error).toBe("Invalid input");
    expect(res.body.issues.some((i: { path: string }) => i.path === "frontmatter.type")).toBe(true);
  });

  it("rejects a path-traversal attempt with a clean 400, not a 500", async () => {
    const res = await request(app)
      .post("/api/v1/concepts")
      .send({
        path: "/../../outside.md",
        frontmatter: { type: "Malicious" },
        body: "x",
        log_summary: "attempt",
      })
      .expect(400);
    expect(res.body.error).toMatch(/escapes bundle root/i);
  });

  it("reading a concept that doesn't exist is a clean 404, not a 500", async () => {
    const res = await request(app).get("/api/v1/concepts/one").query({ path: "/nope.md" }).expect(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
