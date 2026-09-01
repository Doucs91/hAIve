/**
 * hivelore session end — save a structured end-of-session recap.
 *
 * Uses topic-upsert: one recap per scope is kept and updated in-place.
 * get_briefing automatically surfaces the latest recap at the next session start.
 */
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Command, Option } from "commander";
import {
  distillFailureObservations,
  buildFrontmatter,
  findProjectRoot,
  loadConfig,
  loadMemoriesFromDir,
  loadPreventionEvents,
  readUsageEvents,
  loadUsageIndex,
  buildRecapWithHistory,
  memoryFilePath,
  renderCaughtForYou,
  resolveHaivePaths,
  serializeMemory,
  summarizeCaughtForYou,
  writeSessionHandoff,
  type MemoryFrontmatter,
  type MemoryScope,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface SessionEndOptions {
  goal?: string;
  accomplished?: string;
  discoveries?: string;
  files?: string;
  next?: string;
  scope?: MemoryScope;
  module?: string;
  dir?: string;
  auto?: boolean;
  quiet?: boolean;
}

interface Observation {
  ts: string;
  session_id?: string;
  cwd?: string;
  tool: string;
  summary: string;
  files?: string[];
  failure_hint?: true;
}

async function buildAutoRecap(
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<{ goal: string; accomplished: string; discoveries?: string; files: string[]; rawCount: number } | null> {
  const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
  if (!existsSync(obsFile)) return await buildGitAutoRecap(paths);
  const raw = await readFile(obsFile, "utf8").catch(() => "");
  if (!raw.trim()) return await buildGitAutoRecap(paths);
  const lines = raw.split("\n").filter(Boolean);
  const obs: Observation[] = [];
  for (const line of lines) {
    try { obs.push(JSON.parse(line) as Observation); } catch { /* skip */ }
  }
  if (obs.length === 0) return await buildGitAutoRecap(paths);

  // ── Aggregate tool usage ────────────────────────────────────────────────
  const toolCounts = new Map<string, number>();
  const writeFiles = new Set<string>(); // files that were written/edited
  const readFiles = new Set<string>();  // files that were only read
  for (const o of obs) {
    toolCounts.set(o.tool, (toolCounts.get(o.tool) ?? 0) + 1);
    const isWrite = ["Edit", "Write", "NotebookEdit"].includes(o.tool);
    for (const f of o.files ?? []) {
      const rel = normalizeAnchorPath(paths.root, f);
      if (isWrite) writeFiles.add(rel);
      else readFiles.add(rel);
    }
  }
  // Files in both sets — the write set is authoritative
  for (const f of writeFiles) readFiles.delete(f);

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t} ×${c}`)
    .join(", ");

  // ── Build accomplished section ─────────────────────────────────────────
  // Prefer git log context (richer than raw tool call list)
  const recentCommits = await runGit(paths.root, ["log", "--oneline", "-5"]).catch(() => "");
  const accomplishedParts: string[] = [];

  if (writeFiles.size > 0) {
    accomplishedParts.push(
      `**Files modified (${writeFiles.size}):**`,
      ...[...writeFiles].slice(0, 10).map((f) => `- \`${f}\``),
      ...(writeFiles.size > 10 ? [`- ...and ${writeFiles.size - 10} more`] : []),
    );
  }

  if (recentCommits.trim()) {
    accomplishedParts.push("", "**Recent commits:**");
    for (const line of recentCommits.trim().split("\n").slice(0, 5)) {
      accomplishedParts.push(`- ${line}`);
    }
  }

  if (accomplishedParts.length === 0) {
    accomplishedParts.push(`${obs.length} tool calls (${topTools}) — no file writes detected.`);
  }

  // ── Discoveries: failures + notable observations ───────────────────────
  const failures = obs.filter((o) => o.failure_hint);
  const discoveriesParts: string[] = [];
  if (failures.length > 0) {
    discoveriesParts.push(
      `⚠️ ${failures.length} failure${failures.length === 1 ? "" : "s"} detected — call \`mem_tried\` for each unresolved one:`,
      ...failures.slice(0, 8).map((o) => `- ${o.summary.slice(0, 180)}`),
    );
  }

  const goal = writeFiles.size > 0
    ? `Edited ${writeFiles.size} file${writeFiles.size === 1 ? "" : "s"} across ${obs.length} tool calls`
    : `Session with ${obs.length} tool calls (${topTools}) — read-only or no writes captured`;

  return {
    goal,
    accomplished: accomplishedParts.join("\n"),
    ...(discoveriesParts.length > 0 ? { discoveries: discoveriesParts.join("\n") } : {}),
    files: [...writeFiles].slice(0, 12),
    rawCount: obs.length,
  };
}

async function buildGitAutoRecap(
  paths: ReturnType<typeof resolveHaivePaths>,
): Promise<{ goal: string; accomplished: string; discoveries?: string; files: string[]; rawCount: number } | null> {
  const changed = await runGit(paths.root, ["diff", "--name-only"]).catch(() => "");
  const staged = await runGit(paths.root, ["diff", "--cached", "--name-only"]).catch(() => "");
  const statusRaw = await runGit(paths.root, ["status", "--porcelain"]).catch(() => "");
  const recentLog = await runGit(paths.root, ["log", "--oneline", "-5"]).catch(() => "");
  const diffStat = await runGit(paths.root, ["diff", "--stat", "HEAD"]).catch(() => "");

  const files = Array.from(new Set(
    [
      ...changed.split("\n"),
      ...staged.split("\n"),
      ...statusRaw.split("\n").map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, "")),
    ]
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((file) => !file.startsWith(".ai/.runtime/") && !file.startsWith(".ai/.cache/")),
  )).sort();

  // Parse porcelain status to get modified/added/deleted categories
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of statusRaw.split("\n")) {
    const code = line.substring(0, 2).trim();
    const file = line.substring(3).trim().replace(/".+"/g, (m) => m.slice(1, -1));
    if (!file || file.startsWith(".ai/.runtime/") || file.startsWith(".ai/.cache/")) continue;
    if (code === "D" || code === "DD") deleted.push(file);
    else if (code === "A" || code === "??") added.push(file);
    else if (file) modified.push(file);
  }

  const accomplishedParts: string[] = [];
  if (modified.length > 0) {
    accomplishedParts.push(`**Modified (${modified.length}):**`);
    for (const f of modified.slice(0, 8)) accomplishedParts.push(`- \`${f}\``);
    if (modified.length > 8) accomplishedParts.push(`- ...and ${modified.length - 8} more`);
  }
  if (added.length > 0) {
    accomplishedParts.push(`\n**Added (${added.length}):**`);
    for (const f of added.slice(0, 5)) accomplishedParts.push(`- \`${f}\``);
    if (added.length > 5) accomplishedParts.push(`- ...and ${added.length - 5} more`);
  }
  if (deleted.length > 0) {
    accomplishedParts.push(`\n**Deleted (${deleted.length}):**`);
    for (const f of deleted.slice(0, 5)) accomplishedParts.push(`- \`${f}\``);
  }

  if (recentLog.trim()) {
    accomplishedParts.push("\n**Recent commits:**");
    for (const line of recentLog.trim().split("\n").slice(0, 5)) {
      accomplishedParts.push(`- ${line}`);
    }
  }

  if (accomplishedParts.length === 0 && files.length === 0) return null;

  if (accomplishedParts.length === 0) {
    accomplishedParts.push(...files.slice(0, 12).map((f) => `- \`${f}\``));
    if (files.length > 12) accomplishedParts.push(`- ...and ${files.length - 12} more`);
  }

  return {
    goal: files.length > 0
      ? `Session with ${files.length} changed file${files.length === 1 ? "" : "s"}`
      : `Session with recent commits (no uncommitted changes)`,
    accomplished: accomplishedParts.join("\n"),
    discoveries: diffStat.trim() ? `Git diff stat:\n\`\`\`\n${diffStat.trim()}\n\`\`\`` : undefined,
    files: files.slice(0, 12),
    rawCount: files.length,
  };
}

function buildRecapBody(opts: {
  goal: string;
  accomplished: string;
  discoveries?: string;
  files?: string;
  next?: string;
}): string {
  const lines: string[] = [];
  lines.push(`## Goal\n${opts.goal}`);
  lines.push(`\n## Accomplished\n${opts.accomplished}`);
  if (opts.discoveries?.trim()) {
    lines.push(`\n## Discoveries & surprises\n${opts.discoveries}`);
  }
  const filesTouched = parseCsv(opts.files);
  if (filesTouched.length > 0) {
    lines.push(`\n## Files touched\n${filesTouched.map((f) => `- \`${f}\``).join("\n")}`);
  }
  if (opts.next?.trim()) {
    lines.push(`\n## Next steps\n${opts.next}`);
  }
  return lines.join("\n");
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function readObservationList(paths: ReturnType<typeof resolveHaivePaths>): Promise<Observation[]> {
  const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
  if (!existsSync(obsFile)) return [];
  const raw = await readFile(obsFile, "utf8").catch(() => "");
  const out: Observation[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Observation); } catch { /* skip corrupt rows */ }
  }
  return out;
}

/**
 * Passive capture, last leg (excellence plan Phase 2): distill the session's failure observations
 * into PROPOSED lesson drafts so the corpus candidate exists without agent discipline — the
 * claude-mem pipeline shape, ending in reviewable team-truth candidates instead of private notes.
 *
 * Boundaries: deterministic templating only (no LLM), born `proposed` + tagged `auto-captured`
 * (autopilot's time-based auto-approve skips that tag — a machine-observed draft needs a human or
 * an explicit approve), never a sensor, capped per session, deduped against existing attempts.
 */
async function autoCaptureFailureLessons(
  paths: ReturnType<typeof resolveHaivePaths>,
  root: string,
  observations: Observation[],
): Promise<{ written: number; ids: string[] }> {
  const failures = observations
    .filter((o) => o.failure_hint)
    .map((o) => ({
      ts: o.ts,
      tool: o.tool,
      summary: o.summary,
      files: (o.files ?? []).map((f) => normalizeAnchorPath(root, f)).filter((f) => existsSync(path.resolve(root, f))),
    }));
  if (failures.length === 0) return { written: 0, ids: [] };
  const lessons = distillFailureObservations(failures, { max: 3 });
  if (lessons.length === 0) return { written: 0, ids: [] };

  const existing = existsSync(paths.memoriesDir) ? await loadMemoriesFromDir(paths.memoriesDir) : [];
  const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  const existingTitles = new Set(
    existing
      .filter(({ memory }) => memory.frontmatter.type === "attempt")
      .map(({ memory }) => normalizeTitle(memory.body.match(/^#\s+(.+)$/m)?.[1] ?? "")),
  );

  let written = 0;
  const ids: string[] = [];
  for (const lesson of lessons) {
    if (existingTitles.has(normalizeTitle(lesson.what))) continue;
    const slug = lesson.what
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join("-") || "auto-captured-failure";
    const baseFm = buildFrontmatter({
      type: "attempt",
      slug,
      scope: "personal",
      tags: ["auto-captured"],
      paths: lesson.paths,
    });
    const frontmatter = { ...baseFm, status: "proposed" as const };
    const file = memoryFilePath(paths, frontmatter.scope, frontmatter.id, frontmatter.module);
    if (existsSync(file)) continue;
    const body =
      `# ${lesson.what}\n\n` +
      `**Why it failed / do NOT use:** ${lesson.why_failed}\n\n` +
      `_Auto-captured from session observations (${lesson.occurrences} occurrence${lesson.occurrences === 1 ? "" : "s"}). ` +
      `Review: refine and approve (\`hivelore memory approve ${frontmatter.id}\`), or reject it._\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serializeMemory({ frontmatter, body }), "utf8").catch(() => { /* best-effort */ });
    existingTitles.add(normalizeTitle(lesson.what));
    written++;
    ids.push(frontmatter.id);
  }
  return { written, ids };
}

async function observationStart(paths: ReturnType<typeof resolveHaivePaths>): Promise<string | null> {
  const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
  if (!existsSync(obsFile)) return null;
  const raw = await readFile(obsFile, "utf8").catch(() => "");
  let first: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obs = JSON.parse(line) as Partial<Observation>;
      if (typeof obs.ts !== "string") continue;
      if (!first || obs.ts < first) first = obs.ts;
    } catch {
      // ignore corrupt observation rows
    }
  }
  return first;
}

/** Best available boundary for a manually closed session: its latest briefing/start marker. */
export async function manualSessionStart(paths: ReturnType<typeof resolveHaivePaths>): Promise<string | null> {
  const events = await readUsageEvents(paths);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (["get_briefing", "briefing", "session_start", "enforce_session_start"].includes(event.tool)) return event.at;
  }
  return null;
}

async function printCaughtForYou(
  paths: ReturnType<typeof resolveHaivePaths>,
  since: string | null,
  quiet: boolean | undefined,
): Promise<void> {
  if (quiet) return;
  const memories = existsSync(paths.memoriesDir) ? await loadMemoriesFromDir(paths.memoriesDir) : [];
  const usage = await loadUsageIndex(paths);
  const events = await loadPreventionEvents(paths);
  const summary = summarizeCaughtForYou(events, memories, usage, {
    ...(since ? { since } : {}),
    now: new Date(),
    limit: 5,
  });
  const block = renderCaughtForYou(summary);
  if (block) {
    console.log();
    console.log(ui.bold(block));
  }
}

function recapTopic(scope: string, module?: string): string {
  return module ? `session-recap-${scope}-${module}` : `session-recap-${scope}`;
}

export function registerSessionEnd(session: Command): void {
  session
    .command("end")
    .description(
      "Save an end-of-session recap so the NEXT session starts with fresh context.\n\n" +
      "  One recap per scope is kept and updated in-place (topic-upsert). The next\n" +
      "  session's get_briefing (or hivelore briefing) shows it at the very top.\n\n" +
      "  In autopilot mode, a minimal recap saves automatically on MCP server exit.\n" +
      "  Calling this manually produces a richer, more actionable recap.\n\n" +
      "  Example:\n" +
      "    hivelore session end \\\\\n" +
      "      --goal \"Add Stripe webhook handler\" \\\\\n" +
      "      --accomplished \"Implemented webhook endpoint, added idempotency key\" \\\\\n" +
      "      --discoveries \"Missing .env.example entry for STRIPE_WEBHOOK_SECRET\" \\\\\n" +
      "      --files src/payments/WebhookController.ts,src/payments/WebhookService.ts \\\\\n" +
      "      --next \"Add integration tests for webhook signature validation\"\n",
    )
    .option("--goal <text>", "what you were trying to accomplish (1–2 sentences)")
    .option("--accomplished <text>", "what was actually done (bullet list recommended)")
    // Hidden synonym: agents guess `--summary` for a one-blob recap; map it to --accomplished
    // instead of dead-ending them. Kept out of help so the structured flags stay the documented API.
    .addOption(new Option("--summary <text>", "alias for --accomplished").hideHelp())
    .option("--discoveries <text>", "bugs, surprises, or inconsistencies found during this session")
    .option("--files <csv>", "key files touched, comma-separated (used as anchor for staleness detection)")
    .option("--next <text>", "what should happen next (for the next session or a teammate)")
    .option("--scope <scope>", "personal | team | module (default: personal)", "personal")
    .option("--module <name>", "module name (required when scope=module)")
    .option("--auto", "synthesize the recap from .ai/.cache/observations.jsonl (used by Claude Code SessionEnd hook)")
    .option("--quiet", "suppress non-error output (for hook use)")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: SessionEndOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);

      if (!existsSync(paths.haiveDir)) {
        if (opts.auto || opts.quiet) return; // hook context — silently no-op
        ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }

      // Auto mode: derive goal/accomplished/files from captured observations
      let resolvedFiles = opts.files;
      let goal = opts.goal;
      let accomplished = opts.accomplished ?? (opts as { summary?: string }).summary;
      const caughtSince = opts.auto ? await observationStart(paths) : await manualSessionStart(paths);
      if (opts.auto) {
        // Passive capture: distill this session's failures into proposed drafts BEFORE the recap,
        // so the recap (and the finish gate's nag) can point at concrete candidates instead of
        // asking the agent to re-type what the harness already observed.
        const autoCaptured = await autoCaptureFailureLessons(paths, root, await readObservationList(paths))
          .catch(() => ({ written: 0, ids: [] as string[] }));
        const synth = await buildAutoRecap(paths);
        if (!synth) return; // nothing observed — silently no-op
        goal = goal ?? synth.goal;
        accomplished = accomplished ?? synth.accomplished;
        opts.discoveries = opts.discoveries ?? synth.discoveries;
        if (autoCaptured.written > 0) {
          const note =
            `${autoCaptured.written} failure(s) auto-captured as proposed lesson(s): ${autoCaptured.ids.join(", ")} — ` +
            "review with `hivelore memory list --status proposed` (approve, refine, or reject).";
          opts.discoveries = opts.discoveries ? `${opts.discoveries}\n${note}` : note;
          if (!opts.quiet) ui.info(note);
        }
        if (!resolvedFiles && synth.files.length) resolvedFiles = synth.files.join(",");
      }

      if (!goal || !accomplished) {
        if (opts.quiet) return;
        ui.error("session-end requires --goal and --accomplished (or pass --auto with captured observations).");
        process.exitCode = 1;
        return;
      }

      const scope = opts.scope ?? "personal";
      const body = buildRecapBody({
        goal,
        accomplished,
        discoveries: opts.discoveries,
        files: resolvedFiles,
        next: opts.next,
      });
      const topic = recapTopic(scope, opts.module);
      // Normalize to project-relative paths before storing as anchors
      const filesTouched = parseCsv(resolvedFiles).map((p) => normalizeAnchorPath(root, p));

      // Warn about paths that don't exist in project
      const missingPaths = filesTouched.filter((p) => !existsSync(path.resolve(root, p)));
      if (missingPaths.length > 0 && !opts.quiet) {
        ui.warn(`Anchor path${missingPaths.length > 1 ? "s" : ""} not found in project (will be stale):`);
        for (const p of missingPaths) ui.warn(`  ✗ ${p}`);
      }

      const cleanupObservations = async (): Promise<void> => {
        if (!opts.auto) return;
        const obsFile = path.join(paths.haiveDir, ".cache", "observations.jsonl");
        if (existsSync(obsFile)) await rm(obsFile).catch(() => { /* non-fatal */ });
      };

      // ── Auto mode honoring config ───────────────────────────────────
      // When autoSessionRecap=false, an automatic (hook-driven) session end does NOT persist a
      // recap memory into the corpus; it writes an ephemeral NEXT.md handoff instead (if enabled).
      // A manual `hivelore session end --goal ...` is unaffected (explicit recaps are always honored).
      const config = await loadConfig(paths);
      if (opts.auto && config.autoSessionRecap === false) {
        if (config.sessionHandoff) {
          const diffStat = await runGit(root, ["diff", "--stat", "HEAD"]).catch(() => "");
          const openThreads = (opts.discoveries ?? "")
            .split("\n")
            .map((s) => s.replace(/^[-*]\s*/, "").trim())
            .filter(Boolean);
          await writeSessionHandoff(root, {
            goal,
            openThreads,
            filesTouched,
            ...(opts.next?.trim() ? { nextSteps: opts.next.trim() } : {}),
            ...(diffStat.trim() ? { diffStat: diffStat.trim() } : {}),
          });
        }
        await cleanupObservations();
        if (!opts.quiet) {
          ui.info(
            config.sessionHandoff
              ? "Auto recap disabled (autoSessionRecap=false) — wrote ephemeral NEXT.md handoff."
              : "Auto recap disabled (autoSessionRecap=false) — no recap memory written.",
          );
        }
        return;
      }

      // ── Topic upsert ────────────────────────────────────────────────
      if (existsSync(paths.memoriesDir)) {
        const existing = await loadMemoriesFromDir(paths.memoriesDir);
        const topicMatch = existing.find(({ memory }) =>
          memory.frontmatter.topic === topic &&
          memory.frontmatter.scope === scope &&
          (!opts.module || memory.frontmatter.module === opts.module),
        );

        if (topicMatch) {
          const fm = topicMatch.memory.frontmatter;
          const revisionCount = (fm.revision_count ?? 0) + 1;
          const newFrontmatter: MemoryFrontmatter = {
            ...fm,
            verified_at: new Date().toISOString(),
            revision_count: revisionCount,
            anchor: {
              ...fm.anchor,
              paths: filesTouched.length ? filesTouched : fm.anchor.paths,
            },
          };
          // Archive the outgoing recap into a bounded per-session history instead of overwriting (§5.6).
          const combinedBody = buildRecapWithHistory(body, topicMatch.memory.body, fm.verified_at ?? fm.created_at);
          await writeFile(topicMatch.filePath, serializeMemory({ frontmatter: newFrontmatter, body: combinedBody }), "utf8");
          await cleanupObservations();
          if (!opts.quiet) {
            ui.success(`Session recap updated (revision #${revisionCount})`);
            ui.info(`id=${fm.id}  file=${path.relative(root, topicMatch.filePath)}`);
            await printCaughtForYou(paths, caughtSince, opts.quiet);
            ui.info("Tip: `hivelore stats --export-report` generates a usage JSON suitable for dashboards.");
          }
          return;
        }
      }

      // ── Create first recap ──────────────────────────────────────────
  const frontmatter = buildFrontmatter({
    type: "session_recap",
    slug: "recap",
    scope,
    module: opts.module,
    tags: ["session", "recap"],
    paths: filesTouched,
    topic,
    status: "validated",
  });

      const file = memoryFilePath(paths, frontmatter.scope, frontmatter.id, frontmatter.module);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, serializeMemory({ frontmatter, body }), "utf8");
      await cleanupObservations();

      if (!opts.quiet) {
        ui.success(`Session recap created`);
        ui.info(`id=${frontmatter.id}  scope=${scope}  file=${path.relative(root, file)}`);
        await printCaughtForYou(paths, caughtSince, opts.quiet);
        ui.info("Next session: call `get_briefing` — the recap will be surfaced automatically.");
        ui.info("Tip: export a local MCP usage rollup with `hivelore stats --export-report .ai/tool-usage-roi-report.json`.");
      }
    });
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Convert an absolute or home-relative path to a project-relative path.
 * If the path is already relative, it is returned as-is.
 * Absolute paths outside the project root are kept as-is (external resources).
 */
export function normalizeAnchorPath(root: string, filePath: string): string {
  if (!filePath) return filePath;
  // Already relative
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(root, filePath);
  // If the relative path goes outside the root (../../..), keep as-is
  if (rel.startsWith("..")) return filePath;
  return rel;
}
