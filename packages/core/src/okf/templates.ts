/**
 * PRISM-57: concept templates — ready skeletons for the documents a
 * consultant writes constantly. Consistent structure makes retrieval precise
 * (the same "# Decision" / "# Gap" sections every time) and is what later
 * deliverable generation (fit-gap packs, traceability) will stand on.
 *
 * Built-ins live here. A bundle overrides or extends them with plain
 * markdown files in `/.templates/<name>.md` (frontmatter + body skeleton).
 * The dot-directory is deliberate: every bundle walker already skips
 * dot-directories (search, index.md generation, graph, lint, validate,
 * changes, the derived index), so templates are excluded everywhere by the
 * same rule that already hides `.prism/` — no per-consumer special case to
 * forget. Unlike `.prism/` (derived, gitignored), `.templates/` is real
 * content and is committed with the bundle.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bundle } from "./bundle.js";
import { parseDoc } from "./frontmatter.js";
import type { ConceptFrontmatter } from "./types.js";

export const TEMPLATES_DIR = ".templates";

export interface ConceptTemplate {
  /** Lookup key, e.g. "decision", "fit-gap". */
  name: string;
  /** The concept type the template produces. */
  type: string;
  description: string;
  /** Default frontmatter (always includes type). */
  frontmatter: ConceptFrontmatter;
  /** Markdown body skeleton — top-level "# Section" headings with guidance comments. */
  body: string;
  source: "builtin" | "bundle";
  /** Bundle path of the override file, when source is "bundle". */
  path?: string;
}

const section = (heading: string, hint: string) => `# ${heading}\n\n<!-- ${hint} -->\n`;

const BUILTINS: Omit<ConceptTemplate, "source">[] = [
  {
    name: "decision",
    type: "Decision",
    description: "A decision record: context, options, the call made and why. Starts open until signed off.",
    frontmatter: { type: "Decision", status: "open" },
    body: [
      section("Context", "What prompted this decision? Constraints, deadlines, who asked."),
      section("Options considered", "Each option with its trade-offs."),
      section("Decision", "The call made. Set status to decided once signed off, and record who signed off."),
      section("Rationale", "Why this option over the others."),
      section("Consequences", "What changes as a result: config, interfaces, process, risks."),
      section("Related", "Links to requirements, fit-gap items, meetings."),
    ].join("\n"),
  },
  {
    name: "meeting-note",
    type: "Meeting Note",
    description: "Workshop or meeting notes with attendees, decisions and actions.",
    frontmatter: { type: "Meeting Note" },
    body: [
      section("Attendees", "Who was there, and in what role."),
      section("Agenda", "What the session was for."),
      section("Notes", "Discussion points."),
      section("Decisions", "Anything agreed. Promote significant ones to their own Decision concepts."),
      section("Actions", "Owner, action and date. Promote each to a tracked item (status/owner/due) so it shows in open_items."),
      section("Related", "Links to decisions, requirements, prior sessions."),
    ].join("\n"),
  },
  {
    name: "fit-gap",
    type: "Fit-Gap Item",
    description: "One requirement assessed against standard capability, with the gap and its resolution.",
    frontmatter: { type: "Fit-Gap Item", status: "open" },
    body: [
      section("Requirement", "The business need, in the business's words."),
      section("Standard capability", "What the target solution does out of the box (the fit)."),
      section("Gap", "What is missing or different."),
      section("Proposed resolution", "Configuration, enhancement, process change, or accept the gap."),
      section("Effort and impact", "Rough size, risk, affected regions or sites."),
      section("Related", "Requirement, decision, interface and config concepts."),
    ].join("\n"),
  },
  {
    name: "requirement",
    type: "Requirement",
    description: "A traceable requirement with acceptance criteria and source.",
    frontmatter: { type: "Requirement", status: "open" },
    body: [
      section("Statement", "The requirement, in one or two testable sentences."),
      section("Rationale", "Why it matters to the business."),
      section("Acceptance criteria", "How we will know it is met."),
      section("Source", "Workshop, document or stakeholder it came from."),
      section("Traceability", "Fit-gap items, design decisions, test cases it maps to."),
      section("Related", "Links to connected concepts."),
    ].join("\n"),
  },
  {
    name: "interface",
    type: "Interface",
    description: "An integration between systems: direction, frequency, payload, error handling, ownership.",
    frontmatter: { type: "Interface" },
    body: [
      section("Purpose", "What business process this interface serves."),
      section("Source and target", "Systems, direction, middleware."),
      section("Frequency and trigger", "Batch schedule, event, or on demand."),
      section("Payload", "Key objects and fields."),
      section("Error handling", "What happens on failure, and who is alerted."),
      section("Owner and support", "Build owner, run owner."),
      section("Related", "Config items, decisions, fit-gap items."),
    ].join("\n"),
  },
  {
    name: "config-item",
    type: "Config Item",
    description: "A configuration setting: what it is, its value, why, and where it lives.",
    frontmatter: { type: "Config Item" },
    body: [
      section("Setting", "What is configured."),
      section("Value", "The value, per region, site or network if it differs."),
      section("Why", "The decision or requirement behind it."),
      section("Where configured", "System, transaction or path, planning book, table."),
      section("Dependencies", "Other settings or interfaces this affects."),
      section("Related", "Decision, requirement and interface concepts."),
    ].join("\n"),
  },
];

/** Normalize "Fit-Gap Item", "fit_gap", "FIT GAP" to a comparable key. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function bundleTemplates(bundle: Bundle): Promise<ConceptTemplate[]> {
  const dir = path.join(bundle.root, TEMPLATES_DIR);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return []; // no overrides — the common case
  }
  const out: ConceptTemplate[] = [];
  for (const file of names) {
    try {
      const { frontmatter, body } = parseDoc(await fs.readFile(path.join(dir, file), "utf-8"));
      const fm = frontmatter as ConceptFrontmatter;
      const name = key(file.replace(/\.md$/, ""));
      const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : name;
      const description =
        typeof fm.description === "string" && fm.description ? fm.description : `Bundle template for ${type}`;
      // `description` describes the template, not the concepts it produces.
      const { description: _omit, ...defaults } = fm;
      out.push({
        name,
        type,
        description,
        frontmatter: { ...defaults, type },
        body,
        source: "bundle",
        path: `/${TEMPLATES_DIR}/${file}`,
      });
    } catch {
      // Permissive: an unparseable override is skipped, the built-in stays.
    }
  }
  return out;
}

/** Every available template: built-ins, with bundle files overriding by name and adding new ones. */
export async function listTemplates(bundle: Bundle): Promise<ConceptTemplate[]> {
  const byName = new Map<string, ConceptTemplate>(BUILTINS.map((t) => [t.name, { ...t, source: "builtin" }]));
  for (const t of await bundleTemplates(bundle)) byName.set(t.name, t);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look a template up by name ("fit-gap") or by the type it produces
 * ("Fit-Gap Item"), case- and punctuation-insensitive. Throws with the list
 * of available names when nothing matches.
 */
export async function getTemplate(bundle: Bundle, nameOrType: string): Promise<ConceptTemplate> {
  const wanted = key(nameOrType);
  const all = await listTemplates(bundle);
  const hit = all.find((t) => t.name === wanted) ?? all.find((t) => key(t.type) === wanted);
  if (!hit) {
    throw new Error(`No template "${nameOrType}". Available: ${all.map((t) => t.name).join(", ")}`);
  }
  return hit;
}
