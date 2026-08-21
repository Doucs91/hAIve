---
id: 2026-04-30-session_recap-recap
scope: team
type: session_recap
status: validated
anchor:
  paths:
    - packages/core/src/gate-verdict.ts
    - packages/core/test/gate-verdict.test.ts
    - packages/cli/src/commands/enforce.ts
    - packages/cli/src/commands/doctor.ts
    - packages/core/src/config.ts
    - packages/core/src/sensor-suggest.ts
    - packages/cli/test/generated-artifacts.test.ts
    - packages/cli/vitest.config.ts
  symbols: []
tags:
  - session
  - recap
created_at: '2026-04-30T00:02:07.282Z'
expires_when: null
verified_at: '2026-08-21T19:59:19.519Z'
stale_reason: null
related_ids: []
last_read_at: null
topic: session-recap-team
revision_count: 44
requires_human_approval: false
validated_by: null
---
## Goal
Answer empirically why a field report scored the briefing 30/100 while `hivelore eval` reported 98% recall, then fix whatever the measurement found.

## Accomplished
- Built a briefing replay over 25 real commits with anchors as ground truth (no hand-written queries). Found the median commit has 34 memories claiming `must_read` for 8 slots — recall@8 was near its arithmetic ceiling, not a ranking failure.
- Traced the cause: `package.json` is touched by 106 of 149 commits (71%), so every lesson anchored to it declares `must_read` on every release commit. Anchor matches were weighted regardless of how much they discriminate.
- Added `core/anchor-specificity.ts` (IDF over anchors, pure) + `mcp/anchor-churn.ts` (one cached `git log -200`). Weak anchors need corroboration to reach must_read, and specificity breaks ties within a tier.
- Measured effect on real commits: slots spent on a low-information anchor 17% → 4%; mean specificity 0.73 → 0.82.
- `hivelore doctor` gained `memory-broad-anchors`, naming the memories to re-anchor with the share of commits each claims (6 found here).
- Fixed `detectFailure`: a command that exited 0 did not fail. Measured 0/3 precision on 256 real observations before the fix.
- Re-cut the eval baseline 97 → 96 with the trade recorded as a decision memory. 916 tests green, eval gate exit 0.</accomplished>
<parameter name="discoveries">- The decisive finding: `exactTaskMatch` is a literal AND-match over the whole memory body, and on a task-shaped corpus it fires on nearly everything. Including it as corroboration silently defeated the entire specificity check — a `chore: bump version` commit marked every package.json lesson `exact`. I only found it by tracing priorities at runtime; the change looked correct and did nothing.
- My first metric was wrong in a way worth remembering: it treated all 34 anchored memories as equally expected, so reordering which 8 surfaced could not move recall. A metric blind to the improvement it is meant to measure looks exactly like an improvement that does not work.
- The eval's blind spot is structural: its cases ask "given a query written to find X, does X surface?", which never puts two anchors in competition. That is why it read 98% while a real session read 30/100. A benchmark can be honest and still measure the wrong thing.
- `detectFailure` fired on its own source code — `grep -A22 "function detectFailure"` was recorded as a failure because its output IS the list of strings it matches. Same class as the block sensor that refused my commit yesterday over the prose in its own explanatory comment: a regex cannot tell code from text about code.
- ctx (ctx.rs, 1042 stars, Rust) does NOT extract anything from agent transcripts — it indexes them verbatim and lets the next agent search on demand. Measuring here confirmed why: exit-code-based failure detection has ~0% precision, and the lesson lives in the agent's prose, not in the tool I/O.</parameter>
<parameter name="files_touched">["packages/core/src/anchor-specificity.ts", "packages/core/src/priority.ts", "packages/mcp/src/anchor-churn.ts", "packages/mcp/src/tools/briefing-helpers.ts", "packages/mcp/src/tools/get-briefing.ts", "packages/cli/src/commands/doctor.ts", "packages/cli/src/commands/observe.ts", ".ai/eval/baseline.json"]

## Next steps
- Add eval cases where SEVERAL memories legitimately match the same files — the eval currently cannot measure what this release improved.
- Re-anchor the 6 memories `doctor` now names; each needs the precise path its lesson is really about.
- Still open from the field report: §4.3 active decay, §4.5 receipt distinguishing bypassed / false-positive from prevented.
