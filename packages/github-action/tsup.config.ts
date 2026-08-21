import { defineConfig } from "tsup";

/**
 * The action runs from a checkout of THIS repository — `uses: Doucs91/hivelore/packages/github-action@vX`
 * — and a composite action gets no `npm install`. Whatever `dist/run.js` `require()`s at runtime must
 * therefore already be inside it.
 *
 * tsup treats `dependencies` as external by default, which is right for the CLI and MCP packages
 * (see gotcha 2026-04-25-gotcha-tsup-externals-required) and exactly wrong here: the published
 * action shipped a 12 KB bundle that opened with `require("@actions/github")` and died with
 * `Error: Cannot find module '@actions/github'` on every pull request, in every repo that adopted
 * the `pr-memory-check` job. `noExternal` inverts that for this package only — the GitHub Actions
 * convention for JavaScript actions is a self-contained committed `dist/`.
 *
 * `packages/github-action/test/bundle.test.ts` fails the build if an external require comes back.
 */
export default defineConfig({
  entry: ["src/run.ts"],
  format: ["cjs"],
  outDir: "dist",
  splitting: false,
  minify: true,
  // Bundle every dependency; only Node built-ins may stay external.
  noExternal: [/^(?!node:)(?!fs$)(?!path$).*/],
  platform: "node",
  target: "node20",
});
