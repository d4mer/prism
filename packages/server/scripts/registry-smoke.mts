/**
 * Manual smoke test for the PRISM-12/13 tool registry (packages/core/src/registry).
 * Exercises every CORE_TOOLS operation directly against a throwaway copy of a
 * bundle — no MCP, no server, no LLM. Fast way to confirm the registry
 * behaves correctly after a change.
 *   SMOKE_BUNDLE=<abs path to copy from> tsx scripts/registry-smoke.mts
 *   (defaults to the repo's sample-bundle if SMOKE_BUNDLE is unset)
 */
import { CORE_TOOLS, getTool, KnowledgeBase } from "@prism/core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src =
  process.env.SMOKE_BUNDLE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../sample-bundle");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "prism-registry-smoke-"));
await fs.cp(src, root, { recursive: true });
const kb = new KnowledgeBase(root);

console.log(`Registry: ${CORE_TOOLS.length} tools`);
for (const t of CORE_TOOLS) console.log(`  - ${t.name} (mutates=${t.mutates})`);

console.log("\nconcept_list('/'):");
console.log(await getTool("concept_list")!.handler(kb, {}));

console.log("\nconcept_write -> concept_read -> concept_patch -> link_add -> lint -> concept_delete round trip:");
await getTool("concept_write")!.handler(kb, {
  path: "/tables/smoke-test.md",
  frontmatter: { type: "Test" },
  body: "# Smoke Test\n\nCreated by registry-smoke.mts.\n",
  log_summary: "smoke test: create",
});
const read = await getTool("concept_read")!.handler(kb, { path: "/tables/smoke-test.md" });
console.log("  read:", read);
await getTool("concept_patch")!.handler(kb, {
  path: "/tables/smoke-test.md",
  replace_body: "# Smoke Test\n\nCreated by registry-smoke.mts.\n\nPatched.\n",
  log_summary: "smoke test: patch",
});

// Link the new concept to whatever else exists in the bundle, if anything does.
const searchAny = await getTool("concept_search")!.handler(kb, { query: "" });
const linkTarget = Array.isArray(searchAny)
  ? searchAny.find((h) => h.path !== "/tables/smoke-test.md")?.path
  : undefined;
if (linkTarget) {
  console.log(`  link_add(smoke-test.md -> ${linkTarget}):`);
  console.log(
    "   ",
    await getTool("link_add")!.handler(kb, {
      source: "/tables/smoke-test.md",
      target: linkTarget,
      log_summary: "smoke test: link",
    })
  );
} else {
  console.log("  (no other concept in this bundle to demo link_add against)");
}

const lintBefore = await getTool("graph_lint")!.handler(kb, {});
console.log("  lint before cleanup:", lintBefore);
await getTool("concept_delete")!.handler(kb, { path: "/tables/smoke-test.md", log_summary: "smoke test: cleanup" });
const lintAfter = await getTool("graph_lint")!.handler(kb, {});
console.log("  lint after cleanup:", lintAfter);

console.log(`\nOK — temp bundle left at ${root} for inspection`);
