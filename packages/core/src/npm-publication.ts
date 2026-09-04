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

import { compareVersions } from "./version-order.js";

export type NpmPublicationCode =
  | "npm-published"
  | "npm-publish-pending"
  | "npm-releases-skipped"
  | "npm-publication-incoherent"
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


/** One lockstep package as seen from the registry. */
export interface LockstepPackageState {
  packageName: string;
  /** Latest version on the registry, or null when it could not be reached. */
  publishedVersion: string | null;
  /** Tagged versions strictly between `publishedVersion` and the local version. */
  taggedBetween?: readonly string[];
}

export interface LockstepPublicationInput {
  /** The lockstep version in the working tree — every package should end up here. */
  localVersion: string;
  packages: readonly LockstepPackageState[];
  publishHint?: string;
}

/**
 * Judge the WHOLE lockstep set, not one representative package.
 *
 * Checking a single package assumes publication is atomic. It is not: `publish:all` runs one
 * `pnpm publish` per package, so any of them can fail on its own (an expired OTP, a 403) while the
 * others land. That produces the one state nobody was watching — a PARTIAL publish, where the
 * registry holds a set that cannot install itself. It happened on 0.60.0: core, cli and embeddings
 * shipped, `@hivelore/mcp` did not, and since cli pins its siblings exactly, every
 * `npm i -g @hivelore/cli` failed with `ETARGET  No matching version found for @hivelore/mcp@0.60.0`.
 * `finish` said `npm-publish-pending` about core and nothing at all about the break.
 *
 * The severity split of {@link classifyNpmPublication} is preserved and extended:
 * - nothing published yet → informational (the normal state before publishing),
 * - some published, some not → WARN, because dependents are broken right now,
 * - a tagged version the registry skipped entirely → WARN, as before.
 */
export function classifyLockstepPublication(input: LockstepPublicationInput): NpmPublicationVerdict {
  const { localVersion } = input;
  const hint = input.publishHint ?? `publish the lockstep packages at ${localVersion}`;
  const reachable = input.packages.filter((pkg) => pkg.publishedVersion !== null);
  if (reachable.length === 0) {
    return {
      code: "npm-publication-unverified",
      severity: "info",
      message: `Could not reach the registry to check whether the ${input.packages.length} lockstep package(s) are published at ${localVersion}.`,
    };
  }

  const behind = reachable.filter((pkg) => compareVersions(pkg.publishedVersion!, localVersion) < 0);
  if (behind.length === 0) {
    return {
      code: "npm-published",
      severity: "ok",
      message: `All ${reachable.length} lockstep package(s) are on npm at ${localVersion}.`,
    };
  }

  const names = behind.map((pkg) => `${pkg.packageName} (${pkg.publishedVersion})`).join(", ");

  // Partial publish: the registry now holds a set that cannot install itself.
  if (behind.length < reachable.length) {
    const ahead = reachable.filter((pkg) => !behind.includes(pkg));
    return {
      code: "npm-publication-incoherent",
      severity: "warn",
      message:
        `npm holds an INCOHERENT lockstep set: ${ahead.length} package(s) are at ${localVersion} but ` +
        `${behind.length} are behind — ${names}. Packages that pin their siblings exactly cannot be ` +
        `installed at all (ETARGET), so this breaks users right now.`,
      fix:
        `Publish the missing package(s) at ${localVersion}: ${hint}. ` +
        "If a publish step reports success while the registry stays behind, its credentials are missing — " +
        "a workflow that SKIPS publishing still reports green.",
    };
  }

  const skipped = [...new Set(behind.flatMap((pkg) => [...(pkg.taggedBetween ?? [])]))].sort(compareVersions);
  if (skipped.length > 0) {
    return {
      code: "npm-releases-skipped",
      severity: "warn",
      message:
        `${skipped.length} tagged release(s) never reached npm — the lockstep packages are behind: ` +
        `${names}. Skipped: ${skipped.map((v) => `v${v}`).join(", ")}.`,
      fix:
        `Registry versions are not cumulative, so publishing the newest is enough: ${hint}. ` +
        "If the release workflow keeps skipping, its publish credentials are missing.",
    };
  }

  return {
    code: "npm-publish-pending",
    severity: "info",
    message:
      `The ${behind.length} lockstep package(s) are not on npm at ${localVersion} yet (${names}) — ` +
      "expected at this point; publish is the next step.",
    fix: hint,
  };
}
