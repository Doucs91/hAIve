---
id: 2026-04-30-session_recap-recap
scope: team
type: session_recap
status: validated
anchor:
  paths:
    - packages/cli/src/commands/enforce.ts
    - packages/cli/src/commands/init.ts
    - packages/cli/src/commands/stats.ts
    - packages/cli/src/commands/bridges.ts
    - packages/core/src/code-map.ts
    - packages/core/src/prevention.ts
    - packages/core/src/sensors.ts
    - packages/core/src/gate-reminder.ts
    - packages/mcp/src/embeddings-runtime.ts
    - packages/github-action/tsup.config.ts
  symbols: []
tags:
  - session
  - recap
created_at: '2026-04-30T00:02:07.282Z'
expires_when: null
verified_at: '2026-08-21T00:51:35.848Z'
stale_reason: null
related_ids: []
last_read_at: null
topic: session-recap-team
revision_count: 42
requires_human_approval: false
validated_by: null
---
## Goal
Work through a v0.54.0 user field report (62/100, two production repos) and implement every defect fix and improvement that stood up to verification.

## Accomplished
- Reproduced and fixed the invalid generated `hivelore-enforcement.yml` (TS `\n` escapes broke the YAML scalar); receipt body now rendered by `stats receipt --comment --gate`, no jq program in YAML. Added `generated-workflows.test.ts` and PROVED it fails on the pre-fix artifact with the reporter's exact error (line 47, col 1).
- Fixed the GitHub Action shipping unbundled deps (tsup externals). New `tsup.config.ts` with `noExternal`, bundle 12 KB → 528 KB, verified by executing it in an empty dir. Added `bundle.test.ts` + two CI steps (dist in sync, smoke-run with no node_modules).
- Found and fixed the ROOT CAUSE of the "briefing never helped" complaint: every embeddings call site wrapped only the dynamic `import()`, leaving `semanticSearch()` outside the try — so a broken native dep crashed `get_briefing` instead of degrading to lexical. New `runSemantic` guard covers load+call at all sites; messages now separate "not installed" from "installed but broken".
- Made `.ai/code-map.json` deterministic: no absolute `root`, no per-run `generated_at` (both back-filled on load), sorted keys, and no write when content is unchanged.
- Gate posture: new `enforcement.processGate` (default `warn`), score-threshold demoted to a non-blocking measurement and suppressed when something really refused, sensor findings now carry `file` + `matched_line`, stale-anchor blocking scoped to touched files.
- Ergonomics: stack packs opt-in, `bridges sync --all` requires `--yes`, shared `explainSensorRejection` naming the warn-first bootstrap path, 24h throttle on repeated advisories, anchor suggestions on anchorless `memory save`, MCP restart notice at init.
- 892 tests green; full verify chain (build/artifacts/typecheck/test/eval gate) passes at 0.55.0.

## Discoveries & surprises
- The invalid-YAML defect was three lines of test away for its whole life: nothing ever parsed a file `init` generates. Same class as the Action bug — nothing ever EXECUTED the bundle we publish. Both artifacts were "verified" only by building them.
- The embeddings guard bug is a general pattern worth watching for: wrapping the cheap `import()` of an optional dependency but not the first CALL, which is where lazy native runtimes actually load. It made an enhancement failure look like a product failure.
- Three capabilities the report asked for as missing already existed and were simply unfindable: PR-review→memory (`ingest --from github-pr`), structural sensors (`--kind ast|shell|test`), and anchor-proximity briefing ranking (`directAnchor` → must_read). Absence of discoverability reads as absence of feature.
- The old committed code-map held 342 files, 140 of them under gitignored `engram/` which is not even on disk any more. Regenerating dropped it to a correct 197.
- `mem_save` again proposed an INVERTED sensor seed (`uses: Doucs91`, which matches correct usage). Not armed. Third time this generator has suggested a fires-on-correct pattern.

## Files touched
- `packages/cli/src/commands/enforce.ts`
- `packages/cli/src/commands/init.ts`
- `packages/cli/src/commands/stats.ts`
- `packages/cli/src/commands/bridges.ts`
- `packages/core/src/code-map.ts`
- `packages/core/src/prevention.ts`
- `packages/core/src/sensors.ts`
- `packages/core/src/gate-reminder.ts`
- `packages/mcp/src/embeddings-runtime.ts`
- `packages/github-action/tsup.config.ts`

## Next steps
- Glama: Sync Server + a new release so the score re-grades against 15 tools (still shows 13 / v0.1.0).
- Consider arming a `kind: test` sensor on the action bundle lesson once `runCommandSensors` is on; CI already enforces it deterministically.
- §4.3 (active memory decay) and §4.5 (receipt distinguishing bypassed / false-positive from prevented) are the two field-report items deliberately left for a later pass.
