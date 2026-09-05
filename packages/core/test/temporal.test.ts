import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-temporal-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-22 acceptance criteria, verbatim from the ticket:
// 1. The existing bundle validates unchanged.
// 2. A malformed date, unknown source value or dangling supersession
//    reference is rejected with a specific message.
// 3. A supersession cycle is detected and refused.

describe("PRISM-22: temporal & provenance frontmatter", () => {
  it("AC1: a bundle with no temporal fields validates unchanged", async () => {
    await kb.writeConcept(
      "/facts/a.md",
      { type: "Fact", title: "A" },
      "# A\n\nSome fact.",
      "Added fact A."
    );
    await kb.writeConcept(
      "/facts/b.md",
      { type: "Fact", title: "B" },
      "# B\n\nAnother fact.",
      "Added fact B."
    );
    const report = await kb.validate();
    expect(report.conformant).toBe(true);
    const temporalIssues = report.issues.filter((i) =>
      /asserted|source|confidence|supersedes|superseded_by/.test(i.message)
    );
    expect(temporalIssues).toEqual([]);
  });

  it("accepts well-formed temporal/provenance fields", async () => {
    const written = await kb.writeConcept(
      "/facts/c.md",
      { type: "Fact", title: "C", asserted: "2026-09-05", source: "human", confidence: 0.8 },
      "# C\n\nA well-provenanced fact.",
      "Added fact C."
    );
    expect(written.frontmatter.asserted).toBe("2026-09-05");
    expect(written.frontmatter.source).toBe("human");
    expect(written.frontmatter.confidence).toBe(0.8);
  });

  it("AC2: rejects a malformed 'asserted' date with a specific message", async () => {
    await expect(
      kb.writeConcept("/facts/d.md", { type: "Fact", asserted: "not-a-date" }, "body", "log")
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining('"asserted"'),
    });
  });

  it("AC2: rejects a calendar-invalid 'asserted' date (e.g. Feb 30)", async () => {
    await expect(
      kb.writeConcept("/facts/d2.md", { type: "Fact", asserted: "2026-02-30" }, "body", "log")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("AC2: rejects an unknown 'source' value with a specific message", async () => {
    await expect(
      kb.writeConcept("/facts/e.md", { type: "Fact", source: "rumor" }, "body", "log")
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining('"source"'),
    });
  });

  it("rejects an out-of-range 'confidence' value", async () => {
    await expect(
      kb.writeConcept("/facts/f.md", { type: "Fact", confidence: 1.5 }, "body", "log")
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining('"confidence"'),
    });
  });

  it("AC2: rejects a dangling 'supersedes' reference with a specific message", async () => {
    await expect(
      kb.writeConcept(
        "/facts/g.md",
        { type: "Fact", supersedes: "/facts/does-not-exist.md" },
        "body",
        "log"
      )
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining("supersedes"),
    });
  });

  it("rejects 'supersedes' referencing the concept's own path", async () => {
    await kb.writeConcept("/facts/h.md", { type: "Fact" }, "body", "Added h.");
    await expect(
      kb.patchConcept("/facts/h.md", { frontmatter: { supersedes: "/facts/h.md" } }, "log")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("AC3: detects and refuses a direct supersession cycle", async () => {
    await kb.writeConcept("/facts/old.md", { type: "Fact", title: "Old" }, "# Old", "Added old.");
    await kb.writeConcept(
      "/facts/new.md",
      { type: "Fact", title: "New", supersedes: "/facts/old.md" },
      "# New",
      "Added new, supersedes old."
    );
    // Closing the loop: old -> supersedes -> new would make new's chain
    // reach back to old, which already points at new.
    await expect(
      kb.patchConcept(
        "/facts/old.md",
        { frontmatter: { supersedes: "/facts/new.md" } },
        "Attempt to close a cycle."
      )
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining("cycle"),
    });
  });

  it("AC3: detects and refuses a longer supersession cycle", async () => {
    await kb.writeConcept("/facts/v1.md", { type: "Fact" }, "v1", "Added v1.");
    await kb.writeConcept(
      "/facts/v2.md",
      { type: "Fact", supersedes: "/facts/v1.md" },
      "v2",
      "Added v2."
    );
    await kb.writeConcept(
      "/facts/v3.md",
      { type: "Fact", supersedes: "/facts/v2.md" },
      "v3",
      "Added v3."
    );
    await expect(
      kb.patchConcept(
        "/facts/v1.md",
        { frontmatter: { supersedes: "/facts/v3.md" } },
        "Attempt to close a 3-node cycle."
      )
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
      message: expect.stringContaining("cycle"),
    });
  });

  it("validate() warns (but does not fail conformance) on hand-edited malformed temporal data", async () => {
    // Simulate data that predates validation, or was hand-edited outside
    // the one write path — validate() must catch it as a warning, since
    // Bundle.writeConcept can only enforce fields going through it.
    await fs.mkdir(path.join(root, "facts"), { recursive: true });
    await fs.writeFile(
      path.join(root, "facts", "manual.md"),
      "---\ntype: Fact\nasserted: not-a-date\nsource: rumor\nconfidence: 5\nsupersedes: /facts/nope.md\n---\n\nHand-edited.",
      "utf-8"
    );
    const report = await kb.validate();
    expect(report.conformant).toBe(true); // warnings never fail conformance
    const messages = report.issues.filter((i) => i.path === "/facts/manual.md").map((i) => i.message);
    expect(messages.some((m) => /asserted/.test(m))).toBe(true);
    expect(messages.some((m) => /source/.test(m))).toBe(true);
    expect(messages.some((m) => /confidence/.test(m))).toBe(true);
    expect(messages.some((m) => /supersedes/.test(m))).toBe(true);
  });
});
