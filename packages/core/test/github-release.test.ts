import { describe, expect, it } from "vitest";
import { classifyGithubRelease } from "../src/index.js";

const base = { localVersion: "0.57.3", taggedVersions: ["0.57.1", "0.57.2", "0.57.3"] };

/**
 * The repo carried 190 version tags and zero GitHub Releases for four months. Nothing in the
 * release chain looked, because the chain stopped at "the tag is pushed and CI is green".
 */
describe("classifyGithubRelease", () => {
  it("is satisfied when this version, or a newer one, has a Release", () => {
    expect(classifyGithubRelease({ ...base, releasedVersions: ["0.57.3"] })?.severity).toBe("ok");
    // Someone released from elsewhere while you worked — not a defect.
    expect(classifyGithubRelease({ ...base, releasedVersions: ["0.58.0"] })?.severity).toBe("ok");
  });

  it("treats HEAD having no Release yet as INFORMATION, never a warning", () => {
    // `finish` runs BEFORE the Release is cut. A gate that cannot pass in the normal flow gets switched off.
    const v = classifyGithubRelease({ ...base, releasedVersions: ["0.57.2"] });
    expect(v?.severity).toBe("info");
    expect(v?.code).toBe("github-release-pending");
  });

  it("does NOT call pre-adoption tags skipped — a warning you cannot clear gets ignored", () => {
    // 189 tags predate the first Release. Backfilling them is not the ask, so it is not reported.
    const tags = Array.from({ length: 189 }, (_, i) => `0.${i + 1}.0`).concat("0.57.3");
    const v = classifyGithubRelease({
      localVersion: "0.57.3",
      taggedVersions: tags,
      releasedVersions: ["0.57.3"],
    });
    expect(v?.severity).toBe("ok");
  });

  it("WARNS about tags after the first Release that never became one", () => {
    const v = classifyGithubRelease({
      localVersion: "0.58.2",
      taggedVersions: ["0.20.0", "0.57.3", "0.58.0", "0.58.1", "0.58.2"],
      releasedVersions: ["0.57.3"],
    });
    expect(v?.severity).toBe("warn");
    expect(v?.code).toBe("github-releases-skipped");
    expect(v?.message).toContain("v0.58.0, v0.58.1");
    expect(v?.message).not.toContain("v0.20.0"); // predates the first Release
  });

  it("caps the listed gap so a long history cannot flood the report", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `0.58.${i}`).concat("0.57.3", "0.59.0");
    const v = classifyGithubRelease({
      localVersion: "0.59.0",
      taggedVersions: tags,
      releasedVersions: ["0.57.3"],
    });
    expect(v?.message).toContain("and 25 more");
    expect(v!.message.length).toBeLessThan(300);
  });

  it("reports tags-but-no-Release once, as info, and points at the current version", () => {
    const v = classifyGithubRelease({ ...base, releasedVersions: [] });
    expect(v?.severity).toBe("info");
    expect(v?.code).toBe("github-releases-absent");
    expect(v?.message).toContain("3 version tag(s)");
    expect(v?.fix).toContain("Older tags stay as they are");
  });

  it("stays silent on a repo that has never tagged a version", () => {
    expect(classifyGithubRelease({ localVersion: "0.1.0", taggedVersions: [], releasedVersions: [] })).toBeNull();
  });

  it("reports an unreachable GitHub as unknown, never as a failure", () => {
    const v = classifyGithubRelease({ ...base, releasedVersions: null });
    expect(v?.severity).toBe("info");
    expect(v?.code).toBe("github-release-unverified");
  });

  it("never returns an error severity — releasing is the human's call", () => {
    const cases: (string[] | null)[] = [["0.57.3"], ["0.57.1"], [], null];
    for (const releasedVersions of cases) {
      const v = classifyGithubRelease({ ...base, releasedVersions });
      if (v) expect(["ok", "info", "warn"]).toContain(v.severity);
    }
  });
});
