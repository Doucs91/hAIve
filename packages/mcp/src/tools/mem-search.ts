import { existsSync } from "node:fs";
import {
  deriveConfidence,
  extractSnippet,
  getUsage,
  literalMatchesAllTokens,
  literalMatchesAnyToken,
  loadMemoriesFromDir,
  loadUsageIndex,
  pickSnippetNeedle,
  rankMemoriesLexical,
  tokenizeQuery,
  trackReads,
  type ConfidenceLevel,
  type LoadedMemory,
  type UsageIndex,
} from "@hivelore/core";
import { z } from "zod";
import { runSemantic } from "../embeddings-runtime.js";
import type { HaiveContext } from "../context.js";

export const MemSearchInputSchema = {
  query: z.string().describe("Substring matched against id, tags, and body"),
  scope: z
    .enum(["personal", "team", "module"])
    .optional()
    .describe("Restrict results to a single scope"),
  type: z
    .enum(["convention", "decision", "gotcha", "architecture", "glossary", "attempt", "session_recap"])
    .optional()
    .describe("Restrict results to a memory type. session_recap is excluded by default — use type='session_recap' to include them."),
  include_session_recap: z
    .boolean()
    .default(false)
    .describe("Include session_recap memories in search results (excluded by default — they surface in get_briefing as last_session)."),
  module: z.string().optional().describe("Restrict results to a module"),
  status: z
    .enum(["draft", "proposed", "validated", "deprecated", "stale", "rejected"])
    .optional()
    .describe("Filter by a single status. Omit to return all statuses."),
  exclude_rejected: z
    .boolean()
    .default(false)
    .describe("When true, exclude memories with status=rejected from results."),
  limit: z.number().int().positive().max(100).default(20).describe("Max results"),
  semantic: z
    .boolean()
    .default(false)
    .describe(
      "Use semantic similarity from the embeddings index (requires `hivelore embeddings index`).",
    ),
  lexical_rank: z
    .boolean()
    .default(false)
    .describe(
      "When true (and semantic is false), rank the filtered corpus with Okapi-BM25-style lexical scoring instead of literal AND/OR. Helps phrase-like queries without embeddings.",
    ),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Minimum cosine similarity (semantic mode only)"),
  track: z
    .boolean()
    .default(true)
    .describe("Increment read_count on returned memories (used for passive validation)"),
};

export type MemSearchInput = {
  [K in keyof typeof MemSearchInputSchema]: z.infer<(typeof MemSearchInputSchema)[K]>;
};

/** session_recap memories are surfaced separately via get_briefing.last_session — not in search results by default. */
function isSessionRecap(fm: { type: string }): boolean {
  return fm.type === "session_recap";
}

export interface MemSearchHit {
  id: string;
  scope: string;
  type: string;
  module?: string;
  tags: string[];
  status: string;
  confidence: ConfidenceLevel;
  read_count: number;
  snippet: string;
  file_path: string;
  score?: number;
}

export interface MemSearchOutput {
  matches: MemSearchHit[];
  total: number;
  mode: "literal" | "semantic" | "literal_fallback" | "lexical_ranked";
  notice?: string;
}

export async function memSearch(
  input: MemSearchInput,
  ctx: HaiveContext,
): Promise<MemSearchOutput> {
  if (!existsSync(ctx.paths.memoriesDir)) {
    return { matches: [], total: 0, mode: input.semantic ? "literal_fallback" : "literal" };
  }

  const all = await loadMemoriesFromDir(ctx.paths.memoriesDir);
  const filtered = all.filter(({ memory }) => passesFilters(memory.frontmatter, input));
  const usage = await loadUsageIndex(ctx.paths);

  let result: MemSearchOutput;
  if (input.semantic) {
    const semantic = await trySemanticSearch(ctx, input, filtered, usage);
    if (semantic) {
      result = semantic;
    } else {
      result = {
        ...buildLiteralResult(input, filtered, usage),
        mode: "literal_fallback",
        notice:
          "Semantic search unavailable (embeddings index missing or @hivelore/embeddings not installed). Falling back to literal search.",
      };
    }
  } else if (input.lexical_rank && input.query.trim()) {
    const { ranked, scores } = rankMemoriesLexical(
      filtered,
      input.query,
      input.limit,
    );
    if (ranked.length > 0) {
      const snippetNeedle = pickSnippetNeedle(input.query);
      result = {
        matches: ranked.map((loaded, i) =>
          lexicalHit(loaded, snippetNeedle, usage, scores[i]!),
        ),
        total: ranked.length,
        mode: "lexical_ranked",
      };
    } else {
      result = {
        ...buildLiteralResult(input, filtered, usage),
        notice: "Lexical ranking found no BM25-positive hits — showing literal matches instead.",
      };
    }
  } else {
    result = buildLiteralResult(input, filtered, usage);
  }

  if (input.track && result.matches.length > 0) {
    await trackReads(
      ctx.paths,
      result.matches.map((m) => m.id),
    );
  }

  return result;
}

function passesFilters(
  fm: LoadedMemory["memory"]["frontmatter"],
  input: MemSearchInput,
): boolean {
  if (input.scope && fm.scope !== input.scope) return false;
  if (input.type && fm.type !== input.type) return false;
  if (input.module && fm.module !== input.module) return false;
  if (input.status && fm.status !== input.status) return false;
  if (input.exclude_rejected && fm.status === "rejected") return false;
  // session_recap memories surface via get_briefing.last_session — exclude unless explicitly requested
  if (!input.include_session_recap && isSessionRecap(fm)) return false;
  return true;
}

function buildLiteralResult(
  input: MemSearchInput,
  filtered: LoadedMemory[],
  usage: UsageIndex,
): { matches: MemSearchHit[]; total: number; mode: "literal"; notice?: string } {
  const tokens = tokenizeQuery(input.query);
  const snippetNeedle = pickSnippetNeedle(input.query);

  let andMatched = filtered.filter(({ memory }) => literalMatchesAllTokens(memory, tokens));
  if (andMatched.length > 0) {
    const top = andMatched.slice(0, input.limit);
    return {
      matches: top.map((loaded) => toHit(loaded, snippetNeedle, usage)),
      total: andMatched.length,
      mode: "literal",
    };
  }

  // AND returned nothing — fall back to OR (any token)
  const orMatched = filtered.filter(({ memory }) => literalMatchesAnyToken(memory, tokens));
  const top = orMatched.slice(0, input.limit);
  return {
    matches: top.map((loaded) => toHit(loaded, snippetNeedle, usage)),
    total: orMatched.length,
    mode: "literal",
    notice: `No exact match for all tokens. Showing partial matches (OR fallback) — ${orMatched.length} result${orMatched.length === 1 ? "" : "s"}.`,
  };
}

async function trySemanticSearch(
  ctx: HaiveContext,
  input: MemSearchInput,
  filtered: LoadedMemory[],
  usage: UsageIndex,
): Promise<MemSearchOutput | null> {
  // The guard covers the search too, not just the import: the transformers runtime initialises on
  // first use, so a broken native install threw past the literal fallback this function exists for.
  const outcome = await runSemantic((mod) =>
    mod.semanticSearch(ctx.paths, input.query, {
      limit: Math.min(input.limit * 3, 100),
      minScore: input.min_score,
    }),
  );
  if (!outcome.ok || !outcome.value) return null;
  const result = outcome.value;

  const allowedIds = new Set(filtered.map((m) => m.memory.frontmatter.id));
  const byId = new Map(filtered.map((m) => [m.memory.frontmatter.id, m]));

  const ranked = result.hits
    .filter((h) => allowedIds.has(h.id))
    .slice(0, input.limit);

  const matches: MemSearchHit[] = ranked.map((hit) => {
    const loaded = byId.get(hit.id);
    if (!loaded) {
      return {
        id: hit.id,
        scope: "unknown",
        type: "unknown",
        tags: [],
        status: "unknown",
        confidence: "unverified" as const,
        read_count: 0,
        snippet: "",
        file_path: hit.file_path,
        score: hit.score,
      };
    }
    const base = toHit(loaded, input.query.toLowerCase(), usage);
    return { ...base, score: hit.score };
  });

  return {
    matches,
    total: ranked.length,
    mode: "semantic",
  };
}

function toHit(loaded: LoadedMemory, needle: string, usage: UsageIndex): MemSearchHit {
  const fm = loaded.memory.frontmatter;
  const u = getUsage(usage, fm.id);
  return {
    id: fm.id,
    scope: fm.scope,
    type: fm.type,
    ...(fm.module ? { module: fm.module } : {}),
    tags: fm.tags,
    status: fm.status,
    confidence: deriveConfidence(fm, u),
    read_count: u.read_count,
    snippet: extractSnippet(loaded.memory.body, needle),
    file_path: loaded.filePath,
  };
}

function lexicalHit(
  loaded: LoadedMemory,
  needle: string,
  usage: UsageIndex,
  lexicalScore: number,
): MemSearchHit {
  return { ...toHit(loaded, needle, usage), score: lexicalScore };
}
