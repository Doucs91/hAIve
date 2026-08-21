---
id: 2026-08-21-architecture-gate-verdict-is-the-single-decision-rule
scope: team
type: architecture
status: validated
anchor:
  paths:
    - packages/core/src/gate-verdict.ts
    - packages/cli/src/commands/enforce.ts
  symbols: []
tags:
  - architecture
  - enforcement
  - gate
created_at: '2026-08-21T03:08:17.562Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
topic: gate-decision-architecture
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# `core/gate-verdict.ts` is the ONLY place that decides what refuses

Severity resolution, posture, baseline health and refusal deduplication live in
`packages/core/src/gate-verdict.ts` as pure functions. `enforce.ts` collects findings and renders
them; it must not decide anything.

## The rule, in one breath

Process gates refuse only when the repo asked for it (`processGate: "block"`), only at a SHARING
point, and only for whoever they are meant to bind. One clause is not a knob: **they never refuse a
local commit, at any posture.**

## Why this is not negotiable

The logic used to be **three sequential downgrade passes** inside `enforce.ts` — `relaxForHuman`,
then the processGate default, then a commit-stage pass. Each arrived with a different bug fix, none
knew about the others, and the outcome depended on their order, which was documented nowhere. The
natural way to fix the next report was to add a fourth. That is how a gate becomes unpredictable,
and an unpredictable gate gets bypassed.

Extracting it immediately paid: the rewrite had dropped the CI carve-out (CI must bind everyone —
it validates the merged result on everyone's behalf) and a unit test caught it before release.

## How to apply

- New gate behaviour → a branch in `decideVerdict`, plus a case in `core/test/gate-verdict.test.ts`.
  **Never** a new `.map()` over findings in `enforce.ts`.
- New posture defaults → `POSTURE_DEFAULTS`. Do not add a switch that duplicates one.
- Anything decidable from inputs alone belongs in the core unit tests (~30 ms), not in the CLI
  integration suite (~104 s, and it cannot be parallelised here — see
  [[2026-08-21-attempt-enabling-parallel-vitest-forks-pooloptionsforkssinglefork]]).
- The health score measures the repo's STANDING STATE only. Never fold a content catch into it: a
  number that moves both for a cold corpus and for one bad diff means nothing over time.
