/**
 * hivelore memory digest — generate a Markdown report of memories added/updated
 * within the last N days for bulk review.
 *
 * Usage:
 *   hivelore memory digest              # last 7 days, team scope
 *   hivelore memory digest --days 14    # last 14 days
 *   hivelore memory digest --scope all  # all scopes
 *   hivelore memory digest --out digest.md  # write to file instead of stdout
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  deriveConfidence,
  findProjectRoot,
  getUsage,
  loadMemoriesFromDir,
  loadUsageIndex,
  resolveHaivePaths,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface DigestOptions {
  days?: string;
  scope?: string;
  out?: string;
  dir?: string;
}

const CONFIDENCE_EMOJI: Record<string, string> = {
  unverified: "⬜",
  low: "🟡",
  trusted: "🟢",
  authoritative: "⭐",
  stale: "🔴",
};

export function registerMemoryDigest(program: Command): void {
  program
    .command("digest")
    .description(
      "Generate a Markdown review digest of recently added or updated memories.\n\n" +
      "  Groups memories by type, shows confidence, status, read count, and anchor info.\n" +
      "  Each memory has action checkboxes (approve / reject / keep as-is) for peer review.\n\n" +
      "  Use this to do a bulk weekly review of team memories, or share with teammates\n" +
      "  as a pull-request attachment so humans can validate what the AI captured.\n\n" +
      "  Examples:\n" +
      "    hivelore memory digest                         # last 7 days, team scope\n" +
      "    hivelore memory digest --days 30 --scope all   # last 30 days, all scopes\n" +
      "    hivelore memory digest --out review.md         # write to file\n",
    )
    .option("--days <n>", "look-back window in days (default: 7)", "7")
    .option("--scope <scope>", "personal | team | module | all (default: team)", "team")
    .option("--out <file>", "write digest to a file instead of stdout")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: DigestOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);

      if (!existsSync(paths.memoriesDir)) {
        ui.error("No .ai/memories found. Run `hivelore init` first.");
        process.exitCode = 1;
        return;
      }

      const days = Math.max(1, Number(opts.days ?? 7));
      const scopeFilter = opts.scope ?? "team";
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const all = await loadMemoriesFromDir(paths.memoriesDir);
      const usage = await loadUsageIndex(paths);

      const recent = all.filter(({ memory: mem }) => {
        const fm = mem.frontmatter;
        if (fm.type === "session_recap") return false;
        if (fm.status === "rejected" || fm.status === "deprecated") return false;
        if (scopeFilter !== "all" && fm.scope !== scopeFilter) return false;
        return new Date(fm.created_at) >= cutoff;
      });

      const now = new Date().toISOString().slice(0, 10);
      const lines: string[] = [
        `# Hivelore Memory Digest — ${now}`,
        ``,
        `> **Period:** last ${days} day${days > 1 ? "s" : ""}  |  **Scope:** ${scopeFilter}  |  **Total:** ${recent.length} memor${recent.length === 1 ? "y" : "ies"}`,
        ``,
        `---`,
        ``,
      ];

      if (recent.length === 0) {
        lines.push(`_No new memories in the last ${days} days._`);
      } else {
        // Group by type
        const byType = new Map<string, typeof recent>();
        for (const m of recent) {
          const t = m.memory.frontmatter.type;
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t)!.push(m);
        }

        for (const [type, mems] of byType) {
          lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)} (${mems.length})`);
          lines.push(``);

          for (const { memory: mem } of mems) {
            const fm = mem.frontmatter;
            const u = getUsage(usage, fm.id);
            const confidence = deriveConfidence(fm, u);
            const emoji = CONFIDENCE_EMOJI[confidence] ?? "⬜";
            const anchor = fm.anchor.paths.length > 0
              ? `\`${fm.anchor.paths[0]}\`` + (fm.anchor.paths.length > 1 ? ` +${fm.anchor.paths.length - 1}` : "")
              : "_no anchor_";

            lines.push(`### ${emoji} \`${fm.id}\``);
            lines.push(``);
            lines.push(`| Field | Value |`);
            lines.push(`|---|---|`);
            lines.push(`| **Status** | \`${fm.status}\` |`);
            lines.push(`| **Confidence** | ${confidence} |`);
            lines.push(`| **Scope** | ${fm.scope}${fm.module ? `/${fm.module}` : ""} |`);
            lines.push(`| **Tags** | ${fm.tags.length > 0 ? fm.tags.map((t) => `\`${t}\``).join(", ") : "_none_"} |`);
            lines.push(`| **Anchor** | ${anchor} |`);
            lines.push(`| **Reads** | ${u.read_count} |`);
            lines.push(`| **Created** | ${fm.created_at.slice(0, 10)} |`);
            lines.push(``);
            // First 6 lines of body
            const bodyPreview = mem.body.split("\n").slice(0, 6).join("\n").trim();
            lines.push(bodyPreview);
            lines.push(``);
            lines.push(`**Action:** [ ] approve &nbsp;&nbsp; [ ] reject &nbsp;&nbsp; [ ] keep as-is`);
            lines.push(``);
            lines.push(`---`);
            lines.push(``);
          }
        }
      }

      lines.push(``);
      lines.push(
        `> _To take action: \`hivelore memory approve <id>\`, \`hivelore memory reject <id>\`._`,
      );

      const digest = lines.join("\n");

      if (opts.out) {
        const outPath = path.resolve(process.cwd(), opts.out);
        await writeFile(outPath, digest, "utf8");
        ui.success(`Digest written to ${opts.out}  (${recent.length} memor${recent.length === 1 ? "y" : "ies"})`);
      } else {
        console.log(digest);
      }
    });
}
