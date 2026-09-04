/**
 * The gate's decision layer — pure, and the only place that decides what refuses.
 *
 * ## Why this module exists
 *
 * This logic used to live inside `packages/cli/src/commands/enforce.ts`, a 3300-line file, as
 * THREE separate downgrade passes applied one after another: one relaxing process gates for human
 * commits, one making them advisory by default, one making them advisory again at commit stage.
 * Each arrived with a different bug fix; none knew about the others. The verdict therefore depended
 * on their execution order, which was never written down anywhere, and adding a fourth pass was the
 * obvious way to fix the next report. That is how a gate becomes unpredictable.
 *
 * There is now ONE pass. Each finding's severity is decided once, from an explicit policy, with the
 * reason recorded on the finding. It is a pure function: no filesystem, no git, no config loading —
 * so "why was this push refused?" is answerable by reading one file and provable by a unit test that
 * runs in a millisecond instead of an 88-second integration suite.
 */

/** Severity as reported by a gate check, before policy is applied. */
export type GateSeverity = "ok" | "info" | "warn" | "error";

export interface GateFinding {
  severity: GateSeverity;
  code: string;
  message: string;
  fix?: string;
  impact?: number;
  reason?: string;
  affected_files?: string[];
  memory_ids?: string[];
  /** Project-relative file a deterministic finding fired on, when one is known. */
  file?: string;
  /** The exact source line that matched — what makes a refusal actionable. */
  matched_line?: string;
  /** Collapsed rendering for a repeated advisory; `message` always holds the full text. */
  short_message?: string;
}

export type GateStage = "local" | "pre-commit" | "pre-push" | "ci";

/**
 * PROCESS gates describe the AGENT WORKFLOW around a change — "was team knowledge consulted?",
 * "was the session recapped?" — never the change itself.
 */
export const PROCESS_GATE_CODES = new Set([
  "briefing-missing",
  "session-recap-missing",
  "decision-coverage-missing",
  "bootstrap-incomplete",
]);

/**
 * CONTENT catches are deterministic statements about THIS diff: a documented lesson matched the code
 * being committed. These are the findings the gate is entitled to refuse on.
 */
export const CONTENT_CATCH_CODES = new Set(["sensor-block", "precommit-policy-block"]);

/** Every code that describes the diff rather than the repo's standing state. */
/** Setup/baseline gates — about the repo's knowledge layer being cold, not the change just made. */
export const SETUP_GATE_CODES = new Set([
  ...PROCESS_GATE_CODES,
]);

// ── Posture ──────────────────────────────────────────────────────────────────

/**
 * A named posture, so a team picks ONE thing instead of reasoning about how two dozen independent
 * switches interact. Individual knobs still win when set explicitly — the posture only supplies the
 * defaults for the three that decide whether anything refuses.
 */
export type GatePosture = "advisory" | "balanced" | "strict";

export const DEFAULT_POSTURE: GatePosture = "balanced";

export interface GatePolicyInput {
  posture?: GatePosture;
  mode?: "off" | "advisory" | "strict";
  processGate?: "warn" | "block";
  humanCommits?: "relaxed" | "strict";
}

export interface GatePolicy {
  posture: GatePosture;
  mode: "off" | "advisory" | "strict";
  processGate: "warn" | "block";
  humanCommits: "relaxed" | "strict";
  /** Which fields the user pinned explicitly, so `doctor` can show posture vs. override. */
  overrides: string[];
}

const POSTURE_DEFAULTS: Record<GatePosture, Omit<GatePolicy, "posture" | "overrides">> = {
  // Report everything, refuse nothing. For adopting Hivelore on a repo mid-flight.
  advisory: { mode: "advisory", processGate: "warn", humanCommits: "relaxed" },
  // Refuse on deterministic, code-bound evidence only. The default.
  balanced: { mode: "strict", processGate: "warn", humanCommits: "relaxed" },
  // Process gates bind too, at the sharing points. For teams that want the workflow enforced.
  strict: { mode: "strict", processGate: "block", humanCommits: "strict" },
};

export function resolveGatePolicy(input: GatePolicyInput | undefined): GatePolicy {
  const cfg = input ?? {};
  const posture = cfg.posture ?? DEFAULT_POSTURE;
  const base = POSTURE_DEFAULTS[posture] ?? POSTURE_DEFAULTS[DEFAULT_POSTURE];
  const overrides: string[] = [];
  for (const key of ["mode", "processGate", "humanCommits"] as const) {
    if (cfg[key] !== undefined) overrides.push(key);
  }
  return {
    posture,
    mode: cfg.mode ?? base.mode,
    processGate: cfg.processGate ?? base.processGate,
    humanCommits: cfg.humanCommits ?? base.humanCommits,
    overrides,
  };
}

/** One sentence describing what a posture actually does, for `doctor` and `--explain`. */
export function describePosture(policy: GatePolicy): string {
  const base =
    policy.posture === "advisory"
      ? "reports everything, refuses nothing"
      : policy.posture === "strict"
        ? "refuses on deterministic findings AND on process gates at pre-push/CI"
        : "refuses on deterministic findings only (sensors, anti-patterns, stale anchors on touched files)";
  const pinned = policy.overrides.length > 0 ? ` · overridden: ${policy.overrides.join(", ")}` : "";
  return `${policy.posture} — ${base}${pinned}`;
}

// ── The single decision pass ─────────────────────────────────────────────────

export interface GateVerdictInput {
  findings: GateFinding[];
  policy: GatePolicy;
  stage: GateStage;
  /** True when an agent harness was detected in the environment. */
  isAgent: boolean;
  /** Env signals that identified the agent, for the actor label. */
  agentSignals?: string[];
}

export interface GateVerdict {
  findings: GateFinding[];
  should_block: boolean;
  actor: string;
  /** Content catches that refuse this change, one entry per memory (never the same lesson twice). */
  refusals: GateFinding[];
  /** Why process gates did or did not bind on this run. */
  process_gate_reason: string;
}

/**
 * Do PROCESS gates refuse on this run?
 *
 * Stated as one rule so it can be read in one breath:
 *   they refuse only when the repo asked for it (processGate "block"), only at a SHARING point
 *   (never during local commit iteration), and only for whoever they are meant to bind.
 *
 * The commit-stage carve-out is not negotiable and is not a posture knob: blocking process gates on
 * every pre-commit is what trained the `--no-verify` reflex on cold repos, and a gate that is
 * routinely bypassed protects nothing (decision 2026-07-07-decision-excellence-polish-pass-v0530).
 */
function processGateDecision(
  policy: GatePolicy,
  stage: GateStage,
  isAgent: boolean,
): { refuses: boolean; reason: string } {
  if (policy.processGate !== "block") {
    return {
      refuses: false,
      reason:
        `advisory: process gates report, they do not refuse — only sensors and other deterministic ` +
        `findings block. Set enforcement.posture="strict" (or processGate="block") to change that.`,
    };
  }
  if (stage === "pre-commit" || stage === "local") {
    return {
      refuses: false,
      reason:
        "advisory at commit time: process gates bind the sharing points (pre-push, CI), not local iteration.",
    };
  }
  // CI is deliberately outside the human carve-out: it validates the merged result on behalf of
  // everyone who will pull it, so who happened to author the commit is irrelevant there.
  if (stage !== "ci" && !isAgent && policy.humanCommits === "relaxed") {
    return {
      refuses: false,
      reason:
        `relaxed to a warning: no agent harness detected, so this human commit is not bound by agent ` +
        `process gates — set enforcement.humanCommits="strict" to change that.`,
    };
  }
  return { refuses: true, reason: "enforced: process gates bind at this sharing point." };
}

/**
 * Collapse content catches so one lesson is reported once.
 *
 * Two independent diff-scan layers exist — the anti-pattern matcher and the sensor runner — and they
 * legitimately both fire on the same memory. Reported separately, a single lesson on a single line
 * of code produced four lines of output (two in the headline, two in the findings list), at exactly
 * the moment the reader's attention is most worth spending. Grouped by memory id, keeping the
 * richest entry: the one that knows which line matched.
 */
export function dedupeRefusals(findings: GateFinding[]): GateFinding[] {
  const byMemory = new Map<string, GateFinding>();
  const out: GateFinding[] = [];
  for (const finding of findings) {
    if (!CONTENT_CATCH_CODES.has(finding.code) || finding.severity !== "error") continue;
    const key = finding.memory_ids?.[0];
    if (!key) {
      out.push(finding);
      continue;
    }
    const existing = byMemory.get(key);
    // Prefer the entry that names the offending line; that is the actionable one.
    if (!existing || (!existing.matched_line && finding.matched_line)) byMemory.set(key, finding);
  }
  return [...byMemory.values(), ...out];
}

/**
 * Decide the whole verdict in one pass. Pure: same inputs, same answer, anywhere.
 */
export function decideVerdict(input: GateVerdictInput): GateVerdict {
  const { policy, stage, isAgent } = input;
  const process = processGateDecision(policy, stage, isAgent);

  const findings: GateFinding[] = input.findings.map((finding) => {
    if (finding.severity !== "error" || !PROCESS_GATE_CODES.has(finding.code)) return finding;
    if (process.refuses) return finding;
    return {
      ...finding,
      severity: "warn" as const,
      // Capped so a downgraded gate cannot dominate the health score it no longer refuses on.
      impact: Math.min(finding.impact ?? 8, 8),
      reason: process.reason,
      message: `${finding.message} (${process.reason})`,
    };
  });

  const refusals = dedupeRefusals(findings);
  const hasErrors = findings.some((f) => f.severity === "error");

  return {
    findings,
    should_block: policy.mode === "strict" && hasErrors,
    actor: isAgent
      ? `agent (${(input.agentSignals ?? []).join(", ")})`
      : process.refuses
        ? "human — strict (enforcement.humanCommits)"
        : "human — process gates relaxed",
    refusals,
    process_gate_reason: process.reason,
  };
}

