/**
 * Measure how often each file changes, so the ranker can tell a specific anchor from a common one.
 *
 * The scoring lives in `core/anchor-specificity.ts`; this is the I/O half — one `git log` per repo,
 * cached in gitignored `.ai/.cache/` and invalidated by HEAD. Strictly best-effort: a repo with no
 * git, a shallow clone, or a failed spawn all yield "unknown", which the scorer treats as
 * "assume specific" and ranks exactly as it did before this file existed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HaivePaths } from "@hivelore/core";

const run = promisify(execFile);

/** Enough history to be representative, small enough to stay fast on a big repo. */
export const CHURN_SAMPLE_COMMITS = 200;

export interface ChurnSample {
  head: string;
  total_commits: number;
  /** project-relative path → number of sampled commits that touched it */
  files: Record<string, number>;
}

function churnCachePath(paths: HaivePaths): string {
  return path.join(paths.haiveDir, ".cache", "anchor-churn.json");
}

async function gitHead(root: string): Promise<string | null> {
  return run("git", ["rev-parse", "HEAD"], { cwd: root })
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
}

async function measureChurn(root: string): Promise<ChurnSample | null> {
  const head = await gitHead(root);
  if (!head) return null;
  const { stdout } = await run(
    "git",
    ["log", `-${CHURN_SAMPLE_COMMITS}`, "--name-only", "--format=%x00", "--no-merges"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  if (!stdout) return null;

  const files: Record<string, number> = {};
  let total = 0;
  for (const block of stdout.split("\0")) {
    const touched = new Set(
      block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith(".ai/")),
    );
    if (touched.size === 0) continue;
    total++;
    // Count each file ONCE per commit — the question is "how many commits touch it", not how
    // many times it appears.
    for (const file of touched) files[file] = (files[file] ?? 0) + 1;
  }
  return total > 0 ? { head, total_commits: total, files } : null;
}

/**
 * Churn for this repo, from cache when HEAD has not moved. Returns null when it cannot be measured,
 * which callers must treat as "rank as before" rather than as zero churn.
 */
export async function loadAnchorChurn(paths: HaivePaths): Promise<ChurnSample | null> {
  const cacheFile = churnCachePath(paths);
  const head = await gitHead(paths.root);
  if (head && existsSync(cacheFile)) {
    const cached = await readFile(cacheFile, "utf8")
      .then((raw) => JSON.parse(raw) as ChurnSample)
      .catch(() => null);
    if (cached?.head === head && cached.total_commits > 0) return cached;
  }
  const measured = await measureChurn(paths.root).catch(() => null);
  if (!measured) return null;
  await mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => { /* best-effort */ });
  await writeFile(cacheFile, JSON.stringify(measured), "utf8").catch(() => { /* best-effort */ });
  return measured;
}
