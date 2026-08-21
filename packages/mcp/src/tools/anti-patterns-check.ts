import { existsSync } from "node:fs";
import {
  addedLinesFromDiff,
  BRIDGE_TARGET_PATH,
  buildDocFrequency,
  CODE_STOPWORDS,
  deriveConfidence,
  diffHasDistinctiveOverlap,
  getUsage,
  isRetiredMemory,
  loadMemoriesFromDir,
  loadUsageIndex,
  literalMatchesAnyToken,
  memoryMatchesAnchorPaths,
  recordPreventionHits,
  runSensors,
  sensorTargetsFromDiff,
  tokenizeQuery,
  type DocFrequency,
} from "@hivelore/core";
import { z } from "zod";
import type { HaiveContext } from "../context.js";

export const AntiPatternsCheckInputSchema = {
  diff: z
    .string()
    .optional()
    .describe(
      "Raw unified diff text (or any code/text snippet) to scan for previously documented anti-patterns. " +
      "Tokens from the diff are used to match memory bodies and the embeddings index.",
    ),
  paths: z
    .array(z.string())
    .default([])
    .describe(
      "File paths affected by the change. Memories anchored to any of these paths are surfaced regardless of the diff content.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .default(8)
    .describe("Cap on returned warnings."),
  semantic: z
    .boolean()
    .default(true)
    .describe(
      "When true, also use semantic search (requires @hivelore/embeddings + memory index) to find related anti-patterns.",
    ),
  min_semantic_score: z
    .number()
    .min(0)
    .max(1)
    .default(0.45)
    .describe(
      "Minimum cosine score for semantic-only anti-pattern hits. Anchor/literal matches still surface. " +
      "Default 0.45 keeps broad, weakly-related memories out of review noise.",
    ),
  track: z
    .boolean()
    .default(true)
    .describe("Record real prevention outcomes. Set false for eval/selftest probes so synthetic cases never inflate ROI."),
};

export interface AntiPatternsCheckInput {
  diff?: string;
  paths: string[];
  limit: number;
  semantic: boolean;
  min_semantic_score?: number;
  track?: boolean;
}

export interface AntiPatternsWarning {
  id: string;
  type: "attempt" | "gotcha";
  scope: string;
  confidence: string;
  body_preview: string;
  reasons: Array<"anchor" | "literal" | "semantic" | "sensor">;
  /**
   * True when the LITERAL overlap includes a token that is *distinctive* to this memory
   * (rare across the gotcha corpus) — e.g. `BigInt`, `open-in-view`. Only a distinctive
   * literal overlap is precise enough to hard-block; a shared common word ("memory",
   * "scope", "version") sets only the `literal` reason for review. Powers the gate.
   */
  distinctive_literal?: boolean;
  semantic_score?: number;
  /** When a regex sensor fired: its self-correction message and severity. */
  sensor_message?: string;
  sensor_severity?: "warn" | "block";
  /** Memory tags — used downstream (e.g. pre_commit_check) to weight a warning by topic. */
  tags?: string[];
  /** Anchor paths of the memory — lets the gate tell what kind of file this warning is about. */
  anchor_paths?: string[];
  /**
   * True when the memory has an executable sensor defined.
   * Used by the pre-commit gate: if a sensor exists but did NOT fire (no "sensor" reason),
   * the sensor is the authoritative check and literal matching alone should not block.
   */
  has_sensor?: boolean;
}

export interface AntiPatternsCheckOutput {
  /** Total number of attempt+gotcha memories that exist in this project. */
  scanned: number;
  warnings: AntiPatternsWarning[];
  notice?: string;
}

/**
 * Tokenize a diff for LITERAL anti-pattern matching.
 *
 * `tokenizeQuery` splits on whitespace only, so code without spaces around an identifier
 * (e.g. `Number(BigInt(a))`) collapses into one un-matchable blob and the "literal" signal
 * silently disappears — leaving the gate to lean on the (non-deterministic, warmup-sensitive)
 * semantic score. We additionally split on non-word boundaries and keep identifier-length
 * tokens (>= 4 chars, not a ubiquitous keyword) so `BigInt`, `lodash`, `openInView`, etc. are
 * matched reliably. The set is unioned with the whitespace tokens to preserve existing behavior.
 */
function tokenizeDiffForLiteral(diff: string): string[] {
  // If this is a unified diff, only consider ADDED lines. The gate should fire on
  // "you introduced the bad pattern", not "you touched a file that merely mentions it"
  // (or "you REMOVED it"). This cuts false positives on refactors that edit anchored files.
  const lines = diff.split("\n");
  const looksLikeDiff = lines.some((l) => /^[+-]/.test(l));
  const addedOnly = looksLikeDiff
    ? lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n")
    : diff;
  const source = addedOnly.trim().length > 0 ? addedOnly : diff;

  const wsTokens = tokenizeQuery(source);
  const wordTokens = source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !CODE_STOPWORDS.has(t));
  return [...new Set([...wsTokens, ...wordTokens])];
}

/**
 * Files Hivelore generates/writes that are NOT application code: agent bridges (Lot A init + Lot C
 * bridges), the MCP client configs, and `.gitignore` (init appends a Hivelore block). Scanning any of
 * these for anti-patterns self-matches the corpus they mirror (a bridge listing the seeded gotchas,
 * a `.gitignore` line that merely contains "cache", etc.).
 */
const HAIVE_GENERATED_FILES = new Set<string>([
  ...Object.values(BRIDGE_TARGET_PATH), // .clinerules, .windsurfrules, .continuerules, .rules, AGENTS.md, .github/copilot-instructions.md, .sourcegraph/cody-rules.md
  "CLAUDE.md",
  ".cursorrules",
  ".gitignore",
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
]);

/**
 * True for files Hivelore itself owns/generates: the `.ai/` knowledge base, plus the agent-bridge,
 * config, and workflow files it writes from that same corpus. Scanning these for anti-patterns
 * self-matches the memories they mirror and fabricates "prevented mistake" events on the very first
 * post-init commit (which stages the seeded corpus AND everything init generated, all at once).
 */
export function isHaiveOwnedPath(p: string): boolean {
  if (p.startsWith(".ai/")) return true;
  if (HAIVE_GENERATED_FILES.has(p)) return true;
  if (p.startsWith(".cursor/rules/")) return true; // haive-mcp-required.mdc and siblings
  if (/^\.github\/workflows\/(hivelore|haive)-.*\.ya?ml$/.test(p)) return true;
  return false;
}

/**
 * Above this many added lines, the fuzzy corroboration layers (literal token overlap + semantic
 * embedding) are skipped — they are review-only (never hard-block) and cost O(added-lines × memories).
 * A human/agent code change is virtually never this large; exceeding it means a generated file,
 * lockfile, or accidentally staged dependency tree. Anchors and sensors are never subject to this cap.
 */
export const MAX_FUZZY_SCAN_LINES = 20_000;

/**
 * Drop hunks for Hivelore-owned files (see {@link isHaiveOwnedPath}) from a unified diff. Anti-patterns
 * are about CODE reintroducing a known mistake — editing Hivelore's own knowledge base or the bridge
 * files it generates from that corpus must never corroborate a literal/semantic match. Without this,
 * re-tagging a memory, or simply committing a fresh `hivelore init` (which writes the seeded corpus AND
 * its bridges in one commit), self-matches and can hard-block or inflate prevention counts.
 * See gotcha 2026-06-03-gotcha-antipattern-self-match-on-memory-file-edit.
 */
/** Test/spec files — they deliberately exercise the symbols & patterns gotchas warn about. */
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
export function isTestPath(p: string): boolean {
  return TEST_PATH_RE.test(p);
}

/**
 * Drop test/spec hunks from a diff before anti-pattern matching. A test that asserts on a documented
 * gotcha (e.g. `expect(serializeMemory(x))…`, or `import lodash` in a "no lodash" test) legitimately
 * contains the very token/pattern the gotcha describes — using it is not reintroducing the mistake.
 * Letting test edits corroborate a literal/semantic match is a recurring false-positive source, so the
 * scan ignores them (production-code blocking, incl. anchored gotchas, is unaffected).
 */
export function stripTestHunks(diff: string): string {
  if (!diff.includes("diff --git")) return diff;
  const out: string[] = [];
  let block: string[] = [];
  let keep = true;
  const flush = (): void => {
    // Push element-by-element, never `out.push(...block)`: a spread passes every element as a
    // call argument, and a single huge hunk (a staged lockfile, generated file, or an accidentally
    // staged node_modules) overflows the call-argument limit — RangeError: Maximum call stack size
    // exceeded — which fails the whole gate closed on an unactionable message. A loop is unbounded.
    if (keep) for (const l of block) out.push(l);
    block = [];
    keep = true;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const target = line.match(/ b\/(.+)$/)?.[1] ?? "";
      keep = !isTestPath(target);
    }
    block.push(line);
  }
  flush();
  return out.join("\n");
}

export function stripAiDirHunks(diff: string): string {
  if (!diff.includes("diff --git")) return diff; // no file headers to split on — leave as-is
  const out: string[] = [];
  let block: string[] = [];
  let keep = true;
  const flush = (): void => {
    // Loop, not `out.push(...block)` — see stripTestHunks: a spread over a huge hunk overflows the
    // call-argument limit and fails the gate closed. A loop scales to any diff size.
    if (keep) for (const l of block) out.push(l);
    block = [];
    keep = true;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const target = line.match(/ b\/(.+)$/)?.[1] ?? "";
      keep = !isHaiveOwnedPath(target);
    }
    block.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Scan a diff (or set of paths) against documented attempt/gotcha memories.
 * Surfaces "you are about to repeat a known mistake" warnings BEFORE you commit.
 *
 * Matching strategy:
 *   1. Anchor — memories anchored to any of the changed paths
 *   2. Literal — tokens from the diff overlap with memory body
 *   3. Semantic — cosine similarity (when enabled and index available)
 */
export async function antiPatternsCheck(
  input: AntiPatternsCheckInput,
  ctx: HaiveContext,
): Promise<AntiPatternsCheckOutput> {
  if (!input.diff && input.paths.length === 0) {
    return {
      scanned: 0,
      warnings: [],
      notice: "Nothing to check — provide either `diff` text or `paths`.",
    };
  }
  if (!existsSync(ctx.paths.memoriesDir)) {
    return { scanned: 0, warnings: [], notice: "No .ai/memories directory — nothing to check against." };
  }

  const all = await loadMemoriesFromDir(ctx.paths.memoriesDir);
  const minSemanticScore = input.min_semantic_score ?? 0.45;
  const negative = all.filter(({ memory }) => {
    const t = memory.frontmatter.type;
    if (t !== "attempt" && t !== "gotcha") return false;
    const s = memory.frontmatter.status;
    return s !== "rejected" && s !== "deprecated" && s !== "stale" &&
      !isRetiredMemory(memory.frontmatter, memory.body);
  });

  if (negative.length === 0) {
    return { scanned: 0, warnings: [], notice: "No attempt/gotcha memories found yet." };
  }

  const usage = await loadUsageIndex(ctx.paths);
  // Document frequency over the gotcha/attempt corpus — drives distinctive-token
  // corroboration so a shared *common* word never hard-blocks (false positives).
  const docFreq: DocFrequency = buildDocFrequency(negative.map(({ memory }) => memory.body));
  const seen = new Map<string, AntiPatternsWarning>();

  const upsert = (
    fm: { id: string; type: string; scope: string; tags?: string[]; anchor?: { paths?: string[] }; sensor?: unknown },
    body: string,
    reason: AntiPatternsWarning["reasons"][number],
    score?: number,
  ): void => {
    const existing = seen.get(fm.id);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (score !== undefined && (existing.semantic_score ?? 0) < score) {
        existing.semantic_score = score;
      }
      return;
    }
    const u = getUsage(usage, fm.id);
    seen.set(fm.id, {
      id: fm.id,
      type: fm.type as "attempt" | "gotcha",
      scope: fm.scope,
      confidence: deriveConfidence(fm as Parameters<typeof deriveConfidence>[0], u),
      body_preview: body.split("\n").slice(0, 5).join("\n").slice(0, 400),
      reasons: [reason],
      tags: fm.tags ?? [],
      anchor_paths: fm.anchor?.paths ?? [],
      ...(fm.sensor != null ? { has_sensor: true } : {}),
      ...(score !== undefined ? { semantic_score: score } : {}),
    });
  };

  // 1. Anchor matches
  if (input.paths.length > 0) {
    for (const { memory } of negative) {
      if (memoryMatchesAnchorPaths(memory, input.paths)) {
        upsert(memory.frontmatter, memory.body, "anchor");
      }
    }
  }

  // Code-only view of the diff: `.ai/` knowledge-base edits never corroborate "you reintroduced a
  // bad pattern in code" (they'd self-match the very memory that documents it).
  const scanDiff = input.diff ? stripTestHunks(stripAiDirHunks(input.diff)) : input.diff;

  // Bound the FUZZY corroboration (literal token overlap + semantic embedding) on pathologically
  // large diffs — a staged lockfile, a generated megafile, or an accidentally staged node_modules.
  // Both are review-only signals (they never hard-block — only a deterministic sensor does), and
  // both cost O(added-lines × memories), so on a huge diff they turn a fast gate into a multi-second
  // stall for zero enforcement value. Anchored lessons (path-based) and sensors (the block path)
  // run in full regardless; only the fuzzy surfacing is skipped, with a notice.
  const scanAddedLineCount = scanDiff ? addedLinesFromDiff(scanDiff).split("\n").length : 0;
  const fuzzyScanTooLarge = scanAddedLineCount > MAX_FUZZY_SCAN_LINES;
  const notice = fuzzyScanTooLarge
    ? `Diff is very large (${scanAddedLineCount.toLocaleString()} added lines) — literal/semantic ` +
      `corroboration skipped for performance; anchored lessons and deterministic sensors were still ` +
      `evaluated in full. If this staged node_modules or a build artifact, unstage it.`
    : undefined;

  // 2. Literal token overlap from diff
  if (scanDiff && !fuzzyScanTooLarge) {
    const tokens = tokenizeDiffForLiteral(scanDiff);
    const added = addedLinesFromDiff(scanDiff);
    const addedText = added.trim().length > 0 ? added : scanDiff;
    if (tokens.length > 0) {
      for (const { memory } of negative) {
        if (literalMatchesAnyToken(memory, tokens)) {
          upsert(memory.frontmatter, memory.body, "literal");
          // Distinguish a meaningful overlap (the diff contains a token rare to this
          // gotcha) from incidental shared domain words. Only the former can hard-block.
          if (diffHasDistinctiveOverlap(addedText, memory.body, docFreq)) {
            const w = seen.get(memory.frontmatter.id);
            if (w) w.distinctive_literal = true;
          }
        }
      }
    }
  }

  // 2b. Sensor matches — deterministic regex checks derived from memories.
  // A sensor fires on the ADDED lines of the diff ("you introduced the bad pattern").
  // This is the feedback *computational* signal: same result every time, no warmup.
  if (scanDiff) {
    const added = addedLinesFromDiff(scanDiff);
    const diffTargets = sensorTargetsFromDiff(scanDiff);
    const hasFileTargets = diffTargets.some((target) => target.path.length > 0);
    // Never run sensors against Hivelore-owned files — a memory/bridge that documents a bad pattern
    // contains that pattern and would self-fire (see stripAiDirHunks / isHaiveOwnedPath).
    const codePaths = input.paths.filter((p) => !isHaiveOwnedPath(p));
    const fallbackContent = added.trim().length > 0 ? added : scanDiff;
    const targets = diffTargets.length > 0 && hasFileTargets
      ? diffTargets
      : codePaths.length > 0
        ? codePaths.map((p) => ({ path: p, content: fallbackContent }))
        : [{ path: "", content: fallbackContent }];
    const hits = runSensors(negative.map(({ memory }) => memory), targets);
    for (const hit of hits) {
      const found = negative.find(({ memory }) => memory.frontmatter.id === hit.memory_id);
      if (!found) continue;
      upsert(found.memory.frontmatter, found.memory.body, "sensor");
      const w = seen.get(found.memory.frontmatter.id);
      if (w) {
        w.sensor_message = hit.message;
        w.sensor_severity = hit.severity;
      }
    }
  }

  // 3. Semantic search
  if (input.semantic && scanDiff && !fuzzyScanTooLarge) {
    try {
      const mod = await import("@hivelore/embeddings");
      // Embed the ADDED lines only — "what you INTRODUCED" — not the raw diff. The raw diff carries
      // context lines, removed lines and file headers; embedding that whole blob blurs the query and
      // inflates cosine similarity against broadly-related memories (a big release matches *some*
      // high-confidence gotcha at ≥0.75 and hard-blocks even though no added hunk reintroduces it).
      // This mirrors the literal + sensor layers, which already match on added lines, and tightens
      // the only layer that could hard-block on topical resemblance alone.
      const added = addedLinesFromDiff(scanDiff);
      const semanticQuery = added.trim().length > 0 ? added : scanDiff;
      const result = await mod.semanticSearch(ctx.paths, semanticQuery, { limit: input.limit * 2 });
      if (result) {
        const negativeIds = new Set(negative.map(({ memory }) => memory.frontmatter.id));
        for (const hit of result.hits) {
          if (!negativeIds.has(hit.id)) continue;
          if (hit.score < minSemanticScore && !seen.has(hit.id)) continue;
          const found = negative.find(({ memory }) => memory.frontmatter.id === hit.id);
          if (found) upsert(found.memory.frontmatter, found.memory.body, "semantic", hit.score);
        }
      }
    } catch {
      // Semantic is an optional enhancement here: not installed, or installed but its runtime
      // failed to load — either way the anchor + literal + sensor layers above already ran.
    }
  }

  // Rank: anchor > literal > semantic, then by confidence
  const warnings = [...seen.values()]
    .sort((a, b) => {
      const score = (w: AntiPatternsWarning): number => {
        const reasonW =
          (w.reasons.includes("sensor") ? 8 : 0) +
          (w.reasons.includes("anchor") ? 4 : 0) +
          (w.reasons.includes("literal") ? 2 : 0) +
          (w.reasons.includes("semantic") ? 1 : 0);
        const confW =
          w.confidence === "authoritative" ? 3 :
          w.confidence === "trusted" ? 2 :
          w.confidence === "low" ? 1 : 0;
        return reasonW + confW + (w.semantic_score ?? 0);
      };
      return score(b) - score(a);
    })
    .slice(0, input.limit);

  // OUTCOME measurement: record as prevention ONLY catches that would actually HARD-BLOCK a diff —
  // never the mere re-surfacing of an anchored note. A prevention event is a measured claim ("a known
  // mistake was intercepted before it landed"); if it's cheap to trigger, the dashboard / gate-precision
  // / proof-line inflate on noise (the "485 repeats blocked" that was really one note matching every
  // package.json commit). SENSOR-ONLY, mirroring the gate (classifyWarning): a deterministic sensor
  // firing is the single hard-block path — sensor-less semantic matches (even ≥ 0.75) no longer block
  // because cosine scores vary across environments, so counting them as "prevented" would claim an
  // outcome the gate no longer produces. Anchor/literal/semantic matches still SURFACE for review;
  // they just aren't counted as prevented outcomes. Debounced via recordPrevention.
  const isHardBlockCatch = (w: { reasons: string[] }): boolean => w.reasons.includes("sensor");
  const strongCatches = warnings.filter(isHardBlockCatch);
  // THE shared recorder — same path the git-hook gate and `hivelore sensors check` use (debounced).
  if (input.track !== false) {
    await recordPreventionHits(ctx.paths, strongCatches.map((w) => w.id), "anti-pattern");
  }

  return {
    scanned: negative.length,
    warnings,
    ...(notice ? { notice } : {}),
  };
}
