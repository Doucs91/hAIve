---
id: 2026-04-25-convention-use-pnpm-workspaces
scope: team
type: convention
status: validated
anchor:
  paths:
    - package.json
    - pnpm-workspace.yaml
  symbols: []
tags:
  - tooling
  - monorepo
created_at: '2026-04-25T23:39:56.680Z'
expires_when: null
verified_at: '2026-07-02T22:21:21.937Z'
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: null
---
# Hivelore Uses Pinned pnpm Workspaces

This repo is pinned to `pnpm@9.14.2` in root `packageManager`; do not use npm/yarn workspace commands for local development or release checks.

Cross-package Hivelore dependencies must stay `workspace:*`. Using published semver ranges such as `^0.12.1` can make pnpm resolve stale registry packages instead of local workspace code, hiding source changes from dependent package builds.

Canonical local commands:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

Shells without global pnpm should use `npx pnpm@9.14.2 ...`; `haive doctor` reports this as `pnpm-not-on-path` so agents do not mistake the missing binary for a repo failure.
