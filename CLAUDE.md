<!-- Hivelore bridge file — do not edit by hand. -->
<!-- This file points your AI tool at the shared Hivelore project context. -->

See `.ai/project-context.md` for the full project context.
Memories live under `.ai/memories/` (personal/team/module).

## Hivelore — mandatory rules for AI agents

Installing or initializing Hivelore in this repository means **the team expects AI agents to drive work through Hivelore**, not bypass it.

### MCP first (default — never optional unless the developer says so)
The Hivelore MCP server (registered under the key **haive** in this machine's client config — tools appear as `mcp__haive__*`) must be enabled in your client. Until it is unavailable (misconfiguration report to the developer), you **must** use it for substantive work:

- **Before** you edit project source files, configs (`package.json`, tooling), or workflows for the current goal, invoke `get_briefing` with a short **task** string (and **files** / **symbols** when you know them). If project context was already refreshed in this session and you only need ranked memories, you may call `mem_relevant_to` instead—but **still** consult Hivelore before trusting ungrounded guesses.
- **Before** declaring a coding task finished, invoke the MCP prompt `post_task` when the session produced learnings or substantive changes worth capturing.

Do **not** treat these as nice-to-have: they are **default-required** for coding agents here.

### Session rules
- **Immediately** when an approach fails (wrong API, wrong pattern, wrong assumption), call `mem_tried` — do not wait until the end of the session.

### Behavioral triggers — exact situations requiring immediate Hivelore action

These are non-negotiable. Each row is a **concrete situation** mapped to a **specific tool call** that must happen **in the same response**, not at the end of the session.

| Situation | Required action | Tool |
|-----------|----------------|------|
| CLI option or API that does not exist | Document before fixing | `mem_tried` |
| Test fails because of a wrong assumption | Document the assumption | `mem_tried` |
| Approach took >15 min and had to be redone | Document what failed | `mem_tried` |
| Choosing A over B for a non-obvious reason | Capture the rationale | `mem_save type=decision` |
| Discovering surprising library/framework behavior | Capture the trap | `mem_save type=gotcha` |
| Inventing a pattern used more than once | Capture the convention | `mem_save type=convention` |
| Completing a task >30 min or >5 files changed | Close with full recap | `mem_session_end` with `discoveries` filled |

**The `discoveries` field in `mem_session_end` is mandatory** — leave it empty only when nothing was surprising. If you cannot think of anything to put there, re-read the session mentally: every `mem_tried` call this session is a discovery candidate.

### Git sync protocol — multi-agent coordination (MANDATORY)
Several agents **and** the human (Sady) work on this repo in parallel with manual pull/push. Without a shared protocol you get merge conflicts (e.g. conflict markers left in `.ai/`) and desynced versions. See decision `2026-05-31-decision-git-sync-protocol-multi-agent`.

**BEFORE starting a task (entry):**
1. `git pull` — get the latest version from GitHub.
2. Resolve any conflicts **before** touching code.
3. Verify no conflict markers remain (`<<<<<<<`, `=======`, `>>>>>>>`), especially under `.ai/`.

**AFTER changing code (exit):**
1. `git commit` your changes.
2. **Bump the version ONLY if shippable code changed** (publishable packages: `@hivelore/core`, `cli`, `mcp`, `embeddings`). Docs-only / `.ai/`-only / config / CI commits → commit + push **without** bump or tag.
3. If bumping: **patch by default** (`0.10.1 → 0.10.2`); minor/major only if justified (feature / breaking). Keep all 4 publishable packages in lockstep.
4. If bumping: create the matching git tag `vX.Y.Z`.
5. `git push` **code and the new tag** (`git push && git push origin vX.Y.Z`). Do **not** use `git push --tags` — it tries to push every local tag and fails if an old one (e.g. `v0.4.0`) already differs on the remote; push only the tag you just created.
6. After push, verify the GitHub Actions runs for HEAD and wait until every workflow passes (`gh run list --commit $(git rev-parse HEAD)`, then `gh run watch <run-id> --exit-status` for pending runs).
7. If bumping: once CI is green, **create the GitHub Release for the tag** — `gh release create vX.Y.Z --verify-tag --latest --title "…" --notes-file <notes>`. A tag is not a Release: listing and scoring tools read Releases, and the repo went four months with 190 tags and none. Notes come from the `CHANGELOG.md` section for that version. Releases are **not** cumulative — never backfill old tags; only the current version gets one.

**BOUNDARY: agents NEVER run `npm publish`. npm publication is done by the human (Sady).** Creating the GitHub Release is *not* publication and is inside the boundary — it announces a tag that is already public.

**Before final response:** run `hivelore enforce finish`. If it blocks, fix the reported commit/version/tag/push/pipeline issue before saying the task is done.

### Safety rules — NEVER violate these
- If `get_briefing` returns an `action_required` list, **stop and show each item to the developer** before doing anything. Use the exact `developer_message` provided. Wait for explicit confirmation.
- **Never modify code autonomously** because of a breaking change detected in another project (dependency version bump, API contract change, removed field). Always ask first.
- When in doubt about a cross-repo change: ask, don't act.

<!-- haive:bridge-start -->
<!-- AUTO-GENERATED by hivelore bridges sync — do not edit between these markers -->
<!-- haive:memories-start -->
<!-- AUTO-GENERATED by hivelore bridges sync — do not edit between these markers -->
<!-- Top breadcrumbs only — call get_briefing / mem_get for deeper context. -->

- `2026-04-25-architecture-embedderlike-interface` (team/architecture) — Architecture Embedderlike Interface _(applies to: packages/embeddings/src/embedder.ts)_
- `2026-04-25-architecture-pure-tool-handlers` (team/architecture) — Architecture Pure Tool Handlers _(applies to: packages/mcp/src/tools)_
- `2026-04-25-convention-always-run-tests-before-commit` (team/convention) — Hivelore Release Verification Chain _(applies to: .github/workflows/ci.yml, package.json, scripts/verify-build-artifacts.mjs)_
- `2026-04-25-convention-use-pnpm-workspaces` (team/convention) — Hivelore Uses Pinned pnpm Workspaces _(applies to: package.json, pnpm-workspace.yaml)_
- `2026-04-25-decision-esm-only` (team/decision) — Decision Esm Only _(applies to: tsconfig.base.json)_
- `2026-04-25-gotcha-tsup-externals-required` (team/gotcha) — Gotcha Tsup Externals Required _(applies to: packages/cli/tsup.config.ts, packages/mcp/tsup.config.ts)_
- `2026-04-27-decision-zod-error-formatting-no-direct-import` (team/decision) — Decision Zod Error Formatting No Direct Import _(applies to: packages/cli/src/index.ts)_
- `2026-04-27-gotcha-embeddings-load-error-double-print` (team/gotcha) — Gotcha Embeddings Load Error Double Print _(applies to: packages/cli/src/commands/embeddings.ts)_

<!-- haive:memories-end -->

<!-- haive:sensors-start -->
<!-- AUTO-GENERATED by hivelore bridges sync — do not edit between these markers -->

## Hard rules — Hivelore block sensors

The patterns below are blocked by the repo enforcement gate.
Introducing them will fail the pre-commit check (`hivelore enforce check`).

- **2026-06-07-convention-vscode-cli-calls-through-runhaive** _(applies to: packages/vscode/src/extension.ts, packages/vscode/src/briefingPanel.ts, packages/vscode/src/observabilityProvider.ts)_: Raw child_process in the extension — call runHaive() (harnessHealth.ts) instead; only runHaive may shell out.
  - Pattern: `cp\.(exec|spawn|execFile|execSync)\s*\(`
- **2026-07-05-convention-child-process-no-shell-interpolation** _(applies to: packages/mcp/src/tools/propose-sensor.ts)_: Use execFileSync with an argument array; never interpolate untrusted values into a shell command.
  - Pattern: `execSync($CMD)`
- **2026-07-05-convention-ci-enforces-eval-regressions** _(applies to: .github/workflows/ci.yml)_: Ci Enforces Eval Regressions
- **2026-07-05-convention-root-verify-is-release-chain** _(applies to: package.json)_: Root Verify Is Release Chain
- **2026-07-05-gotcha-engram-is-a-nested-reference-repository** _(applies to: engram/)_: Do not commit Engram credentials or private keys in the nested reference checkout.
  - Pattern: `(?:ENGRAM_API_KEY\s*=|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)`
- **2026-07-05-gotcha-github-review-text-is-untrusted-data** _(applies to: packages/github-action/src/run.ts)_: Review text is untrusted: never execute comment.body or the derived instruction.
  - Pattern: `(?:exec|execSync|execFile|execFileSync)\s*\([^;\n]*(?:comment\.body|instruction)`
- **2026-07-05-gotcha-unsupported-benchmark-claims** _(applies to: benchmarks/agent-benchmark/RESULTS.md, packages/cli/src/commands/benchmark.ts)_: Do not claim a proven benchmark advantage until evidence_grade is decision-ready.
  - Pattern: `\bproves?\b.{0,80}\b(?:advantage|superiority)\b`

<!-- haive:sensors-end -->

<!-- haive:bridge-end -->
