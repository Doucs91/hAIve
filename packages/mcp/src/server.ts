import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createContext, type CreateContextOptions, type HaiveContext } from "./context.js";
import {
  BootstrapProjectSaveInputSchema,
  bootstrapProjectSave,
  type BootstrapProjectSaveInput,
} from "./tools/bootstrap-project-save.js";
import {
  GetProjectContextInputSchema,
  getProjectContext,
  type GetProjectContextInput,
} from "./tools/get-project-context.js";
import { MemListInputSchema, memList, type MemListInput } from "./tools/mem-list.js";
import { MemSaveInputSchema, memSave, type MemSaveInput } from "./tools/mem-save.js";
import {
  MemSearchInputSchema,
  memSearch,
  type MemSearchInput,
} from "./tools/mem-search.js";
import {
  MemVerifyInputSchema,
  memVerify,
  type MemVerifyInput,
} from "./tools/mem-verify.js";
import {
  MemRejectInputSchema,
  memReject,
  type MemRejectInput,
} from "./tools/mem-reject.js";
import {
  MemFeedbackInputSchema,
  memFeedback,
  type MemFeedbackInput,
} from "./tools/mem-feedback.js";
import {
  MemForFilesInputSchema,
  memForFiles,
  type MemForFilesInput,
} from "./tools/mem-for-files.js";
import { MemGetInputSchema, memGet, type MemGetInput } from "./tools/mem-get.js";
import {
  MemDeleteInputSchema,
  memDelete,
  type MemDeleteInput,
} from "./tools/mem-delete.js";
import {
  MemUpdateInputSchema,
  memUpdate,
  type MemUpdateInput,
} from "./tools/mem-update.js";
import {
  MemPendingInputSchema,
  memPending,
  type MemPendingInput,
} from "./tools/mem-pending.js";
import {
  MemApproveInputSchema,
  memApprove,
  type MemApproveInput,
} from "./tools/mem-approve.js";
import {
  MemTriedInputSchema,
  memTried,
  type MemTriedInput,
} from "./tools/mem-tried.js";
import {
  ProposeSensorInputSchema,
  proposeSensor,
  type ProposeSensorInput,
} from "./tools/propose-sensor.js";
import {
  ScaffoldTestInputSchema,
  scaffoldTest,
  type ScaffoldTestInput,
} from "./tools/scaffold-test.js";
import {
  IngestFindingsInputSchema,
  ingestFindings,
  type IngestFindingsInput,
} from "./tools/ingest-findings.js";
import {
  MemSessionEndInputSchema,
  memSessionEnd,
  type MemSessionEndInput,
} from "./tools/mem-session-end.js";
import {
  GetBriefingInputSchema,
  getBriefing,
  type GetBriefingInput,
} from "./tools/get-briefing.js";
import {
  CodeMapInputSchema,
  codeMapTool,
  type CodeMapInput,
} from "./tools/code-map.js";
import {
  MemDiffInputSchema,
  memDiff,
  type MemDiffInput,
} from "./tools/mem-diff.js";
import {
  GetRecapInputSchema,
  getRecap,
  type GetRecapInput,
} from "./tools/get-recap.js";
import {
  MemRelevantToInputSchema,
  memRelevantTo,
  type MemRelevantToInput,
} from "./tools/mem-relevant-to.js";
import {
  CodeSearchInputSchema,
  codeSearch,
  type CodeSearchInput,
} from "./tools/code-search.js";
import {
  AntiPatternsCheckInputSchema,
  antiPatternsCheck,
  type AntiPatternsCheckInput,
} from "./tools/anti-patterns-check.js";
import {
  MemDistillInputSchema,
  memDistill,
  type MemDistillInput,
} from "./tools/mem-distill.js";
import {
  PreCommitCheckInputSchema,
  preCommitCheck,
  type PreCommitCheckInput,
} from "./tools/precommit-check.js";
import {
  MemConflictCandidatesInputSchema,
  memConflictCandidates,
  type MemConflictCandidatesInput,
} from "./tools/mem-conflict-candidates.js";
import {
  MemResolveProjectInputSchema,
  memResolveProject,
  type MemResolveProjectInput,
} from "./tools/mem-resolve-project.js";
import {
  MemSuggestTopicInputSchema,
  memSuggestTopic,
  type MemSuggestTopicInput,
} from "./tools/mem-suggest-topic.js";
import {
  MemTimelineInputSchema,
  memTimeline,
  type MemTimelineInput,
} from "./tools/mem-timeline.js";
import {
  BootstrapProjectArgsSchema,
  bootstrapProjectPrompt,
  type BootstrapProjectArgs,
} from "./prompts/bootstrap-project.js";
import {
  BootstrapRepoArgsSchema,
  bootstrapRepoPrompt,
  type BootstrapRepoArgs,
} from "./prompts/bootstrap-repo.js";
import {
  PostTaskArgsSchema,
  postTaskPrompt,
  type PostTaskArgs,
} from "./prompts/post-task.js";
import {
  ImportDocsArgsSchema,
  importDocsPrompt,
  type ImportDocsArgs,
} from "./prompts/import-docs.js";
import { SessionTracker } from "./session-tracker.js";
import { hasRecentBriefingMarker, loadConfigSync } from "@hivelore/core";

// Re-export tool implementations so `@hivelore/cli` (and integrators) can call
// them programmatically without going through the MCP stdio transport.
// These are the same handlers the MCP server registers below.
export {
  getBriefing,
  type GetBriefingInput,
  type BriefingOutput,
} from "./tools/get-briefing.js";
export {
  codeMapTool,
  type CodeMapInput,
  type CodeMapToolOutput,
} from "./tools/code-map.js";
export {
  getRecap,
  type GetRecapInput,
  type GetRecapOutput,
} from "./tools/get-recap.js";
export {
  memRelevantTo,
  type MemRelevantToInput,
  type MemRelevantToOutput,
} from "./tools/mem-relevant-to.js";
export {
  codeSearch,
  type CodeSearchInput,
  type CodeSearchOutput,
} from "./tools/code-search.js";
export {
  antiPatternsCheck,
  type AntiPatternsCheckInput,
  type AntiPatternsCheckOutput,
} from "./tools/anti-patterns-check.js";
export {
  memDistill,
  type MemDistillInput,
  type MemDistillOutput,
} from "./tools/mem-distill.js";
export {
  preCommitCheck,
  type PreCommitCheckInput,
  type PreCommitCheckOutput,
} from "./tools/precommit-check.js";
export { readPresumedCorrectTargets } from "./tools/propose-sensor.js";
export {
  astEngineAvailable,
  astLangForPath,
  runAstPattern,
  runAstSensorOnContent,
  type AstMatch,
  type AstScanResult,
} from "./ast-sensors.js";
export { memTried, type MemTriedOutput } from "./tools/mem-tried.js";
export { proposeSensor, type ProposeSensorOutput } from "./tools/propose-sensor.js";
export {
  scaffoldTest,
  detectTestFrameworkForPaths,
  detectTestFrameworksForAnchors,
  type AnchorFrameworkGroup,
  type ScaffoldTestOutput,
} from "./tools/scaffold-test.js";
export {
  memResolveProject,
  type MemResolveProjectInput,
} from "./tools/mem-resolve-project.js";
export {
  memSuggestTopic,
  type MemSuggestTopicInput,
} from "./tools/mem-suggest-topic.js";
export {
  memTimeline,
  type MemTimelineInput,
} from "./tools/mem-timeline.js";
export {
  memConflictCandidates,
  type MemConflictCandidatesInput,
} from "./tools/mem-conflict-candidates.js";

declare const __HAIVE_VERSION__: string;

export const SERVER_NAME = "hivelore";
export const SERVER_VERSION = __HAIVE_VERSION__;
export type ToolProfile = "enforcement" | "maintenance" | "experimental" | "full";

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export const ENFORCEMENT_PROFILE_TOOLS = [
  "get_briefing",
  "mem_save",
  "mem_tried",
  "mem_search",
  "mem_get",
  "mem_verify",
  "mem_relevant_to",
  "code_map",
  "code_search",
  "pre_commit_check",
  "mem_session_end",
  "propose_sensor",
  "scaffold_test",
] as const;

export const MAINTENANCE_PROFILE_TOOLS = [
  ...ENFORCEMENT_PROFILE_TOOLS,
  "mem_suggest_topic",
  "mem_for_files",
  "mem_list",
  "get_project_context",
  "bootstrap_project_save",
  "mem_resolve_project",
  "mem_update",
  "mem_approve",
  "mem_reject",
  "mem_pending",
  "mem_delete",
  "mem_diff",
  "get_recap",
  "anti_patterns_check",
  "mem_distill",
  "mem_timeline",
  "mem_conflict_candidates",
  "mem_feedback",
  "ingest_findings",
] as const;

// v0.32.0 surface reduction: the experimental tools (mem_observe, why_this_file,
// why_this_decision, mem_conflicts_with, pattern_detect, runtime_journal_*) were removed —
// months of usage logs showed a single call across all of them. The profile name stays as
// a deprecated alias of maintenance so existing HAIVE_TOOL_PROFILE=experimental configs keep working.
export const EXPERIMENTAL_PROFILE_TOOLS = [
  ...MAINTENANCE_PROFILE_TOOLS,
] as const;

export const TOOL_PROFILES: Record<Exclude<ToolProfile, "full">, ReadonlySet<string>> = {
  enforcement: new Set(ENFORCEMENT_PROFILE_TOOLS),
  maintenance: new Set(MAINTENANCE_PROFILE_TOOLS),
  experimental: new Set(EXPERIMENTAL_PROFILE_TOOLS),
};

export function getAllowedToolsForProfile(profile: ToolProfile): ReadonlySet<string> {
  if (profile === "full") return TOOL_PROFILES.experimental;
  return TOOL_PROFILES[profile] ?? TOOL_PROFILES.enforcement;
}

const BRIEFING_TOOLS = new Set(["get_briefing", "mem_relevant_to"]);

const MUTATING_TOOLS = new Set([
  "mem_save",
  "mem_tried",
  "mem_session_end",
  "bootstrap_project_save",
  "mem_update",
  "mem_approve",
  "mem_reject",
  "mem_delete",
  "mem_feedback",
  "ingest_findings",
  "propose_sensor",
]);

export function createHaiveServer(
  options: CreateContextOptions = {},
): { server: McpServer; context: HaiveContext; tracker: SessionTracker } {
  const context = createContext(options);
  const config = loadConfigSync(context.paths);
  const toolProfile =
    (options.env?.HIVELORE_TOOL_PROFILE as ToolProfile | undefined) ??
    (options.env?.HAIVE_TOOL_PROFILE as ToolProfile | undefined) ?? // legacy env name
    config.enforcement?.toolProfile ??
    "enforcement";
  const requireBriefingFirst =
    options.env?.HAIVE_REQUIRE_BRIEFING_FIRST === "0"
      ? false
      : config.enforcement?.requireBriefingFirst ?? true;
  let briefingLoaded = false;
  const tracker = new SessionTracker(context);
  // Init is async — fire-and-forget at startup (registers shutdown handler if autopilot)
  void tracker.init();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  const allowedTools = getAllowedToolsForProfile(toolProfile);

  const shouldRegisterTool = (name: string): boolean => allowedTools.has(name);

  const registerTool = <TInput>(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (input: TInput) => Promise<unknown> | unknown,
  ): void => {
    if (!shouldRegisterTool(name)) return;
    const tool = server.tool.bind(server) as (
      toolName: string,
      toolDescription: string,
      toolSchema: Record<string, unknown>,
      toolHandler: (input: unknown) => Promise<unknown> | unknown,
    ) => unknown;
    tool(
      name,
      description,
      schema,
      async (input: unknown) => {
        if (BRIEFING_TOOLS.has(name)) {
          briefingLoaded = true;
          return await handler(input as TInput);
        }
        if (requireBriefingFirst && MUTATING_TOOLS.has(name) && !briefingLoaded) {
          // Fall back to the disk-persisted marker before blocking — covers client
          // reconnections where the server process is fresh but a recent briefing ran.
          const hasDiskMarker = await hasRecentBriefingMarker(context.paths).catch(() => false);
          if (hasDiskMarker) {
            briefingLoaded = true;
          } else {
            return jsonResult({
              error: "haive_briefing_required",
              message:
                "This Hivelore project requires get_briefing or mem_relevant_to before state-changing Hivelore tools. Call get_briefing({ task: '...' }) first.",
              tool: name,
            });
          }
        }
        return await handler(input as TInput);
      },
    );
  };

  const shouldRegisterPrompt = (name: string): boolean => {
    if (name === "bootstrap_project" || name === "bootstrap_repo" || name === "post_task") return true;
    if (name === "import_docs") return toolProfile !== "enforcement";
    return toolProfile === "experimental" || toolProfile === "full";
  };

  // ── Memory creation ────────────────────────────────────────────────────

  registerTool(
    "mem_save",
    [
      "Save a piece of knowledge as a persistent memory that survives across AI sessions.",
      "",
      "USE THIS WHEN you discover something worth remembering for future sessions:",
      "  - A project convention (how things are done here)",
      "  - An architectural decision and its rationale",
      "  - A gotcha or non-obvious behavior that surprised you",
      "  - A domain term and what it means in this codebase",
      "",
      "DO NOT USE for failed approaches → use mem_tried instead (better structure).",
      "For reactive code discoveries during exploration, prefer a compact gotcha via mem_save.",
      "",
      "PARAMETERS:",
      "  type     — convention | decision | gotcha | architecture | glossary | attempt",
      "  slug     — short kebab-case id (e.g. 'flyway-no-modify-existing')",
      "  body     — Markdown content with the full knowledge",
      "  scope    — team (shared with all devs) | personal (private) | module (component-scoped)",
      "  paths    — anchor to source files for staleness detection (STRONGLY recommended)",
      "  topic    — stable key for upsert: if a memory with same topic+scope exists, update it in-place",
      "",
      "RETURNS: { id, scope, file_path, action: 'created'|'updated', warning?, invalid_paths? }",
      "WARNING: if paths point to non-existent files, they will be immediately stale after hivelore sync.",
      "DEDUP: identical body content within the same scope is rejected — use mem_update to modify.",
    ].join("\n"),
    MemSaveInputSchema,
    async (input: MemSaveInput) => {
      tracker.record("mem_save", input.slug);
      return jsonResult(await memSave(input, context));
    },
  );

  registerTool(
    "mem_suggest_topic",
    [
      "Propose a stable `topic` key (topic-upsert) from type + short title.",
      "",
      "USE BEFORE mem_save when you want deterministic updates to the same memory over time;",
      "families mimic Engram-style grouping (architecture/*, bug/*, decision/*, …).",
      "",
      "PARAMETERS:",
      "  type  — convention | decision | gotcha | architecture | glossary | attempt | session_recap",
      "  title — phrase to slugify under the suggested family prefix",
      "",
      "RETURNS: { topic_key, family, type }",
    ].join("\n"),
    MemSuggestTopicInputSchema,
    async (input: MemSuggestTopicInput) =>
      jsonResult(await memSuggestTopic(input, context)),
  );

  registerTool(
    "mem_tried",
    [
      "Record a FAILED approach so future agents don't repeat the same mistake.",
      "",
      "USE THIS IMMEDIATELY when you try something and it doesn't work. This is the",
      "most valuable type of negative knowledge — it saves hours of debugging for",
      "future agents working on the same codebase.",
      "",
      "Auto-validated (no approval cycle). Surfaced FIRST in future get_briefing calls",
      "so it's impossible to miss.",
      "",
      "PARAMETERS:",
      "  what       — short title of what you tried (e.g. 'importing X with ESM dynamic import')",
      "  why_failed — the exact error or reason it failed",
      "  instead    — what to do instead (the correct approach)",
      "  scope      — team (default) | personal",
      "  paths      — source files where the issue lives",
      "",
      "RETURNS: { id, file_path, action: 'created' }",
    ].join("\n"),
    MemTriedInputSchema,
    async (input: MemTriedInput) => {
      tracker.record("mem_tried", input.what.slice(0, 80));
      return jsonResult(await memTried(input, context));
    },
  );

  registerTool(
    "propose_sensor",
    [
      "Propose a discriminating sensor for a gotcha/attempt — YOU write the pattern (you understand the",
      "code), Hivelore validates it before trusting it to block. This is how a captured lesson becomes a",
      "RELIABLE block instead of an advisory note.",
      "",
      "USE THIS right after mem_tried / mem_save on a gotcha whose mistake is detectable in code, to",
      "upgrade the auto-suggested (warn) sensor into a precise, promotable one.",
      "",
      "Write a pattern that matches the FAULTY usage, and — crucially — an `absent` regex for the",
      "CORRECT-usage marker so it fires on the bug only, not every call (e.g. pattern=the API call,",
      "absent=the required option).",
      "",
      "VALIDATION (a `block` proposal is accepted ONLY if): the pattern is not brittle, stays SILENT on",
      "the current (correct) anchored code, and FIRES on the bad example. A rejected proposal is NOT",
      "written — the returned `reason`/`guidance` tells you how to revise; then call propose_sensor again.",
      "",
      "PARAMETERS:",
      "  memory_id  — the gotcha/attempt to protect",
      "  pattern    — regex matching the faulty usage",
      "  absent     — regex for the correct-usage marker (makes it discriminate) — strongly recommended",
      "  bad_example— a snippet that SHOULD match (else examples are read from the lesson)",
      "  severity   — 'block' (default) | 'warn'",
      "",
      "RETURNS: { accepted, reason?, guidance?, self_check, file_path? }",
    ].join("\n"),
    ProposeSensorInputSchema,
    async (input: ProposeSensorInput) => {
      tracker.record("propose_sensor", input.memory_id);
      return jsonResult(await proposeSensor(input, context));
    },
  );

  registerTool(
    "scaffold_test",
    [
      "Generate a PENDING post-incident test from a lesson (attempt/gotcha) — the on-ramp to a command",
      "sensor. A command sensor routes YOUR test as its oracle, but someone has to write it; this writes",
      "the skeleton so you only fill in the assertion.",
      "",
      "USE THIS right after mem_tried when the mistake is behavioural (a regex can't express it): it",
      "writes a stub carrying the incident's provenance and returns the exact `sensors propose --kind",
      "test` command to arm it.",
      "",
      "It DOES NOT arm a sensor — propose_sensor stays the sole validated writer, and the stub is left",
      "PENDING (todo/skip) so the suite stays green until you write the assertion. Monorepo-aware: the",
      "framework and location come from the package that owns the lesson's anchor paths.",
      "",
      "PARAMETERS:",
      "  memory_id — the attempt/gotcha to scaffold from",
      "  framework — vitest | jest | pytest | gotest (auto-detected when omitted)",
      "  out_path  — override the test file path (repo-relative)",
      "  write     — write the file (default true); false returns the content for preview",
      "",
      "RETURNS: { ok, path, run_command, propose_command, content, written, already_exists, notice }",
    ].join("\n"),
    ScaffoldTestInputSchema,
    async (input: ScaffoldTestInput) => {
      tracker.record("scaffold_test", input.memory_id);
      return jsonResult(await scaffoldTest(input, context));
    },
  );

  registerTool(
    "ingest_findings",
    [
      "Turn scanner findings (SonarQube / SARIF) into proposed, anchored memories with sensors.",
      "",
      "USE THIS to seed Hivelore from your existing quality tooling: each real defect a scanner",
      "found becomes a `gotcha`/`convention` memory anchored to the file, pre-filled with a",
      "conservative `warn` sensor — so the next agent is steered away from it before re-writing it.",
      "This closes the review↔memory loop and kills the cold-start problem.",
      "",
      "SAFETY: drafts are status=proposed and sensors are warn-only + autogen. This tool NEVER",
      "auto-validates and NEVER auto-blocks. A human reviews (mem_pending) and promotes the sensor.",
      "",
      "PARAMETERS:",
      "  format       — 'sarif' (ESLint/Semgrep/CodeQL) | 'sonar' (SonarQube issues JSON)",
      "  report_path  — project-relative path to the report file (OR pass `report` inline)",
      "  report       — inline JSON content (OR pass `report_path`)",
      "  type         — gotcha (default) | convention",
      "  scope        — team (default) | personal | module",
      "  min_severity — drop findings below this severity",
      "  dry_run      — preview what would be created without writing",
      "",
      "RETURNS: { format, parsed, new, skipped_existing, created[], notice }",
    ].join("\n"),
    IngestFindingsInputSchema,
    async (input: IngestFindingsInput) => {
      tracker.record("ingest_findings", `${input.format}:${input.report_path ?? "inline"}`);
      return jsonResult(await ingestFindings(input, context));
    },
  );


  registerTool(
    "mem_session_end",
    [
      "Save an end-of-session recap so the NEXT session starts with fresh context.",
      "",
      "CALL THIS before closing any significant working session. In autopilot mode,",
      "the MCP server saves a minimal recap automatically on exit — but calling this",
      "manually produces a richer, more useful recap.",
      "",
      "HOW IT WORKS: uses topic-upsert — one recap per scope is kept and updated",
      "in-place (revision_count increments). get_briefing surfaces the latest recap",
      "at the very top of the next session's briefing, before project context.",
      "",
      "PARAMETERS:",
      "  goal         — what you were trying to accomplish (1–2 sentences)",
      "  accomplished — what was actually done (bullet list recommended)",
      "  discoveries  — bugs, surprises, missing knowledge found during this session",
      "  files_touched — key files read or modified (used as anchor for staleness)",
      "  next_steps   — what should happen in the next session or for a teammate",
      "  scope        — personal (default) | team",
      "",
      "RETURNS: { id, scope, action: 'created'|'updated', revision_count }",
    ].join("\n"),
    MemSessionEndInputSchema,
    async (input: MemSessionEndInput) => {
      tracker.record("mem_session_end", input.goal.slice(0, 80));
      return jsonResult(await memSessionEnd(input, context));
    },
  );

  // ── Memory retrieval ───────────────────────────────────────────────────

  registerTool(
    "get_briefing",
    [
      "⭐ DEFAULT-FIRST for coding agents on any repo where `hivelore init` ran: call this BEFORE",
      "changing source or project config for the current goal (unless the developer explicitly opts out).",
      "One-shot onboarding: everything relevant in a single call under a token budget.",
      "",
      "PROGRESSIVE DISCLOSURE — after this, drill down only if needed:",
      "  mem_relevant_to / mem_search (compact lists) → mem_get (full body + anchors).",
      "",
      "RETURNS (in order of priority):",
      "  0. action_required — ⚠️ HANDLE THIS FIRST if non-empty (see protocol below)",
      "  1. last_session   — recap of the previous session (goal, what was done, next steps)",
      "  2. project_context — .ai/project-context.md (auto-generated from code-map if template)",
      "  3. module_contexts — relevant .ai/modules/<name>/context.md based on files being edited",
      "  4. memories        — ranked team memories relevant to your task",
      "  5. symbol_locations — file:line:kind for any requested symbols (no grep needed)",
      "  6. setup_warnings  — actionable warnings if setup is incomplete",
      "  7. decay_warnings  — memories not read in >90 days (consider reviewing)",
      "",
      "⚠️ ACTION_REQUIRED PROTOCOL — MANDATORY:",
      "  If action_required[] is non-empty, STOP and for each item:",
      "  1. Show the developer the exact developer_message field verbatim",
      "  2. Wait for explicit human confirmation ('yes', 'go ahead', 'oui', etc.)",
      "  3. Only then proceed with any code changes",
      "  NEVER act autonomously on cross-repo breaking changes, dep bumps, or contract diffs.",
      "",
      "KEY PARAMETERS:",
      "  task    — what you are about to do (1–2 sentences) — ALWAYS provide this",
      "  files   — files you are about to edit — surfaces anchored memories",
      "  symbols — symbol names to look up in the code-map (e.g. ['PaymentService'])",
      "  format  — 'full' (default) | 'compact' (1-line) | 'actions' (bullet-first excerpts)",
      "  budget_preset — 'quick' | 'balanced' | 'deep' — scales max_tokens/memories/module contexts",
      "",
      "EXAMPLE USAGE:",
      "  get_briefing({ task: 'add a Stripe payment integration', files: ['src/payments/'], symbols: ['PaymentService'] })",
      "",
      "CONFIDENCE LEVELS in memories:",
      "  authoritative — validated + read 10+ times (highest trust)",
      "  trusted       — validated or proposed + read 3+ times",
      "  low           — proposed, few reads (take with caution)",
      "  unverified    — draft (unverified: true flag set)",
      "",
      "Replaces 4–5 separate tool calls. Prefer this first; use mem_search / mem_get only for follow-up.",
    ].join("\n"),
    GetBriefingInputSchema,
    async (input: GetBriefingInput) => {
      tracker.record("get_briefing", input.task ?? "");
      return jsonResult(await getBriefing(input, context));
    },
  );

  registerTool(
    "mem_search",
    [
      "Search memories by keyword or semantic similarity.",
      "",
      "USE WHEN you need to find a specific memory and don't know its id.",
      "For session onboarding, use get_briefing instead (richer, ranked, budgeted).",
      "",
      "SEARCH MODES:",
      "  Literal (default): AND search across id, tags, and body — all tokens must match.",
      "  Falls back to OR automatically if no AND results (partial match).",
      "  Lexical rank (lexical_rank: true, semantic: false): Okapi-BM25-style scoring on the",
      "  filtered corpus — good for phrase-like queries without embeddings.",
      "  Semantic (semantic: true): embedding-based similarity — finds related memories",
      "  even with different wording. Requires hivelore embeddings index to be built.",
      "",
      "PARAMETERS:",
      "  query    — search terms or natural language question",
      "  scope    — filter by personal | team | module",
      "  type     — filter by convention | decision | gotcha | architecture | glossary",
      "  semantic — true for embedding-based search (requires @hivelore/embeddings)",
      "  lexical_rank — BM25-style ranking (ignored when semantic is true)",
      "  limit    — max results (default 10)",
      "",
      "RETURNS: array of { id, type, scope, status, confidence, body, match_quality }",
    ].join("\n"),
    MemSearchInputSchema,
    async (input: MemSearchInput) => {
      tracker.record("mem_search", input.query.slice(0, 80));
      return jsonResult(await memSearch(input, context));
    },
  );

  registerTool(
    "mem_timeline",
    [
      "Chronological view of related memories: by shared frontmatter.topic OR expanded from a seed id",
      "(related_ids, same topic, overlapping anchor paths — one extra hop on related_ids).",
      "",
      "PARAMETERS:",
      "  memory_id — optional seed memory id",
      "  topic     — optional topic key (required if memory_id omitted)",
      "  limit     — max entries (default 30)",
      "",
      "RETURNS: { entries: [{ id, type, scope, created_at, one_line, topic? }], total, notice? }",
    ].join("\n"),
    MemTimelineInputSchema,
    async (input: MemTimelineInput) => jsonResult(await memTimeline(input, context)),
  );

  registerTool(
    "mem_for_files",
    [
      "Surface memories relevant to the files you are currently editing.",
      "",
      "USE WHEN starting work on specific files and you want to know:",
      "  - What conventions apply to these files",
      "  - What gotchas are anchored to these paths",
      "  - What decisions were made about this module",
      "",
      "Matching strategy (in priority order):",
      "  1. Anchor overlap — memories whose paths overlap with your files",
      "  2. Module context — .ai/modules/<name>/context.md if module is inferred",
      "  3. Domain/tag match — memories whose tags include path segments",
      "",
      "PARAMETERS:",
      "  files — list of project-relative file paths you are editing",
      "  scope — filter by scope (default: all)",
      "",
      "RETURNS: { memories: [...], module_contexts: [...] }",
    ].join("\n"),
    MemForFilesInputSchema,
    async (input: MemForFilesInput) => jsonResult(await memForFiles(input, context)),
  );

  registerTool(
    "mem_get",
    [
      "Fetch a single memory by its full id with all details.",
      "",
      "USE WHEN get_briefing / mem_relevant_to / mem_search returned a compact hit and you need",
      "the full body, or when you know the exact id of a memory.",
      "",
      "PARAMETERS:",
      "  id — full memory id (e.g. '2026-04-28-gotcha-flyway-strict-no-ddl')",
      "",
      "RETURNS: { id, type, scope, status, confidence, body, anchor, tags, usage }",
    ].join("\n"),
    MemGetInputSchema,
    async (input: MemGetInput) => jsonResult(await memGet(input, context)),
  );

  registerTool(
    "mem_list",
    [
      "List memories with optional filters. Use for browsing, not for task onboarding.",
      "",
      "For task onboarding use get_briefing (ranked + budgeted).",
      "For keyword search use mem_search.",
      "",
      "PARAMETERS:",
      "  scope  — personal | team | module",
      "  type   — convention | decision | gotcha | architecture | glossary",
      "  status — draft | proposed | validated | stale | rejected",
      "  tags   — filter by tags (AND match)",
      "  module — filter by module name",
      "",
      "RETURNS: array of { id, type, scope, status, confidence, tags, created_at }",
    ].join("\n"),
    MemListInputSchema,
    async (input: MemListInput) => jsonResult(await memList(input, context)),
  );

  // ── Project context ────────────────────────────────────────────────────

  registerTool(
    "get_project_context",
    [
      "Read .ai/project-context.md (and optionally a module context) directly.",
      "",
      "USE WHEN you need the full project context without the memory ranking and",
      "token budgeting of get_briefing — e.g. for a reference architecture review.",
      "",
      "For normal task onboarding, use get_briefing instead (more efficient).",
      "",
      "PARAMETERS:",
      "  module — also load .ai/modules/<module>/context.md if provided",
      "",
      "RETURNS: { content: string, module_context?: string }",
    ].join("\n"),
    GetProjectContextInputSchema,
    async (input: GetProjectContextInput) =>
      jsonResult(await getProjectContext(input, context)),
  );

  registerTool(
    "bootstrap_project_save",
    [
      "Persist the project context document (.ai/project-context.md) or a module",
      "context (.ai/modules/<name>/context.md) analyzed by the AI.",
      "",
      "USE AFTER the bootstrap_project MCP prompt: the prompt tells you how to",
      "analyze the codebase; this tool saves the result.",
      "",
      "PARAMETERS:",
      "  content — full Markdown content of the context document",
      "  module  — if provided, saves as a module context (not root project context)",
      "",
      "RETURNS: { file_path, module? }",
    ].join("\n"),
    BootstrapProjectSaveInputSchema,
    async (input: BootstrapProjectSaveInput) =>
      jsonResult(await bootstrapProjectSave(input, context)),
  );

  registerTool(
    "code_map",
    [
      "Look up where symbols (classes, functions, interfaces) are defined in the codebase.",
      "",
      "USE INSTEAD OF grepping when you need to find where something lives.",
      "Requires hivelore index code to have been run (done automatically in autopilot mode).",
      "",
      "TIP: include symbols in get_briefing directly for auto-lookup at session start.",
      "",
      "PARAMETERS:",
      "  symbol   — name or partial name to search (e.g. 'PaymentService')",
      "  file     — filter by file path substring",
      "  max_files — cap on results (default 40)",
      "",
      "RETURNS: { available: bool, files: [{ path, exports: [{ name, kind, line, description }] }] }",
      "If available: false → run hivelore index code first.",
    ].join("\n"),
    CodeMapInputSchema,
    async (input: CodeMapInput) => jsonResult(await codeMapTool(input, context)),
  );

  registerTool(
    "mem_resolve_project",
    [
      "Diagnostics: resolve which project root Hivelore is using (never throws).",
      "",
      "USE IN multi-root workspaces or when the agent CWD may not be the repo root —",
      "mirrors HAIVE_PROJECT_ROOT, findProjectRoot markers, and presence of .ai/memories.",
      "",
      "PARAMETERS:",
      "  cwd — optional directory used for discovery when HAIVE_PROJECT_ROOT is unset",
      "",
      "RETURNS: { ok: true, info: { cwd, resolved_root, haive_project_root_env, … } }",
    ].join("\n"),
    MemResolveProjectInputSchema,
    async (input: MemResolveProjectInput) =>
      jsonResult(await memResolveProject(input, context)),
  );

  // ── Memory lifecycle ───────────────────────────────────────────────────

  registerTool(
    "mem_update",
    [
      "Update the body, tags, or anchor of an existing memory in-place.",
      "",
      "USE WHEN a memory exists but its content has become outdated or incomplete.",
      "This preserves the memory's id, usage history, and read_count.",
      "",
      "For evolving memories that you will update repeatedly, use mem_save with a",
      "topic key instead (topic-upsert pattern).",
      "",
      "PARAMETERS:",
      "  id      — full memory id to update",
      "  body    — new Markdown content (replaces existing body)",
      "  tags    — new tag list (replaces existing tags)",
      "  paths   — new anchor paths (replaces existing paths)",
      "  symbols — new anchor symbols (replaces existing symbols)",
      "",
      "RETURNS: { id, file_path, updated_fields: string[] }",
    ].join("\n"),
    MemUpdateInputSchema,
    async (input: MemUpdateInput) => jsonResult(await memUpdate(input, context)),
  );

  registerTool(
    "mem_verify",
    [
      "Check whether memory anchor paths and symbols still exist in the current code.",
      "",
      "USE WHEN you want to know if a specific memory is still valid after a refactor,",
      "or to check all memories for staleness (hivelore sync does this automatically).",
      "",
      "PARAMETERS:",
      "  id     — check a single memory (omit to check all)",
      "  update — write 'stale' or 'validated' status back to disk",
      "",
      "RETURNS: { results: [{ id, status: 'fresh'|'stale'|'anchorless', reason? }] }",
      "Stale means the anchored file/symbol no longer exists at that path.",
      "Anchorless means the memory has no paths/symbols — staleness is undetectable.",
    ].join("\n"),
    MemVerifyInputSchema,
    async (input: MemVerifyInput) => jsonResult(await memVerify(input, context)),
  );

  registerTool(
    "mem_approve",
    [
      "Mark a memory as validated (trusted, approved by a human or the team).",
      "",
      "In autopilot mode, memories are validated automatically — you rarely need this.",
      "In manual mode, call this after reviewing a proposed memory to activate it.",
      "",
      "PARAMETERS:",
      "  id — full memory id to approve",
      "",
      "RETURNS: { id, previous_status, new_status: 'validated' }",
    ].join("\n"),
    MemApproveInputSchema,
    async (input: MemApproveInput) => jsonResult(await memApprove(input, context)),
  );

  registerTool(
    "mem_reject",
    [
      "Mark a memory as rejected and record a reason.",
      "",
      "USE WHEN a memory is factually wrong, outdated, or not useful.",
      "Rejection blocks auto-promotion and lowers the memory's trust signal.",
      "Rejected memories are excluded from get_briefing by default.",
      "",
      "PARAMETERS:",
      "  id     — full memory id to reject",
      "  reason — why this memory is being rejected (stored in frontmatter)",
      "",
      "RETURNS: { id, previous_status, new_status: 'rejected' }",
    ].join("\n"),
    MemRejectInputSchema,
    async (input: MemRejectInput) => jsonResult(await memReject(input, context)),
  );

  registerTool(
    "mem_feedback",
    [
      "Record whether a memory actually HELPED — the closed-loop utility signal.",
      "",
      "USE right after a memory changed (or failed to change) what you did:",
      "  - outcome='applied'  → the memory steered your work (strong positive signal)",
      "  - outcome='rejected' → it was wrong/outdated/unhelpful (negative signal)",
      "",
      "A read only means a memory was surfaced; 'applied' means it demonstrably helped.",
      "This powers `hivelore memory impact` (impact tiers + prune candidates) and future ranking.",
      "",
      "PARAMETERS:",
      "  id      — full memory id the feedback is about",
      "  outcome — 'applied' | 'rejected'",
      "  reason  — why it was rejected (optional, stored on the usage record)",
      "",
      "RETURNS: { ok, id, outcome, usage:{read_count,applied_count,rejected_count}, impact:{score,tier,signals} }",
    ].join("\n"),
    MemFeedbackInputSchema,
    async (input: MemFeedbackInput) => jsonResult(await memFeedback(input, context)),
  );

  registerTool(
    "mem_pending",
    [
      "List memories in 'proposed' status awaiting review, sorted by read count.",
      "",
      "USE IN MANUAL MODE to see what memories are waiting for human review.",
      "In autopilot mode, proposed memories auto-approve after 72h.",
      "",
      "High read_count on a proposed memory = many agents found it useful without",
      "rejecting it = strong signal to approve.",
      "",
      "RETURNS: array of { id, type, scope, read_count, created_at, body_preview }",
    ].join("\n"),
    MemPendingInputSchema,
    async (input: MemPendingInput) => jsonResult(await memPending(input, context)),
  );

  registerTool(
    "mem_delete",
    [
      "Permanently delete a memory by id.",
      "",
      "USE WITH CAUTION — prefer mem_reject for outdated memories (preserves history).",
      "Use delete only for accidentally created memories or duplicates.",
      "",
      "PARAMETERS:",
      "  id            — full memory id to delete",
      "  delete_usage  — also delete usage stats (default: true)",
      "",
      "RETURNS: { deleted: true, id }",
    ].join("\n"),
    MemDeleteInputSchema,
    async (input: MemDeleteInput) => jsonResult(await memDelete(input, context)),
  );

  // ── v0.5.0: granular alternatives to get_briefing ─────────────────────
  // Use these when you don't need the full one-shot briefing payload.

  registerTool(
    "get_recap",
    [
      "Return ONLY the most recent session_recap. Cheaper than get_briefing when",
      "you just want to know 'what was I doing last time?' and don't need project",
      "context, modules, or memory ranking.",
      "",
      "PARAMETERS:",
      "  scope — 'personal' | 'team' | 'any' (default 'any', returns the most recent across both)",
      "",
      "RETURNS: { recap: { id, scope, revision_count, created_at, body } | null, notice? }",
    ].join("\n"),
    GetRecapInputSchema,
    async (input: GetRecapInput) => {
      tracker.record("get_recap", input.scope);
      return jsonResult(await getRecap(input, context));
    },
  );

  registerTool(
    "mem_relevant_to",
    [
      "One-shot ranked memories for a task — use instead of get_briefing when",
      "project context is already loaded and you only want the relevant memory layer.",
      "",
      "Second step in progressive disclosure (after get_briefing): narrow here, then mem_get for full text.",
      "",
      "Reuses the same ranking pipeline (anchor / module / literal / semantic) but",
      "skips project_context, modules, action_required, etc.",
      "",
      "PARAMETERS:",
      "  task    — 1–2 sentences describing what you are about to do (required)",
      "  files   — files you'll edit (surfaces anchored memories)",
      "  limit   — cap on returned memories (default 8)",
      "  min_semantic_score — drop weak semantic hits below this cosine (default 0.25)",
      "  format — 'full' | 'compact' | 'actions' (inherits get_briefing memory framing)",
      "",
      "RETURNS: { task, search_mode, memories: [...], hints?: [...], empty?: true }",
    ].join("\n"),
    MemRelevantToInputSchema,
    async (input: MemRelevantToInput) => {
      tracker.record("mem_relevant_to", input.task.slice(0, 80));
      return jsonResult(await memRelevantTo(input, context));
    },
  );

  // ── v0.5.0: code semantic search ──────────────────────────────────────

  registerTool(
    "code_search",
    [
      "Semantic search over the codebase — finds exported symbols (functions, classes,",
      "interfaces) related to a natural-language query. Replaces blind grep when you",
      "don't know the exact symbol name.",
      "",
      "Requires `hivelore index code-search` to have been run (builds embeddings for every",
      "exported symbol from the code-map). Falls back to a notice when index is missing.",
      "",
      "PARAMETERS:",
      "  query     — natural language (e.g. 'function that hashes passwords', 'JWT signing')",
      "  k         — number of top hits (default 5)",
      "  min_score — minimum cosine similarity (default 0.2; try 0.3+ for stricter)",
      "",
      "RETURNS: { available: bool, hits: [{ file, name, kind, line, description?, score }] }",
    ].join("\n"),
    CodeSearchInputSchema,
    async (input: CodeSearchInput) => {
      tracker.record("code_search", input.query.slice(0, 80));
      return jsonResult(await codeSearch(input, context));
    },
  );

  // ── v0.5.0: file-context lookup ───────────────────────────────────────


  // ── v0.5.0: anti-patterns check ───────────────────────────────────────

  registerTool(
    "anti_patterns_check",
    [
      "Scan a diff (or set of paths) against documented attempt/gotcha memories.",
      "[Diff-scan layer: the MEMORY-MATCH component. `pre_commit_check` combines this with sensors + stale checks; `hivelore enforce check` is the gate.]",
      "Surfaces 'you are about to repeat a known mistake' warnings BEFORE you commit.",
      "",
      "USE BEFORE finalizing a non-trivial change. Cheap and high-signal: the only",
      "memories scanned are 'attempt' and 'gotcha' types.",
      "",
      "PARAMETERS:",
      "  diff     — raw unified diff text (or any code snippet) — optional if `paths` provided",
      "  paths    — affected file paths (optional if `diff` provided)",
      "  limit    — cap on returned warnings (default 8)",
      "  semantic — also use semantic search (default true; requires embeddings index)",
      "",
      "RETURNS: { scanned, warnings: [{ id, type, scope, confidence, body_preview, reasons, semantic_score? }] }",
    ].join("\n"),
    AntiPatternsCheckInputSchema,
    async (input: AntiPatternsCheckInput) => {
      tracker.record("anti_patterns_check", input.paths.join(",").slice(0, 80));
      return jsonResult(await antiPatternsCheck(input, context));
    },
  );

  // ── v0.6.0 additions ───────────────────────────────────────────────────

  registerTool(
    "mem_distill",
    [
      "Cluster recurring observations / failed attempts so a human can collapse",
      "N similar memories into one richer convention/gotcha. Cheap heuristic",
      "(anchor path overlap + body keyword overlap) — no embeddings required.",
      "",
      "USE periodically (e.g. monthly) to prevent memory pollution from agents",
      "saving the same observation many times.",
      "",
      "PARAMETERS:",
      "  since_days   — only consider memories from the last N days (default 30)",
      "  min_cluster  — minimum cluster size to surface (default 3)",
      "  type_filter  — 'gotcha' | 'attempt' | 'all' (default 'gotcha')",
      "  scope        — 'personal' | 'team' | 'module' | 'any' (default 'any')",
      "",
      "RETURNS: { scanned, singletons, clusters: [{ suggested_topic, member_ids, ... }] }",
      "Output is advisory — nothing is written to disk.",
    ].join("\n"),
    MemDistillInputSchema,
    async (input: MemDistillInput) => {
      tracker.record("mem_distill", `${input.type_filter}/since=${input.since_days}d`);
      return jsonResult(await memDistill(input, context));
    },
  );



  registerTool(
    "mem_conflict_candidates",
    [
      "Bulk scan for conflict CANDIDATES (not proof):",
      "",
      "  1. Lexical similarity (Jaccard) on decision/architecture-like pairs",
      "  2. Same frontmatter.topic with validated vs rejected — quick human-review signal",
      "",
      "Advisory only — review the listed candidate ids, then resolve with mem_update/mem_delete.",
      "",
      "PARAMETERS:",
      "  since_days, types, min_jaccard, max_pairs, max_scan, max_topic_pairs",
      "",
      "RETURNS: { pairs, topic_status_pairs, scanned, truncated, notice? }",
    ].join("\n"),
    MemConflictCandidatesInputSchema,
    async (input: MemConflictCandidatesInput) => {
      tracker.record("mem_conflict_candidates", `${input.since_days}d`);
      return jsonResult(await memConflictCandidates(input, context));
    },
  );



  registerTool(
    "pre_commit_check",
    [
      "One-shot 'should I block this commit?' check. Combines three signals:",
      "",
      "  1. anti_patterns_check — known gotchas/attempts that match the diff",
      "  2. mem_for_files       — conventions/decisions anchored to touched files",
      "  3. mem_verify          — memories whose anchors are stale (knowledge may be wrong)",
      "",
      "This is the COMBINED diff-scan layer — sensors, anti-patterns and stale anchors in a single call.",
      "`hivelore enforce check` is the git-hook gate that runs the same combination at commit time.",
      "",
      "USE FROM A GIT HOOK or before finalizing a non-trivial change.",
      "",
      "PARAMETERS:",
      "  diff       — raw unified diff text (e.g. `git diff --cached`)",
      "  paths      — affected file paths (project-relative)",
      "  block_on   — 'any' | 'high-confidence' (default) | 'never'",
      "  semantic   — use embeddings in anti_patterns_check (default true)",
      "",
      "RETURNS: { should_block, summary, warnings, relevant_memories, stale_anchors }",
    ].join("\n"),
    PreCommitCheckInputSchema,
    async (input: PreCommitCheckInput) => {
      tracker.record("pre_commit_check", `${input.paths.length}p`);
      return jsonResult(await preCommitCheck(input, context));
    },
  );


  registerTool(
    "mem_diff",
    [
      "Compare two memories side-by-side to decide if they should be merged.",
      "",
      "USE BEFORE merging or deduplicating similar memories.",
      "Shows: frontmatter fields that differ + lines unique to each body.",
      "",
      "PARAMETERS:",
      "  id_a — first memory id",
      "  id_b — second memory id",
      "",
      "RETURNS: { frontmatter_diff: {...}, body_only_in_a: [...], body_only_in_b: [...] }",
    ].join("\n"),
    MemDiffInputSchema,
    async (input: MemDiffInput) => jsonResult(await memDiff(input, context)),
  );

  if (shouldRegisterPrompt("bootstrap_project")) {
    server.prompt(
      "bootstrap_project",
      [
        "Analyze the project codebase and write .ai/project-context.md — run once after hivelore init.",
        "The AI explores the directory structure, reads key files (package.json, README, config),",
        "identifies the tech stack, architectural patterns, key modules, and conventions,",
        "then persists everything via bootstrap_project_save.",
        "For multi-component projects, run with module param to create .ai/modules/<name>/context.md.",
      ].join(" "),
      BootstrapProjectArgsSchema,
      (args: BootstrapProjectArgs) => bootstrapProjectPrompt(args, context),
    );
  }

  if (shouldRegisterPrompt("bootstrap_repo")) {
    server.prompt(
      "bootstrap_repo",
      [
        "⭐ First-agent bootstrap — run once on a fresh repo to fill the knowledge layer the bootstrap",
        "gate requires: project-context, a module context per component, anchored memories, and a",
        "validated sensor per main code area. Tailors a concrete checklist from the current corpus state",
        "and walks the agent through bootstrap_project_save, mem_save, and propose_sensor until READY.",
      ].join(" "),
      BootstrapRepoArgsSchema,
      (args: BootstrapRepoArgs) => bootstrapRepoPrompt(args, context),
    );
  }

  if (shouldRegisterPrompt("post_task")) {
    server.prompt(
      "post_task",
      [
        "⭐ Post-task reflection — run at the end of every session to capture what you learned:",
        "failed approaches (mem_tried), new conventions/decisions/gotchas (mem_save),",
        "failed approaches (mem_tried), and an end-of-session recap (mem_session_end).",
        "In autopilot mode a minimal recap saves automatically; calling this produces a richer one.",
      ].join(" "),
      PostTaskArgsSchema,
      (args: PostTaskArgs) => postTaskPrompt(args, context),
    );
  }

  if (shouldRegisterPrompt("import_docs")) {
    server.prompt(
      "import_docs",
      [
        "Import knowledge from a document (README, ADR, wiki, API spec) as Hivelore memories.",
        "Pass the full document content; the AI extracts up to 10 actionable memories",
        "(conventions, decisions, gotchas, architecture) and saves them via mem_save.",
        "Good candidates: ADRs, onboarding docs, runbooks, team wikis.",
      ].join(" "),
      ImportDocsArgsSchema,
      (args: ImportDocsArgs) => importDocsPrompt(args, context),
    );
  }

  return { server, context, tracker };
}

// ── Stdio runtime (also invoked by `hivelore mcp --stdio` via bundled CLI) ─────

/** Parse argv for the standalone haive-mcp binary / CLI subprocess parity. */
export function parseMcpCliArgs(argv: string[]): {
  root?: string;
  versionOnly: boolean;
} {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-V") {
      return { versionOnly: true };
    }
  }
  const out: { root?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" || arg === "-r") {
      out.root = argv[++i];
    } else if (arg?.startsWith("--root=")) {
      out.root = arg.slice("--root=".length);
    }
  }
  return { root: out.root, versionOnly: false };
}

/** Print MCP server version (same as haive CLI when bundled together). */
export function printHaiveMcpVersion(): void {
  console.log(SERVER_VERSION);
}

/**
 * Run the MCP server over stdio. Used by `haive-mcp` and by `hivelore mcp --stdio`
 * when the MCP implementation is bundled into the CLI.
 */
export async function runHaiveMcpStdio(options: { root?: string }): Promise<void> {
  const { server, context } = createHaiveServer({ root: options.root, env: process.env });
  await writeMcpRuntimeMarker(context).catch(() => { /* diagnostics must never prevent MCP startup */ });
  console.error(
    `[hivelore-mcp] starting server v${SERVER_VERSION} (project root: ${context.paths.root})`,
  );
  await server.connect(new StdioServerTransport());
}

export async function writeMcpRuntimeMarker(context: HaiveContext): Promise<void> {
  await mkdir(context.paths.runtimeDir, { recursive: true });
  await writeFile(path.join(context.paths.runtimeDir, "mcp-server.json"), JSON.stringify({
    version: SERVER_VERSION,
    pid: process.pid,
    started_at: new Date().toISOString(),
    command: "hivelore mcp --stdio",
  }, null, 2), "utf8");
}
