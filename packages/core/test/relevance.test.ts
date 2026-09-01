import { describe, expect, it } from "vitest";
import { buildFrontmatter } from "../src/parser.js";
import {
  extractReferencedPaths,
  inferModulesFromPaths,
  memoryHasExcludedTag,
  memoryMatchesAnchorPaths,
  pathsOverlap,
  adaptiveSemanticFloor,
  ADAPTIVE_FLOOR_MIN_SAMPLES,
} from "../src/relevance.js";
import { DEFAULT_BRIEFING_EXCLUDE_TAGS } from "../src/config.js";
import type { Memory } from "../src/types.js";

function memoryWithPaths(paths: string[]): Memory {
  return {
    frontmatter: buildFrontmatter({ type: "convention", slug: "x", paths }),
    body: "",
  };
}

describe("adaptiveSemanticFloor (field report 2026-09-01 §4.1)", () => {
  it("does nothing below the sample threshold — small corpora rank exactly as before", () => {
    const few = [0.7, 0.6, 0.5];
    expect(few.length).toBeLessThan(ADAPTIVE_FLOOR_MIN_SAMPLES);
    expect(adaptiveSemanticFloor(few, 0)).toBe(0);
    expect(adaptiveSemanticFloor(few, 0.25)).toBe(0.25);
  });

  it("raises the bar toward the mass on a compressed distribution, but never past the top hit", () => {
    // 16 hits packed in a narrow band (the reported failure): everything ~0.54–0.66.
    const compressed = [0.66, 0.64, 0.63, 0.62, 0.61, 0.6, 0.59, 0.59, 0.58, 0.58, 0.57, 0.56, 0.56, 0.55, 0.55, 0.54];
    const floor = adaptiveSemanticFloor(compressed, 0);
    const top = Math.max(...compressed);
    expect(floor).toBeGreaterThan(0.55); // trims the undifferentiated mass
    expect(floor).toBeLessThan(top); // never excludes the genuine winner
    expect(compressed.some((s) => s >= floor)).toBe(true); // list stays non-empty
  });

  it("never drops below an explicit caller floor", () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.3 + i * 0.01);
    expect(adaptiveSemanticFloor(scores, 0.9)).toBe(0.9);
  });
});

describe("extractReferencedPaths (context grounding)", () => {
  it("extracts file paths from backticks and bare text, requiring slash + extension", () => {
    const text = "See `src/payments/stripe.ts` and packages/core/src/config.ts for details.";
    const refs = extractReferencedPaths(text);
    expect(refs).toContain("src/payments/stripe.ts");
    expect(refs).toContain("packages/core/src/config.ts");
  });

  it("ignores domain terms and bare words without a slash or extension", () => {
    const text = "The `PaymentService` handles transactions in the billing module.";
    expect(extractReferencedPaths(text)).toEqual([]);
  });

  it("dedupes and strips a leading ./", () => {
    const text = "`./src/a.ts` and src/a.ts again";
    expect(extractReferencedPaths(text)).toEqual(["src/a.ts"]);
  });
});

describe("memoryHasExcludedTag (briefing strategy filter)", () => {
  it("excludes a memory carrying a default meta tag (case-insensitive)", () => {
    expect(memoryHasExcludedTag({ tags: ["Positioning"] }, DEFAULT_BRIEFING_EXCLUDE_TAGS)).toBe(true);
    expect(memoryHasExcludedTag({ tags: ["strategy", "x"] }, DEFAULT_BRIEFING_EXCLUDE_TAGS)).toBe(true);
  });

  it("keeps an ordinary technical memory", () => {
    expect(memoryHasExcludedTag({ tags: ["enforcement", "precommit"] }, DEFAULT_BRIEFING_EXCLUDE_TAGS)).toBe(false);
    expect(memoryHasExcludedTag({ tags: [] }, DEFAULT_BRIEFING_EXCLUDE_TAGS)).toBe(false);
    expect(memoryHasExcludedTag({}, DEFAULT_BRIEFING_EXCLUDE_TAGS)).toBe(false);
  });

  it("never excludes when the list is empty or missing (feature off)", () => {
    expect(memoryHasExcludedTag({ tags: ["positioning"] }, [])).toBe(false);
    expect(memoryHasExcludedTag({ tags: ["positioning"] }, undefined)).toBe(false);
  });

  it("respects a custom exclude list", () => {
    expect(memoryHasExcludedTag({ tags: ["billing"] }, ["billing"])).toBe(true);
    expect(memoryHasExcludedTag({ tags: ["billing"] }, ["other"])).toBe(false);
  });
});

describe("inferModulesFromPaths", () => {
  it("extracts package names from packages/<name>/...", () => {
    expect(
      inferModulesFromPaths([
        "packages/core/src/parser.ts",
        "packages/cli/src/commands/init.ts",
      ]),
    ).toEqual(["cli", "core"]);
  });

  it("extracts module names from src/<name>/... and apps/<name>/...", () => {
    expect(
      inferModulesFromPaths([
        "src/transactions/Tx.ts",
        "apps/web/page.tsx",
        "modules/billing/index.ts",
      ]),
    ).toEqual(["billing", "transactions", "web"]);
  });

  it("returns empty array when no path matches a known pattern", () => {
    expect(inferModulesFromPaths(["README.md", "package.json"])).toEqual([]);
  });

  it("normalizes backslashes (Windows-style paths)", () => {
    expect(inferModulesFromPaths(["packages\\core\\src\\index.ts"])).toEqual(["core"]);
  });
});

describe("pathsOverlap", () => {
  it("true for identical paths", () => {
    expect(pathsOverlap("a/b/c", "a/b/c")).toBe(true);
  });

  it("true when one is a parent of the other", () => {
    expect(pathsOverlap("packages/core", "packages/core/src/parser.ts")).toBe(true);
    expect(pathsOverlap("packages/core/src/parser.ts", "packages/core")).toBe(true);
  });

  it("false for sibling paths sharing a prefix only as substring", () => {
    expect(pathsOverlap("packages/cli", "packages/cli-extra")).toBe(false);
  });

  it("false for unrelated paths", () => {
    expect(pathsOverlap("packages/core", "packages/cli")).toBe(false);
  });

  it("ignores leading ./ and trailing /", () => {
    expect(pathsOverlap("./packages/core/", "packages/core/src")).toBe(true);
  });

  it("supports glob anchors", () => {
    expect(pathsOverlap("packages/*/src/**/*.ts", "packages/core/src/parser.ts")).toBe(true);
    expect(pathsOverlap("packages/*/src/**/*.ts", "packages/core/test/parser.test.ts")).toBe(false);
  });

  it("treats a directory as overlapping a glob below it", () => {
    expect(pathsOverlap("packages/core", "packages/core/src/**/*.ts")).toBe(true);
  });
});

describe("memoryMatchesAnchorPaths", () => {
  it("matches when anchor path is a parent of input path", () => {
    const m = memoryWithPaths(["packages/core"]);
    expect(memoryMatchesAnchorPaths(m, ["packages/core/src/parser.ts"])).toBe(true);
  });

  it("matches when input path is a parent of anchor path", () => {
    const m = memoryWithPaths(["packages/core/src/parser.ts"]);
    expect(memoryMatchesAnchorPaths(m, ["packages/core"])).toBe(true);
  });

  it("does not match anchorless memories", () => {
    const m = memoryWithPaths([]);
    expect(memoryMatchesAnchorPaths(m, ["packages/core"])).toBe(false);
  });

  it("does not match unrelated paths", () => {
    const m = memoryWithPaths(["packages/cli"]);
    expect(memoryMatchesAnchorPaths(m, ["packages/core"])).toBe(false);
  });

  it("matches glob anchor paths", () => {
    const m = memoryWithPaths(["packages/*/src/**/*.ts"]);
    expect(memoryMatchesAnchorPaths(m, ["packages/core/src/parser.ts"])).toBe(true);
  });
});
