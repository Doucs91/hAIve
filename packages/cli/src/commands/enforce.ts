import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  antiPatternGateParams,
  appendSensorEvaluations,
  assessSensorHealth,
  sensorPromotedAtMap,
  assessBootstrapState,
  addedLineNumbersFromDiff,
  detectSensorWeakening,
  isSensorScannablePath,
  findProjectRoot,
  loadCodeMap,
  renderBootstrapChecklist,
  findUncapturedFailures,
  handoffAgeMs,
  hasRecentBriefingMarker,
  isFreshIsoDate,
  isRetiredMemory,
  loadConfig,
  detectAgentContext,
  loadMemoriesFromDir,
  loadMemoriesFromDirDetailed,
  classifyLockstepPublication,
  classifyGithubRelease,
  compareVersions,
  buildBaselineHealthFinding,
  computeBaselineHealth,
  decideVerdict,
  dedupeRefusals,
  describePosture,
  resolveGatePolicy,
  CONTENT_CATCH_CODES,
  SETUP_GATE_CODES,
  shouldExpandGateReminder,
  recordGateReminder,
  loadSensorLedger,
  memoryMatchesAnchorPaths,
  readRecentBriefingMarker,
  recordPreventionHits,
  resolveBriefingBudget,
  incidentSuffix,
  resolveHaivePaths,
  runSensors,
  runPresenceSensors,
  changedPathsFromDiff,
  saveConfig,
  selectCommandSensors,
  sensorTargetsFromDiff,
  sensorAppliesToPath,
  SESSION_RECAP_TTL_MS,
  verifyAnchor,
  writeBriefingMarker,
  type AntiPatternGate,
  type CommandSensorSpec,
  type LoadedMemory,
  type HaiveConfig,
} from "@hivelore/core";
import type { GateFinding, BaselineHealth } from "@hivelore/core";
import { astEngineAvailable, getBriefing, preCommitCheck, runAstSensorOnContent } from "@hivelore/mcp";
import { ui } from "../utils/ui.js";
import { installClaudeHooksAtPath, uninstallClaudeHooksAtPath, defaultClaudeSettingsPath } from "../utils/claude-hooks.js";
import { executeCommandSensors } from "../utils/command-sensors.js";
import { commandScopeHash, evaluation, gitHeadSha } from "../utils/sensor-evaluations.js";
import { applyAutopilotRepairs } from "../utils/autopilot.js";
import { collectScaffoldLoopGaps, describeScaffoldGap } from "../utils/post-incident-scan.js";

declare const __HAIVE_VERSION__: string;

const execFileAsync = promisify(execFile);

const MAX_STDIN_BYTES = 256 * 1024;
const ENFORCE_HOOK_MARKER = "# Hivelore enforcement hook";

/**
 * Remove every Hivelore-owned block from a git-hook script, in BOTH the current and the legacy
 * (`# hAIve enforcement hook` → direct `haive …` call) shapes, returning only foreign content.
 *
 * Why this exists: `installGitEnforcement` keyed idempotency on the *current* marker string, so a
 * repo installed before the v0.51.0 `haive`→`hivelore` rename (whose hook says `# hAIve …`) was not
 * recognised as ours and the new block was APPENDED below the stale one — a two-block hook whose dead
 * `haive` line runs first and aborts every commit (`haive: not found`). We must detect ours by family
 * (any Hivelore/hAIve marker or the `_hivelore()` resolver) and replace, never append.
 *
 * A block spans its marker comment through the next Hivelore/hAIve invocation line (the one with `||`),
 * so the resolver function body in between is consumed. Shebang lines are dropped (a fresh one is added
 * by the caller) so a previously-appended duplicate can't leave a stray `#!/bin/sh` mid-script. Pure.
 */
export function stripHiveloreHookBlock(content: string): string {
  const markerRe = /^\s*#\s*(?:hivelore|h[aA]ive)\b.*\bhook\b/i;
  const invocationRe = /^\s*_?(?:hivelore|haive)\b.*\|\|/i;
  const shebangRe = /^\s*#!.*\bsh\b/;
  const out: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    if (inBlock) {
      if (invocationRe.test(line)) inBlock = false; // consume through the invocation line
      continue;
    }
    if (markerRe.test(line)) { inBlock = true; continue; }
    if (shebangRe.test(line)) continue; // drop shebangs; the caller re-adds exactly one
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Idempotent hook content: our block wholesale when the file is ours (or empty), else the preserved
 * foreign script followed by our block (a genuine husky/custom hook is never clobbered).
 */
export function buildHookFileContent(current: string, ownBody: string): string {
  const foreign = stripHiveloreHookBlock(current);
  if (!foreign) return ownBody;
  const ownWithoutShebang = ownBody.replace(/^\s*#!.*\n/, "");
  return `#!/bin/sh\n${foreign}\n\n${ownWithoutShebang}`;
}

interface HookPayload {
  cwd?: string;
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface EnforceOptions {
  dir?: string;
  task?: string;
  source?: string;
  sessionId?: string;
  json?: boolean;
  stage?: "local" | "pre-commit" | "pre-push" | "ci";
  strict?: boolean;
  claude?: boolean;
  claudeScope?: string;
  claudeSettings?: string;
  removeClaude?: boolean;
  git?: boolean;
  ci?: boolean;
  explain?: boolean;
  verbose?: boolean;
}

interface FinishOptions {
  dir?: string;
  json?: boolean;
  explain?: boolean;
  wait?: boolean;
  waitTimeout?: string;
}

/**
 * Shape of a gate finding. Defined in `@hivelore/core` (gate-verdict.ts) alongside the decision
 * logic that consumes it; aliased here so the command file reads the same as before.
 */
type EnforcementFinding = GateFinding;
type EnforcementScore = BaselineHealth;

interface EnforcementReport {
  root: string;
  initialized: boolean;
  mode: "off" | "advisory" | "strict";
  /** The hook/stage this report was built for — named in the pass line so two hooks firing on one
   * `git` action (pre-commit then pre-push) read as distinct stages, not a duplicated print. */
  stage?: "local" | "pre-commit" | "pre-push" | "ci";
  /** Who this run binds: "agent (…signals)" or "human — …". Absent for early-exit reports. */
  actor?: string;
  /** Effective gate posture and any explicit overrides — see `describePosture`. */
  posture?: string;
  score: EnforcementScore;
  should_block: boolean;
  findings: EnforcementFinding[];
  categories: {
    blocking: EnforcementFinding[];
    review: EnforcementFinding[];
    info: EnforcementFinding[];
  };
}

export function registerEnforce(program: Command): void {
  // Back-compat alias (v0.32.0): `install-hooks [git|claude]` was merged into `enforce install`
  // — the second hook generator it carried was a recurring drift source. Old invocations keep
  // working; the command is hidden from help.
  program
    .command("install-hooks [target]", { hidden: true })
    .option("-d, --dir <dir>", "project root")
    .option("--force", "(ignored — Hivelore-owned hooks are always refreshed, foreign hooks appended)")
    .option("--scope <scope>", "claude: 'user' (~/.claude) or 'project' (.claude/)", "user")
    .option("--uninstall", "claude: remove previously installed hooks")
    .option("--settings <path>", "claude: explicit settings.json path")
    .action(async (target: string | undefined, opts: { dir?: string; scope?: string; uninstall?: boolean; settings?: string }) => {
      const t = (target ?? "git").toLowerCase();
      const root = findProjectRoot(opts.dir);
      if (t === "git") {
        await installGitEnforcement(root);
        return;
      }
      if (t === "claude") {
        const settingsPath = opts.settings ?? defaultClaudeSettingsPath(opts.scope === "project" ? "project" : "user", root);
        if (opts.uninstall) {
          const result = await uninstallClaudeHooksAtPath(settingsPath);
          ui.success(`Removed Hivelore hooks from ${result.settingsPath}`);
        } else {
          const result = await installClaudeHooksAtPath(settingsPath);
          ui.success(`${result.created ? "Created" : "Patched"} Claude Code hooks (${result.settingsPath})`);
        }
        return;
      }
      ui.error(`Unknown target: ${target}. Use \`hivelore enforce install\` (git + claude + ci).`);
      process.exitCode = 1;
    });

  const enforce = program
    .command("enforce")
    .description(
      "Agent-agnostic enforcement helpers: install policy gates, report status, and block unsafe workflows.",
    );

  enforce
    .command("install")
    .description("Install Hivelore enforcement across MCP config, git hooks, CI template, and supported client hooks.")
    .option("-d, --dir <dir>", "project root")
    .option("--no-git", "skip git pre-commit/pre-push enforcement hooks")
    .option("--no-claude", "skip Claude Code hooks")
    .option("--claude-scope <scope>", "where to write Claude Code hooks: 'project' (.claude/) or 'user' (~/.claude)", "project")
    .option("--claude-settings <path>", "explicit path to a Claude settings.json")
    .option("--remove-claude", "remove previously installed Claude Code hooks instead of installing")
    .option("--no-ci", "skip GitHub Actions enforcement workflow")
    .action(async (opts: EnforceOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      await mkdir(paths.haiveDir, { recursive: true });
      const current = await loadConfig(paths);
      await saveConfig(paths, {
        ...current,
        enforcement: {
          ...current.enforcement,
          mode: "strict",
          requireBriefingFirst: true,
          requireSessionRecap: true,
          requireMemoryVerify: true,
          blockStaleDecisionChanges: true,
          requireDecisionCoverage: true,
          scoreThreshold: 85,
          cleanupGeneratedArtifacts: true,
          toolProfile: "enforcement",
          policyPacks: ["architecture", "gotchas", "security", "domain", "release"],
        },
      });
      ui.success("Hivelore strict enforcement enabled in .ai/hivelore.config.json");

      if (opts.git !== false) await installGitEnforcement(root);
      if (opts.ci !== false) await installCiEnforcement(root);
      if (opts.claude !== false) {
        const claudeScope = opts.claudeScope === "user" ? "user" as const : "project" as const;
        const settingsPath = opts.claudeSettings ?? defaultClaudeSettingsPath(claudeScope, root);
        try {
          if (opts.removeClaude) {
            const result = await uninstallClaudeHooksAtPath(settingsPath);
            ui.success(`Removed Hivelore hooks from ${result.settingsPath}`);
          } else {
            const result = await installClaudeHooksAtPath(settingsPath);
            ui.success(`${result.created ? "Created" : "Patched"} Claude Code hooks (${path.relative(root, result.settingsPath) || result.settingsPath})`);
          }
        } catch (err) {
          ui.warn(`Claude Code hooks not ${opts.removeClaude ? "removed" : "installed"}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      ui.info("Agent-agnostic gates are now active at workflow level: MCP, git, CI, and optional client hooks.");
      ui.info("Use `hivelore run -- <agent command>` for agents that do not expose blocking hooks.");
    });

  enforce
    .command("status")
    .description("Show whether this project has agent-agnostic Hivelore enforcement installed.")
    .option("-d, --dir <dir>", "project root")
    .option("--explain", "group findings by blocking/review/info and show repair commands", false)
    .option("--verbose", "show every check (including the passing ones), not just what needs action", false)
    .option("--json", "emit JSON", false)
    .action(async (opts: EnforceOptions) => {
      const report = await buildEnforcementReport(opts.dir, "local");
      printReport(report, Boolean(opts.json), Boolean(opts.explain), !opts.explain && !opts.verbose);
      if (report.should_block) process.exitCode = 1;
    });

  enforce
    .command("check")
    .description("Run the Hivelore policy gate. Intended for pre-commit, pre-push, wrappers, and any agent client.")
    .option("-d, --dir <dir>", "project root")
    .option("--stage <stage>", "local | pre-commit | pre-push | ci", "local")
    .option("--explain", "group findings by blocking/review/info and show repair commands", false)
    .option("--verbose", "show every check (including the passing ones), not just what needs action", false)
    .option("--json", "emit JSON", false)
    .action(async (opts: EnforceOptions) => {
      const stage = opts.stage ?? "local";
      const report = await buildEnforcementReport(opts.dir, stage);
      // Compact on the interactive/commit paths; CI, --explain and --verbose keep the full report.
      const quiet = stage !== "ci" && !opts.explain && !opts.verbose;
      printReport(report, Boolean(opts.json), Boolean(opts.explain), quiet);
      if (report.should_block) process.exit(2);
    });

  enforce
    .command("cleanup")
    .description("Remove generated Hivelore runtime/cache artifacts that should not appear in commits.")
    .option("-d, --dir <dir>", "project root")
    .option("--dry-run", "print what would be removed without deleting", false)
    .action(async (opts: EnforceOptions & { dryRun?: boolean }) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const cacheDir = path.join(paths.haiveDir, ".cache");
      if (existsSync(cacheDir)) {
        if (opts.dryRun) ui.info(`would clean ${path.relative(root, cacheDir)} (preserving .gitignore)`);
        else {
          const removed = await cleanupCacheDir(cacheDir);
          ui.success(`cleaned ${path.relative(root, cacheDir)}${removed > 0 ? ` (${removed} item${removed === 1 ? "" : "s"} removed)` : ""}`);
        }
      }
      if (existsSync(paths.runtimeDir)) {
        if (opts.dryRun) ui.info(`would clean ${path.relative(root, paths.runtimeDir)} (preserving briefing markers)`);
        else {
          const removed = await cleanupRuntimeDir(paths.runtimeDir);
          ui.success(`cleaned ${path.relative(root, paths.runtimeDir)}${removed > 0 ? ` (${removed} item${removed === 1 ? "" : "s"} removed)` : ""}`);
        }
      }
    });

  enforce
    .command("ci")
    .description("CI entrypoint: fail if the repository violates Hivelore enforcement policy.")
    .option("-d, --dir <dir>", "project root")
    .option("--explain", "group findings by blocking/review/info and show repair commands", false)
    .option("--json", "emit JSON", false)
    .action(async (opts: EnforceOptions) => {
      const report = await buildEnforcementReport(opts.dir, "ci");
      printReport(report, Boolean(opts.json), Boolean(opts.explain));
      if (report.should_block) process.exit(2);
    });

  enforce
    .command("finish")
    .alias("completion")
    .description(
      "Final agent-exit gate: verify the git sync/release protocol before reporting a task done.",
    )
    .option("-d, --dir <dir>", "project root")
    .option("--explain", "group findings by blocking/review/info and show repair commands", false)
    .option("--wait", "poll GitHub Actions until the runs for HEAD complete instead of failing on pending CI", false)
    .option("--wait-timeout <minutes>", "max minutes to wait for CI with --wait", "15")
    .option("--json", "emit JSON", false)
    .action(async (opts: FinishOptions) => {
      let report = await buildFinishReport(opts.dir);
      if (opts.wait) {
        // Replaces the manual `gh run watch <id>` ritual: keep re-checking while the ONLY
        // blocker is CI that hasn't finished (or hasn't appeared yet right after a push).
        const WAIT_CODES = new Set(["github-actions-pending", "github-actions-runs-missing"]);
        const deadline = Date.now() + Math.max(1, Number(opts.waitTimeout ?? 15)) * 60_000;
        const onlyWaitingOnCi = (r: EnforcementReport): boolean =>
          r.should_block &&
          r.findings.some((f) => f.severity === "error" && WAIT_CODES.has(f.code)) &&
          !r.findings.some((f) => f.severity === "error" && !WAIT_CODES.has(f.code));
        while (onlyWaitingOnCi(report) && Date.now() < deadline) {
          if (!opts.json) ui.info("GitHub Actions still running for HEAD — rechecking in 20s (--wait)…");
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          report = await buildFinishReport(opts.dir);
        }
      }
      printReport(report, Boolean(opts.json), Boolean(opts.explain));
      if (report.should_block) {
        if (!opts.json) printNextRequiredAction(report);
        process.exit(2);
      }
    });

  enforce
    .command("commit-msg <msgfile>")
    .description(
      "git commit-msg hook: block a CI-skip directive in a commit that also changes shippable code " +
      "(GitHub scans the whole message and would skip CI for the entire push). `.ai/`-only sync commits are allowed.",
    )
    .option("-d, --dir <dir>", "project root")
    .action(async (msgfile: string, opts: EnforceOptions) => {
      const root = findProjectRoot(opts.dir);
      const verdict = await checkCommitMessageSkipCi(root, msgfile);
      if (verdict.block) {
        ui.error(verdict.message);
        process.exit(1);
      }
    });

  enforce
    .command("session-start")
    .description("Claude Code SessionStart hook: inject briefing and write a local briefing marker.")
    .option("-d, --dir <dir>", "project root")
    .option("--task <text>", "task text to rank memories")
    .option("--source <name>", "marker source", "claude-session-start")
    .option("--session-id <id>", "agent session id")
    .action(async (opts: EnforceOptions) => {
      const payload = await readHookPayload();
      const root = resolveRoot(opts.dir, payload);
      if (!root) return;
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.haiveDir)) return;
      await mkdir(paths.runtimeDir, { recursive: true });
      const sessionId = opts.sessionId ?? payload.session_id;
      const task = opts.task ?? payload.prompt ?? "Start an AI coding session in this Hivelore-initialized project.";
      await applyLightweightRepairs(root, paths);

      const budget = resolveBriefingBudget("quick", {
        max_tokens: 2500,
        max_memories: 5,
        include_module_contexts: false,
      });
      const briefing = await getBriefing(
        {
          task,
          files: [],
          max_tokens: budget.max_tokens,
          max_memories: budget.max_memories,
          include_project_context: true,
          include_module_contexts: budget.include_module_contexts,
          semantic: true,
          include_stale: false,
          track: true,
          format: "actions",
          symbols: [],
          min_semantic_score: 0.25,
          budget_preset: "quick",
        },
        { paths },
      );
      await writeBriefingMarker(paths, {
        sessionId,
        task,
        source: opts.source ?? "claude-session-start",
        memoryIds: briefing.memories.map((m) => m.id),
      });

      console.log("Hivelore briefing loaded. Agents must consult this before editing.");
      if (briefing.last_session) {
        console.log(`\n## Last session\n${briefing.last_session.body.slice(0, 1200)}`);
      }
      if (briefing.project_context?.content) {
        console.log(`\n## Project context\n${briefing.project_context.content.slice(0, 1800)}`);
      }
      if (briefing.memories.length > 0) {
        console.log("\n## Relevant memories");
        for (const memory of briefing.memories.slice(0, 6)) {
          console.log(`\n### ${memory.id} (${memory.scope}/${memory.type}, ${memory.confidence})`);
          console.log(memory.body.slice(0, 1000));
        }
      }
      for (const warning of briefing.setup_warnings) {
        console.log(`\n[setup warning] ${warning}`);
      }
    });

  enforce
    .command("pre-tool-use")
    .description("Claude Code PreToolUse hook: surface the relevant team policy for the edited file (advise; configurable to block).")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: EnforceOptions) => {
      const payload = await readHookPayload();
      const root = resolveRoot(opts.dir, payload);
      if (!root) return;
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.haiveDir)) return;
      if (!isWriteLikeTool(payload)) return;

      const config = await loadConfig(paths);
      if (config.enforcement?.requireBriefingFirst === false) return;
      const gate = config.enforcement?.preEditGate ?? "advise";

      const targetFiles = extractToolPaths(payload, root);
      const hasMarker = await hasRecentBriefingMarker(paths, payload.session_id);
      const missing = targetFiles.length > 0
        ? await missingRequiredMemoriesForFiles(paths, targetFiles, payload.session_id)
        : [];

      // Clean pass: a recent briefing exists and the touched files carry no un-surfaced policy.
      if (hasMarker && missing.length === 0) return;

      // Auto-resolve: record the relevant policy for the touched files into the briefing marker so
      // the agent gets credit for it AND the commit-time decision-coverage gate accumulates coverage
      // as the agent edits — no separate `hivelore briefing` command needed.
      if (targetFiles.length > 0) {
        await recordFilesIntoBriefingMarker(paths, targetFiles, missing, payload.session_id)
          .catch(() => { /* best-effort */ });
      }

      const contextText = buildPreEditContext(payload.tool_name ?? "write tool", targetFiles, missing, hasMarker);

      if (gate === "block") {
        // Legacy strict behaviour: block — but with the actual content and no separate command.
        // The relevant policy is already recorded, so simply re-issuing the edit passes.
        console.error(
          contextText +
          "\n\nThe relevant context is now recorded — re-issue the same edit to proceed " +
          "(no `hivelore briefing` command needed). To make this advisory instead of blocking, set " +
          '`{ "enforcement": { "preEditGate": "advise" } }` in .ai/hivelore.config.json.',
        );
        process.exit(2);
      }

      // advise (default): inject the context into the agent and ALLOW the edit — zero round-trip.
      // Commit-time decision-coverage + CI enforcement remain the hard backstops.
      emitPreToolUseContext(contextText);
    });
}

/**
 * Record the validated policy memories anchored to the touched files into the briefing marker,
 * unioned with whatever is already there. Mirrors what `hivelore briefing --files` records, so the
 * commit-time decision-coverage gate accumulates coverage as the agent edits (no broad re-briefing).
 */
async function recordFilesIntoBriefingMarker(
  paths: ReturnType<typeof resolveHaivePaths>,
  files: string[],
  missing: LoadedMemory[],
  sessionId?: string,
): Promise<void> {
  const existing = await readRecentBriefingMarker(paths, sessionId);
  const ids = new Set<string>(existing?.memory_ids ?? []);
  for (const { memory } of missing) ids.add(memory.frontmatter.id);
  await writeBriefingMarker(paths, {
    sessionId,
    task: existing?.task ?? "pre-edit auto-briefing",
    source: "haive-pre-edit",
    files,
    memoryIds: [...ids],
  });
}

/** Build the context block surfaced to the agent at edit time (the actual memory bodies). */
function buildPreEditContext(
  tool: string,
  files: string[],
  missing: LoadedMemory[],
  hasMarker: boolean,
): string {
  const lines: string[] = ["Hivelore — relevant team policy for this edit", `Tool: ${tool}`];
  if (files.length > 0) lines.push(`Files: ${files.slice(0, 6).join(", ")}`);
  if (missing.length > 0) {
    lines.push("", "Consult these before editing (anchored to the files you are touching):");
    for (const { memory } of missing.slice(0, 5)) {
      const fm = memory.frontmatter;
      lines.push("", `### ${fm.id}  (${fm.scope}/${fm.type})`, memory.body.trim().slice(0, 900));
    }
  } else if (!hasMarker) {
    lines.push(
      "",
      "No team briefing was loaded yet this session. Proceeding — but for substantive work call " +
      "get_briefing / mem_relevant_to for richer context.",
    );
  }
  return lines.join("\n");
}

/** Emit a Claude Code PreToolUse hook result that injects context for the model WITHOUT blocking. */
function emitPreToolUseContext(text: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: text,
      },
    }),
  );
}

/**
 * Behaviour-loop accounting at the exit gate: a scaffolded post-incident test whose assertion is
 * still pending, or whose lesson has no armed command sensor, means the incident is documented but
 * nothing deterministic guards it yet. Warn-only NUDGE (impact 0) — it must never block a finish,
 * only make the open loop impossible to close the task around without seeing it.
 */
async function checkPostIncidentScaffolds(
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<EnforcementFinding[]> {
  try {
    const gaps = await collectScaffoldLoopGaps(paths);
    if (gaps.length === 0) return [];
    return [{
      severity: "warn",
      code: "post-incident-test-unarmed",
      message:
        `${gaps.length} post-incident test(s) are scaffolded but not yet armed as gates: ` +
        gaps.slice(0, 5).map(describeScaffoldGap).join(", ") +
        (gaps.length > 5 ? ", …" : "") + ".",
      fix: "Fill the pending assertion, run the test, then arm it: the scaffold header contains the exact `hivelore sensors propose --kind test` command.",
      memory_ids: [...new Set(gaps.map((g) => g.memory_id))].slice(0, 10),
      impact: 0,
    }];
  } catch {
    return []; // best-effort nudge — a scan error must never affect the exit gate
  }
}

/**
 * Demote findings to advisory: an `error` becomes a `warn` and stops costing score.
 *
 * `enforce finish` mixes three natures of check, and only the first is Hivelore's mandate:
 * KNOWLEDGE (uncaptured failure, stale corpus) blocks; GIT HYGIENE warns; INFRASTRUCTURE STATE
 * (someone's CI quota, a flaky runner) is none of a knowledge tool's business. Blocking on the last
 * two makes the exit gate unpassable for reasons the agent cannot fix, and the only available exit
 * is to ignore it — which also discards the checks that were right (field report 2026-09-04 §5).
 */
function advisoryOnly(findings: EnforcementFinding[]): EnforcementFinding[] {
  return findings.map((finding) =>
    finding.severity === "error" ? { ...finding, severity: "warn" as const, impact: 0 } : finding,
  );
}

async function buildFinishReport(dir: string | undefined): Promise<EnforcementReport> {
  const root = findProjectRoot(dir);
  const paths = resolveHaivePaths(root);
  const initialized = existsSync(paths.haiveDir);
  const config = initialized ? await loadConfig(paths) : {};
  // Resolve the posture FIRST: `mode` is one of the switches a posture supplies, so defaulting it
  // to "strict" before asking the policy would make enforcement.posture="advisory" unreachable.
  const gatePolicy = resolveGatePolicy(config.enforcement);
  const mode = gatePolicy.mode;
  const findings: EnforcementFinding[] = [];

  if (!initialized) {
    return withCategories({
      root,
      initialized,
      mode,
      score: buildScore([], config.enforcement?.scoreThreshold),
      should_block: true,
      findings: [{
        severity: "error",
        code: "not-initialized",
        message: "This repository is not initialized with Hivelore.",
        fix: "Run `hivelore init` or `hivelore enforce install`.",
        impact: 100,
      }],
    });
  }

  findings.push(...await checkFailureCapture(paths, config));
  findings.push(...await checkPostIncidentScaffolds(paths));
  // First-agent bootstrap is a PROJECT, not a precondition for finishing one bugfix. Blocking here
  // made `finish` unpassable for entire sessions, and its only fix ("invoke the bootstrap_repo MCP
  // prompt") is unreachable whenever the MCP layer is down — which is exactly when the gate fires.
  // A rule that cannot be satisfied does not teach the rule, it teaches ignoring the gate, and that
  // discredits `github-actions-pass` alongside it (field reports 2026-09-02 §3.3, 2026-09-04 §5).
  // Kept as a warning so the gap stays visible; enforcement lives at pre-push/ci where it belongs.
  findings.push(...advisoryOnly(await checkBootstrapComplete(paths, config, true, "pre-push")));

  const status = await getGitSyncStatus(root);
  if (!status.available) {
    findings.push({
      severity: "error",
      code: "git-unavailable",
      message: "Git status could not be inspected, so Hivelore cannot verify the exit protocol.",
      fix: "Run `git status` manually, then commit/push according to the Hivelore git-sync protocol.",
      impact: 100,
    });
    return finishReport(root, initialized, mode, findings, config);
  }

  const shippableDirty = status.dirtyFiles.filter(isShippablePath);
  // Hivelore regenerates `.ai/code-map.json` on every sync and it is git-tracked, so a `finish` run
  // that just refreshed it would block on its OWN artifact ("dirty worktree") — the tool creating
  // its own blocker (field report §4.4). A deterministic, regenerable index is not the agent's
  // uncommitted work, so it must not gate the exit. (project-context.md stays in — it is human content.)
  const isHiveloreRegenerated = (f: string): boolean => f === ".ai/code-map.json";
  const regeneratedOnly = status.dirtyFiles.filter(isHiveloreRegenerated);
  const dirtyFiles = status.dirtyFiles.filter((f) => !isHiveloreRegenerated(f));
  const untrackedFiles = status.untrackedFiles.filter((f) => !isHiveloreRegenerated(f));
  // Untracked files need a different sentence AND a different fix than modified ones: they are
  // resolved by committing them *or* by ignoring them. Calling them "modified" sends the developer
  // hunting for a change that does not exist — and a file left untracked-and-unignored keeps the
  // worktree dirty forever, blocking this gate on every later task.
  const modifiedCount = dirtyFiles.length - untrackedFiles.length;
  const untrackedOnly = dirtyFiles.length > 0 && modifiedCount === 0;
  // Untracked-only is git HYGIENE, not lost work: nothing tracked was modified, so there is no
  // change at risk of being left behind. It blocked sessions on files Hivelore itself had just
  // written (`mem_save` creates a memory, then the exit gate refuses to close because that memory is
  // untracked) — the tool manufacturing its own blocker. Warn, and keep blocking real uncommitted
  // work (field report 2026-09-04 §5).
  const hygieneOnly = untrackedOnly && shippableDirty.length === 0;
  if (dirtyFiles.length > 0) {
    findings.push({
      severity: hygieneOnly ? "warn" : "error",
      code: shippableDirty.length > 0 ? "git-sync-uncommitted-shippable" : "git-sync-uncommitted-changes",
      message: shippableDirty.length > 0
        ? `${shippableDirty.length} shippable file(s) are not committed.`
        : untrackedOnly
          ? `${untrackedFiles.length} file(s) are untracked — neither committed nor ignored.`
          : untrackedFiles.length > 0
            ? `${dirtyFiles.length} file(s) are uncommitted (${modifiedCount} modified, ${untrackedFiles.length} untracked).`
            : `${dirtyFiles.length} file(s) are modified but not committed.`,
      fix: shippableDirty.length > 0
        ? "Bump the lockstep package version if needed, then `git add`, `git commit`, `git tag vX.Y.Z`, `git push && git push origin vX.Y.Z` (not `--tags`)."
        : untrackedOnly
          ? "Commit them — or add them to .gitignore if they are meant to stay local. Untracking a file without ignoring it leaves the worktree permanently dirty."
          : "Commit and push these changes before reporting the task done.",
      reason: "The multi-agent git-sync decision requires agents to leave completed work committed and pushed, not as a local diff.",
      affected_files: dirtyFiles.slice(0, 12),
      impact: hygieneOnly ? 0 : 100,
    });
    // Only a real blocker short-circuits: a hygiene warning must not hide the checks that follow
    // (release protocol, CI verdict) behind an untracked scratch file.
    if (!hygieneOnly) return finishReport(root, initialized, mode, findings, config);
  }

  if (regeneratedOnly.length > 0) {
    findings.push({
      severity: "info",
      code: "hivelore-artifact-regenerated",
      message: `Ignoring ${regeneratedOnly.length} Hivelore-regenerated artifact(s) left uncommitted: ${regeneratedOnly.join(", ")}.`,
      fix: "Optional: `git add .ai/code-map.json && git commit` to keep it in sync — it is deterministic and safe to commit.",
    });
  }

  if (!hygieneOnly) {
    findings.push({
      severity: "ok",
      code: "git-worktree-clean",
      message: "No uncommitted worktree changes remain.",
    });
  }

  if (!status.upstream) {
    findings.push({
      severity: "warn",
      code: "git-sync-no-upstream",
      message: "This branch has no upstream, so Hivelore cannot verify that commits/tags were pushed.",
      fix: "Set an upstream with `git push -u origin <branch>`.",
      impact: 15,
    });
    return finishReport(root, initialized, mode, findings, config);
  }

  if (status.behind > 0) {
    findings.push({
      severity: "error",
      code: "git-sync-behind-upstream",
      message: `This branch is ${status.behind} commit(s) behind ${status.upstream}.`,
      fix: "Run `git pull --ff-only` and resolve any conflicts before finishing.",
      impact: 40,
    });
  }

  if (status.ahead > 0) {
    findings.push({
      severity: "error",
      code: "git-sync-unpushed-commits",
      message: `This branch is ${status.ahead} commit(s) ahead of ${status.upstream}.`,
      fix: "Run `git push` before reporting the task done.",
      reason: "The multi-agent git-sync decision requires agents to push completed commits.",
      impact: 60,
    });
  } else {
    findings.push({
      severity: "ok",
      code: "git-sync-pushed",
      message: `Branch is not ahead of ${status.upstream}.`,
    });
  }

  const releaseChangedFiles = status.releaseChangedFiles ?? status.changedSinceUpstream;
  const releaseBaseRef = status.releaseBaseRef ?? status.upstream;
  const shippableChanged = releaseChangedFiles.filter(isShippablePath);
  if (shippableChanged.length === 0) {
    findings.push({
      severity: "ok",
      code: "release-version-not-required",
      message: "No shippable package code changed since upstream; no version/tag required.",
    });
    findings.push(...await verifyGithubActionsForHead(root, status));
    return finishReport(root, initialized, mode, findings, config);
  }

  findings.push({
    severity: "info",
    code: "release-shippable-changes",
    message: `${shippableChanged.length} shippable file(s) changed since ${releaseBaseRef}.`,
    affected_files: shippableChanged.slice(0, 12),
  });

  // Release discipline (version bump + tag) is a HARD gate only on the configured release branch.
  // On feature/* or an integration branch like `develop`, the bump/tag happen when releasing from
  // that branch — so here the same findings are advisory (warn), never blocking the agent's exit.
  const releaseBranch = config.enforcement?.releaseBranch ?? "main";
  const onReleaseBranch = !status.branch || status.branch === releaseBranch;
  const releaseSeverity: EnforcementFinding["severity"] = onReleaseBranch ? "error" : "warn";
  const offBranchNote = onReleaseBranch
    ? ""
    : ` (advisory on '${status.branch}'; enforced when releasing from '${releaseBranch}')`;

  const versionState = await inspectReleaseVersionState(root, releaseBaseRef);
  if (!versionState.lockstep) {
    findings.push({
      severity: "error",
      code: "release-version-not-lockstep",
      message: `Publishable package versions are not in lockstep: ${versionState.localVersionsLabel}.`,
      fix: "Set root, core, cli, mcp, and embeddings package.json versions to the same X.Y.Z.",
      impact: 60,
    });
    return finishReport(root, initialized, mode, findings, config);
  }

  const version = versionState.version;
  if (!version) {
    findings.push({
      severity: "error",
      code: "release-version-unreadable",
      message: "Could not read the lockstep package version.",
      fix: "Verify package.json files are valid JSON.",
      impact: 60,
    });
    return finishReport(root, initialized, mode, findings, config);
  }

  if (versionState.baseVersion && compareSemver(version, versionState.baseVersion) <= 0) {
    findings.push({
      severity: releaseSeverity,
      code: "release-version-missing",
      message: `Shippable code changed, but version stayed at ${version} (base: ${versionState.baseVersion})${offBranchNote}.`,
      fix: "Bump the lockstep package version (patch by default), commit the bump, tag it, then push code and tags.",
      impact: onReleaseBranch ? 70 : 0,
    });
  } else {
    findings.push({
      severity: "ok",
      code: "release-version-bumped",
      message: versionState.baseVersion
        ? `Lockstep version bumped from ${versionState.baseVersion} to ${version}.`
        : `Lockstep version is ${version}.`,
    });
  }

  const tag = `v${version}`;
  const localTagAtHead = await tagPointsAtHead(root, tag);
  if (!localTagAtHead) {
    findings.push({
      severity: releaseSeverity,
      code: "release-tag-missing",
      message: `Expected git tag ${tag} to point at HEAD${offBranchNote}.`,
      fix: `Run \`git tag ${tag}\` after committing the version bump.`,
      impact: onReleaseBranch ? 50 : 0,
    });
  } else {
    findings.push({
      severity: "ok",
      code: "release-tag-present",
      message: `Tag ${tag} points at HEAD.`,
    });
  }

  const remoteTag = await remoteTagExists(root, tag);
  if (remoteTag === false) {
    findings.push({
      severity: releaseSeverity,
      code: "release-tag-unpushed",
      message: `Tag ${tag} is not present on the remote${offBranchNote}.`,
      fix: `Run \`git push origin ${tag}\` (avoid \`git push --tags\` — it fails on pre-existing divergent tags).`,
      impact: onReleaseBranch ? 50 : 0,
    });
  } else if (remoteTag === true) {
    findings.push({
      severity: "ok",
      code: "release-tag-pushed",
      message: `Tag ${tag} exists on the remote.`,
    });
  } else {
    findings.push({
      severity: "warn",
      code: "release-tag-remote-unverified",
      message: `Could not verify whether tag ${tag} exists on the remote.`,
      fix: `Run \`git push origin ${tag}\` if you have not already (avoid \`git push --tags\`).`,
      impact: 10,
    });
  }

  findings.push(...await verifyGithubActionsForHead(root, status));
  findings.push(...await verifyNpmPublication(root, version, config));
  findings.push(...await verifyGithubRelease(root, version, config));
  return finishReport(root, initialized, mode, findings, config);
}


/**
 * Registry side of the release chain. The verdict logic is pure and lives in
 * `core/npm-publication.ts`; this resolves the package name, asks the registry, and lists the tags.
 * Best-effort throughout: no registry, no network, a private package or none at all are all
 * "cannot tell", never a failure. Off with `enforcement.npmPublishCheck: "off"`.
 */
async function verifyNpmPublication(
  root: string,
  version: string,
  config: HaiveConfig,
): Promise<EnforcementFinding[]> {
  if (config.enforcement?.npmPublishCheck === "off") return [];

  // EVERY lockstep package, not a representative one. Publication is per-package, so the set can
  // land partially — and a partial set is the state that actually breaks installs (see
  // classifyLockstepPublication). Asking only the first publishable manifest made 0.60.0 report
  // "publish is the next step" about core while @hivelore/mcp was missing and the CLI uninstallable.
  const packageNames = await publishablePackageNames(root);
  if (packageNames.length === 0) return []; // nothing is published from here — stay silent rather than add noise

  const packages = await Promise.all(packageNames.map(async (packageName) => {
    const published = await runCommand("npm", ["view", packageName, "version"], root)
      .then((out) => out.trim())
      .catch(() => null);
    const publishedVersion = published && /^\d/.test(published) ? published : null;
    return {
      packageName,
      publishedVersion,
      taggedBetween: publishedVersion ? await taggedVersionsBetween(root, publishedVersion, version) : [],
    };
  }));

  const verdict = classifyLockstepPublication({
    localVersion: version,
    packages,
    publishHint: `\`gh workflow run release -f tag=v${version}\` or \`pnpm run publish:all\``,
  });
  return [{
    severity: verdict.severity,
    code: verdict.code,
    message: verdict.message,
    ...(verdict.fix ? { fix: verdict.fix } : {}),
    ...(verdict.severity === "warn" ? { impact: 10 } : {}),
  }];
}

/**
 * Announcement side of the release chain. The verdict logic is pure and lives in
 * `core/github-release.ts`; this lists the tags and asks GitHub which of them have a Release.
 *
 * Best-effort, exactly like the npm check: no `gh`, no auth, no network or a non-GitHub remote all
 * resolve to "cannot tell". Off with `enforcement.githubReleaseCheck: "off"`.
 */
async function verifyGithubRelease(
  root: string,
  version: string,
  config: HaiveConfig,
): Promise<EnforcementFinding[]> {
  if (config.enforcement?.githubReleaseCheck === "off") return [];

  const taggedVersions = await versionTags(root);
  if (taggedVersions.length === 0) return [];

  const verdict = classifyGithubRelease({
    localVersion: version,
    releasedVersions: await publishedReleaseVersions(root),
    taggedVersions,
    releaseHint: `\`gh release create v${version} --verify-tag --notes-file <notes>\``,
  });
  if (!verdict) return [];

  return [{
    severity: verdict.severity,
    code: verdict.code,
    message: verdict.message,
    ...(verdict.fix ? { fix: verdict.fix } : {}),
    ...(verdict.severity === "warn" ? { impact: 10 } : {}),
  }];
}

/**
 * Versions that have a published GitHub Release, or null when the question could not be asked.
 *
 * Drafts are excluded deliberately: a draft is not visible to anyone but the maintainer, so
 * counting it as shipped would report a release nobody can install. `--json` output is parsed
 * rather than the human table, which changes format between `gh` versions.
 */
async function publishedReleaseVersions(root: string): Promise<string[] | null> {
  const raw = await runCommand(
    "gh",
    ["release", "list", "--limit", "200", "--json", "tagName,isDraft"],
    root,
  ).catch(() => null);
  if (raw === null) return null;

  try {
    const rows = JSON.parse(raw) as { tagName?: unknown; isDraft?: unknown }[];
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((r) => r.isDraft !== true && typeof r.tagName === "string")
      .map((r) => (r.tagName as string).trim().replace(/^v/, ""))
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  } catch {
    return null;
  }
}

/** Every `vX.Y.Z` tag in the repo, `v` stripped. Non-semver tags (`vscode-0.6.1`) are not releases. */
async function versionTags(root: string): Promise<string[]> {
  const tags = (await runCommand("git", ["tag", "--list", "v*"], root).catch(() => ""))
    .split("\n")
    .map((line) => line.trim().replace(/^v/, ""))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  return [...new Set(tags)];
}

/**
 * Every package this repo publishes at the lockstep version. Derived from the files that already
 * carry that version rather than hardcoded, so this works outside this repo: private manifests are
 * skipped (a private root package.json contributes nothing), and a single-package repo resolves to
 * the one name. Order follows VERSION_FILES, which is stable, so the report reads the same each run.
 */
async function publishablePackageNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const file of VERSION_FILES) {
    const manifest = await readFile(path.join(root, file), "utf8")
      .then((raw) => JSON.parse(raw) as { name?: unknown; private?: unknown })
      .catch(() => null);
    if (!manifest || manifest.private === true) continue;
    if (typeof manifest.name === "string" && manifest.name.length > 0 && !names.includes(manifest.name)) {
      names.push(manifest.name);
    }
  }
  return names;
}

/** Version tags strictly between what npm has and what HEAD carries — the ones that were skipped. */
async function taggedVersionsBetween(root: string, after: string, before: string): Promise<string[]> {
  return (await versionTags(root))
    .filter((v) => compareSemver(v, after) > 0 && compareSemver(v, before) < 0)
    .sort(compareSemver);
}

/**
 * Failure-capture gate: hard failures observed this session (`hivelore observe` tagged them
 * `failure_hint`) that were never written down as a lesson are a silent-repeat risk. Surface them
 * (gate=warn, default) or block finish (gate=block). A failure is "captured" once an attempt/gotcha
 * lesson was recorded after it. Off by config opt-out — the signal has false positives (a `grep`
 * that finds nothing exits non-zero), so the default is advisory, not blocking.
 */
async function checkFailureCapture(
  paths: ReturnType<typeof resolveHaivePaths>,
  config: HaiveConfig,
): Promise<EnforcementFinding[]> {
  const gate = config.enforcement?.failureCaptureGate ?? "warn";
  if (gate === "off") return [];

  const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
  if (!existsSync(obsFile)) return [];

  const failures: { ts: string; tool: string; summary: string }[] = [];
  try {
    const raw = await readFile(obsFile, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed) as { ts?: string; tool?: string; summary?: string; failure_hint?: boolean };
        if (o.failure_hint && o.ts) failures.push({ ts: o.ts, tool: o.tool ?? "?", summary: o.summary ?? "" });
      } catch { /* skip corrupt line */ }
    }
  } catch {
    return [];
  }
  if (failures.length === 0) return [];

  const memories = existsSync(paths.memoriesDir) ? await loadMemoriesFromDir(paths.memoriesDir) : [];
  const captureTimes = memories
    .filter(({ memory }) => ["attempt", "gotcha"].includes(memory.frontmatter.type))
    .map(({ memory }) => memory.frontmatter.created_at);

  const uncaptured = findUncapturedFailures(failures, captureTimes);
  if (uncaptured.length === 0) {
    return [{
      severity: "ok",
      code: "failure-capture-clean",
      message: "No uncaptured hard failures from this session.",
    }];
  }

  // Passive capture (Phase 2) may already have distilled these into proposed drafts — point the
  // agent at the review step instead of asking it to re-type what the harness observed.
  const autoDrafts = memories.filter(
    ({ memory }) =>
      memory.frontmatter.status === "proposed" && memory.frontmatter.tags.includes("auto-captured"),
  );

  return [{
    severity: gate === "block" ? "error" : "info",
    code: "uncaptured-failures",
    message:
      `${uncaptured.length} hard failure(s) this session were never captured as a lesson (mem_tried).` +
      (autoDrafts.length > 0
        ? ` ${autoDrafts.length} auto-captured draft(s) are waiting for review: ${autoDrafts.slice(0, 3).map(({ memory }) => memory.frontmatter.id).join(", ")}${autoDrafts.length > 3 ? ", …" : ""}.`
        : ""),
    fix: autoDrafts.length > 0
      ? "Review the auto-captured drafts (`hivelore memory list --status proposed`) — approve, refine, or reject; call `mem_tried` only for failures the drafts missed."
      : "Call `mem_tried` (or `hivelore memory tried`) for each real failure so the next session doesn't repeat it. False positives (e.g. a grep that found nothing) can be ignored.",
    reason: "Harness ratchet: a mistake that isn't written down gets re-introduced. Set enforcement.failureCaptureGate to 'off' to disable, or 'block' to hard-fail.",
    affected_files: uncaptured.slice(0, 8).map((f) => `${f.tool}: ${f.summary}`.slice(0, 100)),
    ...(gate === "block" ? { impact: 30 } : {}),
  }];
}

function finishReport(
  root: string,
  initialized: boolean,
  mode: EnforcementReport["mode"],
  findings: EnforcementFinding[],
  config: HaiveConfig,
): EnforcementReport {
  const score = buildScore(findings, config.enforcement?.scoreThreshold);
  const hasErrors = findings.some((f) => f.severity === "error");
  return withCategories({
    root,
    initialized,
    mode,
    score,
    should_block: mode === "strict" && hasErrors,
    findings,
  });
}

export async function runWithEnforcement(
  command: string,
  args: string[],
  opts: { dir?: string; task?: string },
): Promise<void> {
  const root = findProjectRoot(opts.dir);
  const paths = resolveHaivePaths(root);
  if (!existsSync(paths.haiveDir)) {
    ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
    process.exit(1);
  }

  const sessionId = `haive-run-${process.pid}-${Date.now()}`;
  const task = opts.task ?? `Run agent command: ${[command, ...args].join(" ")}`;
  await writeBriefingMarker(paths, {
    sessionId,
    task,
    source: "haive-run",
  });
  const briefingFile = await writeWrapperBriefing(paths, sessionId, task);

  const before = await buildEnforcementReport(root, "local", sessionId);
  const blocking = before.findings.filter((f) => f.severity === "error" && f.code !== "session-recap-missing");
  if (blocking.length > 0) {
    printReport({ ...before, should_block: true, findings: blocking }, false);
    process.exit(2);
  }

  ui.info(`Hivelore briefing marker created for wrapped agent session: ${sessionId}`);
  ui.info(`Briefing written to ${path.relative(root, briefingFile)} and exported as HAIVE_BRIEFING_FILE`);
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      HAIVE_PROJECT_ROOT: root,
      HAIVE_SESSION_ID: sessionId,
      HAIVE_BRIEFING_FILE: briefingFile,
      HAIVE_ENFORCEMENT: "strict",
      HAIVE_AGENT: "1", // wrapped process is an agent — process gates bind it (detectAgentContext)
      HIVELORE_TOOL_PROFILE: process.env.HIVELORE_TOOL_PROFILE ?? process.env.HAIVE_TOOL_PROFILE ?? "enforcement",
    },
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) process.exit(128);
      process.exitCode = code ?? 0;
      // Passive capture for hook-less agents: a wrapped agent that exits non-zero is a failure
      // observation, same stream the Claude Code PostToolUse hook feeds — session-end --auto
      // distills it into a proposed draft. Best-effort, never affects the exit code.
      if ((code ?? 0) !== 0) {
        const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
        void mkdir(path.dirname(obsFile), { recursive: true })
          .then(() => writeFile(obsFile, "", { flag: "a" }))
          .then(() => writeFile(
            obsFile,
            JSON.stringify({
              ts: new Date().toISOString(),
              session_id: sessionId,
              tool: "AgentRun",
              summary: `wrapped agent exited ${code}: ${[command, ...args].join(" ").slice(0, 180)}`,
              failure_hint: true,
            }) + "\n",
            { flag: "a" },
          ))
          .catch(() => { /* telemetry must never break the wrapper */ })
          .finally(() => resolve());
        return;
      }
      resolve();
    });
  });
}

async function writeWrapperBriefing(
  paths: ReturnType<typeof resolveHaivePaths>,
  sessionId: string,
  task: string,
): Promise<string> {
  await applyLightweightRepairs(paths.root, paths);
  const budget = resolveBriefingBudget("quick", {
    max_tokens: 2500,
    max_memories: 5,
    include_module_contexts: false,
  });
  const briefing = await getBriefing({
    task,
    files: [],
    max_tokens: budget.max_tokens,
    max_memories: budget.max_memories,
    include_project_context: true,
    include_module_contexts: budget.include_module_contexts,
    semantic: true,
    include_stale: false,
    track: true,
    format: "actions",
    symbols: [],
    min_semantic_score: 0.25,
    budget_preset: "quick",
  }, { paths });
  await writeBriefingMarker(paths, {
    sessionId,
    task,
    source: "haive-run",
    memoryIds: briefing.memories.map((m) => m.id),
  });
  const dir = path.join(paths.runtimeDir, "enforcement", "briefings");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.md`);
  const parts = [
    "# Hivelore Briefing",
    "",
    `Task: ${task}`,
    "",
  ];
  if (briefing.last_session) parts.push("## Last Session", briefing.last_session.body.trim(), "");
  if (briefing.project_context?.content) parts.push("## Project Context", briefing.project_context.content.trim(), "");
  if (briefing.memories.length > 0) {
    parts.push("## Relevant Memories");
    for (const memory of briefing.memories) {
      parts.push("", `### ${memory.id}`, memory.body.trim());
    }
  }
  if (briefing.setup_warnings.length > 0) {
    parts.push("", "## Setup Warnings", ...briefing.setup_warnings.map((w) => `- ${w}`));
  }
  await writeFile(file, parts.join("\n") + "\n", "utf8");
  return file;
}

const PRODUCTION_CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|vue|svelte)$/i;
/** A changed path that represents real product source (not .ai/, docs, config, or generated artifacts). */
function looksLikeProductionCode(file: string): boolean {
  const f = file.replace(/^\/+/, "");
  if (f.startsWith(".ai/") || f.startsWith(".github/")) return false;
  if (isGeneratedArtifact(f)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return false;
  if (/(^|\/)(test|tests|__tests__|__mocks__|e2e|fixtures)(\/|$)/.test(f)) return false;
  return PRODUCTION_CODE_EXT.test(f);
}

/**
 * First-agent bootstrap gate. Forces the very first agent on a cold corpus to fill the knowledge layer
 * (project-context, module contexts, anchored memories + a sensor per main code area) before its
 * commit/finish can pass. The trigger is the corpus state (all committed artifacts → identical in CI),
 * so it self-clears and is silent for every later agent. Block only bites when production code changes;
 * docs/config-only commits are downgraded to a warning.
 */
async function checkBootstrapComplete(
  paths: ReturnType<typeof resolveHaivePaths>,
  config: HaiveConfig,
  productionCodeChanged: boolean,
  stage: "local" | "pre-commit" | "pre-push" | "ci",
): Promise<EnforcementFinding[]> {
  const gate = config.enforcement?.bootstrapGate ?? "block";
  if (gate === "off") return [];

  let projectContextRaw = "";
  try { projectContextRaw = await readFile(paths.projectContext, "utf8"); } catch { /* absent */ }

  const memories = existsSync(paths.memoriesDir) ? await loadMemoriesFromDir(paths.memoriesDir) : [];
  const codeMap = await loadCodeMap(paths);
  // A committed code-map may contain files from a developer's ignored benchmark checkout or a
  // nested reference repo. A clean CI clone cannot be required to document code that is not there.
  const codeFiles = codeMap
    ? Object.keys(codeMap.files).filter((file) => existsSync(path.join(paths.root, file)))
    : [];

  let existingModules: string[] = [];
  try {
    const entries = await readdir(paths.modulesContextDir, { withFileTypes: true });
    existingModules = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* no modules dir yet */ }

  const assessment = assessBootstrapState({ projectContextRaw, memories, codeFiles, existingModules });

  if (assessment.state === "ready") {
    return [{
      severity: "ok",
      code: "bootstrap-complete",
      message: `Repo knowledge layer is ready — ${assessment.metrics.mainAreas} main area(s) covered by memories and sensors.`,
    }];
  }

  // Only enforce where there are genuine main code areas — otherwise (tiny / docs / config-only repo)
  // there is nothing for later coding agents to rely on, so the gate is advisory (info, no score penalty).
  const hasCodeAreas = assessment.metrics.mainAreas > 0;
  // Bind the block to the SHARING points (pre-push, ci, finish) — the baseline only matters before
  // other agents see the code. Blocking every local pre-commit trained `--no-verify` and taxed quick
  // iteration in throwaway/experimental repos; at pre-commit/local the gate is a warn, not an error.
  const enforcedStage = stage === "pre-push" || stage === "ci";
  const blocking = gate === "block" && hasCodeAreas && productionCodeChanged && enforcedStage;
  const severity: EnforcementFinding["severity"] = blocking ? "error" : hasCodeAreas ? "warn" : "info";
  return [{
    severity,
    code: "bootstrap-incomplete",
    message:
      `First-agent bootstrap ${blocking ? "REQUIRED" : "pending"} — the repo knowledge layer is ${assessment.state}; ` +
      `later agents will rely on it. Close these gaps:\n${renderBootstrapChecklist(assessment)}`,
    fix: "Invoke the bootstrap_repo MCP prompt — it drives project-context, module contexts, anchored memories, and propose_sensor for each main area. (Override: enforcement.bootstrapGate, or `git commit --no-verify`.)",
    impact: blocking ? 40 : severity === "warn" ? 5 : 0,
  }];
}

async function buildEnforcementReport(
  dir: string | undefined,
  stage: "local" | "pre-commit" | "pre-push" | "ci",
  sessionId?: string,
): Promise<EnforcementReport> {
  const root = findProjectRoot(dir);
  const paths = resolveHaivePaths(root);
  const initialized = existsSync(paths.haiveDir);
  const config = initialized ? await loadConfig(paths) : {};
  if (initialized) {
    await applyLightweightRepairs(root, paths);
    // Atomic release commit: when the repair re-syncs the project-context version
    // header to package.json, stage it so it lands in THIS commit instead of drifting
    // into a later `chore: hivelore sync [skip ci]` tip — which would skip CI for the whole
    // push (decision 2026-06-02-decision-atomic-release-commit-and-skip-ci-tip).
    if (stage === "pre-commit") await stageResyncedArtifacts(root, paths);
  }
  // Same rule as buildFinishReport: resolve the posture before reading `mode` off it.
  const gatePolicy = resolveGatePolicy(config.enforcement);
  const mode = gatePolicy.mode;
  const findings: EnforcementFinding[] = [];

  if (!initialized) {
    return withCategories({
      root,
      initialized,
      mode,
      score: buildScore([], config.enforcement?.scoreThreshold),
      should_block: true,
      findings: [{
        severity: "error",
        code: "not-initialized",
        message: "This repository is not initialized with Hivelore.",
        fix: "Run `hivelore init` or `hivelore enforce install`.",
        impact: 100,
      }],
    });
  }

  if (mode === "off") {
    return withCategories({
      root,
      initialized,
      mode,
      stage,
      score: buildScore([], config.enforcement?.scoreThreshold),
      should_block: false,
      findings: [{ severity: "info", code: "enforcement-off", message: "Hivelore enforcement is disabled." }],
    });
  }

  findings.push(...await inspectIntegrationVersions(root, __HAIVE_VERSION__));

  // A corpus file the loader cannot parse is INVISIBLE to briefings and to the gate itself — a
  // silently lost team lesson. `doctor` already reports it; the gate must too, or "gate passed"
  // is a lie about the corpus the commit just touched. Deterministic and code-bound → it blocks.
  findings.push(...await checkCorpusReadable(paths));

  if (config.enforcement?.requireBriefingFirst !== false && stage !== "ci") {
    const hasBriefing = await hasRecentBriefingMarker(paths, sessionId);
    findings.push(hasBriefing
      ? { severity: "ok", code: "briefing-loaded", message: "A recent Hivelore briefing marker exists." }
      : {
          severity: "error",
          code: "briefing-missing",
          message: "No recent Hivelore briefing marker was found for this workflow.",
          fix: "Run `hivelore briefing --task \"...\"`, `hivelore enforce session-start`, or wrap the agent with `hivelore run -- <agent>`.",
          impact: 35,
        });
  }

  if (config.enforcement?.requireSessionRecap !== false && (stage === "pre-push" || stage === "ci")) {
    const hasRecap = await hasRecentSessionRecap(paths);
    findings.push(hasRecap
      ? { severity: "ok", code: "session-recap-present", message: "A recent session_recap memory exists." }
      : stage === "ci"
        ? {
            severity: "warn",
            code: "session-recap-missing",
            message: "No recent session_recap memory was found. CI reports this as a warning because personal recaps are usually not committed.",
            fix: "Run `hivelore session end --scope team --goal ... --accomplished ...` if you want a team recap visible in CI.",
            impact: 5,
          }
        : {
            severity: "error",
            code: "session-recap-missing",
            message: "No recent session_recap memory was found.",
            fix: "Run `hivelore session end --goal ... --accomplished ...` before pushing.",
            impact: 20,
          });
  }

  // Resolved once and shared: several gates need to know WHAT CHANGED in order to judge the change
  // rather than the repo's overall state.
  const changedFiles = await getChangedFiles(root, stage).catch(() => [] as string[]);

  if (config.enforcement?.requireMemoryVerify !== false) {
    findings.push(...await verifyMemoryPolicy(paths, config, changedFiles));
  }

  if (config.enforcement?.requireDecisionCoverage !== false) {
    findings.push(...await verifyDecisionCoverage(paths, stage, sessionId));
  }

  if (stage === "pre-commit" || stage === "ci") {
    findings.push(...await runPrecommitPolicy(paths, config.enforcement?.antiPatternGate ?? "anchored", stage, config));
  } else if (stage === "local") {
    // The diff-scan layer (anti-pattern matcher + regex/command sensors) runs only at
    // pre-commit/ci — by design, so a bare `enforce check` preview stays fast and quiet on
    // config/docs work. Say so explicitly: otherwise a clean `local` run reads as "your diff
    // passed the sensor gate", which it did not evaluate. The installed git hook uses pre-commit.
    findings.push({
      severity: "info",
      code: "antipattern-gate-deferred",
      message:
        "Anti-pattern + sensor diff scan is NOT evaluated in --stage local (this is a preview). " +
        "It runs in the installed git hook (--stage pre-commit) and in CI (--stage ci).",
      fix: "To scan the staged diff now: `hivelore sensors check`, or `hivelore enforce check --stage pre-commit`.",
    });
  }

  if (config.enforcement?.cleanupGeneratedArtifacts !== false) {
    findings.push(...await findGeneratedArtifacts(paths));
  }

  findings.push(
    ...await checkBootstrapComplete(paths, config, changedFiles.some(looksLikeProductionCode), stage),
  );

  // ── Verdict ────────────────────────────────────────────────────────────
  // One pass, in `core/gate-verdict.ts`. This used to be three sequential downgrade transforms
  // stacked here, each added by a different fix and none aware of the others, so the outcome
  // depended on their order and nobody could state the rule. Everything below is now orchestration.
  const agentContext = detectAgentContext();
  const policy = gatePolicy;
  const verdict = decideVerdict({
    findings,
    policy,
    stage,
    isAgent: agentContext.agent,
    agentSignals: agentContext.signals,
  });
  let effectiveFindings = verdict.findings;
  const healthFinding = buildBaselineHealthFinding(
    effectiveFindings,
    verdict.baseline_health,
    verdict.should_block,
  );
  if (healthFinding) effectiveFindings = [...effectiveFindings, healthFinding];

  // Collapse an advisory reminder that has already been shown in full today. The finding, its
  // severity and its fix are untouched — only how much of it a human sees again.
  effectiveFindings = await collapseRepeatedReminders(paths, effectiveFindings);

  const report = withCategories({
    root,
    initialized,
    mode,
    stage,
    actor: verdict.actor,
    posture: describePosture(policy),
    score: computeBaselineHealth(effectiveFindings, policy.scoreThreshold),
    should_block: verdict.should_block,
    findings: effectiveFindings,
  });
  if (!report.should_block && (stage === "pre-commit" || stage === "ci")) {
    const headSha = await gitHeadSha(root);
    await appendSensorEvaluations(paths, [evaluation({
      memory_id: "__gate__",
      kind: "shell",
      stage,
      head_sha: headSha,
      scope_hash: "",
      outcome: "silent",
    })]);
  }
  return report;
}

function withCategories(report: Omit<EnforcementReport, "categories">): EnforcementReport {
  return {
    ...report,
    categories: {
      blocking: report.findings.filter((f) => f.severity === "error"),
      review: report.findings.filter((f) => f.severity === "warn"),
      info: report.findings.filter((f) => f.severity === "info" || f.severity === "ok"),
    },
  };
}

async function hasRecentSessionRecap(paths: ReturnType<typeof resolveHaivePaths>): Promise<boolean> {
  // An ephemeral NEXT.md handoff also satisfies continuity (autoSessionRecap=false setups).
  const handoffAge = await handoffAgeMs(paths.root);
  if (handoffAge !== null && handoffAge < SESSION_RECAP_TTL_MS) return true;
  if (!existsSync(paths.memoriesDir)) return false;
  const all = await loadMemoriesFromDir(paths.memoriesDir);
  return all.some(({ memory }) => {
    const fm = memory.frontmatter;
    const freshnessDate = fm.verified_at ?? fm.created_at;
    return fm.type === "session_recap" &&
      fm.status !== "rejected" &&
      isFreshIsoDate(freshnessDate, SESSION_RECAP_TTL_MS);
  });
}

/**
 * A memory file the loader cannot parse is dropped silently by `loadMemoriesFromDir`, so it is
 * invisible to every briefing AND to the gate — the exact shape of a lost lesson a field report
 * hit: a `type: reference` file written by hand, parsed nowhere, yet the gate said "passed". This
 * closes the gap between `doctor` (which reported it) and the gate (which did not).
 */
async function checkCorpusReadable(
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<EnforcementFinding[]> {
  if (!existsSync(paths.memoriesDir)) return [];
  const { invalid } = await loadMemoriesFromDirDetailed(paths.memoriesDir);
  if (invalid.length === 0) return [];
  const listed = invalid
    .slice(0, 8)
    .map((f) => `${path.relative(paths.root, f.filePath)} (${f.error})`)
    .join("; ");
  return [{
    severity: "error",
    code: "invalid-memory-files",
    message:
      `${invalid.length} memory file(s) failed to parse and are INVISIBLE to briefings and the gate: ${listed}`,
    fix: "Fix the frontmatter (see `hivelore doctor` for the full list). A corpus file the gate cannot read is a silently lost lesson.",
    impact: 50,
  }];
}

/**
 * Stale-anchor policy, scoped to the change under review.
 *
 * A stale memory anchored somewhere the author never touched is a CORPUS-MAINTENANCE problem, not a
 * defect in their diff. Refusing their push for it punishes whoever happens to pass through rather
 * than whoever introduced it — and the only lever they have is `--no-verify`, which also disables
 * the sensors. So a stale anchor ON A FILE THIS CHANGE TOUCHES still refuses (that one IS about the
 * diff: the author is editing code whose documented policy no longer matches it), and everything
 * else is reported as a warning for the corpus owner to clear.
 */
async function verifyMemoryPolicy(
  paths: ReturnType<typeof resolveHaivePaths>,
  config: HaiveConfig,
  changedFiles: string[] = [],
): Promise<EnforcementFinding[]> {
  if (!existsSync(paths.memoriesDir)) return [];
  const all = await loadMemoriesFromDir(paths.memoriesDir);
  const findings: EnforcementFinding[] = [];
  const staleImportant: string[] = [];
  const staleElsewhere: string[] = [];
  // Why each touched memory is flagged, so the message can say "anchor points at a file that does
  // not exist here" (an invalid anchor) rather than the misleading catch-all "stale", and can offer
  // the rename the file most likely moved to (field report §4).
  const invalidAnchors: Array<{ id: string; missing: string[]; renames: string[] }> = [];
  let verified = 0;

  for (const { memory } of all) {
    const fm = memory.frontmatter;
    const anchored = fm.anchor.paths.length > 0 || fm.anchor.symbols.length > 0;
    if (!anchored || fm.status === "rejected" || fm.status === "deprecated") continue;
    verified++;
    // Does this memory govern code the change actually touches? With no changed-file list at all
    // (a bare `enforce check` preview), fall back to the previous repo-wide behaviour.
    const touched = changedFiles.length === 0 || memoryMatchesAnchorPaths(memory, changedFiles);
    if (fm.status === "stale") {
      if (["decision", "gotcha", "architecture", "convention"].includes(fm.type)) {
        (touched ? staleImportant : staleElsewhere).push(fm.id);
      }
      continue;
    }
    if (config.enforcement?.blockStaleDecisionChanges !== false && ["decision", "gotcha"].includes(fm.type)) {
      const result = await verifyAnchor(memory, { projectRoot: paths.root });
      if (result.stale) {
        (touched ? staleImportant : staleElsewhere).push(fm.id);
        // A "no longer exist" reason means the anchor never resolved here — an invalid anchor, not a
        // moved-symbol staleness. Capture it (touched only — that is what blocks) for a precise message.
        if (touched && result.reason?.includes("no longer exist")) {
          const missing = result.reason.replace(/^.*exist:\s*/, "").split(",").map((s) => s.trim()).filter(Boolean);
          invalidAnchors.push({ id: fm.id, missing, renames: result.possibleRenames });
        }
      }
    }
  }

  findings.push({
    severity: "ok",
    code: "memory-verify-ran",
    message: `Checked ${verified} anchored memories for stale enforcement policy.`,
  });

  if (staleImportant.length > 0) {
    // Prefer the actionable command that actually fixes the reported problem. `memory verify --update`
    // only re-labels status; it does NOT repair a wrong anchor path, so pointing at it wastes the
    // developer's time (field report §4). `memory update --paths` is the command that resolves it.
    const invalid = invalidAnchors[0];
    const renameHint = invalid?.renames.length
      ? ` The file may have moved to: ${invalid.renames.slice(0, 3).join(", ")}.`
      : "";
    const wording = invalidAnchors.length > 0
      ? `anchored to file(s) that do not exist in this repo`
      : `stale on files this change touches`;
    findings.push({
      severity: "error",
      code: "stale-important-memories",
      message:
        `${staleImportant.length} important anchored memor${staleImportant.length === 1 ? "y is" : "ies are"} ${wording}: ` +
        `${staleImportant.slice(0, 8).join(", ")}` +
        (invalid ? ` (e.g. ${invalid.id} → ${invalid.missing.join(", ")}).${renameHint}` : ""),
      fix: invalidAnchors.length > 0
        ? `Repair the anchor: \`hivelore memory update <id> --paths <existing-file>\` (or \`hivelore memory reject <id>\` if the lesson is obsolete). \`memory verify --update\` only relabels status — it will not fix a wrong path.`
        : "Run `hivelore memory verify --update`, then update or delete stale decisions/gotchas before merging.",
      impact: 40,
      affected_files: changedFiles.slice(0, 20),
      memory_ids: staleImportant,
    });
  }
  if (staleElsewhere.length > 0) {
    findings.push({
      severity: "warn",
      code: "stale-memories-elsewhere",
      message:
        `${staleElsewhere.length} important anchored memor${staleElsewhere.length === 1 ? "y is" : "ies are"} stale ` +
        `elsewhere in the repo — not on any file this change touches: ${staleElsewhere.slice(0, 8).join(", ")}`,
      fix: "Corpus maintenance, not a defect in this change: run `hivelore memory verify --update` when convenient.",
      impact: 3,
      memory_ids: staleElsewhere,
    });
  }
  return findings;
}

async function verifyDecisionCoverage(
  paths: ReturnType<typeof resolveHaivePaths>,
  stage: "local" | "pre-commit" | "pre-push" | "ci",
  sessionId?: string,
): Promise<EnforcementFinding[]> {
  if (!existsSync(paths.memoriesDir)) return [];
  // Exclude Hivelore-generated artifacts: the agent doesn't author them, so requiring decision
  // coverage for them is pure friction (and blocked release commits over repair-touched files).
  const changedFiles = (await getChangedFiles(paths.root, stage)).filter((f) => !isGeneratedArtifact(f));
  if (changedFiles.length === 0) {
    return [{ severity: "info", code: "decision-coverage-no-changes", message: "No changed files to match against policy memories." }];
  }

  const all = await loadMemoriesFromDir(paths.memoriesDir);
  const changedSet = new Set(changedFiles);
  const policyTypes = new Set(["decision", "gotcha", "architecture", "convention"]);
  const relevant = all
    .filter(({ memory }) => {
      const fm = memory.frontmatter;
      if (!policyTypes.has(fm.type)) return false;
      if (fm.status !== "validated") return false;
      return memoryMatchesAnchorPaths(memory, changedFiles);
    });

  if (relevant.length === 0) {
    return [{
      severity: "ok",
      code: "decision-coverage-none-required",
      message: `No anchored decisions or policies matched ${changedFiles.length} changed file(s).`,
    }];
  }

  const marker = await readRecentBriefingMarker(paths, sessionId);
  if (stage === "ci" && !marker) {
    return [{
      severity: "ok",
      code: "decision-coverage-ci-pass",
      message:
        `CI surfaced ${relevant.length} relevant anchored decision/polic${relevant.length === 1 ? "y" : "ies"} ` +
        `for ${changedFiles.length} changed file(s). Runtime briefing markers are local-only and are not expected on GitHub Actions.`,
      memory_ids: relevant.slice(0, 20).map(({ memory }) => memory.frontmatter.id),
      affected_files: changedFiles.slice(0, 10),
    }];
  }

  const consulted = new Set(marker?.memory_ids ?? []);
  // Self-authored exemption: a policy memory whose OWN backing file is in this changeset is being
  // written/edited by the committer — requiring it to be pre-surfaced in a briefing is pure friction
  // (you cannot brief a memory you are creating in the same commit). Treat it as covered.
  const missing = relevant
    .filter(({ memory, filePath }) => {
      if (consulted.has(memory.frontmatter.id)) return false;
      if (changedSet.has(path.relative(paths.root, filePath))) return false;
      return true;
    })
    .map(({ memory }) => memory);
  if (missing.length === 0) {
    return [{
      severity: "ok",
      code: "decision-coverage-pass",
      message: `Relevant decisions/policies were surfaced for ${changedFiles.length} changed file(s): ${relevant.length}/${relevant.length}.`,
    }];
  }

  // Auto-brief (default on): instead of blocking with "run a briefing first", the gate surfaces the
  // relevant policies itself and records them in the session marker — feedforward at commit time with
  // zero manual step (the harness iterates the loop, not the human). Strict teams set
  // enforcement.autoBrief=false to keep the legacy "must brief before commit" hard gate.
  if (stage === "pre-commit" || stage === "pre-push") {
    const cfg = await loadConfig(paths).catch(() => ({}) as HaiveConfig);
    if (cfg.enforcement?.autoBrief !== false) {
      await writeBriefingMarker(paths, {
        sessionId,
        source: "haive-autobrief",
        task: "decision-coverage auto-surfaced at commit",
        memoryIds: relevant.map(({ memory }) => memory.frontmatter.id),
        files: changedFiles,
      }).catch(() => { /* best-effort: marker is runtime-local */ });
      return [{
        severity: "ok",
        code: "decision-coverage-autosurfaced",
        message:
          `Surfaced ${relevant.length} relevant decision/policy memor${relevant.length === 1 ? "y" : "ies"} ` +
          `for ${changedFiles.length} changed file(s) at commit time` +
          (missing.length > 0 ? ` (${missing.length} not previously briefed — now recorded)` : "") +
          ". Set enforcement.autoBrief=false to require a manual briefing first.",
        memory_ids: relevant.slice(0, 12).map(({ memory }) => memory.frontmatter.id),
        affected_files: changedFiles.slice(0, 10),
      }];
    }
  }

  return [{
    severity: stage === "local" ? "warn" : "error",
    code: "decision-coverage-missing",
    message: `${missing.length}/${relevant.length} relevant anchored decisions/policies were not present in the latest briefing: ${missing.slice(0, 6).map((m) => m.frontmatter.id).join(", ")}`,
    fix: `Run \`hivelore briefing --files "${changedFiles.slice(0, 12).join(",")}" --max-memories 60 --task "..."\` before committing (briefings now accumulate, so several smaller briefings also work).`,
    reason: "Changed files overlap validated anchored policy memories that were not recorded in the latest briefing marker.",
    affected_files: changedFiles.slice(0, 10),
    memory_ids: missing.slice(0, 10).map((m) => m.frontmatter.id),
    impact: Math.min(35, 10 + missing.length * 5),
  }];
}

async function runPrecommitPolicy(
  paths: ReturnType<typeof resolveHaivePaths>,
  gate: AntiPatternGate,
  stage: "pre-commit" | "ci",
  config: HaiveConfig,
): Promise<EnforcementFinding[]> {
  const snapshot = await getPolicyDiffSnapshot(paths.root, stage);
  // Gate-surface integrity runs even when the anti-pattern gate is off: a diff that demotes or
  // unwires a block sensor is a change to the ENFORCEMENT SURFACE itself, and the whole point is
  // that such a change never lands unmentioned (the gate lives in `.ai/`, editable by the same
  // agent it constrains). Review-only — legitimate demotions exist.
  const weakeningApprovals = await resolveSensorWeakeningApprovals(paths.root, stage);
  const detectedWeakenings = detectSensorWeakening(snapshot.diff);
  const weakenings = detectedWeakenings.filter((weakening) => !weakeningApprovals.has(weakening.memory_id));
  const approvedWeakenings = detectedWeakenings.filter((weakening) => weakeningApprovals.has(weakening.memory_id));
  const weakeningFindings: EnforcementFinding[] = weakenings.length > 0
    ? [{
        severity: config.enforcement?.sensorWeakeningGate === "block" ? "error" : "warn",
        code: "sensor-weakened",
        message:
          `This diff weakens the enforcement surface — ${weakenings.length} sensor change(s) need review: ` +
          weakenings.slice(0, 5).map((w) => `${w.memory_id} (${w.change}: ${w.detail})`).join(", ") +
          (weakenings.length > 5 ? ", …" : "") + ".",
        fix: "If intentional, add `Hivelore-Sensor-Change: <memory-id>` to the commit message and set `HIVELORE_SENSOR_WEAKENING_APPROVALS=<memory-id>` for the local commit hook; otherwise restore the sensor.",
        memory_ids: [...new Set(weakenings.map((w) => w.memory_id))].slice(0, 10),
        impact: config.enforcement?.sensorWeakeningGate === "block" ? 30 : 8,
      }]
    : [];
  if (approvedWeakenings.length > 0) {
    weakeningFindings.push({
      severity: "ok",
      code: "sensor-weakening-approved",
      message: `Reviewed sensor change(s) approved for ${[...new Set(approvedWeakenings.map((w) => w.memory_id))].join(", ")}.`,
      memory_ids: [...new Set(approvedWeakenings.map((w) => w.memory_id))],
    });
  }
  if (gate === "off") {
    return [
      { severity: "info", code: "precommit-policy-off", message: "Anti-pattern gate is disabled (enforcement.antiPatternGate=off)." },
      ...weakeningFindings,
    ];
  }
  const touchedPaths = snapshot.paths;
  if (touchedPaths.length === 0) {
    const code = stage === "ci" ? "no-ci-diff-changes" : "no-staged-changes";
    const message = stage === "ci"
      ? "No changed files found for CI policy diff."
      : "No staged changes found for pre-commit policy.";
    return [{ severity: "info", code, message }, ...weakeningFindings];
  }
  // The gate→params mapping lives in @hivelore/core so the git-hook path and the
  // standalone `hivelore precommit` command can never drift apart.
  const { block_on, anchored_blocks } = antiPatternGateParams(gate);
  const result = await preCommitCheck({
    diff: snapshot.diff,
    paths: touchedPaths,
    block_on,
    anchored_blocks,
    semantic: true,
  }, { paths });

  // Deterministic regex sensors — the precise/computational layer. Previously these
  // only ran via the standalone `hivelore sensors check` and never on a real commit
  // (see 2026-06-03-gotcha-regex-sensors-orphaned-from-precommit-gate). Run them here
  // so a promoted block sensor actually blocks and warn sensors surface in the gate,
  // covering convention/architecture sensors the fuzzy anti-pattern matcher skips.
  const sensorFindings = await runSensorGate(paths, snapshot.diff, stage);

  // Review-level anti-patterns must stay VISIBLE in the gate output even when nothing blocks.
  // History (see 2026-05-07-attempt-strict-precommit-gate-on-haive): making them block spammed
  // config-only commits — so they were silenced entirely, and `enforce check` reported a clean
  // pass while `hivelore precommit` showed "you are about to repeat a documented failed approach".
  // Middle ground: ONE aggregated warn finding (bounded score impact, never blocks) that points
  // at `hivelore precommit` for the full detail. Sensor-driven review warnings are excluded — the
  // sensor gate below already emits a dedicated finding per sensor hit.
  // Fuzzy "you might be repeating a lesson" matches are OFF by default: across real sessions this
  // aggregated finding fired on almost every commit and was skimmed past every time — pure noise that
  // trains people to ignore the gate. Only a DETERMINISTIC sensor block is signal. Restore the review
  // surfacing with `enforcement.reviewMatches: true`, or the explicit `antiPatternGate: "review"` mode.
  const showReview = config.enforcement?.reviewMatches === true || gate === "review";
  const reviewWarnings = showReview
    ? result.warnings.filter((w) => w.level === "review" && !w.reasons.includes("sensor"))
    : [];
  // Repeat-warning fatigue guard: hot files re-match the same historical lessons on every
  // commit (enforce.ts alone re-surfaces its own gate gotchas 12–20× per session). Listing
  // them each time trains people to skim past the whole finding — so ids already listed in
  // the last 24h collapse into a "+N shown recently" tail while NEW matches stay prominent.
  // Runtime-local (gitignored), best-effort, and only affects the LISTING, never the count.
  const REVIEW_SEEN_TTL_MS = 24 * 60 * 60 * 1000;
  const reviewSeenFile = path.join(paths.runtimeDir, "enforcement", "review-seen.json");
  let reviewSeen: Record<string, string> = {};
  try { reviewSeen = JSON.parse(await readFile(reviewSeenFile, "utf8")) as Record<string, string>; } catch { /* first run */ }
  const now = Date.now();
  const isFreshlySeen = (id: string): boolean => {
    const at = Date.parse(reviewSeen[id] ?? "");
    return Number.isFinite(at) && now - at < REVIEW_SEEN_TTL_MS;
  };
  const newWarnings = reviewWarnings.filter((w) => !isFreshlySeen(w.id));
  const repeatCount = reviewWarnings.length - newWarnings.length;
  const reviewFinding: EnforcementFinding[] = reviewWarnings.length > 0
    ? [{
        severity: "warn",
        code: "anti-pattern-review",
        message:
          `${reviewWarnings.length} documented lesson(s) plausibly match this diff — review before committing` +
          (newWarnings.length > 0
            ? `: ${newWarnings.slice(0, 3).map((w) => `${w.id} (${w.reasons.join("+")})`).join(", ")}` +
              (newWarnings.length > 3 ? ", …" : "")
            : "") +
          (repeatCount > 0 ? ` (+${repeatCount} shown in the last 24h — \`hivelore precommit\` lists all)` : "") + ".",
        fix: "Run `hivelore precommit` for the matched lines and repair commands; update the code, or retire the memory if it no longer applies.",
        memory_ids: reviewWarnings.slice(0, 10).map((w) => w.id),
        impact: 5,
      }]
    : [];
  if (reviewWarnings.length > 0) {
    try {
      for (const w of reviewWarnings) reviewSeen[w.id] = new Date(now).toISOString();
      // Drop expired entries so the file cannot grow unbounded.
      for (const [id, at] of Object.entries(reviewSeen)) {
        if (!Number.isFinite(Date.parse(at)) || now - Date.parse(at) >= REVIEW_SEEN_TTL_MS) delete reviewSeen[id];
      }
      await mkdir(path.dirname(reviewSeenFile), { recursive: true });
      await writeFile(reviewSeenFile, JSON.stringify(reviewSeen, null, 2), "utf8");
    } catch { /* best-effort: fatigue guard must never break the gate */ }
  }

  // A large-diff notice (fuzzy corroboration capped) is guidance, not a violation — surface it as
  // info so an accidentally staged node_modules / build artifact is visible without blocking.
  const noticeFinding: EnforcementFinding[] = result.notice
    ? [{ severity: "info", code: "precommit-policy-notice", message: result.notice }]
    : [];

  if (!result.should_block) {
    return [
      {
        severity: "ok",
        code: "precommit-policy-pass",
        message: `${stage === "ci" ? "CI" : "Pre-commit"} policy passed for ${touchedPaths.length} changed file(s).`,
      },
      ...noticeFinding,
      ...reviewFinding,
      ...sensorFindings,
      ...weakeningFindings,
    ];
  }
  // Name the culprits: a CI failure that says "1 blocking anti-pattern" without the memory id
  // is undebuggable from the workflow log (lived on the v0.29.12 release push).
  const blockingWarnings = result.warnings.filter((w) => w.level === "blocking");
  const blockingDetail = blockingWarnings
    .slice(0, 5)
    .map((w) => `${w.id} (${w.reasons.join("+")}${w.sensor_severity ? `, sensor=${w.sensor_severity}` : ""})`)
    .join(", ");
  return [
    {
      severity: "error",
      code: "precommit-policy-block",
      message:
        `Pre-commit policy matched ${result.summary.blocking_warnings ?? result.summary.anti_patterns} blocking anti-pattern(s), ${result.summary.stale_anchors} stale anchor(s)` +
        (blockingDetail ? `: ${blockingDetail}` : "") +
        (result.stale_anchors.length > 0 ? ` — stale: ${result.stale_anchors.slice(0, 5).map((s) => s.id).join(", ")}` : "") + ".",
      fix: "Review the Hivelore warnings, then update the code or the relevant memories.",
      memory_ids: blockingWarnings.slice(0, 10).map((w) => w.id),
      impact: 45,
    },
    ...noticeFinding,
    ...reviewFinding,
    ...sensorFindings,
    ...weakeningFindings,
  ];
}

/** Parse auditable sensor-change approvals from an env value or commit-message trailer block. */
export function parseSensorWeakeningApprovals(text: string | undefined): Set<string> {
  const approved = new Set<string>();
  if (!text) return approved;
  const trailer = /^Hivelore-Sensor-Change:\s*(.+)$/gmi;
  for (const match of text.matchAll(trailer)) {
    for (const id of (match[1] ?? "").split(/[\s,]+/)) if (id) approved.add(id);
  }
  if (!text.includes("Hivelore-Sensor-Change:")) {
    for (const id of text.split(/[\s,]+/)) if (id) approved.add(id);
  }
  return approved;
}

async function resolveSensorWeakeningApprovals(
  root: string,
  stage: "pre-commit" | "ci",
): Promise<Set<string>> {
  const approved = parseSensorWeakeningApprovals(process.env["HIVELORE_SENSOR_WEAKENING_APPROVALS"]);
  if (stage !== "ci") return approved;
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%B"], { cwd: root });
    for (const id of parseSensorWeakeningApprovals(stdout)) approved.add(id);
  } catch { /* the unapproved finding remains fail-closed */ }
  return approved;
}

/**
 * Staged (index) content of a project-relative path, falling back to the working tree — the
 * AST sensor layer parses whole files, and at pre-commit the staged blob is the truth.
 */
async function stagedFileContent(root: string, rel: string): Promise<string | null> {
  try {
    return await runCommand("git", ["show", `:${rel}`], root);
  } catch {
    try {
      return await readFile(path.resolve(root, rel), "utf8");
    } catch {
      return null;
    }
  }
}

/**
 * Run the repo's regex sensors against the staged diff and turn hits into findings:
 * a `block`-severity sensor → error (fails the gate); a `warn` sensor → warn (visible,
 * non-blocking). Read-only and best-effort: a sensor bug must never break a commit.
 */
async function runSensorGate(
  paths: ReturnType<typeof resolveHaivePaths>,
  diff: string,
  stage: "pre-commit" | "ci",
): Promise<EnforcementFinding[]> {
  if (!diff || !existsSync(paths.memoriesDir)) return [];
  try {
    const loaded = await loadMemoriesFromDir(paths.memoriesDir);
    const scannable = loaded
      .map((l) => l.memory)
      .filter((m) => Boolean(m.frontmatter.sensor) && !isRetiredMemory(m.frontmatter, m.body));
    if (scannable.length === 0) return [];

    // Only scan real code targets — never Hivelore-owned/`.ai/` files (self-match guard).
    const targets = sensorTargetsFromDiff(diff).filter((t) => isSensorScannablePath(t.path));
    if (targets.length === 0) return [];

    const findings: EnforcementFinding[] = [];
    const seen = new Set<string>();
    const firedIds = new Set<string>();
    const ledgerRows = [] as import("@hivelore/core").SensorEvaluation[];
    const headSha = await gitHeadSha(paths.root);

    // ── Computational layer 1: deterministic regex sensors ──
    const regexSensorMemories = scannable.filter((m) => m.frontmatter.sensor!.kind === "regex");
    // Presence sensors are kind=regex but evaluated separately (on final content), so keep them out
    // of the added-lines pass and its ledger to avoid a duplicate silent row.
    const plainRegexMemories = regexSensorMemories.filter((m) => !m.frontmatter.sensor!.require_present);
    // Inline `hivelore:allow <slug> — reason` waivers are honoured but never silent: a suppressed
    // match is surfaced as an info finding so the exception stays auditable in the gate output and
    // in CI (field report 2026-09-04 §3.1 — a rule with no exception outlet ends up deleted).
    const waivers = [] as import("@hivelore/core").SensorWaiver[];
    const hits = plainRegexMemories.length > 0 ? runSensors(plainRegexMemories, targets, waivers) : [];
    for (const waiver of waivers) {
      findings.push({
        severity: "info",
        code: "sensor-waived",
        message: `Sensor waived inline — ${waiver.memory_id}: ${waiver.reason}${waiver.file ? ` (${waiver.file})` : ""}\n  waived: ${waiver.line}`,
        fix: "If this exception is the rule rather than the exception, narrow the sensor (`paths`/`exclude`/`absent`) instead of repeating the waiver.",
        memory_ids: [waiver.memory_id],
        file: waiver.file,
        matched_line: waiver.line,
      });
    }
    for (const memory of plainRegexMemories) {
      const sensor = memory.frontmatter.sensor!;
      if (!targets.some((target) => sensorAppliesToPath(sensor, memory.frontmatter.anchor.paths, target.path))) continue;
      ledgerRows.push(evaluation({
        memory_id: memory.frontmatter.id,
        kind: "regex",
        stage,
        head_sha: headSha,
        scope_hash: "",
        outcome: hits.some((hit) => hit.memory_id === memory.frontmatter.id) ? "fired" : "silent",
      }));
    }
    for (const hit of hits) {
      if (seen.has(hit.memory_id)) continue;
      seen.add(hit.memory_id);
      firedIds.add(hit.memory_id);
      const where = hit.file ? ` (${hit.file})` : "";
      // Always show the matched line: a refusal that names the offending code is actionable,
      // one that only names a score is not. The AST branch below already did this.
      const matched = hit.matched_line ? `\n  matched: ${hit.matched_line}` : "";
      if (hit.severity === "block") {
        findings.push({
          severity: "error",
          code: "sensor-block",
          message: `Block sensor fired — ${hit.memory_id}: ${hit.message}${where}${incidentSuffix(hit.sensor.incident)}${matched}`,
          fix: "Remove the flagged pattern. If this specific line is a legitimate exception, waive it in place: " +
            "`// hivelore:allow " + hit.memory_id + " — <reason>` at the end of the line (that line only, and it is reported). " +
            "`hivelore sensors check` shows the match.",
          impact: 45,
          memory_ids: [hit.memory_id],
          file: hit.file,
          matched_line: hit.matched_line,
        });
      } else {
        findings.push({
          severity: "warn",
          code: "sensor-warn",
          message: `Sensor flagged ${hit.memory_id}: ${hit.message}${where}${incidentSuffix(hit.sensor.incident)}${matched}`,
          fix: "Review the flagged line; `hivelore sensors check` shows the matched code.",
          impact: 5,
          memory_ids: [hit.memory_id],
          file: hit.file,
          matched_line: hit.matched_line,
        });
      }
    }

    // ── Computational layer 1b: AST sensors (structural — comments/strings can't false-positive).
    // Match on the staged content of changed files; fire only when a match intersects added lines.
    // Engine missing = unrunnable → ONE aggregated warn, never a block (same honesty as commands). ──
    // ── Computational layer 1a: presence sensors (require_present) — fire on a DELETION of a
    // required line, which a diff-of-added-lines sensor structurally cannot see. Evaluated on the
    // FINAL content of every file the change touched (including pure deletions). ──
    const presenceMemories = regexSensorMemories.filter((m) => m.frontmatter.sensor!.require_present);
    if (presenceMemories.length > 0) {
      const finalTargets: import("@hivelore/core").SensorTarget[] = [];
      for (const rel of changedPathsFromDiff(diff)) {
        if (!isSensorScannablePath(rel)) continue;
        const content = await stagedFileContent(paths.root, rel);
        if (content !== null) finalTargets.push({ path: rel, content });
      }
      const presenceHits = runPresenceSensors(presenceMemories, finalTargets);
      for (const memory of presenceMemories) {
        const applies = finalTargets.some((t) => sensorAppliesToPath(memory.frontmatter.sensor!, memory.frontmatter.anchor.paths, t.path));
        if (!applies) continue;
        ledgerRows.push(evaluation({
          memory_id: memory.frontmatter.id,
          kind: "regex",
          stage,
          head_sha: headSha,
          scope_hash: "",
          outcome: presenceHits.some((h) => h.memory_id === memory.frontmatter.id) ? "fired" : "silent",
        }));
      }
      for (const hit of presenceHits) {
        if (seen.has(hit.memory_id)) continue;
        seen.add(hit.memory_id);
        firedIds.add(hit.memory_id);
        const where = hit.file ? ` (${hit.file})` : "";
        if (hit.severity === "block") {
          findings.push({
            severity: "error",
            code: "sensor-block",
            message: `Block presence sensor fired — ${hit.memory_id}: ${hit.message}${where}${incidentSuffix(hit.sensor.incident)}\n  a required line was removed (it must remain present in ${hit.file ?? "the anchored file"}).`,
            fix: "Restore the required line, or if the invariant is intentionally gone, demote the sensor: `hivelore sensors promote <id> --severity warn`.",
            impact: 45,
            memory_ids: [hit.memory_id],
            file: hit.file,
          });
        } else {
          findings.push({
            severity: "warn",
            code: "sensor-warn",
            message: `Presence sensor flagged ${hit.memory_id}: ${hit.message}${where} — a required line appears to have been removed.`,
            fix: "Confirm the removal was intended; the lesson explains why the line must stay.",
            impact: 5,
            memory_ids: [hit.memory_id],
            file: hit.file,
          });
        }
      }
    }

    const astSensorMemories = scannable.filter((m) => m.frontmatter.sensor!.kind === "ast");
    if (astSensorMemories.length > 0) {
      const addedByPath = addedLineNumbersFromDiff(diff);
      if (!(await astEngineAvailable())) {
        findings.push({
          severity: "warn",
          code: "ast-sensor-unrunnable",
          message:
            `${astSensorMemories.length} AST sensor(s) could not run — the optional @ast-grep/napi engine is not installed. ` +
            "Their protection is OFF on this machine.",
          fix: "Install the engine: `npm i -g @ast-grep/napi` (or add it to the repo devDependencies).",
          impact: 5,
        });
      } else {
        for (const memory of astSensorMemories) {
          const sensor = memory.frontmatter.sensor!;
          if (!sensor.pattern && !sensor.rule) continue;
          const applicable = targets.filter((t) => sensorAppliesToPath(sensor, memory.frontmatter.anchor.paths, t.path));
          if (applicable.length === 0) continue;
          let fired = false;
          for (const target of applicable) {
            const added = addedByPath.get(target.path);
            if (!added || added.size === 0) continue;
            const content = await stagedFileContent(paths.root, target.path);
            if (content === null) continue;
            const scan = await runAstSensorOnContent({
              pattern: sensor.pattern,
              rule: sensor.rule,
              language: sensor.language,
              absent: sensor.absent,
              content,
              filePath: target.path,
              addedLines: added,
            });
            if (scan.status !== "ok" || scan.matches.length === 0) continue;
            fired = true;
            if (seen.has(memory.frontmatter.id)) break;
            seen.add(memory.frontmatter.id);
            firedIds.add(memory.frontmatter.id);
            const where = ` (${target.path}:${scan.matches[0]!.startLine})`;
            if (sensor.severity === "block") {
              findings.push({
                severity: "error",
                code: "sensor-block",
                message: `Block AST sensor fired — ${memory.frontmatter.id}: ${sensor.message}${where}${incidentSuffix(sensor.incident)}\n  matched: ${scan.matches[0]!.text}`,
                fix: "Remove the flagged construct, or run `hivelore sensors check` to inspect the match.",
                impact: 45,
                memory_ids: [memory.frontmatter.id],
                file: `${target.path}:${scan.matches[0]!.startLine}`,
                matched_line: scan.matches[0]!.text,
              });
            } else {
              findings.push({
                severity: "warn",
                code: "sensor-warn",
                message: `AST sensor flagged ${memory.frontmatter.id}: ${sensor.message}${where}${incidentSuffix(sensor.incident)}`,
                fix: "Review the flagged construct; `hivelore sensors check` shows the matched code.",
                impact: 5,
                memory_ids: [memory.frontmatter.id],
                file: `${target.path}:${scan.matches[0]!.startLine}`,
                matched_line: scan.matches[0]!.text,
              });
            }
            break;
          }
          ledgerRows.push(evaluation({
            memory_id: memory.frontmatter.id,
            kind: "ast",
            stage,
            head_sha: headSha,
            scope_hash: "",
            outcome: fired ? "fired" : "silent",
          }));
        }
      }
    }

    // ── Computational layer 2: shell/test command sensors (a regex can't express) ──
    // OFF by default — they execute arbitrary repo-authored commands. Opt in per-repo with
    // enforcement.runCommandSensors=true (mirrors `hivelore sensors check --commands`).
    const config = await loadConfig(paths).catch(() => ({} as HaiveConfig));
    if (config?.enforcement?.runCommandSensors === true) {
      const changedPaths = targets.map((t) => t.path).filter(Boolean);
      const specs = selectCommandSensors(scannable, changedPaths).filter((sp) => !seen.has(sp.memory_id));
      const runs = await executeCommandSensors(specs, paths.root);
      for (const run of runs) {
        const spec = specs.find((candidate) => candidate.memory_id === run.memory_id)!;
        ledgerRows.push(evaluation({
          memory_id: run.memory_id,
          kind: run.kind,
          stage,
          head_sha: headSha,
          scope_hash: await commandScopeHash(paths.root, spec),
          outcome: run.status === "failed" ? "fired" : run.status === "passed" ? "silent" : "unrunnable",
        }, { exit_code: run.exit_code, duration_ms: run.duration_ms }));
      }
      const prior = await loadSensorLedger(paths);
      const promotedAt = sensorPromotedAtMap(scannable.map((m) => m.frontmatter));
      const health = new Map(
        assessSensorHealth([...prior, ...ledgerRows], new Date(), { promotedAt }).map((h) => [h.memory_id, h]),
      );
      for (const run of runs) {
        const sensorHealth = health.get(run.memory_id);
        const quarantined = sensorHealth?.quarantine_pending === true;
        if (quarantined && run.severity === "block") {
          const last = sensorHealth.flaps.at(-1)!;
          findings.push({
            severity: "warn",
            code: "sensor-flaky",
            message:
              `Command sensor ${run.memory_id} flapped ${sensorHealth.flap_count}× on identical inputs; ` +
              `treated as warn pending sync quarantine. Last contradiction: ` +
              `${last.previous.at} ${last.previous.outcome} → ${last.current.at} ${last.current.outcome}.`,
            fix: "Run `hivelore sync`, fix the flaky oracle, then re-promote with `hivelore sensors promote <id> --yes`.",
            impact: 5,
            memory_ids: [run.memory_id],
          });
        }
        if (run.status === "passed") continue;
        seen.add(run.memory_id);
        if (run.status === "unrunnable") {
          // The oracle said NOTHING about the code — a broken harness must not block a commit.
          const strictUnrunnable = config.enforcement?.commandSensorUnrunnable === "block";
          findings.push({
            severity: strictUnrunnable ? "error" : "warn",
            code: "command-sensor-unrunnable",
            message:
              `Command sensor ${run.memory_id} could not run (${run.unrunnable_reason}): \`${run.command}\`` +
              (run.output_tail ? `\n${run.output_tail}` : ""),
            fix: "Fix the sensor's command (or its timeout_ms), or demote it: `hivelore sensors promote <id> --severity warn`.",
            impact: strictUnrunnable ? 35 : 5,
          });
          continue;
        }
        firedIds.add(run.memory_id);
        const outputBlock = run.output_tail ? `\n${run.output_tail}` : "";
        if (run.severity === "block" && !quarantined) {
          findings.push({
            severity: "error",
            code: "sensor-block",
            message:
              `Block ${run.kind} sensor fired — ${run.memory_id}: ${run.message}${incidentSuffix(run.incident)}\n` +
              `command: ${run.command} (exit ${run.exit_code}, ${run.duration_ms}ms)${outputBlock}`,
            fix: "Fix the behaviour the command checks, or run `hivelore sensors check --commands` to inspect it.",
            impact: 45,
            memory_ids: [run.memory_id],
          });
        } else {
          findings.push({
            severity: "warn",
            code: "sensor-warn",
            message: `${run.kind} sensor flagged ${run.memory_id}: ${run.message}${incidentSuffix(run.incident)} (exit ${run.exit_code})${outputBlock}`,
            fix: "Review the failing command; `hivelore sensors check --commands` re-runs it.",
            impact: 5,
            memory_ids: [run.memory_id],
          });
        }
      }
    }

    await appendSensorEvaluations(paths, ledgerRows);

    // OUTCOME measurement — the formerly-missing leg of the loop. A sensor firing in the gate is a
    // prevention event (a documented mistake intercepted before it landed). Funnel through THE shared
    // recorder so the installed git-hook gate finally records what it blocks — debounced, so it can't
    // double-count with a prior `sensors check` / `anti_patterns_check` on the same diff.
    if (firedIds.size > 0) {
      const details = Object.fromEntries([...firedIds].map((id) => {
        const row = ledgerRows.find((entry) => entry.memory_id === id && entry.outcome === "fired");
        return [id, { kind: row?.kind ?? "regex", stage, ...(row?.exit_code !== undefined ? { exit_code: row.exit_code } : {}) }];
      }));
      await recordPreventionHits(paths, [...firedIds], "sensor", new Date(), details)
        .catch(() => { /* best-effort telemetry */ });
    }

    return findings;
  } catch (err) {
    // A sensor-machinery error means the ENTIRE deterministic layer just evaluated nothing — the one
    // way Hivelore's core guarantee ("the gate always fires") can vanish. So it must never be quiet:
    //  - in CI it FAILS THE BUILD (fail-closed) — a green CI that silently evaluated no sensors is a
    //    lie about protection, worse than a red one.
    //  - locally it stays non-blocking (a broken toolchain must not brick every commit) but is a loud,
    //    high-impact finding, not a footnote.
    const inCi = stage === "ci";
    return [{
      severity: inCi ? "error" : "warn",
      code: "sensor-gate-errored",
      message:
        `⛔ The sensor gate itself errored, so NO sensors were evaluated on this diff — the deterministic ` +
        `protection was OFF for this run${inCi ? " (failing CI: a passing gate that evaluated nothing is not trustworthy)" : ""}: ` +
        `${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      fix: "Run `hivelore sensors check` to reproduce (set HIVELORE_DEBUG=1 for the stack), and `hivelore doctor` for setup drift. Protection is OFF until this is fixed.",
      impact: inCi ? 60 : 25,
    }];
  }
}


async function findGeneratedArtifacts(paths: ReturnType<typeof resolveHaivePaths>): Promise<EnforcementFinding[]> {
  const dirty = await runCommand("git", ["status", "--short", "--untracked-files=all"], paths.root).catch(() => "");
  const generated = dirty
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      isGeneratedArtifactStatusLine(line) ||
      line.includes("__pycache__/") ||
      line.endsWith(".pyc"),
    );
  if (generated.length === 0) {
    return [{ severity: "ok", code: "generated-artifacts-clean", message: "No generated runtime/cache artifacts are visible to git." }];
  }
  return [{
    severity: "warn",
    code: "generated-artifacts-visible",
    message: `${generated.length} generated artifact(s) are visible in git status.`,
    fix: "Run `hivelore enforce cleanup`, update .gitignore, or remove test/runtime outputs before committing.",
    impact: 10,
  }];
}

function isGeneratedArtifactStatusLine(line: string): boolean {
  const file = line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
  if (file === ".ai/.cache/.gitignore") return false;
  if (file === ".ai/.runtime/.gitignore" || file === ".ai/.runtime/README.md") return false;
  if (file.startsWith(".ai/.runtime/enforcement/briefings/")) return false;
  return file.startsWith(".ai/.cache/") || file.startsWith(".ai/.runtime/");
}

async function cleanupRuntimeDir(runtimeDir: string): Promise<number> {
  let removed = 0;
  await mkdir(runtimeDir, { recursive: true });
  const entries = await readdir(runtimeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".gitignore" || entry.name === "README.md") continue;
    if (entry.name === "enforcement") {
      removed += await cleanupEnforcementDir(path.join(runtimeDir, entry.name));
      continue;
    }
    await rm(path.join(runtimeDir, entry.name), { recursive: true, force: true });
    removed++;
  }
  await writeFile(path.join(runtimeDir, ".gitignore"), "*\n!.gitignore\n!README.md\n", "utf8");
  if (!existsSync(path.join(runtimeDir, "README.md"))) {
    await writeFile(
      path.join(runtimeDir, "README.md"),
      "# .ai/.runtime — disposable local layer\n\nRuntime data is local. Hivelore cleanup preserves briefing markers so enforcement state remains valid.\n",
      "utf8",
    );
  }
  return removed;
}

async function cleanupCacheDir(cacheDir: string): Promise<number> {
  let removed = 0;
  await mkdir(cacheDir, { recursive: true });
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".gitignore") continue;
    await rm(path.join(cacheDir, entry.name), { recursive: true, force: true });
    removed++;
  }
  await writeFile(path.join(cacheDir, ".gitignore"), "*\n!.gitignore\n", "utf8");
  return removed;
}

async function cleanupEnforcementDir(enforcementDir: string): Promise<number> {
  let removed = 0;
  const entries = await readdir(enforcementDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "briefings") continue;
    await rm(path.join(enforcementDir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function inspectIntegrationVersions(
  root: string,
  expectedVersion: string,
): Promise<EnforcementFinding[]> {
  const files = [
    ".git/hooks/pre-commit",
    ".git/hooks/pre-push",
    ".claude/settings.local.json",
    ".mcp.json",
    ".cursor/mcp.json",
    ".vscode/mcp.json",
  ];
  const findings: EnforcementFinding[] = [];
  // Dedupe by binary: one finding per unique stale/broken path (listing the files that reference it),
  // not one per occurrence across pre-commit/pre-push/.mcp.json/etc.
  const missingBins = new Map<string, Set<string>>();
  const staleBins = new Map<string, { version: string; files: Set<string> }>();
  for (const rel of files) {
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
  for (const [bin, fileSet] of missingBins) {
    findings.push({
      severity: "warn",
      code: "integration-haive-binary-missing",
      message: `${[...fileSet].join(", ")} reference ${bin}, but that binary could not be executed.`,
      fix: "Run `hivelore agent setup --no-global` or `hivelore enforce install` to refresh project integrations.",
      impact: 0,
    });
  }
  for (const [bin, { version, files: fileSet }] of staleBins) {
    findings.push({
      severity: "warn",
      code: "integration-haive-version-mismatch",
      message: `${[...fileSet].join(", ")} reference Hivelore ${version} at ${bin}; current Hivelore is ${expectedVersion}.`,
      fix: "Run `hivelore agent setup --no-global` and `hivelore enforce install` to repair stale hooks/configs.",
      impact: 0,
    });
  }
  if (findings.length === 0) {
    return [{
      severity: "ok",
      code: "integration-version-check",
      message: "No stale absolute Hivelore binary paths were found in project hooks/MCP configs.",
    }];
  }
  return findings;
}

function extractAbsoluteHaiveBins(text: string): string[] {
  const out = new Set<string>();
  const re = /(["'\s])((?:\/[^"'\s]+)*\/haive)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const p = match[2];
    if (!p) continue;
    // Skip directories — a haive binary is a file, not a folder.
    // Prevents HAIVE_PROJECT_ROOT env values from being mistaken for binaries.
    try {
      if (statSync(p).isDirectory()) continue;
    } catch {
      // Path does not exist — still report as missing binary
    }
    out.add(p);
  }
  return [...out].sort();
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

async function getChangedFiles(
  root: string,
  stage: "local" | "pre-commit" | "pre-push" | "ci",
): Promise<string[]> {
  if (stage === "ci") {
    return (await getPolicyDiffSnapshot(root, "ci")).paths;
  }
  if (stage === "pre-commit") {
    return normalizeChangedFileList(
      await runCommand("git", ["diff", "--cached", "--name-only"], root).catch(() => ""),
    );
  }
  const files = new Set<string>();
  for (const args of [["diff", "--cached", "--name-only"], ["diff", "--name-only"]]) {
    for (const file of normalizeChangedFileList(await runCommand("git", args, root).catch(() => ""))) {
      files.add(file);
    }
  }
  return [...files];
}

interface PolicyDiffSnapshot {
  diff: string;
  paths: string[];
  source: string;
}

async function getPolicyDiffSnapshot(
  root: string,
  stage: "pre-commit" | "ci",
): Promise<PolicyDiffSnapshot> {
  if (stage === "pre-commit") {
    const diff = await runCommand("git", ["diff", "--cached"], root).catch(() => "");
    const names = await runCommand("git", ["diff", "--cached", "--name-only"], root).catch(() => "");
    return { diff, paths: normalizeChangedFileList(names), source: "staged" };
  }

  const range = await resolveCiDiffRange(root);
  if (range) {
    const diff = await runCommand("git", ["diff", range], root).catch(() => "");
    const names = await runCommand("git", ["diff", "--name-only", range], root).catch(() => "");
    return { diff, paths: normalizeChangedFileList(names), source: range };
  }

  return { diff: "", paths: [], source: "none" };
}

async function resolveCiDiffRange(root: string): Promise<string | null> {
  // Read the new HIVELORE_* names, falling back to legacy HAIVE_* baked into pre-rename workflows.
  const explicitBase = cleanGitSha(process.env.HIVELORE_BASE_SHA ?? process.env.HIVELORE_BASE_REF ?? process.env.HAIVE_BASE_SHA ?? process.env.HAIVE_BASE_REF);
  const explicitHead = cleanGitSha(process.env.HIVELORE_HEAD_SHA ?? process.env.HAIVE_HEAD_SHA ?? process.env.GITHUB_SHA) ?? "HEAD";
  if (explicitBase && await gitCommitExists(root, explicitBase)) {
    return `${explicitBase}...${explicitHead}`;
  }

  const eventRange = await resolveGithubEventRange(root);
  if (eventRange) return eventRange;

  const baseRef = process.env.GITHUB_BASE_REF?.trim();
  if (baseRef) {
    const remoteRef = `origin/${baseRef}`;
    if (await gitCommitExists(root, remoteRef)) return `${remoteRef}...${explicitHead}`;
  }

  if (await gitCommitExists(root, "origin/main")) return `origin/main...${explicitHead}`;
  if (await gitCommitExists(root, "origin/master")) return `origin/master...${explicitHead}`;
  if (await gitCommitExists(root, "HEAD^")) return `HEAD^..${explicitHead}`;
  return null;
}

async function resolveGithubEventRange(root: string): Promise<string | null> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(await readFile(eventPath, "utf8")) as {
      before?: string;
      after?: string;
      pull_request?: {
        base?: { sha?: string };
        head?: { sha?: string };
      };
    };
    const prBase = cleanGitSha(event.pull_request?.base?.sha);
    const prHead = cleanGitSha(event.pull_request?.head?.sha ?? event.after ?? process.env.GITHUB_SHA) ?? "HEAD";
    if (prBase && await gitCommitExists(root, prBase)) return `${prBase}...${prHead}`;

    const pushBase = cleanGitSha(event.before);
    const pushHead = cleanGitSha(event.after ?? process.env.GITHUB_SHA) ?? "HEAD";
    if (pushBase && await gitCommitExists(root, pushBase)) return `${pushBase}..${pushHead}`;
  } catch {
    return null;
  }
  return null;
}

function cleanGitSha(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /^0+$/.test(trimmed)) return null;
  return trimmed;
}

async function gitCommitExists(root: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`], root);
    return true;
  } catch {
    return false;
  }
}

function normalizeChangedFileList(raw: string): string[] {
  return raw.split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((file) =>
      !file.startsWith(".ai/.runtime/") &&
      !file.startsWith(".ai/.cache/") &&
      !file.startsWith(".ai/.usage/") &&
      file !== ".ai/.usage/tool-usage.jsonl"
    );
}

interface GitSyncStatus {
  available: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirtyFiles: string[];
  /**
   * Subset of `dirtyFiles` that git reports as untracked (`??`). Kept apart because the corrective
   * action differs: a modified file must be committed, while an untracked one is either committed
   * OR ignored. Reporting the second as "modified" sent the developer looking for a change that
   * does not exist.
   */
  untrackedFiles: string[];
  changedSinceUpstream: string[];
  releaseBaseRef?: string;
  releaseChangedFiles?: string[];
}

interface GithubActionsRun {
  conclusion?: string | null;
  databaseId?: number;
  name?: string;
  status?: string;
  workflowName?: string;
}

async function getGitSyncStatus(root: string): Promise<GitSyncStatus> {
  const statusLines = (await runCommand("git", ["status", "--short", "--untracked-files=all"], root).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty: string[] = [];
  const untracked: string[] = [];
  for (const line of statusLines) {
    const file = statusLineToPath(line);
    if (!file || normalizeChangedFileList(file).length === 0) continue;
    dirty.push(file);
    // `??` is git's untracked marker. Trimming above is safe for it (unlike the leading-space
    // staged/unstaged distinction) because `?` is not whitespace.
    if (line.startsWith("??")) untracked.push(file);
  }
  const branch = (await runCommand("git", ["branch", "--show-current"], root).catch(() => "")).trim() || undefined;
  const upstream = (await runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root).catch(() => "")).trim() || undefined;
  if (!branch && !upstream) {
    const inside = (await runCommand("git", ["rev-parse", "--is-inside-work-tree"], root).catch(() => "")).trim();
    if (inside !== "true") {
      return {
        available: false,
        ahead: 0,
        behind: 0,
        dirtyFiles: [],
        untrackedFiles: [],
        changedSinceUpstream: [],
      };
    }
  }

  let ahead = 0;
  let behind = 0;
  let changedSinceUpstream: string[] = [];
  let releaseBaseRef: string | undefined;
  let releaseChangedFiles: string[] | undefined;
  if (upstream) {
    const counts = (await runCommand("git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], root).catch(() => "")).trim();
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    behind = Number.parseInt(behindRaw ?? "0", 10) || 0;
    ahead = Number.parseInt(aheadRaw ?? "0", 10) || 0;
    changedSinceUpstream = normalizeChangedFileList(
      await runCommand("git", ["diff", "--name-only", `${upstream}...HEAD`], root).catch(() => ""),
    );
    if (changedSinceUpstream.length > 0) {
      releaseBaseRef = upstream;
      releaseChangedFiles = changedSinceUpstream;
    }
  }

  if (!releaseChangedFiles || releaseChangedFiles.length === 0) {
    const hasParent = (await runCommand("git", ["rev-parse", "--verify", "--quiet", "HEAD^"], root).catch(() => "")).trim().length > 0;
    if (hasParent) {
      const changedSinceParent = normalizeChangedFileList(
        await runCommand("git", ["diff", "--name-only", "HEAD^..HEAD"], root).catch(() => ""),
      );
      if (changedSinceParent.length > 0) {
        releaseBaseRef = "HEAD^";
        releaseChangedFiles = changedSinceParent;
      }
    }
  }

  return {
    available: true,
    branch,
    upstream,
    ahead,
    behind,
    dirtyFiles: dirty,
    untrackedFiles: untracked,
    changedSinceUpstream,
    ...(releaseBaseRef ? { releaseBaseRef } : {}),
    ...(releaseChangedFiles ? { releaseChangedFiles } : {}),
  };
}

function statusLineToPath(line: string): string {
  const body = line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
  const renamed = body.match(/.+ -> (.+)$/);
  return renamed?.[1]?.trim() ?? body;
}

const VERSION_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/mcp/package.json",
  "packages/embeddings/package.json",
] as const;

const SHIPPABLE_PATH_PREFIXES = [
  "packages/core/src/",
  "packages/cli/src/",
  "packages/mcp/src/",
  "packages/embeddings/src/",
];

function isShippablePath(file: string): boolean {
  return SHIPPABLE_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    VERSION_FILES.includes(file as (typeof VERSION_FILES)[number]);
}

/** Directives that make GitHub Actions skip a whole push (matched on the cleaned message). */
const CI_SKIP_DIRECTIVE = /\[skip ci\]|\[ci skip\]|\[no ci\]|\[skip actions\]|\*\*\*NO_CI\*\*\*|skip-checks: *true/i;

/**
 * commit-msg prevention for the skip-ci footgun: GitHub scans the ENTIRE commit message
 * (subject + body) for a CI-skip directive and then skips CI for the whole push. Blocking such a
 * directive ONLY when the commit also carries shippable code keeps legitimate `.ai/`-only sync
 * commits (which correctly use [skip ci]) working. Comment lines (`#…`, stripped by git) are
 * ignored so merely discussing the directive in a comment never blocks.
 */
async function checkCommitMessageSkipCi(
  root: string,
  msgfile: string,
): Promise<{ block: boolean; message: string }> {
  const file = path.isAbsolute(msgfile) ? msgfile : path.join(root, msgfile);
  const raw = await readFile(file, "utf8").catch(() => "");
  const cleaned = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  if (!CI_SKIP_DIRECTIVE.test(cleaned)) return { block: false, message: "" };

  const staged = (await runCommand("git", ["diff", "--cached", "--name-only"], root).catch(() => ""))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const shippable = staged.filter(isShippablePath);
  if (shippable.length === 0) return { block: false, message: "" };

  return {
    block: true,
    message:
      "This commit message contains a CI-skip directive ([skip ci] / [ci skip] / [no ci]) but the commit changes shippable code:\n" +
      shippable.slice(0, 6).map((f) => `  - ${f}`).join("\n") +
      (shippable.length > 6 ? `\n  …and ${shippable.length - 6} more` : "") +
      "\nGitHub scans the whole commit message and would skip CI for the ENTIRE push — your code would land untested.\n" +
      "Fix: reword the message so it does not contain the literal directive (e.g. write 'skip-ci'), or move the\n" +
      "skip-ci sync into a separate `.ai/`-only commit.",
  };
}

interface ReleaseVersionState {
  lockstep: boolean;
  version?: string;
  baseVersion?: string;
  localVersionsLabel: string;
}

async function inspectReleaseVersionState(root: string, upstream: string): Promise<ReleaseVersionState> {
  const localEntries = await Promise.all(VERSION_FILES.map(async (file) => [file, await readPackageVersion(root, file)] as const));
  const localVersions = new Map(localEntries);
  const unique = new Set([...localVersions.values()].filter(Boolean));
  const version = unique.size === 1 ? [...unique][0] : undefined;
  const localVersionsLabel = VERSION_FILES
    .map((file) => `${file}=${localVersions.get(file) ?? "unreadable"}`)
    .join(", ");

  const baseVersion = await readPackageVersionAtRef(root, upstream, "package.json");
  return {
    lockstep: unique.size === 1 && localVersions.size === VERSION_FILES.length,
    ...(version ? { version } : {}),
    ...(baseVersion ? { baseVersion } : {}),
    localVersionsLabel,
  };
}

async function readPackageVersion(root: string, relPath: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(path.join(root, relPath), "utf8")) as { version?: unknown };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}

async function readPackageVersionAtRef(root: string, ref: string, relPath: string): Promise<string | undefined> {
  try {
    const raw = await runCommand("git", ["show", `${ref}:${relPath}`], root);
    const data = JSON.parse(raw) as { version?: unknown };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}

/** Ordering lives in core so the npm and Release checks cannot disagree about which tag is newer. */
const compareSemver = compareVersions;

async function tagPointsAtHead(root: string, tag: string): Promise<boolean> {
  const tags = await runCommand("git", ["tag", "--points-at", "HEAD"], root).catch(() => "");
  return tags.split("\n").map((line) => line.trim()).includes(tag);
}

async function remoteTagExists(root: string, tag: string): Promise<boolean | null> {
  const branch = (await runCommand("git", ["branch", "--show-current"], root).catch(() => "")).trim();
  const branchRemote = branch
    ? (await runCommand("git", ["config", "--get", `branch.${branch}.remote`], root).catch(() => "")).trim()
    : "";
  const hasOrigin = (await runCommand("git", ["config", "--get", "remote.origin.url"], root).catch(() => "")).trim().length > 0;
  const remote = branchRemote || (hasOrigin ? "origin" : "");
  if (!remote) return null;
  try {
    const out = await runCommand("git", ["ls-remote", "--tags", remote, `refs/tags/${tag}`], root);
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

async function verifyGithubActionsForHead(
  root: string,
  status: GitSyncStatus,
): Promise<EnforcementFinding[]> {
  if (!status.upstream) return [];
  if (status.ahead > 0) {
    return [{
      severity: "info",
      code: "github-actions-waiting-for-push",
      message: "GitHub Actions verification waits until HEAD is pushed.",
    }];
  }

  const remote = await githubRemoteForCurrentBranch(root);
  if (!remote) {
    return [{
      severity: "info",
      code: "github-actions-not-applicable",
      message: "No GitHub remote was detected; GitHub Actions pipeline verification was skipped.",
    }];
  }

  const sha = (await runCommand("git", ["rev-parse", "HEAD"], root).catch(() => "")).trim();
  if (!sha) {
    return [{
      severity: "error",
      code: "github-actions-head-unreadable",
      message: "Could not read HEAD SHA for GitHub Actions verification.",
      fix: "Run `git rev-parse HEAD`, then verify GitHub Actions manually before finishing.",
      impact: 30,
    }];
  }

  let runs: GithubActionsRun[];
  try {
    const raw = await runCommand("gh", [
      "run",
      "list",
      "--commit",
      sha,
      "--limit",
      "50",
      "--json",
      "conclusion,databaseId,name,status,workflowName",
    ], root);
    runs = JSON.parse(raw) as GithubActionsRun[];
  } catch {
    return [{
      severity: "error",
      code: "github-actions-unverified",
      message: "Could not verify GitHub Actions runs for HEAD.",
      fix: "Install/authenticate GitHub CLI, then run `gh run list --commit $(git rev-parse HEAD)` and ensure every workflow is successful before finishing.",
      reason: `Detected GitHub remote ${remote}, but Hivelore could not query workflow runs.`,
      impact: 50,
    }];
  }

  if (runs.length === 0) {
    // Pinpoint the most common cause: GitHub scans the WHOLE HEAD commit message (subject AND
    // body) for a CI-skip directive and then skips the entire push — even when it carries code.
    const headMsg = (await runCommand("git", ["log", "-1", "--pretty=%B"], root).catch(() => "")).trim();
    if (/\[skip ci\]|\[ci skip\]|\[no ci\]|\*\*\*NO_CI\*\*\*|skip-checks: *true/i.test(headMsg)) {
      return [{
        severity: "error",
        code: "github-actions-skipped-by-message",
        message: "No GitHub Actions runs for HEAD because the HEAD commit message contains a CI-skip directive ([skip ci] / [ci skip] / [no ci]) — this skips the WHOLE push, including code.",
        fix: "Reword the HEAD commit so its message (subject AND body) does not contain the literal skip-ci directive — write it as 'skip-ci'. Then re-push, or trigger CI manually with `gh workflow run <workflow.yml> --ref <branch>`.",
        reason: "GitHub scans the entire commit message; a code commit whose message includes a skip-ci directive silently skips CI for the whole push.",
        impact: 60,
      }];
    }
    return [{
      severity: "error",
      code: "github-actions-runs-missing",
      message: "No GitHub Actions runs were found for HEAD.",
      fix: "Wait for GitHub to create the workflow runs, or verify that the push was not skipped by a skip-ci head commit; rerun `hivelore enforce finish` after the runs appear.",
      impact: 50,
    }];
  }

  const pending = runs.filter((run) => run.status !== "completed");
  if (pending.length > 0) {
    return [{
      severity: "error",
      code: "github-actions-pending",
      message: `${pending.length}/${runs.length} GitHub Actions workflow run(s) for HEAD are still pending: ${formatGithubRunNames(pending)}.`,
      fix: "Wait for the runs to finish (`gh run watch <run-id> --exit-status`), then rerun `hivelore enforce finish`.",
      impact: 50,
    }];
  }

  const failed = runs.filter((run) => run.conclusion !== "success");
  const failedCore = failed.filter((run) => !isExternalTransientWorkflow(run));
  const failedExternal = failed.filter((run) => isExternalTransientWorkflow(run));

  // A core workflow that failed only on plumbing (artifact upload over the account's storage quota,
  // a cache or toolchain-setup step) says nothing about the change: the build and the tests ran and
  // passed. Blocking the exit on someone's billing state puts a knowledge tool in charge of an
  // infrastructure problem the agent cannot fix, and the only way out is to ignore the gate
  // (field report 2026-09-04 §5 — 529 + 484 tests green, `finish` refused on an artifact quota).
  const infraFailed: GithubActionsRun[] = [];
  const realFailed: GithubActionsRun[] = [];
  for (const run of failedCore) {
    (await failedOnInfrastructureOnly(run, root) ? infraFailed : realFailed).push(run);
  }

  if (realFailed.length > 0) {
    return [{
      severity: "error",
      code: "github-actions-failed",
      message: `${realFailed.length}/${runs.length} GitHub Actions workflow run(s) for HEAD did not pass: ${formatGithubRunNames(realFailed)}.`,
      fix: "Inspect the failed run logs with `gh run view <run-id> --log`, fix the issue, push the fix, then rerun `hivelore enforce finish`.",
      impact: 80,
    }];
  }

  if (infraFailed.length > 0) {
    return [{
      severity: "warn",
      code: "github-actions-infrastructure-failed",
      message:
        `${infraFailed.length}/${runs.length} workflow run(s) for HEAD failed on INFRASTRUCTURE steps only ` +
        `(artifact/cache/toolchain plumbing), not on build or test: ${formatGithubRunNames(infraFailed)}. ` +
        "Not blocking — this is not a defect in the change.",
      fix: "Fix the runner-side cause when you can (artifact storage quota, cache eviction, registry outage), or `gh run rerun <run-id>`. It is not required to finish.",
      impact: 0,
    }];
  }

  if (failedExternal.length > 0) {
    // Don't let a flaky external integration (e.g. SonarQube network/timeout) masquerade as a
    // product regression. Hivelore's principle is zero hard dependency on the user's environment, so
    // external workflows are advisory: surfaced as info, never blocking `finish`.
    return [{
      severity: "info",
      code: "github-actions-external-transient",
      message: `${failedExternal.length} external/transient workflow run(s) for HEAD did not pass (non-blocking): ${formatGithubRunNames(failedExternal)}. All core workflows passed.`,
      fix: "External integrations can fail on transient network/timeout. Re-run with `gh run rerun <run-id>` if you want them green — not required to finish.",
    }];
  }

  return [{
    severity: "ok",
    code: "github-actions-pass",
    message: `All ${runs.length} GitHub Actions workflow run(s) for HEAD completed successfully.`,
  }];
}

/**
 * Steps that are runner plumbing rather than a verdict on the code: they move artifacts around,
 * warm caches, or install the toolchain. When one of these is the ONLY thing that failed, the
 * repository's own build/test steps ran and succeeded.
 */
const INFRASTRUCTURE_STEP = /(upload|download)[- ]?artifact|actions\/(cache|setup-|checkout)|^set ?up job$|^post /i;

/**
 * Did this failed run fail exclusively on infrastructure steps? Reads the run's jobs (one `gh` call,
 * only ever on an already-failed run) and looks at which STEPS failed — no log download. Answers
 * false on any doubt (unreadable jobs, an unrecognised failed step), so the gate keeps blocking
 * whenever we cannot prove the failure was plumbing.
 */
async function failedOnInfrastructureOnly(run: GithubActionsRun, root: string): Promise<boolean> {
  if (!run.databaseId) return false;
  let jobs: { steps?: { name?: string; conclusion?: string | null }[] }[];
  try {
    const raw = await runCommand("gh", ["run", "view", String(run.databaseId), "--json", "jobs"], root);
    jobs = (JSON.parse(raw) as { jobs?: typeof jobs }).jobs ?? [];
  } catch {
    return false;
  }
  const failedSteps = jobs
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.conclusion === "failure")
    .map((step) => step.name ?? "");
  if (failedSteps.length === 0) return false; // job died before/outside its steps — can't attribute it
  return failedSteps.every((name) => INFRASTRUCTURE_STEP.test(name));
}

/** External integrations whose failures are advisory (flaky network/timeout), not product
 *  regressions. Matched by workflow name so it works regardless of file naming. */
function isExternalTransientWorkflow(run: GithubActionsRun): boolean {
  const label = `${run.workflowName ?? ""} ${run.name ?? ""}`.toLowerCase();
  return /\bsonar(qube|cloud)?\b|\bcodeql\b|\bsnyk\b|\bcodecov\b/.test(label);
}

async function githubRemoteForCurrentBranch(root: string): Promise<string | null> {
  const branch = (await runCommand("git", ["branch", "--show-current"], root).catch(() => "")).trim();
  const branchRemote = branch
    ? (await runCommand("git", ["config", "--get", `branch.${branch}.remote`], root).catch(() => "")).trim()
    : "";
  const remoteName = branchRemote || "origin";
  const remoteUrl = (await runCommand("git", ["config", "--get", `remote.${remoteName}.url`], root).catch(() => "")).trim();
  if (!isGithubRemoteUrl(remoteUrl)) return null;
  return remoteUrl;
}

function isGithubRemoteUrl(url: string): boolean {
  return /(^git@github\.com:|github\.com[/:])/.test(url);
}

function formatGithubRunNames(runs: GithubActionsRun[]): string {
  return runs
    .slice(0, 6)
    .map((run) => {
      const label = run.workflowName ?? run.name ?? "workflow";
      return run.databaseId ? `${label}#${run.databaseId}` : label;
    })
    .join(", ");
}

/**
 * Advisory findings whose message carries multi-line teaching text. Shown in full once per window,
 * then collapsed to one line — see `core/gate-reminder.ts` for why.
 */
const THROTTLED_REMINDER_CODES: Record<string, string> = {
  "bootstrap-incomplete":
    "First-agent bootstrap still pending — run `hivelore doctor` for the checklist.",
};

async function collapseRepeatedReminders(
  paths: ReturnType<typeof resolveHaivePaths>,
  findings: EnforcementFinding[],
): Promise<EnforcementFinding[]> {
  const out: EnforcementFinding[] = [];
  for (const finding of findings) {
    const collapsed = THROTTLED_REMINDER_CODES[finding.code];
    // Only ever collapse an ADVISORY reminder. A finding that refuses the change must always state
    // its full case — that is the one moment the text is guaranteed to be worth reading.
    if (!collapsed || finding.severity === "error") {
      out.push(finding);
      continue;
    }
    if (await shouldExpandGateReminder(paths, finding.code).catch(() => true)) {
      await recordGateReminder(paths, finding.code).catch(() => { /* best-effort */ });
      out.push(finding);
    } else {
      out.push({ ...finding, short_message: collapsed });
    }
  }
  return out;
}

/**
 * Kept as the shim the early-exit report paths use (not-initialized, enforcement-off, finish).
 * The real computation lives in `core/gate-verdict.ts` so there is exactly one definition of the
 * number and it cannot drift between the two call paths.
 */
function buildScore(findings: EnforcementFinding[], threshold = 80): EnforcementScore {
  return computeBaselineHealth(findings, threshold);
}

/** The managed git hooks Hivelore owns, as `{ name, body }` — the single source of truth reused by
 *  install AND the doctor self-heal path, so they can never drift apart. */
export function managedGitHookSpecs(): Array<{ name: string; body: string }> {
  // Resolve the CLI with a graceful no-op fallback: a hook must never abort a commit just because the
  // binary isn't on PATH (e.g. a GUI client with a minimal env) — that is exactly the failure the
  // pre-rename `haive`-calling hooks caused.
  const resolveCli = `_hivelore() {
  if command -v hivelore >/dev/null 2>&1; then hivelore "$@"
  else return 0
  fi
}`;
  const block = (invocation: string): string => `#!/bin/sh\n${ENFORCE_HOOK_MARKER}\n${resolveCli}\n${invocation}\n`;
  return [
    { name: "pre-commit", body: block("_hivelore enforce check --stage pre-commit --dir . || exit $?") },
    { name: "pre-push", body: block("_hivelore enforce check --stage pre-push --dir . || exit $?") },
    { name: "commit-msg", body: block('_hivelore enforce commit-msg "$1" --dir . || exit $?') },
    // Absorbed from the removed `install-hooks` command (v0.32.0): keep anchors fresh after every
    // pull/merge/rebase so the next agent's briefing reflects moved/deleted files.
    { name: "post-merge", body: block("_hivelore sync --quiet --since ORIG_HEAD || true") },
    { name: "post-rewrite", body: block("_hivelore sync --quiet --since ORIG_HEAD || true") },
  ];
}

/**
 * A managed hook is BROKEN (not merely absent) when it still calls the removed `haive` binary
 * directly, or carries a duplicated block (>1 marker / >1 shebang — the artifact the pre-v0.52.1
 * installer produced). Either state aborts every commit or runs a dead line first. Pure over content.
 */
export function hookIsStale(content: string): boolean {
  if (!content.trim()) return false;
  const callsRemovedBinary = /^\s*haive\s+(?:enforce|sync)\b/m.test(content);
  const markerCount = (content.match(/#\s*(?:hivelore|h[aA]ive)\b[^\n]*\bhook\b/gi) ?? []).length;
  const shebangCount = (content.match(/^\s*#!.*\bsh\b/gm) ?? []).length;
  return callsRemovedBinary || markerCount > 1 || shebangCount > 1;
}

/** Names of managed hooks that exist and are BROKEN (legacy `haive` call or duplicated block). */
export async function detectStaleGitHooks(root: string): Promise<string[]> {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return [];
  const stale: string[] = [];
  for (const hook of managedGitHookSpecs()) {
    const file = path.join(hooksDir, hook.name);
    if (!existsSync(file)) continue;
    const current = await readFile(file, "utf8").catch(() => "");
    if (hookIsStale(current)) stale.push(hook.name);
  }
  return stale;
}

/**
 * Detect + REPAIR broken managed hooks in `.git/hooks`. Regenerates only hooks that exist and are
 * stale (see {@link hookIsStale}); a foreign husky/custom hook is preserved by
 * {@link buildHookFileContent}. Returns the names repaired. Safe to call from `doctor` for self-heal.
 */
export async function repairStaleGitHooks(root: string): Promise<string[]> {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return [];
  const repaired: string[] = [];
  for (const hook of managedGitHookSpecs()) {
    const file = path.join(hooksDir, hook.name);
    if (!existsSync(file)) continue;
    const current = await readFile(file, "utf8").catch(() => "");
    if (!hookIsStale(current)) continue;
    await writeFile(file, buildHookFileContent(current, hook.body), "utf8");
    await chmod(file, 0o755);
    repaired.push(hook.name);
  }
  return repaired;
}

async function installGitEnforcement(root: string): Promise<void> {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!existsSync(path.join(root, ".git"))) {
    ui.warn("No .git directory found; git enforcement hooks skipped.");
    return;
  }
  await mkdir(hooksDir, { recursive: true });
  for (const hook of managedGitHookSpecs()) {
    const file = path.join(hooksDir, hook.name);
    // Idempotent regeneration: strip any Hivelore-owned block (current OR legacy hAIve) and rewrite,
    // so a stale `haive …` line is REPLACED, never left to run first — while a genuinely foreign hook
    // (husky/custom) is preserved and our block appended after it.
    const current = existsSync(file) ? await readFile(file, "utf8").catch(() => "") : "";
    await writeFile(file, buildHookFileContent(current, hook.body), "utf8");
    await chmod(file, 0o755);
  }
  ui.success("Installed git hooks: pre-commit, pre-push, commit-msg (blocking) + post-merge, post-rewrite (sync)");
}

async function installCiEnforcement(root: string): Promise<void> {
  const workflowsDir = path.join(root, ".github", "workflows");
  const workflowPath = path.join(workflowsDir, "hivelore-enforcement.yml");
  const legacyPath = path.join(workflowsDir, "haive-enforcement.yml");
  await mkdir(workflowsDir, { recursive: true });
  const workflow = renderCiEnforcementWorkflow();
  // Migrate: adopt the managed block from a legacy haive-enforcement.yml, then remove it so CI does
  // not run twice. Markers of both eras are recognised.
  const source = existsSync(workflowPath) ? workflowPath : existsSync(legacyPath) ? legacyPath : null;
  if (source) {
    const existing = await readFile(source, "utf8");
    const startAt = Math.max(existing.indexOf("# hivelore:enforcement-workflow:start"), existing.indexOf("# haive:enforcement-workflow:start"));
    const endMarker = existing.includes("# hivelore:enforcement-workflow:end") ? "# hivelore:enforcement-workflow:end" : "# haive:enforcement-workflow:end";
    const endAt = existing.indexOf(endMarker);
    if (startAt >= 0 && endAt > startAt) {
      await writeFile(workflowPath, existing.slice(0, startAt) + workflow + existing.slice(endAt + endMarker.length), "utf8");
      ui.success(`Updated ${path.relative(root, workflowPath)} managed block`);
    } else if (source === workflowPath) {
      ui.info("GitHub Actions enforcement workflow already exists without Hivelore markers — preserved");
      return;
    } else {
      await writeFile(workflowPath, workflow, "utf8");
      ui.success(`Created ${path.relative(root, workflowPath)}`);
    }
    if (source === legacyPath) {
      await rm(legacyPath, { force: true });
      ui.info(`Migrated ${path.relative(root, legacyPath)} → ${path.relative(root, workflowPath)}.`);
    }
    return;
  }
  await writeFile(workflowPath, workflow, "utf8");
  ui.success(`Created ${path.relative(root, workflowPath)}`);
}

export function renderCiEnforcementWorkflow(): string {
  return `# hivelore:enforcement-workflow:start
name: hivelore-enforcement

on:
  pull_request:
  push:
    branches: [main, master]

jobs:
  hivelore-enforcement:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install Hivelore
        run: npm install -g @hivelore/cli
      - name: Enforce Hivelore policy
        id: gate
        env:
          HIVELORE_BASE_SHA: \${{ github.event.pull_request.base.sha || github.event.before }}
          HIVELORE_HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          set +e
          hivelore enforce ci --json > "$RUNNER_TEMP/hivelore-gate.json"
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          exit 0
      - name: Upsert prevention receipt
        if: always() && github.event_name == 'pull_request'
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          if [ -z "\${GH_TOKEN:-}" ] || ! command -v gh >/dev/null 2>&1; then exit 0; fi
          hivelore stats receipt --since 7d --comment --gate "$RUNNER_TEMP/hivelore-gate.json" \\
            > "$RUNNER_TEMP/hivelore-receipt.md" || exit 0
          # Nothing fired and nothing in the rolling window → empty body → do not post a zero-count receipt.
          [ -s "$RUNNER_TEMP/hivelore-receipt.md" ] || exit 0
          comments="$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" --paginate --jq \\
            '.[] | select(.body | contains("<!-- haive:prevention-receipt -->")) | .id' 2>/dev/null | head -1)"
          if [ -n "$comments" ]; then
            gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comments" \\
              -F body=@"$RUNNER_TEMP/hivelore-receipt.md" >/dev/null 2>&1 || true
          else
            gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \\
              -F body=@"$RUNNER_TEMP/hivelore-receipt.md" >/dev/null 2>&1 || true
          fi
      - name: Report enforcement result
        if: always()
        run: |
          gate="$RUNNER_TEMP/hivelore-gate.json"
          if [ ! -f "$gate" ]; then
            echo "No enforcement output was produced." | tee -a "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          {
            echo "## Hivelore enforcement"
            echo
            if command -v jq >/dev/null 2>&1; then
              blocking="$(jq -r '[.findings[]? | select(.severity=="error")] | length' "$gate" 2>/dev/null || echo 0)"
              if [ "\${blocking:-0}" -gt 0 ]; then
                echo "**Refused — \${blocking} blocking finding(s):**"; echo
              else
                echo "**Passed** — no blocking findings."; echo
              fi
              jq -r '.findings[]? | "- **" + (.code // "finding") + "** (" + (.severity // "info") + "): " + (.message // "") + (if .matched_line then "\\n  matched: " + .matched_line else "" end) + (if .fix then "\\n  fix: " + .fix else "" end)' "$gate" 2>/dev/null || cat "$gate"
            else
              cat "$gate"
            fi
          } | tee -a "$GITHUB_STEP_SUMMARY"
      - name: Fail when enforcement blocked
        if: steps.gate.outputs.exit_code != '0'
        run: exit \${{ steps.gate.outputs.exit_code }}
# hivelore:enforcement-workflow:end
`;
}

/**
 * The part of a refusal worth reading, once the bullet has already named the lesson and the file.
 *
 * Finding messages are written to stand alone in a flat list ("Block sensor fired — <id>: <lesson>
 * (<file>)"), so rendering one under a bullet that already carries the id and the file printed both
 * twice. The bullet is the identity; this is the lesson.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refusalSummary(finding: EnforcementFinding, id: string): string {
  let text = finding.message.split("\n")[0] ?? "";
  // Drop the leading "<what fired> — <id>:" preamble the flat-list format needs.
  text = text.replace(new RegExp(`^.*?—\\s*${escapeRegExp(id)}\\s*:\\s*`), "");
  if (finding.file) text = text.replace(` (${finding.file})`, "");
  return text.replace(new RegExp(escapeRegExp(id), "g"), "").replace(/\s{2,}/g, " ").trim() || finding.code;
}

/**
 * When the gate blocks, lead with WHY in one line so the two very different failures never blur:
 * a documented lesson refusing THIS change vs. the repo's baseline not being set up yet. Without
 * this, a sensor block on a cold repo is buried among bootstrap/score noise and the developer can't
 * tell "I repeated a mistake" from "this repo isn't initialized" (found e2e-testing the cold path).
 */
function printBlockHeadline(report: EnforcementReport): void {
  const blocking = report.categories?.blocking ?? report.findings.filter((f) => f.severity === "error");
  if (blocking.length === 0) return;
  // One lesson, one line. The anti-pattern matcher and the sensor runner both legitimately fire on
  // the same memory, and reporting them separately turned a single bad line into four lines of
  // output at exactly the moment attention is most worth spending.
  const catches = dedupeRefusals(blocking);
  console.log();
  if (catches.length > 0) {
    console.log(ui.red(ui.bold("🛡️  A documented lesson refused this commit — about the change you just made:")));
    for (const c of catches) {
      const id = c.memory_ids?.[0] ?? c.code;
      const where = c.file ? ui.dim(` (${c.file})`) : "";
      console.log(`    ${ui.red("•")} ${ui.bold(id)}${where}  ${refusalSummary(c, id)}`);
      if (c.matched_line) console.log(`      ${ui.dim(c.matched_line)}`);
    }
  } else if (blocking.every((f) => SETUP_GATE_CODES.has(f.code))) {
    console.log(ui.yellow(ui.bold("⚙  Setup gate — about your repo's baseline, not the change you just made.")));
    console.log(ui.dim("    Fill the knowledge layer once (bootstrap / load a briefing); later commits pass silently."));
  }
}

/** Codes that describe the repo's standing baseline rather than the change being committed. Kept in
 * the report (doctor, CI, --explain) but hidden from the quiet interactive gate — they never block
 * and were the most frequent non-actionable nags (field reports 2026-09-01 §5.4, 2026-09-02 §3.4:
 * the same two process warnings printed on all ~20 commits of a session). */
const STANDING_STATE_CODES = new Set([
  "enforcement-score-below-threshold",
  "decision-coverage-missing",
  "briefing-missing",
  "bootstrap-incomplete",
]);

function printReport(report: EnforcementReport, json: boolean, explain = false, quiet = false): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const actionable = report.findings.filter((f) => f.severity === "error" || f.severity === "warn");
  // Standing-state findings describe the repo's baseline, not the change being committed: baseline
  // health and the decision-coverage ritual were the two most frequent, least actionable nags on
  // interactive runs (field report 2026-09-01 §5.4). Keep them in the report for `doctor`, CI, and
  // --explain, but drop them from the quiet interactive gate. They never block.
  const changeActionable = quiet
    ? actionable.filter((f) => !STANDING_STATE_CODES.has(f.code))
    : actionable;

  // SILENCE ON SUCCESS: a passing gate with nothing to act on is one line, not a page of ✓. A full
  // report on every clean commit buries the day a real block appears — the signal that matters most.
  // Verbose paths (CI, --explain) keep the whole report; `--verbose` (quiet=false) restores it too.
  if (quiet && !report.should_block && changeActionable.length === 0) {
    const ok = report.findings.filter((f) => f.severity === "ok").length;
    ui.success(`Hivelore gate passed${stageLabel(report)} — ${ok} check(s), 0 issue(s).`);
    return;
  }

  console.log(ui.bold(`Hivelore enforcement — ${report.mode}${report.actor ? ` · ${report.actor}` : ""}`));
  console.log(ui.dim(`  root: ${report.root}`));
  // Name what the number measures. "score: 40%" invited the reading "your change is 40% good";
  // it has only ever described the repo's standing knowledge layer.
  console.log(ui.dim(`  knowledge-layer health: ${report.score.score}% (target ${report.score.threshold}%)`));
  if (explain && report.posture) console.log(ui.dim(`  posture: ${report.posture}`));

  if (report.should_block) printBlockHeadline(report);

  if (explain) {
    printFindingGroup("Blocking", report.categories.blocking, "error");
    printFindingGroup("Review", report.categories.review, "warn");
    printFindingGroup("Info", report.categories.info, "info");
  } else if (quiet) {
    // Show only what needs action; drop the reassuring ✓/• noise (the passing checks). When the
    // headline already named a refusal, do not print the same memory again underneath it.
    // Keyed by MEMORY, not by code: the anti-pattern matcher and the sensor runner report the same
    // lesson under two different codes, so keying on the code would still print it twice.
    const named = new Set(
      report.should_block
        ? dedupeRefusals(report.findings).flatMap((f) => f.memory_ids ?? []).filter(Boolean)
        : [],
    );
    for (const finding of actionable) {
      const isNamedRefusal =
        CONTENT_CATCH_CODES.has(finding.code) && (finding.memory_ids ?? []).some((id) => named.has(id));
      if (isNamedRefusal) continue;
      if (STANDING_STATE_CODES.has(finding.code)) continue;
      printFinding(finding);
    }
  } else {
    for (const finding of report.findings) printFinding(finding);
  }
  if (report.should_block) ui.error("Hivelore enforcement gate failed.");
  else if (changeActionable.length > 0) ui.success(`Hivelore gate passed${stageLabel(report)} — ${changeActionable.length} advisory finding(s), 0 blocking.`);
  else ui.success(`Hivelore enforcement gate passed${stageLabel(report)}.`);
  // A blocking rule can be a false positive. Name the escape hatch at the one moment it is natural —
  // the block itself — or friction is only ever reported into commit messages (field report §2.1).
  if (report.should_block && report.findings.some((f) => CONTENT_CATCH_CODES.has(f.code))) {
    console.log(ui.dim("  Blocked wrongly? Flag it with the `report_friction` MCP tool — a human reviews it, nothing is sent."));
  }
}

/** Name the hook/stage in the pass line so pre-commit (then pre-push on the same push) don't read
 * as one gate printed twice with mismatched counts (field report 2026-09-01 §4.4). */
function stageLabel(report: EnforcementReport): string {
  return report.stage && report.stage !== "local" ? ` (${report.stage})` : "";
}

function printFindingGroup(
  title: string,
  findings: EnforcementFinding[],
  tone: "error" | "warn" | "info",
): void {
  if (findings.length === 0) return;
  console.log();
  const heading = tone === "error" ? ui.red(title) : tone === "warn" ? ui.yellow(title) : ui.bold(title);
  console.log(ui.bold(`${heading} (${findings.length})`));
  const scoreFinding = findings.find((f) => f.code === "enforcement-score-below-threshold");
  for (const finding of findings.filter((f) => f.code !== "enforcement-score-below-threshold")) {
    printFinding(finding, true);
  }
  if (scoreFinding) printFinding(scoreFinding, true);
}

function printFinding(finding: EnforcementFinding, explain = false): void {
    const marker = finding.severity === "error"
      ? ui.red("✗")
      : finding.severity === "warn"
        ? ui.yellow("⚠")
        : finding.severity === "ok"
          ? ui.green("✓")
          : ui.dim("•");
    console.log(`${marker} ${finding.code}: ${explain ? finding.message : finding.short_message ?? finding.message}`);
    if (explain && finding.reason) console.log(ui.dim(`  why: ${finding.reason}`));
    if (explain && finding.affected_files?.length) console.log(ui.dim(`  files: ${finding.affected_files.join(", ")}`));
    if (explain && finding.memory_ids?.length) console.log(ui.dim(`  memories: ${finding.memory_ids.join(", ")}`));
    if (finding.fix) console.log(ui.dim(`${explain ? "  repair: " : "  fix: "}${finding.fix}`));
}

/**
 * Turn the blocking report into one guided next step. Findings are produced in protocol order
 * (worktree clean → synced → version bumped → tag → push → CI), so the first blocking finding
 * with a fix IS the next required action. Surfacing it removes the "assemble the steps yourself"
 * burden that makes the exit protocol error-prone.
 */
function printNextRequiredAction(report: EnforcementReport): void {
  const blocker = report.findings.find((f) => f.severity === "error" && f.fix);
  if (!blocker) return;
  console.log("");
  console.log(ui.bold("→ NEXT REQUIRED ACTION") + ui.dim(`  (${blocker.code})`));
  for (const line of blocker.fix!.split("\n")) console.log(`  ${line}`);
}

async function applyLightweightRepairs(
  root: string,
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<void> {
  await applyAutopilotRepairs(root, paths, {
    applyConfig: false,
    applyContext: true,
    applyCorpus: true,
    applyCodeMap: false,
    applyCodeSearch: true,
  }).catch(() => { /* lightweight repair is best-effort */ });
}

async function readHookPayload(): Promise<HookPayload> {
  const raw = await readStdin(MAX_STDIN_BYTES);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

function resolveRoot(dir: string | undefined, payload: HookPayload): string | null {
  try {
    return findProjectRoot(dir ?? payload.cwd);
  } catch {
    return null;
  }
}

function isWriteLikeTool(payload: HookPayload): boolean {
  const tool = payload.tool_name ?? "";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return true;
  if (tool !== "Bash") return false;
  const command = String(payload.tool_input?.["command"] ?? "");
  return /\b(rm|mv|cp|mkdir|touch|tee|sed|perl|python|node|npm|pnpm|yarn|git)\b/.test(command) ||
    />{1,2}/.test(command);
}

function extractToolPaths(payload: HookPayload, root: string): string[] {
  const input = payload.tool_input ?? {};
  const values: unknown[] = [
    input["file_path"],
    input["path"],
    input["notebook_path"],
  ];
  if (Array.isArray(input["file_paths"])) values.push(...input["file_paths"]);
  if (Array.isArray(input["files"])) values.push(...input["files"]);

  if (payload.tool_name === "MultiEdit" && Array.isArray(input["edits"])) {
    for (const edit of input["edits"]) {
      if (edit && typeof edit === "object" && "file_path" in edit) {
        values.push((edit as { file_path?: unknown }).file_path);
      }
    }
  }

  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    out.add(normalizeToolPath(value, root));
  }
  return [...out].filter(Boolean).sort();
}

function normalizeToolPath(file: string, root: string): string {
  const normalized = file.replace(/\\/g, "/");
  if (!path.isAbsolute(normalized)) return normalized.replace(/^\.\//, "");
  return path.relative(root, normalized).replace(/\\/g, "/");
}

async function missingRequiredMemoriesForFiles(
  paths: ReturnType<typeof resolveHaivePaths>,
  files: string[],
  sessionId?: string,
): Promise<LoadedMemory[]> {
  if (!existsSync(paths.memoriesDir)) return [];
  const marker = await readRecentBriefingMarker(paths, sessionId);
  const consulted = new Set(marker?.memory_ids ?? []);
  const policyTypes = new Set(["decision", "gotcha", "architecture", "convention", "attempt"]);
  const all = await loadMemoriesFromDir(paths.memoriesDir);
  return all
    .filter(({ memory }) => {
      const fm = memory.frontmatter;
      if (!policyTypes.has(fm.type)) return false;
      if (fm.status !== "validated") return false;
      if (consulted.has(fm.id)) return false;
      return memoryMatchesAnchorPaths(memory, files);
    })
    .map(({ memory, filePath }) => ({ memory, filePath }));
}

/**
 * Hivelore-generated `.ai/` artifacts that the agent never authors — they are re-synced by the
 * lightweight repair (version header, code-map) or are pure telemetry. Requiring a human-reviewed
 * "decision" to cover them is friction with no value, and it caused the gate to block release
 * commits whose only "uncovered" change was a repair-touched artifact. Excluded from
 * decision-coverage's notion of "changed files". Source code and real `.ai/memories/*` still count.
 */
function isGeneratedArtifact(file: string): boolean {
  if (file === ".ai/project-context.md" || file === ".ai/code-map.json") return true;
  if (file.startsWith(".ai/.cache/") || file.startsWith(".ai/.runtime/") || file.startsWith(".ai/.usage/")) return true;
  return false;
}

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        process.stdin.destroy();
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 2000);
  });
}

/**
 * Stage `.ai/` artifacts that a pre-commit lightweight repair just re-synced
 * (currently the project-context version header) so the release commit is atomic.
 * Best-effort — never blocks a commit. Scoped to the project-context file so it does
 * not sweep in telemetry churn (e.g. the tool-usage log) that belongs in a later sync.
 */
/** Machine-local `.ai/` subtrees that must NOT enter the release commit — they belong in a
 *  separate later `chore: hivelore sync` push (telemetry, runtime markers, derived caches). */
const ATOMIC_STAGE_EXCLUDE = ["/.usage/", "/.runtime/", "/.cache/"];

async function stageResyncedArtifacts(
  root: string,
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<void> {
  // Stage every tracked `.ai/` file the lightweight repair just re-synced (project-context
  // version header, auto-promoted/re-validated memories, code-map) so the release commit is
  // atomic and the haive-sync workflow has nothing left to commit as a `[skip ci]` tip.
  // `git diff --name-only` lists only tracked files with UNSTAGED changes, relative to the repo
  // root — exactly the repair output. Telemetry subtrees are excluded on purpose.
  const aiRel = path.relative(root, paths.haiveDir);
  const out = await runCommand("git", ["diff", "--name-only", "--", aiRel], root).catch(() => "");
  const toStage = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !ATOMIC_STAGE_EXCLUDE.some((excl) => `/${file}`.includes(excl)));
  if (toStage.length === 0) return;
  await runCommand("git", ["add", "--", ...toStage], root).catch(() => { /* best-effort */ });
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${cmd} exited with code ${code}`));
    });
  });
}
