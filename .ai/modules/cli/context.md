# Module: cli (`@hivelore/cli`)

The main product surface — `commander`-based CLI; also bundles the MCP server (`hivelore mcp --stdio`).

## Purpose
User-facing orchestration: init, briefing, memory, sensors, enforce, sync, doctor, eval, session end.

## Conventions specific to this module
- Each subcommand is its own file under `src/commands/`, registered on the root program. Keep command
  files **thin**: parse options, resolve the root, call core/MCP, print actionable output.
- Heavy ranking/scoring/matching belongs in `@hivelore/core`, not here.
- Default `hivelore --help` exposes only the golden path (init → briefing → enforce → session end);
  maintenance/experimental commands stay behind `--advanced`.
- Doctor findings must be concrete and fixable: a specific code (e.g. `pnpm-not-on-path`) + exact command.

## Internals
- `enforce.ts` is the gate engine: `buildEnforcementReport` (local/pre-commit/ci) and `buildFinishReport`.
  Each gate pushes an `EnforcementFinding`; `should_block = mode==="strict" && any error`.
- CI runs `node packages/cli/dist/index.js enforce ci` — the freshly built repo code, not the published package.
