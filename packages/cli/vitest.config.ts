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
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
