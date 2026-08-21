<p align="center">
  <a href="https://github.com/Doucs91/hivelore">
    <img src="https://raw.githubusercontent.com/Doucs91/hivelore/main/packages/vscode/media/logo.svg" alt="Hivelore logo" width="96" />
  </a>
</p>

<h1 align="center">Hivelore</h1>

<p align="center">
  <strong>The deterministic policy gate for agent-written code — it refuses the commit that repeats a mistake your team already paid for.</strong><br/>
  <em>A repo-native context policy for coding-agent harnesses; the rules live as team memory. Formerly published as <code>hAIve</code> (<code>@hiveai/*</code>).</em>
</p>

Hivelore is the **enforcement layer** inside an AI coding-agent harness. It briefs agents with the team's non-obvious knowledge before they act, then turns each hard-won lesson into a **deterministic gate** — in MCP, Git hooks, and CI — that blocks the change about to repeat it. Same diff, same verdict, on every machine. **Memory is the substrate; the gate is the product.**

A capable model already knows generic best practice. What it *cannot* guess is your team's arbitrary, repo-specific knowledge: that public ids are `id + 100000` prefixed `AC-`, that the status field must be `"OK"`/`"KO"`, that you never edit an applied migration. Left to itself, a confident agent invents a plausible answer - clean, tested, green, and **wrong by policy**. Hivelore carries that unguessable knowledge into the task and blocks the change that's about to violate it.

> Hivelore's job is not to replace tests, linters, or observability. It makes the repo-specific knowledge those tools cannot infer available, auditable, and enforceable.

[![npm](https://img.shields.io/npm/v/@hivelore/cli?color=blue)](https://www.npmjs.com/package/@hivelore/cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![CI](https://github.com/Doucs91/hivelore/actions/workflows/ci.yml/badge.svg)](https://github.com/Doucs91/hivelore/actions/workflows/ci.yml)

<p align="center">
  <img src="docs/demo/hivelore-demo.gif" alt="A captured lesson attaches a validated guard; the commit that reintroduces the mistake is refused — same diff, same verdict on every machine" width="720" />
</p>
<p align="center"><sub><b>Capture a mistake → attach a validated guard → the commit that repeats it is refused.</b> Same diff, same verdict, on every machine and in CI. <a href="#the-60-second-proof">Reproduce it in 60 seconds ↓</a></sub></p>

---

## The problem

AI coding agents are powerful, but they often act with incomplete repo context. Compaction, parallel sessions, agent switches, and stale advisory docs all create the same failure mode: the agent changes code without carrying the team's current decisions into the work.

Most teams work around this with instructions and hope:

- *"Please read our architecture decisions first."*
- *"Don't repeat the migration mistake from last sprint."*
- *"Remember to capture what you learned."*
- *"Don't merge code that invalidates a team decision."*

Those rules are easy to skip. Hivelore turns them into **repo-native context policy**.

---

## How it works

```
AI agent ──▶ Hivelore briefing ──▶ code change ──▶ Hivelore policy gate ──▶ merge
                  ▲                                       │
                  └── context breadcrumbs · decisions · gotchas · anchors
```

1. `hivelore init` creates a `.ai/` context policy layer in your repo.
2. Agents start every session with `get_briefing` — one MCP call that returns small default context plus deeper breadcrumbs ranked by task relevance.
3. Decisions, gotchas, failed attempts, and session recaps live as Markdown files anchored to the code paths they describe. When code moves, Hivelore detects stale anchors.
4. `hivelore enforce check` and CI enforcement block unsafe states: missing briefing, stale critical decisions, an anchored anti-pattern your diff is about to repeat, or uncaptured session knowledge.

> **Memory is the substrate. Context enforcement is the product promise.**
> AI changes should not enter the codebase without consulting the team's current knowledge.

## Where Hivelore fits in the harness

Harness engineering is about the environment around the model: feedforward guidance before it acts, feedback sensors after it acts, and workflow gates that keep bad states from landing. Hivelore owns the **repo-specific context policy** part of that harness.

| Harness concern | Hivelore role |
|---|---|
| **Feedforward guidance** | `get_briefing`, module context, skills, decisions, gotchas, failed attempts |
| **Feedback and gates** | MCP ordering policy, `pre_commit_check`, Git hooks, CI enforcement, stale-anchor detection |
| **Knowledge lifecycle** | Git-native Markdown records, path/symbol anchors, confidence, retirement, linting |
| **Boundaries** | Hivelore complements unit/e2e tests, type checks, runtime traces, security scanners, and LLM evals; it does not try to replace them |

The narrow positioning is intentional: Hivelore is not a general memory database or an agent dashboard. It is the control layer that helps coding agents act with the validated, non-obvious knowledge of the team.

### Scope & boundaries — the three harnesses

Harness engineering regulates three different things about agent-written code. Hivelore deliberately
covers two of them and **treats the third as out of scope, for now.**

| Harness dimension | Question it answers | Hivelore today |
|---|---|---|
| **Maintainability** | Is the code clean? (patterns, footguns, conventions) | ✅ **Covered** — executable sensors + anti-pattern gate |
| **Architecture fitness** | Does it respect the team's structural decisions? | 🟡 **Partly** — anchored `decision`/`architecture` memories + decision-coverage gate |
| **Behaviour** | Does the code do the *functionally correct* thing? | 🟡 **Bridged** — command sensors route your own tests to lessons (see below) |

**Why no behaviour harness yet.** Verifying functional correctness needs an *oracle* — an independent
source of truth for what the code *should* do — and that oracle problem (plus the trap of an agent
grading its own work) is the least-mature part of the field. That territory belongs to your tests,
property-based checks, and LLM-evals; Hivelore does not try to replace them. What Hivelore *does* do is carry
the **unguessable intent** a behaviour test would otherwise have to encode (`status must be OK/KO`,
`public ids = id + 100000`) as feedforward context and deterministic sensors — a partial, static slice
of behaviour control, not a runtime functional oracle.

**The bridge exists (v0.33.0): command sensors.** A lesson can carry a *command* instead of a regex —
your own test or invariant script. When a diff touches the sensor's paths, the gate executes it and a
non-zero exit refuses the commit with the lesson as the message. Hivelore does not invent the oracle
(the unsolved problem); it **routes the oracle your team already owns** to the lesson it protects:

```bash
hivelore memory tried \
  --what "refund exceeded the captured amount" \
  --why-failed "prod incident #442 — refunds must clamp to capture" \
  --paths src/payments/ \
  --sensor-command "npx vitest run tests/payments/refund-invariants.spec.ts"
# → validated (the oracle must PASS on the current tree), then enforced at commit + CI
#   Saved team-scoped by default: an enforced lesson must travel to every machine and CI.
```

Rules that keep it honest: opt-in per repo (`enforcement.runCommandSensors: true` — it executes
repo-authored commands), a proposal whose oracle *fails on the presumed-correct tree* is rejected,
an oracle that is still a **pending stub** cannot arm a block sensor, and an **unrunnable** command
(not found, timeout) warns but never blocks — a broken harness must not masquerade as a failing test.
Commands run with a **scrubbed environment** (test-runner basics only — no cloud credentials or
tokens). And you can make the guarantee demonstrable: `--red-ref <pre-fix-commit>` replays the
incident in a scratch worktree and requires the oracle to FAIL there — the sensor then records
`red_proven: true`, shown in the prevention receipt. A crash is **not** a RED: if the oracle errors
before reaching its assertion on the incident state (the guarded code doesn't exist yet, an import
or syntax error, "no tests found"), the replay reports `red-unrunnable` and refuses to claim proof.
Full behaviour verification (test generation, LLM evals) remains your test suite's job.

Since v0.43.0, prove-RED is mandatory for a blocking shell/test sensor: an oracle without a
reproducible incident state remains `warn`. CI can also set `commandSensorUnrunnable: "block"` so a
missing required oracle fails as a broken harness, and `sensorWeakeningGate: "block"` so protection
cannot be silently demoted or removed.

**The on-ramp (v0.36.0): scaffold the test from the incident.** A command sensor needs a test to
route — so Hivelore generates the skeleton from the lesson. `hivelore sensors scaffold <memory-id>`
(or the `scaffold_test` MCP tool, so agents do it in-session) detects your test framework
(vitest / jest / pytest / go), writes a **pending** test carrying the incident's provenance in its
header, and prints the exact `sensors propose --kind test` line to arm it. It never arms a sensor
itself (`propose_sensor` stays the sole validated writer); the stub stays pending so the suite is
green until you write the assertion. In a **monorepo**, the framework and location come from the
package that owns the lesson's anchor paths (a lesson under `packages/api/` scaffolds into
`packages/api/tests/…`), not the repo root — and a lesson that **spans several packages** scaffolds
one pending test per owning package, all armed by a single sensor whose oracle chains their run
commands. A scaffold left pending or never armed is an open loop: `doctor` and `enforce finish`
nudge it (`post-incident-test-unarmed`) until the oracle is routed.

**Pass the incident and the stub writes itself around the fix (v0.46.0).** Add `--red-ref <pre-fix-commit>`
and the scaffold names the symbols the fix (`red_ref..HEAD`) actually touched and pre-fills the example
around them — `import { refund } …`, `expect(refund(/* incident input */)).toBe(/* post-fix expected */)`
instead of a blank `subjectUnderTest()`. It stays a **pending, commented** stub (no live import, suite
stays green) — a deterministic head-start, never an LLM guessing your assertion.

```bash
hivelore sensors scaffold 2026-07-03-attempt-refund-exceeds-capture --red-ref <pre-fix-commit>
# → tests/incidents/refund-exceeds-capture.test.ts (pending; names the touched symbols from the fix)
#   then: fill the assertion → run it → arm it with the printed propose command.
```

**Lower the cost of expressing the invariant (v0.48.0): `--style`.** The behaviour harness leaves the
*oracle* to you — so the scaffold offers the two deterministic ways to make that cheaper (no LLM
guessing your assertion):

- `--style property` — a [fast-check](https://github.com/dubzzz/fast-check) / Hypothesis skeleton:
  state the invariant **once** (`refund(a, b) ≤ b`) and it is checked over many generated inputs.
- `--style differential --reference <impl>` — state **no** invariant at all: assert the subject
  *agrees* with a reference implementation (a legacy version, a second impl) for all generated inputs.

```bash
hivelore sensors scaffold <lesson> --red-ref <pre-fix-commit> --style property
hivelore sensors scaffold <lesson> --style differential --reference ../legacy/refund
```

Both stay pending, commented stubs (the suite stays green) and arm through the same validated
prove-RED path once you fill them in.

**Measure the behaviour harness (v0.45.0).** `hivelore doctor` reports, per main code area, how much of
the behaviour surface is guarded: `Behaviour harness: X/N area(s) guarded by a behavioural oracle
(K armed, P red-proven)` — so the branch's progress is visible, not guesswork. The human `stats receipt`
prints the same line as a footer. Since **v0.47.0** the finding closes the loop to action: for each
uncovered area it prints the exact `hivelore sensors scaffold <lesson> --red-ref <pre-fix-commit>`
command in its Suggested commands (or a `memory tried … then scaffold` line when no lesson exists yet).

> See [`STABILITY.md`](./STABILITY.md) for the frozen 1.0 surface and [`CONTRIBUTING.md`](./CONTRIBUTING.md) to extend Hivelore.

### Executable memory sensors

Some `gotcha` and `attempt` memories can now carry a `sensor` block: a deterministic guardrail that
scans the diff. Three shapes, one validation doctrine (silent on correct code, fires on the mistake):

- **regex** — matched on added lines; the simple, dependency-free default.
- **ast** — an [ast-grep](https://ast-grep.github.io) *structural* pattern
  (`stripe.paymentIntents.create($$$)` with `absent: idempotencyKey`): comments and string literals
  can never false-positive, and "X without Y" is expressed on the call itself. Needs the optional
  `@ast-grep/napi` engine — without it the sensor is unrunnable (warn, never block).
- **shell/test** — a command routing your own test as the oracle (the behaviour bridge, below).

Sensors turn a documented lesson into a repeatable feedback signal, independent of embeddings or
model judgment. Autogenerated sensors start as `warn`; humans promote vetted ones to `block`. The
doctrine is also enforced against *inversion*: a `block` pattern that matches the lesson's own
recommended fix (its `Instead, use:` snippet) is refused (`fires-on-correct`) — it would block the
correct code and never the mistake.

```bash
hivelore sensors list
hivelore sensors check                          # scans git diff --cached
hivelore sensors propose <lesson> --from-fix <pre-fix-ref>   # MINE the pattern from the fix diff
hivelore sensors promote <id> --yes             # promote a vetted sensor to block
hivelore sensors export --format grep
```

**Cheaper arming (`--from-fix`).** Authoring a discriminating regex is the main cost between a
documented lesson and an enforced one — so let the fix write it. `sensors propose --from-fix
<pre-fix-ref>` mines the pattern from the fix diff: the line the fix **removed** is the mistake
(`pattern`), the line it **added** is the correct marker (`absent`). You confirm a candidate instead of
authoring a regex — and it still passes the full validation (silent-on-current, fires-on-bad,
not-inverted) before it can block.

---

## Install

```bash
npm install -g @hivelore/cli
# Optional: local semantic search (downloads ~110MB model once)
npm install -g @hivelore/embeddings
```

---

<a id="the-60-second-proof"></a>
## The 60-second proof — watch a lesson stop a commit

> This is the exact flow shown in the demo above.

Memory tools remember; Hivelore's difference is that a remembered lesson can **refuse the commit
that repeats it**. Try it on any git repo:

```bash
hivelore init -y                     # .ai/ layer + git hooks + bridges for the agents you actually use (detected)

# 1. Capture a failed approach (agents do this via the mem_tried MCP tool)
hivelore memory tried \
  --what "importing moment.js" \
  --why-failed "bundle bloat — team standard is date-fns" \
  --instead "date-fns" --paths src/
#    → prints the new memory id, e.g. 2026-07-02-attempt-importing-momentjs

# 2. Give the lesson teeth: a validated, deterministic guardrail
hivelore sensors propose 2026-07-02-attempt-importing-momentjs \
  --pattern "from ['\"]moment['\"]" --severity block
#    Hivelore validates it first: silent on your current code, fires on the mistake.

# 3. Reintroduce the mistake — the commit is refused
echo "import moment from 'moment';" >> src/dates.ts
git add . && git commit -m "add date helper"
#    🛡️  A documented lesson refused this commit — about the change you just made:
#        • 2026-07-02-attempt-importing-momentjs (src/dates.ts)  use date-fns
#          import moment from 'moment';
```

Same diff, same answer, on every machine and in CI — the gate is deterministic by design.
Everything lives as reviewable Markdown in `.ai/`, versioned with your code. `rm -rf .ai` undoes it all.

---

## Quick start

### 1. Initialize your project

```bash
cd my-project
hivelore init          # Creates .ai/, bridge files, MCP config, hooks, CI template
```

`hivelore init` now also runs agent setup. It writes project-level MCP configs, records the best available mode, and asks before changing user-level client configs. In non-interactive shells it skips global config and tells you how to finish setup.

### 2. Connect your AI client

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "hivelore": {
      "command": "hivelore",
      "args": ["mcp", "--stdio", "--root", "/absolute/path/to/my-project"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "hivelore": {
      "command": "hivelore",
      "args": ["mcp", "--stdio", "--root", "/absolute/path/to/my-project"]
    }
  }
}
```

**VS Code**:
```bash
code --add-mcp '{"name":"hivelore","command":"hivelore","args":["mcp","--stdio","--root","/path/to/project"]}'
```

### 3. Bootstrap your project context

In your AI client, invoke the `bootstrap_project` MCP prompt. The agent analyzes your codebase and writes `.ai/project-context.md` automatically.

### 4. Start work through Hivelore

Every session starts with one call:

```
get_briefing(task: "add a Stripe payment integration", files: ["src/payments/PaymentService.ts"])
```

The agent gets project context + relevant module contexts + ranked context breadcrumbs in one shot — no more grepping to rediscover what the team already knows.

For CLI agents without native MCP, wrap them:

```bash
hivelore run -- claude --dangerously-skip-permissions -p "$(cat task.md)"
```

Check the selected mode any time:

```bash
hivelore agent status
hivelore agent setup          # re-run setup later
hivelore agent setup --yes    # approve user-level MCP config without prompting
```

### 5. Gate commits and pull requests

```bash
hivelore enforce install       # Installs Git hooks + CI enforcement template
hivelore enforce status        # Current enforcement posture
hivelore enforce check         # Pre-commit policy gate
hivelore enforce ci            # CI entrypoint (exits 1 on violations)
```

**One knob decides what refuses: `enforcement.posture`.**

| posture | what refuses |
|---|---|
| `advisory` | nothing — everything is reported. For adopting Hivelore on a repo mid-flight |
| **`balanced`** (default) | deterministic, code-bound findings only: block sensors, anchored anti-patterns, stale anchors on files you touched, artifact hygiene |
| `strict` | the above, **plus** the process gates (briefing, recap, decision coverage, bootstrap) at the sharing points — `pre-push` and CI |

`mode`, `processGate` and `humanCommits` are the individual switches a posture sets; pin one
explicitly to override the posture for that switch alone. `hivelore doctor` always prints the
effective posture and any overrides, so what the gate will do is never a guess.

One rule is not a posture knob and is not negotiable: **process gates never refuse a local commit**,
at any posture. Blocking them on every pre-commit is what trains the `--no-verify` reflex on cold
repos. A passing commit-time gate prints one line; `--verbose` shows every check. If a git hook was
left broken by an old install, `hivelore doctor --fix` regenerates it.

**When something does refuse, it names the line.**

```
🛡️  A documented lesson refused this commit — about the change you just made:
    • 2026-07-02-attempt-importing-momentjs (src/dates.ts)  use date-fns, not moment
      import moment from 'moment';
```

One lesson, one line, with the file and the offending source. No composite score: the repo's
`knowledge-layer health` percentage is a measurement of your baseline, reported but never a verdict
on your change.

---

## CLI at a glance — the golden path

`hivelore --help` shows only the commands you use day to day. Everything else (review, import,
diagnostics, benchmarks) is one `hivelore --advanced --help` away — the focused surface is deliberate,
not a missing feature.

> **Exhaustive command manual:** [`packages/cli/README.md`](./packages/cli/README.md) documents every
> command with its flags and examples. It is the reference; this page is the concepts. Each claim
> lives in exactly one of the two.

| Stage | Command | What it does |
|---|---|---|
| **Set up** | `hivelore init` | Create `.ai/`, bridge files, MCP config, hooks, CI |
| | `hivelore doctor` | Check the install is healthy |
| | `hivelore agent setup` | Wire your AI client (MCP, hooks) |
| **Before editing** | `hivelore briefing` | Feedforward context — the CLI mirror of `get_briefing` |
| **Capture knowledge** | `hivelore memory save` | Record a decision / convention / gotcha |
| | `hivelore memory tried` | Record a failed approach so it isn't repeated |
| | *(passive)* | Session failures observed by the hooks are **auto-distilled into `proposed` drafts** at session end — review with `memory list --status proposed`; they never self-validate and never carry sensors |
| **Retrieve** | `hivelore memory search` · `get` | Find, then read a record |
| **Feedback** | `hivelore sensors check` | Scan the diff against documented lessons |
| **Gate** | `hivelore enforce finish` | Exit gate before you call the task done |
| **Sync** | `hivelore sync` | Re-check stale anchors, refresh bridge files |
| **Close** | `hivelore session end` | Save a recap for the next session |

**One vocabulary across CLI and MCP.** The memory verbs mirror the MCP tool names, so an agent learns
them once: `hivelore memory save/search/get/delete` ↔ `mem_save`/`mem_search`/`mem_get`/`mem_delete`
(the older `add`/`query`/`show`/`rm` still work as aliases).

---

## Try it on your repo (5 minutes, reversible)

Want to evaluate Hivelore on a real codebase that isn't a toy? It is non-destructive — everything it
writes lives under `.ai/` plus a few bridge files, all removable.

```bash
cd your-project
npm install -g @hivelore/cli
hivelore init -y            # seeds stack packs + git-history scars; writes .ai/ and bridges
hivelore briefing --task "the change you're about to make" --files path/to/file
hivelore doctor             # health + coverage report
hivelore sensors check      # scan your staged diff against documented lessons
hivelore eval --fail-under 50   # retrieval + sensor quality on your own corpus
```

To remove everything Hivelore added: `rm -rf .ai CLAUDE.md AGENTS.md GEMINI.md .cursorrules .clinerules
.continuerules .windsurfrules .rules CONVENTIONS.md .github/copilot-instructions.md` and drop the
`.github/workflows/hivelore-*.yml` files. Feedback from a repo that isn't ours is the most valuable thing
you can send — please [open an issue](https://github.com/Doucs91/hivelore/issues) with what worked and what didn't.

## What Hivelore enforces

| Gate | What it checks |
|---|---|
| **First-agent bootstrap** | On a **cold corpus**, the first agent is asked to fill the knowledge layer: a filled project-context, a module context per component, an anchored memory per main code area, and a **sensor per main code area**. The trigger is corpus state — once the baseline exists the gate is silent for every later agent. Reports by default; refuses at `posture: "strict"` |
| **Briefing loaded** | Agent loaded fresh context breadcrumbs before editing. Reports by default |
| **Decision coverage** | Changed files are covered by relevant anchored decisions in the last briefing. Reports by default |
| **Anti-pattern matching** | Anti-patterns relevant to the diff are surfaced at the gate; a **validated block sensor** that fires on the added lines **blocks** the commit. Hardness is tunable via `enforcement.antiPatternGate` (`off` · `review` · `anchored` (default) · `strict`) |
| **Gate-surface integrity** | A diff that **weakens a sensor** (block→warn demotion, changed/removed oracle, broadened suppression, deleted block-sensor memory) is surfaced for review (`sensor-weakened`) — the gate lives in `.ai/`, so weakening it must never sail through unmentioned |
| **Stale anchors** | Memories anchored to deleted/moved paths **block** — but only when the anchor is on a file this change touches. Stale anchors elsewhere are corpus maintenance, reported as a warning |
| **Session recap** | Agent captured what changed and what remains before closing. Reports by default |
| **CI enforcement** | Required check blocks merge on any gate failure |

> **What "block" means here.** The gate spends its refusals only where it has deterministic,
> code-bound evidence: a **validated sensor** firing on the added lines, an anchored anti-pattern, a
> stale anchor on a file you touched — same diff, same answer, on every machine and in CI. Anchor,
> literal-token, and semantic matches (however strong) are **surfaced for review**, never blocked:
> relevance signals vary across environments and co-occurrence is not reintroduction.
> `propose_sensor` is the path from a captured lesson to a blocking guardrail.
>
> **The process gates report; they do not refuse.** Since v0.55.0, "you did not load a briefing" and
> "you did not write a session recap" are requests, not verdicts on your diff. The reason is
> empirical: a field report had two pushes refused carrying tested code with a green quality gate
> and zero violations — every penalty was a process one, none was about the code. The next thing a
> developer learns is `--no-verify`, which costs them the **whole** gate, sensors included, and a
> gate that gets bypassed protects nothing. Set `enforcement.posture: "strict"` if you want the
> workflow enforced too.

---

## Cold start — value in session one

`hivelore init` can seed from signals the repo already has, and every seed passes a **quality floor**
so cold-start never ships generic, guessable advice.

**Stack packs are opt-in since v0.55.0** (`--stack auto`). Seeding them by default filled a new corpus
with advice nobody wrote for the repo, and the first briefing of a real session read
`thin · must_read=0 useful=0 background=3` — all three being stack-pack platitudes occupying the
briefing without teaching anything. An empty corpus is more honest: it says plainly that it needs
filling. Git-history seeding stays on in autopilot, because a revert in *your* history is *your* scar.

| Source | What it seeds | Quality gate |
|---|---|---|
| **Stack packs** (`--stack auto`, opt-in) | Detected-framework traps (Next/Nest/Prisma/Flask/Rails/Tailwind/Docker… 20+ packs), with **block sensors** where high-signal | specificity floor — generic advice is dropped, audited in CI |
| **Git history** (`--seed`, on by default) | Draft memories from revert/hotfix/workaround commits — your repo's real scars | noise-subject denylist (merge/bump/deps/wip/format dropped) |
| **Scanner findings** (`hivelore ingest`) | SonarQube / SARIF / ESLint / `npm audit` findings as proposed, anchored memories with sensors | auto-fixable **stylistic** rules dropped (incl. Sonar numeric keys); `--include-stylistic` to keep |

```bash
hivelore init                                   # Initialize + seed from git history
hivelore init --stack auto                      # ...and add starter packs for the detected stack
hivelore ingest --from sonar issues.json --min-severity major
hivelore ingest --from eslint report.json
hivelore ingest --from sarif report.sarif --dry-run   # Preview without writing
```

Ingested and git-seeded memories land as `proposed` (warn-only sensors). Review them with
`hivelore memory list --status proposed`; promote vetted sensors to `block` with `hivelore sensors promote`.

---

## .ai/ directory layout

```
your-project/
├── .ai/
│   ├── project-context.md          # Shared project overview
│   ├── modules/                    # Per-component context files
│   │   ├── backend/context.md
│   │   └── frontend/context.md
│   ├── memories/
│   │   ├── personal/               # Private — gitignored
│   │   ├── team/                   # Shared — committed to git
│   │   └── module/<name>/          # Module-scoped memories
│   ├── code-map.json               # Symbol index — deterministic, safe to commit
│   ├── .runtime/                   # Local session state — gitignored
│   └── .cache/                     # Indexes, churn, telemetry — gitignored
├── CLAUDE.md                       # Auto-generated bridge (Claude Code)
├── AGENTS.md / GEMINI.md / …       # …and 10 more native bridges (see below)
└── .github/
    ├── copilot-instructions.md     # Auto-generated bridge for Copilot
    └── workflows/
        ├── hivelore-sync.yml       # Anchor verification on merge
        └── hivelore-enforcement.yml # Required policy gate
```

### Native bridges — meet every agent where it is

For CLI/IDE agents without MCP, `hivelore init` generates native config files from the **same** corpus, so
the team's memories and **block sensors** travel to whatever agent a developer uses — not just an empty
template, the enforcement edge too. `hivelore sync` keeps them fresh; never hand-edit them (regenerate with
`hivelore bridges sync`).

| Agent | File | Agent | File |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | Cline | `.clinerules` |
| Cursor | `.cursor/rules/haive-memories.mdc` | Windsurf | `.windsurfrules` |
| Codex / generic | `AGENTS.md` | Continue | `.continuerules` |
| GitHub Copilot | `.github/copilot-instructions.md` | Cody | `.sourcegraph/cody-rules.md` |
| Gemini CLI | `GEMINI.md` | Zed | `.rules` |
| Aider | `CONVENTIONS.md` | Roo | `.roo/rules/haive.md` |

```bash
hivelore bridges list                 # Show target status
hivelore bridges sync --all           # Regenerate every native bridge
hivelore init --bridge-targets cursor,copilot   # Or scope to specific agents
```

---

## Context policy records

| Type | Description |
|---|---|
| `decision` | Architectural or design choices the team has locked in |
| `gotcha` | Non-obvious constraints, known footguns, subtle invariants |
| `convention` | Naming, patterns, style rules specific to this codebase |
| `attempt` | Failed approaches — so agents don't repeat them |
| `architecture` | Component boundaries, interfaces, data flow |

All records can be anchored to file paths and symbol names. When anchored code changes, Hivelore flags the record as potentially stale.

---

## MCP tools reference

| Tool | Description |
|---|---|
| `get_briefing` | ⭐ Project context + decisions + gotchas + ranked breadcrumbs in one call |
| `mem_save` | Save repo policy knowledge (decision, gotcha, convention, attempt, architecture) |
| `mem_tried` | Record a failed approach so future agents do not repeat it |
| `mem_search` | Full-text or semantic search across context records |
| `mem_relevant_to` | Ranked context records for a task when project context is already loaded |
| `mem_get` | Fetch one context record after a compact briefing/search result |
| `mem_update` | Amend an existing record in place — add the anchor paths a lesson was missing |
| `propose_sensor` | ⭐ Turn a captured lesson into a **validated** guardrail. You write the pattern; Hivelore proves it is silent on your current code and fires on the mistake before it is trusted to block |
| `report_friction` | Record friction with Hivelore itself, locally. Never sends anything — a human reviews with `hivelore report` and decides what becomes an issue |
| `code_map` | Look up symbols without manual grep when code-map is indexed |
| `code_search` | Semantic search over exported symbols (needs `@hivelore/embeddings` + `hivelore index code-search`) |
| `mem_verify` | Check anchor freshness, detect stale records |
| `scaffold_test` | Generate a pending post-incident test from a lesson + the `sensors propose --kind test` line to arm it (monorepo-aware) |
| `pre_commit_check` | Diff against known gotchas, decisions, and stale anchors |
| `mem_session_end` | Save end-of-session recap for the next agent |

MCP profiles keep the product focused:

- `HAIVE_TOOL_PROFILE=enforcement` (default): compact coding-agent harness.
- `HAIVE_TOOL_PROFILE=maintenance`: corpus review, lifecycle, distillation, code-search, and project-context maintenance.
- `HAIVE_TOOL_PROFILE=experimental` / `full`: legacy aliases for `maintenance` (the experimental
  diagnostics were removed in v0.32.0 — months of usage showed a single call across all of them).

---

## MCP prompts reference

| Prompt | Description |
|---|---|
| `post_task` | ⭐ Post-task checklist — capture learnings before closing every session |
| `bootstrap_repo` | ⭐ First-agent bootstrap — fills the whole knowledge layer the bootstrap gate requires (project-context, module contexts, anchored memories, a validated sensor per main area). Tailors a concrete checklist from the current corpus state and drives `bootstrap_project_save` → `mem_save` → `propose_sensor` until ready |
| `bootstrap_project` | Analyze the codebase and write `.ai/project-context.md` |

---

## Packages

| Package | Install | Description |
|---|---|---|
| [`@hivelore/cli`](./packages/cli) | `npm i -g @hivelore/cli` | Main product: init, enforce, run agents, briefing, memory, sync, CI/Git hooks |
| [`@hivelore/mcp`](./packages/mcp) | bundled into `@hivelore/cli` | Policy-aware MCP server |
| [`@hivelore/core`](./packages/core) | dependency | Types, schema, anchors, policy primitives, token budgets |
| [`@hivelore/embeddings`](./packages/embeddings) | `npm i -g @hivelore/embeddings` | Optional: local semantic ranking (bge-small-en-v1.5, fully offline) |

**Also in this repo:** a [VS Code extension](./packages/vscode) (surfaces memories inline + a Strategic
Cockpit over the CLI's observability) and a [GitHub Action](./packages/github-action) (posts relevant
team memories as a PR comment so reviewers and agents never miss a non-obvious constraint).

**The PR loop.** Review feedback is team truth in the making: reply **`/hivelore remember <rule>`**
on any review thread and the Action acknowledges it with the exact persist command; or run
`hivelore ingest --from github-pr <number>` to turn a PR's human review instructions
("never…", "always…", "prefer X instead") into `proposed`, file-anchored memories — each one a
candidate for `sensors propose`, which is the step no inferential review bot can take.
With `persist-review-learnings` enabled (default), the Action creates a dedicated branch and PR
containing the proposed memory; when repository write permission is unavailable, it falls back to
the local ingest command. Top-level PR comments and review-thread replies follow the same path.

**Structural sensors.** `sensors propose --kind ast` accepts either a concise `--pattern` or a full
ast-grep `--rule <json>` (`inside`/`has`/`not`/`all`/`any`). JavaScript/TypeScript are built in;
Python, Go, Rust, and Java are optional language packages shipped with the CLI. Rules still pass
Hivelore's silent-on-current/fires-on-bad validation before they can block.
Nested relational rules are not recursive by default: add `"stopBy":"end"` when `has` or `inside`
must search every descendant, for example `{"has":{"kind":"interpolation","stopBy":"end"}}`.

---

## Adaptive briefing

A briefing only earns its place when it carries unguessable knowledge, so `get_briefing` returns
`briefing_value: "high" | "low"`. When nothing team-specific matches the files/task, the auto-generated
project context is trimmed to a one-line note (config: `adaptiveBriefing`, default on) — so Hivelore
surfaces deeper context only when it actually knows something the model doesn't.

### Anchors are weighted by how much they actually discriminate

An anchor match is the strongest ranking signal there is — when the anchor is specific. On a file
every commit touches it is almost none. Measured on this repo: **`package.json` is touched by 106 of
149 commits**, so every lesson anchored to it declared itself `must_read` on every release commit.
The median commit had **34 memories claiming the top rank for 8 slots**, and which 8 surfaced was
arbitrary.

Since v0.57.0 a match is weighted by how rare the matched path is — plain IDF, applied to anchors.
An anchor touched by more than 35% of recent commits needs corroboration (a strong semantic hit or a
symbol match) before it outranks everything, and specificity breaks ties within a tier. Measured
over 25 real commits, briefing slots spent on a low-information anchor fell from **17% to 4%**.

Churn is one cached `git log`, invalidated by HEAD. Too small a sample — a shallow clone, a young
repo — is reported as *unknown* and ranks exactly as before, never as "everything is common".

`hivelore doctor` reports `memory-broad-anchors`, naming the memories that claim nearly every change
and the share of commits each anchor covers. The fix is always additive: give the lesson the precise
path it is really about.

---

## CLI reference

```bash
# Setup
hivelore init [--with-ci] [--no-bridges]         # Initialize .ai/ + bridge files + seed from git history
hivelore init --stack auto                       # Opt in to generic starter packs for the detected stack
hivelore init --bridge-targets <all|csv>         # Scope generated bridges to specific agents
hivelore enforce install                         # Install Git hooks + CI enforcement
hivelore enforce status                          # Enforcement posture report
hivelore bridges list/sync [--all]               # Inspect / regenerate native agent bridges
hivelore index code                              # Build .ai/code-map.json
hivelore index code --status [--json]            # Report code-map / code-search index freshness

# Daily use
hivelore briefing [--task <text>] [--files] [--json]   # Print context + relevant memories
hivelore run -- <agent command>                  # Wrap any CLI agent in Hivelore session
hivelore enforce check [--stage pre-commit]      # Policy gate
hivelore enforce ci                              # CI entrypoint
hivelore enforce finish                          # Final agent-exit gate: commit/push + version/tag protocol
hivelore coverage [--source git|agent|both]      # Find changed files no memory covers
hivelore sync [--since <ref>] [--embed]          # Verify anchors + auto-promote
hivelore sensors list/check/export/promote       # Operate executable memory sensors
hivelore sensors propose <id> --pattern <re>     # Turn a lesson into a VALIDATED guardrail
hivelore report list|submit|dismiss              # Friction agents hit with Hivelore itself

# Memory
hivelore memory save --type <type> --body "<text>" [--paths <csv>]  # Save a memory (anchor to files)
hivelore memory list [--scope] [--status]        # List memories
hivelore memory search <text>                    # Full-text / semantic search
hivelore memory get <id>                         # Read one record
hivelore memory approve [<id>|--all]             # Mark as validated
hivelore memory promote <id>                     # personal → team
hivelore memory tried [--sensor-pattern <re>]    # Record a failed approach (one-shot guardrail)
hivelore memory conflicts [<a> <b>] [--yes]      # List conflict candidates / resolve one pair
hivelore memory verify [--update] [--json]       # Check anchor freshness
hivelore memory import --from <file> [--changelog]  # Import docs or a CHANGELOG as memories
hivelore memory seed [stack|--git]               # Re-seed stack packs / git-history scars

# Cold start (seed from existing signals)
hivelore ingest --from sonar|sarif|eslint|npm-audit <file>  # Scanner findings → anchored memories
hivelore ingest --from <fmt> <file> --dry-run    # Preview without writing

# Indexes (symbol map + semantic search)
hivelore index code [--status]                   # Build .ai/code-map.json / report freshness
hivelore index memories                          # Build the semantic index (first run: ~110MB model)
hivelore index query <text>                      # Semantic search over memories

# Release protocol
hivelore release bump <patch|minor|major>        # Lockstep version bump + CHANGELOG scaffold
hivelore release tag                             # Tag vX.Y.Z at HEAD, push branch + tag
hivelore release ship                            # After the bump commit: pull --rebase → tag+push → poll CI

# Diagnostics
hivelore doctor                                  # Analyze setup, emit recommendations
hivelore eval --fail-under 80                    # Retrieval + sensor quality gate
hivelore eval --semantic-ranking                 # Real embeddings lane (requires index)
hivelore selftest                                # Self-test MCP tools (latency + payloads)
```

`hivelore eval` auto-synthesizes retrieval cases from anchored memories and, when present, also loads
`.ai/eval/spec.json` for labeled retrieval/sensor cases. This repo uses that file to keep executable
memory sensors in CI, so a broken guardrail is caught before release.
Committed regression baselines use only versioned team/module memories and deterministic
anchor/lexical ranking; local usage counters, personal memories, and optional embedding caches cannot
make a baseline pass locally but fail in a clean CI clone. Semantic search remains exercised by the
embeddings/search test suites and by a separate `--semantic-ranking` CI lane backed by
`.ai/eval/semantic-baseline.json`. That lane fails closed when the package or index is unavailable.

`hivelore doctor` reports local setup drift that can make agents misdiagnose the repo: missing `pnpm`,
stale workspace `dist` artifacts, global CLI/MCP version skew, outdated code-search indexes, and low
memory-anchor coverage.

---

## Multi-component projects

For projects with multiple components (frontend/backend/microservices), create one module context per component. `get_briefing` auto-loads the relevant module context based on the files being edited.

```bash
mkdir -p .ai/modules/backend .ai/modules/frontend

cat > .ai/modules/backend/context.md << 'EOF'
# Module: backend
- Spring Boot, Java 17, PostgreSQL
- Always filter by tenantId in every repository query
- Never modify existing Flyway migrations — create V{N+1}__desc.sql
EOF

cat > .ai/modules/frontend/context.md << 'EOF'
# Module: frontend
- React 19, TypeScript, TanStack Query v5
- All API calls go through hooks in features/<domain>/api/
- Env vars must start with VITE_ to be exposed to the client
EOF
```

---

## Development

```bash
git clone https://github.com/Doucs91/hivelore.git
cd Hivelore
pnpm install
pnpm -r build    # Build all packages
pnpm -r test     # Run tests
```

Requires Node 20 LTS+, pnpm 9+.

---

## Contributing

Issues and PRs are welcome. Please open an issue before starting significant work so we can align on direction.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
