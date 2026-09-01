import { describe, expect, it } from "vitest";
import { compactAutoRecapBody, isAutoRecap, recapBriefingExcerpt, buildRecapWithHistory } from "../src/recap.js";
import { isEnvWorkaroundMemory } from "../src/relevance.js";

describe("buildRecapWithHistory (field report 2026-09-01 §5.6)", () => {
  const mkRecap = (goal: string, next: string) =>
    `## Goal\n${goal}\n\n## Accomplished\n- did work\n\n## Next steps\n${next}`;

  it("returns the new body unchanged when there is no previous recap", () => {
    const body = mkRecap("Session A", "do X");
    expect(buildRecapWithHistory(body, null, null)).toBe(body);
  });

  it("archives the previous session into a bounded history without losing it", () => {
    const prev = mkRecap("Session A", "finish the refactor");
    const next = mkRecap("Session B", "write the tests");
    const out = buildRecapWithHistory(next, prev, "2026-08-30T10:00:00.000Z");
    // New session stays on top…
    expect(out.indexOf("Session B")).toBeLessThan(out.indexOf("## Session history"));
    // …and the previous one is preserved as a dated entry.
    expect(out).toContain("## Session history");
    expect(out).toContain("### 2026-08-30");
    expect(out).toContain("Session A");
    expect(out).toContain("finish the refactor");
    // The briefing excerpt still surfaces only the LATEST goal + next steps, not the history.
    const excerpt = recapBriefingExcerpt(out);
    expect(excerpt).toContain("Session B");
    expect(excerpt).toContain("write the tests");
    expect(excerpt).not.toContain("Session A");
  });

  it("caps history at maxEntries, dropping the oldest", () => {
    let body = mkRecap("goal01", "next01");
    for (let i = 2; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      body = buildRecapWithHistory(mkRecap(`goal${n}`, `next${n}`), body, `2026-08-${n}T00:00:00.000Z`, 3);
    }
    const entries = (body.match(/^### /gm) ?? []).length;
    expect(entries).toBe(3); // only the 3 most recent past sessions retained
    expect(body).toContain("next09"); // a recent past session is kept
    expect(body).not.toContain("next01"); // oldest dropped
  });
});

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
