/**
 * Generate the OpenAPI 3.1 spec for the versioned REST API and write it to
 * disk (openapi.json at the repo root by default). Intended to run in CI:
 * regenerating and diffing this file catches any registry change that
 * would otherwise silently drift the published spec (PRISM-17 acceptance
 * criterion 1 — "generated in CI").
 *
 *   pnpm --filter @prism/server exec tsx scripts/generate-openapi.mts [outPath]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/openapi/generate.js";

const outPath =
  process.argv[2] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../openapi.json");

const doc = buildOpenApiDocument();
await fs.writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
console.log(`Wrote OpenAPI 3.1 spec (${Object.keys(doc.paths as object).length} paths) to ${outPath}`);
