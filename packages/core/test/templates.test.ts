import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { conceptTemplateTool, conceptCaptureTool } from "../src/registry/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-templates-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// PRISM-57 acceptance criteria:
// 1. Each built-in template produces a concept that passes validation when written.
// 2. A bundle-local template overrides the built-in one of the same type.
// 3. Template files never appear in search, graph or lint output.

const BUILTIN_NAMES = ["config-item", "decision", "fit-gap", "interface", "meeting-note", "requirement"];

async function writeOverride(file: string, content: string) {
  await fs.mkdir(path.join(root, ".templates"), { recursive: true });
  await fs.writeFile(path.join(root, ".templates", file), content, "utf-8");
}

describe("built-in templates", () => {
  it("lists the six consultant templates", async () => {
    const all = await kb.listTemplates();
    expect(all.map((t) => t.name)).toEqual(BUILTIN_NAMES);
    expect(all.every((t) => t.source === "builtin")).toBe(true);
  });

  it("AC1: every built-in, written as-is, is a valid concept with zero validation errors or warnings of its own", async () => {
    for (const t of await kb.listTemplates()) {
      const p = `/t/${t.name}.md`;
      await kb.writeConcept(p, { ...t.frontmatter, title: `Sample ${t.name}`, description: "x" }, t.body, `add ${t.name}`);
    }
    const report = await kb.validate();
    expect(report.conformant).toBe(true);
    expect(report.issues.filter((i) => i.path.startsWith("/t/"))).toEqual([]);
  });

  it("looks up by name or by produced type, case/punctuation-insensitively", async () => {
    expect((await kb.getTemplate("fit-gap")).type).toBe("Fit-Gap Item");
    expect((await kb.getTemplate("Fit-Gap Item")).name).toBe("fit-gap");
    expect((await kb.getTemplate("MEETING_NOTE")).name).toBe("meeting-note");
    await expect(kb.getTemplate("sow")).rejects.toThrow(/Available: config-item, decision/);
  });

  it("decision, fit-gap and requirement start as open items", async () => {
    for (const n of ["decision", "fit-gap", "requirement"]) {
      expect((await kb.getTemplate(n)).frontmatter.status).toBe("open");
    }
  });
});

describe("bundle-local templates", () => {
  it("AC2: a /.templates file overrides the built-in of the same name, and can add new ones", async () => {
    await writeOverride(
      "decision.md",
      "---\ntype: Decision\ndescription: GSK decision format\nstatus: open\ntags: [design-authority]\n---\n# Context\n\n# Decision\n\n# Sign-off\n"
    );
    await writeOverride("risk.md", "---\ntype: Risk\nstatus: open\n---\n# Risk\n\n# Mitigation\n");
    const all = await kb.listTemplates();
    expect(all.map((t) => t.name)).toEqual([...BUILTIN_NAMES, "risk"].sort());
    const decision = await kb.getTemplate("decision");
    expect(decision).toMatchObject({ source: "bundle", path: "/.templates/decision.md", description: "GSK decision format" });
    expect(decision.frontmatter).toEqual({ type: "Decision", status: "open", tags: ["design-authority"] });
    expect(decision.body).toContain("# Sign-off");
    expect((await kb.getTemplate("Risk")).name).toBe("risk");
  });

  it("an unparseable override is skipped and the built-in survives", async () => {
    await writeOverride("decision.md", "---\ntype: [unclosed\n---\nbody");
    expect((await kb.getTemplate("decision")).source).toBe("builtin");
  });

  it("AC3: template files never appear in search, graph, lint, validate, changes or index.md", async () => {
    await writeOverride("decision.md", "---\ntype: Decision\n---\n# Context\n\nUNIQUETEMPLATEMARKER [x](/nowhere.md)\n");
    await kb.writeConcept("/real.md", { type: "Note", title: "Real" }, "A real note.", "add");
    await kb.rebuildSearchIndex();
    expect(await kb.search("UNIQUETEMPLATEMARKER")).toEqual([]);
    expect((await kb.search("")).map((h) => h.path)).toEqual(["/real.md"]);
    const graph = await kb.graph();
    expect(graph.nodes.map((n) => n.path)).toEqual(["/real.md"]);
    const lint = await kb.lint();
    expect(JSON.stringify(lint)).not.toContain(".templates");
    const report = await kb.validate();
    expect(report.issues.some((i) => i.path.includes(".templates"))).toBe(false);
    expect((await kb.changesSince("1h")).changes.map((c) => c.path)).toEqual(["/real.md"]);
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).not.toContain("templates");
  });
});

describe("concept_template tool and capture integration", () => {
  it("lists with sections when no name is given, returns the full template for a name", async () => {
    const list = await conceptTemplateTool.handler(kb, conceptTemplateTool.inputSchema.parse({}));
    expect("templates" in list && list.templates.find((t) => t.name === "fit-gap")?.sections).toEqual([
      "Requirement",
      "Standard capability",
      "Gap",
      "Proposed resolution",
      "Effort and impact",
      "Related",
    ]);
    const one = await conceptTemplateTool.handler(kb, { name: "interface" });
    expect("body" in one && one.body).toContain("# Error handling");
  });

  it("capture with a template applies its defaults and skeleton below the text", async () => {
    const out = await conceptCaptureTool.handler(
      kb,
      conceptCaptureTool.inputSchema.parse({ text: "Go with fixed min/max banding for CMO", template: "decision", folder: "/emea" })
    );
    const c = await kb.readConcept(out.captured);
    expect(c.frontmatter).toMatchObject({ type: "Decision", status: "open", title: "Go with fixed min/max banding for CMO" });
    expect(c.body.startsWith("Go with fixed min/max banding for CMO")).toBe(true);
    expect(c.body).toContain("# Options considered");
    // ...which makes it an open item straight away.
    expect((await kb.openItems()).items.map((i) => i.path)).toEqual([out.captured]);
  });

  it("an explicit type still wins over the template's type; an unknown template is a clear error", async () => {
    const c = await kb.capture({ text: "x", template: "decision", type: "Architecture Decision" });
    expect(c.frontmatter.type).toBe("Architecture Decision");
    await expect(kb.capture({ text: "x", template: "nope" })).rejects.toThrow(/No template "nope"/);
  });
});
