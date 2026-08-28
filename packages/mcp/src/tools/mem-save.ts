import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  buildFrontmatter,
  loadConfig,
  loadMemoriesFromDir,
  memoryFilePath,
  serializeMemory,
  suggestSensorSeed,
  type Sensor,
} from "@hivelore/core";
import { z } from "zod";
import type { HaiveContext } from "../context.js";

export const MemSaveInputSchema = {
  type: z
    .enum(["convention", "decision", "gotcha", "architecture", "glossary", "skill", "attempt", "session_recap"])
    .describe(
      "Kind of memory being saved. " +
      "Use 'skill' for reusable procedures/playbooks agents should follow for recurring tasks (feedforward harness guide). " +
      "Use 'attempt' for failed approaches (auto-validated). " +
      "Use 'session_recap' via mem_session_end instead.",
    ),
  slug: z
    .string()
    .min(1)
    .describe("Short human-readable identifier — becomes part of the filename"),
  body: z
    .string()
    .describe("Markdown body of the memory"),
  scope: z
    .enum(["personal", "team", "module"])
    .optional()
    .describe(
      "Visibility scope: personal | team | module. " +
      "When omitted, falls back to defaultScope in haive.config.json (default: personal).",
    ),
  module: z
    .string()
    .optional()
    .describe("Module name (required when scope=module)"),
  tags: z.array(z.string()).default([]).describe("Tags for filtering"),
  domain: z.string().optional().describe("Domain (e.g. transactions, billing)"),
  author: z.string().optional().describe("Author handle or email"),
  paths: z
    .array(z.string())
    .default([])
    .describe("Anchor paths (file paths this memory references)"),
  symbols: z
    .array(z.string())
    .default([])
    .describe("Anchor symbols (function/class names this memory references)"),
  commit: z
    .string()
    .optional()
    .describe("Anchor commit SHA (for staleness detection later)"),
  lifecycle: z
    .enum(["applied", "planned", "abandoned"])
    .optional()
    .describe(
      "Does this describe code that EXISTS now, or a decision not yet built? 'applied' (default) = " +
      "reflected in the code; 'planned' = decided but NOT yet implemented (surfaced distinctly so agents " +
      "don't write code against it as if it were real); 'abandoned' = rejected, kept so it isn't re-tried.",
    ),
  topic: z
    .string()
    .optional()
    .describe(
      "Stable key for this memory. If a memory with the same topic already exists in this scope, " +
      "it is updated in-place (revision_count++). Use for knowledge that evolves over time.",
    ),
  activation: z
    .object({
      keywords: z.array(z.string()).default([]),
      globs: z.array(z.string()).default([]),
      always: z.boolean().default(false),
    })
    .optional()
    .describe(
      "Only for type='skill'. Progressive-disclosure triggers: the skill is surfaced ONLY when " +
      "a keyword matches the task or a glob matches the edited files (or always=true). Omit to keep " +
      "the skill always-eligible.",
    ),
};

export type MemSaveInput = {
  [K in keyof typeof MemSaveInputSchema]: z.infer<(typeof MemSaveInputSchema)[K]>;
};

export interface MemSaveOutput {
  id: string;
  scope: string;
  file_path: string;
  action: "created" | "updated";
  revision_count?: number;
  warning?: string;
  similar_found?: string[];
  /** High textual overlap with existing memory (same scope+type); consider merging instead. */
  body_similar?: { id: string; score: number };
  invalid_paths?: string[];
  /**
   * A gotcha/attempt anchored to code only CLOSES its prevention loop (the gate can block the repeat)
   * once a sensor is VALIDATED via propose_sensor. True until then — the lesson is briefed but not enforced.
   */
  loop_open?: boolean;
  /**
   * Heuristic candidate to PRE-FILL a propose_sensor call (refine, then call it). The agent owns the
   * final pattern — this is a starting point, never a persisted sensor.
   */
  proposed_sensor_seed?: { pattern: string; absent?: string; message: string };
  /** Directive describing how to close the loop (call propose_sensor). */
  sensor_hint?: string;
}

/**
 * Replace the old "auto-write a heuristic warn sensor" behavior: a saved gotcha/attempt no longer
 * persists a sensor. Instead we report whether the prevention loop is still open and, when possible,
 * a SEED to pre-fill propose_sensor — which validates the pattern (silent on current code, fires on
 * the bad example) before it is trusted. propose_sensor is now the sole writer of live sensors.
 */
function sensorLoopState(
  type: string,
  body: string,
  paths: string[],
  existingSensor: Sensor | undefined,
): Pick<MemSaveOutput, "loop_open" | "proposed_sensor_seed" | "sensor_hint"> {
  if (type !== "gotcha" && type !== "attempt") return {};
  // Already protected by a sensor (validated via propose_sensor, or a legacy one) → loop closed.
  if (existingSensor) return {};
  if (paths.length === 0) {
    return {
      loop_open: true,
      sensor_hint:
        "No `paths` given, so this lesson is feedforward-only — it will be briefed but the gate cannot " +
        "block the repeat. Re-save with `paths` set to the file(s) where the mistake lives, then call " +
        "propose_sensor to close the loop.",
    };
  }
  const seed = suggestSensorSeed(body, paths);
  if (seed) {
    return {
      loop_open: true,
      proposed_sensor_seed: {
        pattern: seed.pattern,
        ...(seed.absent ? { absent: seed.absent } : {}),
        message: seed.message,
      },
      sensor_hint:
        "This lesson is NOT yet enforced. Call propose_sensor to turn it into a reliable block — a " +
        "candidate is pre-filled in proposed_sensor_seed (refine it: pattern = the faulty usage, " +
        "absent = the correct-usage marker). Hivelore validates the proposal (silent on current code, " +
        "fires on the bad example) before trusting it to block.",
    };
  }
  return {
    loop_open: true,
    sensor_hint:
      "This lesson is NOT yet enforced and no candidate pattern could be derived from the wording. Call " +
      "propose_sensor with a discriminating pattern (pattern = faulty usage, absent = correct-usage " +
      "marker) to close the loop.",
  };
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 12);
}

const WORD_RE = /\b[a-z0-9]{3,}\b/gi;

function bodyTokenSet(body: string): Set<string> {
  const raw = body.toLowerCase().match(WORD_RE) ?? [];
  return new Set(raw);
}

/** Jaccard similarity on alphanumeric tokens — warns when corpus has near-duplicate wording. */
function maxBodySimilarity(
  incomingTokens: Set<string>,
  memories: Array<{ memory: { body: string; frontmatter: { scope: string; type: string; id: string; status?: string } } }>,
  scope: string,
  type: string,
  excludeIds?: ReadonlySet<string>,
): { score: number; id: string } | null {
  if (incomingTokens.size < 6) return null;
  let best: { score: number; id: string } | null = null;
  const skip = excludeIds ?? new Set<string>();
  for (const { memory } of memories) {
    const fm = memory.frontmatter;
    if (skip.has(fm.id)) continue;
    if (fm.scope !== scope || fm.type !== type) continue;
    if (fm.status === "rejected" || fm.status === "deprecated") continue;
    const other = bodyTokenSet(memory.body);
    if (other.size === 0) continue;
    let inter = 0;
    for (const t of incomingTokens) if (other.has(t)) inter++;
    const uni = incomingTokens.size + other.size - inter;
    const j = uni === 0 ? 0 : inter / uni;
    if (j >= 0.72 && (!best || j > best.score)) best = { score: j, id: fm.id };
  }
  return best;
}

export async function memSave(
  input: MemSaveInput,
  ctx: HaiveContext,
): Promise<MemSaveOutput> {
  if (!existsSync(ctx.paths.haiveDir)) {
    throw new Error(
      `No .ai/ directory at ${ctx.paths.root}. Run 'hivelore init' first.`,
    );
  }

  const existing = existsSync(ctx.paths.memoriesDir)
    ? await loadMemoriesFromDir(ctx.paths.memoriesDir)
    : [];

  // ── Resolve scope once: explicit input wins over config default ────────
  // Must be computed early so dedup and topic-upsert use the same scope
  // that the new memory will ultimately be saved under.
  const haiveConfig = await loadConfig(ctx.paths);
  const resolvedScope = (
    input.scope ?? haiveConfig.defaultScope ?? "personal"
  ) as "personal" | "team" | "module";

  // ── Anchor path validation ─────────────────────────────────────────────
  const invalidPaths = input.paths.filter(
    (p) => !existsSync(path.resolve(ctx.paths.root, p)),
  );

  // ── Dedup by content hash ──────────────────────────────────────────────
  const incomingHash = bodyHash(input.body);
  const hashDuplicate = existing.find(({ memory }) =>
    bodyHash(memory.body) === incomingHash &&
    memory.frontmatter.scope === resolvedScope,
  );
  if (hashDuplicate) {
    throw new Error(
      `Duplicate content detected — identical body already saved as "${hashDuplicate.memory.frontmatter.id}". ` +
      `Use mem_update to modify it, or change the body to add new information.`,
    );
  }

  const incomingTokens = bodyTokenSet(input.body);

  function bodySimilarWarnings(excludeIds?: ReadonlySet<string>): {
    similarityWarning?: string;
    body_similar?: MemSaveOutput["body_similar"];
  } {
    const dup = maxBodySimilarity(incomingTokens, existing, resolvedScope, input.type, excludeIds);
    if (!dup?.id) return {};
    const body_similar: MemSaveOutput["body_similar"] = {
      id: dup.id,
      score: Math.round(dup.score * 100) / 100,
    };
    return {
      similarityWarning: `Body is ~${Math.round(dup.score * 100)}% similar (token overlap) to existing "${dup.id}" — consolidate if redundant.`,
      body_similar,
    };
  }

  // ── Topic upsert ───────────────────────────────────────────────────────
  if (input.topic) {
    const topicMatch = existing.find(({ memory }) =>
      memory.frontmatter.topic === input.topic &&
      memory.frontmatter.scope === resolvedScope &&
      (!input.module || memory.frontmatter.module === input.module),
    );

    if (topicMatch) {
      const fm = topicMatch.memory.frontmatter;
      const { similarityWarning: simW, body_similar: bs } = bodySimilarWarnings(new Set([fm.id]));
      const newFrontmatter = {
        ...fm,
        tags: input.tags.length ? input.tags : fm.tags,
        revision_count: (fm.revision_count ?? 0) + 1,
        ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
        anchor: {
          commit: input.commit ?? fm.anchor.commit,
          paths: input.paths.length ? input.paths : fm.anchor.paths,
          symbols: input.symbols.length ? input.symbols : fm.anchor.symbols,
        },
      };
      await writeFile(
        topicMatch.filePath,
        serializeMemory({ frontmatter: newFrontmatter, body: input.body }),
        "utf8",
      );
      const mergedTw = [
        invalidPaths.length > 0
          ? `Anchor path(s) not found in project: ${invalidPaths.join(", ")}. They will be marked stale by hivelore sync.`
          : null,
        criticalAnchorWarning(input.type, fm.status, newFrontmatter.anchor.paths, newFrontmatter.anchor.symbols),
        simW ?? null,
      ]
        .filter(Boolean)
        .join(" — ") || undefined;

      const sensorState = sensorLoopState(input.type, input.body, newFrontmatter.anchor.paths, newFrontmatter.sensor);

      return {
        id: fm.id,
        scope: fm.scope,
        file_path: topicMatch.filePath,
        action: "updated",
        revision_count: newFrontmatter.revision_count,
        ...(mergedTw ? { warning: mergedTw } : {}),
        ...(bs ? { body_similar: bs } : {}),
        ...(invalidPaths.length > 0 ? { invalid_paths: invalidPaths } : {}),
        ...sensorState,
      };
    }
  }

  // ── Create new memory ──────────────────────────────────────────────────
  // resolvedScope and haiveConfig are already computed above.

  const frontmatter = buildFrontmatter({
    type: input.type,
    slug: input.slug,
    scope: resolvedScope,
    module: input.module,
    tags: input.tags,
    domain: input.domain,
    author: input.author,
    paths: input.paths,
    symbols: input.symbols,
    commit: input.commit,
    topic: input.topic,
    status: haiveConfig.defaultStatus === "validated" ? "validated" : undefined,
    activation: input.type === "skill" ? input.activation : undefined,
    lifecycle: input.lifecycle,
  });
  // Created already-validated by config (defaultStatus), not by explicit review → mark "auto".
  if (frontmatter.status === "validated") frontmatter.validated_by = "auto";

  const file = memoryFilePath(
    ctx.paths,
    frontmatter.scope,
    frontmatter.id,
    frontmatter.module,
  );
  await mkdir(path.dirname(file), { recursive: true });

  if (existsSync(file)) {
    throw new Error(`Memory already exists at ${file}`);
  }

  // ── Similar slug detection (warn but don't block) ──────────────────────
  let warning: string | undefined;
  let similar_found: string[] | undefined;
  if (existing.length > 0) {
    const slugTokens = input.slug.toLowerCase().split(/[-_\s]+/).filter(Boolean);
    const similar = existing.filter(({ memory }) => {
      const id = memory.frontmatter.id.toLowerCase();
      return (
        slugTokens.length >= 2 &&
        slugTokens.filter((t) => id.includes(t)).length >= Math.ceil(slugTokens.length * 0.6)
      );
    });
    if (similar.length > 0) {
      similar_found = similar.map((m) => m.memory.frontmatter.id);
      warning = `Possible duplicate: similar memories already exist (${similar_found.join(", ")}). Consider updating one of these instead.`;
    }
  }

  await writeFile(file, serializeMemory({ frontmatter, body: input.body }), "utf8");

  const { similarityWarning: simWarnNew, body_similar: bsNew } = bodySimilarWarnings();

  // Merge warnings: invalid anchors + slug similarity + body similarity
  const finalWarning = [
    invalidPaths.length > 0
      ? `Anchor path(s) not found in project: ${invalidPaths.join(", ")}. They will be marked stale by \`hivelore sync\`.`
      : null,
    criticalAnchorWarning(frontmatter.type, frontmatter.status, frontmatter.anchor.paths, frontmatter.anchor.symbols),
    warning ?? null,
    simWarnNew ?? null,
  ].filter(Boolean).join(" — ") || undefined;

  return {
    id: frontmatter.id,
    scope: frontmatter.scope,
    file_path: file,
    action: "created",
    ...(finalWarning ? { warning: finalWarning } : {}),
    ...(similar_found ? { similar_found } : {}),
    ...(bsNew ? { body_similar: bsNew } : {}),
    ...(invalidPaths.length > 0 ? { invalid_paths: invalidPaths } : {}),
    ...sensorLoopState(input.type, input.body, input.paths, frontmatter.sensor),
  };
}

function criticalAnchorWarning(
  type: string,
  status: string,
  paths: string[],
  symbols: string[],
): string | null {
  if (!["decision", "gotcha", "architecture"].includes(type)) return null;
  if (status !== "validated") return null;
  if (paths.length > 0 || symbols.length > 0) return null;
  return `${type} is validated without paths or symbols; add anchors so Hivelore can detect drift.`;
}
