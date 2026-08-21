<p align="center">
  <a href="https://github.com/Doucs91/hivelore">
    <img src="https://raw.githubusercontent.com/Doucs91/hivelore/main/packages/vscode/media/wordmark.svg" alt="Hivelore" width="240" />
  </a>
</p>

# @hivelore/cli

> **The deterministic policy gate for agent-written code** — it refuses the commit that repeats a mistake your team already paid for.

Hivelore is the **enforcement layer** inside an AI coding-agent harness. A failed approach or gotcha captured via MCP (`mem_tried`) becomes a **validated guard** — a regex, an [ast-grep](https://ast-grep.github.io) structural pattern, or a command/test oracle routing your own test — trusted to block only after it is proven silent on the correct code and firing on the mistake. Git hooks and a CI entrypoint then refuse any diff that reintroduces the documented mistake — **same diff, same verdict, on every machine**. The knowledge lives as repo-native Markdown in `.ai/`, versioned with your code and briefed to any agent over MCP; it complements tests, linters, and evals rather than replacing them.

<p align="center">
  <img src="https://raw.githubusercontent.com/Doucs91/hivelore/main/docs/demo/hivelore-demo.gif" alt="A captured lesson attaches a validated guard; the commit that reintroduces the mistake is refused — same diff, same verdict on every machine" width="720" />
</p>

---

## Install

```bash
npm install -g @hivelore/cli
```

This installs the `hivelore` command globally. **The MCP server is bundled** — use `hivelore mcp --stdio` in your AI client (no separate `@hivelore/mcp` install required for normal use).

> **Semantic search** (optional): install `@hivelore/embeddings` for local embedding-based search (no data leaves your machine).

> Repos installed before the `haive`→`hivelore` rename are migrated automatically on the next `hivelore init` / `hivelore enforce install`; if an old git hook still calls the removed `haive` binary, `hivelore doctor --fix` regenerates it.

---

## Quick start

```bash
# 1. Initialize Hivelore in your project (strict enforcement ON by default)
cd my-project
hivelore init                          # .ai/, MCP config, hooks, CI, code-map
hivelore agent status                  # confirm MCP/wrapper/fallback mode
hivelore enforce install               # re-apply strict MCP + Git + CI enforcement gates

# 2. Point your AI client at the MCP server
# Add to ~/.claude.json / ~/.cursor/mcp.json:
# { "mcpServers": { "hivelore": { "command": "hivelore", "args": ["mcp", "--stdio", "--root", "/absolute/path"] } } }

# 3. Bootstrap project context (run once in your AI client)
# → Use the bootstrap_project MCP prompt to analyze the codebase and fill .ai/project-context.md

# 4. Start work through Hivelore
hivelore briefing --task "add Stripe webhook"
hivelore run -- <agent-command> [args...]      # for CLI agents without blocking hooks

# 5. Save durable policy knowledge manually (or let the agent use mem_save/mem_tried)
hivelore memory save \
  --type gotcha --slug "jpa-open-in-view" --scope team \
  --paths src/main/resources/application.properties \
  --body "spring.jpa.open-in-view=false is intentional — do not re-enable."

# 6. Gate the workflow
hivelore enforce status
hivelore enforce check --stage pre-commit
hivelore enforce ci
```

---

## Commands

The default help is intentionally small and centered on the core harness workflow. Run:

```bash
hivelore --help
hivelore memory --help
```

to see the focused surface. Maintenance and experimental commands remain available, but are hidden from default help:

```bash
hivelore --advanced --help
hivelore --advanced memory --help
```

This keeps Hivelore from feeling like a grab bag: day-to-day users see the core harness loop first - context loading, enforcement, diagnostics, sync, recaps, and the high-signal memory operations.

### `hivelore init`

Initialize the `.ai/` structure in a project. **Autopilot mode is ON by default** and installs the git hooks and CI gate.

What the gate refuses is set by `enforcement.posture` — **`balanced`** by default: deterministic,
code-bound findings only (a validated sensor firing on your diff, an anchored anti-pattern, a stale
anchor on a file you touched). The process gates — briefing loaded, session recap, decision coverage,
bootstrap — report but never refuse. Use `posture: "strict"` to enforce the workflow too, or
`"advisory"` to report everything and refuse nothing.

```bash
hivelore init                    # Autopilot: policy config, hooks, CI, MCP setup, code-map
hivelore init --stack auto       # Opt in to generic starter packs for the detected stack
hivelore init --manual           # Manual mode: you approve every memory yourself
hivelore init --no-bridges       # Skip native bridge generation (CLAUDE.md, AGENTS.md, etc.)
hivelore init --dir /other/path  # Initialize in a specific directory
hivelore init --yes              # Also approve user-level AI client MCP configuration
```

**Autopilot mode** (default):
- Memories are saved directly as `validated` (no approval cycle)
- Git hooks installed automatically (`hivelore enforce check` gates commits/pushes)
- CI workflows generated (`hivelore-enforcement.yml` and sync workflow)
- Initial code-map built (`.ai/code-map.json`) for symbol lookup
- Session recaps saved automatically when the MCP server exits
- Configuration stored in `.ai/hivelore.config.json`

**Manual mode** (`--manual`):
- Memories start as `proposed` and require explicit approval (`hivelore memory approve`)
- No automatic hooks or CI — set up manually with `hivelore enforce install` and `hivelore init --with-ci`
- Full control over when knowledge becomes team policy

**What it creates:**

```
your-project/
├── .ai/
│   ├── project-context.md        # Shared project overview (fill via bootstrap_project MCP prompt)
│   ├── hivelore.config.json      # Policy + autopilot settings
│   ├── modules/                  # Per-component context files
│   └── memories/
│       ├── personal/             # Private to one developer
│       ├── team/                 # Shared with the whole team (git-committed)
│       └── module/<name>/        # Scoped to a specific module/component
├── CLAUDE.md                     # Bridge for Claude Code (auto-generated)
├── AGENTS.md / GEMINI.md / …     # 12 native bridges total (Cursor, Cline, Windsurf,
│                                 #   Continue, Cody, Zed, Roo, Aider, Copilot…)
└── .github/
    └── copilot-instructions.md   # Bridge for GitHub Copilot (auto-generated)
```

Each bridge carries the repo's validated memories **and** block sensors — not just an empty template —
so the enforcement edge travels to non-MCP agents too. Regenerate with `hivelore bridges sync`; scope with
`hivelore init --bridge-targets cursor,copilot`. Bridge files include mandatory rules, but they are not the
enforcement boundary. Hivelore's portable enforcement comes from MCP policy, Git hooks, CI checks, and `hivelore run -- <agent>` for CLI agents.

`hivelore init` also runs agent-aware setup. It always writes project-level MCP configs and records the selected mode in `.ai/.runtime/enforcement/agent-mode.json`. When it needs to change user-level configs such as Cursor, Claude Code, VS Code, Windsurf, or Codex, it asks for confirmation in an interactive shell. In CI/non-interactive shells, re-run:

```bash
hivelore agent setup --yes
```

### `hivelore agent`

Detect and configure the best Hivelore mode for the current machine.

```bash
hivelore agent detect                 # inspect project MCP + installed agents
hivelore agent status                 # same report, human-readable or --json
hivelore agent setup                  # project MCP + optional global MCP setup
hivelore agent setup --no-global      # project-only setup, no user config writes
hivelore agent setup --yes            # approve user-level MCP config writes
```

Modes:

- `mcp`: native Hivelore tools are available through the AI client.
- `wrapped`: use `hivelore run -- <agent>` when native MCP is unavailable.
- `fallback`: use `hivelore briefing` and `hivelore enforce check` manually.

---

### `hivelore enforce`

Install and run the agent-agnostic policy gates.

```bash
hivelore enforce install                 # strict config + Git hooks + CI + supported client hooks
hivelore enforce status                  # show whether the repo is protected
hivelore enforce check --stage local     # local policy gate
hivelore enforce check --stage pre-push  # used by Git hooks
hivelore enforce ci                      # used by required CI checks
hivelore enforce finish                  # final agent-exit gate: commit/push + version/tag protocol
hivelore enforce cleanup                 # remove generated .ai runtime/cache artifacts
```

Strict mode checks for:

- a recent Hivelore briefing marker before local write workflows
- recent session recap before push/CI gates
- stale important memories anchored to changed code
- decision coverage: changed files must have their relevant anchored policies surfaced in the latest briefing
- known anti-patterns from validated gotchas/decisions
- visible generated artifacts such as `.ai/.runtime`, `.ai/.cache`, or Python bytecode
- completed work is committed/pushed; shippable package changes have lockstep version bump + git tag

`hivelore enforce check` prints an enforcement score and fails strict gates when the score drops below the configured threshold.

### `hivelore sensors`

Operate executable regex sensors stored on `gotcha`/`attempt` memories.

```bash
hivelore sensors list
hivelore sensors check                    # scans git diff --cached
hivelore sensors check --diff-file diff.patch --json
hivelore sensors promote <memory-id> --yes
hivelore sensors export --format grep
```

Autogenerated sensors are conservative: they start as `warn` and `autogen: true`. A human can promote
high-confidence sensors to `severity: block`, which makes a deterministic pre-commit blocker when the
sensor matches added diff lines.

### `hivelore ingest`

Seed proposed, anchored memories (with sensors) from scanner output, so a fresh repo has policy from
day one instead of an empty corpus.

```bash
hivelore ingest --from sonar issues.json --min-severity major
hivelore ingest --from sarif report.sarif
hivelore ingest --from eslint eslint-report.json
hivelore ingest --from npm-audit audit.json --scope team
hivelore ingest --from sonar-api --sonar-component my_project   # pull straight from SonarQube
hivelore ingest --from sarif report.sarif --dry-run             # preview without writing
```

A **quality floor** runs by default: auto-fixable stylistic rules (semi/quotes/indent/prefer-const/
prettier… and the equivalent Sonar numeric keys) are dropped as linter-autofix noise, not lessons. Pass
`--include-stylistic` to keep them. Created memories are `proposed` with warn-only sensors — review with
`hivelore memory list --status proposed` and promote vetted sensors with `hivelore sensors promote`.

### `hivelore coverage`

Find changed files that no memory covers — the blind spots in your corpus.

```bash
hivelore coverage                       # cross corpus with git churn + agent-edited hot files
hivelore coverage --source git          # only committed churn
hivelore coverage --source agent        # only files agents edited (PostToolUse observation log)
```

### `hivelore eval`

Run the repeatable quality gate for Hivelore itself or for a project using Hivelore:

```bash
hivelore eval
hivelore eval --semantic-only
hivelore eval --semantic-ranking  # require and exercise the real embeddings-backed ranker
hivelore eval --spec .ai/eval/spec.json --fail-under 80
```

Without `--spec`, Hivelore synthesizes retrieval cases from anchored memories. If `.ai/eval/spec.json`
exists, it is loaded automatically and merged with those synthesized retrieval cases. Use that file
for labeled sensor cases and hard retrieval probes so CI measures both “did the right memory surface?”
and “did the executable guardrail fire?”.

### `hivelore doctor`

`doctor` is the first stop when Hivelore feels inconsistent locally:

```bash
hivelore doctor
hivelore doctor --json
hivelore doctor --fix
```

It reports missing `pnpm`, stale workspace `dist` artifacts after a pull, global CLI/MCP version skew,
outdated code-search indexes, memory-lint findings, and harness coverage. The output is intentionally
actionable: every setup finding should carry the exact command to run next.

### `hivelore benchmark`

Turn Hivelore-vs-plain agent trials into a repeatable demo/report.

```bash
hivelore benchmark demo
hivelore benchmark report --dir benchmarks/agent-benchmark
hivelore benchmark report --dir benchmarks/agent-benchmark --out RESULTS.md
```

The report summarizes agent effort from `BENCHMARK_AGENT_REPORT.md` files: commands, files read, files modified, test iterations, terminal failures, decision mentions, token proxy, and whether Hivelore memory shaped the outcome.

### `hivelore run`

Wrap any CLI-based coding agent in a Hivelore session.

```bash
hivelore run -- claude
hivelore run -- codex
hivelore run -- aider
hivelore run -- <custom-agent> [args...]
```

The wrapper writes a compact briefing file and exports:

- `HAIVE_PROJECT_ROOT`
- `HAIVE_SESSION_ID`
- `HAIVE_BRIEFING_FILE`
- `HAIVE_ENFORCEMENT=strict`
- `HAIVE_TOOL_PROFILE=enforcement`

---

### `hivelore mcp`

Run the Hivelore MCP server over stdio (**bundled into this package** — same tools as legacy `haive-mcp`).

```bash
hivelore mcp --stdio                     # typical MCP client args (stdio marker optional but recommended)
hivelore mcp -d /path/to/project         # resolve project root from this directory
hivelore mcp --root /path/to/project     # alias for legacy haive-mcp --root
```

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "hivelore": {
      "command": "hivelore",
      "args": ["mcp", "--stdio", "--root", "/absolute/path/to/your/project"]
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
      "args": ["mcp", "--stdio", "--root", "/absolute/path/to/your/project"]
    }
  }
}
```

**VS Code**:
```bash
code --add-mcp '{"name":"haive","command":"haive","args":["mcp","--stdio","--root","/path/to/project"]}'
```

---

### `hivelore memory`

Manage individual memory entries.

#### `hivelore memory save`

(Canonical verb; `hivelore memory add` remains as an alias.)

```bash
hivelore memory save \
  --type <type> \          # convention | decision | gotcha | architecture | glossary | attempt
  --slug <slug> \          # Short identifier used in the filename
  --scope team \           # personal (default) | team | module
  --title "My title" \     # Optional heading (auto-added to body)
  --tags "auth,jwt" \      # Comma-separated tags
  --domain payments \      # Business domain for relevance scoring
  --paths src/auth.ts \    # Anchor to files (enables staleness detection)
  --symbols JwtFilter \    # Anchor to symbols/functions
  --body "The knowledge."  # Memory content (Markdown)

# Read body from a file (useful for long memories):
hivelore memory save --type architecture --slug "payment-flow" \
  --body-file docs/payment-architecture.md
```

**Memory types:**

| Type | When to use |
|---|---|
| `convention` | How things are done here: naming, patterns, workflow |
| `decision` | A choice that was made and WHY (tradeoffs, constraints) |
| `gotcha` | Non-obvious behavior, traps, things that surprise newcomers |
| `architecture` | Structural overview of a system or module |
| `glossary` | Domain terms and their meaning in this project |
| `attempt` | Failed approach — prevents the same mistake next session |

#### `hivelore memory list`

```bash
hivelore memory list                        # All memories
hivelore memory list --scope team           # Team memories only
hivelore memory list --status validated     # Only validated
hivelore memory list --type gotcha          # Gotchas only
hivelore memory list --tags auth,jwt        # By tags (AND match)
hivelore memory list --module payments      # Module-scoped memories
```

#### `hivelore memory search`

Full-text (or semantic) search across id, tags, and body. (`hivelore memory query` remains as an alias.)

```bash
hivelore memory search "flyway migration"         # AND search across all tokens
hivelore memory search "payment mobile wave"      # Falls back to OR if no AND match
hivelore memory search "jwt" --scope team --limit 5
```

#### `hivelore memory get`

Print the full body, frontmatter, and usage stats of a memory. (`hivelore memory show` remains as an alias.)

```bash
hivelore memory get 2025-01-15-gotcha-flyway-strict
```

#### `hivelore memory update`

Update a memory's body, tags, or anchor without changing its id or history.

```bash
hivelore memory update <id> --body "Updated content."
hivelore memory update <id> --tags "auth,jwt,security"
hivelore memory update <id> --paths src/auth.ts,src/jwt.ts
```

#### `hivelore memory verify`

Check anchor freshness — detect stale memories when anchored files or symbols have moved.

```bash
hivelore memory verify           # Check all memories
hivelore memory verify --id <id> # Check a specific one
hivelore memory verify --update  # Write stale/validated status back to disk
```

When a file is missing, Hivelore searches the project for files with the same basename and suggests possible renames.

#### `hivelore memory approve` / `promote` / `reject`

Control the memory lifecycle: `draft → proposed → validated` or `rejected`.

```bash
hivelore memory approve <id>       # Mark as validated
hivelore memory approve --all      # Bulk-approve all proposed/draft
hivelore memory promote <id>       # Promote personal → team (status: proposed)
hivelore memory reject <id> --reason "Outdated after refactor"
```

#### `hivelore memory tried`

Record a failed approach — the most valuable type of negative knowledge.

```bash
hivelore memory tried \
  --what "importing gray-matter with ESM dynamic import" \
  --why-failed "gray-matter doesn't export a default; named import required" \
  --instead "import matter from 'gray-matter'" \
  --scope team \
  --paths src/parser.ts
```

Auto-validated (no approval cycle needed). Surfaced first in `get_briefing` so agents see it before making the same mistake.

#### `hivelore memory import`

Import documentation (README, ADR, wiki page) as memories via the `import_docs` MCP prompt.

```bash
hivelore memory import --from docs/architecture.md --scope team
```

Prints the MCP `import_docs` invocation to run in your AI client.

#### `hivelore memory for-files`

Show memories relevant to specific files you're about to edit.

```bash
hivelore memory for-files src/payments/PaymentService.java src/payments/PaymentController.java
```

#### `hivelore memory stats` / `hot` / `pending` / `digest`

```bash
hivelore memory stats     # Usage stats and confidence levels for all memories
hivelore memory hot       # Most-read unvalidated memories (good promotion candidates)
hivelore memory pending   # Proposed memories awaiting review

# Generate a Markdown review digest for bulk approval/rejection:
hivelore memory digest                  # Last 7 days, team scope (prints to stdout)
hivelore memory digest --days 14        # Last 14 days
hivelore memory digest --scope all      # All scopes
hivelore memory digest --out digest.md  # Write to file
```

The digest groups memories by type, shows confidence level (⬜ unverified / 🟡 low / 🟢 trusted / ⭐ authoritative), anchor, read count, and action checkboxes for easy bulk review.

---

### `hivelore briefing`

Print the full project briefing — project context + relevant memories — in one shot. Use before starting a task.

```bash
hivelore briefing                                           # Full briefing, team scope
hivelore briefing --task "add a Stripe payment"             # Filter by task relevance
hivelore briefing --files src/payments/PaymentService.java  # Filter by files
hivelore briefing --symbols PaymentService,TenantFilter     # Look up symbol locations in code-map
hivelore briefing --scope all                               # Include personal memories
hivelore briefing --include-stale                           # Include stale memories
hivelore briefing --max-memories 15                         # Show more memories
```

**`--symbols` (requires `hivelore index code`):** look up where specific symbols are defined across your entire codebase — no grep needed. Returns file, line number, kind (class/interface/function/enum), and JSDoc description for each match.

```
PaymentProvider  src/payments/PaymentProvider.java:12  [interface]  — Abstract payment provider
PaymentProvider  src/frontend/payment.types.ts:4       [enum]       — Mobile payment provider enum
```

---

### `hivelore sync`

Refresh memory state after a `git pull` or merge.

```bash
hivelore sync                          # Verify anchors + auto-promote eligible memories
hivelore sync --since main             # Report memories changed since main
hivelore sync --inject-bridge          # Inject top memories into CLAUDE.md
hivelore sync --embed                  # Rebuild embeddings index after sync
hivelore sync --quiet                  # Minimal output (for git hooks)
```

**What sync does:**
1. Checks every anchored memory: does the file/symbol still exist? → marks `stale` if not
2. Re-validates previously stale memories that are now fresh again
3. Auto-promotes `proposed` memories that have been read enough times
4. Reports a decay warning for memories not read in >90 days
5. Optionally injects the top validated memories into your CLAUDE.md

---

### `hivelore enforce install`

Install the blocking git hooks (pre-commit, pre-push, commit-msg) plus the sync hooks that run
`hivelore sync` after every pull/merge, and write the CI enforcement workflow.

```bash
hivelore enforce install                  # Hooks + CI enforcement workflow
hivelore enforce install --dir /path/to/project
```

> `hivelore install-hooks` still works as a hidden back-compat alias; `enforce install` is the
> canonical command.

---

### `hivelore index`

Manage the local semantic search index (requires `@hivelore/embeddings` to be installed).

```bash
hivelore index memories            # Build or refresh the embeddings index
hivelore index status              # Show index stats (count, last updated, model)
hivelore index query "how do we handle retries on payment failures"
```

The model (`bge-small-en-v1.5`, ~110MB) is downloaded on first use and cached locally. **No data leaves your machine.**

---

### `hivelore index`

Build code navigation indexes.

```bash
hivelore index code        # Build .ai/code-map.json (file → exports + 1-line descriptions)
```

The code map lets AI agents find where a function lives without grepping — dramatically reducing tool calls at the start of a task.

---

### `hivelore tui`

Interactive terminal dashboard with 3 screens — browse, filter, and manage memories without leaving the terminal.

```bash
hivelore tui               # Open the TUI
hivelore tui --dir /path/to/project
```

**Screens (switch with `1` `2` `3`):**

| Screen | Key | What it shows |
|---|---|---|
| Memories | `1` | Full list + preview panel, filter by status (Tab), actions |
| Health | `2` | Stale memories, pending review, anchorless memories |
| Stats | `3` | Top-read memories, decaying (>90d unused), totals by status |

**Actions (in Memories screen):**

| Key | Action |
|---|---|
| `↑` `↓` | Navigate |
| `Tab` | Cycle filter (all / draft / proposed / validated / stale / rejected) |
| `a` | Approve (→ validated) |
| `r` | Reject |
| `p` | Propose (→ proposed) |
| `d` | Delete |
| `q` | Quit |

---

### `hivelore session end`

Save a structured end-of-session recap. Surfaced automatically at the start of the next session via `get_briefing`.

```bash
hivelore session end \
  --goal "Add Stripe payment integration" \
  --accomplished "Implemented PaymentService, added tests, deployed to staging" \
  --discoveries "The webhook signature must use the raw request body, not parsed JSON" \
  --files "src/payments/PaymentService.ts,src/payments/webhook.ts" \
  --next "Add retry logic for failed webhooks" \
  --scope team
```

One recap is kept per scope (topic-upsert: `revision_count` increments on each call).

---

## Memory lifecycle

```
hivelore memory save       → status: draft
hivelore memory promote    → status: proposed  (personal → team)
hivelore memory approve    → status: validated
hivelore sync              → status: stale     (if anchor broken)
hivelore memory reject     → status: rejected
```

Validated team memories are loaded into every `get_briefing` call and injected into bridge files.

---

## Multi-component projects

For projects with frontend + backend (or microservices), create one module context per component:

```bash
# After hivelore init, create module context files:
mkdir -p .ai/modules/backend .ai/modules/frontend

cat > .ai/modules/backend/context.md << 'EOF'
# Module: backend
- Spring Boot, Java 17, PostgreSQL
- Always filter by tenantId in every query
- Never modify existing Flyway migrations
EOF

cat > .ai/modules/frontend/context.md << 'EOF'
# Module: frontend
- React 19, TypeScript, TanStack Query
- All API calls go through hooks in features/<domain>/api/
- Env vars must be prefixed with VITE_
EOF
```

`get_briefing` auto-loads the relevant module context based on the files the agent is editing.

---

## Semantic search (optional)

Install `@hivelore/embeddings` for similarity-based memory retrieval:

```bash
npm install -g @hivelore/embeddings
hivelore index memories            # First run downloads the model (~110MB)
hivelore index query "payment retry logic"
```

From MCP: set `semantic: true` on `mem_search` or `get_briefing`.

---

## License

MIT
