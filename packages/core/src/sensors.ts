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
    // A number used as a divisor/multiplier is a real constant — a decimal base, a byte size — not a
    // line number. The operator must be a LITERAL `/`, an escaped `\*`/`\/`, or a `[/*]` char class
    // (how a sensor writes "÷ or ×"); a bare `*`/`+` is a regex quantifier, never arithmetic. Strip it
    // so a legitimate currency/units sensor is not forced into an approximate pattern (report §5.3).
    .replace(/(?:\/|%|\\[/*]|\[[^\]]*[/*][^\]]*\])[^\d]{0,4}\d{3,}/g, " ")
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
 *
 * Two guards keep a rule from firing where it can only be a false positive: an explicit `exclude`
 * glob list (a production-only lesson skips its own test doubles), and a built-in skip of
 * DOCUMENTATION files for content sensors — example code in a `.md`/`.rst` is never shipped, so a
 * regex/ast match there is always wrong unless the sensor names that exact file.
 */
export function sensorAppliesToPath(
  sensor: Sensor,
  anchorPaths: string[],
  path: string,
): boolean {
  const target = normalizeProjectPath(path);
  const matchesScope = (rawScope: string): boolean => {
    const scope = normalizeProjectPath(rawScope);
    if (!scope) return false;
    if (isGlobPath(scope)) return globToRegExp(scope).test(target);
    return target === scope || target.startsWith(`${scope}/`);
  };
  // An explicit exclusion always wins — this is the per-sensor negation `paths` cannot express.
  if (sensor.exclude?.some(matchesScope)) return false;
  const scopes = sensor.paths.length > 0 ? sensor.paths : anchorPaths;
  // A content sensor never fires on a documentation file reached via a wildcard/prefix scope; it may
  // only fire on a doc the sensor names EXACTLY (so an intentional doc rule still works).
  if ((sensor.kind === "regex" || sensor.kind === "ast") && isDocumentationPath(target)) {
    return scopes.map(normalizeProjectPath).includes(target);
  }
  if (scopes.length === 0) return true;
  return scopes.some(matchesScope);
}

const DOCUMENTATION_EXTENSIONS = new Set(["md", "mdx", "markdown", "rst", "txt", "adoc"]);

/** True for prose/documentation files that ship as docs, not executable code. */
function isDocumentationPath(target: string): boolean {
  const base = target.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 && DOCUMENTATION_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
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
 * Comment syntax for a file family. A regex sensor targets CODE; when its pattern also matches the
 * prose of a comment that DOCUMENTS the very rule the sensor enforces, it punishes the author for
 * explaining the rule next to the code it guards. Field report 2026-09-01 §3.1: a CSS block comment
 * naming `bg-emerald-600` and a Javadoc line naming `LocalDate.now()` both tripped block sensors,
 * costing a full CI cycle each and forcing the docs to stop naming what they forbid. We blank comment
 * spans before matching so the pattern only sees code.
 *
 * String literals are LEFT INTACT on purpose: many sensors legitimately target a bad literal inside a
 * string (a hardcoded colour class, URL, or secret), so stripping strings would blind them.
 */
interface CommentSyntax {
  /** Line-comment starters that run to end-of-line when seen outside a string. */
  line: string[];
  /** Block-comment open/close pair, or null. */
  block: [string, string] | null;
  /** Blank a line whose trimmed text begins with `*` — a block-comment continuation (Javadoc/JSDoc). */
  starContinuation: boolean;
}

const C_FAMILY: CommentSyntax = { line: ["//"], block: ["/*", "*/"], starContinuation: true };
const HASH_FAMILY: CommentSyntax = { line: ["#"], block: null, starContinuation: false };
const CSS_FAMILY: CommentSyntax = { line: [], block: ["/*", "*/"], starContinuation: true };
const SCSS_FAMILY: CommentSyntax = { line: ["//"], block: ["/*", "*/"], starContinuation: true };
const SQL_FAMILY: CommentSyntax = { line: ["--"], block: ["/*", "*/"], starContinuation: false };
const HTML_FAMILY: CommentSyntax = { line: [], block: ["<!--", "-->"], starContinuation: false };

const COMMENT_SYNTAX_BY_EXT: Record<string, CommentSyntax> = {
  ts: C_FAMILY, tsx: C_FAMILY, js: C_FAMILY, jsx: C_FAMILY, mjs: C_FAMILY, cjs: C_FAMILY,
  java: C_FAMILY, c: C_FAMILY, h: C_FAMILY, cpp: C_FAMILY, hpp: C_FAMILY, cc: C_FAMILY, hh: C_FAMILY,
  cs: C_FAMILY, go: C_FAMILY, rs: C_FAMILY, kt: C_FAMILY, kts: C_FAMILY, swift: C_FAMILY,
  scala: C_FAMILY, php: C_FAMILY, dart: C_FAMILY, m: C_FAMILY, mm: C_FAMILY,
  py: HASH_FAMILY, rb: HASH_FAMILY, sh: HASH_FAMILY, bash: HASH_FAMILY, zsh: HASH_FAMILY,
  yml: HASH_FAMILY, yaml: HASH_FAMILY, toml: HASH_FAMILY, properties: HASH_FAMILY,
  conf: HASH_FAMILY, cfg: HASH_FAMILY, pl: HASH_FAMILY, pm: HASH_FAMILY, r: HASH_FAMILY,
  css: CSS_FAMILY, scss: SCSS_FAMILY, less: SCSS_FAMILY,
  sql: SQL_FAMILY,
  html: HTML_FAMILY, htm: HTML_FAMILY, xml: HTML_FAMILY, vue: HTML_FAMILY, svelte: HTML_FAMILY,
  md: HTML_FAMILY, markdown: HTML_FAMILY,
};

function commentSyntaxForPath(path: string): CommentSyntax | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return COMMENT_SYNTAX_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Blank the comment spans of one line, threading multi-line block-comment state. `inBlock` says we
 * opened a block comment on an earlier line that has not closed yet; the return says whether it is
 * still open at end of line. Preserves column positions (comment chars → spaces). */
function blankCommentsOnLine(line: string, syntax: CommentSyntax, inBlock: boolean): { text: string; inBlock: boolean } {
  let out = "";
  let stringDelim: string | null = null;
  let i = 0;
  // Resume an open block comment from a previous line: blank up to its close, then scan the rest.
  if (inBlock) {
    if (!syntax.block) return { text: line, inBlock: false };
    const close = syntax.block[1];
    const closeIdx = line.indexOf(close);
    if (closeIdx === -1) return { text: " ".repeat(line.length), inBlock: true };
    out += " ".repeat(closeIdx + close.length);
    i = closeIdx + close.length;
  } else if (syntax.starContinuation && /^\*(\s|\/|$)/.test(line.trimStart())) {
    // A block-comment continuation (`* @param`, `*/`, or a lone `*`) is entirely prose. Require the
    // `*` to be followed by whitespace / `/` / end so real code like `*ptr` or `*= 2` is left alone.
    return { text: " ".repeat(line.length), inBlock: false };
  }
  for (; i < line.length; i++) {
    const ch = line[i]!;
    if (stringDelim) {
      out += ch;
      if (ch === "\\" && i + 1 < line.length) { out += line[i + 1]!; i++; continue; }
      if (ch === stringDelim) stringDelim = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { stringDelim = ch; out += ch; continue; }
    if (syntax.block) {
      const [open, close] = syntax.block;
      if (line.startsWith(open, i)) {
        const closeIdx = line.indexOf(close, i + open.length);
        // Opened but not closed on this line → the rest is comment; carry the state to the next line.
        if (closeIdx === -1) { out += " ".repeat(line.length - i); return { text: out, inBlock: true }; }
        const end = closeIdx + close.length;
        out += " ".repeat(end - i);
        i = end - 1;
        continue;
      }
    }
    let hitLineComment = false;
    for (const lc of syntax.line) {
      if (line.startsWith(lc, i)) { out += " ".repeat(line.length - i); hitLineComment = true; break; }
    }
    if (hitLineComment) break;
    out += ch;
  }
  return { text: out, inBlock: false };
}

/**
 * Blank comment spans in scannable text so a sensor's regex matches CODE, not the prose that
 * documents it — including MULTI-LINE block comments whose forbidden token sits on a middle line
 * that starts with neither the opener nor `*` (field report 2026-09-04 §3.1: a `bg-emerald-600` in a
 * multi-line CSS comment still tripped the sensor because the earlier fix was purely per-line).
 * Returns `content` unchanged for unknown file types. Pure.
 */
export function stripCommentsForScan(content: string, path: string): string {
  const syntax = commentSyntaxForPath(path);
  if (!syntax) return content;
  let inBlock = false;
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const res = blankCommentsOnLine(line, syntax, inBlock);
    out.push(res.text);
    inBlock = res.inBlock;
  }
  return out.join("\n");
}

/**
 * An inline waiver a developer wrote to excuse ONE line from ONE sensor, recorded so the exception
 * is auditable rather than silent. Field report 2026-09-04 §3.1: a false positive had no outlet
 * other than rewriting correct code or deleting the sensor — and "a linter with no exception
 * mechanism ends up disabled", which costs the whole rule, not one line.
 */
export interface SensorWaiver {
  memory_id: string;
  /** Project-relative file the waiver was used in. */
  file?: string;
  /** The waived line, trimmed and capped. */
  line: string;
  /** The reason the author gave after the slug. Never empty — a reasonless waiver does not apply. */
  reason: string;
}

/**
 * Does a `hivelore:allow` waiver on (or just above) this line excuse THIS sensor?
 *
 * Syntax, written in a comment: `hivelore:allow <slug> — why this line is fine`. The slug must
 * identify the memory (a substring of its id), so a waiver is never a blanket suppression of every
 * sensor on the line, and the reason is mandatory — an unexplained exception is the thing that lets
 * a rule quietly rot. Read from the RAW line: the marker lives in a comment, which the scan text
 * has already blanked.
 */
const WAIVER_MARKER = /hivelore:allow\s+([A-Za-z0-9._/-]+)(?=\s|$)\s*[—–:-]*\s*(.*)$/i;

export function sensorWaiverOnLine(memoryId: string, rawLine: string): string | null {
  const m = WAIVER_MARKER.exec(rawLine);
  if (!m) return null;
  const slug = (m[1] ?? "").toLowerCase();
  // Strip a trailing comment closer (`*/`, `-->`) so a block-comment waiver keeps a clean reason.
  const reason = (m[2] ?? "").replace(/(?:\*\/|-->|#>)\s*$/, "").trim();
  if (!slug || !reason) return null;
  const id = memoryId.toLowerCase();
  if (id !== slug && !id.includes(slug)) return null;
  return reason;
}

/**
 * Run a single regex sensor over one target. Returns the first matching line as a hit,
 * or null. Deterministic and side-effect-free — waivers found along the way are pushed into the
 * optional `waivers` sink so the caller can journal them (the exception stays visible).
 */
export function runRegexSensor(
  memoryId: string,
  sensor: Sensor,
  target: SensorTarget,
  waivers?: SensorWaiver[],
): SensorHit | null {
  const re = compileRegexSensor(sensor);
  if (!re) return null;
  const absentRe = compileAbsentRegex(sensor);
  const rawLines = target.content.split("\n");
  // Match against comment-stripped lines so a rule's own documentation can't trip its sensor, but
  // report the ORIGINAL line so the agent sees real content.
  const scanLines = stripCommentsForScan(target.content, target.path).split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    const scanLine = scanLines[i] ?? rawLine;
    // Fresh lastIndex each line (no global flag is forced, but be defensive).
    re.lastIndex = 0;
    if (!re.test(scanLine)) continue;

    // Discriminating sensor: the trigger matched, but if the correct-usage marker (`absent`) is
    // present within the window around this match, this is a LEGITIMATE use — skip it and keep
    // scanning for a genuinely faulty occurrence. This is what turns "fires on every call" into
    // "fires only on the faulty call".
    if (absentRe) {
      const from = Math.max(0, i - SENSOR_ABSENT_LOOKBACK);
      const to = Math.min(scanLines.length, i + SENSOR_ABSENT_WINDOW + 1);
      absentRe.lastIndex = 0;
      if (absentRe.test(scanLines.slice(from, to).join("\n"))) continue;
    }

    // Inline waiver: the author already judged this occurrence and said why. Honour it and keep
    // scanning — a waiver excuses THIS line and nothing else. Deliberately end-of-line only: a
    // waiver read from the preceding line silently covers the line after it too, which is how a
    // one-off exception quietly becomes a disabled rule.
    const waivedReason = sensorWaiverOnLine(memoryId, rawLine);
    if (waivedReason) {
      waivers?.push({
        memory_id: memoryId,
        file: target.path,
        line: rawLine.trim().slice(0, 200),
        reason: waivedReason,
      });
      continue;
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
  waivers?: SensorWaiver[],
): SensorHit[] {
  const hits: SensorHit[] = [];
  for (const memory of memories) {
    const sensor = memory.frontmatter.sensor;
    if (!sensor || sensor.kind !== "regex") continue;
    // Presence sensors are evaluated on FINAL file content (they fire on a deletion), not on added
    // diff lines — running them here would false-fire on any added line that lacks the marker.
    if (sensor.require_present) continue;
    const anchorPaths = memory.frontmatter.anchor.paths;
    for (const target of targets) {
      if (!sensorAppliesToPath(sensor, anchorPaths, target.path)) continue;
      const hit = runRegexSensor(memory.frontmatter.id, sensor, target, waivers);
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

/**
 * Parse every touched file path out of a unified diff (`diff --git a/X b/X` headers), including
 * files changed by pure DELETIONS — the case a presence sensor exists for. Pure.
 */
export function changedPathsFromDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    out.add((m[2] ?? m[1] ?? "").trim());
  }
  // Fallback for header-less diffs (some callers pass a bare `+++ b/path` hunk).
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const p = (m[1] ?? "").trim();
    if (p && p !== "/dev/null") out.add(p);
  }
  return [...out];
}

/**
 * Run REQUIRED-PRESENCE regex sensors (`require_present`) against the FINAL content of touched files.
 * Fires when the required `pattern` is ABSENT from a file the change touched — i.e. the guarded line
 * was removed. Deterministic and side-effect-free; the caller supplies the final file contents.
 */
export function runPresenceSensors(
  memories: Memory[],
  finalTargets: SensorTarget[],
): SensorHit[] {
  const hits: SensorHit[] = [];
  for (const memory of memories) {
    const sensor = memory.frontmatter.sensor;
    if (!sensor || sensor.kind !== "regex" || !sensor.require_present || !sensor.pattern) continue;
    let re: RegExp;
    try {
      const flags = new Set(["m", ...(sensor.flags ?? "").split("")].filter(Boolean));
      re = new RegExp(sensor.pattern, [...flags].join(""));
    } catch {
      continue;
    }
    const anchorPaths = memory.frontmatter.anchor.paths;
    for (const target of finalTargets) {
      if (!sensorAppliesToPath(sensor, anchorPaths, target.path)) continue;
      re.lastIndex = 0;
      if (!re.test(target.content)) {
        hits.push({
          memory_id: memory.frontmatter.id,
          sensor,
          file: target.path,
          message: sensor.message,
          severity: sensor.severity,
        });
        break; // one hit per memory
      }
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
  // An inverted sensor — one that fires on the lesson's OWN recommended-correct code — is noise at
  // ANY severity: a warn that cries on correct code trains agents to ignore it, and it will be
  // ignored the day it is right too (field report §3.4). Reject it before the severity split.
  if (self_check.fires_on_correct === true) {
    return { accepted: false, reason: "fires-on-correct", self_check, brittle };
  }
  if (sensor.severity === "block") {
    if (brittle) return { accepted: false, reason: "brittle", self_check, brittle };
    if (input.currentTargets.length > 0 && !self_check.silent_on_current) {
      return { accepted: false, reason: "fires-on-current", self_check, brittle };
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

/** One place a sensor's rule can be violated that the sensor is not looking at. */
export interface SensorBlindSpot {
  memory_id: string;
  severity: Sensor["severity"];
  /** The scope actually in force (sensor.paths, else the memory's anchor paths; empty = repo-wide). */
  scopes: string[];
  /** Files outside that scope whose content the sensor's own pattern matches. */
  matches: { path: string; line: string }[];
  /** Total out-of-scope matching files, even when `matches` is truncated. */
  match_count: number;
}

/**
 * Find, for every regex sensor, the files its OWN pattern matches that its scope excludes.
 *
 * Motivated by the case in field report 2026-09-05 §5: a "no hardcoded credentials" sensor scoped
 * to `frontend/src, backend/src/test/java` while the secret went into `docker-compose.yml`. Every
 * piece existed — the right rule, the right file, the right moment — and the scope kept them apart,
 * so a third-party scanner caught what the corpus had described nine days earlier. A sensor's scope
 * should follow the INTENT of its rule, not the directory where the mistake was first seen; a scope
 * that is too narrow is more dangerous than no sensor at all, because it reads as coverage.
 *
 * Pure: callers supply the file contents. Presence sensors are skipped (they assert a line must
 * exist, so "matches elsewhere" is meaningless for them) and so are non-regex kinds, which need an
 * engine or a shell.
 */
export function findSensorBlindSpots(
  sensors: { id: string; sensor: Sensor; anchorPaths: string[] }[],
  files: SensorTarget[],
  opts: { maxPerSensor?: number } = {},
): SensorBlindSpot[] {
  const maxPerSensor = opts.maxPerSensor ?? 5;
  const out: SensorBlindSpot[] = [];
  for (const { id, sensor, anchorPaths } of sensors) {
    if (sensor.kind !== "regex" || sensor.require_present) continue;
    if (!compileRegexSensor(sensor)) continue;
    const matches: { path: string; line: string }[] = [];
    let matchCount = 0;
    for (const file of files) {
      if (!isSensorScannablePath(file.path)) continue;
      // A documentation file can only ever fire a content sensor that names it EXACTLY (see
      // sensorAppliesToPath), so widening a scope would not start catching it. Reporting one as a
      // blind spot sends the reader to fix a hole that cannot exist — the rule's own prose quoting
      // the pattern it forbids is the usual match.
      if (isDocumentationPath(file.path)) continue;
      if (sensorAppliesToPath(sensor, anchorPaths, file.path)) continue;
      const hit = runRegexSensor(id, sensor, file);
      if (!hit) continue;
      matchCount++;
      if (matches.length < maxPerSensor) {
        matches.push({ path: file.path, line: (hit.matched_line ?? "").trim().slice(0, 200) });
      }
    }
    if (matchCount === 0) continue;
    out.push({
      memory_id: id,
      severity: sensor.severity,
      scopes: sensor.paths.length > 0 ? [...sensor.paths] : [...anchorPaths],
      matches,
      match_count: matchCount,
    });
  }
  // Widest hole first: a block sensor blind to many files is the most misleading kind of coverage.
  return out.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1) || b.match_count - a.match_count,
  );
}
