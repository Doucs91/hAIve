/**
 * Did the tags that were meant to be releases become GitHub Releases?
 *
 * The npm check ([[npm-publication.ts]]) closed one end of the release chain. This closes the
 * other. They are not the same signal: npm is where the code is *installed from*, a GitHub Release
 * is where the version is *announced* — changelog, provenance, and the thing listing directories
 * and score checkers read to decide whether a project ships. This repo carried 190 version tags
 * and zero Releases, and the only reason anyone noticed was a third-party listing scoring it down.
 *
 * ## The pre-adoption rule is the whole design
 *
 * A repo that adopts Releases at version 0.57 has 189 older tags that were never going to be
 * Releases. Calling those "skipped" would mean a permanent warning that no action can ever clear,
 * and a warning you cannot clear is one people learn to scroll past. So only tags **newer than the
 * oldest Release** count: gaps that opened *after* the repo started releasing. Adopting the
 * practice retroactively cleans nothing, and is not asked to.
 *
 * Severities mirror the npm check exactly, and for the same reason — `finish` runs BEFORE you
 * publish, so "HEAD has no Release yet" is the normal state and can only be info. Never an error:
 * publishing is the human's call.
 *
 * Pure: listing tags and asking GitHub happen in the caller.
 */

import { compareVersions } from "./version-order.js";

export type GithubReleaseCode =
  | "github-release-published"
  | "github-release-pending"
  | "github-releases-skipped"
  | "github-releases-absent"
  | "github-release-unverified";

export interface GithubReleaseInput {
  /** Version in the working tree (the lockstep version). */
  localVersion: string;
  /**
   * Versions that have a published, non-draft GitHub Release. `null` means the lookup could not
   * run at all — no `gh`, no network, not a GitHub remote — which is "cannot tell", not a defect.
   */
  releasedVersions: readonly string[] | null;
  /** Every version tag in the repo, without the `v` prefix. */
  taggedVersions: readonly string[];
  /** How to create one, injected so core stays free of tooling opinions. */
  releaseHint?: string;
}

export interface GithubReleaseVerdict {
  code: GithubReleaseCode;
  severity: "ok" | "info" | "warn";
  message: string;
  fix?: string;
}

/** Enough of the gap to act on; the rest is a count, so 189 tags cannot flood the report. */
const MAX_LISTED = 5;

function listGap(versions: readonly string[]): string {
  const shown = versions.slice(0, MAX_LISTED).map((v) => `v${v}`).join(", ");
  const rest = versions.length - MAX_LISTED;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** `null` when there is nothing worth saying — an untagged repo has no release chain to check. */
export function classifyGithubRelease(input: GithubReleaseInput): GithubReleaseVerdict | null {
  const { localVersion, releasedVersions, taggedVersions } = input;
  const hint = input.releaseHint ?? `create a GitHub Release for v${localVersion}`;

  if (releasedVersions === null) {
    return {
      code: "github-release-unverified",
      severity: "info",
      message: `Could not check whether v${localVersion} has a GitHub Release.`,
    };
  }

  const tags = [...new Set(taggedVersions)].sort(compareVersions);
  if (releasedVersions.length === 0) {
    if (tags.length === 0) return null; // nothing tagged, nothing to release — stay silent
    return {
      code: "github-releases-absent",
      severity: "info",
      message:
        `${tags.length} version tag(s) exist but the repository has no GitHub Release. ` +
        "Tags are not Releases: listing and scoring tools read Releases.",
      fix: `Start with the current version — ${hint}. Older tags stay as they are; only gaps after the first Release are reported.`,
    };
  }

  const released = new Set(releasedVersions);
  const oldestReleased = [...releasedVersions].sort(compareVersions)[0]!;
  const newestReleased = [...releasedVersions].sort(compareVersions).at(-1)!;

  // Only gaps that opened after the repo started releasing. See the pre-adoption rule above.
  const skipped = tags.filter(
    (v) =>
      !released.has(v) &&
      compareVersions(v, oldestReleased) > 0 &&
      compareVersions(v, localVersion) < 0,
  );
  if (skipped.length > 0) {
    return {
      code: "github-releases-skipped",
      severity: "warn",
      message:
        `${skipped.length} tagged version(s) after v${oldestReleased} never became a GitHub Release: ` +
        `${listGap(skipped)}.`,
      fix:
        `Releases are not cumulative, so the newest is the one that matters: ${hint}. ` +
        "If the gap is deliberate, turn the check off with `enforcement.githubReleaseCheck: \"off\"`.",
    };
  }

  if (compareVersions(newestReleased, localVersion) >= 0) {
    return {
      code: "github-release-published",
      severity: "ok",
      message: `v${newestReleased} has a GitHub Release.`,
    };
  }

  return {
    code: "github-release-pending",
    severity: "info",
    message:
      `v${localVersion} has no GitHub Release yet (newest is v${newestReleased}) — ` +
      "expected at this point; the Release comes after the tag is pushed.",
    fix: hint,
  };
}
