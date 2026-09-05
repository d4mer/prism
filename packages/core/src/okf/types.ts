/** Frontmatter of an OKF concept. `type` is the only required field (spec §5). */
export interface ConceptFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /**
   * Temporal & provenance fields (PRISM-22). All optional and additive — a
   * concept written before these existed stays fully valid. See okf/temporal.ts
   * for the validation rules enforced whenever any of these are set.
   */
  /** ISO 8601 date/time this belief was asserted. */
  asserted?: string;
  /** Where this belief came from: "session" | "agent" | "human" | "document". */
  source?: string;
  /** How firmly held, 0 (uncertain) to 1 (certain). */
  confidence?: number;
  /** Bundle-relative path of the concept this one replaces. */
  supersedes?: string;
  /** Bundle-relative path of the concept that replaced this one. */
  superseded_by?: string;
  /** Producer-defined keys are permitted and preserved. */
  [key: string]: unknown;
}

export interface Concept {
  /** Bundle-relative path, always starting with "/" (e.g. "/tables/customers.md"). */
  path: string;
  frontmatter: ConceptFrontmatter;
  body: string;
  raw: string;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  /** Present on concepts. */
  type?: string;
  title?: string;
  description?: string;
  /** PRISM-24: true when this concept has a superseded_by field (a historical belief). */
  superseded?: boolean;
  children?: TreeNode[];
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  /** Snippet of body text around the first match, if the match was in the body. */
  snippet?: string;
  /** PRISM-24: true when this is a superseded (historical) concept — only present when includeHistory was requested. */
  superseded?: boolean;
  score: number;
}

export type LogAction = "Creation" | "Update" | "Deletion" | "Supersession";

export interface LogEntry {
  date: string; // YYYY-MM-DD
  action: LogAction;
  summary: string;
}

export interface ConformanceIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: ConformanceIssue[];
}

export const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
