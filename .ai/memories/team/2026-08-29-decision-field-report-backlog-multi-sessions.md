---
id: 2026-08-29-decision-field-report-backlog-multi-sessions
scope: team
type: decision
status: validated
anchor:
  paths:
    - docs/hivelore-retour-multi-sessions-2026-08-29.md
    - packages/core/src/usage.ts
    - packages/core/src/sensor-suggest.ts
  symbols: []
tags:
  - backlog
  - field-report
  - sensors
  - telemetry
created_at: '2026-08-29T05:47:32.791Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# Backlog — field reports (retour multi-sessions 2026-08-29 + earlier)

Where the next agent should start. Prioritised remaining items from the three field reports in
`docs/hivelore-retour-*`. Items already SHIPPED are listed at the bottom so nobody redoes them.

## Done in v0.57.6 (do NOT redo)
- **§3.4** `propose_sensor` now refuses `fires-on-correct` at ANY severity (not just block), and a warn
  sensor that fires-on-current returns an explicit caveat instead of a bland `accepted:true`
  (`judgeProposedSensor` in `core/sensors.ts`, caveat in `mcp/tools/propose-sensor.ts`).
- **§3.5** Presence/deletion sensor: a regex sensor with `require_present: true` fires when a change
  REMOVES the required line (evaluated on final content). `runPresenceSensors` + `changedPathsFromDiff`
  in `core/sensors.ts`, wired into `runSensorGate` (`cli/commands/enforce.ts`), proposable via
  `propose_sensor({ require_present: true })`. **CLI `sensors propose --require-present` is NOT wired
  yet** — MCP only. Small follow-up.
- **§4 (slice)** `sensor.last_fired` is now stamped into the memory frontmatter on a real prevention
  (`stampSensorLastFired` in `core/prevention.ts`), so a fired guard survives a clone.
- **§5 (slice)** The prevention receipt no longer prints a "rising/declining" verdict on a tiny sample
  (`trendClause` in `core/prevention.ts`).
- Earlier (v0.57.5): invalid-corpus gate block, clear parse errors, sensor-overwrite guard, brittle
  heuristic IP/escape exemption, `lifecycle` field, doctor dead-`.mcp.json` detection, code-map worktree
  exclusion, embeddings error surfacing.

## Remaining — recommended order

1. **§4 (full) — read telemetry visible in the repo.** `read_count`/`last_read_at` still live only in
   gitignored `.ai/.cache/usage.json`, so a clone can't prune or see which memories are dead weight.
   DESIGN TENSION: writing per-read counters into each `.md` causes merge-conflict churn across
   parallel agents (the whole reason it's cached). Preferred approach: **commit `usage.json`** (move it
   out of `.ai/.cache/`, add a merge driver) OR persist a batched/decayed summary on `hivelore sync`
   (a deliberate moment), not on every read. Home: `core/usage.ts`, `.gitignore` generation in
   `cli/commands/init.ts`, and the worktree-clean exclusion in `enforce.ts` (like code-map.json).

2. **§5 (full) — historise the PR prevention receipt.** It still regenerates from the current run, so a
   fix erases the "fired" proof. Needs workflow plumbing: parse the EXISTING PR comment and preserve a
   `### Previously prevented` section, OR persist the prevention log into CI. Home:
   `.github/workflows/hivelore-enforcement.yml` + `cli/commands/stats.ts` + `core/prevention.ts`.

3. **§3.3 — reduce `proposed_sensor_seed`.** The prose-extraction seed (`suggestSensorSeed` in
   `core/sensor-suggest.ts`) produced 4/4 unusable seeds on French lessons (e.g. `test:une`). Keep the
   strong `--from-fix` mining path; drop or heavily gate the body-token seed so agents aren't nudged to
   arm nonsense.

4. **§6.1 — memory summary = first line.** In `compact`/`actions` formats an intro sentence becomes the
   whole summary. Extract a real summary or require the first body line to carry the info. Home:
   `core/briefing-body.ts`, `mcp/tools/get-briefing.ts`.

5. **§6.3 — bridge-file duplication.** CLAUDE.md/AGENTS.md/GEMINI.md are near-identical and churn 12
   commits into unrelated PRs. Consider one canonical + one-line pointers (tradeoff: some agents read
   only one file). Home: `core/bridges.ts`.

6. **§6.4 — recap/memory id frozen at creation date.** A 3-day-old recap still reads `2026-08-27-…`.
   Consider surfacing `verified_at`/`revision_count` in listings, or a display date.

7. **§6.6 — `haive` vs `hivelore` naming.** Generated markers (`<!-- haive:… -->`,
   `.cursor/rules/haive-memories.mdc`) still use the old prefix. Cosmetic but erodes trust.

8. **§6.2 — health-score / decision-coverage noise** shown on every commit though never blocking.
   Consider printing it only on demand / on change.

## Judgement to preserve
The reports agree the SESSION RECAP + anchored memory-with-why is the product's real, under-sold value;
the deterministic gate is over-sold. Do not add gate ceremony; make each sensor/receipt claim honest
and reduce noise. See `docs/hivelore-retour-multi-sessions-2026-08-29.md` §9.
