import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  buildDashboard,
  findProjectRoot,
  loadConfig,
  loadMemoriesFromDir,
  loadPreventionEvents,
  loadUsageIndex,
  resolveHaivePaths,
  type DashboardReport,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface DashboardOptions {
  json?: boolean;
  top?: string;
  dormantDays?: string;
  dir?: string;
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description(
      "Non-interactive observability snapshot of the memory corpus.\n\n" +
      "  One-shot rollup an agent or CI can read — no TTY needed:\n" +
      "  inventory, impact tiers + top memories, sensors (and which ones fired),\n" +
      "  health (stale / anchorless / pending / prune candidates), decay, and corpus weight.\n" +
      "  Use --json to pipe it into other tooling.",
    )
    .option("--json", "emit the full report as JSON", false)
    .option("--top <n>", "rows per top-list", "10")
    .option("--dormant-days <n>", "dormancy window for impact scoring")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: DashboardOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.haiveDir)) {
        ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }

      const memories = existsSync(paths.memoriesDir) ? await loadMemoriesFromDir(paths.memoriesDir) : [];
      const usage = await loadUsageIndex(paths);
      const preventionEvents = await loadPreventionEvents(paths);
      const config = await loadConfig(paths);
      const top = Math.max(1, Number.parseInt(opts.top ?? "10", 10) || 10);
      const dormantDays = opts.dormantDays ? Number.parseInt(opts.dormantDays, 10) : undefined;
      const report = buildDashboard(memories, usage, {
        top,
        preventionEvents,
        antiPatternGate: config.enforcement?.antiPatternGate ?? "anchored",
        ...(dormantDays !== undefined && Number.isFinite(dormantDays) ? { dormantDays } : {}),
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      renderDashboard(report);
    });
}

function renderDashboard(r: DashboardReport): void {
  const { inventory: inv, impact, sensors, health, decay, corpus, prevention, gate_precision: gate } = r;

  console.log(ui.bold("Hivelore dashboard"));
  console.log(
    `  ${ui.dim("corpus:")} ${inv.total} policy memor${inv.total === 1 ? "y" : "ies"} ` +
    `(${inv.active} active, ${inv.retired} retired) · ${inv.session_recaps} recap(s) · ` +
    `~${corpus.est_tokens.toLocaleString()} tokens`,
  );
  console.log(`  ${ui.dim("scopes:")} ${formatCounts(inv.by_scope)}`);
  console.log(`  ${ui.dim("types: ")} ${formatCounts(inv.by_type)}`);

  // ── Value vs cost (the honest one-line answer to "is Hivelore earning its keep?") ──
  console.log();
  console.log(ui.bold("Value") + ui.dim("  (what Hivelore demonstrably earned — vs its per-task cost)"));
  const blocked = prevention.trend.last_30d;
  const demonstrated = impact.high;
  console.log(
    `  ${blocked > 0 ? ui.green(`${blocked} repeat${blocked === 1 ? "" : "s"} blocked (30d)`) : "0 repeats blocked (30d)"}` +
    ` · ${demonstrated} high-impact memor${demonstrated === 1 ? "y" : "ies"} (applied/prevented)` +
    ` · ${inv.active} active polic${inv.active === 1 ? "y" : "ies"} surfaceable`,
  );
  console.log(
    ui.dim(
      "  Cost is real: the briefing adds context to every task; the payoff is downstream (defects/incidents avoided), not the agent's token bill.",
    ),
  );

  // ── Prevention (outcome) ──
  console.log();
  console.log(ui.bold("Prevention") + ui.dim("  (caught-for-you outcome)"));
  console.log(
    `  ${prevention.trend.last_30d} catch${prevention.trend.last_30d === 1 ? "" : "es"} in 30d` +
    ` · ${prevention.recurrence.recurring_count} recurrence${prevention.recurrence.recurring_count === 1 ? "" : "s"} to review` +
    ` · ${prevention.trend.last_7d} in 7d`,
  );
  console.log(
    `  ${prevention.total_events > 0 ? ui.green(`${prevention.total_events} total catch event(s)`) : "0 total catch events"}` +
    ` · ${prevention.memories_with_catches} memor${prevention.memories_with_catches === 1 ? "y" : "ies"} with catches` +
    `  ${ui.dim("weekly")} [${prevention.trend.weekly.join(" ")}]`,
  );
  for (const p of prevention.top.slice(0, 5)) {
    console.log(
      `    ${ui.green("✓")} ${p.prevented_count}× ${p.id}` +
      (p.last_prevented_at ? ui.dim(`  last ${p.last_prevented_at.slice(0, 10)}`) : ""),
    );
  }
  if (prevention.recurrence.recurring_count > 0) {
    for (const r of prevention.recurrence.top.slice(0, 5)) {
      console.log(`    ${ui.yellow("↻")} ${r.distinct_days} days · ${r.catches}× ${r.id}`);
    }
  }

  // ── Gate precision (inferential signal quality) ──
  console.log();
  console.log(ui.bold("Gate precision") + ui.dim("  (is the anti-pattern gate real or noisy?)"));
  const precisionLabel =
    gate.precision === null
      ? ui.dim("no signal yet")
      : gate.precision >= 0.7
        ? ui.green(`${Math.round(gate.precision * 100)}%`)
        : ui.yellow(`${Math.round(gate.precision * 100)}%`);
  console.log(
    `  ${precisionLabel} precision · ${gate.useful} useful (sensor ${gate.sensor_catches} · anti-pattern ${gate.anti_pattern_catches}) · ` +
    `${gate.rejections > 0 ? ui.yellow(`${gate.rejections} rejected`) : "0 rejected"}`,
  );
  if (gate.suggestion) {
    ui.info(`Tuning: set enforcement.antiPatternGate="${gate.suggestion.recommended}" — ${gate.suggestion.reason}`);
  }

  // ── Impact ──
  console.log();
  console.log(ui.bold("Impact"));
  console.log(
    `  ${ui.green(`high ${impact.high}`)} · ${ui.yellow(`medium ${impact.medium}`)} · ` +
    `low ${impact.low} · ${ui.dim(`dormant ${impact.dormant}`)} · ` +
    `${impact.prune_candidates > 0 ? ui.red(`prune ${impact.prune_candidates}`) : "prune 0"}`,
  );
  if (impact.top.length > 0) {
    console.log(ui.dim("  top by demonstrated utility:"));
    for (const row of impact.top.filter((x) => x.score > 0).slice(0, 8)) {
      console.log(
        `    ${tierMark(row.tier)} ${row.score.toFixed(2)}  ${row.id}` +
        (row.signals.length ? ui.dim(`  [${row.signals.join(", ")}]`) : ""),
      );
    }
  }

  // ── Sensors ──
  console.log();
  console.log(ui.bold("Sensors"));
  console.log(
    `  ${sensors.total} total · ${sensors.block} block · ${sensors.warn} warn · ` +
    `${ui.dim(`${sensors.autogen} autogen`)} · ${sensors.fired > 0 ? ui.green(`${sensors.fired} fired`) : "0 fired"}`,
  );
  for (const s of sensors.recently_fired.slice(0, 5)) {
    const marker = s.severity === "block" ? ui.red("✗") : ui.yellow("⚠");
    console.log(`    ${marker} ${s.id} ${ui.dim(`last fired ${s.last_fired.slice(0, 10)}`)}`);
  }

  // ── Health ──
  console.log();
  console.log(ui.bold("Health"));
  console.log(
    `  stale ${warnNum(health.stale)} · anchorless ${warnNum(health.anchorless)} · ` +
    `pending ${health.pending} · prune candidates ${warnNum(health.prune_candidates)}`,
  );
  if (health.anchorless > 0) {
    ui.info("Anchorless validated decisions/gotchas can't detect drift — add `paths`/`symbols`.");
  }

  // ── Decay ──
  console.log();
  console.log(ui.bold(`Decay (>${decay.decay_days}d)`));
  console.log(`  ${decay.decaying} decaying memor${decay.decaying === 1 ? "y" : "ies"}`);
  for (const d of decay.top_dormant.slice(0, 5)) {
    const last = d.last_read_at ? d.last_read_at.slice(0, 10) : "never read";
    console.log(`    ${ui.dim(String(d.age_days).padStart(4) + "d")}  ${d.id}  ${ui.dim(`(${last})`)}`);
  }
  if (health.prune_candidates > 0 || decay.decaying > 0) {
    console.log();
    ui.info("Review low-value memories with `hivelore memory impact` and `hivelore memory lint`.");
  }
}

function formatCounts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "none";
  return entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

function tierMark(tier: string): string {
  if (tier === "high") return ui.green("●");
  if (tier === "medium") return ui.yellow("●");
  if (tier === "dormant") return ui.dim("○");
  return "·";
}

function warnNum(n: number): string {
  return n > 0 ? ui.yellow(String(n)) : String(n);
}
