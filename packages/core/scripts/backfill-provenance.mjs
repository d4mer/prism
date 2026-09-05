#!/usr/bin/env node
// PRISM-25: backfill provenance for concepts written before PRISM-22's
// temporal schema landed, without ever fabricating history that was
// never recorded.
//
// For each concept in the target bundle that does not already carry
// `asserted` or `source`:
//
//   1. log.md is the bundle's own record of when a concept was added.
//      If it has a "Creation" entry linking to this concept's path, the
//      entry's `## YYYY-MM-DD` heading becomes `asserted` (the earliest
//      such date, if more than one somehow exists for the same path).
//   2. Otherwise, if the bundle is itself inside a git working tree and
//      the concept file has tracked history, the date of the earliest
//      commit that added the file becomes `asserted`.
//   3. If NEITHER source has evidence, `asserted` is left absent —
//      never guessed — and `source` is set to "document". That is the
//      closest fit in the existing, closed BELIEF_SOURCES enum
//      (session | agent | human | document — see okf/temporal.ts) for
//      "this predates provenance tracking; all we actually know is
//      that it came from an existing document, not a live session/
//      agent/human assertion made under the new schema." Extending the
//      enum with a dedicated value (e.g. "backfill") was considered and
//      rejected: PRISM-22 already shipped and validated against the
//      four-value enum, and widening it is a schema change well beyond
//      this ticket's scope.
//   4. `confidence` is never inferred; always left absent.
//
// A concept that already has `asserted` or `source` set (including by
// a prior run of this script) is left completely untouched — that is
// what makes re-running it a no-op (PRISM-25 AC3).
//
// Usage:
//   node backfill-provenance.mjs <bundle-dir>            # dry run: prints a diff, writes nothing
//   node backfill-provenance.mjs <bundle-dir> --apply    # writes the changes
//
// Run from anywhere; requires `gray-matter` and `simple-git` to be
// resolvable (both are @prism/core dependencies — invoke via
// `node packages/core/scripts/backfill-provenance.mjs ...` from the
// repo, or copy alongside a node_modules that has them).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import { simpleGit } from "simple-git";

const RESERVED = new Set(["index.md", "log.md"]);
const PRE_PROVENANCE_SOURCE = "document";

function usageAndExit() {
  console.error("Usage: node backfill-provenance.mjs <bundle-dir> [--apply]");
  process.exit(1);
}

async function walkConcepts(dir, root, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .git, .DS_Store, etc.
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkConcepts(abs, root, out);
    } else if (e.isFile() && e.name.endsWith(".md") && !RESERVED.has(e.name)) {
      const rel = "/" + path.relative(root, abs).split(path.sep).join("/");
      out.push({ abs, path: rel });
    }
  }
  return out;
}

function normalizeLinkPath(link) {
  let p = link.trim().replace(/^\.\//, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** Bundle-local evidence: earliest "Creation" date per concept path, from log.md. */
async function parseLogCreationDates(bundleRoot) {
  const logPath = path.join(bundleRoot, "log.md");
  let raw;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch {
    return new Map();
  }
  const dates = new Map();
  let currentDate = null;
  for (const line of raw.split("\n")) {
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }
    const bulletMatch = line.match(/^\*\s+\*\*(Creation)\*\*:\s*(.*)$/);
    if (bulletMatch && currentDate) {
      const linkMatch = bulletMatch[2].match(/\(([^)]+)\)/);
      if (!linkMatch) continue;
      const p = normalizeLinkPath(linkMatch[1]);
      const existing = dates.get(p);
      if (!existing || currentDate < existing) dates.set(p, currentDate);
    }
  }
  return dates;
}

/** Git-history evidence: earliest commit date that added this file, if any. */
async function earliestGitAddDate(bundleRoot, absFile, gitHandle) {
  if (!gitHandle) return null;
  try {
    const rel = path.relative(bundleRoot, absFile);
    const log = await gitHandle.log({ file: rel, "--follow": null, "--diff-filter": "A" });
    const all = log?.all ?? [];
    if (all.length === 0) return null;
    // git log is newest-first; the oldest "A"(dd) entry is the true creation.
    const oldest = all[all.length - 1];
    return oldest?.date ? oldest.date.slice(0, 10) : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) usageAndExit();
  const bundleRoot = path.resolve(positional[0]);

  let stat;
  try {
    stat = await fs.stat(bundleRoot);
  } catch {
    console.error(`Bundle directory does not exist: ${bundleRoot}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${bundleRoot}`);
    process.exit(1);
  }

  const concepts = await walkConcepts(bundleRoot, bundleRoot, []);
  const logDates = await parseLogCreationDates(bundleRoot);

  let git = null;
  try {
    const candidate = simpleGit(bundleRoot);
    if (await candidate.checkIsRepo()) git = candidate;
  } catch {
    git = null;
  }

  const changed = [];
  const skippedAlreadyProvenanced = [];
  const noEvidence = [];
  const dated = [];

  for (const concept of concepts) {
    const raw = await fs.readFile(concept.abs, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data ?? {};

    if (fm.asserted !== undefined || fm.source !== undefined) {
      skippedAlreadyProvenanced.push(concept.path);
      continue;
    }

    let assertedDate = logDates.get(concept.path) ?? null;
    let evidenceKind = assertedDate ? "log.md" : null;
    if (!assertedDate) {
      const gitDate = await earliestGitAddDate(bundleRoot, concept.abs, git);
      if (gitDate) {
        assertedDate = gitDate;
        evidenceKind = "git";
      }
    }

    const newFm = { ...fm };
    if (assertedDate) {
      newFm.asserted = assertedDate;
      dated.push({ path: concept.path, date: assertedDate, evidence: evidenceKind });
    } else {
      newFm.source = PRE_PROVENANCE_SOURCE;
      noEvidence.push(concept.path);
    }

    const body = parsed.content.replace(/^\n/, "");
    const newRaw = matter.stringify(body.endsWith("\n") ? body : body + "\n", newFm);
    changed.push({ path: concept.path, abs: concept.abs, before: raw, after: newRaw });
  }

  // --- report ---
  console.log(`Bundle: ${bundleRoot}`);
  console.log(`Concepts scanned: ${concepts.length}`);
  console.log(`Already had asserted/source (untouched): ${skippedAlreadyProvenanced.length}`);
  console.log(`Backfilled with a recoverable asserted date: ${dated.length}`);
  for (const d of dated) console.log(`  asserted=${d.date} (from ${d.evidence})  ${d.path}`);
  console.log(`Backfilled with source="${PRE_PROVENANCE_SOURCE}" (no recoverable date): ${noEvidence.length}`);
  for (const p of noEvidence) console.log(`  ${p}`);

  if (changed.length === 0) {
    console.log("\nNo changes needed — bundle is already fully provenanced or this script already ran (no-op).");
    return;
  }

  console.log(`\n${changed.length} file(s) would change:\n`);
  for (const c of changed) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prism25-diff-"));
    const beforePath = path.join(tmpDir, "before.md");
    const afterPath = path.join(tmpDir, "after.md");
    await fs.writeFile(beforePath, c.before, "utf-8");
    await fs.writeFile(afterPath, c.after, "utf-8");
    try {
      execFileSync("diff", ["-u", `--label=a${c.path}`, `--label=b${c.path}`, beforePath, afterPath], {
        stdio: "inherit",
      });
    } catch (err) {
      // `diff` exits 1 when files differ — that's expected, not an error.
      if (err.status !== 1) throw err;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  if (apply) {
    for (const c of changed) {
      await fs.writeFile(c.abs, c.after, "utf-8");
    }
    console.log(`\nApplied: wrote ${changed.length} file(s).`);
  } else {
    console.log(`\nDry run only — re-run with --apply to write these changes.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
