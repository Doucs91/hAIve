import type { Sensor } from "./types.js";
import { extractCorrectApproachExamples, sensorPatternBrittleness } from "./sensors.js";

const CODE_TOKEN_RE = /`([^`\n]{3,80})`|["']([A-Za-z0-9_.:-]{3,80})["']|\b([A-Za-z][A-Za-z0-9_.:-]{2,79})\b/g;

const SENSOR_STOPWORDS = new Set([
  "about", "after", "again", "agent", "always", "anchor", "approach", "because",
  "before", "break", "broken", "cannot", "change", "code", "commit", "correct",
  "could", "default", "detect", "direct", "directory", "does", "error", "failed",
  "fails", "file", "files", "future", "haive", "instead", "memory", "never", "project",
  "recorded", "repo", "return", "should", "source", "string", "this",
  "tried", "true", "type", "undefined", "value", "when", "where", "which", "with",
  "without",
  // Error/diagnostic words: tokens lifted from an incident's *error output* (not the code to avoid)
  // produced dead sensors like `CACError:Unknown` / `Fallback:ci.yml` that never match a real diff.
  "unknown", "exception", "fallback", "stack", "trace", "output", "message", "warning",
]);

export interface SensorSuggestionOptions {
  /** Extra paths to put on the sensor. Defaults to the memory anchor paths. */
  paths?: string[];
}

/**
 * A non-persisted sensor *seed*: a candidate pattern (and optional discriminating `absent` companion)
 * extracted heuristically from a lesson body, handed to the agent to PRE-FILL a `propose_sensor` call.
 *
 * A seed is NOT a live guardrail. The agent-in-the-loop write paths no longer persist heuristic
 * sensors onto frontmatter; instead they surface this seed so the agent can refine it and let
 * `propose_sensor` validate it (silent on current code, fires on the bad example) before it is trusted
 * to block. This is the "generate-then-validate via the LLM" pipeline — the heuristic only proposes.
 */
export interface SensorSeed {
  /** Regex matching the faulty usage. */
  pattern: string;
  /** Regex for the correct-usage marker (discriminating sensor) — present for "X without Y" lessons. */
  absent?: string;
  /** LLM-facing fix message derived from the lesson. */
  message: string;
  /** Scope paths for the eventual sensor (the lesson's anchor paths). */
  paths: string[];
}

/**
 * Conservatively extract a sensor SEED from a gotcha/attempt body — a candidate pattern for the agent
 * to validate via `propose_sensor`, never a persisted live sensor.
 *
 * This helper intentionally returns null more often than it guesses: a wrong seed wastes an agent's
 * attention, so when no distinctive token / discriminating companion is found it yields nothing and
 * the agent is simply told to author the pattern itself.
 */
export function suggestSensorSeed(
  body: string,
  anchorPaths: string[],
  options: SensorSuggestionOptions = {},
): SensorSeed | null {
  const paths = options.paths ?? anchorPaths;
  if (paths.length === 0) return null;

  const negativeText = body.split(/\*\*Instead,\s*use:\*\*|^##\s+Instead\b/im)[0] ?? body;

  // Tokens naming the RECOMMENDED approach (the lesson's `Instead, use:` snippet) must never become
  // the sensor pattern — they are the correct code, so a sensor built from them fires on the fix.
  // They frequently leak into the why-failed line too ("team standard is date-fns"), which is inside
  // negativeText, so excluding them from every pick is the fix for the inverted-suggestion class.
  const recommended = recommendedTokens(body);
  const isRecommended = (token: string | undefined | null): boolean =>
    !!token && recommended.has(token.toLowerCase());

  const assignmentRaw = pickAssignmentPattern(negativeText);
  const assignment = isRecommended(assignmentRaw?.label.split(/[:=]/)[0]) ? null : assignmentRaw;
  const lowercaseRaw = assignment ? null : pickLowercaseValuePattern(negativeText);
  const lowercaseValue = isRecommended(lowercaseRaw?.label.split(/[:=]/)[0]) ? null : lowercaseRaw;

  // Discriminating "X without Y" sensor. When neither a key=value nor a lowercase pattern applies,
  // look for a REQUIRED COMPANION ("create WITHOUT idempotencyKey", "must pass idempotencyKey") and
  // emit pattern=trigger (the risky call) + absent=companion (the correct-usage marker). The sensor
  // then fires on the faulty call ONLY — not on every call — which is what makes it safe to promote.
  const required = !assignment && !lowercaseValue ? pickRequiredCompanion(body) : null;

  let companion: { trigger: string; required: string; plain: boolean } | null = null;
  if (required) {
    // Pick the trigger EXCLUDING the required companion. Otherwise, when the companion (Y) is a longer/
    // more distinctive token than the call (X) — e.g. "createOrder without idempotencyKey" — the plain
    // distinctive-token pick returns Y, the equality guard bails out, and the fallback below would emit
    // a sensor whose pattern is Y. That sensor fires on CORRECT usage (Y present) and stays silent on
    // the actual fault: an inverted, self-contradictory guardrail. Excluding Y keeps the trigger = X.
    // NB: do NOT exclude `recommended` here — in an "X without Y" lesson the recommendation sentence
    // ("always pass Y to X") legitimately names the faulty call X, which is exactly the trigger we want.
    // The recommended-token exclusion belongs only on the fallback/assignment paths (the date-fns class).
    let trigger = pickDistinctiveToken(negativeText, [required]);
    let plain = false;
    // Plain-word call ("calling charge without idempotencyKey"): the trigger isn't code-shaped, so the
    // strict pick returns null. Because `required` is always a DISTINCTIVE token (pickRequiredCompanion
    // enforces it) and the sensor only fires when it is ABSENT, a word-bounded plain trigger gated by
    // that companion is safe enough as a warn sensor. Without this, common "doX without <key>" lessons
    // (verbs like charge/login/create) produce no guardrail at all.
    if (!trigger) {
      const word = pickPlainTrigger(body, required);
      if (word) { trigger = word; plain = true; }
    }
    if (
      trigger &&
      trigger.toLowerCase() !== required.toLowerCase() &&
      !trigger.toLowerCase().includes(required.toLowerCase()) &&
      !sensorPatternBrittleness(escapeRegExp(trigger))
    ) {
      companion = { trigger, required, plain };
    }
  }

  // The fallback token must ALSO exclude the required companion: a "X without Y" memory whose trigger
  // could not be isolated must yield no sensor rather than degrade into a plain `pattern=Y` (the
  // inverted sensor above). Excluding Y here means an un-isolable case returns null — the safe default.
  const fallbackToken = pickDistinctiveToken(negativeText, [...(required ? [required] : []), ...recommended]);
  const token = assignment?.label ?? lowercaseValue?.label ?? companion?.trigger ?? fallbackToken;
  if (!token) return null;

  const pattern =
    assignment?.pattern ?? lowercaseValue?.pattern ??
    (companion?.plain
      ? `\\b${escapeRegExp(companion.trigger)}\\b` // word-bound a plain-word call to limit false matches
      : escapeRegExp(companion?.trigger ?? token));
  // Belt-and-suspenders: never emit a pattern that is already known to be brittle (line numbers, etc.).
  if (sensorPatternBrittleness(pattern)) return null;

  const seed: SensorSeed = {
    pattern,
    paths,
    message: companion ? companionMessage(body, companion) : sensorMessageFromBody(body, token),
  };
  if (companion) seed.absent = escapeRegExp(companion.required);
  // Final gate: the lesson carries its own counter-example, so test against it before emitting.
  return seedFiresOnCorrectUsage(seed, body) ? null : seed;
}

/**
 * Does this candidate match the lesson's OWN description of correct usage?
 *
 * The heuristics above avoid the inverted-seed class token by token; this checks the finished
 * pattern against the text, which is the only way to catch a token that was innocent in isolation.
 * Observed three times in the field: a lesson about bundling a GitHub Action produced the seed
 * `uses\s*:\s*["']?Doucs91`, lifted from the very line that shows how to consume the action
 * CORRECTLY. `propose_sensor` would have rejected it, so nothing unsafe could ever be armed — but a
 * visibly absurd first suggestion teaches agents to stop reading the loop, and the sensor loop is
 * the most valuable thing Hivelore does. No seed is strictly better than an inverted seed.
 *
 * Deliberately not routed through `judgeProposedSensor`: seeds are `warn`, and that function accepts
 * every warn sensor by design. The inversion check has to be explicit here.
 */
function seedFiresOnCorrectUsage(seed: SensorSeed, body: string): boolean {
  const correct = correctUsageText(body);
  if (!correct) return false;
  let re: RegExp;
  try {
    re = new RegExp(seed.pattern, "m");
  } catch {
    return true; // an uncompilable pattern is not worth proposing either
  }
  if (!re.test(correct)) return false;
  // A discriminating sensor is allowed to match correct usage as long as its `absent` companion is
  // there too — that is exactly what makes it discriminate rather than fire on everything.
  if (seed.absent) {
    try {
      if (new RegExp(seed.absent, "m").test(correct)) return false;
    } catch { /* fall through: treat as inverted */ }
  }
  return true;
}

/**
 * The parts of a memory body that describe what you SHOULD do. Broader than
 * `extractCorrectApproachExamples` (which reads the structured `Instead, use:` field) because
 * free-form lessons put the recommendation under headings like "How to apply" or "Fix", and fenced
 * code blocks there are the clearest statement of correct usage a lesson ever contains.
 */
function correctUsageText(body: string): string {
  const parts = [...extractCorrectApproachExamples(body)];
  // NB: end-of-input is `(?![\s\S])` — `\Z` is Python, and in JS silently degrades to a literal "Z",
  // which made the whole section capture fail closed and let inverted seeds through.
  const headingRe = /^#{1,6}\s+(?:how to apply|instead|correct|the fix|fix|recommended|do this|guidance)\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/gim;
  for (const match of body.matchAll(headingRe)) {
    if (match[1]) parts.push(match[1]);
  }
  return parts.join("\n").trim();
}

/**
 * @deprecated The agent-in-the-loop write paths no longer persist heuristic sensors — they surface a
 * {@link SensorSeed} for `propose_sensor` to validate instead. This wrapper remains only for
 * back-compat (and the scanner-ingestion draft path, where the sensor lands on a human-reviewed
 * `proposed` draft and can never hard-block). It builds the old `autogen: true, severity: "warn"`
 * sensor from a seed. Prefer {@link suggestSensorSeed}.
 */
export function suggestSensorFromMemory(
  body: string,
  anchorPaths: string[],
  options: SensorSuggestionOptions = {},
): Sensor | null {
  const seed = suggestSensorSeed(body, anchorPaths, options);
  if (!seed) return null;
  return {
    kind: "regex",
    pattern: seed.pattern,
    ...(seed.absent ? { absent: seed.absent } : {}),
    paths: seed.paths,
    message: seed.message,
    severity: "warn",
    autogen: true,
    last_fired: null,
  };
}

/**
 * The strongest possible seed: mine it from the FIX itself. Given the unified diff of the fix
 * (`<pre-fix-ref>..HEAD`) scoped to the lesson's anchor paths, the mistake is *what the fix removed
 * and did not re-add* (a token present only on `-` lines) and the correct marker is *what it added*
 * (a token present only on `+` lines). That yields a discriminating `pattern` + `absent` companion
 * grounded in the real change — turning "author a regex" into "confirm the mined candidate".
 *
 * Pure. Returns null when no distinctive removed-only token exists (nothing to key on). Callers run
 * it through `propose_sensor` for the same silent-on-current / fires-on-bad / not-inverted validation
 * as any hand-written pattern — mining lowers the authoring cost, it never bypasses the gate.
 */
export function mineSensorSeedFromDiff(
  diff: string,
  anchorPaths: string[],
  body?: string,
): SensorSeed | null {
  if (!diff.trim() || anchorPaths.length === 0) return null;
  const { removed, added } = collectDiffLines(diff, anchorPaths);
  if (removed.length === 0) return null;
  const removedTokens = rankDiffTokens(removed);
  const addedLower = new Set(rankDiffTokens(added).map((t) => t.toLowerCase()));
  const removedLower = new Set(removedTokens.map((t) => t.toLowerCase()));
  // The mistake: removed AND not re-added (a pure deletion the fix made).
  const patternToken = removedTokens.find((t) => !addedLower.has(t.toLowerCase())) ?? removedTokens[0];
  if (!patternToken) return null;
  const pattern = escapeRegExp(patternToken);
  if (sensorPatternBrittleness(pattern)) return null;
  // The correct marker: added AND not previously present (a pure addition the fix made).
  const absentToken = rankDiffTokens(added).find(
    (t) => !removedLower.has(t.toLowerCase()) && t.toLowerCase() !== patternToken.toLowerCase(),
  );
  const seed: SensorSeed = {
    pattern,
    paths: anchorPaths,
    message: body ? sensorMessageFromBody(body, patternToken) : `Reintroduces \`${patternToken}\`, removed by the fix this lesson guards.`,
  };
  if (absentToken && !sensorPatternBrittleness(escapeRegExp(absentToken))) seed.absent = escapeRegExp(absentToken);
  return seed;
}

/** Collect the `-`/`+` payload lines of a unified diff, restricted to files under the anchor paths. */
function collectDiffLines(diff: string, anchorPaths: string[]): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  let inScope = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const file = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      inScope = file !== "/dev/null" && anchorPaths.some((p) => diffPathInAnchor(file, p));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("@@") || line.startsWith("index ")) continue;
    if (!inScope) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  return { removed, added };
}

function diffPathInAnchor(file: string, anchor: string): boolean {
  const a = anchor.replace(/^\/+|\/+$/g, "");
  const f = file.replace(/^\/+/, "");
  if (!a) return false;
  return f === a || f.startsWith(`${a}/`) || f.startsWith(a) || a.startsWith(f);
}

/** Distinctive code tokens across a set of diff lines, ranked most-distinctive first (deduped). */
function rankDiffTokens(lines: string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(CODE_TOKEN_RE)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^[^\w.-]+|[^\w.-]+$/g, "");
      const isCodeLike = Boolean(match[1] ?? match[2]);
      if (isDistinctiveToken(raw, isCodeLike)) seen.add(raw);
    }
  }
  return [...seen].sort((a, b) => diffTokenScore(b) - diffTokenScore(a));
}

function diffTokenScore(token: string): number {
  const shape = /[-_.:]/.test(token) ? 3 : /[A-Z]/.test(token.slice(1)) ? 2 : /\d/.test(token) ? 1 : 0;
  return token.length + shape;
}

/**
 * Lowercased tokens that name the lesson's RECOMMENDED approach (its `Instead, use:` snippet). These
 * are the correct code — a sensor pattern built from them fires on the fix, never the mistake. Only
 * the explicit recommendation markers are used (not a generic "use X"), so an attempt whose bad token
 * happens to follow "use" is not accidentally suppressed.
 */
function recommendedTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const clause of extractCorrectApproachExamples(body)) {
    for (const match of clause.matchAll(CODE_TOKEN_RE)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^[^\w.-]+|[^\w.-]+$/g, "");
      if (raw.length >= 3) tokens.add(raw.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Detect a required-companion token: the thing that, when MISSING, makes the call faulty
 * ("create without an idempotencyKey", "must pass idempotencyKey"). Returns a distinctive code
 * token or null. Used to build a discriminating `absent` regex.
 */
function pickRequiredCompanion(text: string): string | null {
  const tok = "([A-Za-z`'\"$][\\w.$-]{2,79})";
  const patterns = [
    new RegExp(`\\bwithout\\s+(?:an?|the|its|explicit|a\\s+valid|passing|setting|providing)?\\s*${tok}`, "i"),
    new RegExp(`\\bmissing\\s+(?:an?|the|its)?\\s*${tok}`, "i"),
    new RegExp(`\\bforgot(?:\\s+to\\s+\\w+)?\\s+(?:an?|the)?\\s*${tok}`, "i"),
    new RegExp(`\\b(?:must|should|always|need\\s+to|needs\\s+to)\\s+(?:pass|provide|include|set|add|receive|specify|supply)\\s+(?:an?|the)?\\s*${tok}`, "i"),
    // NOTE: `\bno\s+X` is intentionally NOT a required-companion signal. It is ambiguous: in an
    // attempt/gotcha title "No BigInt" means *avoid* BigInt (X is the bad token), not "BigInt is
    // required and missing". Treating it as required produced inverted sensors like "JSON without
    // BigInt". The other forms above (without/missing/forgot/must-pass X) are unambiguous: X is desired.
  ];
  for (const re of patterns) {
    const candidate = cleanCompanionToken(text.match(re)?.[1]);
    if (candidate && isDistinctiveToken(candidate, false)) return candidate;
  }
  return null;
}

/**
 * The plain-word call immediately before a "without/missing" clause ("calling charge without …",
 * "create without …"). Used only as the trigger of a discriminating sensor that is ALREADY gated by a
 * distinctive `absent` companion, so a bare verb is acceptable. Requires >=5 chars and not a stopword.
 */
const PLAIN_TRIGGER_RE = /\b([A-Za-z][A-Za-z0-9_]{4,40})\s+(?:without|missing)\b/i;
function pickPlainTrigger(text: string, required: string): string | null {
  const tok = PLAIN_TRIGGER_RE.exec(text)?.[1];
  if (!tok) return null;
  const lower = tok.toLowerCase();
  if (lower === required.toLowerCase() || SENSOR_STOPWORDS.has(lower)) return null;
  return tok;
}

function cleanCompanionToken(raw: string | undefined | null): string {
  return (raw ?? "").replace(/^[^\w.$-]+|[^\w.$-]+$/g, "");
}

function companionMessage(body: string, c: { trigger: string; required: string }): string {
  const instead = body.match(/\*\*Instead,\s*use:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const base = `${c.trigger} without ${c.required}`;
  return instead ? `${base} — ${instead}` : `${base} — add the required ${c.required}.`;
}

function pickLowercaseValuePattern(text: string): { label: string; pattern: string; score: number } | null {
  const candidates: Array<{ label: string; pattern: string; score: number }> = [];
  for (const match of text.matchAll(/\blowercase\s+([A-Za-z][A-Za-z0-9_.:-]{2,79})\s+([a-z][a-z0-9_.:-]{1,40})\b/g)) {
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (!isDistinctiveToken(key, true) || isBoringValue(value)) continue;
    candidates.push({
      label: `${key}=${value}`,
      pattern: `${escapeRegExp(key)}\\s*[:=]\\s*["']?${escapeRegExp(value)}["']?`,
      score: key.length + value.length + 35,
    });
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function pickAssignmentPattern(text: string): { label: string; pattern: string; score: number } | null {
  const candidates: Array<{ label: string; pattern: string; score: number }> = [];
  for (const source of assignmentSources(text)) {
    for (const match of source.matchAll(/\b([A-Za-z][A-Za-z0-9_.:-]{2,79})\b\s*(=|:)\s*["']?([A-Za-z0-9_.:-]{2,80})["']?/g)) {
      const key = match[1] ?? "";
      const operator = match[2] ?? "";
      const value = match[3] ?? "";
      if (!isDistinctiveToken(key, true) || isBoringValue(value)) continue;
      const label = `${key}${operator}${value}`;
      candidates.push({
        label,
        pattern: `${escapeRegExp(key)}\\s*${escapeRegExp(operator)}\\s*["']?${escapeRegExp(value)}["']?`,
        score: label.length + assignmentContextScore(source, match.index ?? 0, match[0].length),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function assignmentContextScore(source: string, index: number, length: number): number {
  const before = source.slice(Math.max(0, index - 50), index).toLowerCase();
  const after = source.slice(index + length, Math.min(source.length, index + length + 50)).toLowerCase();
  const window = `${before} ${after}`;
  let score = 0;
  if (/\b(bad|failed|fails|broke|broken|wrong|avoid|forbid|forbidden|leaks?)\b/.test(after)) score += 50;
  if (/do\s+not|don't|never|should\s+not|must\s+not/.test(window)) score += 40;
  if (/\b(keep|instead|correct|right|use|prefer|allowed)\b/.test(before)) score -= 60;
  if (/\b(keep|instead|correct|right|use|prefer|allowed)\b/.test(after)) score -= 25;
  return score;
}

function assignmentSources(text: string): string[] {
  return [text];
}

function pickDistinctiveToken(text: string, exclude: string[] = []): string | null {
  const excludeSet = new Set(exclude.map((t) => t.toLowerCase()));
  const candidates = new Map<string, { raw: string; score: number }>();
  for (const match of text.matchAll(CODE_TOKEN_RE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const token = raw.replace(/^[^\w.-]+|[^\w.-]+$/g, "");
    const isCodeLike = Boolean(match[1] ?? match[2]);
    if (!isDistinctiveToken(token, isCodeLike)) continue;
    const key = token.toLowerCase();
    if (excludeSet.has(key)) continue;
    const codeSpanBonus = match[1] ? 20 : match[2] ? 8 : 0;
    const shapeBonus =
      /[-_.:]/.test(token) ? 3 :
      /[A-Z]/.test(token.slice(1)) ? 2 :
      /\d/.test(token) ? 1 : 0;
    const score = token.length + codeSpanBonus + shapeBonus;
    const existing = candidates.get(key);
    if (!existing || score > existing.score) candidates.set(key, { raw: token, score });
  }
  const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
  return best?.raw ?? null;
}

/**
 * Reject tokens that produce nonsensical sensors: pure numbers, number ranges / line refs
 * (`1131-1186`), version-ish strings, and bare filenames (`enforce.ts`). A sensor built from these
 * fires on noise and trains agents to ignore the gate — the false-positive failure mode the harness
 * must avoid. (Real reproduced miss: a gotcha body referencing `enforce.ts:1131-1186` produced the
 * regex `enforce\.ts\s*:\s*1131-1186`.)
 */
const FILE_EXT_REF = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|md|json|ya?ml|toml|lock)\b/i;
function isDegenerateToken(token: string): boolean {
  if (/^[\d.\-:_]+$/.test(token)) return true; // pure number / range / line ref like 1131-1186
  if (/\d+\s*-\s*\d+/.test(token)) return true; // a numeric / line range embedded anywhere (e.g. 1131-1186)
  if (FILE_EXT_REF.test(token)) return true; // contains a filename reference (e.g. enforce.ts, enforce.ts:1131)
  // mostly digits (e.g. a version or id with a stray letter): <=1 letter among many digits
  const letters = (token.match(/[A-Za-z]/g) ?? []).length;
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits >= 3 && letters <= 1) return true;
  return false;
}

function isDistinctiveToken(token: string, isCodeLike: boolean): boolean {
  if (token.length < 4 || token.length > 80) return false;
  if (/^https?:\/\//i.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  // Prose / error-output fragments (e.g. a backtick span `CACError: Unknown option --runInBand`)
  // make literal patterns that never match a real source diff — the dead-sensor class. Reject them.
  if (/\S\s+\S+\s+\S/.test(token)) return false; // 3+ words → a phrase, not a code symbol
  if (/[A-Za-z]:\s/.test(token)) return false; // "Error: …" message shape
  if (isDegenerateToken(token)) return false;
  const lower = token.toLowerCase();
  if (SENSOR_STOPWORDS.has(lower)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  const shaped = /[-_.:\d]/.test(token) || /[A-Z]/.test(token.slice(1));
  return shaped || isCodeLike;
}

function isBoringValue(value: string): boolean {
  if (!value || value.length > 80) return true;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "false") return false;
  if (isDegenerateToken(value)) return true; // numbers / ranges / line refs / filenames are not real values
  return SENSOR_STOPWORDS.has(lower);
}

function sensorMessageFromBody(body: string, token: string): string {
  const instead = body.match(/\*\*Instead,\s*use:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  if (instead) return `Avoid ${token}; ${instead}`;
  const firstGuidance = body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("---"));
  return firstGuidance?.slice(0, 180) || `Avoid ${token}; this matched an autogenerated Hivelore sensor.`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
