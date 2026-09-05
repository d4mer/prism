import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc, serializeDoc, hasNonEmptyType } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Concept, ConceptFrontmatter, TreeNode } from "./types.js";

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "OUTSIDE_BUNDLE"
      | "RESERVED_NAME"
      | "NOT_FOUND"
      | "INVALID_FRONTMATTER"
      | "NOT_MARKDOWN"
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Filesystem access to one OKF bundle, sandboxed to its root directory.
 * All public methods take/return bundle-relative paths ("/dir/concept.md").
 */
export class Bundle {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a bundle-relative path to an absolute one, rejecting escapes. */
  resolve(bundlePath: string): string {
    // Already an OS-absolute path inside the bundle (e.g. from a directory walk).
    if (
      path.isAbsolute(bundlePath) &&
      (bundlePath === this.root || bundlePath.startsWith(this.root + path.sep))
    ) {
      return path.resolve(bundlePath);
    }
    const cleaned = bundlePath.replace(/^\/+/, "");
    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new BundleError(`Path escapes bundle root: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    return abs;
  }

  /**
   * String-sandbox a path (traversal, absolute-path escapes — resolve()
   * above) AND reject a symlink placed inside the bundle that would resolve
   * outside it once followed. resolve() alone can't see this: a symlinked
   * directory component keeps its literal name in the string, so the
   * string-level check passes even though the OS would follow it out.
   * Walks up to the closest existing ancestor (the target itself may not
   * exist yet, e.g. a new concept) and realpath's that — any symlink in the
   * existing chain gets resolved and checked. PRISM-16: every entry point
   * that takes a caller-supplied bundle path calls this, not just resolve().
   */
  async resolveSafe(bundlePath: string): Promise<string> {
    const abs = this.resolve(bundlePath);
    let current = abs;
    for (;;) {
      try {
        await fs.lstat(current);
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break; // reached filesystem root without finding anything
        current = parent;
      }
    }
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch {
      real = current;
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new BundleError(`Path escapes bundle root via symlink: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    return abs;
  }

  /** Normalize any input to a canonical bundle-relative path starting with "/". */
  toBundlePath(inputPath: string): string {
    const abs = this.resolve(inputPath);
    const rel = path.relative(this.root, abs);
    return "/" + rel.split(path.sep).join("/");
  }

  private assertConceptPath(bundlePath: string): void {
    if (!bundlePath.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${bundlePath}`, "NOT_MARKDOWN");
    }
    const base = path.posix.basename(bundlePath);
    if (RESERVED_FILENAMES.has(base)) {
      throw new BundleError(
        `"${base}" is a reserved filename (index.md/log.md) and cannot be a concept`,
        "RESERVED_NAME"
      );
    }
  }

  async exists(bundlePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(bundlePath));
      return true;
    } catch {
      return false;
    }
  }

  async readConcept(bundlePath: string): Promise<Concept> {
    await this.resolveSafe(bundlePath);
    const canonical = this.toBundlePath(bundlePath);
    const abs = this.resolve(canonical);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
    const { frontmatter, body } = parseDoc(raw);
    return { path: canonical, frontmatter: frontmatter as ConceptFrontmatter, body, raw };
  }

  async readFileRaw(bundlePath: string): Promise<string> {
    await this.resolveSafe(bundlePath);
    const abs = this.resolve(bundlePath);
    try {
      return await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`File not found: ${bundlePath}`, "NOT_FOUND");
    }
  }

  async writeConcept(
    bundlePath: string,
    frontmatter: ConceptFrontmatter,
    body: string
  ): Promise<Concept> {
    await this.resolveSafe(bundlePath);
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    if (!hasNonEmptyType(frontmatter)) {
      throw new BundleError(
        `Frontmatter must include a non-empty "type" field (OKF spec §5)`,
        "INVALID_FRONTMATTER"
      );
    }
    const stamped: ConceptFrontmatter = {
      ...frontmatter,
      timestamp: new Date().toISOString(),
    };
    const abs = this.resolve(canonical);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeDoc(stamped, body), "utf-8");
    return { path: canonical, frontmatter: stamped, body, raw: serializeDoc(stamped, body) };
  }

  /**
   * Targeted update: merge frontmatter keys (null deletes a key) and/or
   * replace the content under one top-level "# Section" heading.
   */
  async patchConcept(
    bundlePath: string,
    changes: {
      frontmatter?: Record<string, unknown>;
      replaceSection?: { heading: string; content: string };
      replaceBody?: string;
    }
  ): Promise<Concept> {
    const existing = await this.readConcept(bundlePath);
    const fm: ConceptFrontmatter = { ...existing.frontmatter };
    if (changes.frontmatter) {
      for (const [k, v] of Object.entries(changes.frontmatter)) {
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
    }
    let body = changes.replaceBody ?? existing.body;
    if (changes.replaceSection) {
      body = replaceSection(body, changes.replaceSection.heading, changes.replaceSection.content);
    }
    return this.writeConcept(existing.path, fm, body);
  }

  async deleteConcept(bundlePath: string): Promise<void> {
    await this.resolveSafe(bundlePath);
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    const abs = this.resolve(canonical);
    try {
      await fs.unlink(abs);
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
  }

  /** All concept files (recursive), as bundle-relative paths. */
  async listConceptPaths(dir = "/"): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.resolve(dir), (abs, name) => {
      if (name.endsWith(".md") && !RESERVED_FILENAMES.has(name)) {
        out.push(this.toBundlePath(abs));
      }
    });
    return out.sort();
  }

  /** Immediate subdirectories of a directory. */
  async listSubdirectories(dir = "/"): Promise<string[]> {
    const abs = this.resolve(dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => this.toBundlePath(path.join(abs, e.name)))
      .sort();
  }

  async listTree(dir = "/"): Promise<TreeNode> {
    await this.resolveSafe(dir);
    const abs = this.resolve(dir);
    const name = abs === this.root ? "/" : path.basename(abs);
    const node: TreeNode = {
      name,
      path: this.toBundlePath(abs),
      kind: "directory",
      children: [],
    };
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        node.children!.push(await this.listTree(this.toBundlePath(childAbs)));
      } else if (entry.name.endsWith(".md")) {
        if (RESERVED_FILENAMES.has(entry.name)) {
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "reserved",
          });
        } else {
          let fmSummary: { type?: string; title?: string; description?: string } = {};
          try {
            const { frontmatter } = parseDoc(await fs.readFile(childAbs, "utf-8"));
            fmSummary = {
              type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
              title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
              description:
                typeof frontmatter.description === "string" ? frontmatter.description : undefined,
            };
          } catch {
            // Permissive: unparseable file still appears in the tree.
          }
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "concept",
            ...fmSummary,
          });
        }
      }
    }
    return node;
  }

  private async walk(
    absDir: string,
    visit: (absPath: string, name: string) => void
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(absDir, entry.name);
      if (entry.isDirectory()) await this.walk(child, visit);
      else visit(child, entry.name);
    }
  }
}

/** Replace the content under a top-level heading; append the section if absent. */
export function replaceSection(body: string, heading: string, content: string): string {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  const isHeading = (line: string) => /^#\s+/.test(line);
  const start = lines.findIndex(
    (line) => isHeading(line) && line.replace(/^#\s+/, "").trim() === normalized
  );
  if (start === -1) {
    const suffix = body.trim().length > 0 ? "\n\n" : "";
    return `${body.trimEnd()}${suffix}# ${normalized}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? "\n" + after : ""}`;
}
