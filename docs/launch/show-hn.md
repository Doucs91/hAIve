<!--
  Launch copy for Hivelore. Two audiences:
  - Hacker News is PLAIN TEXT (no images): use the title + "Author comment" below. Submit the repo URL.
  - dev.to / Reddit / GitHub Discussions / LinkedIn render images: use the "Long version" (GIF embeds).
  Keep it honest — HN rewards limits stated plainly and punishes hype.
-->

# Show HN

## Title (pick one; lead with the problem, not the tech)

1. `Show HN: Hivelore – a deterministic gate that blocks AI commits repeating past mistakes`
2. `Show HN: Hivelore – make the bug your team already fixed un-repeatable by AI agents`
3. `Show HN: Hivelore – turn a lived lesson into a gate that refuses the commit repeating it`

**URL to submit:** https://github.com/Doucs91/hivelore  (the README leads with the demo GIF)

---

## Author comment (post this as the first comment right after submitting)

Hi HN — I built Hivelore because my AI coding agents kept confidently redoing mistakes my team had already paid for. A capable model knows generic best practice; what it can't guess is your team's *arbitrary, repo-specific* knowledge — that public ids are `id + 100000`, that you never edit an applied migration, that this call needs an idempotency key. Left alone, the agent writes something clean, tested, green — and wrong by policy.

Hivelore is the enforcement layer for that. A lesson you capture (a failed approach, a gotcha) can attach a **validated guard** — a regex, an ast-grep structural pattern, or a command/test oracle routing your own test. Git hooks and a CI check then refuse any diff that reintroduces the documented mistake. Same diff, same verdict, on every machine. It's deterministic on purpose — no LLM grading another LLM.

GIF (a lesson refusing the commit that repeats it): https://raw.githubusercontent.com/Doucs91/hivelore/main/docs/demo/hivelore-demo.gif

Three things people do with it:
1. **Block a repeat mistake.** `memory tried … --instead date-fns` → `sensors propose --pattern "from 'moment'" --severity block`. The guard is trusted only after it's proven silent on your correct code and firing on the mistake — so the gate never false-positives its way into being ignored. (This is the GIF.)
2. **Route your own test as the gate.** A command/test sensor runs your invariant on the diff; a `--red-ref <pre-fix-commit>` replays the incident and requires the test to actually go RED there before it can block — so a "guard" can't claim protection it never demonstrated.
3. **Brief any agent before it edits.** One MCP call (`get_briefing`) surfaces the team's unguessable, file-anchored rules for the files being touched — so the agent starts with the context, not a plausible guess.

Everything lives as plain Markdown under `.ai/`, versioned with your code. It complements tests/linters/evals rather than replacing them — it carries the repo-specific knowledge they can't infer.

Honest limits (it's early — just hit the MCP registry): the deterministic gate catches *syntactic* repeats well; a semantically-different version of the same mistake slips unless you wire a test oracle. Realistically many lessons stay feedforward-only, because writing a good guard is work (there's a `--from-fix` that mines the pattern from the fix diff to lower that). And I've mostly dogfooded it on my own repos — I'd genuinely value hearing where it breaks on yours.

Install: `npm i -g @hivelore/cli` then `hivelore init`. MCP server bundled. Apache-2.0. Feedback and "this is wrong because…" very welcome.

---

## Long version (dev.to / Reddit / GitHub Discussions — images render here)

### Your AI agent keeps repeating the mistake your team already fixed

A capable model knows generic best practice. What it *can't* guess is your team's arbitrary, repo-specific knowledge: that public ids are `id + 100000`, that you never edit an applied migration, that this API call needs an idempotency key. Left to itself, a confident agent writes something clean, tested, green — and **wrong by policy**.

**Hivelore** is the enforcement layer for that knowledge. A lived lesson becomes a **validated, deterministic guard** that refuses the commit reintroducing the mistake — same diff, same verdict, on every machine. No LLM grading another LLM.

<p align="center">
  <img src="https://raw.githubusercontent.com/Doucs91/hivelore/main/docs/demo/hivelore-demo.gif" alt="A captured lesson attaches a validated guard; the commit that reintroduces the mistake is refused" width="760" />
</p>

#### Use case 1 — Block a repeat mistake

```bash
hivelore memory tried --what "import moment" --why-failed "bloat; use date-fns" --paths src/
hivelore sensors propose <lesson> --pattern "from 'moment'" --severity block
# reintroduce moment → the commit is refused (exit 1)
```

The guard is accepted **only after** it's proven silent on your current (correct) code and firing on the mistake — so it can't false-positive its way into being ignored. Guards can be a regex, an [ast-grep](https://ast-grep.github.io) structural pattern (comments/strings can't false-positive), or a command/test oracle.

#### Use case 2 — Route your own test as the gate (behaviour bridge)

```bash
hivelore sensors propose <lesson> --kind test \
  --command "npx vitest run tests/refund-invariants.spec.ts" \
  --red-ref <pre-fix-commit>          # replays the incident: the test must go RED there
```

Hivelore doesn't invent the oracle — it routes the test you already own to the lesson it protects, and `--red-ref` proves the test actually catches the incident before it's allowed to block. A crash isn't accepted as proof.

#### Use case 3 — Brief any agent before it edits

```
get_briefing(task: "add a refund path", files: ["src/payments/refund.ts"])
```

One MCP call returns the team's unguessable, file-anchored rules for exactly the files being touched — so the agent starts with the context instead of a plausible guess. Works over MCP or generated bridge files (CLAUDE.md, .cursorrules, …).

#### Where it fits / honest limits

- Complements tests, linters, and evals — it carries the repo-specific knowledge they can't infer.
- Deterministic gate catches *syntactic* repeats; wire a test oracle (use case 2) for behavioural ones.
- Many lessons stay feedforward-only unless you arm a guard (`--from-fix` mines the pattern from the fix diff to make that a one-liner).
- Early and mostly dogfooded — real-world feedback is the thing I want most.

Everything is plain Markdown under `.ai/`, versioned with your code. `npm i -g @hivelore/cli`, Apache-2.0 → https://github.com/Doucs91/hivelore
