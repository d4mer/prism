import { describe, expect, it } from "vitest";
import type { TreeNode } from "@prism/core";
import { deriveConceptDescription } from "../../src/mcp/seed.js";

describe("seed", () => {
  describe("deriveConceptDescription", () => {
    const name = "foo";
    const title = "Foo";
    const description =
      "a main-belt asteroid that was discovered on September 2nd, 1983, by the Belgian astronomer Henri Debehogne";

    const cases: Record<string, { input: Pick<TreeNode, 'name'> & Partial<Pick<TreeNode, 'title' | 'description'>>; expected: string }> = {
      "name only": {
        input: { name },
        expected: `**${name}**`,
      },
      "name and title": {
        input: { name, title },
        expected: `**${title}**`,
      },
      "name and description": {
        input: { name, description },
        expected: `**${name}**, ${description}`,
      },
      "name and title and description": {
        input: { name, title, description },
        expected: `**${title}**, ${description}`,
      },
    };

    Object.entries(cases).forEach(([test_desc, test_case]) => {
      it(`provides a suitable description for concept tree nodes containing ${test_desc}`, () => {
        const { input, expected } = test_case;

        const actual = deriveConceptDescription(input as TreeNode);

        expect(actual).toEqual(expected);
      });
    });
  });
});

describe("session instructions steer agents to the direct tools", () => {
  it("names the direct tools as primary and the LLM-backed ones as fallback", async () => {
    const { seedInstructions } = await import("../../src/mcp/seed.js");
    const text = seedInstructions("(overview)");
    expect(text.indexOf("concept_search")).toBeGreaterThan(-1);
    expect(text.indexOf("concept_patch")).toBeLessThan(text.indexOf("memory_add"));
    expect(text).toMatch(/FALLBACK ONLY: memory_query, memory_add and memory_update/);
    expect(text).toMatch(/memory_job/);
    expect(text).toMatch(/periodically/);
  });
});
