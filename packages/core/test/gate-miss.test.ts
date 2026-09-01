import { describe, expect, it } from "vitest";
import {
  gatePassedShas,
  planGitWatch,
  proposeGateMissDrafts,
  type GitCommit,
  type SensorEvaluation,
} from "../src/index.js";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const revert: GitCommit = {
  sha: B,
  subject: 'Revert "break refunds"',
  body: `This reverts commit ${A}.`,
  files: ["src/refund.ts"],
};

describe("gate miss watch", () => {
  it("initializes at HEAD without scanning, then plans only the incremental range", () => {
    expect(planGitWatch(null, A)).toEqual({ action: "initialize", next: { last_scanned_sha: A } });
    expect(planGitWatch({ last_scanned_sha: A }, B)).toEqual({
      action: "scan", range: `${A}..${B}`, next: { last_scanned_sha: B },
    });
    expect(planGitWatch({ last_scanned_sha: B }, B).action).toBe("idle");
  });

  it("dedupes by reverted SHA and carries provenance", () => {
    const proposal = proposeGateMissDrafts([revert], new Set(), new Set())[0]!;
    expect(proposal.reverted_sha).toBe(A);
    expect(proposal.body).toContain(`Reverted SHA: ${A}`);
    expect(proposal.body).toContain(`Revert SHA: ${B}`);
    expect(proposal.paths).toEqual(["src/refund.ts"]);
    expect(proposeGateMissDrafts([revert], new Set([A]), new Set())).toEqual([]);
  });

  it("drops .ai/ paths and paths the revert deleted from anchor candidates — a draft anchored to a deleted file goes stale on the very next sync", () => {
    const messy: GitCommit = {
      ...revert,
      files: [".ai/code-map.json", ".ai/memories/team/x.md", "src/refund.ts", "src/fee.ts"],
    };
    const proposal = proposeGateMissDrafts([messy], new Set(), new Set(), {
      pathExists: (rel) => rel === "src/refund.ts", // src/fee.ts was deleted by the revert
    })[0]!;
    expect(proposal.paths).toEqual(["src/refund.ts"]);
  });

  it("emits an honest diff-miner directive as the seed, never a prose/subject-derived pattern", () => {
    const proposal = proposeGateMissDrafts([revert], new Set(), new Set())[0]!;
    const seedLine = proposal.body.split("\n").find((l) => l.startsWith("proposed_sensor_seed:"))!;
    expect(seedLine).toContain("sensors propose --from-fix");
    expect(seedLine).not.toMatch(/Subject\\?s?\*?:/);
    expect(seedLine).not.toContain("Reverted");
    expect(seedLine).not.toContain("re-attempting"); // the shared generated why_failed sentence
  });

  it("cross-references a synthetic gate-pass row and includes the sensor hint", () => {
    const row: SensorEvaluation = {
      at: "2026-07-03T00:00:00.000Z", memory_id: "__gate__", kind: "shell",
      stage: "ci", head_sha: A, scope_hash: "", outcome: "silent",
    };
    const passed = gatePassedShas([row]);
    const proposal = proposeGateMissDrafts([revert], new Set(), passed)[0]!;
    expect(proposal.gate_passed).toBe(true);
    expect(proposal.body).toContain("The gate PASSED this commit");
    expect(proposal.body).toContain("proposed_sensor_seed:");
  });
});
