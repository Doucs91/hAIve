/**
 * Did the tagged releases actually reach the registry?
 *
 * `enforce finish` verified commit, version, tag, push and CI — the whole release chain except its
 * last link. Three consecutive releases sat tagged and green while npm stayed several versions
 * behind, because the publish workflow SKIPS (rather than fails) when its token is absent. Nothing
 * reported it: green CI on an unpublished release looks exactly like a shipped one.
 *
 * The severity split is the whole design. `finish` runs BEFORE you publish, so "HEAD's version is
 * not on the registry yet" is the NORMAL state and can only ever be informational — a gate that
 * cannot pass in the normal flow is a gate people switch off. What is a real defect is an
 * INTERMEDIATE tagged version the registry skipped: it was tagged, so it was meant to ship, and it
 * silently never did.
 *
 * Pure: the registry lookup and the tag listing happen in the caller.
 */

export type NpmPublicationCode =
  | "npm-published"
  | "npm-publish-pending"
  | "npm-releases-skipped"
  | "npm-publication-unverified";

export interface NpmPublicationInput {
  packageName: string;
  /** Version in the working tree (the lockstep version). */
  localVersion: string;
  /** Latest version on the registry, or null when it could not be reached. */
  publishedVersion: string | null;
  /** Tagged versions strictly between `publishedVersion` and `localVersion`. */
  taggedBetween: readonly string[];
  /** How to publish, injected so core stays free of tooling opinions. */
  publishHint?: string;
}

export interface NpmPublicationVerdict {
  code: NpmPublicationCode;
  severity: "ok" | "info" | "warn";
  message: string;
  fix?: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function classifyNpmPublication(input: NpmPublicationInput): NpmPublicationVerdict {
  const { packageName, localVersion, publishedVersion } = input;
  const hint = input.publishHint ?? `publish ${packageName} ${localVersion}`;

  if (!publishedVersion) {
    return {
      code: "npm-publication-unverified",
      severity: "info",
      message: `Could not reach the registry to check whether ${packageName} ${localVersion} is published.`,
    };
  }

  if (compareVersions(publishedVersion, localVersion) >= 0) {
    return {
      code: "npm-published",
      severity: "ok",
      message: `${packageName} ${publishedVersion} is on npm.`,
    };
  }

  const skipped = [...input.taggedBetween].sort(compareVersions);
  if (skipped.length > 0) {
    return {
      code: "npm-releases-skipped",
      severity: "warn",
      message:
        `${skipped.length} tagged release(s) never reached npm — ${packageName} is on ` +
        `${publishedVersion}: ${skipped.map((v) => `v${v}`).join(", ")}.`,
      fix:
        `Registry versions are not cumulative, so publishing the newest is enough: ${hint}. ` +
        "If the release workflow keeps skipping, its publish credentials are missing.",
    };
  }

  return {
    code: "npm-publish-pending",
    severity: "info",
    message:
      `${packageName} ${localVersion} is not on npm yet (registry has ${publishedVersion}) — ` +
      "expected at this point; publish is the next step.",
    fix: hint,
  };
}
