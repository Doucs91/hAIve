import { existsSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { Command } from "commander";
import {
  applyAutopilotRepairs,
  projectContextVersionStatus,
  type AutopilotRepair,
} from "../utils/autopilot.js";
import { lintMemoriesAsync } from "./memory-lint.js";
import { detectStaleGitHooks, repairStaleGitHooks } from "./enforce.js";
import { isSyntheticSuggestionQuery } from "./memory-suggest.js";

declare const __HAIVE_VERSION__: string;
import {
  codeMapPath,
  assessSensorHealth,
  assessBehaviourCoverage,
  renderBehaviourCoverageLine,
  sensorPromotedAtMap,
  countSourceFilesOnDisk,
  extractReferencedPaths,
  sensorPatternBrittleness,
  sensorSelfCheck,
  findProjectRoot,
  getUsage,
  isStackPackSeed,
  loadCodeMap,
  loadConfig,
  resolveGatePolicy,
  describePosture,
  loadMemoriesFromDirDetailed,
  loadSensorLedger,
  loadUsageIndex,
  readUsageEvents,
  readFrictionReports,
  loadFrictionState,
  groupFriction,
  resolveHaivePaths,
  type LoadedMemory,
  type SensorTarget,
  type UsageEvent,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";
import { collectScaffoldLoopGaps, describeScaffoldGap } from "../utils/post-incident-scan.js";

interface DoctorOptions {
  json?: boolean;
  dir?: string;
  fix?: boolean;
  dryRun?: boolean;
  all?: boolean;
}

type Severity = "info" | "warn" | "error";
type DoctorSection =
  | "Protection"
  | "Agent coverage"
  | "Context quality"
  | "Corpus health"
  | "Harness coverage"
  | "Index health"
  | "Next actions";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  fix?: string;
  section?: DoctorSection;
  coverage_percent?: number;
  /** Info findings are hidden by default; set this to keep a high-value one (e.g. coverage) visible. */
  alwaysShow?: boolean;
}

interface DoctorScores {
  protection_score: number;
  context_quality_score: number;
  corpus_quality_score: number;
  harness_coverage_score: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Analyze the local Hivelore setup and emit actionable recommendations.\n\n" +
      "  Inspects: project-context status, memory health (stale/anchorless/decay/pending),\n" +
      "  code-map freshness, usage log signals (low-hit briefings, repeated empty searches).\n\n" +
      "  Read-only by default. Pass --fix to apply safe autopilot repairs.",
    )
    .option("--json", "emit JSON instead of human-readable output", false)
    .option("--fix", "include suggested fix commands in human output", false)
    .option("--dry-run", "with --fix, show delegated repairs without applying them", false)
    .option("--all", "show informational findings too (hidden by default to keep doctor actionable)", false)
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: DoctorOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const findings: Finding[] = [];
      const repairs: AutopilotRepair[] = [];
      const config = await loadConfig(paths);

      // ── 1. Init state ─────────────────────────────────────────────────────
      if (!existsSync(paths.haiveDir)) {
        // Do NOT route through emit(): health scores over a non-existent corpus (protection=…,
        // corpus=100) are meaningless noise for a project that simply isn't set up yet.
        if (opts.json) {
          console.log(JSON.stringify({
            initialized: false,
            findings: [{ severity: "error", code: "not-initialized", message: ".ai/ directory missing — Hivelore is not initialized in this project.", fix: "hivelore init" }],
          }, null, 2));
        } else {
          ui.error(`Hivelore is not initialized at ${root} (no .ai/ directory).`);
          ui.info("Run `hivelore init` to set it up — everything it writes is removable (.ai/ + bridge files).");
        }
        process.exitCode = 1;
        return;
      }

      if (opts.fix && !opts.dryRun) {
        repairs.push(
          ...await applyAutopilotRepairs(root, paths, {
            applyConfig: true,
            applyContext: true,
            applyCorpus: true,
            applyCodeMap: true,
            applyCodeSearch: true,
            forceCodeMap: true,
          }),
        );
      }

      // ── First-run health: broken git hooks ────────────────────────────────
      // A hook left calling the removed `haive` binary (pre-v0.51.0 install) or carrying a duplicated
      // block aborts EVERY commit with `haive: not found` — the worst possible first impression, and
      // one the user cannot diagnose. Detect it here (doctor is the "is my install healthy?" command)
      // and repair it under --fix (deterministic, foreign husky hooks preserved). Error, not warn:
      // a hook that blocks all commits is not advisory.
      {
        const staleHooks = await detectStaleGitHooks(root);
        if (staleHooks.length > 0) {
          if (opts.fix && !opts.dryRun) {
            const repaired = await repairStaleGitHooks(root);
            findings.push({
              severity: "info",
              code: "git-hook-repaired",
              alwaysShow: true,
              message: `Repaired ${repaired.length} broken git hook(s) (${repaired.join(", ")}) — they called the removed \`haive\` binary or carried a duplicate block. Commits work again.`,
            });
          } else {
            findings.push({
              severity: "error",
              code: "stale-git-hook",
              message: `${staleHooks.length} git hook(s) are broken (${staleHooks.join(", ")}): they call the removed \`haive\` binary or carry a duplicate block, so every commit fails with \`haive: not found\`.`,
              fix: "hivelore doctor --fix   # or: hivelore enforce install",
            });
          }
        }
      }

      // ── 2. Project context ────────────────────────────────────────────────
      if (!existsSync(paths.projectContext)) {
        findings.push({
          severity: "warn",
          code: "no-project-context",
          message: ".ai/project-context.md is missing.",
          fix: "hivelore init",
        });
      } else {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(paths.projectContext, "utf8");
        const isTemplate = content.includes("TODO — high-level overview") ||
          content.includes("Generated by `hivelore init`");
        if (isTemplate) {
          findings.push({
            severity: "warn",
            code: "template-context",
            message: "project-context.md still contains the default template — get_briefing returns little value until filled.",
            fix: "Invoke the bootstrap_project MCP prompt from your AI client.",
          });
        } else {
          // Grounding: a FILLED context that cites file paths which don't exist on disk is ungrounded
          // (hallucinated or stale) — the failure mode of LLM-generated context. Flag low-grounded ones.
          const referenced = extractReferencedPaths(content);
          const missing = referenced.filter((p) => !existsSync(path.resolve(root, p)));
          const grounded = referenced.length - missing.length;
          if (referenced.length >= 3 && grounded / referenced.length < 0.5) {
            findings.push({
              severity: "warn",
              code: "project-context-ungrounded",
              section: "Context quality" as DoctorSection,
              message:
                `project-context.md cites ${referenced.length} file path(s) but ${missing.length} don't exist on disk ` +
                `(e.g. ${missing.slice(0, 3).join(", ")}) — it looks ungrounded or stale, not written from the real code.`,
              fix: "Regenerate via the bootstrap_project MCP prompt, or fix the stale paths.",
            });
          }
        }
        const versionStatus = await projectContextVersionStatus(root, paths);
        if (versionStatus.mismatch) {
          findings.push({
            severity: "warn",
            code: "project-context-version-mismatch",
            message:
              `.ai/project-context.md version metadata (${versionStatus.currentVersion ?? "missing"}) ` +
              `does not match package.json (${versionStatus.expectedVersion}).`,
            fix: "hivelore doctor --fix",
          });
        }
      }

      // ── 3. Memories ───────────────────────────────────────────────────────
      const memoriesDetailed = existsSync(paths.memoriesDir)
        ? await loadMemoriesFromDirDetailed(paths.memoriesDir)
        : { loaded: [], invalid: [] };
      const memories: LoadedMemory[] = memoriesDetailed.loaded;
      const now = Date.now();

      if (memoriesDetailed.invalid.length > 0) {
        const listed = memoriesDetailed.invalid
          .slice(0, 5)
          .map((f) => `${path.relative(root, f.filePath)} (${f.error})`)
          .join("; ");
        findings.push({
          severity: "warn",
          code: "invalid-memory-files",
          message:
            `${memoriesDetailed.invalid.length} memory file(s) failed to parse and are INVISIBLE to briefings and the gate: ${listed}`,
          fix: "Fix the frontmatter (or delete the file) — a corrupt memory is a silently lost team lesson.",
        });
      }

      if (memories.length === 0) {
        findings.push({
          severity: "info",
          code: "no-memories",
          message: "No memories yet. Capture knowledge as agents work via mem_save / mem_tried.",
        });
      } else {
        const usage = await loadUsageIndex(paths);

        const stale = memories.filter((m) => m.memory.frontmatter.status === "stale");
        if (stale.length > 0) {
          findings.push({
            severity: "warn",
            code: "stale-memories",
            message: `${stale.length} memor${stale.length === 1 ? "y" : "ies"} marked stale (anchored code drifted).`,
            fix: "hivelore memory verify --update    # re-check anchors\nhivelore memory update <id>        # manually refresh body",
          });
        }

        const proposed = memories.filter((m) => m.memory.frontmatter.status === "proposed");
        if (proposed.length > 0) {
          findings.push({
            severity: "info",
            code: "pending-review",
            message: `${proposed.length} memor${proposed.length === 1 ? "y is" : "ies are"} proposed and awaiting validation.`,
            fix: "hivelore memory pending       # list them\nhivelore memory approve <id>  # validate a proposed one",
          });
        }

        // Drafts older than 30 days — likely forgotten, never activated
        const OLD_DRAFT_DAYS = 30;
        const oldDrafts = memories.filter((m) => {
          if (m.memory.frontmatter.status !== "draft") return false;
          const age = (now - Date.parse(m.memory.frontmatter.created_at)) / MS_PER_DAY;
          return age > OLD_DRAFT_DAYS;
        });
        if (oldDrafts.length > 0) {
          const ids = oldDrafts.slice(0, 4).map((m) => m.memory.frontmatter.id).join(", ");
          const more = oldDrafts.length > 4 ? ` (+${oldDrafts.length - 4} more)` : "";
          findings.push({
            severity: "warn",
            code: "stale-draft-memories",
            message:
              `${oldDrafts.length} draft memor${oldDrafts.length === 1 ? "y has" : "ies have"} been in draft status for 30+ days: ${ids}${more}`,
            fix: "hivelore memory approve <id>   # activate\nhivelore memory delete <id>    # or delete if obsolete",
          });
        }

        // Anchorless = no paths AND no symbols → cannot detect drift automatically
        // (skill, glossary, session_recap are procedure/reference types that don't need code anchors)
        const policyMemories = memories.filter((m) => !isStackPackSeed(m.memory.frontmatter));
        const anchorless = policyMemories.filter((m) =>
          m.memory.frontmatter.anchor.paths.length === 0 &&
          m.memory.frontmatter.anchor.symbols.length === 0 &&
          m.memory.frontmatter.type !== "session_recap" &&
          m.memory.frontmatter.type !== "glossary" &&
          m.memory.frontmatter.type !== "skill"
        );
        const stackSeeds = memories.filter((m) => isStackPackSeed(m.memory.frontmatter));
        if (anchorless.length / Math.max(policyMemories.length, 1) > 0.3) {
          findings.push({
            severity: "warn",
            code: "anchorless-majority",
            message: `${anchorless.length}/${policyMemories.length} repo-specific memories have no anchor path/symbol — staleness undetectable.`,
            fix: "Add `paths:` + `symbols:` to mem_save calls to enable hivelore memory verify.",
          });
        } else if (stackSeeds.length > 0 && policyMemories.length === 0) {
          findings.push({
            severity: "info",
            code: "stack-pack-seeds",
            message: `${stackSeeds.length} starter stack memor${stackSeeds.length === 1 ? "y is" : "ies are"} present as generic background guidance.`,
            fix: "Replace or anchor stack-pack seeds when they become repo-specific policy.",
          });
        }

        // Decay candidates: validated memories not read in 180 days
        const decayCandidates = memories.filter((m) => {
          if (m.memory.frontmatter.status !== "validated") return false;
          const u = getUsage(usage, m.memory.frontmatter.id);
          const last = u.last_read_at ?? m.memory.frontmatter.created_at;
          return (now - Date.parse(last)) / MS_PER_DAY > 180;
        });
        if (decayCandidates.length > 0) {
          findings.push({
            severity: "info",
            code: "decay-candidates",
            message: `${decayCandidates.length} validated memor${decayCandidates.length === 1 ? "y has" : "ies have"} not been read in 180+ days — confidence is decaying.`,
            fix: "hivelore memory archive --type all --since 365d   # dry run",
          });
        }
      }

      const lintReport = await lintMemoriesAsync(root);
      const actionableLintFindings = lintReport.findings.filter((finding) => finding.severity !== "info");
      if (actionableLintFindings.length > 0) {
        const warnCount = lintReport.findings.filter((finding) => finding.severity === "warn").length;
        const errorCount = lintReport.findings.filter((finding) => finding.severity === "error").length;
        const severity: Severity = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "info";
        findings.push({
          severity,
          code: "memory-lint-findings",
          message:
            `memory lint reports ${actionableLintFindings.length} actionable finding${actionableLintFindings.length === 1 ? "" : "s"} ` +
            `(${errorCount} error, ${warnCount} warn).`,
          fix: "hivelore memory lint --fix --apply",
        });
      }

      // Corpus hygiene: brittle sensors (over-fit to line numbers/literals) silently rot and inflate
      // the "active protection" count. Surface them so they can be rewritten or retired.
      const brittleSensors = memories.filter((m) => {
        const s = m.memory.frontmatter.sensor;
        return s?.kind === "regex" && s.pattern && sensorPatternBrittleness(s.pattern);
      }).length;
      if (brittleSensors > 0) {
        findings.push({
          severity: "info",
          code: "memory-brittle-sensors",
          message: `${brittleSensors} sensor(s) look brittle (hardcoded line numbers/literals) — they won't hard-block and may not fire on real diffs.`,
          fix: "hivelore sensors list   # review the ⚠ brittle entries, then rewrite or retire them",
        });
      }

      // State the effective gate posture out loud. Two dozen enforcement switches interact, and a
      // developer who cannot predict what the gate will refuse stops trusting it. One line, always
      // shown, naming the posture, what it does, and anything pinned on top of it.
      {
        const policy = resolveGatePolicy(config.enforcement);
        findings.push({
          severity: "info",
          code: "enforcement-posture",
          message: `Gate posture: ${describePosture(policy)}.`,
          fix:
            policy.posture === "balanced"
              ? undefined
              : 'Set enforcement.posture to "advisory" | "balanced" | "strict" in .ai/hivelore.config.json.',
        });
      }

      // Honest protection signal: Hivelore's headline claim is "blocks the repeat". If every sensor is
      // warn-only, enforcement is *advisory*, not blocking — say so (and pull down protection_score)
      // rather than letting the pitch outrun the config. Either promote a trusted sensor, or stop
      // claiming enforcement. Counts toward the Protection section.
      const sensorMemories = memories.filter((m) => m.memory.frontmatter.sensor);
      const gateMissDrafts = memories.filter((m) =>
        m.memory.frontmatter.status === "proposed" && m.memory.frontmatter.tags.includes("gate-miss"),
      );
      if (gateMissDrafts.length > 0) {
        findings.push({
          severity: "info",
          code: "gate-miss-drafts",
          section: "Corpus health" as DoctorSection,
          message:
            `${gateMissDrafts.length} proposed gate-miss lesson(s) await review: ` +
            `${gateMissDrafts.slice(0, 5).map((m) => m.memory.frontmatter.id).join(", ")}.`,
          fix: "Review with `hivelore memory list --status proposed`.",
        });
      }
      const blockSensors = sensorMemories.filter(
        (m) => m.memory.frontmatter.sensor?.severity === "block",
      ).length;
      if (sensorMemories.length > 0 && blockSensors === 0) {
        findings.push({
          severity: "warn",
          code: "sensors-no-hard-block",
          section: "Protection" as DoctorSection,
          message:
            `${sensorMemories.length} sensor(s) defined but 0 hard-block (all warn-only) — enforcement is ` +
            `effectively advisory. The "blocks the repeat" guarantee isn't true until a trusted sensor is promoted.`,
          fix: "hivelore sensors list   # then `hivelore sensors promote <id>` for a trusted, non-brittle sensor — or retire the noise",
        });
      }
      const commandSensorMemories = sensorMemories.filter((m) => {
        const kind = m.memory.frontmatter.sensor?.kind;
        return kind === "shell" || kind === "test";
      });
      if (commandSensorMemories.length > 0 && config.enforcement?.runCommandSensors !== true) {
        findings.push({
          severity: "error",
          code: "command-sensors-disabled",
          section: "Protection" as DoctorSection,
          message: `${commandSensorMemories.length} command/test sensor(s) exist but enforcement.runCommandSensors is not true — their behaviour protection is OFF.`,
          fix: "Set enforcement.runCommandSensors=true after reviewing the repo-authored commands.",
        });
      }
      const unprovenBlocks = commandSensorMemories.filter((m) => {
        const sensor = m.memory.frontmatter.sensor!;
        return sensor.severity === "block" && sensor.red_proven !== true;
      });
      if (unprovenBlocks.length > 0) {
        findings.push({
          severity: "error",
          code: "command-sensors-block-without-red",
          section: "Protection" as DoctorSection,
          message: `${unprovenBlocks.length} blocking command/test sensor(s) predate mandatory prove-RED and cannot substantiate their incident claim.`,
          fix: "Re-propose each sensor with --red-ref <pre-fix-commit>, or demote it to warn.",
        });
      }

      // AST sensors need the optional engine — without it their protection is silently OFF here.
      const astSensorCount = sensorMemories.filter((m) => m.memory.frontmatter.sensor?.kind === "ast").length;
      if (astSensorCount > 0) {
        const { astEngineAvailable } = await import("@hivelore/mcp");
        if (!(await astEngineAvailable())) {
          findings.push({
            severity: "warn",
            code: "ast-engine-missing",
            section: "Protection" as DoctorSection,
            message:
              `${astSensorCount} AST sensor(s) exist but the optional @ast-grep/napi engine is not installed — ` +
              "they are unrunnable on this machine (warn-only at the gate, protection OFF).",
            fix: "npm i -g @ast-grep/napi   # or add it to the repo devDependencies",
          });
        }
      }

      // Self-validation: a block sensor that matches the CURRENT (presumed-correct) code false-positives
      // on every commit. It shouldn't be trusted as protection — surface it so it's fixed or demoted.
      const firesOnCurrent: string[] = [];
      for (const m of sensorMemories) {
        const s = m.memory.frontmatter.sensor;
        if (!s || s.kind !== "regex" || s.severity !== "block" || !s.pattern) continue;
        const anchorPaths = s.paths.length > 0 ? s.paths : m.memory.frontmatter.anchor.paths;
        const targets: SensorTarget[] = [];
        for (const rel of anchorPaths) {
          const abs = path.resolve(root, rel);
          if (!existsSync(abs)) continue;
          try { targets.push({ path: rel, content: await readFile(abs, "utf8") }); } catch { /* skip */ }
        }
        if (targets.length === 0) continue;
        if (!sensorSelfCheck(s, { currentTargets: targets, badExamples: [] }).silent_on_current) {
          firesOnCurrent.push(m.memory.frontmatter.id);
        }
      }
      if (firesOnCurrent.length > 0) {
        findings.push({
          severity: "warn",
          code: "sensor-fires-on-current",
          section: "Protection" as DoctorSection,
          message:
            `${firesOnCurrent.length} block sensor(s) match the CURRENT code — they false-positive on every ` +
            `commit and can't be trusted as protection: ${firesOnCurrent.slice(0, 3).join(", ")}` +
            `${firesOnCurrent.length > 3 ? ", …" : ""}.`,
          fix: "Make the pattern discriminating (add an 'absent' companion), or demote: `hivelore sensors promote <id> --severity warn`",
        });
      }

      // Command-oracle accountability: identical source inputs must produce identical outcomes.
      const sensorHealth = assessSensorHealth(await loadSensorLedger(paths), new Date(), {
        promotedAt: sensorPromotedAtMap(memories.map((m) => m.memory.frontmatter)),
      });
      for (const health of sensorHealth.filter((h) => h.quarantine_pending)) {
        const last = health.flaps.at(-1)!;
        findings.push({
          severity: "warn",
          code: "sensor-flaky",
          section: "Protection" as DoctorSection,
          message:
            `${health.memory_id} flapped ${health.flap_count}× on identical inputs. Last contradiction: ` +
            `${last.previous.at} ${last.previous.outcome} → ${last.current.at} ${last.current.outcome}.`,
          fix: "Run `hivelore sync` to demote it, fix the oracle, then `hivelore sensors promote <id> --yes`.",
        });
      }
      for (const health of sensorHealth.filter((h) => h.never_fired)) {
        findings.push({
          severity: "info",
          code: "sensor-never-fired",
          section: "Protection" as DoctorSection,
          message: `${health.memory_id} was evaluated ${health.evaluation_count} times across 30+ days and never fired — retirement candidate.`,
          fix: "Review the sensor manually; no automatic delete/retire command is provided.",
        });
      }

      // ── 4. Code-map freshness ─────────────────────────────────────────────
      const codeMap = await loadCodeMap(paths);
      if (!codeMap) {
        findings.push({
          severity: "warn",
          code: "no-code-map",
          message: "No code-map found — code_map MCP tool and symbol_locations are unavailable.",
          fix: "hivelore index code",
        });
      } else {
        const cmFile = codeMapPath(paths);
        const cmStat = await stat(cmFile);
        const ageDays = (now - cmStat.mtimeMs) / MS_PER_DAY;
        const indexedCount = Object.keys(codeMap.files).length;
        if (ageDays > 14) {
          findings.push({
            severity: "warn",
            code: "stale-code-map",
            message: `code-map is ${Math.round(ageDays)} days old (${indexedCount} files indexed).`,
            fix: "hivelore index code   # or rely on the post-merge git hook",
          });
        }
        // Detect a near-empty code-map: many source files on disk but few indexed (untracked source
        // or a structure the indexer missed). Silent before — on a real monorepo it indexed 2/1400+.
        const onDisk = await countSourceFilesOnDisk(root);
        if (isCodeMapNearEmpty(indexedCount, onDisk)) {
          findings.push({
            severity: "warn",
            code: "code-map-near-empty",
            message: `code-map indexed ${indexedCount} file(s) but ~${onDisk} source file(s) are on disk — most of your code is NOT indexed (untracked source, or nested repos the indexer can't reach).`,
            fix: "hivelore index code   # if files are untracked, commit them or check nested-repo setup",
          });
        }
      }

      // ── Friction agents hit with Hivelore itself ──
      // The journal is write-only from the agent's side, so without a nudge here nobody ever reads
      // it. Always `info`: this is feedback about the tooling, never a defect in the user's repo.
      try {
        const openFriction = groupFriction(
          await readFrictionReports(paths),
          await loadFrictionState(paths),
        ).filter((group) => group.status === "open");
        if (openFriction.length > 0) {
          const occurrences = openFriction.reduce((sum, group) => sum + group.count, 0);
          const top = openFriction[0]!;
          findings.push({
            severity: "info",
            code: "friction-unreviewed",
            section: "Corpus health" as DoctorSection,
            message:
              `${openFriction.length} unreviewed friction report${openFriction.length === 1 ? "" : "s"} ` +
              `from agent sessions (${occurrences} occurrence${occurrences === 1 ? "" : "s"}). ` +
              `Top: ${top.surface} — ${top.summary} (${top.count}×).`,
            fix: "hivelore report list",
          });
        }
      } catch {
        // The journal is best-effort telemetry; never fail doctor over it.
      }

      findings.push(...await collectHarnessCoverageFindings(codeMap, memories));
      findings.push(...collectBehaviourCoverageFindings(codeMap, memories));
      findings.push(...await collectSemanticIndexFindings(paths, config, memories.length, codeMap));

      // ── Behaviour-loop accounting: scaffolded post-incident tests that never became gates ──
      try {
        const scaffoldGaps = await collectScaffoldLoopGaps(paths);
        if (scaffoldGaps.length > 0) {
          findings.push({
            severity: "warn",
            code: "post-incident-test-unarmed",
            message:
              `${scaffoldGaps.length} post-incident test(s) are scaffolded but not armed as gates — the incident is documented, nothing deterministic guards it yet: ` +
              scaffoldGaps.slice(0, 5).map(describeScaffoldGap).join(", ") +
              (scaffoldGaps.length > 5 ? ", …" : "") + ".",
            fix: "Fill the pending assertion, run it, then arm it with the `hivelore sensors propose --kind test` command in the scaffold header.",
          });
        }
      } catch { /* best-effort — a scan error must not break doctor */ }

      // ── 5. Usage log signals ──────────────────────────────────────────────
      const events = await readUsageEvents(paths);
      if (events.length === 0) {
        findings.push({
          severity: "info",
          code: "no-usage-log",
          message: "No usage log entries — MCP server hasn't recorded any calls yet, or this project hasn't been used by an agent.",
        });
      } else {
        // Count searches that likely returned little (heuristic: same query repeated 3+ times)
        const queryRepeats = new Map<string, number>();
        for (const e of events) {
          if (!isSearchTool(e.tool)) continue;
          const key = (e.summary ?? "").toLowerCase().trim();
          if (!key) continue;
          if (isSyntheticSuggestionQuery(key)) continue;
          queryRepeats.set(key, (queryRepeats.get(key) ?? 0) + 1);
        }
        const repeated = [...queryRepeats.entries()].filter(([, n]) => n >= 3);
        if (repeated.length > 0) {
          findings.push({
            severity: "info",
            code: "recurring-searches",
            message: `${repeated.length} query${repeated.length === 1 ? "" : "ies"} repeated 3+ times — agents keep asking the same things.`,
            fix: `hivelore memory suggest --auto-save --top-n ${Math.min(5, repeated.length)}`,
          });
        }

        // Code-map calls that errored (returned 0 files even though indexed)
        const codeMapCalls = events.filter((e) => e.tool === "code_map").length;
        const briefingCalls = events.filter((e) => e.tool === "get_briefing").length;
        if (codeMapCalls > 0 && memories.length > 0) {
          // we only have summaries, not output; this stays informational
          findings.push({
            severity: "info",
            code: "tool-mix",
            message: `${briefingCalls} get_briefing call${briefingCalls === 1 ? "" : "s"}, ${codeMapCalls} code_map call${codeMapCalls === 1 ? "" : "s"} recorded.`,
          });
        }
      }

      // ── 6. Config sanity ──────────────────────────────────────────────────
      if (config.enforcement?.requireBriefingFirst) {
        const claudeSettings = path.join(root, ".claude", "settings.local.json");
        let hasClaudeEnforcement = false;
        if (existsSync(claudeSettings)) {
          try {
            const { readFile } = await import("node:fs/promises");
            const raw = await readFile(claudeSettings, "utf8");
            hasClaudeEnforcement =
              raw.includes("hivelore enforce session-start") &&
              raw.includes("hivelore enforce pre-tool-use");
          } catch {
            hasClaudeEnforcement = false;
          }
        }
        if (!hasClaudeEnforcement) {
          findings.push({
            severity: "info",
            code: "claude-enforcement-hooks-missing",
            message: "Hivelore enforcement is enabled, but project-scoped Claude Code hooks are not installed.",
            fix: "hivelore enforce install --claude-scope project",
          });
        }
      }
      if (!config.autoSessionEnd) {
        findings.push({
          severity: "info",
          code: "no-autopilot",
          message: "Autopilot is OFF — session recaps are not auto-saved on shutdown.",
          fix: "Edit .ai/hivelore.config.json: set autoSessionEnd: true (or re-run `hivelore init` without --manual).",
        });
      }

      // ── 7. Installation / integration version sanity ──────────────────────
      findings.push(...await collectInstallFindings(root, __HAIVE_VERSION__));
      findings.push(...await collectMcpRuntimeFindings(paths, __HAIVE_VERSION__));
      findings.push(...await collectToolchainFindings(root));

      // ── 8. Legacy standalone haive-mcp ──────────────────────────────────────
      // MCP runs inside `hivelore mcp --stdio` — updating @hivelore/cli is enough.
      // Warn only if an old global haive-mcp exists and disagrees with CLI.
      try {
        const legacyRaw = execSync("haive-mcp --version", {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const cliVersion = __HAIVE_VERSION__;
        if (legacyRaw && legacyRaw !== cliVersion) {
          findings.push({
            severity: "warn",
            code: "legacy-haive-mcp-stale",
            message:
              `Standalone haive-mcp on PATH is v${legacyRaw} but the CLI is v${cliVersion}. ` +
              `MCP is now bundled in the hivelore CLI itself — switch your client configs to ` +
              `command "hivelore" + args ["mcp", "--stdio"], then uninstall @hivelore/mcp.`,
            fix:
              `# 1. Run hivelore init to regenerate MCP configs pointing to bundled server:\n` +
              `hivelore init\n` +
              `# 2. Optionally remove the now-redundant standalone package:\n` +
              `npm uninstall -g @hivelore/mcp`,
          });
        }
      } catch {
        // haive-mcp not on PATH — expected when using bundled MCP via haive only
      }

      // ── 9. Legacy haive-mcp references in project MCP config files ──────────
      // Scan .mcp.json / .cursor/mcp.json / .vscode/mcp.json for old command references.
      {
        const configPaths = [
          path.join(root, ".mcp.json"),
          path.join(root, ".cursor", "mcp.json"),
          path.join(root, ".vscode", "mcp.json"),
        ];
        const staleConfigs: string[] = [];
        for (const cfgPath of configPaths) {
          if (!existsSync(cfgPath)) continue;
          try {
            const raw = await readFile(cfgPath, "utf8");
            if (raw.includes('"haive-mcp"') || raw.includes("'haive-mcp'")) {
              staleConfigs.push(path.relative(root, cfgPath));
              if (opts.fix && !opts.dryRun) {
                const updated = raw
                  .replace(/"command"\s*:\s*"haive-mcp"/g, '"command": "hivelore"')
                  .replace(/"args"\s*:\s*\[\]/g, '"args": ["mcp", "--stdio"]');
                await writeFile(cfgPath, updated, "utf8");
              }
            }
          } catch { /* ignore unreadable config */ }
        }
        if (staleConfigs.length > 0) {
          findings.push({
            severity: "warn",
            code: "legacy-mcp-config",
            message:
              `${staleConfigs.length} MCP config file${staleConfigs.length === 1 ? "" : "s"} still reference the old "haive-mcp" command: ` +
              staleConfigs.join(", ") +
              `. Run \`hivelore doctor --fix\` to auto-migrate to the bundled server.`,
            fix: "hivelore doctor --fix",
            section: "Protection" as DoctorSection,
          });
        }
      }

      if (repairs.length > 0) {
        findings.push({
          severity: "info",
          code: "autopilot-repairs-applied",
          message: repairs.map((repair) => repair.message).join(" "),
          section: "Next actions",
        });
      }

      emit(findings, opts, repairs);
    });
}

/** Reserve "near empty" for catastrophic misses, not files that legitimately expose no symbols. */
export function isCodeMapNearEmpty(indexedCount: number, sourceFilesOnDisk: number): boolean {
  return sourceFilesOnDisk >= 20 && indexedCount < sourceFilesOnDisk * 0.05;
}

interface McpRuntimeMarker {
  version?: string;
  pid?: number;
  started_at?: string;
}

export function mcpRuntimeVersionFinding(
  marker: McpRuntimeMarker,
  expectedVersion: string,
  processAlive: boolean,
): Finding | null {
  if (!processAlive || !marker.version || marker.version === expectedVersion) return null;
  return {
    severity: "warn",
    code: "active-mcp-server-stale",
    message:
      `An active MCP server is still v${marker.version} while the installed CLI is v${expectedVersion}. ` +
      "MCP clients keep server processes alive across package upgrades.",
    fix: "Restart the IDE/agent MCP client, then confirm get_briefing.server_version matches `hivelore --version`.",
    section: "Agent coverage",
  };
}

async function collectMcpRuntimeFindings(
  paths: ReturnType<typeof resolveHaivePaths>,
  expectedVersion: string,
): Promise<Finding[]> {
  const markerFile = path.join(paths.runtimeDir, "mcp-server.json");
  if (!existsSync(markerFile)) return [];
  try {
    const marker = JSON.parse(await readFile(markerFile, "utf8")) as McpRuntimeMarker;
    let alive = false;
    if (typeof marker.pid === "number") {
      try { process.kill(marker.pid, 0); alive = true; } catch { alive = false; }
    }
    const finding = mcpRuntimeVersionFinding(marker, expectedVersion, alive);
    return finding ? [finding] : [];
  } catch {
    return [];
  }
}

function emit(findings: Finding[], opts: DoctorOptions, repairs: AutopilotRepair[] = []): void {
  const classified = findings.map((finding) => ({
    ...finding,
    section: finding.section ?? sectionForFinding(finding),
  }));
  const scores = computeDoctorScores(classified);
  if (opts.json) {
    console.log(JSON.stringify({
      scores,
      findings: classified,
      sections: groupBySection(classified),
      next_actions: nextActions(classified),
      repairs,
      fix_mode: opts.fix ? opts.dryRun ? "dry-run" : "apply" : "off",
    }, null, 2));
    return;
  }
  if (classified.length === 0) {
    ui.success(repairs.length > 0 ? "Hivelore doctor — autopilot repairs applied." : "Hivelore doctor — no issues found.");
    return;
  }
  console.log(ui.bold(`Hivelore doctor — ${classified.length} finding${classified.length === 1 ? "" : "s"}`));
  console.log(
    ui.dim(
      `  protection=${scores.protection_score}  ` +
      `context=${scores.context_quality_score}  ` +
      `corpus=${scores.corpus_quality_score}  ` +
      `harness-coverage=${scores.harness_coverage_score}%`,
    ),
  );
  console.log();

  const sectionOrder: DoctorSection[] = [
    "Protection",
    "Agent coverage",
    "Context quality",
    "Corpus health",
    "Harness coverage",
    "Index health",
    "Next actions",
  ];
  const severityOrder: Severity[] = ["error", "warn", "info"];
  // Keep doctor ACTIONABLE: info findings are noise most of the time (pending review, no-usage-log,
  // …). Hide them by default (--all restores), but always show warn/error and the high-value coverage
  // metrics flagged alwaysShow. A one-line summary tells the reader how many were collapsed.
  const isVisible = (f: Finding): boolean => f.severity !== "info" || opts.all === true || f.alwaysShow === true;
  let hiddenInfo = 0;
  for (const section of sectionOrder) {
    const sectionFindings = classified.filter((f) => f.section === section);
    const visible = sectionFindings.filter(isVisible);
    hiddenInfo += sectionFindings.length - visible.length;
    if (visible.length === 0) continue;
    console.log(ui.bold(section));
    for (const sev of severityOrder) {
      for (const f of visible.filter((x) => x.severity === sev)) {
        const icon = sev === "error" ? ui.red("✗") : sev === "warn" ? ui.yellow("⚠") : ui.dim("ℹ");
        console.log(`${icon} ${ui.bold(f.code)}  ${f.message}`);
        if (opts.fix && f.fix) {
          for (const line of f.fix.split("\n")) {
            console.log(`     ${ui.dim(opts.dryRun ? "would run:" : "$")} ${line}`);
          }
        }
      }
    }
    console.log();
  }
  if (hiddenInfo > 0) {
    ui.info(`${hiddenInfo} informational finding(s) hidden — run \`hivelore doctor --all\` to show them.`);
  }

  if (repairs.length > 0) {
    console.log(ui.bold("Autopilot repairs applied"));
    for (const repair of repairs) console.log(`  ${ui.dim("✓")} ${repair.message}`);
    console.log();
  }

  const actions = nextActions(classified);
  if (actions.length > 0) {
    // Distinct from the "Next actions" findings section above — this is the flat command list.
    console.log(ui.bold("Suggested commands"));
    for (const action of actions.slice(0, 5)) {
      // Only shell-prompt-prefix lines that ARE commands; prose fixes read wrong behind a `$`.
      const isCommand = /^(hivelore|haive|git|npm|pnpm|npx|node|gh|rm|code|cd)\b/.test(action);
      console.log(`  ${ui.dim(isCommand ? "$" : "→")} ${action}`);
    }
  } else if (!opts.fix && classified.some((f) => f.fix)) {
    ui.info("Re-run with --fix to see suggested commands.");
  }
}

function sectionForFinding(finding: Finding): DoctorSection {
  if (
    finding.code.includes("haive") ||
    finding.code.includes("integration") ||
    finding.code.includes("claude") ||
    finding.code.includes("autopilot")
  ) return "Agent coverage";
  if (
    finding.code.includes("context") ||
    finding.code.includes("briefing") ||
    finding.code.includes("search")
  ) return "Context quality";
  if (finding.code.includes("harness-coverage")) return "Harness coverage";
  if (finding.code.includes("code-map") || finding.code.includes("index")) return "Index health";
  if (
    finding.code.includes("memory") ||
    finding.code.includes("anchor") ||
    finding.code.includes("pending") ||
    finding.code.includes("decay")
  ) return "Corpus health";
  if (finding.severity === "error") return "Protection";
  return "Next actions";
}

function computeDoctorScores(findings: Finding[]): DoctorScores {
  const scoreFor = (sections: DoctorSection[]): number => {
    const scoped = findings.filter((f) => sections.includes(f.section ?? sectionForFinding(f)));
    const penalty = scoped.reduce((sum, f) => {
      if (f.severity === "error") return sum + 35;
      if (f.severity === "warn") return sum + 15;
      return sum + 4;
    }, 0);
    return Math.max(0, 100 - penalty);
  };
  const coverageFinding = findings.find((f) => f.code === "harness-coverage");
  const harnessCoverageScore = coverageFinding?.coverage_percent ?? 0;
  return {
    protection_score: scoreFor(["Protection", "Agent coverage"]),
    context_quality_score: scoreFor(["Context quality", "Index health"]),
    corpus_quality_score: scoreFor(["Corpus health"]),
    harness_coverage_score: harnessCoverageScore,
  };
}

function groupBySection(findings: Finding[]): Record<DoctorSection, Finding[]> {
  const out: Record<DoctorSection, Finding[]> = {
    "Protection": [],
    "Agent coverage": [],
    "Context quality": [],
    "Corpus health": [],
    "Harness coverage": [],
    "Index health": [],
    "Next actions": [],
  };
  for (const finding of findings) out[finding.section ?? sectionForFinding(finding)].push(finding);
  return out;
}

function nextActions(findings: Finding[]): string[] {
  return [...new Set(findings.flatMap((finding) => finding.fix ? finding.fix.split("\n") : []))]
    .filter(Boolean);
}

/**
 * Files that are low-value anchoring targets: test files, build configs, and type
 * declaration files don't represent production logic worth protecting with memories.
 * Excluding them from the denominator makes the coverage percentage meaningful.
 */
function isLowValueCoverageFile(file: string): boolean {
  const lower = file.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (lower.includes(".test.") || lower.includes(".spec.")) return true;
  if (lower.includes("/__tests__/") || lower.includes("/test/") || lower.includes("/tests/")) return true;
  if (lower.endsWith(".d.ts")) return true;
  if (base === "tsup.config.ts" || base === "vitest.config.ts" || base === "jest.config.ts") return true;
  if (base.endsWith(".config.ts") || base.endsWith(".config.js")) return true;
  if (base === "vite.config.ts" || base === "vite.config.js") return true;
  return false;
}

async function collectHarnessCoverageFindings(
  codeMap: Awaited<ReturnType<typeof loadCodeMap>>,
  memories: LoadedMemory[],
): Promise<Finding[]> {
  if (!codeMap) return [];
  const allFiles = Object.keys(codeMap.files);
  // Exclude test files and build configs from the denominator — only production
  // source files are meaningful anchor targets for harness coverage.
  const codeFiles = allFiles.filter((f) => !isLowValueCoverageFile(f));
  const total = codeFiles.length;
  if (total === 0) return [];

  const validatedWithAnchors = memories.filter(
    (m) =>
      (m.memory.frontmatter.status === "validated" || m.memory.frontmatter.status === "proposed") &&
      m.memory.frontmatter.anchor.paths.length > 0,
  );

  const coveredFiles = new Set<string>();
  for (const m of validatedWithAnchors) {
    for (const anchorPath of m.memory.frontmatter.anchor.paths) {
      const normalized = anchorPath.replace(/^\/+/, "");
      for (const codeFile of codeFiles) {
        if (
          codeFile === normalized ||
          codeFile.startsWith(normalized + "/") ||
          normalized.startsWith(codeFile + "/")
        ) {
          coveredFiles.add(codeFile);
        }
      }
    }
  }

  const covered = coveredFiles.size;
  const pct = Math.round((covered / total) * 100);

  // Top uncovered files — prefer root-level and common source directories
  const uncovered = codeFiles
    .filter((f) => !coveredFiles.has(f))
    .sort((a, b) => {
      // Prefer shorter paths (key modules tend to be near the root)
      const depthA = a.split("/").length;
      const depthB = b.split("/").length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b);
    })
    .slice(0, 5);

  const coverageDesc =
    pct < 10 && total > 10
      ? "Low coverage — add memory anchors on key modules to improve harness enforcement."
      : pct < 50
      ? "Partial coverage — useful but not yet broad enough to call the harness mature."
      : pct < 80
      ? "Good coverage — critical modules are increasingly protected."
      : "Good harness coverage.";

  const uncoveredHint = uncovered.length > 0
    ? `\n  Top uncovered: ${uncovered.map((f) => `\`${f}\``).join(", ")}`
    : "";

  const findings: Finding[] = [];
  findings.push({
    severity: "info",
    code: "harness-coverage",
    alwaysShow: true,
    coverage_percent: pct,
    message:
      `${covered}/${total} code-map files have validated memory anchors (${pct}%). ` +
      coverageDesc + uncoveredHint,
    fix: pct < 50 && total > 10
      ? `hivelore memory save --type gotcha|convention|architecture --paths <key-file> --scope team`
      : undefined,
    section: "Harness coverage",
  });

  return findings;
}

/**
 * Behaviour-harness coverage — the visible MEASURE for the branch Hivelore leads. Reports, per main
 * code area, whether a behavioural oracle (test/shell sensor) guards it, how many are armed (block),
 * and how many are red-proven. Always info: the behaviour harness is opt-in and the hardest to fill,
 * so this surfaces progress without nagging (the unarmed-scaffold and command-sensors-disabled
 * findings already nag on the actionable gaps).
 */
function collectBehaviourCoverageFindings(
  codeMap: Awaited<ReturnType<typeof loadCodeMap>>,
  memories: LoadedMemory[],
): Finding[] {
  if (!codeMap) return [];
  const codeFiles = Object.keys(codeMap.files);
  const cov = assessBehaviourCoverage({ memories, codeFiles });
  // Stay silent only when there is genuinely nothing to report. If oracles are armed we still surface
  // them even when no main area could be derived (a small/flat repo) — the branch Hivelore leads must
  // acknowledge behavioural protection wherever it exists, not vanish on the smallest repos.
  if (cov.mainAreas.length === 0 && cov.totalOracles === 0) return [];

  const uncoveredHint =
    cov.uncoveredAreas.length > 0 && cov.totalOracles > 0
      ? `\n  No behavioural oracle: ${cov.uncoveredAreas.slice(0, 5).map((a) => `\`${a}\``).join(", ")}` +
        (cov.uncoveredAreas.length > 5 ? `, +${cov.uncoveredAreas.length - 5} more` : "")
      : "";

  // Close the loop: for each uncovered area, print the exact next command. When a lesson already
  // exists there, scaffold a behavioural oracle from it (with the just-shipped --red-ref); otherwise
  // capture the incident first. Falls back to the arm-warn-only hint when every area IS covered.
  let fix: string | undefined;
  if (cov.uncoveredAreas.length > 0) {
    const lines = cov.uncoveredAreaSuggestions.slice(0, 4).map((s) =>
      s.candidateLessonId
        ? `hivelore sensors scaffold ${s.candidateLessonId} --red-ref <pre-fix-commit>   # guard ${s.area}`
        : `hivelore memory tried --paths ${s.area}/ --what "<incident>" --why-failed "<why>"   # then scaffold --red-ref for ${s.area}`,
    );
    if (cov.uncoveredAreas.length > 4) lines.push(`# +${cov.uncoveredAreas.length - 4} more uncovered area(s) — run doctor after guarding these`);
    fix = lines.join("\n");
  } else if (cov.armedOracles < cov.totalOracles || cov.redProvenOracles < cov.armedOracles) {
    fix = "Arm warn-only oracles to `block` and re-propose with `--red-ref` so each substantiates its incident.";
  }

  return [{
    severity: "info",
    code: "behaviour-coverage",
    alwaysShow: true,
    section: "Protection" as DoctorSection,
    coverage_percent: cov.mainAreas.length > 0
      ? Math.round((cov.areasWithOracle.length / cov.mainAreas.length) * 100)
      : (cov.totalOracles > 0 ? 100 : 0),
    message: `Behaviour harness: ${renderBehaviourCoverageLine(cov)}.` + uncoveredHint,
    fix,
  }];
}

async function collectSemanticIndexFindings(
  paths: ReturnType<typeof resolveHaivePaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  memoryCount: number,
  codeMap: Awaited<ReturnType<typeof loadCodeMap>>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const autoWantsCodeSearch = Boolean(config.autopilot || config.autoRepair?.codeSearch);
  let mod: typeof import("@hivelore/embeddings");
  try {
    mod = await import("@hivelore/embeddings");
  } catch {
    findings.push({
      severity: autoWantsCodeSearch ? "warn" : "info",
      code: "embeddings-unavailable",
      message:
        "@hivelore/embeddings is not available, so get_briefing falls back to lexical ranking and code_search cannot run.",
      fix: "npm install -g @hivelore/embeddings@latest\nhivelore index status",
      section: "Index health",
    });
    return findings;
  }

  if (memoryCount > 0) {
    const stat = await mod.indexStat(paths).catch(() => ({ exists: false, count: 0 }));
    if (!stat.exists || stat.count === 0) {
      findings.push({
        severity: "warn",
        code: "semantic-memory-index-missing",
        message:
          "Memory embeddings index is missing or empty; get_briefing will report literal_fallback instead of semantic ranking.",
        fix: "hivelore index memories",
        section: "Index health",
      });
    }
  }

  if (autoWantsCodeSearch || codeMap) {
    const codeIndex = await mod.loadCodeIndex(paths).catch(() => null);
    if (!codeIndex || codeIndex.entries.length === 0) {
      findings.push({
        severity: autoWantsCodeSearch ? "warn" : "info",
        code: "code-search-index-missing",
        message:
          "Code-search embeddings index is missing or empty; MCP code_search is unavailable until it is built.",
        fix: "hivelore index code-search",
        section: "Index health",
      });
    } else if (codeMap && codeIndex.source_generated_at !== codeMap.generated_at) {
      findings.push({
        severity: "info",
        code: "code-search-index-outdated",
        message:
          "Code-search embeddings index was built from an older code-map; semantic code search may miss recent symbols.",
        fix: "hivelore index code-search",
        section: "Index health",
      });
    }
  }

  return findings;
}

function isSearchTool(name: string): boolean {
  return ["mem_search", "code_search", "mem_relevant_to", "get_briefing"].includes(name);
}

async function collectInstallFindings(root: string, expectedVersion: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  findings.push(...await collectWorkspaceVersionFindings(root, expectedVersion));
  findings.push(...await collectDistFreshnessFindings(root, expectedVersion));

  const haiveBins = listHaiveBins();
  if (haiveBins.length === 0) {
    findings.push({
      severity: "warn",
      code: "haive-not-on-path",
      message: "No `hivelore` (or legacy `haive`) binary was found on PATH. Hooks and MCP configs that call it may fail.",
      fix: `npm install -g @hivelore/cli@${expectedVersion}`,
    });
  } else {
    const first = haiveBins[0]!;
    const firstVersion = versionForBinary(first);
    if (firstVersion && firstVersion !== expectedVersion) {
      findings.push({
        severity: "warn",
        code: "path-haive-version-mismatch",
        message: `PATH resolves the CLI to ${first} (${firstVersion}), but this build expects ${expectedVersion}.`,
        fix: `npm install -g @hivelore/cli@${expectedVersion}\nwhich -a hivelore haive`,
      });
    }
    const skewed = haiveBins
      .map((bin) => ({ bin, version: versionForBinary(bin) }))
      .filter((item) => item.version && item.version !== expectedVersion);
    if (skewed.length > 0) {
      findings.push({
        severity: "info",
        code: "multiple-haive-binaries",
        message:
          `Found ${haiveBins.length} hivelore/haive binar${haiveBins.length === 1 ? "y" : "ies"} on PATH; ` +
          `${skewed.length} do not match ${expectedVersion}.`,
        fix: "Remove stale global installs or ensure hooks call the intended `hivelore` binary.",
      });
    }
  }

  const integrationFiles = [
    ".git/hooks/pre-commit",
    ".git/hooks/pre-push",
    ".claude/settings.local.json",
    ".mcp.json",
    ".cursor/mcp.json",
    ".vscode/mcp.json",
  ];
  // Dedupe by binary: the same broken/stale path is usually referenced by several integration files
  // (pre-commit, pre-push, .mcp.json…). Emit ONE finding per unique binary that lists the files,
  // instead of one per occurrence (which produced 3× identical warnings).
  const missingBins = new Map<string, Set<string>>();
  const staleBins = new Map<string, { version: string; files: Set<string> }>();
  for (const rel of integrationFiles) {
    const file = path.join(root, rel);
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    for (const bin of extractAbsoluteHaiveBins(text)) {
      const version = versionForBinary(bin);
      if (!version) {
        (missingBins.get(bin) ?? missingBins.set(bin, new Set()).get(bin)!).add(rel);
      } else if (version !== expectedVersion) {
        const entry = staleBins.get(bin) ?? staleBins.set(bin, { version, files: new Set() }).get(bin)!;
        entry.files.add(rel);
      }
    }
  }
  for (const [bin, files] of missingBins) {
    findings.push({
      severity: "warn",
      code: "integration-haive-binary-missing",
      message: `${[...files].join(", ")} reference ${bin}, but it could not be executed.`,
      fix: "Run `hivelore agent setup --no-global` or `hivelore enforce install` to rewrite project integrations.",
    });
  }
  for (const [bin, { version, files }] of staleBins) {
    findings.push({
      severity: "warn",
      code: "integration-haive-version-mismatch",
      message: `${[...files].join(", ")} reference ${bin} (${version}), but current Hivelore is ${expectedVersion}.`,
      fix: "Run `hivelore agent setup --no-global` and `hivelore enforce install` to refresh stale paths.",
    });
  }

  return findings;
}

async function collectToolchainFindings(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pkg = await readJson<{ packageManager?: string; scripts?: Record<string, string> }>(
    path.join(root, "package.json"),
  );
  const wantsPnpm = pkg?.packageManager?.startsWith("pnpm@") ||
    Object.values(pkg?.scripts ?? {}).some((script) => /\bpnpm\b/.test(script));
  if (!wantsPnpm) return findings;

  const expected = pkg?.packageManager?.replace(/^pnpm@/, "") ?? "9.14.2";
  if (!commandExists("pnpm", ["--version"])) {
    const corepackAvailable = commandExists("corepack", ["--version"]);
    findings.push({
      severity: "warn",
      code: "pnpm-not-on-path",
      message:
        `This workspace uses pnpm${expected ? ` ${expected}` : ""}, but no pnpm binary is available on PATH. ` +
        `Local build/test commands may fail even though CI works.`,
      fix: corepackAvailable
        ? `corepack prepare pnpm@${expected} --activate`
        : `npx pnpm@${expected} install --frozen-lockfile`,
      section: "Agent coverage",
    });
  }
  return findings;
}

async function collectDistFreshnessFindings(root: string, expectedVersion: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const isHaiveWorkspace =
    ["hivelore-monorepo", "haive-monorepo"].includes((await readJson<{ name?: string }>(path.join(root, "package.json")))?.name ?? "");
  if (!isHaiveWorkspace) return findings;

  const cliDist = path.join(root, "packages/cli/dist/index.js");
  if (!existsSync(cliDist)) {
    findings.push({
      severity: "warn",
      code: "workspace-dist-missing",
      message: "packages/cli/dist/index.js is missing; local Hivelore smoke commands cannot reflect source changes.",
      fix: "pnpm -r build",
      section: "Agent coverage",
    });
    return findings;
  }

  const distVersion = versionForNodeEntrypoint(cliDist);
  if (distVersion && distVersion !== expectedVersion) {
    findings.push({
      severity: "warn",
      code: "workspace-dist-version-mismatch",
      message:
        `packages/cli/dist/index.js reports ${distVersion}, but this source build expects ${expectedVersion}. ` +
        `Run a fresh workspace build after pull before trusting local doctor/enforce output.`,
      fix: "pnpm -r build\npnpm check:artifacts",
      section: "Agent coverage",
    });
  }

  const sourceFiles = [
    "packages/core/src/index.ts",
    "packages/mcp/src/server.ts",
    "packages/cli/src/index.ts",
  ].map((rel) => path.join(root, rel)).filter(existsSync);
  if (sourceFiles.length > 0) {
    const distMtime = statSync(cliDist).mtimeMs;
    const newestSource = Math.max(...sourceFiles.map((file) => statSync(file).mtimeMs));
    if (newestSource > distMtime + 1000) {
      findings.push({
        severity: "info",
        code: "workspace-dist-older-than-source",
        message:
          "Built CLI artifacts are older than key source files; rebuild before running release smoke checks.",
        fix: "pnpm -r build\npnpm check:artifacts",
        section: "Agent coverage",
      });
    }
  }

  return findings;
}

async function collectWorkspaceVersionFindings(root: string, expectedVersion: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const rootPkg = await readJson<{ name?: string; version?: string }>(path.join(root, "package.json"));
  const workspacePackages = [
    "packages/core/package.json",
    "packages/embeddings/package.json",
    "packages/cli/package.json",
    "packages/mcp/package.json",
  ];
  const existing = (await Promise.all(workspacePackages.map(async (rel) => ({
    rel,
    pkg: await readJson<{ name?: string; version?: string }>(path.join(root, rel)),
  })))).filter((item) => item.pkg);

  const isHaiveWorkspace = rootPkg?.name === "hivelore-monorepo" || rootPkg?.name === "haive-monorepo" ||
    existing.some((item) => item.pkg?.name?.startsWith("@hivelore/"));
  if (!isHaiveWorkspace) return findings;

  if (rootPkg?.version && rootPkg.version !== expectedVersion) {
    findings.push({
      severity: "warn",
      code: "repo-root-version-mismatch",
      message: `Root package.json is ${rootPkg.version}, but the active Hivelore build is ${expectedVersion}.`,
      fix: `Update root package.json to ${expectedVersion} before tagging/publishing.`,
      section: "Agent coverage",
    });
  }

  const skewed = existing.filter((item) => item.pkg?.version !== expectedVersion);
  if (skewed.length > 0) {
    findings.push({
      severity: "warn",
      code: "workspace-package-version-mismatch",
      message:
        `Workspace package version skew: ` +
        skewed.map((item) => `${item.rel}=${item.pkg?.version ?? "missing"}`).join(", ") +
        `; expected ${expectedVersion}.`,
      fix: `Bump @hivelore/core, @hivelore/embeddings, @hivelore/cli and @hivelore/mcp to ${expectedVersion}.`,
      section: "Agent coverage",
    });
  }

  findings.push(...collectGlobalHivemoduleFindings(expectedVersion));
  return findings;
}

function collectGlobalHivemoduleFindings(expectedVersion: string): Finding[] {
  try {
    const raw = execSync(
      "npm list -g --depth=0 --json @hivelore/cli @hivelore/mcp @hivelore/core @hivelore/embeddings",
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, { version?: string }> };
    const deps = parsed.dependencies ?? {};
    const important = ["@hivelore/cli", "@hivelore/mcp"];
    const staleImportant = important
      .map((name) => ({ name, version: deps[name]?.version }))
      .filter((item) => item.version && item.version !== expectedVersion);
    const staleTopLevel = ["@hivelore/core", "@hivelore/embeddings"]
      .map((name) => ({ name, version: deps[name]?.version }))
      .filter((item) => item.version && item.version !== expectedVersion);
    const findings: Finding[] = [];
    if (staleImportant.length > 0) {
      findings.push({
        severity: "warn",
        code: "global-haive-version-mismatch",
        message:
          `Global Hivelore CLI/MCP package skew: ` +
          staleImportant.map((item) => `${item.name}@${item.version}`).join(", ") +
          `; expected ${expectedVersion}.`,
        fix: `npm install -g @hivelore/cli@${expectedVersion} @hivelore/mcp@${expectedVersion}`,
        section: "Agent coverage",
      });
    }
    if (staleTopLevel.length > 0) {
      findings.push({
        severity: "info",
        code: "global-haive-top-level-stale",
        message:
          `Older top-level global packages are installed but may be unused: ` +
          staleTopLevel.map((item) => `${item.name}@${item.version}`).join(", ") +
          `. Active CLI/MCP dependencies should still be checked by hivelore --version and haive-mcp --version.`,
        fix: "npm uninstall -g @hivelore/core @hivelore/embeddings",
        section: "Agent coverage",
      });
    }
    return findings;
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function listHaiveBins(): string[] {
  // Transition: the CLI ships both `hivelore` (primary) and `haive` (legacy alias) bins.
  const found: string[] = [];
  for (const name of ["hivelore", "haive"]) {
    try {
      found.push(...execSync(`which -a ${name}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean));
    } catch { /* not on PATH under this name */ }
  }
  return found;
}

function versionForBinary(bin: string): string | null {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function versionForNodeEntrypoint(file: string): string | null {
  try {
    const out = execFileSync(process.execPath, [file, "--version"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function commandExists(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function extractAbsoluteHaiveBins(text: string): string[] {
  const out = new Set<string>();
  const re = /(["'\s])((?:\/[^"'\s]+)*\/haive)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const p = match[2];
    if (!p) continue;
    // Skip paths that are directories — a haive binary is a file, not a folder.
    // This prevents env-var values like HAIVE_PROJECT_ROOT being mistaken for binaries.
    try {
      if (statSync(p).isDirectory()) continue;
    } catch {
      // Path does not exist — still add so we can report it as missing
    }
    out.add(p);
  }
  return [...out].sort();
}
