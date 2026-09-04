import { describe, expect, it } from "vitest";
import { classifyLockstepPublication, classifyNpmPublication } from "../src/index.js";

const base = { packageName: "@hivelore/cli", localVersion: "0.57.2", taggedBetween: [] as string[] };

/**
 * The release chain checked commit, version, tag, push and CI — everything except whether the
 * release actually shipped. Three consecutive versions sat tagged and green while the registry
 * stayed behind, because the publish workflow skips instead of failing when its token is missing.
 */
describe("classifyNpmPublication", () => {
  it("is satisfied when the registry has this version or newer", () => {
    expect(classifyNpmPublication({ ...base, publishedVersion: "0.57.2" }).severity).toBe("ok");
    // Someone published from elsewhere while you worked — not a defect.
    expect(classifyNpmPublication({ ...base, publishedVersion: "0.58.0" }).severity).toBe("ok");
  });

  it("treats HEAD not being published yet as INFORMATION, never a warning", () => {
    // `finish` runs BEFORE publishing. A gate that cannot pass in the normal flow gets switched off.
    const v = classifyNpmPublication({ ...base, publishedVersion: "0.57.1" });
    expect(v.severity).toBe("info");
    expect(v.code).toBe("npm-publish-pending");
  });

  it("WARNS about tagged versions the registry skipped — they were meant to ship", () => {
    const v = classifyNpmPublication({
      ...base,
      localVersion: "0.57.0",
      publishedVersion: "0.54.0",
      taggedBetween: ["0.56.0", "0.55.0"],
    });
    expect(v.severity).toBe("warn");
    expect(v.code).toBe("npm-releases-skipped");
    expect(v.message).toContain("v0.55.0, v0.56.0"); // sorted, not in input order
    expect(v.message).toContain("2 tagged release(s)");
  });

  it("tells the reader that publishing the newest is enough", () => {
    const v = classifyNpmPublication({
      ...base,
      publishedVersion: "0.54.0",
      taggedBetween: ["0.55.0"],
      publishHint: "run the release workflow",
    });
    expect(v.fix).toContain("not cumulative");
    expect(v.fix).toContain("run the release workflow");
  });

  it("reports an unreachable registry as unknown, never as a failure", () => {
    const v = classifyNpmPublication({ ...base, publishedVersion: null });
    expect(v.severity).toBe("info");
    expect(v.code).toBe("npm-publication-unverified");
  });

  it("never returns an error severity — publishing is the human's call", () => {
    const cases = ["0.57.2", "0.57.1", "0.10.0", null];
    for (const published of cases) {
      const v = classifyNpmPublication({ ...base, publishedVersion: published, taggedBetween: ["0.57.0"] });
      expect(["ok", "info", "warn"]).toContain(v.severity);
    }
  });
});

describe("classifyLockstepPublication", () => {
  const lockstep = (published: Record<string, string | null>, taggedBetween: string[] = []) => ({
    localVersion: "0.60.0",
    packages: Object.entries(published).map(([packageName, publishedVersion]) => ({
      packageName,
      publishedVersion,
      taggedBetween,
    })),
  });

  it("warns on a PARTIAL publish — the state that actually breaks installs", () => {
    // The real 0.60.0 incident: core/cli/embeddings shipped, @hivelore/mcp did not. Because cli pins
    // its siblings exactly, `npm i -g @hivelore/cli` failed for everyone with ETARGET, while the
    // single-package check reported a bland "publish is the next step" about core.
    const v = classifyLockstepPublication(lockstep({
      "@hivelore/core": "0.60.0",
      "@hivelore/cli": "0.60.0",
      "@hivelore/embeddings": "0.60.0",
      "@hivelore/mcp": "0.59.0",
    }));
    expect(v.code).toBe("npm-publication-incoherent");
    expect(v.severity).toBe("warn");
    expect(v.message).toContain("@hivelore/mcp (0.59.0)");
    expect(v.message).not.toContain("@hivelore/core (");
    expect(v.fix).toContain("credentials");
  });

  it("stays informational when NOTHING is published yet — the normal state at finish time", () => {
    const v = classifyLockstepPublication(lockstep({
      "@hivelore/core": "0.59.0",
      "@hivelore/mcp": "0.59.0",
    }));
    expect(v.code).toBe("npm-publish-pending");
    expect(v.severity).toBe("info");
  });

  it("is ok once every package reached the lockstep version", () => {
    const v = classifyLockstepPublication(lockstep({
      "@hivelore/core": "0.60.0",
      "@hivelore/mcp": "0.60.0",
    }));
    expect(v.code).toBe("npm-published");
    expect(v.severity).toBe("ok");
  });

  it("treats a package published AHEAD of the local version as satisfied", () => {
    const v = classifyLockstepPublication(lockstep({
      "@hivelore/core": "0.61.0",
      "@hivelore/mcp": "0.60.0",
    }));
    expect(v.code).toBe("npm-published");
  });

  it("still reports tagged releases the registry skipped entirely", () => {
    const v = classifyLockstepPublication(lockstep(
      { "@hivelore/core": "0.57.0", "@hivelore/mcp": "0.57.0" },
      ["0.58.0", "0.59.0"],
    ));
    expect(v.code).toBe("npm-releases-skipped");
    expect(v.severity).toBe("warn");
    expect(v.message).toContain("v0.58.0");
  });

  it("reports an unreachable registry as unknown, and never returns an error severity", () => {
    const v = classifyLockstepPublication(lockstep({ "@hivelore/core": null, "@hivelore/mcp": null }));
    expect(v.code).toBe("npm-publication-unverified");
    expect(v.severity).toBe("info");
    // A package we could not reach must not be mistaken for one that is behind.
    const partial = classifyLockstepPublication(lockstep({ "@hivelore/core": "0.60.0", "@hivelore/mcp": null }));
    expect(partial.code).toBe("npm-published");
  });
});
