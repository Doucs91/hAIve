import { describe, expect, it } from "vitest";
import { extractActionsBriefBody } from "../src/briefing-body.js";

describe("extractActionsBriefBody", () => {
  it("pulls bullets when present", () => {
    const md = `# Title\n\nIntro line.\n\n- Do **this** first\n- Then **that**\n- Finally check Z\n`;
    const out = extractActionsBriefBody(md, 400);
    expect(out).toContain("- Do **this** first");
    expect(out).toContain("- Then **that**");
    expect(out).not.toContain("Intro line.");
  });

  it("falls back to first paragraph when no bullets", () => {
    const md = `# H\n\nPlain paragraph explaining the trap without list syntax.`;
    const out = extractActionsBriefBody(md, 120);
    expect(out.toLowerCase()).toContain("plain paragraph");
  });

  it("keeps substance after a short prose accroche (field report 2026-09-01 §5.2)", () => {
    // A must-read memory opens with a one-line delivery accroche, then the actual content in prose.
    // Returning only the first paragraph truncated it to the accroche and dropped everything useful.
    const md = `Lot 8, livré le 2026-08-31. Dernier lot de la roadmap.\n\nAucune route ne supprime un avis. Suspendre doit révoquer les jetons de rafraîchissement.`;
    const out = extractActionsBriefBody(md, 600);
    expect(out).toContain("Lot 8");
    expect(out).toContain("révoquer les jetons");
  });
});
