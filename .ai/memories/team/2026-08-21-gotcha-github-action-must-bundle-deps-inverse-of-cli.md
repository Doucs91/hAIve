---
id: 2026-08-21-gotcha-github-action-must-bundle-deps-inverse-of-cli
scope: team
type: gotcha
status: validated
anchor:
  paths:
    - packages/github-action/tsup.config.ts
    - packages/github-action/package.json
  symbols: []
tags:
  - build
  - tsup
  - github-action
created_at: '2026-08-21T00:51:02.125Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# The GitHub Action must BUNDLE its deps — the exact inverse of the CLI/MCP rule

`2026-04-25-gotcha-tsup-externals-required` says tsup externals are required. That is true for
`@hivelore/cli` and `@hivelore/mcp`, which are npm packages installed with their dependency tree.

It is **exactly wrong** for `packages/github-action`. That action is consumed as
`uses: Doucs91/hivelore/packages/github-action@vX`, which runs the committed `dist/` straight from a
bare checkout — a composite action never gets an `npm install`. Whatever `dist/run.js` `require()`s
at runtime must already be inside it.

tsup externalises `dependencies` by default, so the published bundle was 12 KB and opened with
`require("@actions/github")`. Every `pr-memory-check` job in every adopting repository failed with
`Error: Cannot find module '@actions/github'`. Shipped for months: `npm pack` and the unit tests
both passed because **nothing ever executed the bundle**.

## How to apply

- `packages/github-action/tsup.config.ts` sets `noExternal` so only Node built-ins stay external.
- `packages/github-action/test/bundle.test.ts` fails if a non-builtin `require(` returns, or if the
  bundle shrinks back under 100 KB.
- `.github/workflows/ci.yml` verifies the committed `dist/` is in sync with source AND **runs it in
  an empty directory**. For anything that ships as an executable artifact, packing is not testing.
