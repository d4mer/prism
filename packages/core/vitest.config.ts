import { defineConfig } from "vitest/config";

// PRISM-42: coverage gate for the deterministic core (the okf layer and the
// tool registry). The LLM agent loop and provider adapters are excluded on
// purpose: they need a live model, and the invariants they must not break
// are enforced from the outside (test/invariants.test.ts). Measured at
// 95.7% lines when this gate was added; the thresholds leave headroom for
// refactors but fail on a real slide.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/okf/**", "src/registry/**"],
      exclude: ["src/okf/types.ts", "src/registry/types.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
