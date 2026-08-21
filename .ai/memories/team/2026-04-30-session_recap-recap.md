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
verified_at: '2026-08-21T03:08:40.072Z'
stale_reason: null
related_ids: []
last_read_at: null
topic: session-recap-team
revision_count: 43
requires_human_approval: false
validated_by: null
---
## Goal
Improve six existing parts of Hivelore to excellence without adding any new capability, following my own analysis of the friction observed while working in this repo.

## Accomplished
- Extracted the gate's decision rule into a pure `core/gate-verdict.ts` (337 lines), replacing three stacked downgrade passes in `enforce.ts`. 18 unit tests, ~30ms.
- Added `enforcement.posture` (advisory | balanced | strict) collapsing 24 interacting knobs into one choice; individual switches still override; `doctor` prints the effective posture.
- Deduplicated refusals by memory id: one lesson now produces one line naming the file and the offending source line (was four lines under two codes).
- Redefined the score as `knowledge-layer health`, computed from the repo's standing state only — content catches excluded — and relabelled in output.
- Extended the generated-artifact harness to git hooks: `sh -n` over every managed hook, including when appended after a foreign husky hook (16 tests). No shell syntax check had existed anywhere.
- Made the sensor seed generator test candidates against the lesson's own "Instead, use" / "How to apply" sections and drop inverted ones; discriminating `absent` sensors exempt.
- Full chain green at 0.56.0: 8+57+4+14+2 test files, artifacts OK, eval gate exit 0.</accomplished>
<parameter name="discoveries">- Extracting the rule caught a regression my own rewrite introduced: the human carve-out was being applied at CI stage, where it must never apply. The old code had `stage !== "ci"` inline; I lost it, and a millisecond unit test found it. Direct evidence for the extraction being worth it.
- A second latent bug from the same refactor: `mode` was defaulted to "strict" before reaching `resolveGatePolicy`, which would have made `posture: "advisory"` silently unreachable. Order of resolution matters — posture first, then read `mode` off it.
- `\Z` is Python, not JavaScript. In a JS regex it degrades to a literal "Z" with no error, so my correct-usage section extractor failed closed and let the inverted seed through on first attempt. Silent-degradation class, worth watching for.
- Parallel vitest forks cannot be enabled here: vitest 2.1.9 resolves worker paths through a URL and collects ZERO tests when the checkout path contains a space (".../New idea"). Recorded with a validated block sensor.
- The seed generator's failure modes are broader than inversion: the seed it proposed for the vitest lesson (`poolOptions\.forks\.singleFork\s*:\s*false`) would have been a DEAD sensor — that literal text never appears in the file. Inversion is now guarded; deadness is not, and cannot be without a bad example.

## Files touched
- `packages/core/src/gate-verdict.ts`
- `packages/core/test/gate-verdict.test.ts`
- `packages/cli/src/commands/enforce.ts`
- `packages/cli/src/commands/doctor.ts`
- `packages/core/src/config.ts`
- `packages/core/src/sensor-suggest.ts`
- `packages/cli/test/generated-artifacts.test.ts`
- `packages/cli/vitest.config.ts`

## Next steps
- A dead-sensor guard for seeds would need a bad example the generator does not have; the honest options are to mine one from the fix diff (`sensors propose --from-fix` already does this) or to leave it to `propose_sensor`.
- `doctor.ts` (1493 lines), `mcp/server.ts` (1399) and `get-briefing.ts` (1090) are the next monoliths; same treatment as enforce.ts if they start accreting conditional passes.
- Still open from the field report: §4.3 active memory decay, §4.5 receipt distinguishing bypassed / false-positive from prevented.
