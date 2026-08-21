import { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  aggregateUsage,
  assessBehaviourCoverage,
  buildPreventionReceipt,
  loadCodeMap,
  renderBehaviourCoverageLine,
  renderPreventionReceipt,
  renderPreventionComment,
  type PreventionCommentFinding,
  findProjectRoot,
  loadMemoriesFromDir,
  loadUsageIndex,
  loadPreventionEvents,
  parseSince,
  readUsageEvents,
  renderPreventionReceiptShare,
  resolveHaivePaths,
  usageLogSize,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface StatsOptions {
  since?: string;
  json?: boolean;
  memoryHits?: boolean;
  exportReport?: string;
  dir?: string;
}

export function registerStats(program: Command): void {
  const stats = program
    .command("stats")
    .description("Show MCP tool-usage stats and prevention receipts.");

  const receiptCmd = stats
    .command("receipt")
    .description("Show documented mistakes refused by the gate over a time window")
    .option("--share", "emit a Markdown block ready to paste into Slack or a PR (with attribution)", false)
    .option(
      "--comment",
      "emit the full PR-comment body (marker + what fired on this PR + receipt) — used by the CI workflow",
      false,
    )
    .option("--gate <file>", "path to a `hivelore enforce ci --json` report, to list what fired on this PR")
    .addHelpText("after", "\nParent options also apply: --since <window> (default 7d here), --json, --dir <dir>.")
    .action(async () => {
      const opts = stats.opts<{ since?: string; json?: boolean; dir?: string }>();
      const sub = receiptCmd.opts<{ share?: boolean; comment?: boolean; gate?: string }>();
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const sinceRaw = stats.getOptionValueSource("since") === "default" ? "7d" : (opts.since ?? "7d");
      const since = parseSince(sinceRaw) ?? new Date(Date.now() - 7 * 86_400_000);
      const [events, usage, memories] = await Promise.all([
        loadPreventionEvents(paths),
        loadUsageIndex(paths),
        existsSync(paths.memoriesDir) ? loadMemoriesFromDir(paths.memoriesDir) : Promise.resolve([]),
      ]);
      const receipt = buildPreventionReceipt(events, memories, usage, { since });
      // A missing or unreadable gate report is not an error: the receipt still stands on its own,
      // and CI must never fail because the comment body could not name this PR's findings.
      const gateFindings = sub.gate
        ? await readFile(sub.gate, "utf8")
            .then((raw) => (JSON.parse(raw) as { findings?: PreventionCommentFinding[] }).findings ?? [])
            .catch(() => [])
        : [];
      const output = sub.comment
        ? renderPreventionComment(receipt, gateFindings)
        : sub.share
          ? renderPreventionReceiptShare(receipt)
          : opts.json
            ? JSON.stringify(receipt, null, 2)
            : renderPreventionReceipt(receipt);
      console.log(output);
      // Behaviour-harness standing — a "where we are" footer for the human receipt (not the JSON /
      // share formats, which are structured/attribution surfaces). Best-effort: never break the receipt.
      if (!opts.json && !sub.share && !sub.comment) {
        try {
          const codeMap = await loadCodeMap(paths);
          if (codeMap) {
            const cov = assessBehaviourCoverage({ memories, codeFiles: Object.keys(codeMap.files) });
            if (cov.mainAreas.length > 0) {
              console.log(`\nBehaviour harness: ${renderBehaviourCoverageLine(cov)}.`);
            }
          }
        } catch { /* best-effort footer */ }
      }
    });

  stats
    .option("--since <window>", "ISO date or relative (e.g. '7d', '24h', '30m')", "30d")
    .option("--json", "emit JSON instead of human-readable output", false)
    .option("--memory-hits", "show top-read memories (which mems are actually being used)", false)
    .option(
      "--export-report <path>",
      "write a JSON rollup (tools + briefing counts + heuristic ROI hints). Parent dirs are created if needed.",
      undefined,
    )
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: StatsOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);

      if (opts.exportReport) {
        await writeRoiReport(paths, root, opts.since ?? "30d", opts.exportReport);
        return;
      }

      if (opts.memoryHits) {
        await renderMemoryHits(paths, opts);
        return;
      }

      const size = await usageLogSize(paths);
      if (!size.exists) {
        if (opts.json) {
          console.log(JSON.stringify({ error: "no_usage_log" }));
          return;
        }
        ui.warn(
          `No usage log found at ${root}. ` +
          `Stats are populated as the MCP server logs each tool call. ` +
          `Run a session first, then re-check.`,
        );
        return;
      }

      const events = await readUsageEvents(paths);
      const since = parseSince(opts.since);
      const aggregate = aggregateUsage(events, since ?? undefined);

      if (opts.json) {
        console.log(JSON.stringify(aggregate, null, 2));
        return;
      }

      const window = opts.since ?? "all time";
      console.log(ui.bold(`Hivelore usage stats (${window})`));
      console.log(
        `  ${ui.dim("total calls:")} ${aggregate.total}  ` +
        `${ui.dim("unique tools:")} ${aggregate.by_tool.length}  ` +
        `${ui.dim("log lines:")} ${size.lines}`,
      );
      if (aggregate.window_start) {
        console.log(
          `  ${ui.dim("window:")} ${aggregate.window_start.slice(0, 19)} → ${aggregate.window_end?.slice(0, 19)}`,
        );
      }
      if (aggregate.by_tool.length === 0) {
        ui.info(`No events in window. Try a wider --since (current: ${window}).`);
        return;
      }
      console.log();
      console.log(ui.bold("Top tools:"));
      const maxCount = aggregate.by_tool[0]?.count ?? 1;
      for (const t of aggregate.by_tool.slice(0, 20)) {
        const bar = "█".repeat(Math.max(1, Math.round((t.count / maxCount) * 30)));
        const pct = ((t.count / aggregate.total) * 100).toFixed(1);
        console.log(
          `  ${t.tool.padEnd(28)} ${ui.green(bar)} ${ui.bold(String(t.count))} ` +
          `${ui.dim(`(${pct}%, last ${t.last_used.slice(0, 19)})`)}`,
        );
      }
    }  );
}

async function writeRoiReport(
  paths: ReturnType<typeof resolveHaivePaths>,
  root: string,
  sinceRaw: string,
  outRelative: string,
): Promise<void> {
  const outAbs = path.isAbsolute(outRelative)
    ? path.resolve(outRelative)
    : path.resolve(root, outRelative);

  const size = await usageLogSize(paths);
  let events = await readUsageEvents(paths);

  let memoryCount = { team: 0, personal: 0, total_skipped_session: 0 };
  if (existsSync(paths.memoriesDir)) {
    const mems = await loadMemoriesFromDir(paths.memoriesDir);
    for (const { memory } of mems) {
      const fm = memory.frontmatter;
      if (fm.type === "session_recap") memoryCount.total_skipped_session++;
      else if (fm.scope === "team") memoryCount.team++;
      else if (fm.scope === "personal") memoryCount.personal++;
    }
  }

  const sinceDt = parseSince(sinceRaw) ?? undefined;
  const aggregate = aggregateUsage(events, sinceDt);
  const inWindow = (at: string): boolean =>
    sinceDt === undefined || Date.parse(at) >= sinceDt.getTime();

  const briefingCalls = events.filter((e) => inWindow(e.at) && e.tool === "get_briefing").length;

  let memoryHitsLeader: { id: string; read_count: number } | null = null;
  try {
    const usageIdx = await loadUsageIndex(paths);
    const tops = Object.entries(usageIdx.by_id)
      .map(([id, v]) => ({ id, read_count: v.read_count }))
      .filter((x) => x.read_count > 0)
      .sort((a, b) => b.read_count - a.read_count);
    memoryHitsLeader = tops[0] ?? null;
  } catch {
    memoryHitsLeader = null;
  }

  const roiHints = [
    "Prefer get_briefing(format:'actions') or budget_preset:'quick' for low-risk edits to reduce token pressure.",
    "Run `hivelore memory lint` in CI to keep the corpus actionable.",
    "Install the haive VS Code extension (packages/vscode) for always-on memory surfacing beside the editor.",
  ];

  if (!size.exists || events.length === 0) {
    ui.warn("Usage log missing or empty — report still written with partial data.");
    events = [];
  }

  await mkdir(path.dirname(outAbs), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    project_root: root,
    window_since: sinceRaw,
    usage_log_meta: size,
    memory_inventory: memoryCount,
    aggregate,
    get_briefing_calls_in_window: briefingCalls,
    top_memory_reads: memoryHitsLeader,
    roi_hints: roiHints,
  };

  await writeFile(outAbs, JSON.stringify(payload, null, 2), "utf8");
  ui.success(`Wrote ROI / usage rollup → ${outAbs}`);
}

async function renderMemoryHits(
  paths: ReturnType<typeof resolveHaivePaths>,
  opts: StatsOptions,
): Promise<void> {
  const index = await loadUsageIndex(paths);
  const since = parseSince(opts.since ?? "30d");
  const sinceMs = since ? new Date(since).getTime() : null;
  const entries = Object.entries(index.by_id)
    .map(([id, usage]) => ({ id, ...usage }))
    .filter((e) => e.read_count > 0)
    .filter((e) => {
      if (!sinceMs || !e.last_read_at) return !sinceMs;
      return new Date(e.last_read_at).getTime() >= sinceMs;
    })
    .sort((a, b) => b.read_count - a.read_count);

  if (opts.json) {
    console.log(JSON.stringify({
      window: opts.since ?? "30d",
      total_mems_with_hits: entries.length,
      top: entries.slice(0, 50),
    }, null, 2));
    return;
  }

  const window = opts.since ?? "30d";
  console.log(ui.bold(`Memory hits (${window})`));
  if (entries.length === 0) {
    ui.info(
      `No memory reads recorded in window. Reads are logged when ` +
      `\`hivelore briefing\` or \`hivelore memory search\` surface a memory.`,
    );
    return;
  }
  console.log(
    `  ${ui.dim("memories with hits:")} ${entries.length}  ` +
    `${ui.dim("total reads:")} ${entries.reduce((a, e) => a + e.read_count, 0)}`,
  );
  console.log();
  console.log(ui.bold("Top read memories:"));
  const maxCount = entries[0]!.read_count;
  for (const e of entries.slice(0, 25)) {
    const bar = "█".repeat(Math.max(1, Math.round((e.read_count / maxCount) * 20)));
    const lastRead = e.last_read_at?.slice(0, 10) ?? "?";
    console.log(
      `  ${ui.bold(String(e.read_count).padStart(4))}  ${ui.green(bar.padEnd(20))}  ` +
      `${e.id}  ${ui.dim(`last: ${lastRead}`)}`,
    );
  }
  const dead = Object.keys(index.by_id).length - entries.length;
  if (dead > 0) {
    console.log();
    ui.info(`${dead} memor${dead === 1 ? "y" : "ies"} never read in window — candidates for cleanup (run \`hivelore doctor\`).`);
  }
}
