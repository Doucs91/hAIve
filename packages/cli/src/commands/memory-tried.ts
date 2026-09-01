import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  findProjectRoot,
  resolveHaivePaths,
  type MemoryScope,
} from "@hivelore/core";
import { memTried } from "@hivelore/mcp";
import { ui } from "../utils/ui.js";

interface TriedOptions {
  what: string;
  whyFailed: string;
  instead?: string;
  scope?: MemoryScope;
  module?: string;
  tags?: string;
  paths?: string;
  files?: string;
  author?: string;
  sensorPattern?: string;
  sensorCommand?: string;
  sensorKind?: string;
  sensorTimeout?: string;
  sensorAbsent?: string;
  sensorSeverity?: string;
  sensorMessage?: string;
  badExample?: string;
  dir?: string;
}

function parseCsv(raw?: string): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function registerMemoryTried(memory: Command): void {
  memory
    .command("tried")
    .description(
      "Record a FAILED approach — prevents repeated mistakes in future sessions.\n\n" +
      "  This is the most valuable type of negative knowledge. It surfaces FIRST in\n" +
      "  get_briefing so agents can't miss it. Auto-validated (no approval cycle).\n\n" +
      "  Use this immediately when you try something and it fails.\n\n" +
      "  One-shot loop close: add --sensor-pattern to validate and attach the guardrail\n" +
      "  in the same command (equivalent to a follow-up `sensors propose`).\n\n" +
      "  Example:\n" +
      "    hivelore memory tried \\\\\n" +
      "      --what \"importing X with ESM dynamic import\" \\\\\n" +
      "      --why-failed \"tsup bundles it as CJS, dynamic import fails at runtime\" \\\\\n" +
      "      --instead \"use static import in the entry file\" \\\\\n" +
      "      --paths packages/cli/src/index.ts \\\\\n" +
      "      --sensor-pattern \"await import\\\\(\" --sensor-absent \"static import\"\n",
    )
    .requiredOption("--what <text>", "what approach was tried (short, descriptive title)")
    .requiredOption("--why-failed <text>", "why it failed or should NOT be used (include the exact error if possible)")
    .option("--instead <text>", "the correct approach to use instead")
    .option("--scope <scope>", "personal | team | module (default: personal — team when a --sensor-* option arms the lesson, so the gate travels)")
    .option("--module <name>", "module name (required when scope=module)")
    .option("--tags <csv>", "comma-separated tags")
    .option("--paths <csv>", "anchor paths, comma-separated")
    .option("--files <csv>", "alias for --paths (matches the MCP `files` parameter)")
    .option("--author <author>", "author email or handle")
    .option("--sensor-pattern <regex>", "one-shot: regex matching the FAULTY usage — validates + attaches a sensor in this call")
    .option("--sensor-command <cmd>", "one-shot BEHAVIOUR sensor: a command (test/script) the gate runs when the diff touches --paths; non-zero exit = lesson fires")
    .option("--sensor-kind <kind>", "with --sensor-command: shell | test (default test)")
    .option("--sensor-timeout <ms>", "with --sensor-command: max runtime in ms (default 120000)")
    .option("--sensor-absent <regex>", "one-shot: regex marking CORRECT usage nearby (excludes it from firing)")
    .option("--sensor-severity <level>", "one-shot sensor severity: warn | block", "block")
    .option("--sensor-message <text>", "one-shot: self-correction message shown when the sensor fires")
    .option("--bad-example <code>", "one-shot: code snippet the sensor must fire on (validation)")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: TriedOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.haiveDir)) {
        ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }

      const severity = opts.sensorSeverity === "warn" ? "warn" as const : "block" as const;
      let result: Awaited<ReturnType<typeof memTried>>;
      try {
        result = await memTried(
          {
            what: opts.what,
            why_failed: opts.whyFailed,
            instead: opts.instead,
            // "shared" is a legacy MemoryScope alias not accepted by mem_tried — normalize to team.
            // Undefined stays undefined: mem_tried defaults it (team when a sensor is attached).
            scope: opts.scope === "shared" ? "team" : opts.scope,
            module: opts.module,
            tags: parseCsv(opts.tags),
            paths: parseCsv(opts.paths ?? opts.files),
            author: opts.author,
            sensor: opts.sensorCommand
              ? {
                  kind: opts.sensorKind === "shell" ? "shell" as const : "test" as const,
                  pattern: undefined,
                  command: opts.sensorCommand,
                  timeout_ms: opts.sensorTimeout ? Math.max(1, Number(opts.sensorTimeout)) : undefined,
                  absent: undefined,
                  severity,
                  message: opts.sensorMessage,
                  bad_example: undefined,
                }
              : opts.sensorPattern
                ? {
                    kind: "regex" as const,
                    pattern: opts.sensorPattern,
                    command: undefined,
                    timeout_ms: undefined,
                    absent: opts.sensorAbsent,
                    severity,
                    message: opts.sensorMessage,
                    bad_example: opts.badExample,
                  }
                : undefined,
          },
          { paths },
        );
      } catch (err) {
        ui.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      ui.success(`Recorded: ${path.relative(root, result.file_path)}`);
      ui.info(`id=${result.id}  type=attempt  scope=${result.scope}  status=validated (auto-approved)`);

      if (result.sensor_result) {
        if (result.sensor_result.accepted) {
          ui.success(`Loop closed: sensor attached (${result.sensor_result.severity}) — the gate now refuses a repeat deterministically.`);
        } else {
          ui.warn(`Attempt saved, but the sensor was rejected (${result.sensor_result.reason ?? "rejected"}).`);
          if (result.sensor_result.guidance) ui.info(`  ${result.sensor_result.guidance}`);
        }
        return;
      }

      if (result.hint) ui.warn(result.hint);
      // Behaviour bridge: when a regex can't express the mistake, route a real test instead.
      ui.info(`  Prefer a real test? \`hivelore sensors scaffold ${result.id}\` generates a pending test + the wiring command.`);
    });
}
