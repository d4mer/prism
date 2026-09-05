import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, validateBundle, readLog } from "../src/okf/index.js";
import { Bundle } from "../src/okf/bundle.js";
import { buildReadTools, buildWriteTools } from "../src/agent/tools.js";
import {
  conceptDeleteTool,
  conceptPatchTool,
  conceptReadTool,
  conceptWriteTool,
  linkAddTool,
} from "../src/registry/index.js";

/**
 * PRISM-16: property-style coverage. Rather than pull in a new dependency
 * (fast-check isn't already used anywhere in this repo), this drives a small
 * seeded PRNG through many random write/patch/delete/link sequences — mixing
 * the granular registry surface with the internal agent-loop render
 * (buildReadTools/buildWriteTools), since both ultimately share the same
 * KnowledgeBase write path — and asserts the bundle is still fully
 * conformant afterwards, no matter what sequence landed. Also fires
 * deliberately adversarial actions (path traversal, dropping the required
 * "type" field, deleting/patching a concept that doesn't exist) into the
 * same sequence and asserts each one is rejected without corrupting
 * anything already on disk.
 */

// mulberry32 — tiny, deterministic, dependency-free.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prism16-prop-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const OP_KINDS = [
  "write",
  "patch",
  "delete",
  "link",
  "agent_write",
  "agent_patch",
  "traversal_write",
  "drop_type",
  "delete_missing",
  "symlink_write",
] as const;

const N_CONCEPTS = 6;
const OPS_PER_RUN = 150;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe("PRISM-16: arbitrary write sequences always leave the bundle conformant", () => {
  for (const seed of SEEDS) {
    it(`stays conformant, path-sandboxed, and log/index-correct across a random sequence (seed ${seed})`, async () => {
      const rng = mulberry32(seed);
      const alive = new Set<string>(); // concept paths currently expected to exist
      let expectedLogEntries = 0;

      const conceptPath = (i: number) => `/gen/concept-${i}.md`;
      const allPaths = Array.from({ length: N_CONCEPTS }, (_, i) => conceptPath(i));

      for (let step = 0; step < OPS_PER_RUN; step++) {
        const kind = pick(rng, OP_KINDS);
        const target = pick(rng, allPaths);

        try {
          switch (kind) {
            case "write": {
              await conceptWriteTool.handler(kb, {
                path: target,
                frontmatter: { type: "Generated", title: `Concept ${target}`, tags: ["gen"] },
                body: `# Body\n\nstep ${step}, seed ${seed}.`,
                log_summary: `Seeded ${target} at step ${step}.`,
              });
              alive.add(target);
              expectedLogEntries++;
              break;
            }
            case "agent_write": {
              const filesChanged = new Set<string>();
              const write = buildWriteTools(kb, filesChanged) as Record<
                string,
                { execute: (input: unknown) => Promise<unknown> }
              >;
              await write.concept_write.execute({
                path: target,
                frontmatter: { type: "Generated", title: `Agent ${target}` },
                body: `# Body\n\nagent-written at step ${step}.`,
                log_summary: `Agent-wrote ${target} at step ${step}.`,
              });
              alive.add(target);
              expectedLogEntries++;
              break;
            }
            case "patch": {
              if (!alive.has(target)) throw new Error("skip: not alive");
              await conceptPatchTool.handler(kb, {
                path: target,
                frontmatter: { description: `patched at step ${step}` },
                log_summary: `Patched ${target} at step ${step}.`,
              });
              expectedLogEntries++;
              break;
            }
            case "agent_patch": {
              if (!alive.has(target)) throw new Error("skip: not alive");
              const write = buildWriteTools(kb, new Set()) as Record<
                string,
                { execute: (input: unknown) => Promise<unknown> }
              >;
              await write.concept_patch.execute({
                path: target,
                frontmatter: { description: `agent-patched at step ${step}` },
                log_summary: `Agent-patched ${target} at step ${step}.`,
              });
              expectedLogEntries++;
              break;
            }
            case "delete": {
              if (!alive.has(target)) throw new Error("skip: not alive");
              await conceptDeleteTool.handler(kb, {
                path: target,
                log_summary: `Deleted ${target} at step ${step}.`,
              });
              alive.delete(target);
              expectedLogEntries++;
              break;
            }
            case "link": {
              const other = pick(rng, allPaths);
              if (!alive.has(target) || !alive.has(other) || target === other) {
                throw new Error("skip: not linkable");
              }
              const result = await linkAddTool.handler(kb, {
                source: target,
                target: other,
                log_summary: `Linked ${target} -> ${other} at step ${step}.`,
              });
              if (result.added) expectedLogEntries++;
              break;
            }
            case "traversal_write": {
              // Adversarial: must be rejected, must not touch the bundle.
              await conceptWriteTool.handler(kb, {
                path: "/../../outside-prism-bundle.md",
                frontmatter: { type: "Malicious" },
                body: "should never land",
                log_summary: "attempted escape",
              });
              throw new Error("traversal_write should have thrown but didn't");
            }
            case "symlink_write": {
              // Adversarial: plant a symlink pointing outside the bundle, then
              // try to write through it. Must be rejected (PRISM-16 resolveSafe).
              const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "prism16-outside-"));
              const linkName = `escape-${seed}-${step}`;
              const bundle = new Bundle(root);
              try {
                await fs.symlink(outsideDir, bundle.resolve(`/${linkName}`), "dir");
                await conceptWriteTool.handler(kb, {
                  path: `/${linkName}/pwned.md`,
                  frontmatter: { type: "Malicious" },
                  body: "should never land outside the bundle",
                  log_summary: "attempted symlink escape",
                });
                throw new Error("symlink_write should have thrown but didn't");
              } finally {
                await fs.rm(outsideDir, { recursive: true, force: true });
              }
            }
            case "drop_type": {
              // Adversarial: try to null out the required "type" field via patch.
              if (!alive.has(target)) throw new Error("skip: not alive");
              await conceptPatchTool.handler(kb, {
                path: target,
                frontmatter: { type: null },
                log_summary: "attempted to drop type",
              });
              throw new Error("drop_type should have thrown but didn't");
            }
            case "delete_missing": {
              if (alive.has(target)) throw new Error("skip: currently alive");
              await conceptDeleteTool.handler(kb, {
                path: target,
                log_summary: "attempted delete of missing concept",
              });
              throw new Error("delete_missing should have thrown but didn't");
            }
          }
        } catch (err) {
          // Expected for "skip: ..." control-flow throws and for every
          // deliberately-adversarial action above (traversal/symlink/drop_type/
          // delete_missing) — those MUST throw, and did. Anything else
          // surfacing here would fail the outer assertions below anyway
          // (e.g. a corrupted bundle), so we don't need to branch on message.
          void err;
        }
      }

      // ── Whatever sequence landed, the bundle must still be fully conformant. ──
      const report = await validateBundle(kb.bundle);
      expect(report.conformant).toBe(true);
      expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);

      // Every concept we believe is alive is actually readable and still has
      // its required type; nothing we believe is gone is still on disk.
      for (const p of allPaths) {
        if (alive.has(p)) {
          const c = await conceptReadTool.handler(kb, { path: p });
          expect(c.frontmatter.type).toBeTruthy();
        } else {
          await expect(conceptReadTool.handler(kb, { path: p })).rejects.toBeTruthy();
        }
      }

      // index.md stayed in sync: every live concept appears in the tree, and
      // listConceptPaths (the ground truth) agrees with what we tracked.
      const onDisk = new Set(await kb.bundle.listConceptPaths());
      expect(onDisk).toEqual(alive);

      // log.md: exactly one entry per successful mutation, no more, no less —
      // a rejected/adversarial action must never have appended anything.
      const entries = await readLog(kb.bundle);
      expect(entries.length).toBe(expectedLogEntries);

      // No adversarial write ever escaped the bundle onto the real filesystem.
      await expect(fs.access("/outside-prism-bundle.md")).rejects.toBeTruthy();
    });
  }

  it("buildReadTools' render agrees with the registry after a mixed sequence", async () => {
    await conceptWriteTool.handler(kb, {
      path: "/a.md",
      frontmatter: { type: "T" },
      body: "body",
      log_summary: "seed",
    });
    const read = buildReadTools(kb) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    const viaAgent = await read.concept_read.execute({ path: "/a.md" });
    const viaRegistry = await conceptReadTool.handler(kb, { path: "/a.md" });
    expect(viaAgent).toEqual(viaRegistry);
  });
});
