import { describe, expect, it } from "vitest";
import { compactAutoRecapBody, isAutoRecap, recapBriefingExcerpt } from "../src/recap.js";
import { isEnvWorkaroundMemory } from "../src/relevance.js";

describe("recapBriefingExcerpt (field report 2026-09-01 §5.6)", () => {
  const human = [
    "## Goal",
    "Ship the Stripe currency refactor.",
    "## Accomplished",
    "- Reworked minor-unit handling across 12 files",
    "- Wired the webhook signature check",
    "## Discoveries",
    "- Stripe stores amounts in minor units; a /100 was doubling the charge",
    "## Next steps",
    "- Backfill historical orders\n- Add a sensor for the /100 divisor",
  ].join("\n");

  it("keeps only the goal line and next steps — not the whole wall", () => {
    const out = recapBriefingExcerpt(human);
    expect(out).toContain("Ship the Stripe currency refactor.");
    expect(out).toContain("Next steps:");
    expect(out).toContain("Backfill historical orders");
    expect(out).not.toContain("Reworked minor-unit handling"); // accomplished dropped
    expect(out).not.toContain("doubling the charge"); // discoveries dropped
    expect(out.length).toBeLessThan(human.length);
  });

  it("still routes auto recaps through the auto compactor", () => {
    const auto = "## Goal\nAuto-captured session (168 tool calls)\n## Discoveries\nNo new memories saved this session.";
    expect(recapBriefingExcerpt(auto)).toBe(compactAutoRecapBody(auto));
  });

  it("returns a bounded body for a free-form recap with no sections", () => {
    expect(recapBriefingExcerpt("just some freeform prose")).toBe("just some freeform prose");
  });
});

describe("recap compaction", () => {
  const auto = [
    "## Goal",
    "Auto-captured session (168 tool calls)",
    "## Accomplished",
    "get_briefing ×3, mem_save ×2",
    "## Discoveries & surprises",
    "No new memories saved this session.",
  ].join("\n");

  it("detects auto-generated recaps", () => {
    expect(isAutoRecap(auto)).toBe(true);
    expect(isAutoRecap("## Goal\nFix the payment bug")).toBe(false);
  });

  it("leaves a human recap untouched", () => {
    const human = "## Goal\nShip v0.16\n## Discoveries\nThe gate double-counts markers.";
    expect(compactAutoRecapBody(human)).toBe(human);
  });

  it("compacts an auto recap with trivial discoveries to a one-liner", () => {
    const out = compactAutoRecapBody(auto);
    expect(out).toContain("Auto-captured session (168 tool calls)");
    expect(out).toContain("No notable discoveries");
    expect(out.length).toBeLessThan(auto.length + 200);
    expect(out).not.toContain("get_briefing ×3");
  });

  it("keeps real discoveries from an auto recap", () => {
    const withFindings = [
      "## Goal",
      "Auto-captured session (40 tool calls)",
      "## Discoveries & surprises",
      "⚠️ 3 failures detected — the build broke on a missing export.",
    ].join("\n");
    const out = compactAutoRecapBody(withFindings);
    expect(out).toContain("Discoveries:");
    expect(out).toContain("build broke");
  });
});

describe("isEnvWorkaroundMemory", () => {
  it("flags dev-environment workaround tags", () => {
    expect(isEnvWorkaroundMemory({ tags: ["npm", "install", "dev-workflow", "hotswap"] })).toBe(true);
    expect(isEnvWorkaroundMemory({ tags: ["hotswap"] })).toBe(true);
  });
  it("does not flag genuine policy memories", () => {
    expect(isEnvWorkaroundMemory({ tags: ["security", "payments"] })).toBe(false);
    expect(isEnvWorkaroundMemory({ tags: [] })).toBe(false);
    expect(isEnvWorkaroundMemory(null)).toBe(false);
  });
});
