---
id: 2026-09-06-decision-field-report-batch-v0620-honest-gates
scope: team
type: decision
status: validated
anchor:
  paths:
    - packages/cli/src/commands/enforce.ts
    - packages/core/src/enforcement.ts
    - packages/core/src/sensors.ts
    - packages/core/src/code-map.ts
    - packages/github-action/src/run.ts
    - packages/mcp/src/tools/get-briefing.ts
  symbols: []
tags:
  - field-report
  - enforcement
  - gate-honesty
created_at: '2026-09-06T00:16:04.570Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
## Field-report batch v0.62.0 — the choices future agents must not re-litigate

Both 2026-09-05 reports converged on one theme: **the gap between what Hivelore displays and what it
does is more damaging than any friction it causes.** An agent that has been misled once stops reading
the tool. Each decision below follows from that, not from a preference.

1. **`--stage local` scans the WORKTREE diff (`git diff HEAD`), not the index.** The agent asks "is
   what I just wrote clean?" before it stages anything; scanning only the index would rebuild the
   same false green one step later. Preview evaluations go to the sensor ledger as `manual`, never
   `pre-commit` — a preview never guarded a commit and must not inflate prevention counts.
2. **A gate never prints "passed" about a check it skipped.** `DEFERRED_CODES` in enforce.ts drives
   the `, N deferred (…)` suffix. If you add a check that can be skipped, add its code there.
3. **`briefing-loaded` reports provenance, and strictness is opt-in.** `hasRecentBriefingMarker`
   (any marker in TTL) still backs decision-coverage accrual — tightening it there would newly block
   commits whose briefing came from a differently-keyed session. `describeBriefingMarker` is the one
   to use when reporting a guarantee to a human. Renaming the finding to `briefing-marker-present`
   for a foreign marker was preferred over silently tightening: a check may not promise more than
   it measures, and the honest name costs nothing.
4. **Blind-spot auditing skips documentation.** `sensorAppliesToPath` already refuses to fire a
   content sensor on a doc reached through a scope, so a doc match is never a real hole — reporting
   it would send the reader to widen a scope that would still not fire.
5. **A failed run with no failed STEP is infrastructure; a failed run whose steps ran and passed
   still blocks.** The ambiguous case fails closed. The motivating case (an exhausted Actions
   budget stops every job in the account) has zero executed steps, which is what distinguishes it.
6. **High-churn exclusion is measured, never a filename list.** `docs/roadmap.md` is high-churn in
   one repo and meaningful in another. With too little history to measure (a shallow checkout),
   nothing is excluded — degrade to the old behaviour, never to a silent over-filter.
7. **The code-map migration deletes the legacy tracked file on the next write.** Leaving it would
   keep the churn that motivated the move; deleting it is one deletion in one commit.

Related: [[2026-09-05-gotcha-hook-stdin-timeout-holds-event-loop]] (the same reports' §3/§7).
