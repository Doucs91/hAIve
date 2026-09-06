import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveHaivePaths } from "../src/paths.js";
import { describeBriefingMarker, writeBriefingMarker, readRecentBriefingMarker } from "../src/enforcement.js";

describe("writeBriefingMarker accumulation", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "haive-marker-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("unions memory_ids across calls in the same session (default)", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "a", memoryIds: ["m1", "m2"] });
    await writeBriefingMarker(paths, { sessionId: "s1", source: "b", memoryIds: ["m3"] });
    const marker = await readRecentBriefingMarker(paths, "s1");
    expect(marker?.memory_ids?.sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("unions files too and dedupes", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "a", files: ["a.ts"], memoryIds: ["m1"] });
    await writeBriefingMarker(paths, { sessionId: "s1", source: "b", files: ["a.ts", "b.ts"], memoryIds: ["m1"] });
    const marker = await readRecentBriefingMarker(paths, "s1");
    expect(marker?.files?.sort()).toEqual(["a.ts", "b.ts"]);
    expect(marker?.memory_ids).toEqual(["m1"]);
  });

  it("replaces (does not accumulate) when accumulate=false", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "a", memoryIds: ["m1", "m2"] });
    await writeBriefingMarker(paths, { sessionId: "s1", source: "b", memoryIds: ["m3"], accumulate: false });
    const marker = await readRecentBriefingMarker(paths, "s1");
    expect(marker?.memory_ids).toEqual(["m3"]);
  });

  it("does not bleed across different sessions", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "a", memoryIds: ["m1"] });
    await writeBriefingMarker(paths, { sessionId: "s2", source: "a", memoryIds: ["m2"] });
    const s2 = await readRecentBriefingMarker(paths, "s2");
    expect(s2?.memory_ids).toEqual(["m2"]);
  });
});

describe("describeBriefingMarker — whose briefing, and how old", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "haive-marker-src-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports this session's own marker", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "get_briefing", memoryIds: ["m1"] });
    const status = await describeBriefingMarker(paths, "s1");
    expect(status.source).toBe("this-session");
    expect(status.marker?.memory_ids).toEqual(["m1"]);
    expect(status.age_ms).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes another session's marker instead of counting it as briefed", async () => {
    // The defect this exists for: an agent that never called get_briefing passed a strict
    // requireBriefingFirst gate eight times, on a marker left the previous night by another
    // session (field report 2026-09-05 §3).
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "yesterday", source: "get_briefing", memoryIds: ["m1"] });
    const status = await describeBriefingMarker(paths, "today");
    expect(status.source).toBe("other-session");
    expect(status.marker?.session_id).toBe("yesterday");
  });

  it("reports none when every marker is past the TTL", async () => {
    const paths = resolveHaivePaths(root);
    await writeBriefingMarker(paths, { sessionId: "s1", source: "get_briefing" });
    // A negative TTL expires a marker written this millisecond; `0` would leave the boundary
    // (now - created === 0) inside the window and make the test depend on clock resolution.
    const status = await describeBriefingMarker(paths, "s1", -1);
    expect(status.source).toBe("none");
    expect(status.marker).toBeNull();
  });
});
