---
id: 2026-09-05-gotcha-hook-stdin-timeout-holds-event-loop
scope: team
type: gotcha
status: validated
anchor:
  paths:
    - packages/cli/src/commands/observe.ts
    - packages/cli/src/commands/enforce.ts
    - packages/cli/test/hook-latency.test.ts
  symbols: []
tags:
  - hooks
  - latency
  - stdin
  - claude-code
created_at: '2026-09-05T22:53:35.231Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
## An un-cleared stdin hard-cap timer made every Claude Code hook cost ~2 s (FIXED v0.61.1)

`readStdin()` in both `observe.ts` and `enforce.ts` armed `setTimeout(finish, 2000)` as a hard cap
"so a stuck hook never blocks Claude" — and never cleared it. The payload was read and resolved in
milliseconds, but the live timer kept the event loop open, so the process could not exit for the
remaining ~2 s. Measured cost: `enforce pre-tool-use` 2.39 s, `observe` 2.38 s, against 0.41 s for
`--version` and 0.29 s of `user` time. Both hooks run on every Edit/Write/Bash: **15-20 minutes of
pure waiting per agent session**, reported independently by two field reports on 2026-09-05 (§3, §7).

**The trap in general form:** in a short-lived CLI, a pending `setTimeout` is not free even when its
callback is a no-op — Node will not exit while it is armed. Any timeout used as a *safety* cap must be
`clearTimeout`'d on the happy path **and** `unref()`'d. Both, not either: `unref` alone leaves it
armed if something else holds the loop, `clearTimeout` alone leaves the window between arm and finish.

**Do not diagnose this class of slowness by reading the command body.** The time was not in corpus
loading, memory ranking, or module resolution — the obvious suspects, all innocent. The tell was
`real 2.4 s / user 0.29 s`: nearly all wall-clock, almost no CPU. Compare against `hivelore --version`
(pure startup) first; a gap that large is waiting, not work.

`packages/cli/test/hook-latency.test.ts` spawns both hooks with a real payload and fails over 1.5 s.
Keep it: this defect is invisible per call and only shows up in aggregate, which is exactly the kind
that survives for months.
