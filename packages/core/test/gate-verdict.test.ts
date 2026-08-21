import { describe, expect, it } from "vitest";
import {
  buildBaselineHealthFinding,
  computeBaselineHealth,
  decideVerdict,
  dedupeRefusals,
  describePosture,
  resolveGatePolicy,
  type GateFinding,
  type GateStage,
} from "../src/index.js";

/**
 * The gate's decision rule, stated as tests.
 *
 * These run in milliseconds. The same coverage used to require spawning the CLI against real git
 * repositories in an 88-second integration file, which is why the rule accumulated three stacked
 * downgrade passes before anyone noticed: nobody iterates on logic they have to wait 88 seconds to
 * see. Behaviour that can be decided from inputs alone belongs here.
 */

const processFinding = (code: string, impact = 35): GateFinding => ({
  severity: "error",
  code,
  message: `${code} fired`,
  impact,
});

const sensorBlock = (memoryId: string, extra: Partial<GateFinding> = {}): GateFinding => ({
  severity: "error",
  code: "sensor-block",
  message: `Block sensor fired — ${memoryId}: use date-fns`,
  impact: 45,
  memory_ids: [memoryId],
  ...extra,
});

function verdictFor(findings: GateFinding[], opts: {
  stage?: GateStage;
  isAgent?: boolean;
  posture?: "advisory" | "balanced" | "strict";
  humanCommits?: "relaxed" | "strict";
} = {}) {
  return decideVerdict({
    findings,
    policy: resolveGatePolicy({ posture: opts.posture, humanCommits: opts.humanCommits }),
    stage: opts.stage ?? "pre-push",
    isAgent: opts.isAgent ?? true,
  });
}

describe("posture resolves the switches that decide whether anything refuses", () => {
  it("defaults to balanced: strict mode, advisory process gates", () => {
    const policy = resolveGatePolicy(undefined);
    expect(policy.posture).toBe("balanced");
    expect(policy.mode).toBe("strict");
    expect(policy.processGate).toBe("warn");
  });

  it("advisory refuses nothing at all; strict binds process gates", () => {
    expect(resolveGatePolicy({ posture: "advisory" }).mode).toBe("advisory");
    expect(resolveGatePolicy({ posture: "strict" }).processGate).toBe("block");
    expect(resolveGatePolicy({ posture: "strict" }).humanCommits).toBe("strict");
  });

  it("an explicit switch overrides the posture, and says so", () => {
    const policy = resolveGatePolicy({ posture: "strict", processGate: "warn" });
    expect(policy.processGate).toBe("warn");
    expect(policy.overrides).toEqual(["processGate"]);
    expect(describePosture(policy)).toContain("overridden: processGate");
  });
});

describe("process gates: one rule, stated once", () => {
  it("balanced — they report, they never refuse, and the message says why", () => {
    const verdict = verdictFor([processFinding("briefing-missing")]);
    const finding = verdict.findings[0]!;
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("processGate");
    expect(verdict.should_block).toBe(false);
  });

  it("strict — they refuse at a sharing point", () => {
    const verdict = verdictFor([processFinding("briefing-missing")], { posture: "strict" });
    expect(verdict.findings[0]!.severity).toBe("error");
    expect(verdict.should_block).toBe(true);
  });

  it("strict — they still never refuse a local commit, at any posture", () => {
    for (const stage of ["pre-commit", "local"] as const) {
      const verdict = verdictFor([processFinding("bootstrap-incomplete")], { posture: "strict", stage });
      expect(verdict.findings[0]!.severity, stage).toBe("warn");
      expect(verdict.process_gate_reason).toContain("commit time");
    }
  });

  it("strict + humanCommits relaxed — a human is not bound, an agent is", () => {
    const human = verdictFor([processFinding("briefing-missing")], {
      posture: "strict",
      humanCommits: "relaxed",
      isAgent: false,
    });
    expect(human.findings[0]!.severity).toBe("warn");
    expect(human.actor).toContain("human");

    const agent = verdictFor([processFinding("briefing-missing")], {
      posture: "strict",
      humanCommits: "relaxed",
      isAgent: true,
    });
    expect(agent.findings[0]!.severity).toBe("error");
  });

  it("CI binds everyone under strict, human or not", () => {
    const verdict = verdictFor([processFinding("briefing-missing")], {
      posture: "strict",
      humanCommits: "relaxed",
      isAgent: false,
      stage: "ci",
    });
    expect(verdict.findings[0]!.severity).toBe("error");
  });
});

describe("deterministic findings are what the gate spends refusals on", () => {
  it("a block sensor refuses at every posture that blocks at all", () => {
    for (const posture of ["balanced", "strict"] as const) {
      expect(verdictFor([sensorBlock("m1")], { posture }).should_block, posture).toBe(true);
    }
  });

  it("advisory posture reports the sensor and still refuses nothing", () => {
    const verdict = verdictFor([sensorBlock("m1")], { posture: "advisory" });
    expect(verdict.findings[0]!.severity).toBe("error");
    expect(verdict.should_block).toBe(false);
  });

  it("a sensor block is never downgraded, even when process gates are", () => {
    const verdict = verdictFor([sensorBlock("m1"), processFinding("briefing-missing")]);
    expect(verdict.findings.find((f) => f.code === "sensor-block")!.severity).toBe("error");
    expect(verdict.findings.find((f) => f.code === "briefing-missing")!.severity).toBe("warn");
  });
});

describe("one lesson is reported once", () => {
  it("collapses the anti-pattern matcher and the sensor runner onto one entry", () => {
    const refusals = dedupeRefusals([
      { severity: "error", code: "precommit-policy-block", message: "matched 1 anti-pattern", memory_ids: ["m1"] },
      sensorBlock("m1", { file: "src/date.ts", matched_line: "const d = moment();" }),
    ]);
    expect(refusals).toHaveLength(1);
    // Keeps the entry that names the offending line — the actionable one.
    expect(refusals[0]!.matched_line).toBe("const d = moment();");
  });

  it("keeps genuinely distinct lessons apart", () => {
    expect(dedupeRefusals([sensorBlock("m1"), sensorBlock("m2")])).toHaveLength(2);
  });

  it("never collapses findings that carry no memory id", () => {
    const anonymous: GateFinding = { severity: "error", code: "sensor-block", message: "a" };
    expect(dedupeRefusals([anonymous, { ...anonymous, message: "b" }])).toHaveLength(2);
  });
});

describe("baseline health measures the repo, not the change", () => {
  it("a block sensor does not move it — that is a verdict, not a health signal", () => {
    const clean = computeBaselineHealth([{ severity: "ok", code: "x", message: "" }], 80);
    const withSensor = computeBaselineHealth(
      [{ severity: "ok", code: "x", message: "" }, sensorBlock("m1")],
      80,
    );
    expect(withSensor.score).toBe(clean.score);
  });

  it("a cold knowledge layer does move it", () => {
    expect(computeBaselineHealth([processFinding("briefing-missing", 35)], 80).score).toBe(65);
  });

  it("is never emitted as a finding when something already refused", () => {
    const findings = [sensorBlock("m1"), processFinding("briefing-missing")];
    const health = computeBaselineHealth(findings, 80);
    expect(buildBaselineHealthFinding(findings, health, true)).toBeNull();
  });

  it("when emitted, it is a warning that names the gaps and says it does not block", () => {
    const findings = [{ ...processFinding("briefing-missing", 35), severity: "warn" as const }];
    const health = computeBaselineHealth(findings, 80);
    const finding = buildBaselineHealthFinding(findings, health, false)!;
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("briefing-missing");
    expect(finding.message).toContain("never blocks");
  });
});
