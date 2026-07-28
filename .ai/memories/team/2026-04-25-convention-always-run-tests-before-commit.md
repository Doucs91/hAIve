---
id: 2026-04-25-convention-always-run-tests-before-commit
scope: team
type: convention
status: validated
anchor:
  paths:
    - .github/workflows/ci.yml
    - package.json
    - scripts/verify-build-artifacts.mjs
  symbols: []
tags:
  - workflow
created_at: '2026-04-25T23:40:07.968Z'
expires_when: null
verified_at: '2026-07-02T22:21:21.937Z'
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: null
---
# Hivelore Release Verification Chain

Hivelore tests import freshly built workspace `dist` artifacts, so the release-quality local check is the same ordered chain as CI:

```bash
pnpm -r build
pnpm check:artifacts
pnpm -r typecheck
pnpm -r test
node packages/cli/dist/index.js eval --fail-under 80
```

If `pnpm` is not on PATH in a local shell, use the pinned package-manager fallback:

```bash
npx pnpm@9.14.2 -r build
npx pnpm@9.14.2 check:artifacts
npx pnpm@9.14.2 -r typecheck
npx pnpm@9.14.2 -r test
```

Run `build` before `typecheck` because downstream packages deliberately check fresh workspace dists with `scripts/ensure-workspace-dists.mjs`.
