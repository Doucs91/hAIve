---
id: 2026-08-21-decision-anchor-specificity-ranking-and-the-eval-tradeoff
scope: team
type: decision
status: validated
anchor:
  paths:
    - packages/core/src/anchor-specificity.ts
    - packages/core/src/priority.ts
    - packages/mcp/src/anchor-churn.ts
    - .ai/eval/baseline.json
  symbols: []
tags:
  - briefing
  - ranking
  - eval
  - measurement
created_at: '2026-08-21T19:54:32.045Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
topic: briefing-anchor-specificity
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# Anchor specificity: why the briefing ranks by it, and why the eval baseline moved 97 → 96

An anchor match promotes a memory to `must_read`, the strongest ranking signal there is. That is
right for a specific anchor and wrong for a file every commit touches.

**Measured on this repo (149 commits, 116 anchored memories):** `package.json` is touched by
**106/149 commits (71%)**. The median memory claims 12 of 60 commits; the p90 claims 36. On a
release commit ~34 memories declared `must_read` simultaneously while the briefing had 8 slots.

`anchor-specificity.ts` scores a match by how rare the matched path is (plain IDF). A weak anchor
(touched by >35% of commits) no longer promotes on its own — it needs a strong semantic hit or a
symbol match — and specificity also breaks ties WITHIN a tier.

## Corroboration deliberately excludes `exactTaskMatch`

`exactTaskMatch` is a literal AND-match over the whole memory body. On a task-shaped corpus it fires
on nearly everything: a `chore: bump version` commit marked every `package.json` lesson `exact` and
promoted all of them straight back to `must_read`, silently defeating the whole check. Only
`strongSemantic` (≥0.65) or `directSymbol` count. Literal body overlap is exactly the "global
textual relevance" a field report identified as the ranking's weak point.

## The eval baseline was re-cut, on purpose

| measured on 25 real commits | before | after |
|---|---|---|
| mean specificity of the matched anchor | 0.73 | **0.82** |
| slots spent on a low-information anchor | 17% | **4%** |

Cost: `hivelore eval` 97 → 96, MRR 0.946 → 0.939. **Recall stayed 98% and no case became a miss** —
the drop is a slightly lower rank, never a lost memory.

The eval cannot see the benefit by construction: its cases ask *"given a query written to find
memory X, does X surface?"*, which never puts two anchors in competition. That blind spot is why a
field report scored briefing usefulness **30/100** while the harness reported 98% recall.

**Do not "recover" the point by relaxing the specificity rule.** If the eval score must go back up,
add cases where several memories legitimately match the same files — that measures the thing the
briefing actually does.

## How to apply

- Churn is measured in `mcp/anchor-churn.ts` (one `git log -200`, cached in gitignored
  `.ai/.cache/`, invalidated by HEAD). Unmeasurable churn → specificity 1 → ranking unchanged, so a
  repo without git behaves exactly as before.
- `hivelore doctor` reports `memory-broad-anchors` naming the memories to re-anchor. The fix is
  always additive: give the lesson the precise path it is really about.
