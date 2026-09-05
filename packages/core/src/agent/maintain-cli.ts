import { promises as fs } from "node:fs";
import { KnowledgeBase } from "../okf/index.js";
import { runDream, DREAM_PASSES, type DreamPass, type DreamReport } from "./dream.js";

/**
 * PRISM-26: `prism maintain <bundle-path>` — a stateless, idempotent CLI
 * entry point for the dream consolidation pass, drivable by cron or any
 * external scheduler with no running server. All the actual logic
 * (signal gating, pass selection, dry-run) lives in runDream(); this module
 * is argv parsing + process-boundary glue, kept separate from process.exit
 * so it stays unit-testable.
 */

export const USAGE =
  "Usage: prism maintain <bundle-path> [--dry-run] [--only=repair|consolidate[,...]]";

export interface MaintainCliOptions {
  bundlePath: string;
  dryRun: boolean;
  passes?: DreamPass[];
}

export type ParsedMaintainArgs = { options: MaintainCliOptions } | { error: string };

/** Pure argv parsing — no filesystem or process access, easy to unit test. */
export function parseMaintainArgs(argv: string[]): ParsedMaintainArgs {
  let bundlePath: string | undefined;
  let dryRun = false;
  let passes: DreamPass[] | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--only=")) {
      const raw = arg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (raw.length === 0) {
        return { error: `--only requires a value — valid passes: ${DREAM_PASSES.join(", ")}` };
      }
      const invalid = raw.filter((p) => !(DREAM_PASSES as string[]).includes(p));
      if (invalid.length > 0) {
        return { error: `Unknown pass "${invalid[0]}" — valid passes: ${DREAM_PASSES.join(", ")}` };
      }
      passes = raw as DreamPass[];
    } else if (arg.startsWith("--")) {
      return { error: `Unknown flag: ${arg}\n${USAGE}` };
    } else if (bundlePath === undefined) {
      bundlePath = arg;
    } else {
      return { error: `Unexpected extra argument: "${arg}"\n${USAGE}` };
    }
  }

  if (bundlePath === undefined) {
    return { error: USAGE };
  }
  return { options: { bundlePath, dryRun, passes } };
}

export interface MaintainCliResult {
  /**
   * Exit code convention (mirrors the well-known `diff` shape):
   *   0 = no-op (healthy bundle, or a dry-run that found nothing to do)
   *   1 = changes made (or, for a dry-run, changes WOULD be made)
   *   2 = failure (bad arguments, bad bundle path, or the agent run itself failed)
   */
  exitCode: number;
  /** JSON-formatted structured summary — see DreamReport, or { error } on failure. */
  output: string;
}

/** Exported for direct unit testing of the exit-code mapping without a live agent run. */
export function exitCodeFor(report: DreamReport): number {
  // A dry-run never sets ran=true (it never invokes the agent), so it is
  // checked first: whether it "would" act is signalCategories, not ran.
  if (report.dryRun) return report.signalCategories.length > 0 ? 1 : 0;
  if (!report.ran) return 0; // no-op: healthy
  return report.succeeded ? 1 : 2;
}

/**
 * Run the maintain command end-to-end. Never throws and never calls
 * process.exit — the thin bin/ wrapper does that, so this stays testable.
 */
export async function runMaintainCli(argv: string[]): Promise<MaintainCliResult> {
  const parsed = parseMaintainArgs(argv);
  if ("error" in parsed) {
    return { exitCode: 2, output: JSON.stringify({ error: parsed.error }, null, 2) };
  }
  const { bundlePath, dryRun, passes } = parsed.options;

  try {
    const stat = await fs.stat(bundlePath);
    if (!stat.isDirectory()) {
      return {
        exitCode: 2,
        output: JSON.stringify({ error: `Bundle path is not a directory: ${bundlePath}` }, null, 2),
      };
    }
  } catch {
    // A cron job pointed at a stale/misspelled path must fail loudly, not
    // silently report "healthy" — an empty/missing tree would otherwise
    // walk to zero concepts and look identical to a genuinely healthy one.
    return {
      exitCode: 2,
      output: JSON.stringify({ error: `Bundle path not found: ${bundlePath}` }, null, 2),
    };
  }

  try {
    const kb = new KnowledgeBase(bundlePath);
    const report = await runDream(kb, {}, undefined, { passes, dryRun });
    return { exitCode: exitCodeFor(report), output: JSON.stringify(report, null, 2) };
  } catch (err) {
    return {
      exitCode: 2,
      output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2),
    };
  }
}
