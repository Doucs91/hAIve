import { z } from "zod";
import { loadCodeMap } from "@hivelore/core";
import { runSemantic } from "../embeddings-runtime.js";
import type { HaiveContext } from "../context.js";

export const CodeSearchInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language description of what you are looking for in the codebase " +
      "(e.g. 'function that hashes passwords', 'JWT signing logic', 'route registration').",
    ),
  k: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(5)
    .describe("Number of top hits to return."),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe(
      "Minimum cosine similarity. Hits below this threshold are dropped to avoid noise. " +
      "Try 0.3+ for stricter matching.",
    ),
};

export type CodeSearchInput = {
  [K in keyof typeof CodeSearchInputSchema]: z.infer<(typeof CodeSearchInputSchema)[K]>;
};

export interface CodeSearchHit {
  file: string;
  name: string;
  kind: string;
  line: number;
  description?: string;
  score: number;
}

export interface CodeSearchOutput {
  available: boolean;
  hits: CodeSearchHit[];
  /** True when the embeddings index was built from an older code-map — results may miss new/moved symbols. */
  stale?: true;
  notice?: string;
}

export async function codeSearch(
  input: CodeSearchInput,
  ctx: HaiveContext,
): Promise<CodeSearchOutput> {
  // Load AND search inside one guard: the search is where the transformers runtime initialises, so
  // a broken native install threw out of the tool instead of reporting `available: false`.
  const outcome = await runSemantic(async (mod) => ({
    mod,
    result: await mod.codeSemanticSearch(ctx.paths, input.query, {
      limit: input.k,
      minScore: input.min_score,
    }),
  }));
  if (!outcome.ok) {
    return { available: false, hits: [], notice: `${outcome.notice} Then run \`hivelore index code-search\`.` };
  }
  const { mod, result } = outcome.value;

  if (!result) {
    return {
      available: false,
      hits: [],
      notice:
        "Code semantic-search index not built. Run `hivelore index code-search` to generate it " +
        "(builds embeddings for every exported symbol in the code-map).",
    };
  }

  // Flag (don't hide) a stale index: the code-map was rebuilt after the embeddings index, so newly
  // added or moved symbols may be missing/mislocated. Best-effort — never fail the search over this.
  let stale = false;
  try {
    const codeMap = await loadCodeMap(ctx.paths);
    if (codeMap) stale = mod.isCodeIndexStale(result.index.source_generated_at, codeMap.generated_at);
  } catch {
    // ignore — staleness is advisory
  }

  return {
    available: true,
    hits: result.hits,
    ...(stale
      ? {
          stale: true as const,
          notice:
            "Code-search index is stale (built from an older code-map); newly added or moved symbols " +
            "may be missing or mislocated. Rebuild with `hivelore index code && hivelore index code-search`.",
        }
      : {}),
  };
}
