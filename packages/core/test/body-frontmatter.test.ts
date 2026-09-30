import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

// Found by testing the live sigma instance: a body that begins with its own
// "---" block had that block stripped and its keys merged into the concept's
// frontmatter, bypassing validation (and appearing as real tracked items).

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-body-fm-test-"));
  kb = new KnowledgeBase(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const PASTED = "---\nstatus: open\nowner: Injected Person\nconfidence: 0.1\nsupersedes: /nope.md\n---\nPasted note with its own front matter.\n";

describe("body that looks like front matter", () => {
  it("is kept verbatim and never merged into the real frontmatter", async () => {
    await kb.writeConcept("/n/pasted.md", { type: "Note", title: "Pasted" }, PASTED, "Added pasted.");
    const c = await kb.readConcept("/n/pasted.md");
    expect(c.body).toBe(PASTED);
    expect(Object.keys(c.frontmatter).sort()).toEqual(["timestamp", "title", "type"]);
    expect((await kb.openItems({})).items).toHaveLength(0);
  });

  it("survives a frontmatter-only patch byte for byte", async () => {
    await kb.writeConcept("/n/pasted.md", { type: "Note", title: "Pasted" }, PASTED, "Added pasted.");
    await kb.patchConcept("/n/pasted.md", { frontmatter: { tags: ["x"] } }, "Tagged.");
    const c = await kb.readConcept("/n/pasted.md");
    expect(c.body).toBe(PASTED);
    expect(c.frontmatter.tags).toEqual(["x"]);
    expect(c.frontmatter.status).toBeUndefined();
  });

  it("does not let an invalid value sneak past validation inside the body", async () => {
    await kb.writeConcept("/n/sneaky.md", { type: "Note" }, "---\nstatus: bogus\ndue: not-a-date\n---\nbody\n", "Added.");
    const c = await kb.readConcept("/n/sneaky.md");
    expect(c.frontmatter.status).toBeUndefined();
    expect(c.frontmatter.due).toBeUndefined();
    expect(c.body.startsWith("---\nstatus: bogus")).toBe(true);
  });

  it("writes are stable: writing the same content twice gives the same file", async () => {
    await kb.writeConcept("/n/stable.md", { type: "Note", title: "S", asserted: "2026-01-01" }, PASTED, "Added.");
    const first = (await kb.readConcept("/n/stable.md")).raw;
    await kb.writeConcept("/n/stable.md", { type: "Note", title: "S", asserted: "2026-01-01" }, PASTED, "Rewrote.");
    const second = (await kb.readConcept("/n/stable.md")).raw;
    expect(second.replace(/timestamp: .*\n/, "")).toBe(first.replace(/timestamp: .*\n/, ""));
  });
});
