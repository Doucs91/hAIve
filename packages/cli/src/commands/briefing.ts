import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  classifyMemoryPriority,
  compactAutoRecapBody,
  extractActionsBriefBody,
  findProjectRoot,
  inferModulesFromPaths,
  literalMatchesAllTokens,
  literalMatchesAnyToken,
  loadCodeMap,
  loadConfig,
  loadMemoriesFromDir,
  loadUsageIndex,
  memoryHasExcludedTag,
  memoryMatchesAnchorPaths,
  queryCodeMap,
  resolveBriefingBudget,
  resolveHaivePaths,
  tokenizeQuery,
  trackReads,
  writeBriefingMarker,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";
import { buildRadar, radarHasContent, type RadarReport } from "../utils/briefing-radar.js";
import { applyAutopilotRepairs } from "../utils/autopilot.js";

interface BriefingOptions {
  task?: string;
  files?: string;
  symbols?: string;
  maxMemories?: string;
  maxTokens?: string;
  explainSource?: boolean;
  scope?: string;
  includeDraft?: boolean;
  includeStale?: boolean;
  dir?: string;
  include?: string[];
  radar?: boolean;
  /** quick | balanced | deep — aligns with get_briefing budget_preset */
  budget?: string;
  /** full | actions — mimic get_briefing format for printed bodies */
  memoryFormat?: string;
  /** Back-compat alias for users who know the MCP get_briefing format option. */
  format?: string;
  /** Emit the ranked briefing as JSON (parity with the MCP get_briefing tool) instead of text. */
  json?: boolean;
}

const RADAR_AUTO_THRESHOLD = 3;

const CHARS_PER_TOKEN = 4;

function printRadar(
  radar: RadarReport,
  out: (text: string) => boolean,
  reason: "low-memory-signal" | "forced",
): void {
  if (!radar.insideGitRepo) return;
  if (!radarHasContent(radar)) return;
  const header = reason === "low-memory-signal"
    ? "=== Project Radar (few relevant memories — surfacing live signals) ==="
    : "=== Project Radar ===";
  out(`${ui.bold(header)}\n`);

  if (radar.recentCommits.length > 0) {
    out(ui.bold("Recent commits:"));
    for (const c of radar.recentCommits) {
      const filesBlurb = c.files.slice(0, 3).join(", ");
      const more = c.files.length > 3 ? ` (+${c.files.length - 3})` : "";
      out(`  ${ui.dim(c.date)} ${c.sha}  ${c.subject}`);
      if (filesBlurb) out(ui.dim(`    ${filesBlurb}${more}`));
    }
    out("");
  }
  if (radar.openTodos.length > 0) {
    out(ui.bold("Open TODOs/FIXMEs:"));
    for (const t of radar.openTodos) {
      out(`  ${ui.dim(t.file + ":" + t.line)}  ${t.text}`);
    }
    out("");
  }
  if (radar.hotFiles.length > 0) {
    out(ui.bold("Hot files (most modified recently):"));
    for (const f of radar.hotFiles) {
      out(`  ${f.changes}× ${ui.dim(f.path)}`);
    }
    out("");
  }
}

class TokenBudgetWriter {
  private used = 0;
  private truncated = false;
  constructor(private readonly budgetChars: number) {}
  write(text: string): boolean {
    if (this.truncated) return false;
    const next = this.used + text.length + 1;
    if (next > this.budgetChars) {
      console.log(ui.dim(`... [briefing truncated to fit --max-tokens budget · ${Math.round(this.used / CHARS_PER_TOKEN)} tokens used]`));
      this.truncated = true;
      return false;
    }
    console.log(text);
    this.used = next;
    return true;
  }
  isTruncated(): boolean { return this.truncated; }
  remainingChars(): number { return Math.max(0, this.budgetChars - this.used); }
}

export function registerBriefing(program: Command): void {
  program
    .command("briefing")
    .description(
      "Print the full project briefing: last session recap + project context + relevant memories.\n" +
      "  Equivalent to calling get_briefing via MCP. Run before starting any task.\n\n" +
      "  Examples:\n" +
      "    hivelore briefing\n" +
      "    hivelore briefing --task \"add Stripe payment\" --files src/payments/PaymentService.ts\n" +
      "    hivelore briefing --budget quick --task \"tiny fix\"\n",
    )
    .option("--task <text>", "what you are about to do — filters memories by relevance")
    .option("--files <csv>", "comma-separated file paths being worked on (surfaces anchored memories)")
    .option("--symbols <csv>", "symbol names to look up in the code-map (e.g. PaymentService,TenantFilter) — requires hivelore index code")
    .option("--max-memories <n>", "cap on memories surfaced", "8")
    .option("--max-tokens <n>", "approximate token budget for the entire briefing (truncates if exceeded)")
    .option("--explain-source", "annotate each memory with [source: <relative-path> · anchors: <files>] for traceable citations")
    .option("--radar", "force project radar (recent commits, open TODOs, hot files) even when memories are plentiful")
    .option("--no-radar", "disable the project radar even when memories are scarce")
    .option("--json", "emit the ranked briefing as JSON (memories + scores + priority), like the MCP get_briefing tool", false)
    .option(
      "--budget <preset>",
      "align with MCP get_briefing budget_preset: quick | balanced | deep — sets cap + truncation budget (overrides --max-memories / replaces default open-ended output)",
      undefined,
    )
    .option(
      "--memory-format <mode>",
      "printed memory bodies: full (default) | actions (cheap bullet-focused excerpt)",
      "full",
    )
    .option(
      "--format <mode>",
      "alias for --memory-format; accepts full | actions | compact",
    )
    .option(
      "--scope <scope>",
      "personal | team | shared | all (default: all — includes team + shared cross-repo memories)",
      "all",
    )
    .option("--include-draft", "include draft memories (excluded by default)")
    .option("--include-stale", "include stale memories (excluded by default — may be outdated)")
    .option(
      "--include <path>",
      "merge memories from another Hivelore-initialized project (repeatable). " +
      "Useful for teams with multiple coordinated repos (e.g. backend + frontend).",
      collectInclude,
      [] as string[],
    )
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: BriefingOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const requestedFormat = (opts.format ?? opts.memoryFormat ?? "full").toLowerCase();
      opts.memoryFormat = requestedFormat === "compact" ? "actions" : requestedFormat;
      const markerFiles = parseCsv(opts.files);
      if (existsSync(paths.haiveDir)) {
        await applyAutopilotRepairs(root, paths, {
          applyConfig: false,
          applyContext: true,
          applyCorpus: true,
          applyCodeMap: false,
          applyCodeSearch: true,
        }).catch(() => { /* briefing should still work if repair fails */ });
      }
      if (existsSync(paths.haiveDir)) {
        await mkdir(paths.runtimeDir, { recursive: true });
        await writeBriefingMarker(paths, {
          task: opts.task ?? "CLI briefing",
          source: "haive-briefing-cli",
          sessionId: process.env.HAIVE_SESSION_ID,
          files: markerFiles,
        }).catch(() => { /* marker is best-effort */ });
      }

      type BB = "quick" | "balanced" | "deep";
      let budgetPreset: BB | null = null;
      if (opts.budget) {
        const b = opts.budget.trim().toLowerCase();
        if (b === "quick" || b === "balanced" || b === "deep") budgetPreset = b;
        else ui.warn(`Unknown --budget '${opts.budget}' — ignoring (use quick|balanced|deep).`);
      }

      let maxMemories = Math.max(1, Number(opts.maxMemories ?? 8));
      let budgetTokensCap: number | null = opts.maxTokens ? Math.max(100, Number(opts.maxTokens)) : null;

      if (budgetPreset !== null) {
        const presetNums = resolveBriefingBudget(budgetPreset, {
          max_tokens: 8000,
          max_memories: 8,
          include_module_contexts: true,
        });
        budgetTokensCap = presetNums.max_tokens;
        maxMemories = presetNums.max_memories;
      }

      const json = opts.json === true;
      const writer = budgetTokensCap !== null ? new TokenBudgetWriter(budgetTokensCap * CHARS_PER_TOKEN) : null;
      const out = (text: string): boolean => {
        if (json) return true; // JSON mode: suppress all formatted text; structured payload emitted below
        if (writer) return writer.write(text);
        console.log(text);
        return true;
      };
      const stopped = (): boolean => writer?.isTruncated() ?? false;

      if (!existsSync(paths.memoriesDir)) {
        // No memories yet — print project context (if any) + radar fallback
        if (existsSync(paths.projectContext)) {
          out(`${ui.bold("=== Project Context ===")}\n`);
          out((await readFile(paths.projectContext, "utf8")).trim());
          out("");
        } else {
          ui.warn("No project-context.md found. Run `hivelore init` and the `bootstrap_project` MCP prompt to set it up.");
        }
        if (opts.radar !== false && !stopped()) {
          const filePathsEarly = parseCsv(opts.files);
          const tokensEarly = opts.task ? tokenizeQuery(opts.task) : null;
          const radar = await buildRadar({ root, taskTokens: tokensEarly, filePaths: filePathsEarly });
          printRadar(radar, out, "low-memory-signal");
        }
        return;
      }

      type LoadedWithOrigin = Awaited<ReturnType<typeof loadMemoriesFromDir>>[number] & { origin?: string };
      const ownMemories: LoadedWithOrigin[] = await loadMemoriesFromDir(paths.memoriesDir);

      // Make the gate's fix hint actually unblock — and independently of --budget / ranking.
      // The decision-coverage gate checks that the validated policy memories
      // (decision/gotcha/architecture/convention) anchored to the changed files are present in the
      // marker's memory_ids. The displayed ("surfaced") set is budget-limited and can omit some of
      // them, so we compute the FULL anchored-policy set here with the SAME match function the gate
      // uses and UNION it into the final marker write below. Then `hivelore briefing --files <changed>`
      // (the command the gate suggests) satisfies the gate regardless of --budget.
      const POLICY_TYPES = new Set(["decision", "gotcha", "architecture", "convention"]);
      const anchoredPolicyIds =
        markerFiles.length > 0
          ? ownMemories
              .map((m) => m.memory)
              .filter(
                (mem) =>
                  POLICY_TYPES.has(mem.frontmatter.type) &&
                  mem.frontmatter.status === "validated" &&
                  memoryMatchesAnchorPaths(mem, markerFiles),
              )
              .map((mem) => mem.frontmatter.id)
          : [];

      // Multi-project aggregation: merge memories from --include <path> projects.
      const externalRoots: string[] = [];
      if (opts.include && opts.include.length > 0) {
        for (const includePath of opts.include) {
          try {
            const otherRoot = findProjectRoot(includePath);
            if (otherRoot === root) continue; // skip self
            const otherPaths = resolveHaivePaths(otherRoot);
            if (!existsSync(otherPaths.memoriesDir)) {
              ui.warn(`--include ${includePath}: no .ai/memories at ${otherRoot} — skipping`);
              continue;
            }
            const otherMemories = await loadMemoriesFromDir(otherPaths.memoriesDir);
            const tag = path.basename(otherRoot);
            for (const m of otherMemories) {
              ownMemories.push({ ...m, origin: tag });
            }
            externalRoots.push(`${tag} (${otherMemories.length})`);
          } catch (err) {
            ui.warn(`--include ${includePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (externalRoots.length > 0) {
          ui.info(`merged from: ${externalRoots.join(", ")}`);
          console.log();
        }
      }

      const all = ownMemories;
      const filePaths = markerFiles;
      const tokens = opts.task ? tokenizeQuery(opts.task) : null;
      const scopeFilter = opts.scope ?? "all";

      // ── 1. Session recap — always shown first so agents start with fresh context ──
      const recaps = all
        .filter(({ memory: mem }) => mem.frontmatter.type === "session_recap")
        .sort((a, b) =>
          new Date(b.memory.frontmatter.created_at).getTime() -
          new Date(a.memory.frontmatter.created_at).getTime(),
        );
      if (recaps.length > 0 && !stopped()) {
        const recap = recaps[0]!;
        const fm = recap.memory.frontmatter;
        const rev = fm.revision_count ? ` · revision #${fm.revision_count}` : "";
        out(`${ui.bold("=== Last Session Recap ===")}\n`);
        out(ui.dim(`${fm.id} (${fm.scope}${rev})`));
        // Auto-generated recaps are low-signal tool dumps — compact them so they don't dominate.
        out(compactAutoRecapBody(recap.memory.body).trim());
        out("");
      }

      // ── 2. Project context ─────────────────────────────────────────────────────
      if (existsSync(paths.projectContext) && !stopped()) {
        const ctx = await readFile(paths.projectContext, "utf8");
        const isTemplate = ctx.includes("TODO — high-level overview") || ctx.includes("Generated by `hivelore init`");
        // Adaptive: an init-bootstrapped context that is still mostly "TODO —" scaffolding is
        // inferable noise — don't dump it. Mirrors the MCP get_briefing adaptive trim.
        const bootstrapUnfilled =
          /Auto-generated by `hivelore init/i.test(ctx) && (ctx.match(/TODO —/g)?.length ?? 0) >= 2;
        if (isTemplate || bootstrapUnfilled) {
          // In --json mode, stdout MUST stay pure JSON — route the advisory to stderr instead.
          const msg =
            "project-context.md is still auto-generated/unfilled — skipping it (low value). " +
            "Fill it in, or invoke the bootstrap_project MCP prompt for real context.";
          if (json) console.error(msg); else ui.warn(msg);
          out("");
        } else {
          out(`${ui.bold("=== Project Context ===")}\n`);
          out(ctx.trim());
          out("");
        }
      } else if (!existsSync(paths.projectContext)) {
        ui.warn(
          "No project-context.md found. Run `hivelore init` then invoke the bootstrap_project MCP prompt.",
        );
      }

      // Strategy/positioning memories are excluded from automatic surfacing (still searchable via
      // `memory search`) — mirrors the MCP get_briefing filter so both façades behave identically.
      const briefingConfig = await loadConfig(paths);
      const excludeTags = briefingConfig.briefingExcludeTags;

      // Filter: exclude noise, drafts, stale, and session_recap (shown above) by default
      const candidates = all.filter(({ memory: mem }) => {
        const fm = mem.frontmatter;
        if (fm.status === "rejected" || fm.status === "deprecated") return false;
        if (!opts.includeDraft && fm.status === "draft") return false;
        if (!opts.includeStale && fm.status === "stale") return false;
        if (scopeFilter !== "all" && fm.scope !== scopeFilter && !(scopeFilter === "team" && fm.scope === "shared")) return false;
        if (fm.type === "session_recap") return false; // shown separately above
        if (memoryHasExcludedTag(fm, excludeTags)) return false;
        return true;
      });

      // Score by relevance (AND on task tokens; OR fallback if AND produces no task hits)
      const andTaskHits = tokens
        ? new Set(candidates.filter(({ memory: mem }) => literalMatchesAllTokens(mem, tokens)).map(({ memory: mem }) => mem.frontmatter.id))
        : null;
      const useOrFallback = andTaskHits !== null && andTaskHits.size === 0 && (tokens?.length ?? 0) > 1;

      const scored = candidates.map(({ memory: mem, filePath }) => {
        const fm = mem.frontmatter;
        let score = 0;
        if (fm.status === "validated") score += 3;
        else if (fm.status === "proposed") score += 1;
        if (filePaths.length > 0 && memoryMatchesAnchorPaths(mem, filePaths)) score += 4;
        if (tokens) {
          if (andTaskHits?.has(fm.id)) score += 3;
          else if (useOrFallback && literalMatchesAnyToken(mem, tokens)) score += 1;
        }
        return { memory: mem, filePath, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, maxMemories);

      if (top.length === 0) {
        if (json) { console.log(JSON.stringify({ task: opts.task ?? null, memories: [], briefing_quality: "thin" }, null, 2)); return; }
        ui.info("No relevant memories found.");
        const draftCount = all.filter(
          (m) =>
            m.memory.frontmatter.status === "draft" &&
            (scopeFilter === "all" || m.memory.frontmatter.scope === scopeFilter),
        ).length;
        if (draftCount > 0) {
          ui.info(`(${draftCount} draft memories excluded — use --include-draft to show)`);
        }
        if (opts.radar !== false && !stopped()) {
          const radar = await buildRadar({ root, taskTokens: tokens, filePaths });
          out("");
          printRadar(radar, out, "low-memory-signal");
        }
        return;
      }

      if (stopped()) return;
      const usageIndex = await loadUsageIndex(paths).catch(() => null);
      out(`${ui.bold("=== Relevant Memories ===")}\n`);
      const priorities = top.map((item) =>
        classifyCliPriority(
          item,
          filePaths,
          tokens,
          Boolean(andTaskHits?.has(item.memory.frontmatter.id)),
          Boolean(useOrFallback && tokens && literalMatchesAnyToken(item.memory, tokens)),
        ),
      );
      const mustReadCount = priorities.filter((p) => p === "must_read").length;
      const usefulCount = priorities.filter((p) => p === "useful").length;
      const backgroundCount = priorities.filter((p) => p === "background").length;
      // Mirrors classifyBriefingQuality (briefing-helpers.ts): a must_read hit is actionable,
      // so "noisy" only applies to useful-only briefings dominated by background seeds.
      const quality = mustReadCount > 0 || usefulCount > 0
        ? mustReadCount === 0 && backgroundCount > usefulCount && backgroundCount > 2 ? "noisy" : "strong"
        : "thin";

      // Module inference — parity with MCP get_briefing (the CLI JSON used to omit it entirely,
      // so module contexts like "always filter by tenantId" never reached CLI-driven flows).
      const inferredModules = inferModulesFromPaths(filePaths);
      const moduleContexts: Array<{ name: string; content: string }> = [];
      for (const m of inferredModules) {
        const ctxFile = path.join(paths.modulesContextDir, m, "context.md");
        if (existsSync(ctxFile)) {
          moduleContexts.push({ name: m, content: (await readFile(ctxFile, "utf8")).trim() });
        }
      }

      // JSON mode: emit the structured ranked briefing (parity with the MCP get_briefing tool) and stop.
      if (json) {
        console.log(JSON.stringify({
          task: opts.task ?? null,
          files: filePaths,
          briefing_quality: quality,
          inferred_modules: inferredModules,
          module_contexts: moduleContexts,
          counts: { must_read: mustReadCount, useful: usefulCount, background: backgroundCount },
          recap_id: recaps[0]?.memory.frontmatter.id ?? null,
          memories: top.map((item, i) => ({
            id: item.memory.frontmatter.id,
            scope: item.memory.frontmatter.scope,
            type: item.memory.frontmatter.type,
            status: item.memory.frontmatter.status,
            priority: priorities[i],
            score: item.score,
            file: path.relative(root, item.filePath),
            summary: (item.memory.body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0) ?? "").slice(0, 140),
          })),
        }, null, 2));
        return;
      }
      out(ui.dim(`briefing_quality: ${quality} · must_read=${mustReadCount} useful=${usefulCount} background=${backgroundCount}`));
      out("");
      for (const mc of moduleContexts) {
        if (stopped()) break;
        out(ui.bold(`=== Module context: ${mc.name} ===`));
        out(mc.content);
        out("");
      }
      printCliBreadcrumbs({
        top,
        priorities,
        task: opts.task,
        files: filePaths,
        symbols: parseCsv(opts.symbols),
        out,
        stopped,
      });
      for (const [idx, item] of top.entries()) {
        if (stopped()) break;
        const fm = item.memory.frontmatter;
        const badge = ui.statusBadge(fm.status);
        const draftMarker = fm.status === "draft" ? ui.yellow(" [DRAFT]") : "";
        const unverifiedMarker = fm.status === "proposed" ? ui.yellow(" [UNVERIFIED]") : "";
        const lifecycleMarker =
          fm.lifecycle === "planned"
            ? ui.yellow(" [PLANNED — not yet implemented]")
            : fm.lifecycle === "abandoned"
              ? ui.yellow(" [ABANDONED]")
              : "";
        const originMarker = (item as LoadedWithOrigin).origin
          ? ` ${ui.yellow("[from " + (item as LoadedWithOrigin).origin + "]")}`
          : "";
        const reads = usageIndex?.by_id[fm.id]?.read_count ?? 0;
        const hitMarker = reads > 0 ? ` ${ui.dim("· " + reads + "× read")}` : "";
        const priority = priorities[idx] ?? "background";
        out(
          `${ui.bold(fm.id)}  ${priorityBadge(priority)}  ${ui.dim(fm.scope + "/" + fm.type)}  ${badge}${draftMarker}${unverifiedMarker}${lifecycleMarker}${originMarker}${hitMarker}`,
        );
        if (opts.explainSource) {
          const relPath = path.relative(root, item.filePath);
          const anchorPaths = fm.anchor?.paths ?? [];
          const anchorSymbols = fm.anchor?.symbols ?? [];
          const parts: string[] = [`source: ${relPath}`];
          if (anchorPaths.length > 0) parts.push(`paths: ${anchorPaths.join(", ")}`);
          if (anchorSymbols.length > 0) parts.push(`symbols: ${anchorSymbols.join(", ")}`);
          out(ui.dim(`  [${parts.join(" · ")}]`));
        }
        const memBody =
          opts.memoryFormat?.toLowerCase() === "actions"
            ? extractActionsBriefBody(item.memory.body)
            : item.memory.body.trim();
        out(memBody);
        out("");
      }
      if (!stopped()) out(ui.dim(`${top.length} memor${top.length === 1 ? "y" : "ies"} surfaced`));

      // Track reads so usage stats, decay, and hot-memory detection work via CLI too
      const ids = top.map(({ memory: mem }) => mem.frontmatter.id);
      if (ids.length > 0) {
        await trackReads(paths, ids).catch(() => { /* non-fatal */ });
      }
      // Union the surfaced ids with the anchored-policy ids so the marker always covers what the
      // decision-coverage gate checks, even when --budget trimmed the surfaced set.
      const markerIds = [...new Set([...ids, ...anchoredPolicyIds])];
      if (markerIds.length > 0) {
        await writeBriefingMarker(paths, {
          task: opts.task ?? "CLI briefing",
          source: "haive-briefing-cli",
          sessionId: process.env.HAIVE_SESSION_ID,
          memoryIds: markerIds,
          files: filePaths,
        }).catch(() => { /* marker is best-effort */ });
      }

      // ── Project radar — surface git/TODO/hot-file signals when memories are scarce ──
      const radarForced = opts.radar === true;
      const radarAuto = opts.radar !== false && top.length < RADAR_AUTO_THRESHOLD;
      if ((radarForced || radarAuto) && !stopped()) {
        const radar = await buildRadar({ root, taskTokens: tokens, filePaths });
        if (radarHasContent(radar)) {
          out("");
          printRadar(radar, out, radarForced ? "forced" : "low-memory-signal");
        }
      }

      // ── Code-map symbol lookup ──────────────────────────────────────────
      const requestedSymbols = (opts.symbols ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (requestedSymbols.length > 0 && !stopped()) {
        const codeMap = await loadCodeMap(paths);
        if (!codeMap) {
          ui.warn("No code-map found. Run `hivelore index code` first to enable symbol lookup.");
        } else {
          out(`\n${ui.bold("=== Symbol Locations ===")}\n`);
          for (const sym of requestedSymbols) {
            if (stopped()) break;
            const { files } = queryCodeMap(codeMap, { symbol: sym });
            if (files.length === 0) {
              out(`${ui.dim(sym)}  (not found in code-map)`);
            } else {
              for (const f of files) {
                if (stopped()) break;
                const exports = f.entry.exports.filter((e) =>
                  e.name.toLowerCase().includes(sym.toLowerCase()),
                );
                for (const e of exports) {
                  if (stopped()) break;
                  const desc = e.description ? `  — ${e.description}` : "";
                  out(`${ui.bold(e.name)}  ${ui.dim(f.path + ":" + e.line)}  [${e.kind}]${desc}`);
                }
              }
            }
          }
          out("");
        }
      }
    });
}

type CliMemoryPriority = "must_read" | "useful" | "background";

/**
 * Map the CLI briefing's lexical evidence into the SHARED core classifier, so `hivelore briefing` and
 * the MCP `get_briefing` can never disagree on priority (the drift that bit us twice). The CLI has no
 * embeddings, so `strongSemantic` is false and `usefulSemantic` is derived from the lexical score.
 */
function classifyCliPriority(
  item: { memory: Awaited<ReturnType<typeof loadMemoriesFromDir>>[number]["memory"]; score: number },
  filePaths: string[],
  tokens: string[] | null,
  exactTaskHit: boolean,
  partialTaskHit: boolean,
): CliMemoryPriority {
  const fm = item.memory.frontmatter;
  const anchored = filePaths.length > 0 && memoryMatchesAnchorPaths(item.memory, filePaths);
  return classifyMemoryPriority({
    type: fm.type,
    tags: fm.tags,
    requiresHumanApproval: Boolean(fm.requires_human_approval),
    directAnchor: anchored,
    directSymbol: false, // symbol lookup is rendered separately in the CLI, not via anchor priority
    exactTaskMatch: exactTaskHit,
    strongSemantic: false,
    usefulSemantic: partialTaskHit || item.score >= 4,
    moduleOrDomainMatch: false,
    tagTaskMatch: Boolean(tokens && fm.tags.some((tag) => tokens.includes(tag))),
  });
}

function priorityBadge(priority: CliMemoryPriority): string {
  if (priority === "must_read") return ui.red("[must_read]");
  if (priority === "useful") return ui.yellow("[useful]");
  return ui.dim("[background]");
}

function printCliBreadcrumbs(input: {
  top: Array<{ memory: Awaited<ReturnType<typeof loadMemoriesFromDir>>[number]["memory"]; filePath: string; score: number }>;
  priorities: CliMemoryPriority[];
  task?: string;
  files: string[];
  symbols: string[];
  out: (text: string) => boolean;
  stopped: () => boolean;
}): void {
  if (input.stopped()) return;
  // A terse pointer map only — the full body for each memory is printed right below, so re-summarizing
  // it here would just duplicate the payload. Keep breadcrumbs small ("map, not manual").
  const startHere = input.top.slice(0, 4).map((item, idx) => {
    const fm = item.memory.frontmatter;
    const priority = input.priorities[idx] ?? "background";
    const anchor = fm.anchor.paths[0] ? ` · applies to ${fm.anchor.paths[0]}` : "";
    return `  - ${priority}: ${fm.id} (${fm.scope}/${fm.type})${anchor}`;
  });

  const drillDown: string[] = [];
  for (const item of input.top.slice(0, 3)) {
    drillDown.push(`  - mem_get("${item.memory.frontmatter.id}")`);
  }
  if (input.task && input.files.length > 0) {
    drillDown.push(
      `  - mem_relevant_to(task:"${cliOneLine(input.task)}", files:[${input.files.map((f) => `"${f}"`).join(", ")}], format:"actions")`,
    );
  }
  if (input.task) drillDown.push(`  - code_search(query:"${cliOneLine(input.task)}", k:5)`);
  for (const symbol of input.symbols.slice(0, 3)) {
    drillDown.push(`  - code_map(symbol:"${cliOneLine(symbol)}")`);
  }

  if (startHere.length === 0 && drillDown.length === 0) return;

  input.out(`${ui.bold("=== Breadcrumbs ===")}\n`);
  if (startHere.length > 0) {
    input.out(ui.bold("Start here:"));
    for (const line of startHere) {
      if (input.stopped()) return;
      input.out(line);
    }
    input.out("");
  }
  const uniqueDrillDown = [...new Set(drillDown)].slice(0, 6);
  if (uniqueDrillDown.length > 0) {
    input.out(ui.bold("Drill down only if needed:"));
    for (const line of uniqueDrillDown) {
      if (input.stopped()) return;
      input.out(line);
    }
    input.out("");
  }
}

function cliOneLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/"/g, '\\"').trim().slice(0, 120);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function collectInclude(value: string, previous: string[]): string[] {
  return [...previous, value];
}
