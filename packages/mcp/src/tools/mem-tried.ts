import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  buildFrontmatter,
  memoryFilePath,
  serializeMemory,
} from "@hivelore/core";
import { z } from "zod";
import type { HaiveContext } from "../context.js";
import { proposeSensor } from "./propose-sensor.js";

export const MemTriedInputSchema = {
  what: z.string().min(1).describe("Brief description of the approach that was tried"),
  why_failed: z
    .string()
    .min(1)
    .describe("Why it failed or why it should NOT be used"),
  instead: z
    .string()
    .optional()
    .describe("What to use or do instead (recommended alternative)"),
  scope: z
    .enum(["personal", "team", "module"])
    .optional()
    .describe(
      "Visibility scope. Defaults to personal — EXCEPT when a one-shot `sensor` is attached: an " +
      "enforced lesson is team truth (the sensor must travel to every machine and CI), so it " +
      "defaults to team. Pass scope explicitly to override.",
    ),
  module: z.string().optional().describe("Module name (required when scope=module)"),
  tags: z.array(z.string()).default([]).describe("Tags for filtering"),
  paths: z
    .array(z.string())
    .default([])
    .describe("Anchor file paths this applies to"),
  author: z.string().optional().describe("Author handle or email"),
  sensor: z
    .object({
      kind: z.enum(["regex", "ast", "shell", "test"]).default("regex").describe("regex/AST pattern, or a shell/test command"),
      pattern: z.string().optional().describe("kind=regex|ast: pattern matching the faulty usage"),
      rule: z.record(z.unknown()).optional().describe("kind=ast: full ast-grep Rule object"),
      language: z.string().optional().describe("kind=ast: explicit built-in/dynamic language"),
      command: z.string().optional().describe("kind=shell|test: command the gate runs when the diff touches the sensor's paths (non-zero exit = lesson fires)"),
      timeout_ms: z.number().int().positive().optional().describe("kind=shell|test: max runtime (default 120000)"),
      absent: z.string().optional().describe("kind=regex: regex marking CORRECT usage nearby — excludes it from firing"),
      severity: z.enum(["warn", "block"]).default("block").describe("block = deterministic gate refusal"),
      message: z.string().optional().describe("Self-correction message shown when the sensor fires"),
      incident: z.string().optional().describe("Provenance: the incident this sensor guards (e.g. 'prod #442') — surfaced when it fires and in the receipt"),
      red_ref: z.string().optional().describe("kind=shell|test: pre-fix commit/ref — the oracle must FAIL on it (proves the test catches the incident; records red_proven)"),
      bad_example: z.string().optional().describe("kind=regex: code snippet the sensor MUST fire on (validation)"),
    })
    .optional()
    .describe(
      "ONE-SHOT loop close: validate and attach a sensor in the same call (equivalent to a follow-up " +
      "propose_sensor). Validated against HEAD — silent on current code, fires on the bad example. " +
      "If rejected, the attempt is still saved and the verdict tells you how to revise.",
    ),
};

export type MemTriedInput = {
  [K in keyof typeof MemTriedInputSchema]: z.infer<(typeof MemTriedInputSchema)[K]>;
};

export interface MemTriedOutput {
  id: string;
  scope: string;
  file_path: string;
  /**
   * A captured attempt closes its prevention loop (gate can block the repeat) only once a sensor is
   * VALIDATED via propose_sensor. True until then — the lesson is briefed but not enforced.
   */
  loop_open: boolean;
  /** Heuristic candidate to PRE-FILL a propose_sensor call (refine, then call it). Never a persisted sensor. */
  proposed_sensor_seed?: { pattern: string; absent?: string; message: string };
  /** Next-step guidance: how to close the loop via propose_sensor. */
  hint?: string;
  /** When input.sensor was given: the inline propose_sensor verdict (accepted ⇒ loop closed). */
  sensor_result?: {
    accepted: boolean;
    severity: "warn" | "block";
    reason?: string;
    guidance?: string;
  };
}

export async function memTried(
  input: MemTriedInput,
  ctx: HaiveContext,
): Promise<MemTriedOutput> {
  if (!existsSync(ctx.paths.haiveDir)) {
    throw new Error(`No .ai/ directory at ${ctx.paths.root}. Run 'hivelore init' first.`);
  }

  // Ids are permanent: don't let the 5-word cut end on a connective ("…-between-api-AND").
  const SLUG_STOPWORDS = new Set(["and", "or", "the", "a", "an", "of", "to", "in", "for", "with", "on", "at", "by"]);
  const words = input.what
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5);
  while (words.length > 2 && SLUG_STOPWORDS.has(words[words.length - 1]!)) words.pop();
  const slug = words.join("-");

  // An enforced lesson is TEAM truth: a sensor that lives on a personal (gitignored) memory only
  // guards the machine that captured it — the incident would repeat on every other clone. So a
  // one-shot sensor flips the default scope to team; an explicit scope always wins.
  const scope = input.scope ?? (input.sensor ? "team" : "personal");

  const baseFm = buildFrontmatter({
    type: "attempt",
    slug,
    scope,
    module: input.module,
    tags: input.tags,
    paths: input.paths,
    author: input.author,
  });
  // attempt memories are immediately validated — no review cycle needed
  const frontmatter = { ...baseFm, status: "validated" as const };

  const lines: string[] = [`# ${input.what}`, ""];
  lines.push(`**Why it failed / do NOT use:** ${input.why_failed}`);
  if (input.instead) {
    lines.push("", `**Instead, use:** ${input.instead}`);
  }
  const body = lines.join("\n") + "\n";

  const file = memoryFilePath(ctx.paths, frontmatter.scope, frontmatter.id, frontmatter.module);
  await mkdir(path.dirname(file), { recursive: true });

  if (existsSync(file)) {
    throw new Error(`Memory already exists at ${file}`);
  }

  await writeFile(file, serializeMemory({ frontmatter, body }), "utf8");

  // ONE-SHOT loop close: when the caller supplies a sensor, run the exact propose_sensor
  // validation inline (HEAD-baseline self-check, brittle/bad-example gates) — same rules,
  // one call instead of two. A rejected proposal never blocks saving the attempt itself.
  if (input.sensor) {
    const verdict = await proposeSensor(
      {
        memory_id: frontmatter.id,
        kind: input.sensor.kind ?? "regex",
        pattern: input.sensor.pattern,
        rule: input.sensor.rule,
        language: input.sensor.language,
        command: input.sensor.command,
        timeout_ms: input.sensor.timeout_ms,
        absent: input.sensor.absent,
        severity: input.sensor.severity ?? "block",
        message: input.sensor.message,
        incident: input.sensor.incident,
        red_ref: input.sensor.red_ref,
        bad_example: input.sensor.bad_example,
        flags: undefined,
        paths: [],
        exclude: [],
        replace: false,
        require_present: false,
      },
      ctx,
    );
    return {
      id: frontmatter.id,
      scope: frontmatter.scope,
      file_path: file,
      loop_open: !verdict.accepted,
      sensor_result: {
        accepted: verdict.accepted,
        severity: input.sensor.severity ?? "block",
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.guidance ? { guidance: verdict.guidance } : {}),
      },
      hint: (verdict.accepted
        ? "Loop closed: the attempt is saved AND enforced — the gate now refuses a repeat deterministically."
        : `Attempt saved, but the sensor was rejected (${verdict.reason}). Revise per the guidance and re-propose with propose_sensor.`) +
        (input.scope === undefined
          ? " Saved team-scoped (an enforced lesson must travel with the repo) — pass scope:'personal' to keep it private."
          : ""),
    };
  }

  // A captured attempt only CLOSES the loop (gate blocks the repeat) once a sensor is VALIDATED via
  // propose_sensor. We no longer auto-write a heuristic warn sensor; instead we hand the agent a SEED
  // (when one can be derived) to pre-fill propose_sensor, and tell it the loop is open until then.
  // No prose-mined seed: it produced unusable patterns in the field (report 2026-09-01 §5.1).
  // Route to propose_sensor (which validates) or the diff miner — the only trustworthy auto-source.
  const hint =
    input.paths.length === 0
      ? "No `paths` given, so this attempt is feedforward-only — it will be briefed but the gate cannot block the repeat. Re-run with `paths` set to the file(s) where the mistake lives, then call propose_sensor to close the loop."
      : "This attempt is NOT yet enforced. Call propose_sensor with a discriminating pattern (pattern = the faulty usage, absent = the correct-usage marker) to turn it into a reliable block; Hivelore validates it (silent on current code, fires on the bad example) before trusting it. To auto-derive a candidate from the actual fix diff, run `hivelore sensors propose --from-fix <ref>`.";

  return {
    id: frontmatter.id,
    scope: frontmatter.scope,
    file_path: file,
    loop_open: true,
    hint,
  };
}
