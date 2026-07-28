import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  findProjectRoot,
  getUsage,
  loadUsageIndex,
  resolveHaivePaths,
} from "@hivelore/core";
import { loadMemoriesFromDir } from "../utils/fs.js";
import { ui } from "../utils/ui.js";

export interface PendingOptions {
  scope?: "personal" | "team" | "module";
  dir?: string;
}

export function registerMemoryPending(memory: Command): void {
  memory
    .command("pending", { hidden: true })
    .description("List draft and proposed memories awaiting review (sorted by reads desc).\n\n  draft = created but not yet activated · proposed = promoted, awaiting team validation")
    .option("--scope <scope>", "filter by scope (personal | team | module)")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: PendingOptions) => runPending(opts));
}

export async function runPending(opts: PendingOptions): Promise<void> {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.memoriesDir)) {
        ui.error(`No .ai/memories at ${root}.`);
        process.exitCode = 1;
        return;
      }

      const all = await loadMemoriesFromDir(paths.memoriesDir);
      const usage = await loadUsageIndex(paths);

      const filterFn = ({ memory: mem }: { memory: { frontmatter: { status: string; scope: string } } }) => {
        if (mem.frontmatter.status !== "proposed" && mem.frontmatter.status !== "draft") return false;
        if (opts.scope && mem.frontmatter.scope !== opts.scope) return false;
        return true;
      };
      const pending = all.filter(filterFn);

      if (pending.length === 0) {
        ui.info("No draft or proposed memories awaiting review.");
        ui.info("Drafts are created by `hivelore memory save` without `--status validated`.");
        return;
      }

      pending.sort(
        (a, b) =>
          getUsage(usage, b.memory.frontmatter.id).read_count -
          getUsage(usage, a.memory.frontmatter.id).read_count,
      );

      const now = Date.now();
      const drafts = pending.filter((m) => m.memory.frontmatter.status === "draft");
      const proposed = pending.filter((m) => m.memory.frontmatter.status === "proposed");

      if (proposed.length > 0) {
        console.log(ui.bold(`Proposed (${proposed.length}) — awaiting team validation`));
        for (const { memory: mem, filePath } of proposed) {
          const fm = mem.frontmatter;
          const u = getUsage(usage, fm.id);
          const ageDays = Math.floor((now - new Date(fm.created_at).getTime()) / 86_400_000);
          const ageStr = ageDays === 0 ? "today" : `${ageDays}d`;
          console.log(
            `  ${ui.bold(fm.id)}  ${ui.dim(`${fm.scope}/${fm.type}`)}  ${ui.dim(`age=${ageStr} reads=${u.read_count}`)}`,
          );
          console.log(`    ${ui.dim(path.relative(root, filePath))}`);
        }
        if (proposed.length > 0) console.log(ui.dim(`  → hivelore memory approve <id>  or  hivelore memory approve --all`));
        console.log();
      }

      if (drafts.length > 0) {
        console.log(ui.bold(`Draft (${drafts.length}) — created but not yet activated`));
        for (const { memory: mem, filePath } of drafts) {
          const fm = mem.frontmatter;
          const u = getUsage(usage, fm.id);
          const ageDays = Math.floor((now - new Date(fm.created_at).getTime()) / 86_400_000);
          const ageStr = ageDays === 0 ? "today" : `${ageDays}d`;
          console.log(
            `  ${ui.bold(fm.id)}  ${ui.dim(`${fm.scope}/${fm.type}`)}  ${ui.dim(`age=${ageStr} reads=${u.read_count}`)}`,
          );
          console.log(`    ${ui.dim(path.relative(root, filePath))}`);
        }
        console.log(ui.dim(`  → hivelore memory approve <id>   (activate)  |  hivelore memory promote <id>  (share with team)`));
      }

      ui.info(`${pending.length} total pending (${proposed.length} proposed · ${drafts.length} draft)`);
}
