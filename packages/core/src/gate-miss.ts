import type { LoadedMemory } from "./loader.js";
import { proposeSeedsFromCommits, type GitCommit } from "./seed-git.js";
import type { SensorEvaluation } from "./sensor-ledger.js";

export interface GitWatchState {
  last_scanned_sha: string;
}

export type GitWatchPlan =
  | { action: "initialize"; next: GitWatchState }
  | { action: "idle"; next: GitWatchState }
  | { action: "scan"; range: string; next: GitWatchState };

export function planGitWatch(state: GitWatchState | null, headSha: string): GitWatchPlan {
  const next = { last_scanned_sha: headSha };
  if (!state?.last_scanned_sha) return { action: "initialize", next };
  if (state.last_scanned_sha === headSha) return { action: "idle", next };
  return { action: "scan", range: `${state.last_scanned_sha}..${headSha}`, next };
}

export interface GateMissProposal {
  slug: string;
  reverted_sha: string;
  revert_sha: string;
  subject: string;
  paths: string[];
  kind: "revert" | "fixup" | "workaround";
  gate_passed: boolean;
  body: string;
}

const REVERTED_SHA_RE = /\bThis reverts commit ([0-9a-f]{7,40})\b/i;
const BODY_REVERTED_SHA_RE = /^Reverted SHA:\s*([0-9a-f]{7,40})\s*$/im;

export function revertedShaFromCommit(commit: GitCommit): string | null {
  return commit.reverted_sha ?? REVERTED_SHA_RE.exec(commit.body ?? "")?.[1] ?? null;
}

export function existingGateMissShas(memories: LoadedMemory[]): Set<string> {
  const shas = new Set<string>();
  for (const loaded of memories) {
    if (!loaded.memory.frontmatter.tags.includes("gate-miss")) continue;
    const sha = BODY_REVERTED_SHA_RE.exec(loaded.memory.body)?.[1];
    if (sha) shas.add(sha);
  }
  return shas;
}

export function gatePassedShas(evaluations: SensorEvaluation[]): Set<string> {
  return new Set(
    evaluations
      .filter((e) => e.memory_id === "__gate__" && e.outcome === "silent" && e.head_sha)
      .map((e) => e.head_sha),
  );
}

function shaMatches(set: Set<string>, sha: string): boolean {
  for (const candidate of set) {
    if (candidate === sha || candidate.startsWith(sha) || sha.startsWith(candidate)) return true;
  }
  return false;
}

/** Build proposed, never-validated lessons from incremental revert/hotfix signals. */
export function proposeGateMissDrafts(
  commits: GitCommit[],
  existingRevertedShas: Set<string>,
  passedShas: Set<string>,
  opts: {
    /**
     * Returns true when a repo-relative path still exists on disk. Anchor candidates come from
     * the REVERT commit's file list — files the revert often just deleted. Anchoring a draft to
     * a deleted path makes the very next `sync` mark it stale, so the learning loop eats its own
     * drafts before anyone reviews them. When omitted, paths are kept (pure callers/tests).
     */
    pathExists?: (rel: string) => boolean;
  } = {},
): GateMissProposal[] {
  const seeds = proposeSeedsFromCommits(commits, commits.length);
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const seen = new Set(existingRevertedShas);
  const out: GateMissProposal[] = [];
  for (const seed of seeds) {
    const commit = bySha.get(seed.source_sha);
    if (!commit) continue;
    // A revert names the failed commit deterministically. Hotfix/workaround subjects identify a
    // miss signal but not the earlier broken SHA, so the signal commit itself is the provenance key.
    const failedSha = revertedShaFromCommit(commit) ?? commit.sha;
    if (shaMatches(seen, failedSha)) continue;
    seen.add(failedSha);
    const gatePassed = shaMatches(passedShas, failedSha);
    // `.ai/` files are Hivelore's own corpus, never a regression anchor; deleted paths would
    // stale the draft on the next sync (see pathExists above).
    const paths = (commit.files ?? [])
      .filter((p) => !p.startsWith(".ai/"))
      .filter((p) => opts.pathExists?.(p) ?? true)
      .slice(0, 8);
    const base =
      `# Gate miss: ${seed.what}\n\n` +
      `A git ${seed.kind} indicates that a change escaped the existing harness. This is a proposed ` +
      `lesson only; review the actual regression before validating it.\n\n` +
      `Reverted SHA: ${failedSha}\n` +
      `Revert SHA: ${commit.sha}\n` +
      `Subject: ${seed.what}\n` +
      (paths.length > 0 ? `Top paths: ${paths.join(", ")}\n` : "") +
      `\n**Why it failed / do NOT use:** ${seed.why_failed}\n`;
    const gateLine = gatePassed
      ? "\nThe gate PASSED this commit — a validated sensor here upgrades the harness.\n"
      : "";
    // No prose/subject-derived seed: it produced junk patterns in the field (report 2026-09-01 §5.1).
    // The only trustworthy auto-source is the actual revert diff — point there instead of guessing.
    const sensorHint =
      "\nproposed_sensor_seed: inspect the revert diff, then author a deterministic candidate with " +
      "`hivelore sensors propose --from-fix <revert-sha>` (it mines the fix diff and validates).\n";
    out.push({
      slug: `gate-miss-${failedSha.slice(0, 12)}`,
      reverted_sha: failedSha,
      revert_sha: commit.sha,
      subject: seed.what,
      paths,
      kind: seed.kind,
      gate_passed: gatePassed,
      body: base + gateLine + sensorHint,
    });
  }
  return out;
}
