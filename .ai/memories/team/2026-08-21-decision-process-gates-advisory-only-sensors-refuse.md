---
id: 2026-08-21-decision-process-gates-advisory-only-sensors-refuse
scope: team
type: decision
status: validated
anchor:
  paths:
    - packages/cli/src/commands/enforce.ts
    - packages/core/src/config.ts
  symbols: []
tags:
  - enforcement
  - gate
  - product-decision
created_at: '2026-08-21T00:50:51.754Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
topic: enforcement-process-gate-posture
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# Process gates report; only deterministic findings refuse (v0.55.0)

`enforcement.processGate` defaults to **`"warn"`**. The process gates — `briefing-missing`,
`session-recap-missing`, `decision-coverage-missing`, `bootstrap-incomplete` — now report at every
stage and refuse at none. Only code-bound findings block: `sensor-block`, `precommit-policy-block`,
stale anchors **on touched files**, artifact hygiene.

Two related changes ship with it:
- `enforcement-score-below-threshold` is a **warning**, never a block, and is suppressed entirely
  when something else already refused (a real block must never be buried under score noise).
- `stale-important-memories` blocks only for memories anchored to files the change touches; stale
  anchors elsewhere surface as `stale-memories-elsewhere` (warn).

## Why

A v0.54.0 field report had two pushes refused. Both carried tested code with a green SonarQube gate
and zero violations, and **not one penalty was about the code**: `briefing-missing (−35)`,
`session-recap-missing (−20)`, `bootstrap-incomplete (−5)`.

The predictable response to that is `git push --no-verify` — which costs the developer the entire
gate, sensors included. A gate that gets routinely bypassed protects nothing. So the gate now spends
its refusals only where it holds deterministic evidence about the diff, and *asks* for the rest.

## Do not re-litigate

- Teams that want the old posture set `processGate: "block"`. `humanCommits` still carves humans out
  of it, and only matters when `processGate` is `"block"` — `processGate` is the master switch.
- Do NOT reintroduce a composite score as a blocking finding. A score moves for reasons unrelated to
  the change under review and names nothing the author can act on. Name the sensor and the line
  instead — findings now carry `file` and `matched_line` for exactly this.
