import { describe, expect, it } from "vitest";
import {
  generateBridges,
  prepareBridgeData,
  bridgeMemorySummary,
  BRIDGE_MARKERS,
  BRIDGE_TARGET_PATH,
  BRIDGE_TARGETS,
  type BridgeSensor,
  type Memory,
} from "../src/bridges.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory["frontmatter"]> & { body?: string } = {}): Memory {
  const { body = "## Summary\nThis is a validated decision.", ...fm } = overrides;
  return {
    frontmatter: {
      id: fm.id ?? "test-decision-2026-01-01",
      slug: fm.slug ?? "test-decision",
      name: fm.name ?? "Test Decision",
      description: fm.description ?? "A test decision",
      type: fm.type ?? "decision",
      scope: fm.scope ?? "team",
      status: fm.status ?? "validated",
      confidence: fm.confidence ?? "trusted",
      created_at: fm.created_at ?? "2026-01-01T00:00:00.000Z",
      tags: fm.tags ?? [],
      anchor: fm.anchor ?? { paths: [], symbols: [] },
      related_ids: fm.related_ids ?? [],
      revision_count: fm.revision_count ?? 0,
      sensor: fm.sensor,
      requires_human_approval: fm.requires_human_approval,
      module: fm.module,
      domain: fm.domain,
      topic: fm.topic,
      read_count: fm.read_count,
      stale_reason: fm.stale_reason,
      verified_at: fm.verified_at,
    },
    body,
  };
}

function makeSensor(overrides: Partial<BridgeSensor> = {}): BridgeSensor {
  return {
    id: "test-gotcha-2026-01-01",
    severity: "block",
    message: "Do not use the old API",
    pattern: "oldApi\\(",
    paths: [],
    ...overrides,
  };
}

const VALIDATED_MEMORY = makeMemory({
  id: "2026-01-01-decision-use-validated",
  body: "## Use the new API\nAlways prefer newApi() over oldApi().",
});
const PROPOSED_MEMORY = makeMemory({
  id: "2026-01-01-gotcha-proposed",
  status: "proposed",
  type: "gotcha",
  body: "## Watch out for race condition\nUse mutex when accessing shared state.",
});
const SESSION_RECAP = makeMemory({
  id: "2026-01-01-session-recap",
  type: "session_recap",
  body: "## Session recap\nFixed bug X.",
});
const STACK_PACK_SEED = makeMemory({
  id: "2026-01-01-stack-pack-seed",
  tags: ["stack-pack"],
  body: "## React best practices\nUse hooks.",
});

// ── bridgeMemorySummary ────────────────────────────────────────────────────

describe("bridgeMemorySummary", () => {
  it("extracts first non-empty line, strips markdown heading markers", () => {
    expect(bridgeMemorySummary("## My Title\nSome text")).toBe("My Title");
  });

  it("uses first non-heading line when heading is absent", () => {
    expect(bridgeMemorySummary("\nPlain text line")).toBe("Plain text line");
  });

  it("truncates at 140 characters", () => {
    const long = "A".repeat(200);
    const result = bridgeMemorySummary(long);
    expect(result.length).toBeLessThanOrEqual(140);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty body", () => {
    expect(bridgeMemorySummary("")).toBe("");
  });
});

// ── prepareBridgeData ──────────────────────────────────────────────────────

describe("prepareBridgeData", () => {
  it("excludes session_recap memories", () => {
    const { topMemories } = prepareBridgeData([SESSION_RECAP], []);
    expect(topMemories).toHaveLength(0);
  });

  it("excludes stack-pack seeds", () => {
    const { topMemories } = prepareBridgeData([STACK_PACK_SEED], []);
    expect(topMemories).toHaveLength(0);
  });

  it("excludes personal memories from committed native bridges", () => {
    const personal = makeMemory({
      id: "2026-01-01-attempt-personal",
      scope: "personal",
      type: "attempt",
      body: "## Local-only attempt\nDo not publish this breadcrumb.",
    });
    const { topMemories } = prepareBridgeData([personal, VALIDATED_MEMORY], []);
    expect(topMemories.map((m) => m.id)).toEqual([VALIDATED_MEMORY.frontmatter.id]);
  });

  it("includes validated and proposed memories", () => {
    const { topMemories } = prepareBridgeData([VALIDATED_MEMORY, PROPOSED_MEMORY], []);
    expect(topMemories).toHaveLength(2);
  });

  it("sorts validated before proposed", () => {
    const { topMemories } = prepareBridgeData([PROPOSED_MEMORY, VALIDATED_MEMORY], []);
    expect(topMemories[0]?.id).toBe(VALIDATED_MEMORY.frontmatter.id);
  });

  it("ranks by value (attempts, then decisions/architecture, then recent-first) — not by filename (§1)", () => {
    // Field report 2026-09-04 §1: the breadcrumb was `ls | sort | head`, surfacing the 8 OLDEST and
    // burying recent decisions and every `attempt`. A newer attempt must beat an older convention.
    const oldConvention = makeMemory({ id: "2026-08-01-convention-old", type: "convention", body: "## Old\nx" });
    const oldDecision = makeMemory({ id: "2026-08-02-decision-old", type: "decision", body: "## Old decision\nx" });
    const newDecision = makeMemory({ id: "2026-09-04-decision-new", type: "decision", body: "## New decision\nx" });
    const attempt = makeMemory({ id: "2026-08-30-attempt-deadend", type: "attempt", body: "## Dead end\nDo not retry X." });
    const { topMemories } = prepareBridgeData([oldConvention, oldDecision, newDecision, attempt], []);
    expect(topMemories[0]?.id).toBe(attempt.frontmatter.id); // preventive first
    expect(topMemories[1]?.id).toBe(newDecision.frontmatter.id); // recent decision before old one
    expect(topMemories[2]?.id).toBe(oldDecision.frontmatter.id);
    expect(topMemories[3]?.id).toBe(oldConvention.frontmatter.id); // plain convention last
  });

  it("respects maxMemories cap", () => {
    const mems = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `mem-${i}`, slug: `mem-${i}` }),
    );
    const { topMemories } = prepareBridgeData(mems, [], { maxMemories: 3 });
    expect(topMemories).toHaveLength(3);
  });

  it("only returns block sensors, not warn sensors", () => {
    const warnSensor = makeSensor({ severity: "warn", id: "warn-sensor" });
    const blockSensor = makeSensor({ severity: "block", id: "block-sensor" });
    const { blockSensors } = prepareBridgeData([], [warnSensor, blockSensor]);
    expect(blockSensors).toHaveLength(1);
    expect(blockSensors[0]?.id).toBe("block-sensor");
  });
});

// ── generateBridges ────────────────────────────────────────────────────────

describe("generateBridges", () => {
  const memories = [VALIDATED_MEMORY, PROPOSED_MEMORY];
  const sensors = [makeSensor()];

  it("generates all targets when no opts", () => {
    const outputs = generateBridges(memories, sensors);
    expect(outputs).toHaveLength(BRIDGE_TARGETS.length);
  });

  it("generates only specified targets", () => {
    const outputs = generateBridges(memories, sensors, { targets: ["cline", "windsurf"] });
    expect(outputs).toHaveLength(2);
    expect(outputs.map((o) => o.target)).toEqual(["cline", "windsurf"]);
  });

  it("injects the sensor's corrective instruction, not its regex (§1.1)", () => {
    const [out] = generateBridges(memories, [makeSensor({ message: "Use the token, not a hardcoded colour", pattern: "bg-\\w+-\\d{3}" })], { targets: ["claude"] });
    expect(out?.content).toContain("Use the token, not a hardcoded colour");
    expect(out?.content).not.toContain("Pattern:");
    expect(out?.content).not.toContain("bg-\\w+-\\d{3}");
  });

  it("supports the reach targets (cursor, claude, roo, gemini, aider)", () => {
    for (const target of ["cursor", "claude", "roo", "gemini", "aider"] as const) {
      const [out] = generateBridges(memories, sensors, { targets: [target] });
      expect(out?.target).toBe(target);
      expect(out?.content).toContain(BRIDGE_MARKERS.memoriesStart);
    }
  });

  it("emits Cursor .mdc frontmatter (alwaysApply) outside the markers", () => {
    const [out] = generateBridges(memories, sensors, { targets: ["cursor"] });
    expect(out?.path).toBe(BRIDGE_TARGET_PATH.cursor);
    expect(out?.content.startsWith("---\n")).toBe(true);
    expect(out?.content).toContain("alwaysApply: true");
  });

  it("surfaces anchor paths inline (path-scoping awareness)", () => {
    const scoped = makeMemory({
      id: "2026-01-01-gotcha-scoped",
      type: "gotcha",
      anchor: { paths: ["src/pay.ts"], symbols: [] },
      body: "## Scoped lesson\nDo the thing.",
    });
    const [out] = generateBridges([scoped], [], { targets: ["agents"] });
    expect(out?.content).toContain("applies to: src/pay.ts");
  });

  it("uses correct path for each target", () => {
    const outputs = generateBridges(memories, sensors, { targets: ["cline"] });
    expect(outputs[0]?.path).toBe(BRIDGE_TARGET_PATH.cline);
  });

  it("each output contains memories markers", () => {
    const outputs = generateBridges(memories, sensors);
    for (const output of outputs) {
      expect(output.content).toContain(BRIDGE_MARKERS.bridgeStart);
      expect(output.content).toContain(BRIDGE_MARKERS.bridgeEnd);
      expect(output.content).toContain(BRIDGE_MARKERS.memoriesStart);
      expect(output.content).toContain(BRIDGE_MARKERS.memoriesEnd);
    }
  });

  it("each output contains sensors markers when block sensors exist", () => {
    const outputs = generateBridges(memories, sensors);
    for (const output of outputs) {
      expect(output.content).toContain(BRIDGE_MARKERS.sensorsStart);
      expect(output.content).toContain(BRIDGE_MARKERS.sensorsEnd);
    }
  });

  it("no sensors block when no block sensors", () => {
    const warnOnly = [makeSensor({ severity: "warn" })];
    const outputs = generateBridges(memories, warnOnly);
    for (const output of outputs) {
      expect(output.content).not.toContain(BRIDGE_MARKERS.sensorsStart);
    }
  });

  it("injects memory id and summary in content", () => {
    const outputs = generateBridges([VALIDATED_MEMORY], []);
    for (const output of outputs) {
      expect(output.content).toContain(VALIDATED_MEMORY.frontmatter.id);
    }
  });

  it("frames generated bridges as breadcrumb maps with quick drill-down guidance", () => {
    const [out] = generateBridges([VALIDATED_MEMORY], [], { targets: ["windsurf"] });
    expect(out?.content).toContain("small breadcrumb map");
    expect(out?.content).toContain('budget_preset:"quick"');
    expect(out?.content).toContain("Drill down only if needed");
    expect(out?.content).toContain("Top breadcrumbs only");
  });

  it("injects sensor message in block sensors section", () => {
    const outputs = generateBridges([], sensors);
    for (const output of outputs) {
      expect(output.content).toContain(sensors[0]!.message);
    }
  });

  it("does NOT inject the sensor regex — only its corrective instruction (§1.1)", () => {
    const outputs = generateBridges([], sensors);
    for (const output of outputs) {
      expect(output.content).toContain(sensors[0]!.message);
      expect(output.content).not.toContain(sensors[0]!.pattern!);
    }
  });

  // ── Per-target snapshots ──────────────────────────────────────────────────
  it.each(BRIDGE_TARGETS)("target %s snapshot", (target) => {
    const [output] = generateBridges([VALIDATED_MEMORY], [makeSensor()], { targets: [target] });
    expect(output?.content).toMatchSnapshot();
  });
});

// ── BRIDGE_TARGET_PATH completeness ───────────────────────────────────────

describe("BRIDGE_TARGET_PATH", () => {
  it("has an entry for every BRIDGE_TARGET", () => {
    for (const target of BRIDGE_TARGETS) {
      expect(BRIDGE_TARGET_PATH[target]).toBeTruthy();
    }
  });
});
