import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "run.js");

/**
 * The action is consumed as `uses: Doucs91/hivelore/packages/github-action@vX`, which runs the
 * committed `dist/` straight from a checkout — a composite action never gets an `npm install`.
 *
 * Until v0.55.0 the bundle was 12 KB and opened with `require("@actions/github")`, because tsup
 * externalises `dependencies` by default. Every `pr-memory-check` job in every adopting repository
 * failed with `Error: Cannot find module '@actions/github'`. `npm pack` looked fine; nothing ran it.
 *
 * This test reads what actually ships.
 */
describe("published action bundle", () => {
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

  it("is committed", () => {
    expect(existsSync(DIST), "dist/run.js is missing — run `pnpm --filter @hivelore/github-action build`").toBe(true);
  });

  it("requires nothing but Node built-ins", () => {
    const source = readFileSync(DIST, "utf8");
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!);
    const external = [...new Set(required.filter((id) => !builtins.has(id)))];
    expect(
      external,
      `these are not bundled and will throw MODULE_NOT_FOUND on the runner: ${external.join(", ")}`,
    ).toEqual([]);
  });

  it("actually bundled its dependencies rather than shipping a stub", () => {
    // A bundle that inlined @actions/github + its octokit tree is hundreds of KB; the broken one
    // was 12 KB. A hard floor catches a build that silently reverted to externals.
    expect(readFileSync(DIST).byteLength).toBeGreaterThan(100_000);
  });
});
