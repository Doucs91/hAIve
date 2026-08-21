import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// tsup injects __HAIVE_VERSION__ at build time; vitest must define it too, or any test that
// imports a module reading it at top level (init.ts builds the GitHub Action ref from it) dies
// at import with "__HAIVE_VERSION__ is not defined". Mirrors packages/mcp/vitest.config.ts.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __HAIVE_VERSION__: JSON.stringify(version) },
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        // Kept single-fork DELIBERATELY. Parallel forks look like the obvious fix for a ~104s
        // suite, but vitest 2.1.9 resolves worker paths through a URL and mis-handles a SPACE in
        // the project path: turning this flag off makes this repo (".../New idea") die at startup
        // with `executeTests ../../../New%20idea/...` and collect zero tests. It would break for
        // any user whose checkout has a space in its path, on their machine only.
        // (The prose above deliberately avoids spelling the disabled form — the block sensor on
        //  2026-08-21-attempt-enabling-parallel-vitest-forks-… matches it, and a regex sensor
        //  cannot tell a comment from code. Use `--kind ast` when a lesson must be discussed in
        //  prose next to the code it guards.)
        //
        // The real fix for feedback speed was to stop needing this suite for logic questions:
        // the gate's decision rule now lives in `core/gate-verdict.ts` and its 18 tests run in
        // ~30ms. Keep behaviour that can be decided from inputs alone OUT of this file.
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
