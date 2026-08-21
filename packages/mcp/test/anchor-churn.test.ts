import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHaivePaths } from "@hivelore/core";
import { loadAnchorChurn, MIN_CHURN_SAMPLE } from "../src/anchor-churn.js";

/**
 * Churn is IDF over recent commits, and IDF over one document is meaningless.
 *
 * `actions/checkout` defaults to depth 1, so a shallow clone is the NORMAL state in CI: `git log`
 * returns a single commit, every file it touched scores 100% churn, and every anchor is classified
 * weak. That is strictly worse than not measuring — it shipped once, and showed up as the same
 * commit scoring 96 locally and 94 in CI.
 */
describe("loadAnchorChurn — too small a sample is not a measurement", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "hivelore-churn-"));
    mkdirSync(path.join(repo, ".ai"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    return () => undefined;
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const commit = (n: number) => {
    writeFileSync(path.join(repo, `f${n}.ts`), `export const v = ${n};\n`, "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", `c${n}`], { cwd: repo, stdio: "pipe" });
  };

  it("returns null on a shallow/young repo rather than calling every anchor weak", async () => {
    for (let i = 0; i < 3; i++) commit(i);
    expect(await loadAnchorChurn(resolveHaivePaths(repo))).toBeNull();
  });

  it("measures once the sample is large enough to mean something", async () => {
    for (let i = 0; i < MIN_CHURN_SAMPLE + 2; i++) commit(i);
    const churn = await loadAnchorChurn(resolveHaivePaths(repo));
    expect(churn).not.toBeNull();
    expect(churn!.total_commits).toBeGreaterThanOrEqual(MIN_CHURN_SAMPLE);
    expect(churn!.files["f0.ts"]).toBe(1);
  });

  it("returns null outside a git repository", async () => {
    const bare = mkdtempSync(path.join(tmpdir(), "hivelore-nogit-"));
    try {
      expect(await loadAnchorChurn(resolveHaivePaths(bare))).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
