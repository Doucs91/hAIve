import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { HaivePaths } from "./paths.js";

/**
 * Friction journal — how an agent tells the maintainer that Hivelore itself got in its way.
 *
 * Deliberately **local and offline**. Nothing here touches the network: the journal lives under
 * `.ai/.runtime/` (machine-local, gitignored, like `.ai/.usage/`), and only a human turns an entry
 * into a public GitHub issue via `hivelore report submit`.
 *
 * That split is the whole design. Capture must be frictionless or agents never report; publication
 * must NOT be, or the maintainer drowns — the failure mode that made curl scrap its bug bounty in
 * January 2026 after ~20% of submissions turned out to be unreviewed AI output. Keeping a human
 * between the agent and the tracker is what makes the channel survivable.
 *
 * Storage is append-only (same shape as the usage log) so concurrent agent sessions can never
 * clobber each other's writes; grouping and counting happen at read time. Review state — which
 * entries were submitted or dismissed — is the one thing a human edits, so it lives in a separate
 * small JSON file keyed by fingerprint.
 */

export const FRICTION_LOG_FILE = "friction.jsonl";
export const FRICTION_STATE_FILE = "friction-state.json";

/** Longest value kept per free-text field, so one runaway paste cannot bloat the journal. */
export const FRICTION_FIELD_MAX = 2000;

export type FrictionKind = "bug" | "suggestion" | "docs" | "confusing";

export type FrictionStatus = "open" | "submitted" | "dismissed";

export interface FrictionReport {
  /** ISO timestamp of this occurrence. */
  at: string;
  kind: FrictionKind;
  /** The Hivelore surface involved — an MCP tool or CLI command (e.g. `mem_save`, `enforce check`). */
  surface: string;
  /** One-line statement of the problem. */
  summary: string;
  expected?: string;
  observed?: string;
  /** Command or tool call that reproduces it. Required for `kind: "bug"` (see `normalizeKind`). */
  repro?: string;
  /** Hivelore version the agent was running. */
  version?: string;
  /** Set when a `bug` was downgraded for lacking a repro. */
  downgraded_from?: FrictionKind;
  /** Stable identity for deduplication across sessions. */
  fingerprint: string;
}

export interface FrictionGroup {
  fingerprint: string;
  kind: FrictionKind;
  surface: string;
  summary: string;
  /** How many times this exact friction was reported — the priority signal. */
  count: number;
  first_seen: string;
  last_seen: string;
  /** Most recent occurrence, which carries the richest detail. */
  latest: FrictionReport;
  status: FrictionStatus;
  submitted_at?: string;
  url?: string;
}

export interface FrictionStateEntry {
  status: Exclude<FrictionStatus, "open">;
  at: string;
  url?: string;
}

export type FrictionState = Record<string, FrictionStateEntry>;

export function frictionLogPath(paths: HaivePaths): string {
  return path.join(paths.runtimeDir, FRICTION_LOG_FILE);
}

export function frictionStatePath(paths: HaivePaths): string {
  return path.join(paths.runtimeDir, FRICTION_STATE_FILE);
}

/**
 * Collapse the incidental differences between two reports of the same problem so they share a
 * fingerprint: case, whitespace, absolute paths (machine-specific), and long digit runs (ids, line
 * numbers, timestamps). Without this every session produces a "new" report and the count — the only
 * priority signal there is — never rises above 1.
 */
export function normalizeFrictionSummary(value: string): string {
  return value
    .toLowerCase()
    .replace(/[a-z]?:?[\\/](?:[\w.-]+[\\/])+/g, "/")
    .replace(/\d{3,}/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

export function frictionFingerprint(input: {
  kind: FrictionKind;
  surface: string;
  summary: string;
}): string {
  const basis = [
    input.kind,
    input.surface.trim().toLowerCase(),
    normalizeFrictionSummary(input.summary),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > FRICTION_FIELD_MAX
    ? `${trimmed.slice(0, FRICTION_FIELD_MAX)}\n…[truncated]`
    : trimmed;
}

/**
 * Apply the evidence bar: a `bug` claim needs something the maintainer can run. Without a repro the
 * report is still worth keeping — it just is not a bug claim, it is a `suggestion`. This is the same
 * doctrine the sensor layer applies to itself (an oracle that never went RED cannot claim to
 * protect anything), turned on Hivelore's own feedback channel.
 */
export function normalizeKind(
  kind: FrictionKind,
  repro: string | undefined,
): { kind: FrictionKind; downgraded_from?: FrictionKind } {
  if (kind === "bug" && !truncate(repro)) {
    return { kind: "suggestion", downgraded_from: "bug" };
  }
  return { kind };
}

export interface AppendFrictionInput {
  kind: FrictionKind;
  surface: string;
  summary: string;
  expected?: string;
  observed?: string;
  repro?: string;
  version?: string;
  now?: Date;
}

export interface AppendFrictionResult {
  report: FrictionReport;
  /** Total occurrences of this fingerprint INCLUDING the one just written. */
  occurrences: number;
  /** True when this fingerprint had already been reported before this call. */
  already_reported: boolean;
  /** Present when the review state says a human already acted on this fingerprint. */
  resolved_as?: FrictionStateEntry;
}

/**
 * Record one friction occurrence. Never throws on I/O: an agent's report must not break the session
 * it was trying to help.
 */
export async function appendFrictionReport(
  paths: HaivePaths,
  input: AppendFrictionInput,
): Promise<AppendFrictionResult> {
  const { kind, downgraded_from } = normalizeKind(input.kind, input.repro);
  const summary = truncate(input.summary) ?? "(no summary)";
  const surface = truncate(input.surface) ?? "(unknown)";
  const fingerprint = frictionFingerprint({ kind, surface, summary });

  const report: FrictionReport = {
    at: (input.now ?? new Date()).toISOString(),
    kind,
    surface,
    summary,
    ...(truncate(input.expected) ? { expected: truncate(input.expected) } : {}),
    ...(truncate(input.observed) ? { observed: truncate(input.observed) } : {}),
    ...(truncate(input.repro) ? { repro: truncate(input.repro) } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(downgraded_from ? { downgraded_from } : {}),
    fingerprint,
  };

  const prior = (await readFrictionReports(paths)).filter((r) => r.fingerprint === fingerprint);

  try {
    if (!existsSync(paths.runtimeDir)) await mkdir(paths.runtimeDir, { recursive: true });
    await appendFile(frictionLogPath(paths), JSON.stringify(report) + "\n", "utf8");
  } catch {
    // Best-effort, exactly like the usage log.
  }

  const state = await loadFrictionState(paths);
  return {
    report,
    occurrences: prior.length + 1,
    already_reported: prior.length > 0,
    ...(state[fingerprint] ? { resolved_as: state[fingerprint] } : {}),
  };
}

/** Read every recorded occurrence. Malformed lines are skipped rather than failing the read. */
export async function readFrictionReports(paths: HaivePaths): Promise<FrictionReport[]> {
  const file = frictionLogPath(paths);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: FrictionReport[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FrictionReport;
      if (parsed.fingerprint && parsed.at && parsed.summary) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export async function loadFrictionState(paths: HaivePaths): Promise<FrictionState> {
  const file = frictionStatePath(paths);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as FrictionState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveFrictionState(paths: HaivePaths, state: FrictionState): Promise<void> {
  if (!existsSync(paths.runtimeDir)) await mkdir(paths.runtimeDir, { recursive: true });
  await writeFile(frictionStatePath(paths), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function setFrictionStatus(
  paths: HaivePaths,
  fingerprint: string,
  status: Exclude<FrictionStatus, "open">,
  url?: string,
): Promise<FrictionStateEntry> {
  const state = await loadFrictionState(paths);
  const entry: FrictionStateEntry = {
    status,
    at: new Date().toISOString(),
    ...(url ? { url } : {}),
  };
  state[fingerprint] = entry;
  await saveFrictionState(paths, state);
  return entry;
}

/**
 * Collapse occurrences into one row per problem, most-reported first (then most-recent). Frequency
 * is the ranking: an agent hitting the same wall in five sessions is a stronger signal than five
 * different one-off annoyances, and it costs nothing to compute.
 */
export function groupFriction(
  reports: FrictionReport[],
  state: FrictionState = {},
): FrictionGroup[] {
  const byFingerprint = new Map<string, FrictionReport[]>();
  for (const report of reports) {
    const bucket = byFingerprint.get(report.fingerprint);
    if (bucket) bucket.push(report);
    else byFingerprint.set(report.fingerprint, [report]);
  }

  const groups: FrictionGroup[] = [];
  for (const [fingerprint, bucket] of byFingerprint) {
    const sorted = [...bucket].sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted[sorted.length - 1]!;
    const resolution = state[fingerprint];
    groups.push({
      fingerprint,
      kind: latest.kind,
      surface: latest.surface,
      summary: latest.summary,
      count: sorted.length,
      first_seen: sorted[0]!.at,
      last_seen: latest.at,
      latest,
      status: resolution?.status ?? "open",
      ...(resolution?.at ? { submitted_at: resolution.at } : {}),
      ...(resolution?.url ? { url: resolution.url } : {}),
    });
  }

  return groups.sort(
    (a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen),
  );
}

/**
 * Render a group as a GitHub issue. Pure formatting so it is testable without a network or `gh`.
 * The occurrence count is stated up front because it is the one thing a maintainer cannot
 * reconstruct from a single report.
 */
export function formatFrictionIssue(group: FrictionGroup): { title: string; body: string } {
  const title = `[${group.kind}] ${group.surface}: ${group.summary}`.slice(0, 120);
  const r = group.latest;
  const lines = [
    `**Surface:** \`${group.surface}\``,
    `**Reported:** ${group.count}× (first ${group.first_seen.slice(0, 10)}, last ${group.last_seen.slice(0, 10)})`,
    ...(r.version ? [`**Version:** ${r.version}`] : []),
    "",
    "### What happened",
    group.summary,
  ];
  if (r.expected) lines.push("", "### Expected", r.expected);
  if (r.observed) lines.push("", "### Observed", r.observed);
  if (r.repro) lines.push("", "### Reproduction", "```sh", r.repro, "```");
  if (r.downgraded_from === "bug") {
    lines.push(
      "",
      "> Reported as a bug but filed as a suggestion: no reproduction was supplied.",
    );
  }
  lines.push(
    "",
    "---",
    "<sub>Captured by an AI agent session via `report_friction` and reviewed by a human before submission.</sub>",
  );
  return { title, body: lines.join("\n") };
}
