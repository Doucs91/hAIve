import { describe, expect, it } from "vitest";
import { runSemantic } from "../src/embeddings-runtime.js";

/**
 * Semantic ranking is an ENHANCEMENT. When it is unavailable the briefing must fall back to lexical
 * ranking — it must never fail.
 *
 * Before v0.55.0 every call site wrapped only the dynamic `import()` in a try/catch and left the
 * `semanticSearch(...)` call outside it. The import is cheap; the search is where the transformers
 * runtime and its native dependencies actually load. So on a machine where those were broken (the
 * ordinary state after a Node major upgrade: `Cannot find module '../build/Release/sharp-...node'`)
 * the exception escaped and took the whole `get_briefing` call down with it. A v0.54.0 field report
 * scored briefing quality 30/100 and reported `--embed` failing while the package was installed.
 */
describe("runSemantic — the optional-enhancement contract", () => {
  it("returns the value when the work succeeds", async () => {
    const outcome = await runSemantic(async () => "ranked");
    expect(outcome).toEqual({ ok: true, value: "ranked" });
  });

  it("catches a failure raised INSIDE the search, not just at import time", async () => {
    const outcome = await runSemantic(async () => {
      const error = new Error("Cannot find module '../build/Release/sharp-linux-x64.node'");
      (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
      throw error;
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A broken native dep is NOT "the package is not installed" — telling the user to install
    // something they already have is what made this defect so hard to diagnose in the field.
    expect(outcome.reason).toBe("broken");
    expect(outcome.notice).toContain("installed but its runtime failed to load");
    expect(outcome.notice).toContain("sharp-linux-x64.node");
  });

  it("reports a genuinely absent package as missing, with the install command", async () => {
    const outcome = await runSemantic(async () => {
      const error = new Error("Cannot find package '@hivelore/embeddings' imported from /x/y.js");
      (error as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("missing");
    expect(outcome.notice).toContain("is not installed");
    expect(outcome.notice).toContain("npm install -g @hivelore/embeddings");
  });

  it("never throws, whatever the failure looks like", async () => {
    await expect(runSemantic(async () => { throw new Error("boom"); })).resolves.toMatchObject({ ok: false });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    await expect(runSemantic(async () => { throw "a string"; })).resolves.toMatchObject({ ok: false });
  });
});
