import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { managedGitHookSpecs, buildHookFileContent } from "../src/commands/enforce.js";

/**
 * Everything Hivelore WRITES INTO A USER'S REPOSITORY must be valid in its own format.
 *
 * This rule exists because two artifacts violated it in production simultaneously, and 892 tests
 * saw neither: the generated `hivelore-enforcement.yml` did not parse (GitHub ran zero jobs in every
 * repo that had run `hivelore init`), and the published GitHub Action bundle did not load its own
 * dependencies. Both were "tested" only in the sense that something built them.
 *
 * The shared lesson is narrow and worth stating: **what Hivelore computes had 892 tests; what
 * Hivelore delivers had none.** A generated file is a deliverable. Parse it, or run it.
 *
 * Workflows are covered by `generated-workflows.test.ts`; this file covers the git hooks, which
 * have the same blast radius — a shell syntax error in a pre-commit hook breaks every commit in
 * every repo that installed it — and had no syntax check anywhere in the suite.
 */
describe("generated git hooks", () => {
  const specs = managedGitHookSpecs();

  it("generates the hooks the installer claims to manage", () => {
    expect(specs.map((s) => s.name).sort()).toEqual(
      ["commit-msg", "post-merge", "post-rewrite", "pre-commit", "pre-push"].sort(),
    );
  });

  for (const spec of specs) {
    describe(spec.name, () => {
      it("is valid shell", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "hivelore-hook-"));
        try {
          const file = path.join(dir, spec.name);
          writeFileSync(file, buildHookFileContent("", spec.body), "utf8");
          // `sh -n` parses without executing: exactly the check that was missing.
          expect(() => execFileSync("sh", ["-n", file], { stdio: "pipe" })).not.toThrow();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("starts with a shebang and never hard-depends on the binary being installed", () => {
        const content = buildHookFileContent("", spec.body);
        expect(content.startsWith("#!")).toBe(true);
        // A hook that fails when `hivelore` is absent bricks the repo for anyone who has not
        // installed the CLI — a teammate, or CI. The generated block guards the lookup.
        expect(content).toContain("command -v hivelore");
      });

      it("stays valid shell when appended after a foreign hook (husky and friends)", () => {
        const foreign = '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\nnpm test\n';
        const dir = mkdtempSync(path.join(tmpdir(), "hivelore-hook-mix-"));
        try {
          const file = path.join(dir, spec.name);
          writeFileSync(file, buildHookFileContent(foreign, spec.body), "utf8");
          expect(() => execFileSync("sh", ["-n", file], { stdio: "pipe" })).not.toThrow();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }
});
