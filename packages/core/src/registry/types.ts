import type { ZodType } from "zod";
import type { KnowledgeBase } from "../okf/index.js";
import type { TraceRecorder } from "../agent/trace.js";

/**
 * Per-call context an adapter may supply. Both fields are optional and
 * Tier-0-safe to omit entirely — a handler that never receives a trace
 * recorder or a filesChanged set still behaves correctly, it just doesn't
 * report back to those bookkeeping mechanisms.
 */
export interface ToolContext {
  /** Present when called from inside the internal agent's own tool loop. */
  trace?: TraceRecorder;
  /** Present when the caller wants to know which concept paths were written. */
  filesChanged?: Set<string>;
}

/**
 * One operation over the deterministic OKF core, described once and
 * rendered by every adapter (internal agent tool loop, MCP, REST, CLI).
 * A definition never imports a protocol type and never invokes an LLM
 * provider — that is what "protocol-neutral" and "deterministic core"
 * mean here, enforced by convention and by the registry's own tests.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable name, stable across every adapter. Never renamed once shipped. */
  readonly name: string;
  /** Short human label (e.g. for a UI command palette). */
  readonly title: string;
  /** Full description — reused verbatim for MCP tool descriptions and OpenAPI summaries. */
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  /** True if this operation writes to the bundle. */
  readonly mutates: boolean;
  /**
   * True if this operation requires an LLM to do useful work (Tier 2).
   * Every entry in this registry is false — deliberation-requiring
   * operations (memory_add, memory_update, unhealthy memory_maintain)
   * are not registry entries; they are Tier-2 wrappers built on top of it.
   */
  readonly requiresDeliberation: false;
  handler(kb: KnowledgeBase, input: TInput, ctx?: ToolContext): Promise<TOutput>;
}
