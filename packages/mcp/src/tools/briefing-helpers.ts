import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  classifyMemoryPriority as coreClassifyPriority,
  isGlobPath,
  pathsOverlap,
  priorityRank as corePriorityRank,
} from "@hivelore/core";
import type { LoadedMemory } from "@hivelore/core";
import { runSemantic } from "../embeddings-runtime.js";
import type { HaiveContext } from "../context.js";
import type {
  BriefingMemory,
  BriefingMemoryPriority,
  BriefingOutput,
  BriefingQuality,
} from "./briefing-types.js";

export function compactSummary(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed.length > 0) return trimmed.slice(0, 120);
  }
  return body.slice(0, 120);
}

/**
 * Map the MCP briefing's evidence into the shared core classifier. Behavior is identical to the old
 * inline logic — the single source of truth now lives in `@hivelore/core` so the CLI cannot drift.
 */
export function classifyMemoryPriority(
  memory: BriefingMemory,
  loaded: LoadedMemory | undefined,
  inputFiles: string[],
  inputSymbols: string[],
): BriefingMemoryPriority {
  const fm = loaded?.memory.frontmatter;
  const directAnchor = Boolean(
    fm && inputFiles.length > 0 &&
    fm.anchor.paths.some((p) => inputFiles.some((file) => pathsOverlap(p, file))),
  );
  const directSymbol = Boolean(
    fm && inputSymbols.length > 0 &&
    fm.anchor.symbols.some((sym) =>
      inputSymbols.some((wanted) => wanted.toLowerCase() === sym.toLowerCase()),
    ),
  );
  const semantic = memory.semantic_score ?? 0;

  return coreClassifyPriority({
    type: memory.type,
    tags: fm?.tags ?? memory.tags ?? [],
    requiresHumanApproval: Boolean(fm?.requires_human_approval),
    directAnchor,
    directSymbol,
    exactTaskMatch: memory.match_quality === "exact",
    strongSemantic: semantic >= 0.65,
    usefulSemantic: semantic >= 0.35,
    moduleOrDomainMatch: memory.reasons.includes("module") || memory.reasons.includes("domain"),
    tagTaskMatch: false, // MCP ranking doesn't use a separate tag-token signal
  });
}

export function priorityRank(priority: BriefingMemoryPriority): number {
  return corePriorityRank(priority);
}

export function classifyBriefingQuality(
  memories: BriefingMemory[],
  context: {
    isTemplateContext: boolean;
    autoContextGenerated: boolean;
    hasLastSession: boolean;
    searchMode: BriefingOutput["search_mode"];
    /** Whether the caller told us which files it is about to touch. */
    hasInputFiles?: boolean;
  },
): BriefingQuality {
  const mustRead = memories.filter((m) => m.priority === "must_read").length;
  const useful = memories.filter((m) => m.priority === "useful").length;
  const background = memories.filter((m) => m.priority === "background").length;
  const weakSemantic = memories.filter((m) =>
    m.reasons.length === 1 &&
    m.reasons.includes("semantic") &&
    (m.semantic_score ?? 0) > 0 &&
    (m.semantic_score ?? 0) < 0.35,
  ).length;
  const reasons: string[] = [];

  if (memories.length === 0) reasons.push("no memories matched the task or files");
  if (context.isTemplateContext && !context.autoContextGenerated) reasons.push("project context is still a template");
  if (!context.hasLastSession) reasons.push("no previous session recap");
  if (mustRead > 0) reasons.push(`${mustRead} must_read memor${mustRead === 1 ? "y" : "ies"} matched directly`);
  if (useful > 0) reasons.push(`${useful} useful memor${useful === 1 ? "y" : "ies"} matched`);
  if (background > useful + mustRead && background > 2) reasons.push(`${background} background memories dominate the result`);
  if (weakSemantic > 0) reasons.push(`${weakSemantic} weak semantic-only match${weakSemantic === 1 ? "" : "es"}`);
  if (context.searchMode === "literal_fallback") reasons.push("semantic index unavailable or empty; literal fallback used");
  // Anchor proximity is the STRONGEST ranking signal there is — a memory anchored to a file you are
  // about to edit goes straight to must_read, ahead of anything semantic. It is also the one signal
  // the caller can switch on, and it is unavailable when `files` is omitted. A briefing that came
  // back thin without it should say so rather than let the caller conclude the corpus is empty.
  if (context.hasInputFiles === false && mustRead === 0) {
    reasons.push(
      "no `files` were passed, so anchored memories could not be matched — pass the files you are " +
      "about to edit to surface the policy attached to them",
    );
  }

  if (memories.length === 0 || (mustRead === 0 && useful === 0)) {
    return { level: "thin", reasons };
  }
  // A direct must_read hit means the briefing is actionable even when background seeds
  // outnumber it — "noisy" as the headline verdict right after the corpus gained its first
  // anchored memories reads as a regression. Background domination stays in `reasons`.
  if (mustRead === 0 && background > useful && background > 2) {
    return { level: "noisy", reasons };
  }
  return { level: "strong", reasons };
}

export function explainWhySurfaced(
  memory: BriefingMemory,
  loaded: LoadedMemory | undefined,
  inputFiles: string[],
  inferredModules: string[],
): string[] {
  const why: string[] = [];
  const fm = loaded?.memory.frontmatter;
  if (memory.reasons.includes("anchor") && fm) {
    const matching = fm.anchor.paths.filter((p) =>
      inputFiles.length === 0 || inputFiles.some((file) => pathsOverlap(p, file)),
    );
    if (matching.length > 0) {
      const exact = matching.filter((p) =>
        !isGlobPath(p) && inputFiles.some((file) => p === file || pathsOverlap(p, file)),
      );
      const glob = matching.filter((p) => isGlobPath(p));
      if (exact.length > 0) {
        why.push(`Exact/file anchor match: ${exact.slice(0, 4).join(", ")}`);
      }
      if (glob.length > 0) {
        why.push(`Glob anchor match: ${glob.slice(0, 4).join(", ")}`);
      }
      if (exact.length === 0 && glob.length === 0) {
        why.push(`Anchored to touched path${matching.length === 1 ? "" : "s"}: ${matching.slice(0, 4).join(", ")}`);
      }
    } else if (fm.anchor.paths.length > 0) {
      why.push(`Pulled by related anchor: ${fm.anchor.paths.slice(0, 4).join(", ")}`);
    }
    if (fm.anchor.symbols.length > 0) {
      why.push(`Anchor symbol${fm.anchor.symbols.length === 1 ? "" : "s"}: ${fm.anchor.symbols.slice(0, 4).join(", ")}`);
    }
  }
  if (memory.reasons.includes("symbol") && fm) {
    why.push(`Explicit symbol match: ${fm.anchor.symbols.slice(0, 4).join(", ")}`);
  }
  if (memory.reasons.includes("module")) {
    const moduleHints = [
      ...(memory.module ? [memory.module] : []),
      ...memory.tags.filter((tag) => inferredModules.includes(tag)),
    ];
    const shown = moduleHints.length > 0 ? [...new Set(moduleHints)].join(", ") : inferredModules.join(", ");
    why.push(shown ? `Matched inferred module/tag: ${shown}` : "Matched inferred module context.");
  }
  if (memory.reasons.includes("domain")) {
    why.push("Matched inferred domain from the target file paths.");
  }
  if (memory.reasons.includes("semantic")) {
    const score = memory.semantic_score !== undefined
      ? ` score=${Math.round(memory.semantic_score * 100) / 100}`
      : "";
    why.push(`${memory.match_quality === "exact" ? "Literal task match" : "Semantic/task relevance"}${score}.`);
  }
  why.push(`Confidence: ${memory.confidence}; read ${memory.read_count} time${memory.read_count === 1 ? "" : "s"}.`);
  if (memory.type === "attempt") why.push("Failed-approach record; read before repeating the same path.");
  if (memory.type === "skill") why.push("Skill (reusable procedure/playbook) — follow the steps described when doing this type of task.");
  if (memory.status === "proposed" || memory.status === "draft") {
    why.push("Unvalidated record; use cautiously or ask a human before treating it as policy.");
  }
  return why;
}

/**
 * Semantic hits for the briefing, or null when semantic ranking is unavailable for ANY reason.
 *
 * Both the load and the search run inside `runSemantic`: the search is where the transformers
 * runtime is actually initialised, and letting it throw used to abort the entire `get_briefing`
 * call rather than fall back to lexical ranking. See `embeddings-runtime.ts`.
 */
export async function trySemanticHits(
  ctx: HaiveContext,
  task: string,
  limit: number,
): Promise<Array<{ id: string; score: number }> | null> {
  const outcome = await runSemantic((mod) => mod.semanticSearch(ctx.paths, task, { limit }));
  if (!outcome.ok || !outcome.value) return null;
  return outcome.value.hits.map((h) => ({ id: h.id, score: h.score }));
}

/** Same call, but surfacing WHY ranking degraded so the briefing can say so out loud. */
export async function trySemanticHitsWithNotice(
  ctx: HaiveContext,
  task: string,
  limit: number,
): Promise<{ hits: Array<{ id: string; score: number }> | null; notice?: string }> {
  const outcome = await runSemantic((mod) => mod.semanticSearch(ctx.paths, task, { limit }));
  if (!outcome.ok) return { hits: null, notice: outcome.notice };
  if (!outcome.value) return { hits: null };
  return { hits: outcome.value.hits.map((h) => ({ id: h.id, score: h.score })) };
}

export async function loadModuleContexts(
  ctx: HaiveContext,
  modules: string[],
): Promise<Array<{ name: string; content: string }>> {
  if (modules.length === 0) return [];
  if (!existsSync(ctx.paths.modulesContextDir)) return [];
  const available = new Set(
    (await readdir(ctx.paths.modulesContextDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
  const out: Array<{ name: string; content: string }> = [];
  for (const m of modules) {
    if (!available.has(m)) continue;
    const file = path.join(ctx.paths.modulesContextDir, m, "context.md");
    if (existsSync(file)) {
      out.push({ name: m, content: await readFile(file, "utf8") });
    }
  }
  return out;
}
