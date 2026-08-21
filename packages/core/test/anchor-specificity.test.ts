import { describe, expect, it } from "vitest";
import {
  anchorSpecificity,
  auditAnchorSpecificity,
  churnForAnchors,
  classifyMemoryPriority,
  DEFAULT_SPECIFICITY,
  isWeakAnchor,
  prioritySignals,
} from "../src/index.js";

/**
 * Measured on this repository: `package.json` is touched by 106 of 149 sampled commits (71%), and
 * the memories anchored to it declared themselves `must_read` on every release commit. ~34 memories
 * claimed the top rank at once while the briefing had 8 slots.
 */
const CHURN = new Map<string, number>([
  ["package.json", 106],
  ["packages/cli/package.json", 106],
  ["CHANGELOG.md", 86],
  ["packages/core/src/sensors.ts", 12],
  ["packages/core/src/anchor-specificity.ts", 1],
  ["packages/cli/src/commands/enforce.ts", 40],
]);
const TOTAL = 149;

describe("anchorSpecificity", () => {
  it("scores a file every commit touches near zero", () => {
    expect(anchorSpecificity(["package.json"], CHURN, TOTAL)).toBeCloseTo(0.29, 2);
    expect(isWeakAnchor(anchorSpecificity(["package.json"], CHURN, TOTAL))).toBe(true);
  });

  it("scores a rarely-touched file near one", () => {
    const s = anchorSpecificity(["packages/core/src/anchor-specificity.ts"], CHURN, TOTAL);
    expect(s).toBeGreaterThan(0.99);
    expect(isWeakAnchor(s)).toBe(false);
  });

  it("takes the RAREST matching anchor — a memory is precise when its precise anchor is what changed", () => {
    const both = ["package.json", "packages/core/src/sensors.ts"];
    expect(anchorSpecificity(both, CHURN, TOTAL)).toBeCloseTo(0.92, 2);
    expect(isWeakAnchor(anchorSpecificity(both, CHURN, TOTAL))).toBe(false);
  });

  it("never penalises when churn cannot be measured — a repo without git ranks as before", () => {
    expect(anchorSpecificity(["whatever.ts"], CHURN, TOTAL)).toBe(DEFAULT_SPECIFICITY);
    expect(anchorSpecificity(["package.json"], CHURN, 0)).toBe(DEFAULT_SPECIFICITY);
    expect(anchorSpecificity([], CHURN, TOTAL)).toBe(DEFAULT_SPECIFICITY);
  });

  it("rolls a directory anchor up to the files under it", () => {
    const rolled = churnForAnchors(["packages/core/src/"], CHURN);
    expect(rolled.get("packages/core/src")).toBe(12);
  });
});

describe("priority: a weak anchor no longer claims the top rank on its own", () => {
  const anchored = (extra: Record<string, unknown> = {}) =>
    classifyMemoryPriority(prioritySignals({ type: "convention", directAnchor: true, ...extra }));

  it("a specific anchor is still must_read", () => {
    expect(anchored({ anchorSpecificity: 0.92 })).toBe("must_read");
    expect(anchored()).toBe("must_read"); // unknown specificity → unchanged behaviour
  });

  it("a weak anchor alone drops to useful — it still ranks, it just stops crowding", () => {
    expect(anchored({ anchorSpecificity: 0.29 })).toBe("useful");
  });

  it("a weak anchor corroborated by a strong semantic hit earns must_read back", () => {
    expect(anchored({ anchorSpecificity: 0.29, strongSemantic: true })).toBe("must_read");
    expect(anchored({ anchorSpecificity: 0.29, directSymbol: true })).toBe("must_read");
  });

  it("literal task overlap is NOT corroboration", () => {
    // `exactTaskMatch` is a literal AND-match over the whole memory body. On a task-shaped corpus it
    // fires on nearly everything: a "chore: bump version" commit marked every package.json lesson
    // `exact`, which promoted all of them straight back to must_read and defeated the check.
    expect(anchored({ anchorSpecificity: 0.29, exactTaskMatch: true })).toBe("useful");
  });
});

describe("auditAnchorSpecificity — the corpus-hygiene report", () => {
  const memories = [
    { id: "broad-1", anchorPaths: ["package.json"] },
    { id: "broad-2", anchorPaths: ["packages/cli/package.json", "CHANGELOG.md"] },
    { id: "precise", anchorPaths: ["packages/core/src/anchor-specificity.ts"] },
    { id: "mixed", anchorPaths: ["package.json", "packages/core/src/sensors.ts"] },
    { id: "unanchored", anchorPaths: [] },
  ];

  it("names only the memories that claim nearly every change", () => {
    const rows = auditAnchorSpecificity(memories, CHURN, TOTAL);
    expect(rows.map((r) => r.id)).toEqual(["broad-1", "broad-2"]);
  });

  it("reports which anchor makes each one broad, and how broad", () => {
    const [worst] = auditAnchorSpecificity(memories, CHURN, TOTAL);
    expect(worst!.broad[0]!.path).toBe("package.json");
    expect(Math.round(worst!.broad[0]!.ratio * 100)).toBe(71);
  });

  it("returns nothing when churn is unmeasurable, rather than guessing", () => {
    expect(auditAnchorSpecificity(memories, CHURN, 0)).toEqual([]);
    expect(auditAnchorSpecificity(memories, new Map(), TOTAL)).toEqual([]);
  });
});
