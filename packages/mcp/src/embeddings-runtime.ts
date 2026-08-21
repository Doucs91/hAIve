/**
 * One guarded entry point to the optional `@hivelore/embeddings` package.
 *
 * Every call site used to write its own `try { await import(...) } catch { return null }` — and every
 * one of them left the actual search OUTSIDE the try. That is where the work happens: importing the
 * package is cheap, but the first `semanticSearch` loads the transformers runtime and its native
 * deps. So a broken native install (`Cannot find module '../build/Release/sharp-linux-x64.node'`,
 * a common state after a Node major upgrade) did not degrade semantic ranking to lexical — it threw
 * straight out of `get_briefing`, killing the whole briefing. A user field report on v0.54.0 rated
 * briefing quality 30/100 and reported `--embed` failing while the package was installed; both are
 * this bug. Semantic ranking is an ENHANCEMENT, and an enhancement must never take the feature down.
 *
 * `runSemantic` covers the load AND the call, and tells the two failures apart so the message can be
 * honest: "not installed" and "installed but its runtime failed to load" need different fixes.
 */

export type EmbeddingsModule = typeof import("@hivelore/embeddings");

export type EmbeddingsFailure = {
  ok: false;
  /** `missing` = the package is not installed. `broken` = it is installed but failed to load or run. */
  reason: "missing" | "broken";
  detail: string;
  notice: string;
};

export type EmbeddingsResult<T> = { ok: true; value: T } | EmbeddingsFailure;

function firstLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split("\n")[0]!.trim();
}

/** True only when the missing module IS the optional package — not a dependency deeper down it. */
function isPackageAbsent(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  return firstLine(error).includes("@hivelore/embeddings");
}

function failure(error: unknown): EmbeddingsFailure {
  const detail = firstLine(error);
  if (isPackageAbsent(error)) {
    return {
      ok: false,
      reason: "missing",
      detail,
      notice:
        "@hivelore/embeddings is not installed, so ranking falls back to lexical matching. " +
        "Install it (`npm install -g @hivelore/embeddings`) and run `hivelore index memories`.",
    };
  }
  return {
    ok: false,
    reason: "broken",
    detail,
    notice:
      "@hivelore/embeddings is installed but its runtime failed to load, so ranking fell back to " +
      `lexical matching: ${detail}. Reinstall it for this Node version ` +
      "(`npm install -g @hivelore/embeddings`), then run `hivelore doctor`.",
  };
}

/**
 * Load the package and run `fn` against it, catching BOTH steps.
 * Returns a typed failure instead of throwing — callers degrade, they do not die.
 */
export async function runSemantic<T>(
  fn: (mod: EmbeddingsModule) => Promise<T>,
): Promise<EmbeddingsResult<T>> {
  try {
    const mod = await import("@hivelore/embeddings");
    return { ok: true, value: await fn(mod) };
  } catch (error) {
    return failure(error);
  }
}
