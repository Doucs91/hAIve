import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  findProjectRoot,
  loadConfig,
  resolveHaivePaths,
} from "@hivelore/core";
import {
  SUPPORTED_STACKS,
  autoDetectStacks,
  isValidStack,
  seedStackPack,
} from "./init-stack-packs.js";
import { applyAutopilotRepairs } from "../utils/autopilot.js";
import { ui } from "../utils/ui.js";

interface SeedOptions {
  git?: boolean;
  apply?: boolean;
  limit?: string;
  days?: string;
  scope?: string;  // --git mode: personal | team
  list?: boolean;
  json?: boolean;
  dir?: string;
}

/** Best-effort read of the project's dependency map from package.json. */
async function readDependencyMap(root: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

export function registerMemorySeed(memory: Command): void {
  memory
    .command("seed [stack]")
    .description(
      "Seed a stack pack of starter memories on demand.\n\n" +
      "  Stack packs are generic framework gotchas/conventions every team using that\n" +
      "  stack rediscovers. They are tagged `stack-pack` and kept at BACKGROUND priority\n" +
      "  in briefings until you anchor them to a real file or replace them with a\n" +
      "  repo-specific note — so they never crowd out your own knowledge.\n\n" +
      "  Examples:\n" +
      "    hivelore memory seed              # auto-detect stacks from package.json and seed them\n" +
      "    hivelore memory seed nestjs       # seed a specific stack\n" +
      "    hivelore memory seed --list       # show supported + auto-detected stacks\n" +
      "    hivelore memory seed --list --json\n\n" +
      "  Richer sources than a generic pack — both propose memories from evidence you already have:\n" +
      "    hivelore memory seed --git              # lessons mined from revert/hotfix commits\n" +
      "    hivelore ingest --from github-pr 123    # lessons mined from PR REVIEW COMMENTS\n" +
      "      A reviewer writing \"careful, the signature must be verified here\" is exactly the\n" +
      "      knowledge Hivelore wants, already carrying its file and line.\n",
    )
    .option("--git", "seed draft `attempt` lessons from revert/hotfix commits instead of stack packs (absorbed seed-git)")
    .option("--apply", "with --git: write the proposed seeds as draft memories (default: preview)", false)
    .option("--limit <n>", "with --git: max seeds to propose", "20")
    .option("--days <n>", "with --git: git-history lookback window in days", "365")
    .option("--scope <scope>", "with --git: personal | team", "team")
    .option("--list", "list supported stacks (and which are auto-detected here) and exit")
    .option("--json", "machine-readable output (use with --list)")
    .option("-d, --dir <dir>", "project root")
    .action(async (stack: string | undefined, opts: SeedOptions) => {
      if (opts.git) {
        const { runGitSeed } = await import("./memory-seed-git.js");
        await runGitSeed({ apply: opts.apply, limit: opts.limit, days: opts.days, scope: opts.scope === "personal" ? "personal" : "team", json: opts.json, dir: opts.dir });
        return;
      }
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const deps = await readDependencyMap(root);
      const detected = autoDetectStacks(deps);

      // ── --list ──────────────────────────────────────────────────────────
      if (opts.list) {
        if (opts.json) {
          console.log(JSON.stringify({ supported: SUPPORTED_STACKS, detected }, null, 2));
          return;
        }
        ui.info("Supported stacks:");
        for (const s of SUPPORTED_STACKS) {
          const mark = detected.includes(s) ? ui.green(" ✓ detected here") : "";
          console.log(`  • ${s}${mark}`);
        }
        if (detected.length === 0) {
          ui.info("No stack auto-detected from package.json — pass a stack name explicitly.");
        }
        return;
      }

      if (!existsSync(paths.haiveDir)) {
        ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }

      // ── Decide which stacks to seed ─────────────────────────────────────
      let stacksToSeed: string[];
      if (stack) {
        if (!isValidStack(stack)) {
          ui.error(`Unknown stack '${stack}'. Supported: ${SUPPORTED_STACKS.join(", ")}.`);
          ui.info("Run `hivelore memory seed --list` to see all stacks.");
          process.exitCode = 1;
          return;
        }
        stacksToSeed = [stack];
      } else if (detected.length > 0) {
        stacksToSeed = detected;
        ui.info(`Auto-detected from package.json: ${detected.join(", ")}`);
      } else {
        ui.error("No stack auto-detected from package.json.");
        ui.info("Pass a stack name (e.g. `hivelore memory seed nestjs`) or run `hivelore memory seed --list`.");
        process.exitCode = 1;
        return;
      }

      // ── Seed ────────────────────────────────────────────────────────────
      let total = 0;
      const seededStacks: string[] = [];
      for (const s of stacksToSeed) {
        const result = await seedStackPack(paths, s as (typeof SUPPORTED_STACKS)[number]);
        if (result.memories > 0) {
          total += result.memories;
          seededStacks.push(`${s} (${result.memories})`);
        } else {
          ui.info(`Stack pack '${s}': all memories already exist — skipped.`);
        }
      }

      if (total === 0) {
        ui.info("Nothing new to seed — every memory in the selected pack(s) already exists.");
        return;
      }

      ui.success(`Seeded ${total} starter memor${total === 1 ? "y" : "ies"}: ${seededStacks.join(", ")}`);
      ui.info("Kept at background priority. Anchor them to a real file (or replace them) to make them high-signal:");
      ui.info("  hivelore memory update <id> --paths <key-file>   # anchor a seed to a file");

      // Refresh the embeddings index so the new seeds are searchable (autopilot only).
      const config = await loadConfig(paths);
      if (config.autopilot || config.autoRepair?.corpus === true) {
        const repairs = await applyAutopilotRepairs(root, paths, {
          applyConfig: false,
          applyContext: false,
          applyCorpus: true,
          applyCodeMap: false,
          applyCodeSearch: false,
        });
        for (const repair of repairs) ui.info(repair.message);
      }
    });
}
