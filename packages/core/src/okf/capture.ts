/**
 * PRISM-52: quick capture. Pure helpers that turn "just the text" into a
 * concept path + frontmatter, so a busy consultant (or their agent) can file
 * a note mid-meeting without deciding path, type or links up front. The
 * actual write — including collision-free path allocation — happens inside
 * KnowledgeBase.capture(), under the mutation queue, so two simultaneous
 * captures of the same title can never race each other into one file.
 */
import type { ConceptFrontmatter } from "./types.js";

export const DEFAULT_CAPTURE_FOLDER = "/inbox";
export const DEFAULT_CAPTURE_TYPE = "note";
export const INBOX_TAG = "inbox";
const MAX_TITLE_LENGTH = 80;
const MAX_SLUG_LENGTH = 60;

export interface CaptureOptions {
  text: string;
  title?: string;
  type?: string;
  tags?: string[];
  /** PRISM-22 provenance; defaults to "human" — capture is someone's own note. */
  source?: string;
  /** Bundle-relative directory; defaults to /inbox. */
  folder?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

export interface CapturePlan {
  folder: string;
  /** Path stem without collision suffix or ".md", e.g. "/inbox/2026-09-23-cutover-risks". */
  stem: string;
  frontmatter: ConceptFrontmatter;
  body: string;
}

/**
 * First meaningful line of the text, stripped of leading markdown markers
 * (headings, bullets, quote marks), capped at a word boundary.
 */
export function deriveTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine || "Untitled note";
  const cut = firstLine.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Filesystem- and URL-safe slug: ascii lowercase, digits and single hyphens. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics after decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "note";
}

/** Normalize a caller-supplied folder to "/a/b" form (no trailing slash). */
export function normalizeFolder(folder: string | undefined): string {
  const raw = (folder ?? DEFAULT_CAPTURE_FOLDER).trim();
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length > 0 && parts[parts.length - 1].toLowerCase().endsWith(".md")) {
    throw new Error(`folder must be a directory, not a concept path: ${folder}`);
  }
  return "/" + parts.join("/");
}

export function planCapture(options: CaptureOptions): CapturePlan {
  const text = options.text.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) throw new Error("text must not be empty");
  const now = options.now ?? new Date();
  const folder = normalizeFolder(options.folder);
  const title = options.title?.trim() || deriveTitle(text);
  const date = now.toISOString().slice(0, 10);
  const stem = `${folder === "/" ? "" : folder}/${date}-${slugify(title)}`;

  const tags = [...(options.tags ?? [])].map((t) => t.trim()).filter((t) => t.length > 0);
  if (folder === DEFAULT_CAPTURE_FOLDER && !tags.some((t) => t.toLowerCase() === INBOX_TAG)) {
    tags.push(INBOX_TAG);
  }

  const frontmatter: ConceptFrontmatter = {
    type: options.type?.trim() || DEFAULT_CAPTURE_TYPE,
    title,
    asserted: now.toISOString(),
    source: options.source ?? "human",
  };
  if (tags.length > 0) frontmatter.tags = [...new Set(tags)];

  return { folder, stem, frontmatter, body: text + "\n" };
}

/** Candidate paths for a stem: stem.md, stem-2.md, stem-3.md, … */
export function* captureCandidates(stem: string): Generator<string> {
  yield `${stem}.md`;
  for (let n = 2; ; n++) yield `${stem}-${n}.md`;
}
