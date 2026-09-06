import { describe, expect, it } from "vitest";

// The module runs `main()` on import unless this is set (see the bottom of run.ts).
process.env.HIVELORE_ACTION_TEST = "1";
const { extractSensor, highChurnPaths, pathsOverlap } = await import("../src/run.js");

describe("pathsOverlap", () => {
  it("matches a file against itself and against a directory anchor", () => {
    expect(pathsOverlap("src/app.ts", "src/app.ts")).toBe(true);
    expect(pathsOverlap("frontend/src/PhoneField.tsx", "frontend/src")).toBe(true);
  });

  it("does NOT match on a shared filename or a shared tail (the PR #78 false positive)", () => {
    expect(pathsOverlap("frontend/public/images/README.md", "README.md")).toBe(false);
    expect(pathsOverlap("frontend/package.json", "packages/core/package.json")).toBe(false);
    expect(pathsOverlap("src/app.ts", "app.ts")).toBe(false);
  });

  it("does not match a sibling directory that shares a prefix string", () => {
    expect(pathsOverlap("frontend/src-generated/x.ts", "frontend/src")).toBe(false);
  });
});

describe("highChurnPaths", () => {
  const commits = (n: number, files: string[]): string[][] => Array.from({ length: n }, () => files);

  it("flags a file present in most commits", () => {
    const history = [...commits(18, ["docs/roadmap.md", "src/a.ts"]), ...commits(6, ["src/b.ts"])];
    const churn = highChurnPaths(history);
    expect(churn.has("docs/roadmap.md")).toBe(true);
    expect(churn.has("src/b.ts")).toBe(false);
  });

  it("excludes nothing when the checkout is too shallow to characterise churn", () => {
    expect(highChurnPaths(commits(5, ["docs/roadmap.md"])).size).toBe(0);
  });

  it("counts a file once per commit even if listed twice", () => {
    const history = commits(25, ["docs/roadmap.md", "docs/roadmap.md"]);
    expect(highChurnPaths(history).has("docs/roadmap.md")).toBe(true);
  });
});

describe("extractSensor", () => {
  it("reads severity and message out of the frontmatter sensor block", () => {
    const raw = [
      "---",
      "id: 2026-01-01-convention-x",
      "sensor:",
      "  kind: regex",
      "  pattern: 'foo'",
      "  severity: block",
      "  message: No hardcoded credentials, even in tests.",
      "anchor:",
      "  paths:",
      "    - src",
      "---",
      "# body",
    ].join("\n");
    expect(extractSensor(raw)).toEqual({ severity: "block", message: "No hardcoded credentials, even in tests." });
  });

  it("returns undefined for a memory with no sensor", () => {
    expect(extractSensor("---\nid: x\n---\nbody")).toBeUndefined();
  });
});
