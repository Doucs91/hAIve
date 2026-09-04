import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHaivePaths, type HaivePaths } from "../src/paths.js";
import { loadPreventionEvents, recordPreventionHits } from "../src/prevention.js";
import { runSensors, sensorTargetsFromDiff } from "../src/sensors.js";
import { serializeMemory } from "../src/parser.js";
import { getUsage, loadUsageIndex } from "../src/usage.js";
import type { Memory, Sensor } from "../src/types.js";

/**
 * Regression guard for the harness loop's load-bearing joint: a documented lesson's sensor fires on a
 * known-bad diff → a prevention event is RECORDED. This leaked once — the installed git-hook gate
 * blocked the commit but never recorded the catch, so the "measure" leg of the loop silently
 * undercounted (see 2026-06-04 harness-positioning gotcha). These tests fail if it leaks again.
 */

function sensorMemory(): Memory {
  const sensor: Sensor = {
    kind: "regex",
    pattern: ":\\s*any\\b",
    paths: [],
    message: "Avoid `: any` — prefer `unknown` and narrow.",
    severity: "block",
    autogen: true,
    last_fired: null,
  };
  return {
    frontmatter: {
      id: "2026-06-04-convention-no-any",
      scope: "team",
      type: "convention",
      status: "validated",
      anchor: { paths: ["src/foo.ts"], symbols: [] },
      sensor,
      tags: [],
      created_at: "2026-06-04T00:00:00.000Z",
      expires_when: null,
      verified_at: null,
      stale_reason: null,
      related_ids: [],
      last_read_at: null,
      revision_count: 0,
      requires_human_approval: false,
    },
    body: "# No any\nPrefer unknown.",
  };
}

const BAD_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,1 +1,2 @@",
  " const x = 1;",
  "+const y: any = 2;",
  "",
].join("\n");

describe("recordPreventionHits — the shared gate recorder", () => {
  let workDir: string;
  let paths: HaivePaths;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-prevent-"));
    paths = resolveHaivePaths(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("records a prevention event AND bumps prevented_count when a sensor fires on a bad diff", async () => {
    // The exact composition the gate runs: targets from diff → runSensors → record fired ids.
    const targets = sensorTargetsFromDiff(BAD_DIFF);
    const hits = runSensors([sensorMemory()], targets);
    expect(hits.map((h) => h.memory_id)).toContain("2026-06-04-convention-no-any");

    const recorded = await recordPreventionHits(paths, hits.map((h) => h.memory_id), "sensor");
    expect(recorded).toEqual(["2026-06-04-convention-no-any"]);

    const usage = await loadUsageIndex(paths);
    expect(getUsage(usage, "2026-06-04-convention-no-any").prevented_count).toBe(1);

    const events = await loadPreventionEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "2026-06-04-convention-no-any", source: "sensor" });
  });

  it("debounces a repeat catch within the window (re-running the hook on the same diff can't inflate)", async () => {
    const ids = ["2026-06-04-convention-no-any"];
    const first = await recordPreventionHits(paths, ids, "sensor");
    expect(first).toHaveLength(1);

    // Same memory again immediately → debounced, no new count, no new event.
    const second = await recordPreventionHits(paths, ids, "sensor");
    expect(second).toHaveLength(0);

    const usage = await loadUsageIndex(paths);
    expect(getUsage(usage, "2026-06-04-convention-no-any").prevented_count).toBe(1);
    const events = await loadPreventionEvents(paths);
    expect(events).toHaveLength(1);
  });

  it("is a no-op for an empty fired-id list", async () => {
    expect(await recordPreventionHits(paths, [], "sensor")).toEqual([]);
    expect(await loadPreventionEvents(paths)).toEqual([]);
  });

  it("does NOT write last_fired into the git-tracked memory file (it runs inside the commit hook)", async () => {
    // Stamping a tracked file mid-commit dirtied the tree and broke `git checkout` (field report
    // 2026-09-02 §3.1). Proof of a catch lives in the gitignored cache instead — the file is untouched.
    const mem = sensorMemory();
    await mkdir(paths.teamDir, { recursive: true });
    const file = path.join(paths.teamDir, `${mem.frontmatter.id}.md`);
    const before = serializeMemory(mem);
    await writeFile(file, before, "utf8");

    const at = new Date("2026-08-29T12:00:00.000Z");
    const recorded = await recordPreventionHits(paths, [mem.frontmatter.id], "sensor", at);

    expect(recorded).toEqual([mem.frontmatter.id]); // the catch was still recorded (in usage.json)
    expect(await readFile(file, "utf8")).toBe(before); // …but the tracked file did not change
  });
});
