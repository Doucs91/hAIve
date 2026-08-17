---
id: 2026-08-17-gotcha-init-leaves-untracked-configs-that-block-enforce-finish
scope: team
type: gotcha
status: validated
anchor:
  paths:
    - packages/cli/src/commands/init.ts
    - packages/cli/src/commands/enforce.ts
  symbols:
    - getGitSyncStatus
    - buildFinishReport
tags:
  - init
  - enforcement
  - git
  - onboarding
  - dx
created_at: '2026-08-17T14:47:21.896Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
## A fresh `hivelore init` leaves untracked files that immediately block `enforce finish`

Reproduced in a throwaway repo at v0.53.4: right after `hivelore init -y`, `git status --short` shows

```
?? .mcp.json
?? .cursor/mcp.json
?? .vscode/
```

and `enforce finish` fails with `git-sync-uncommitted-changes`. **The tool creates its own blocker on
day one** — the first thing a new user meets after init is a red gate about files init just wrote.

`getGitSyncStatus` runs `git status --short --untracked-files=all`, so untracked paths count as dirty.
That is *correct* and must stay: an agent that writes a new source file and forgets `git add` has to be
caught. The bug was never the detection — it was the wording (fixed in v0.53.5, which now says
"untracked — neither committed nor ignored" and offers `.gitignore` as the second exit).

**The underlying trap, which still applies to any repo:** a file that is untracked *and* not ignored
leaves the worktree permanently dirty, so the gate blocks on **every later task**, not just the one
that created it. `git rm --cached` alone does not finish the job — in git, "keep this local" is an
ignore rule. This repo hit it twice: `ctx-haive-poc/` (ignored) and `docs/launch/` (untracked in
dd54870, ignored only in v0.53.5).

**Open:** `init` should decide for the configs it generates — either write them into `.gitignore`
(they carry machine-specific absolute paths, so ignoring is defensible) or tell the user to commit
them. Leaving them undecided is what produces the day-one red gate.
