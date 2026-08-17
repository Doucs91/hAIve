import { Command } from "commander";
import { registerBriefing } from "./commands/briefing.js";
import { registerEmbeddings, registerIndexSemantic } from "./commands/embeddings.js";
import { registerIndexCode } from "./commands/index-code.js";
import { registerInit } from "./commands/init.js";
import { registerObserve } from "./commands/observe.js";
import { registerMcp } from "./commands/mcp.js";
import { registerSync } from "./commands/sync.js";
import { registerMemoryAdd } from "./commands/memory-add.js";
import { registerMemoryList } from "./commands/memory-list.js";
import { registerMemoryPromote } from "./commands/memory-promote.js";
import { registerMemoryApprove } from "./commands/memory-approve.js";
import { registerMemoryUpdate } from "./commands/memory-update.js";
import { registerMemoryTried } from "./commands/memory-tried.js";
import { registerMemorySeed } from "./commands/memory-seed.js";
import { registerMemoryQuery } from "./commands/memory-query.js";
import { registerMemoryReject } from "./commands/memory-reject.js";
import { registerMemoryRm } from "./commands/memory-rm.js";
import { registerMemoryShow } from "./commands/memory-show.js";
import { registerMemoryStats } from "./commands/memory-stats.js";
import { registerMemoryImpact } from "./commands/memory-impact.js";
import { registerMemoryFeedback } from "./commands/memory-feedback.js";
import { registerMemoryVerify } from "./commands/memory-verify.js";
import { registerMemoryImport } from "./commands/memory-import.js";
import { registerMemoryDigest } from "./commands/memory-digest.js";
import { registerSessionEnd } from "./commands/session-end.js";
import { registerStats } from "./commands/stats.js";
import { registerBench } from "./commands/bench.js";
import { registerBenchmark } from "./commands/benchmark.js";
import { registerEval } from "./commands/eval.js";
import { registerMemorySuggest } from "./commands/memory-suggest.js";
import { registerMemoryPending } from "./commands/memory-pending.js";
import { registerMemorySeedGit } from "./commands/memory-seed-git.js";
import { registerMemoryImportChangelog } from "./commands/memory-import-changelog.js";
import { registerMemoryConflictCandidates } from "./commands/memory-conflict-candidates.js";
import { registerMemoryResolveConflict } from "./commands/memory-resolve-conflict.js";
import { registerMemoryArchive } from "./commands/memory-archive.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerPrecommit } from "./commands/precommit.js";
import { registerMemoryLint } from "./commands/memory-lint.js";
import { registerResolveProject } from "./commands/resolve-project.js";
import { registerEnforce } from "./commands/enforce.js";
import { registerRelease } from "./commands/release.js";
import { registerRun } from "./commands/run.js";
import { registerAgent } from "./commands/agent.js";
import { registerSensors } from "./commands/sensors.js";
import { registerIngest } from "./commands/ingest.js";
import { registerReport } from "./commands/report.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerDevLink } from "./commands/dev-link.js";
import { registerCoverage } from "./commands/coverage.js";
import { registerMergeDriver } from "./commands/merge-driver.js";
// --- Lot C ---
import { registerBridges } from "./commands/bridges.js";

const program = new Command();

declare const __HAIVE_VERSION__: string;

program
  .name("hivelore")
  .description("Hivelore - the deterministic policy gate for agent-written code (rules live as repo-native team memory)")
  .version(__HAIVE_VERSION__)
  .option("--advanced", "show maintenance and experimental commands in help")
  // Agents guess flags by analogy (`--content` for `--body`, `--summary` for `--goal`) and a
  // bare "unknown option" dead-ends them. Must run BEFORE the register* calls so subcommands
  // created via program.command() inherit the setting.
  .showSuggestionAfterError(true);

registerInit(program);
registerResolveProject(program);
registerEnforce(program);
registerRelease(program);
registerRun(program);
registerAgent(program);
registerSensors(program);
registerIngest(program);
registerReport(program);
registerDashboard(program);
registerCoverage(program);
registerMergeDriver(program);
registerDevLink(program);

registerMcp(program);
registerBriefing(program);
registerEmbeddings(program);
registerSync(program);
registerBridges(program); // --- Lot C ---
registerObserve(program);
registerIndexSemantic(registerIndexCode(program));

const memory = program.command("memory").description("Manage memory entries");
registerMemoryAdd(memory);
registerMemoryList(memory);
registerMemoryQuery(memory);
registerMemoryPromote(memory);
registerMemoryVerify(memory);
registerMemoryStats(memory);
registerMemoryImpact(memory);
registerMemoryFeedback(memory);
registerMemoryReject(memory);
registerMemoryShow(memory);
registerMemoryRm(memory);
registerMemoryApprove(memory);
registerMemoryUpdate(memory);
registerMemoryTried(memory);
registerMemorySeed(memory);
registerMemoryImport(memory);
registerMemoryDigest(memory);
registerMemorySuggest(memory);
registerMemoryPending(memory);          // hidden alias — canonical: memory list --pending
registerMemorySeedGit(memory);          // hidden alias — canonical: memory seed --git
registerMemoryImportChangelog(memory);  // hidden alias — canonical: memory import --changelog
registerMemoryConflictCandidates(memory); // `memory conflicts [a] [b]` (+ alias conflict-candidates)
registerMemoryResolveConflict(memory);  // hidden alias — canonical: memory conflicts <a> <b>
registerMemoryArchive(memory);
registerMemoryLint(memory);

const session = program.command("session").description(
  "Manage session lifecycle.\n\n" +
  "  Session start is automatic — Hivelore loads context via `get_briefing` at the start\n" +
  "  of each agent session (Claude Code SessionStart hook or MCP first call).\n" +
  "  Use `hivelore session end` to save a rich end-of-session recap for the next session.",
);
registerSessionEnd(session);

registerStats(program);
registerBench(program);
registerBenchmark(program);
registerEval(program);
registerDoctor(program);
registerPrecommit(program);

// The core harness loop only — what a developer actually types day to day. Everything else
// (tui dashboard, welcome onboarding, the manual `precommit` variant of `enforce check`, plus the
// maintenance/experimental families) stays one `--advanced` away. A focused surface is part of the
// positioning: Hivelore is repo context policy for coding-agent harnesses, not a 54-command Swiss army knife.
const CORE_ROOT_COMMANDS = new Set([
  "init",
  "doctor",
  "agent",
  "briefing",
  "bridges", // --- Lot C ---
  "enforce",
  "run",
  "sensors",
  "sync",
  "mcp",
  "memory",
  "session",
]);

// Canonical verbs mirror the MCP tool names (mem_save / mem_search / mem_get / mem_delete)
// so an agent learns one vocabulary across both façades. Old verbs (add/query/show/rm) stay
// as command aliases, so existing scripts keep working.
const CORE_MEMORY_COMMANDS = new Set([
  "save",
  "list",
  "search",
  "get",
  "verify",
  "lint",
  "tried",
  "delete",
]);

const CORE_SESSION_COMMANDS = new Set(["end"]);

applySurfaceVisibility(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (isZodError(err)) {
    for (const issue of err.issues) {
      const field = issue.path.length > 0 ? `${String(issue.path.join("."))}: ` : "";
      console.error(`\x1b[31m✗\x1b[0m ${field}${issue.message}`);
    }
  } else {
    // Default to the message so gate output stays clean; set HIVELORE_DEBUG=1 for the full stack
    // when a swallowed error (e.g. a RangeError deep in diff processing) needs to be located.
    console.error(err instanceof Error ? (process.env.HIVELORE_DEBUG ? err.stack ?? err.message : err.message) : err);
  }
  process.exit(1);
});

function applySurfaceVisibility(root: Command): void {
  const showAdvanced =
    process.argv.includes("--advanced") || process.env.HAIVE_SHOW_ADVANCED === "1";

  if (!showAdvanced) hideNonCoreCommands(root);

  // Families block lists advanced command names, so it only shows in advanced help —
  // the default help stays focused on the golden path (those names would otherwise leak
  // into the core surface).
  const familiesBlock = showAdvanced
    ? [
        "",
        "Advanced surface, by family:",
        "  reports:  dashboard · stats                    eval:     eval · benchmark · selftest (alias: bench)",
        "  index:    index code|memories|query            runtime:  observe (hook plumbing)",
        "  ops:      memory <sub> · sensors · ingest · sync · release · precommit (= enforce check)",
        "  feedback: report list|submit|dismiss (friction agents hit with Hivelore itself)",
      ]
    : [];
  root.addHelpText(
    "after",
    [
      "",
      "Golden path (what you type day to day):",
      "  init → doctor → agent setup → briefing → memory save/tried → sensors check → enforce finish → sync → session end",
      "",
      "Memory verbs mirror the MCP tools: memory save/search/get/delete <-> mem_save/mem_search/mem_get/mem_delete",
      "(old verbs add/query/show/rm still work as aliases).",
      ...familiesBlock,
      "",
      "Run `hivelore --advanced --help` or set HAIVE_SHOW_ADVANCED=1 to show maintenance and experimental commands.",
    ].join("\n"),
  );
  const memoryCommand = root.commands.find((cmd) => cmd.name() === "memory");
  memoryCommand?.addHelpText(
    "after",
    [
      "",
      "Default help shows the memory commands that support the core harness workflow.",
      "Run `hivelore --advanced memory --help` or set HAIVE_SHOW_ADVANCED=1 to show review, import, digest, timeline, and conflict tools.",
    ].join("\n"),
  );
}

function hideNonCoreCommands(command: Command): void {
  for (const child of command.commands) {
    if (!isCoreCommand(command, child)) {
      (child as unknown as { _hidden: boolean })._hidden = true;
    }
    hideNonCoreCommands(child);
  }
}

function isCoreCommand(parent: Command, child: Command): boolean {
  const parentName = parent.name();
  const childName = child.name();
  if (parentName === "hivelore") return CORE_ROOT_COMMANDS.has(childName);
  if (parentName === "memory") return CORE_MEMORY_COMMANDS.has(childName);
  if (parentName === "session") return CORE_SESSION_COMMANDS.has(childName);
  return true;
}

function isZodError(
  err: unknown,
): err is { issues: Array<{ path: unknown[]; message: string }> } {
  return (
    err !== null &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as Record<string, unknown>).issues)
  );
}
