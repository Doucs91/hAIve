---
id: 2026-08-24-decision-release-gap-checks-only-after-adoption
scope: team
type: decision
status: validated
anchor:
  paths:
    - packages/core/src/github-release.ts
    - packages/core/src/npm-publication.ts
    - packages/cli/src/commands/enforce.ts
    - CLAUDE.md
  symbols:
    - classifyGithubRelease
    - verifyGithubRelease
    - publishedReleaseVersions
    - compareVersions
tags:
  - release
  - enforcement
  - gate
  - github
  - npm
created_at: '2026-08-24T04:15:26.622Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
topic: github-release-check-pre-adoption-rule
revision_count: 0
requires_human_approval: false
validated_by: auto
---
# A release-chain check only reports gaps that opened AFTER the practice was adopted

`enforce finish` checks that tagged versions became GitHub Releases (`core/github-release.ts`,
v0.57.4). The rule that makes it usable is **not** "every tag should have a Release".

## Why the naive rule is wrong

This repo had **190 version tags and 0 GitHub Releases**. "Every tag needs a Release" would have
emitted 189 findings on the first run, and **no action could ever clear them** — backfilling is not
possible in any meaningful sense (`POST /repos/{owner}/{repo}/releases` has **no `published_at`
field**, so 190 backfilled Releases would all be stamped with today's date: a manufactured spike,
strictly worse than the honest absence).

A warning that no action can clear is a warning people learn to scroll past. That degrades the whole
report, not just that line.

## The rule

Only tags **strictly newer than the oldest existing Release** count as gaps.

- 0 Releases + N tags → **one** `info` line (`github-releases-absent`) pointing at the current
  version only. Explicitly says older tags stay as they are.
- Oldest Release = v0.57.3 → the 186 tags below it are **pre-adoption**, permanently silent.
- v0.58.0 and v0.58.1 tagged, neither released, HEAD at v0.58.2 → `warn github-releases-skipped`.

Adopting the practice mid-history cleans the past, and is not asked to.

## Severities mirror the npm check, for the same reason

`finish` runs **before** the Release is cut, so "HEAD has no Release yet" can only be `info` — see
[[2026-08-21-...]] npm-publication reasoning: a gate that cannot pass in the normal flow is a gate
people switch off. Nothing here is ever `error`; releasing is the human's call.

Other invariants: drafts do not count as published (invisible to everyone but the maintainer); a
long gap is capped at 5 listed versions plus a count so it cannot flood the report; `gh` absent /
no network / non-GitHub remote all resolve to `info github-release-unverified`, never a failure.
Off with `enforcement.githubReleaseCheck: "off"`.

## Applies to any new release-chain check

npm (0.57.3) and GitHub Releases (0.57.4) both follow this shape: pure classifier in `core`, the
lookup in the CLI, never blocking, and a defect is only reported when the repo **already
demonstrated the intent** (it tagged; it released before). Follow it for whatever closes the chain
next.

## Proof the check was needed, observed the same day

The `release` workflow run for v0.57.4 reported **success** with the step
`Build, test, and publish all packages: skipped` — it skips rather than fails when `NPM_TOKEN` is
absent. Green CI on an unpublished release is indistinguishable from a shipped one. That is the
exact hole both checks exist to cover.

## Also: one version comparator

Three byte-identical copies existed (two in core, one in `enforce.ts`) because each release check
wrote its own. Extracted to `core/version-order.ts`. **Import `compareVersions` — do not write a
fourth.** Two gates reading the same tags must not be able to disagree about which one is newer.
