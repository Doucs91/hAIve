import type { Memory, Sensor } from "./types.js";
import { BRIDGE_TARGET_PATH } from "./bridges.js";
import { globToRegExp, isGlobPath } from "./relevance.js";

/**
 * Is a regex sensor pattern brittle — over-fit to incident-specific literals that rot when code
 * shifts (hardcoded line numbers / ranges like `1131-1186`)? High-precision by design: digits that
 * live inside a character class (`[0-9]`) or quantifier (`{2,}`), regex escapes (`\d`, `\w`, `\s`),
 * or a dotted-quad IP / version literal (`127\.0\.0\.1`, `1\.2\.3`) all GENERALIZE and are NOT
 * flagged — so durable patterns like `v[0-9]+\.[0-9]+`, `:\s*any\b`, or `https?://127\.0\.0\.1:\d+`
 * stay clean. Returns a short reason naming the offending token, or null.
 *
 * Used to keep brittle legacy sensors from being counted as real protection or promoted to `block`.
 */
export function sensorPatternBrittleness(pattern: string): string | null {
  const literal = pattern
    // Regex escapes (\d \w \s \b …) are structural, not literal digits — their letter is not a value.
    .replace(/\\[a-zA-Z]/g, " ")
    // Character classes and quantifiers generalize.
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    // Dotted-quad IPs and version triples (127\.0\.0\.1, 1\.2\.3) are structural constants, not line numbers.
    .replace(/\b\d{1,3}(?:\s*\\?\.\s*\d{1,3}){2,3}\b/g, " ");
  const range = literal.match(/\d{2,}\s*-\s*\d{2,}/);
  if (range) return `hardcoded line/number range "${range[0].replace(/\s+/g, "")}" — rots when code shifts`;
  const numeric = literal.match(/\d{3,}/);
  if (numeric) {
    return `hardcoded numeric literal "${numeric[0]}" (likely a line number) — rots when code shifts; ` +
      `if it is a real constant, put it in a character class ([0-9]) or anchor it to a stable token`;
  }
  return null;
}

/**
 * Sensors — the feedback *computational* layer of the harness.
 *
 * A memory's `sensor` turns a documented lesson (gotcha/attempt) into a deterministic
 * check. Unlike semantic anti-pattern matching (probabilistic, warmup-sensitive), a
 * regex sensor fires the same way every time, so a known mistake becomes a permanent
 * guardrail. Phase 1 supports `kind: "regex"` only — pure, no I/O. `shell`/`test`
 * sensors are recognized but not executed here (they must run from the CLI).
 */

export interface SensorHit {
  /** The memory id whose sensor matched. */
  memory_id: string;
  /** The sensor that matched. */
  sensor: Sensor;
  /** Project-relative file the match was found in (when known). */
  file?: string;
  /** The matched line (trimmed, capped) — useful for review output. */
  matched_line?: string;
  /** LLM-facing self-correction message carried from the sensor. */
  message: string;
  severity: Sensor["severity"];
}

/** A unit of code to scan: a file path plus the text to match against. */
export interface SensorTarget {
  /** Project-relative path (used for path scoping and reporting). */
  path: string;
  /**
   * Text to scan. For a diff, pass only the added lines (callers should pre-filter)
   * so a sensor fires on "you introduced the bad pattern", not "you touched a file
   * that merely mentions it".
   */
  content: string;
}

function normalizeProjectPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^[ab]\//, "")
    .replace(/\/+$/g, "");
}

/**
 * Does this sensor apply to `path`? A sensor with no explicit `paths` (and whose
 * memory has no anchor paths) applies everywhere. Otherwise it applies to the exact
 * file, a directory prefix, or a glob (`**` / `*.controller.ts` style) scope.
 */
export function sensorAppliesToPath(
  sensor: Sensor,
  anchorPaths: string[],
  path: string,
): boolean {
  const scopes = sensor.paths.length > 0 ? sensor.paths : anchorPaths;
  if (scopes.length === 0) return true;
  const target = normalizeProjectPath(path);
  return scopes.some((rawScope) => {
    const scope = normalizeProjectPath(rawScope);
    if (!scope) return false;
    // Glob scopes (stack packs ship `**/*.controller.ts`-style sensors) were silently dead
    // under pure prefix matching — every glob-scoped sensor never fired anywhere.
    if (isGlobPath(scope)) return globToRegExp(scope).test(target);
    return target === scope || target.startsWith(`${scope}/`);
  });
}

/**
 * Window (in added lines) searched for the `absent` (correct-usage) marker around a trigger match.
 *
 * FORWARD-biased on purpose: a risky call's required companion (e.g. an option object) is part of the
 * call's ARGUMENTS, which follow the call across the next few lines — so we look mostly ahead.
 * The lookback is tiny (catches an options-object hoisted to the line just above) but small enough
 * that a *separate* correct call sitting above a faulty one does NOT mask the faulty one (the live
 * failure that a symmetric window caused). Asymmetry > a single big symmetric window.
 */
export const SENSOR_ABSENT_WINDOW = 6;
export const SENSOR_ABSENT_LOOKBACK = 2;

/**
 * Compile a regex sensor. Returns null when the sensor is not a runnable regex
 * (wrong kind, missing/invalid pattern) so callers can skip it safely.
 */
export function compileRegexSensor(sensor: Sensor): RegExp | null {
  if (sensor.kind !== "regex" || !sensor.pattern) return null;
  try {
    // Always multiline so `^`/`$` work per added line; merge with caller flags.
    const flags = new Set(["m", ...(sensor.flags ?? "").split("")].filter(Boolean));
    return new RegExp(sensor.pattern, [...flags].join(""));
  } catch {
    return null;
  }
}

/** Compile the optional `absent` (correct-usage) regex for a discriminating sensor, or null. */
function compileAbsentRegex(sensor: Sensor): RegExp | null {
  if (sensor.kind !== "regex" || !sensor.absent) return null;
  try {
    const flags = new Set(["m", ...(sensor.flags ?? "").split("")].filter(Boolean));
    return new RegExp(sensor.absent, [...flags].join(""));
  } catch {
    return null;
  }
}

/**
 * Run a single regex sensor over one target. Returns the first matching line as a hit,
 * or null. Deterministic and side-effect-free.
 */
export function runRegexSensor(
  memoryId: string,
  sensor: Sensor,
  target: SensorTarget,
): SensorHit | null {
  const re = compileRegexSensor(sensor);
  if (!re) return null;
  const absentRe = compileAbsentRegex(sensor);
  const lines = target.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Fresh lastIndex each line (no global flag is forced, but be defensive).
    re.lastIndex = 0;
    if (!re.test(rawLine)) continue;

    // Discriminating sensor: the trigger matched, but if the correct-usage marker (`absent`) is
    // present within the window around this match, this is a LEGITIMATE use — skip it and keep
    // scanning for a genuinely faulty occurrence. This is what turns "fires on every call" into
    // "fires only on the faulty call".
    if (absentRe) {
      const from = Math.max(0, i - SENSOR_ABSENT_LOOKBACK);
      const to = Math.min(lines.length, i + SENSOR_ABSENT_WINDOW + 1);
      absentRe.lastIndex = 0;
      if (absentRe.test(lines.slice(from, to).join("\n"))) continue;
    }

    // A brittle pattern (hardcoded line numbers, etc.) must never hard-block, even if a human
    // promoted it to `block` — a fragile false-positive gate is what trains agents to ignore the
    // gate entirely. Downgrade to warn at match time so it stays advisory everywhere.
    const brittle = sensor.kind === "regex" && sensor.pattern ? sensorPatternBrittleness(sensor.pattern) : null;
    const severity = brittle ? "warn" : sensor.severity;
    return {
      memory_id: memoryId,
      sensor,
      file: target.path,
      matched_line: rawLine.trim().slice(0, 200),
      message: sensor.message,
      severity,
    };
  }
  return null;
}

/**
 * Run every memory's regex sensor against every applicable target.
 *
 * Memories without a sensor, or with a non-regex sensor, are skipped (non-regex kinds
 * are the CLI's responsibility). At most one hit per (memory, file) pair is returned.
 */
export function runSensors(
  memories: Memory[],
  targets: SensorTarget[],
): SensorHit[] {
  const hits: SensorHit[] = [];
  for (const memory of memories) {
    const sensor = memory.frontmatter.sensor;
    if (!sensor || sensor.kind !== "regex") continue;
    const anchorPaths = memory.frontmatter.anchor.paths;
    for (const target of targets) {
      if (!sensorAppliesToPath(sensor, anchorPaths, target.path)) continue;
      const hit = runRegexSensor(memory.frontmatter.id, sensor, target);
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

/**
 * A shell/test sensor selected for execution — the feedback *computational* layer that a regex
 * can't express. The schema reserves `kind: "shell" | "test"`; this picks the ones whose memory
 * applies to the changed paths so the CLI can run `command` (core stays pure — it never executes).
 */
export interface CommandSensorSpec {
  memory_id: string;
  /** Command to execute (shell or test runner invocation). */
  command: string;
  kind: "shell" | "test";
  severity: Sensor["severity"];
  /** LLM-facing self-correction message carried from the sensor. */
  message: string;
  /** Optional incident provenance carried from the sensor (ticket/prod ref this test guards). */
  incident?: string;
  /** Anchor/scoped paths this sensor cares about (for reporting). */
  paths: string[];
  /** Max runtime in ms (executor default applies when unset). */
  timeout_ms?: number;
}

/**
 * Environment allowlist for command-sensor execution (and validation). Command sensors run
 * repo-authored commands; the executor must not hand them the caller's full environment — cloud
 * credentials, tokens, and API keys have no business inside a test oracle. Exact names cover the
 * basics a test runner needs; prefixes cover locale/Node/npm knobs. Everything else is dropped.
 * Pure: callers pass process.env and spread the result into their exec options.
 */
const COMMAND_ENV_EXACT = new Set([
  "PATH", "HOME", "LANG", "LANGUAGE", "TMPDIR", "TMP", "TEMP", "TERM", "SHELL", "USER", "LOGNAME",
  "PWD", "CI", "COLORTERM", "TZ",
]);
const COMMAND_ENV_PREFIXES = ["LC_", "NODE_", "NVM_", "npm_", "HIVELORE_", "HAIVE_"];

export function scrubbedCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (COMMAND_ENV_EXACT.has(key) || COMMAND_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render the incident-provenance suffix appended to a fired sensor's message. Empty when the sensor
 * carries no `incident` — so the behaviour-harness link ("guards the incident this test exists for")
 * shows up wherever a sensor speaks, without every call site re-deriving the copy.
 */
export function incidentSuffix(incident?: string): string {
  const ref = incident?.trim();
  return ref ? `  ↩ guards incident: ${ref}` : "";
}

/**
 * Select the shell/test sensors that apply to `changedPaths`. With no changed paths (or a sensor
 * scoped to everywhere) the sensor is selected unconditionally. Pure: the caller executes commands.
 */
export function selectCommandSensors(
  memories: Memory[],
  changedPaths: string[],
): CommandSensorSpec[] {
  const specs: CommandSensorSpec[] = [];
  for (const memory of memories) {
    const sensor = memory.frontmatter.sensor;
    if (!sensor) continue;
    if (sensor.kind !== "shell" && sensor.kind !== "test") continue;
    const command = sensor.command?.trim();
    if (!command) continue;
    const anchorPaths = memory.frontmatter.anchor.paths;
    const applies =
      changedPaths.length === 0
        ? true
        : changedPaths.some((p) => sensorAppliesToPath(sensor, anchorPaths, p));
    if (!applies) continue;
    specs.push({
      memory_id: memory.frontmatter.id,
      command,
      kind: sensor.kind,
      severity: sensor.severity,
      message: sensor.message,
      ...(sensor.incident ? { incident: sensor.incident } : {}),
      paths: sensor.paths.length > 0 ? sensor.paths : anchorPaths,
      ...(sensor.timeout_ms ? { timeout_ms: sensor.timeout_ms } : {}),
    });
  }
  return specs;
}

/**
 * Per-file NEW-side line numbers of added lines in a unified diff. AST sensors match on the full
 * (parsed) file content, but must only FIRE on introductions — a hit counts when the matched
 * node's line range intersects the added lines of that file. Pure hunk-header arithmetic.
 */
export function addedLineNumbersFromDiff(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentPath: string | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? null : normalizeProjectPath(raw);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      let set = result.get(currentPath);
      if (!set) result.set(currentPath, (set = new Set()));
      set.add(newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // removed line: new-side counter does not advance
    } else if (!line.startsWith("\\")) {
      newLine++; // context line
    }
  }
  return result;
}

/** Split a unified diff into per-file targets containing only added lines. */
export function sensorTargetsFromDiff(diff: string): SensorTarget[] {
  const targets: SensorTarget[] = [];
  let currentPath: string | null = null;
  let added: string[] = [];

  const flush = (): void => {
    if (!currentPath || added.length === 0) return;
    targets.push({ path: currentPath, content: added.join("\n") });
    added = [];
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentPath = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      flush();
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? null : normalizeProjectPath(raw);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!currentPath) currentPath = "";
      added.push(line.slice(1));
    }
  }
  flush();
  return targets;
}

/**
 * Files Hivelore itself owns/generates — scanning them with sensors self-matches the very memories
 * they mirror (a memory body documenting a bad pattern literally contains that pattern, and a
 * generated bridge re-states the block sensors). Mirrors `isHaiveOwnedPath` in the MCP
 * anti-pattern check; centralized here so the git-hook gate (`enforce check`) and the standalone
 * `sensors check` CLI can never drift apart on what counts as scannable code.
 */
export const HAIVE_OWNED_FILES: ReadonlySet<string> = new Set<string>([
  ...Object.values(BRIDGE_TARGET_PATH),
  "CLAUDE.md",
  ".cursorrules",
  ".gitignore",
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".cursor/rules/haive-mcp-required.mdc",
]);

/**
 * A diff target is scannable by sensors only when it is real source — never the `.ai/` knowledge
 * base or a Hivelore-generated bridge/config file. Without this guard, staging an `.ai/memories/*.md`
 * file (whose body quotes the bad pattern) makes the sensor fire on itself — a false positive.
 */
export function isSensorScannablePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith(".ai/")) return false;
  return !HAIVE_OWNED_FILES.has(p);
}

/**
 * Filter raw diff targets down to scannable source files. Falls back to scanning the whole diff as
 * one anonymous blob ONLY when the diff carried no file headers at all (e.g. a hand-fed `--diff-file`
 * with bare content) — never when every header was a Hivelore-owned path, so `.ai/`-only diffs scan nothing.
 */
export function scannableSensorTargets(diff: string): SensorTarget[] {
  const all = sensorTargetsFromDiff(diff);
  if (all.length === 0) return [{ path: "", content: diff }];
  return all.filter((t) => isSensorScannablePath(t.path));
}

// ── Gate-surface integrity: a diff that WEAKENS a sensor deserves review ─────────────────────────

export interface SensorWeakening {
  /** The `.ai/memories/**` file whose sensor the diff weakens. */
  file: string;
  /** Memory id derived from the filename (best-effort). */
  memory_id: string;
  change: "severity-demoted" | "oracle-changed" | "oracle-removed" | "sensor-removed" | "memory-deleted" | "suppression-broadened";
  detail: string;
}

interface DiffFileChange {
  path: string;
  created: boolean;
  deleted: boolean;
  removed: string[];
  added: string[];
}

/** Per-file removed/added lines from a unified diff (context lines are ignored). */
function diffFileChanges(diff: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  let current: DiffFileChange | null = null;
  let oldPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      oldPath = raw === "/dev/null" ? null : normalizeProjectPath(raw);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      const newPath = raw === "/dev/null" ? null : normalizeProjectPath(raw);
      current = {
        path: newPath ?? oldPath ?? "",
        created: oldPath === null && newPath !== null,
        deleted: newPath === null,
        removed: [],
        added: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
  }
  return files;
}

const SENSOR_ORACLE_KEY_RE = /^\s*(pattern|command):\s*(.*)$/;
const SENSOR_ABSENT_KEY_RE = /^\s*absent:\s*(.*)$/;
const SEVERITY_BLOCK_RE = /^\s*severity:\s*['"]?block['"]?\s*$/;
const SEVERITY_WARN_RE = /^\s*severity:\s*['"]?warn['"]?\s*$/;
const SENSOR_BLOCK_START_RE = /^\s*sensor:\s*$/;

/**
 * Detect diff hunks that WEAKEN the enforcement surface: demoting a block sensor to warn, changing
 * or removing its oracle (`pattern`/`command`), broadening its `absent` suppression, deleting the
 * whole sensor block, or deleting a memory file that carried a block sensor.
 *
 * Rationale: the gate is written in `.ai/` — the same tree the agent it constrains can edit. A
 * legitimate demotion exists (that's why this yields REVIEW findings, never blocks), but a weakening
 * that sails through unmentioned is exactly how a documented lesson silently stops protecting.
 * Deterministic, pure, diff-text only. Additions (new sensors) never flag; removing `absent`
 * TIGHTENS a sensor and never flags.
 */
export function detectSensorWeakening(diff: string): SensorWeakening[] {
  const weakenings: SensorWeakening[] = [];
  for (const file of diffFileChanges(diff)) {
    if (!file.path.startsWith(".ai/memories/") || !file.path.endsWith(".md")) continue;
    const memoryId = file.path.replace(/^.*\//, "").replace(/\.md$/, "");
    const flag = (change: SensorWeakening["change"], detail: string): void => {
      weakenings.push({ file: file.path, memory_id: memoryId, change, detail });
    };

    const removedBlockSeverity = file.removed.some((l) => SEVERITY_BLOCK_RE.test(l));

    // A newly-created memory cannot weaken a pre-existing enforcement surface. In particular,
    // a discriminating sensor commonly introduces `pattern`, `absent`, and `severity` together.
    if (file.created) continue;

    if (file.deleted) {
      if (file.removed.some((l) => SENSOR_BLOCK_START_RE.test(l)) && removedBlockSeverity) {
        flag("memory-deleted", "memory file with a block sensor deleted");
      }
      continue;
    }

    if (removedBlockSeverity && file.added.some((l) => SEVERITY_WARN_RE.test(l))) {
      flag("severity-demoted", "severity: block → warn");
    }

    for (const line of file.removed) {
      const m = line.match(SENSOR_ORACLE_KEY_RE);
      if (!m) continue;
      const key = m[1]!;
      const replacement = file.added.find((l) => l.match(SENSOR_ORACLE_KEY_RE)?.[1] === key);
      if (replacement === undefined) {
        flag("oracle-removed", `sensor ${key} removed`);
      } else if (replacement.trim() !== line.trim()) {
        flag("oracle-changed", `sensor ${key} changed`);
      }
    }

    // `absent` suppresses matches: ADDING or CHANGING it broadens what the sensor ignores.
    const removedAbsent = file.removed.find((l) => SENSOR_ABSENT_KEY_RE.test(l));
    const addedAbsent = file.added.find((l) => SENSOR_ABSENT_KEY_RE.test(l));
    const addingNewSensorBlock =
      file.added.some((l) => SENSOR_BLOCK_START_RE.test(l)) &&
      !file.removed.some((l) =>
        SENSOR_BLOCK_START_RE.test(l) || SENSOR_ORACLE_KEY_RE.test(l) ||
        SEVERITY_BLOCK_RE.test(l) || SEVERITY_WARN_RE.test(l)
      );
    if (!addingNewSensorBlock && addedAbsent !== undefined && addedAbsent.trim() !== removedAbsent?.trim()) {
      flag("suppression-broadened", removedAbsent === undefined ? "absent marker added" : "absent marker changed");
    }

    if (
      file.removed.some((l) => SENSOR_BLOCK_START_RE.test(l)) &&
      removedBlockSeverity &&
      !file.added.some((l) => SENSOR_BLOCK_START_RE.test(l))
    ) {
      flag("sensor-removed", "block sensor block deleted");
    }
  }
  return weakenings;
}

// ── Self-validation: a generated sensor must prove it discriminates before it can block ──────────

export interface SensorSelfCheck {
  /** The sensor stays SILENT on the current, presumed-correct code — i.e. it won't false-positive. */
  silent_on_current: boolean;
  /** Did it fire on a known-bad example from the lesson? null when no example was available. */
  fires_on_bad: boolean | null;
  /**
   * Did it fire on the lesson's stated CORRECT approach (the `Instead, use:` snippet)? true = the
   * sensor is INVERTED — it would block the recommended fix. null when no correct example was given.
   */
  fires_on_correct: boolean | null;
  /** Files whose CURRENT content the sensor matched — evidence of a false positive. */
  fired_on: string[];
  /**
   * Safe to hard-block: silent on the current code, does NOT fire on the stated correct approach,
   * AND (fires on the bad example, or there was no example to test). A sensor that fires on correct
   * code is exactly what trains agents to ignore the gate — this is the gate that keeps the
   * auto-generation layer honest.
   */
  passed: boolean;
}

/**
 * Validate a sensor before it is trusted to hard-block. Pure: the caller supplies the CURRENT
 * (presumed-correct) file contents and any bad examples lifted from the lesson body.
 *
 *   - silent_on_current: the sensor must NOT match the current code (else it false-positives).
 *   - fires_on_bad: if the lesson carried a bad code example, the sensor SHOULD match it.
 */
export function sensorSelfCheck(
  sensor: Sensor,
  input: { currentTargets: SensorTarget[]; badExamples: string[]; correctExamples?: string[] },
): SensorSelfCheck {
  const firedOn: string[] = [];
  for (const target of input.currentTargets) {
    if (runRegexSensor("self-check", sensor, target)) firedOn.push(target.path);
  }
  const silentOnCurrent = firedOn.length === 0;

  let firesOnBad: boolean | null = null;
  if (input.badExamples.length > 0) {
    firesOnBad = input.badExamples.some(
      (example) => runRegexSensor("self-check", sensor, { path: "<example>", content: example }) !== null,
    );
  }

  // Inversion guard: the lesson's stated CORRECT approach (its `Instead, use:` snippet) is code the
  // sensor must NEVER fire on. A pattern that matches it is inverted — it would block the very fix the
  // lesson recommends (the exact failure of arming `date-fns` when the lesson says "use date-fns").
  let firesOnCorrect: boolean | null = null;
  const correctExamples = (input.correctExamples ?? []).filter((e) => e.trim().length > 0);
  if (correctExamples.length > 0) {
    firesOnCorrect = correctExamples.some(
      (example) => runRegexSensor("self-check", sensor, { path: "<correct>", content: example }) !== null,
    );
  }

  return {
    silent_on_current: silentOnCurrent,
    fires_on_bad: firesOnBad,
    fires_on_correct: firesOnCorrect,
    fired_on: firedOn,
    passed: silentOnCurrent && firesOnBad !== false && firesOnCorrect !== true,
  };
}

export interface ProposedSensorVerdict {
  /** Safe to store at the requested severity. */
  accepted: boolean;
  /** Why a block proposal was rejected (so the agent can revise and re-propose). */
  reason?: "fires-on-current" | "fires-on-correct" | "missed-bad-example" | "brittle";
  self_check: SensorSelfCheck;
  /** Brittleness reason (hardcoded line numbers, etc.) or null. */
  brittle: string | null;
}

/**
 * Decide whether a PROPOSED sensor may be trusted at its severity. This is the deterministic gate
 * behind "the agent (LLM) proposes the sensor, core validates it": a `block` sensor is accepted only
 * if it is NOT brittle, stays SILENT on the current (presumed-correct) code, and FIRES on the bad
 * example (when one is available). A `warn` sensor is always accepted (advisory). Pure.
 */
export function judgeProposedSensor(
  sensor: Sensor,
  input: { currentTargets: SensorTarget[]; badExamples: string[]; correctExamples?: string[] },
): ProposedSensorVerdict {
  const brittle = sensor.kind === "regex" && sensor.pattern ? sensorPatternBrittleness(sensor.pattern) : null;
  const self_check = sensorSelfCheck(sensor, input);
  if (sensor.severity === "block") {
    if (brittle) return { accepted: false, reason: "brittle", self_check, brittle };
    if (input.currentTargets.length > 0 && !self_check.silent_on_current) {
      return { accepted: false, reason: "fires-on-current", self_check, brittle };
    }
    // An inverted sensor (fires on the recommended fix) is worse than useless — it blocks the
    // correct code and never the mistake. Reject before the weaker missed-bad-example check.
    if (self_check.fires_on_correct === true) {
      return { accepted: false, reason: "fires-on-correct", self_check, brittle };
    }
    if (self_check.fires_on_bad === false) {
      return { accepted: false, reason: "missed-bad-example", self_check, brittle };
    }
  }
  return { accepted: true, self_check, brittle };
}

/**
 * One wording for every sensor rejection, shared by the CLI (`sensors propose`) and the MCP
 * (`propose_sensor`) so the two façades cannot drift.
 *
 * `fires-on-current` in particular used to say only "add or tighten `absent`", which assumes the
 * pattern is imprecise. There is a second, very common cause the message never named: the pattern is
 * exactly right and **the faulty code is still in the tree** — which is the normal state at the
 * moment you document the problem. Requiring silence-on-current then makes arming a `block` sensor
 * impossible precisely when you want to arm it. A field report hit this and had to infer the
 * sequence (write the lesson → fix the code → come back and arm) from a bare refusal. Both causes
 * are now named, and the warn-first path out is spelled with the exact command.
 */
export function explainSensorRejection(
  verdict: ProposedSensorVerdict,
  context: { style: "cli" | "mcp"; memoryId?: string },
): string {
  const retry = context.style === "cli" ? "re-run" : "re-propose";
  switch (verdict.reason) {
    case "fires-on-current": {
      const where = verdict.self_check.fired_on.join(", ");
      const warnCommand =
        context.style === "cli"
          ? `hivelore sensors propose ${context.memoryId ?? "<memory-id>"} --pattern '<same>' --severity warn`
          : `propose_sensor({ memory_id: "${context.memoryId ?? "<memory-id>"}", pattern: "<same>", severity: "warn" })`;
      return [
        `A block sensor must be silent on the current code, and this one fires on: ${where}.`,
        "That means one of two things:",
        `  1. The faulty pattern is STILL PRESENT — the usual case when you document a problem before`,
        `     fixing it. A block sensor cannot be armed yet. Arm it as a warning now, fix the code,`,
        `     then promote it:`,
        `       ${warnCommand}`,
        `       …then re-run the same proposal with severity "block" once ${where} is clean.`,
        `  2. The pattern also matches LEGITIMATE usage. Add or tighten the 'absent' companion so`,
        `     correct usage is excluded, then ${retry}.`,
      ].join("\n");
    }
    case "fires-on-correct":
      return (
        "Inverted: the pattern matches the lesson's OWN recommended fix (its `Instead, use:` approach) — " +
        `it would block correct code and never the mistake. Point the pattern at the FAULTY usage, then ${retry}.`
      );
    case "missed-bad-example":
      return `The sensor did not match the bad example, so it won't catch the mistake. Adjust the pattern, then ${retry}.`;
    case "brittle":
      return `The pattern is brittle (${verdict.brittle}). Use a durable pattern (avoid hardcoded line numbers), then ${retry}.`;
    default:
      return `Re-propose with a discriminating pattern, then ${retry}.`;
  }
}

/**
 * A command oracle that exits non-zero has either FAILED an assertion (a real signal) or errored
 * before it could reach one — a missing module, an import/collection failure, a syntax error, or
 * "no tests found". Only the former proves anything. This distinguishes them from the output tail.
 *
 * Used by the prove-RED replay: at the pre-fix `red_ref` the code/test under guard often does not
 * exist yet, so `node t.js` exits 1 for "Cannot find module" — that is the harness failing to run,
 * NOT the oracle catching the incident. Classifying it as RED-proven would fabricate a guarantee.
 * Conservative by design: when in doubt at prove-RED, "could not run" (no proof) is the safe verdict.
 */
export function isHarnessErrorOutput(output: string): boolean {
  if (!output) return false;
  return HARNESS_ERROR_SIGNATURES.some((re) => re.test(output));
}

const HARNESS_ERROR_SIGNATURES: RegExp[] = [
  /cannot find module/i,           // node CJS require of a missing file/dep
  /ERR_MODULE_NOT_FOUND/,          // node ESM import of a missing file/dep
  /\bMODULE_NOT_FOUND\b/,          // node error code
  /ModuleNotFoundError/,           // python
  /\bImportError\b/,               // python import failure at collection
  /\bSyntaxError\b/,               // parse failure at load (any runtime)
  /no test files? found/i,         // vitest / jest — nothing ran
  /no tests found/i,               // jest
  /no tests ran/i,                 // pytest -q
  /collected 0 items/i,            // pytest — nothing collected
  /error(s)? (?:while )?collecting/i, // pytest collection error
  /cannot find package/i,          // go
  /no( buildable)? go( source)? files/i, // go: nothing to build
];

/**
 * Pull candidate bad-code examples from a lesson body: fenced code blocks and inline code spans that
 * look like code (contain a call/dot/assignment). Used to confirm a generated sensor actually fires
 * on the mistake it describes.
 */
export function extractSensorExamples(body: string): string[] {
  const examples: string[] = [];
  for (const match of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const code = (match[1] ?? "").trim();
    if (code) examples.push(code);
  }
  for (const match of body.matchAll(/`([^`\n]{3,200})`/g)) {
    const span = (match[1] ?? "").trim();
    if (span && /[().=]/.test(span)) examples.push(span);
  }
  return examples;
}

/**
 * Pull the lesson's stated CORRECT approach — the text of an `**Instead, use:** …` line or an
 * `## Instead` section (the shape `mem_tried --instead` and the attempt template write). This is code
 * the sensor must NEVER match: a block pattern that fires on it is inverted (it would refuse the very
 * fix the lesson prescribes). Returns the raw snippet(s); the caller runs the sensor against them.
 */
export function extractCorrectApproachExamples(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/\*\*Instead,?\s*use:?\*\*\s*([^\n]+)/gi)) {
    const snippet = (match[1] ?? "").trim();
    if (snippet) out.push(snippet);
  }
  // An `## Instead` / `### Instead …` section: take its first non-empty content line.
  const sectionMatch = body.match(/^#{2,}\s+Instead\b[^\n]*\n+([^\n]+)/im);
  const sectionLine = sectionMatch?.[1]?.trim();
  if (sectionLine) out.push(sectionLine);
  return out;
}

/**
 * Extract the added lines from a unified diff (lines starting with a single `+`,
 * excluding the `+++` file header). Mirrors the diff-handling already used by the
 * anti-pattern tokenizer so sensors fire on introductions, not mere mentions.
 */
export function addedLinesFromDiff(diff: string): string {
  const targets = sensorTargetsFromDiff(diff);
  if (targets.length > 0) return targets.map((target) => target.content).join("\n");
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}
