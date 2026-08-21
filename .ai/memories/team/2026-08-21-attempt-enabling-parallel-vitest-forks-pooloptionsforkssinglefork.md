---
id: 2026-08-21-attempt-enabling-parallel-vitest-forks-pooloptionsforkssinglefork
scope: team
type: attempt
status: validated
anchor:
  paths:
    - packages/cli/vitest.config.ts
  symbols: []
sensor:
  kind: regex
  pattern: 'singleFork\s*:\s*false'
  absent: 'singleFork\s*:\s*true'
  paths:
    - packages/cli/vitest.config.ts
    - packages/mcp/vitest.config.ts
    - packages/core/vitest.config.ts
  message: >-
    singleFork:false makes vitest 2.1.9 resolve worker paths through a URL,
    which breaks on a space in the checkout path (".../New idea" → New%20idea)
    and collects ZERO tests. Keep singleFork:true; speed up feedback by moving
    pure logic into core unit tests instead.
  severity: block
  autogen: false
  last_fired: null
tags:
  - testing
  - vitest
  - tooling
created_at: '2026-08-21T03:00:32.956Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: human
---
# Enabling parallel vitest forks (poolOptions.forks.singleFork: false) in packages/cli to speed up the ~104s integration suite

**Why it failed / do NOT use:** vitest 2.1.9 resolves worker entry paths through a URL, and mis-handles a SPACE in the project path. This repo lives at ".../New idea", so with singleFork:false every run dies at startup with `executeTests ../../../New%20idea/node_modules/.pnpm/vitest@2.1.9/.../resolveConfig.js` and collects ZERO tests ("Test Files no tests", 16ms). It is not a flaky-test or shared-state problem — the runner never starts. It would break identically for any user whose checkout path contains a space, and only on their machine, which makes it a nasty thing to ship.</why_failed>
<parameter name="instead">Leave `singleFork: true` (the comment in packages/cli/vitest.config.ts now records why, so nobody re-attempts it). Attack feedback speed from the other end instead: move logic that can be decided from inputs alone out of the integration suite and into pure core unit tests. The gate's decision rule moved to `core/gate-verdict.ts` and its 18 tests run in ~30ms versus the 104s suite. If parallel forks are ever genuinely needed, the prerequisites are a vitest upgrade AND a checkout path with no spaces.</instead>
<parameter name="scope">team
