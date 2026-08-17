import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFrictionReport,
  formatFrictionIssue,
  frictionFingerprint,
  groupFriction,
  loadFrictionState,
  normalizeFrictionSummary,
  normalizeKind,
  readFrictionReports,
  resolveHaivePaths,
  setFrictionStatus,
  type HaivePaths,
} from "../src/index.js";

describe("friction journal", () => {
  let dir: string;
  let paths: HaivePaths;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hivelore-friction-"));
    paths = resolveHaivePaths(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a bug claim only when it carries a reproduction", () => {
    expect(normalizeKind("bug", "hivelore doctor")).toEqual({ kind: "bug" });
    expect(normalizeKind("bug", undefined)).toEqual({
      kind: "suggestion",
      downgraded_from: "bug",
    });
    expect(normalizeKind("bug", "   ")).toEqual({ kind: "suggestion", downgraded_from: "bug" });
    // Non-bug kinds never need evidence.
    expect(normalizeKind("suggestion", undefined)).toEqual({ kind: "suggestion" });
  });

  it("normalizes away machine-specific noise so repeats share a fingerprint", () => {
    const a = normalizeFrictionSummary("Failed at /home/sady/proj/src/a.ts line 1284");
    const b = normalizeFrictionSummary("failed at   /Users/other/work/src/a.ts line 97311");
    expect(a).toBe(b);
  });

  it("deduplicates repeats of the same friction and counts them", async () => {
    const input = {
      kind: "suggestion" as const,
      surface: "mem_save",
      summary: "dedup rejection message does not say which memory collided",
    };
    const first = await appendFrictionReport(paths, input);
    expect(first.already_reported).toBe(false);
    expect(first.occurrences).toBe(1);

    const second = await appendFrictionReport(paths, {
      ...input,
      summary: "Dedup   rejection message does not say which memory collided",
    });
    expect(second.already_reported).toBe(true);
    expect(second.occurrences).toBe(2);
    expect(second.report.fingerprint).toBe(first.report.fingerprint);

    // Both occurrences are kept on disk; grouping collapses them into one ranked row.
    expect(await readFrictionReports(paths)).toHaveLength(2);
    const groups = groupFriction(await readFrictionReports(paths));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.status).toBe("open");
  });

  it("files a repro-less bug as a suggestion, under a different fingerprint than a real bug", async () => {
    const result = await appendFrictionReport(paths, {
      kind: "bug",
      surface: "enforce check",
      summary: "gate blocks on a clean tree",
    });
    expect(result.report.kind).toBe("suggestion");
    expect(result.report.downgraded_from).toBe("bug");
    expect(result.report.fingerprint).not.toBe(
      frictionFingerprint({
        kind: "bug",
        surface: "enforce check",
        summary: "gate blocks on a clean tree",
      }),
    );
  });

  it("ranks by occurrence count, then recency", async () => {
    await appendFrictionReport(paths, { kind: "docs", surface: "a", summary: "one" });
    await appendFrictionReport(paths, { kind: "docs", surface: "b", summary: "two" });
    await appendFrictionReport(paths, { kind: "docs", surface: "b", summary: "two" });
    const groups = groupFriction(await readFrictionReports(paths));
    expect(groups.map((g) => g.surface)).toEqual(["b", "a"]);
    expect(groups[0]!.count).toBe(2);
  });

  it("hides an entry once a human has acted on it, and reports that back to the agent", async () => {
    const first = await appendFrictionReport(paths, {
      kind: "confusing",
      surface: "doctor",
      summary: "score of 0% with zero blocking findings",
    });
    await setFrictionStatus(paths, first.report.fingerprint, "submitted", "https://example.test/1");

    const groups = groupFriction(await readFrictionReports(paths), await loadFrictionState(paths));
    expect(groups[0]!.status).toBe("submitted");
    expect(groups[0]!.url).toBe("https://example.test/1");

    // An agent hitting it again is told it was already handled, so it stops re-reporting.
    const again = await appendFrictionReport(paths, {
      kind: "confusing",
      surface: "doctor",
      summary: "score of 0% with zero blocking findings",
    });
    expect(again.resolved_as?.status).toBe("submitted");
  });

  it("renders an issue that leads with the occurrence count", async () => {
    await appendFrictionReport(paths, {
      kind: "bug",
      surface: "sensors propose",
      summary: "rejects a valid pattern",
      expected: "accepted",
      observed: "fires-on-correct",
      repro: "hivelore sensors propose x --pattern y",
      version: "9.9.9",
    });
    const group = groupFriction(await readFrictionReports(paths))[0]!;
    const { title, body } = formatFrictionIssue(group);
    expect(title).toBe("[bug] sensors propose: rejects a valid pattern");
    expect(body).toContain("**Reported:** 1×");
    expect(body).toContain("**Version:** 9.9.9");
    expect(body).toContain("hivelore sensors propose x --pattern y");
  });

  it("returns an empty journal rather than throwing when nothing was ever recorded", async () => {
    expect(await readFrictionReports(paths)).toEqual([]);
    expect(await loadFrictionState(paths)).toEqual({});
    expect(groupFriction([])).toEqual([]);
  });
});
