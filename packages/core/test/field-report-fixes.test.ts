import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  explainSensorRejection,
  judgeProposedSensor,
  loadCodeMap,
  recordGateReminder,
  renderPreventionComment,
  saveCodeMap,
  serializeCodeMap,
  shouldExpandGateReminder,
  resolveHaivePaths,
  buildFrontmatter,
  parseMemory,
  serializeMemory,
  type CodeMap,
  type HaivePaths,
  type PreventionReceipt,
} from "../src/index.js";

/**
 * Regressions for the defects a v0.54.0 field report reproduced on two real repositories.
 * Each block names the observed symptom it exists to prevent.
 */

function fakeCodeMap(root: string, files: Record<string, unknown> = {}): CodeMap {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    root,
    files: files as CodeMap["files"],
  };
}

const ENTRY = { exports: [{ name: "a", kind: "const" as const, line: 1 }], loc: 3 };

describe("code-map is versionable (§3.7: 528 KB rewritten on every sync, with an absolute path)", () => {
  let dir: string;
  let paths: HaivePaths;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hivelore-codemap-"));
    paths = resolveHaivePaths(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never serializes the absolute root or a per-run timestamp", async () => {
    await saveCodeMap(paths, fakeCodeMap(dir, { "src/a.ts": ENTRY }));
    const raw = await readFile(path.join(dir, ".ai", "code-map.json"), "utf8");
    // The absolute root was one developer's home directory; no two machines could agree on it.
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain("generated_at");
    expect(raw).not.toContain('"root"');
  });

  it("produces identical bytes for the same tree on two different machines", () => {
    const machineA = fakeCodeMap("/home/alice/proj", { "src/b.ts": ENTRY, "src/a.ts": ENTRY });
    const machineB = fakeCodeMap("/Users/bob/work/proj", { "src/a.ts": ENTRY, "src/b.ts": ENTRY });
    // Different roots, different key insertion order, same source tree → same file.
    expect(serializeCodeMap(machineA)).toBe(serializeCodeMap(machineB));
  });

  it("does not rewrite the file when nothing changed (no diff, so no conflict on pull)", async () => {
    const file = path.join(dir, ".ai", "code-map.json");
    await saveCodeMap(paths, fakeCodeMap(dir, { "src/a.ts": ENTRY }));
    const first = await readFile(file, "utf8");
    await writeFile(file, first, "utf8");

    await saveCodeMap(paths, fakeCodeMap(dir, { "src/a.ts": ENTRY }));
    expect(await readFile(file, "utf8")).toBe(first);

    // A real change still lands.
    await saveCodeMap(paths, fakeCodeMap(dir, { "src/a.ts": ENTRY, "src/c.ts": ENTRY }));
    expect(await readFile(file, "utf8")).not.toBe(first);
  });

  it("still hands consumers a root and a generated_at, so staleness checks keep working", async () => {
    await saveCodeMap(paths, fakeCodeMap(dir, { "src/a.ts": ENTRY }));
    const loaded = await loadCodeMap(paths);
    expect(loaded?.root).toBe(dir);
    expect(Date.parse(loaded!.generated_at)).toBeGreaterThan(0);
  });
});

describe("block-sensor bootstrap guidance (§3.9: refusal never explained the way out)", () => {
  const firesOnCurrent = judgeProposedSensor(
    {
      kind: "regex",
      pattern: "moment\\(",
      message: "use date-fns",
      severity: "block",
      autogen: false,
      last_fired: null,
    },
    { currentTargets: [{ path: "src/a.ts", content: "moment()\n" }], badExamples: ["moment()"] },
  );

  it("rejects a block sensor while the faulty pattern is still in the tree", () => {
    expect(firesOnCurrent.accepted).toBe(false);
    expect(firesOnCurrent.reason).toBe("fires-on-current");
  });

  it("names BOTH causes and spells out the warn-first path, with the memory id filled in", () => {
    const guidance = explainSensorRejection(firesOnCurrent, { style: "cli", memoryId: "2026-01-01-gotcha-x" });
    // Cause 1: the code is not fixed yet — the case the old message never mentioned.
    expect(guidance).toContain("STILL PRESENT");
    expect(guidance).toContain('severity warn');
    expect(guidance).toContain("2026-01-01-gotcha-x");
    // Cause 2: the pattern is too broad — the only one the old message covered.
    expect(guidance).toContain("absent");
    // And it says where it fired, so the author can check.
    expect(guidance).toContain("src/a.ts");
  });

  it("uses the tool call, not the shell command, when the caller is the MCP surface", () => {
    const guidance = explainSensorRejection(firesOnCurrent, { style: "mcp", memoryId: "m1" });
    expect(guidance).toContain("propose_sensor(");
    expect(guidance).not.toContain("hivelore sensors propose");
  });
});

describe("gate reminders stop repeating (§3.8: six lines on every commit)", () => {
  let dir: string;
  let paths: HaivePaths;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hivelore-reminder-"));
    paths = resolveHaivePaths(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("expands once, stays quiet inside the window, then expands again after it", async () => {
    const t0 = Date.parse("2026-08-20T09:00:00.000Z");
    expect(await shouldExpandGateReminder(paths, "bootstrap-incomplete", t0)).toBe(true);
    await recordGateReminder(paths, "bootstrap-incomplete", t0);

    const sameDay = t0 + 3 * 60 * 60 * 1000;
    expect(await shouldExpandGateReminder(paths, "bootstrap-incomplete", sameDay)).toBe(false);

    const nextDay = t0 + 25 * 60 * 60 * 1000;
    expect(await shouldExpandGateReminder(paths, "bootstrap-incomplete", nextDay)).toBe(true);
  });

  it("tracks each reminder separately", async () => {
    const t0 = Date.now();
    await recordGateReminder(paths, "bootstrap-incomplete", t0);
    expect(await shouldExpandGateReminder(paths, "briefing-missing", t0)).toBe(true);
  });
});

describe("prevention comment (§3.1: built by the CLI, not by jq inside YAML)", () => {
  const receipt: PreventionReceipt = {
    generated_at: "2026-08-20T00:00:00.000Z",
    since: "2026-08-13T00:00:00.000Z",
    window_days: 7,
    total: 0,
    previous_total: 0,
    prevented_count_total: 0,
    by_evidence: { proven: 0, incident: 0, documented: 0 },
    trend: { current: 0, previous: 0, direction: "flat" } as PreventionReceipt["trend"],
    events: [],
  };

  it("says plainly when nothing fired", () => {
    const body = renderPreventionComment(receipt, []);
    expect(body).toContain("<!-- haive:prevention-receipt -->");
    expect(body).toContain("No documented sensor fired on this PR.");
  });

  it("names the memory, the file and the offending line — not a score", () => {
    const body = renderPreventionComment(receipt, [
      {
        code: "sensor-block",
        message: "Use date-fns, not moment.",
        memory_ids: ["2026-01-01-gotcha-moment"],
        file: "src/date.ts",
        matched_line: "const d = moment();",
      },
      { code: "briefing-missing", message: "no briefing" },
    ]);
    expect(body).toContain("2026-01-01-gotcha-moment");
    expect(body).toContain("src/date.ts");
    expect(body).toContain("const d = moment();");
    // Process findings are not preventions and must not pad the receipt.
    expect(body).not.toContain("no briefing");
  });
});

describe("lifecycle: applied | planned | abandoned (§3.3: nothing distinguished 'decided' from 'implemented')", () => {
  it("round-trips through buildFrontmatter → serialize → parse", () => {
    const fm = buildFrontmatter({ type: "decision", slug: "httponly-cookie", scope: "team", lifecycle: "planned" });
    expect(fm.lifecycle).toBe("planned");
    const round = parseMemory(serializeMemory({ frontmatter: fm, body: "# Decision\n\nMove refresh token to an httpOnly cookie." }));
    expect(round.frontmatter.lifecycle).toBe("planned");
  });

  it("defaults to undefined (treated as 'applied') and rejects an unknown value with a clear message", () => {
    const fm = buildFrontmatter({ type: "decision", slug: "x", scope: "team" });
    expect(fm.lifecycle).toBeUndefined();
    expect(() =>
      parseMemory(
        "---\nid: 2026-08-27-decision-y\ntype: decision\ncreated_at: 2026-08-27T10:00:00.000Z\nlifecycle: someday\n---\nbody",
      ),
    ).toThrow(/invalid lifecycle/i);
  });
});
