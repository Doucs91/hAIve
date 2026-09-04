/**
 * propose_sensor — the agent (LLM), which understands the code, PROPOSES a sensor; core VALIDATES it.
 *
 * This is the "generate via the LLM-in-the-loop, validate deterministically" half of making the
 * auto-generation layer excellent. The heuristic generator (suggestSensorFromMemory) only recognizes
 * a few shapes; an agent that has read the code can write a precise discriminating pattern. But a
 * proposal is only TRUSTED to hard-block after `judgeProposedSensor` proves it discriminates:
 *   - not brittle, and
 *   - SILENT on the current (presumed-correct) anchored code, and
 *   - FIRES on the bad example (from input, or extracted from the lesson body).
 * A rejected proposal is NOT written; the verdict tells the agent how to revise and re-propose.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCorrectApproachExamples,
  extractSensorExamples,
  extractTestFilePathsFromCommand,
  hasPendingTestMarker,
  isHarnessErrorOutput,
  explainSensorRejection,
  judgeProposedSensor,
  loadMemoriesFromDir,
  scrubbedCommandEnv,
  sensorPatternBrittleness,
  serializeMemory,
  type Sensor,
  type SensorTarget,
} from "@hivelore/core";
import { z } from "zod";
import type { HaiveContext } from "../context.js";
import { astEngineAvailable, astLangForPath, runAstSensorOnContent } from "../ast-sensors.js";

export const ProposeSensorInputSchema = {
  memory_id: z.string().min(1).describe("Id of the gotcha/attempt memory this sensor protects."),
  kind: z
    .enum(["regex", "ast", "shell", "test"])
    .default("regex")
    .describe(
      "regex = pattern matched on added diff lines (default; comments are stripped before matching, " +
      "but string literals are NOT — so a regex can still target a bad literal in a string). ast = an " +
      "ast-grep STRUCTURAL pattern (e.g. 'stripe.paymentIntents.create($$$)') matched on the AST of " +
      "changed files — comments AND strings can never false-positive, so PREFER ast for a parseable " +
      "language (JS/TS, Python, Go, Java, Rust, …) when the @ast-grep/napi engine is available; " +
      "`absent` is a sub-pattern that must be missing INSIDE the match (requires that optional engine). " +
      "shell|test = a COMMAND the gate runs " +
      "when the diff touches the sensor's paths — routes the team's own oracle (an existing test, an " +
      "invariant script) to this lesson. Command sensors only execute where enforcement.runCommandSensors=true.",
    ),
  pattern: z
    .string()
    .optional()
    .describe("kind=regex: regex matching the faulty usage; kind=ast: optional structural pattern (may be combined with `rule`)."),
  rule: z
    .record(z.unknown())
    .optional()
    .describe("kind=ast: full ast-grep Rule object (kind/inside/has/not/all/any/etc.). May be used alone or combined with pattern."),
  language: z
    .string()
    .optional()
    .describe("kind=ast: explicit built-in/dynamic language name for non-standard file extensions."),
  command: z
    .string()
    .optional()
    .describe("kind=shell|test: command to execute (e.g. 'npx vitest run tests/payments/refund.spec.ts'). Non-zero exit = the lesson fires."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("kind=shell|test: max runtime before the executor kills the command (default 120000)."),
  absent: z
    .string()
    .optional()
    .describe(
      "Regex for the CORRECT-usage marker (e.g. 'idempotencyKey'). When it appears in the window around " +
      "a match, the catch is suppressed — this is what makes the sensor discriminate the faulty call " +
      "from the correct one. STRONGLY recommended for 'X without Y' lessons.",
    ),
  bad_example: z
    .string()
    .optional()
    .describe("A code snippet that SHOULD match — proves the sensor catches the mistake. If omitted, examples are read from the lesson body."),
  severity: z
    .enum(["warn", "block"])
    .default("block")
    .describe("block = hard-fail the gate (accepted ONLY if it passes self-validation). warn = advisory."),
  message: z.string().optional().describe("LLM-facing fix message shown when it fires. Defaults to one derived from the lesson."),
  incident: z
    .string()
    .optional()
    .describe(
      "Provenance: the real incident this sensor guards — a ticket/prod ref ('prod #442', 'INC-1029', " +
      "'2026-06 refund overcharge'). Turns 'a test failed' into 'this reproduces the incident the test " +
      "exists to prevent'. Surfaced in the block message and the prevention receipt. Strongly recommended " +
      "for command/test sensors routed from a post-incident test.",
    ),
  red_ref: z
    .string()
    .optional()
    .describe(
      "kind=shell|test: prove the oracle actually catches the incident. A git ref (commit/branch) of " +
      "the PRE-FIX state; validation replays it in a scratch worktree and requires the command to FAIL " +
      "there (RED) in addition to passing on the current tree (GREEN). On success the sensor records " +
      "red_proven: true — 'the test demonstrably catches the incident', shown in the prevention receipt.",
    ),
  flags: z.string().optional().describe("Optional regex flags (e.g. 'i' for case-insensitive)."),
  require_present: z
    .boolean()
    .default(false)
    .describe(
      "kind=regex: make this a REQUIRED-PRESENCE invariant instead of a forbidden-pattern one. `pattern` " +
      "then names a line that must REMAIN in the anchored file; the sensor FIRES when a change REMOVES it. " +
      "Use for 'do not delete this critical line' lessons a diff-of-added-lines sensor cannot see. Validated " +
      "by requiring the pattern to be PRESENT in the current anchored code (there must be something to guard).",
    ),
  paths: z
    .array(z.string())
    .default([])
    .describe("Override scope paths. Defaults to the memory's anchor paths."),
  exclude: z
    .array(z.string())
    .default([])
    .describe(
      "Glob-ish paths the sensor must NOT fire on, even inside `paths`. Set this for a PRODUCTION-ONLY " +
      "lesson so it skips test doubles/fixtures — e.g. exclude ['**/*.test.*','**/*.spec.*'," +
      "'**/__tests__/**','**/*.stories.*','**/*.d.ts']. Leave empty for a lesson that IS about tests " +
      "(it should still fire there). Documentation files (.md/.rst/…) are already skipped automatically.",
    ),
  replace: z
    .boolean()
    .default(false)
    .describe(
      "Set true to DELIBERATELY replace a sensor already hand-authored on this memory. Without it, a " +
      "second proposal onto a memory that already carries a validated sensor is REFUSED — otherwise the " +
      "second call silently destroys the first while still answering accepted:true. One memory holds one " +
      "sensor; use a separate memory for a second, distinct symptom.",
    ),
};

export type ProposeSensorInput = {
  [K in keyof typeof ProposeSensorInputSchema]: z.infer<(typeof ProposeSensorInputSchema)[K]>;
};

export interface ProposeSensorOutput {
  accepted: boolean;
  memory_id: string;
  severity: "warn" | "block";
  /** Set when rejected — why, and how to revise. */
  reason?: string;
  guidance?: string;
  self_check: {
    silent_on_current: boolean;
    fires_on_bad: boolean | null;
    fired_on: string[];
  };
  file_path?: string;
}

function deriveMessage(body: string, pattern: string, absent?: string): string {
  const instead = body.match(/\*\*Instead,\s*use:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  if (absent) {
    const base = `${pattern} without ${absent}`;
    return instead ? `${base} — ${instead}` : `${base} — add the required companion.`;
  }
  const heading = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0 && !l.startsWith("---"));
  return heading?.slice(0, 180) || `Avoid ${pattern}.`;
}

/**
 * Read the PRESUMED-CORRECT contents of anchored files for sensor self-checks.
 *
 * "Silent on current" must test the last COMMITTED state (HEAD), not the working tree: an agent
 * typically proposes a sensor right after hitting the failure, while the bad pattern is still
 * sitting uncommitted in the anchored file — validating against the working tree then rejects
 * every honest proposal with fires-on-current. HEAD already passed the gate, so it is the
 * presumed-correct baseline; fall back to the working tree for files not yet in git.
 */
export async function readPresumedCorrectTargets(
  root: string,
  relPaths: string[],
): Promise<SensorTarget[]> {
  const targets: SensorTarget[] = [];
  for (const rel of relPaths) {
    try {
      // "./" keeps the path relative to cwd even if the project root is a git subdirectory.
      const content = execFileSync("git", ["show", `HEAD:./${rel}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      targets.push({ path: rel, content });
      continue;
    } catch { /* not in HEAD or not a git repo — fall back to the working tree */ }
    const abs = path.resolve(root, rel);
    if (!existsSync(abs)) continue;
    try {
      targets.push({ path: rel, content: await readFile(abs, "utf8") });
    } catch { /* unreadable — skip */ }
  }
  return targets;
}

/**
 * Minimal validation runner for command sensors (mirrors the CLI executor's classification —
 * the dependency direction is cli→mcp, so the full executor can't be imported here).
 */
function runCommandForValidation(
  command: string,
  root: string,
  timeoutMs = 120_000,
): { status: "passed" | "failed" | "unrunnable"; detail: string } {
  try {
    execFileSync("bash", ["-c", command], {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      // Same containment as the gate executor: an oracle gets a test-runner env, not credentials.
      env: { ...scrubbedCommandEnv(process.env), HIVELORE_SENSOR: "validation" },
    });
    return { status: "passed", detail: "exit 0" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; killed?: boolean; stdout?: Buffer; stderr?: Buffer };
    const out = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`.split("\n").filter(Boolean).slice(-8).join("\n");
    if (e.killed) return { status: "unrunnable", detail: `timed out after ${timeoutMs}ms` };
    if (e.status === 127 || e.status === 126 || e.code === "ENOENT") {
      return { status: "unrunnable", detail: e.status === 126 ? "command found but not executable" : "command not found" };
    }
    return { status: "failed", detail: out || `exit ${e.status ?? "?"}` };
  }
}

/**
 * Prove the oracle goes RED on the incident: replay `redRef` (the pre-fix state) in a scratch
 * `git worktree`, symlink the main tree's node_modules into it (a bare worktree has none — the
 * documented reason the HEAD-baseline trick doesn't transfer to command sensors), and require the
 * command to FAIL there. "unrunnable" is NOT proof — the oracle said nothing.
 */
function proveRedOnIncident(
  command: string,
  root: string,
  redRef: string,
  timeoutMs?: number,
): { proven: boolean; reason?: "red-ref-invalid" | "red-not-proven" | "red-unrunnable"; detail: string } {
  const worktree = path.join(os.tmpdir(), `hivelore-red-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let added = false;
  try {
    try {
      execFileSync("git", ["worktree", "add", "--detach", worktree, redRef], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      });
      added = true;
    } catch (err) {
      const e = err as { stderr?: Buffer };
      return { proven: false, reason: "red-ref-invalid", detail: (e.stderr?.toString() ?? String(err)).slice(0, 300) };
    }
    const mainModules = path.join(root, "node_modules");
    const wtModules = path.join(worktree, "node_modules");
    if (existsSync(mainModules) && !existsSync(wtModules)) {
      try { symlinkSync(mainModules, wtModules, "dir"); } catch { /* best-effort — the run will tell */ }
    }
    const run = runCommandForValidation(command, worktree, timeoutMs);
    if (run.status === "failed") {
      // A non-zero exit only proves RED if the oracle actually RAN and its ASSERTION failed. At the
      // pre-fix state the guarded code/test often does not exist yet, so the runner errors out
      // ("Cannot find module", a syntax error, "no tests found") before reaching any assertion —
      // that is a broken harness, not a demonstrated incident. Same honesty family as unrunnable≠failed.
      if (isHarnessErrorOutput(run.detail)) {
        return {
          proven: false,
          reason: "red-unrunnable",
          detail: `the oracle errored before reaching its assertion on the incident state, so it proves nothing there — ${run.detail}`,
        };
      }
      return { proven: true, detail: run.detail };
    }
    if (run.status === "passed") {
      return { proven: false, reason: "red-not-proven", detail: "oracle PASSED on the incident state — it does not catch the incident" };
    }
    return { proven: false, reason: "red-unrunnable", detail: run.detail };
  } finally {
    if (added) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore", timeout: 60_000 });
      } catch {
        try { rmSync(worktree, { recursive: true, force: true }); } catch { /* leave for tmp cleanup */ }
      }
    }
  }
}

export async function proposeSensor(
  input: ProposeSensorInput,
  ctx: HaiveContext,
): Promise<ProposeSensorOutput> {
  if (!existsSync(ctx.paths.memoriesDir)) {
    throw new Error(`No .ai/memories at ${ctx.paths.root}. Run 'hivelore init' first.`);
  }

  const kind = input.kind ?? "regex";
  if (kind === "regex") {
    if (!input.pattern) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "invalid-regex",
        guidance: "kind=regex requires a `pattern`.",
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
    // Validate the regex(es) compile before anything else.
    try {
      new RegExp(input.pattern, input.flags ?? "");
      if (input.absent) new RegExp(input.absent, input.flags ?? "");
    } catch (err) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "invalid-regex",
        guidance: `The pattern or absent regex does not compile: ${String(err)}`,
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
  } else if (kind === "ast") {
    if (!input.pattern?.trim() && !input.rule) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "invalid-pattern",
        guidance: "kind=ast requires a structural `pattern` or a full ast-grep `rule` object.",
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
  } else if (!input.command?.trim()) {
    return {
      accepted: false,
      memory_id: input.memory_id,
      severity: input.severity,
      reason: "invalid-command",
      guidance: "kind=shell|test requires a `command` (the check the gate will execute).",
      self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
    };
  }

  const loaded = await loadMemoriesFromDir(ctx.paths.memoriesDir);
  const found = loaded.find(({ memory }) => memory.frontmatter.id === input.memory_id);
  if (!found) {
    throw new Error(`No memory found with id ${input.memory_id}`);
  }

  // Guard against SILENT sensor loss: a second proposal carrying a DIFFERENT guardrail onto a
  // memory that already holds a hand-authored (non-autogen) sensor used to overwrite the first
  // while answering accepted:true — a team believed a rule enforced when its guardrail no longer
  // existed. Refuse that unless the caller opts in with replace=true. Two flows stay allowed:
  //   • upgrading/refining the SAME sensor (same pattern/command) — e.g. warn → block, tune `absent`;
  //   • replacing an autogen (warn) suggestion — that IS the mem_tried → propose_sensor loop.
  const existingSensor = found.memory.frontmatter.sensor;
  const sameGuardrail =
    !!existingSensor &&
    existingSensor.kind === kind &&
    (input.pattern ?? "") === (existingSensor.pattern ?? "") &&
    (input.command ?? "") === (existingSensor.command ?? "") &&
    JSON.stringify(input.rule ?? null) === JSON.stringify(existingSensor.rule ?? null);
  if (existingSensor && existingSensor.autogen === false && !sameGuardrail && !input.replace) {
    const shape =
      existingSensor.kind === "regex"
        ? `pattern=${existingSensor.pattern ?? "?"}`
        : existingSensor.kind === "ast"
          ? "an ast rule"
          : `command=${existingSensor.command ?? "?"}`;
    return {
      accepted: false,
      memory_id: input.memory_id,
      severity: input.severity,
      reason: "sensor-exists",
      guidance:
        `This memory already carries a validated ${existingSensor.severity} sensor (kind=${existingSensor.kind}, ${shape}). ` +
        `Proposing a DIFFERENT one would REPLACE it — pass replace=true to overwrite it deliberately, or capture this ` +
        `second symptom as a separate memory so both guardrails survive. One memory holds one sensor.`,
      self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      file_path: found.filePath,
    };
  }

  // A sensor on a personal (gitignored) memory only guards THIS machine — the lesson would still
  // repeat on every other clone and in CI. Nudge promotion whenever an accepted sensor lands on one.
  const personalScopeNudge =
    found.memory.frontmatter.scope === "personal"
      ? ` Note: this lesson is personal-scoped, so the sensor guards only YOUR machine (personal memories are gitignored). Promote it so the gate travels with the repo: hivelore memory promote ${input.memory_id}.`
      : "";

  // ── AST sensors: same doctrine as regex (silent-on-current, fires-on-bad, anti-brittleness) but
  // structural — the matcher is the optional ast-grep engine, so "engine missing" must reject a
  // block proposal (an unvalidatable guard must not claim to block). ──
  if (kind === "ast") {
    const pattern = input.pattern?.trim();
    if (!(await astEngineAvailable()) && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "ast-engine-missing",
        guidance:
          "The optional AST engine is not installed, so this proposal cannot be validated — a block " +
          "sensor is only trusted after proof. Install it (`npm i -g @ast-grep/napi`, or add it to the repo) and re-propose.",
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
    const brittleAst = pattern ? sensorPatternBrittleness(pattern) : null;
    if (brittleAst && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "brittle",
        guidance: `The pattern is brittle (${brittleAst}). Use a durable structural pattern, then re-propose.`,
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
    const anchorPathsAst = input.paths.length > 0 ? input.paths : found.memory.frontmatter.anchor.paths;
    const currentTargetsAst = await readPresumedCorrectTargets(ctx.paths.root, anchorPathsAst);
    const firedOnAst: string[] = [];
    for (const target of currentTargetsAst) {
      const scan = await runAstSensorOnContent({ pattern, rule: input.rule, language: input.language, absent: input.absent, content: target.content, filePath: target.path });
      if (scan.status === "invalid-pattern") {
        return {
          accepted: false,
          memory_id: input.memory_id,
          severity: input.severity,
          reason: "invalid-pattern",
          guidance: `The ast-grep pattern is invalid: ${scan.detail ?? "unparseable"}. Fix it and re-propose.`,
          self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
        };
      }
      if (scan.status === "ok" && scan.matches.length > 0) firedOnAst.push(target.path);
    }
    if (firedOnAst.length > 0 && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "fires-on-current",
        guidance:
          `The pattern matches the CURRENT (correct) code in ${firedOnAst.join(", ")}. Add/tighten the ` +
          "'absent' companion sub-pattern so correct usage is excluded, then re-propose.",
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: firedOnAst },
      };
    }
    const badExamplesAst = [
      ...(input.bad_example ? [input.bad_example] : []),
      ...extractSensorExamples(found.memory.body),
    ];
    let firesOnBadAst: boolean | null = null;
    if (badExamplesAst.length > 0 && (await astEngineAvailable())) {
      // Parse examples with the anchor's language (fallback tsx — the most permissive JS grammar).
      const exampleLang = anchorPathsAst.find((p) => astLangForPath(p, input.language) !== null) ?? "example.tsx";
      firesOnBadAst = false;
      for (const example of badExamplesAst) {
        const scan = await runAstSensorOnContent({ pattern, rule: input.rule, language: input.language, absent: input.absent, content: example, filePath: exampleLang });
        if (scan.status === "ok" && scan.matches.length > 0) { firesOnBadAst = true; break; }
      }
    }
    if (firesOnBadAst === false && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "missed-bad-example",
        guidance: "The pattern did not match the bad example structurally, so it won't catch the mistake. Adjust it, then re-propose.",
        self_check: { silent_on_current: firedOnAst.length === 0, fires_on_bad: false, fired_on: [] },
      };
    }
    const sensorAst: Sensor = {
      kind: "ast",
      ...(pattern ? { pattern } : {}),
      ...(input.rule ? { rule: input.rule } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.absent ? { absent: input.absent } : {}),
      paths: anchorPathsAst,
      ...(input.exclude?.length ? { exclude: input.exclude } : {}),
      message: input.message?.trim() || deriveMessage(found.memory.body, pattern ?? "AST rule", input.absent),
      ...(input.incident?.trim() ? { incident: input.incident.trim() } : {}),
      severity: input.severity,
      autogen: false,
      last_fired: null,
    };
    await writeFile(found.filePath, serializeMemory({ frontmatter: { ...found.memory.frontmatter, sensor: sensorAst }, body: found.memory.body }), "utf8");
    return {
      accepted: true,
      memory_id: input.memory_id,
      severity: input.severity,
      guidance:
        "Structural sensor accepted — it matches the AST, so comments/strings can never false-positive." +
        ((await astEngineAvailable()) ? "" : " Note: the AST engine is not installed here; the sensor is UNRUNNABLE (warn-only) until @ast-grep/napi is available.") +
        personalScopeNudge,
      self_check: { silent_on_current: firedOnAst.length === 0, fires_on_bad: firesOnBadAst, fired_on: firedOnAst },
      file_path: found.filePath,
    };
  }

  // ── Command sensors: the oracle must PASS on the presumed-correct current tree ──
  // (the behaviour analogue of "silent on current"). A failing oracle would block every
  // commit; an unrunnable one proves nothing. Both reject `block`; warn is advisory.
  if (kind === "shell" || kind === "test") {
    // A STILL-PENDING oracle (it.todo / skip stub) passes on anything — arming it as `block`
    // would report protection that does not exist. Refuse until the assertion is written.
    const referencedTests = extractTestFilePathsFromCommand(input.command!.trim())
      .filter((rel) => existsSync(path.resolve(ctx.paths.root, rel)));
    const pendingTests: string[] = [];
    for (const rel of referencedTests) {
      try {
        if (hasPendingTestMarker(await readFile(path.resolve(ctx.paths.root, rel), "utf8"))) pendingTests.push(rel);
      } catch { /* unreadable — let the command run speak for itself */ }
    }
    if (pendingTests.length > 0 && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "oracle-pending",
        guidance:
          `The routed test is still a PENDING stub (${pendingTests.join(", ")}) — it passes on anything, so the ` +
          "sensor would enforce nothing while reporting protection. Write the assertion (RED on the incident, " +
          "GREEN once fixed), run it, then re-propose.",
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: pendingTests },
      };
    }
    const verdictCmd = runCommandForValidation(input.command!.trim(), ctx.paths.root, input.timeout_ms);
    const anchorPathsCmd = input.paths.length > 0 ? input.paths : found.memory.frontmatter.anchor.paths;

    // Prove-RED: mandatory for block, optional evidence for warn. GREEN on current is necessary
    // but weak — it cannot distinguish "the
    // test catches the incident" from "the test passes on everything". A red_ref makes the claim
    // demonstrable: the same oracle must FAIL on the replayed pre-fix state.
    let redProven = false;
    if (input.red_ref?.trim()) {
      const red = proveRedOnIncident(input.command!.trim(), ctx.paths.root, input.red_ref.trim(), input.timeout_ms);
      if (!red.proven && input.severity === "block") {
        return {
          accepted: false,
          memory_id: input.memory_id,
          severity: input.severity,
          reason: red.reason ?? "red-not-proven",
          guidance:
            red.reason === "red-ref-invalid"
              ? `red_ref could not be checked out (${red.detail}). Pass a valid commit/ref of the pre-fix state.`
              : red.reason === "red-unrunnable"
                ? `The oracle could not RUN on the incident state (${red.detail}) — it proves nothing there. Fix the command or drop red_ref.`
                : "The oracle PASSED on the incident state, so it does not catch the incident it claims to guard. " +
                  "Strengthen the assertion until it goes RED on red_ref, then re-propose. Output: " + red.detail.slice(0, 300),
          self_check: { silent_on_current: verdictCmd.status === "passed", fires_on_bad: false, fired_on: [] },
        };
      }
      redProven = red.proven;
    }

    if (verdictCmd.status !== "passed" && input.severity === "block") {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: verdictCmd.status === "unrunnable" ? "command-unrunnable" : "fails-on-current",
        guidance:
          verdictCmd.status === "unrunnable"
            ? `The command could not run (${verdictCmd.detail}). Fix the command (or timeout_ms), then re-propose.`
            : "The command FAILS on the current tree — the presumed-correct state must pass, or the gate would " +
              "block every commit. Revert the faulty diff (or fix the check), then re-propose. " +
              `Output tail:\n${verdictCmd.detail}`,
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: anchorPathsCmd },
      };
    }
    // A blocking behavioural claim must be demonstrated, not inferred from GREEN alone. Without
    // an incident state, an oracle that always exits zero is indistinguishable from a real guard.
    if (input.severity === "block" && !input.red_ref?.trim()) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "red-required",
        guidance:
          "A blocking shell/test sensor requires `red_ref`: the oracle must PASS on the current " +
          "tree and FAIL on the pre-fix incident state. Pass the incident commit/ref, or propose " +
          "the sensor at warn severity until RED can be proven.",
        self_check: { silent_on_current: true, fires_on_bad: null, fired_on: [] },
      };
    }
    const sensorCmd: Sensor = {
      kind,
      command: input.command!.trim(),
      ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
      paths: anchorPathsCmd,
      ...(input.exclude?.length ? { exclude: input.exclude } : {}),
      message: input.message?.trim() || deriveMessage(found.memory.body, input.command!.trim(), undefined),
      ...(input.incident?.trim() ? { incident: input.incident.trim() } : {}),
      ...(redProven ? { red_proven: true } : {}),
      severity: input.severity,
      autogen: false,
      last_fired: null,
    };
    const nextCmd = {
      frontmatter: { ...found.memory.frontmatter, sensor: sensorCmd },
      body: found.memory.body,
    };
    await writeFile(found.filePath, serializeMemory(nextCmd), "utf8");
    return {
      accepted: true,
      memory_id: input.memory_id,
      severity: input.severity,
      guidance:
        (verdictCmd.status === "passed"
          ? "Command oracle passes on the current tree; the gate now runs it when the diff touches the sensor's paths (requires enforcement.runCommandSensors=true)."
          : `Accepted at warn severity, but note: ${verdictCmd.status} on the current tree (${verdictCmd.detail}).`) +
        (redProven
          ? " RED proven: the oracle demonstrably FAILS on the incident state (red_ref) — recorded as red_proven."
          : " This warn-only oracle is not RED-proven; pass red_ref before promoting it to block.") +
        (pendingTests.length > 0
          ? ` Note: the routed test is still a PENDING stub (${pendingTests.join(", ")}) — it passes on anything; write the assertion to make this oracle real.`
          : "") +
        personalScopeNudge,
      self_check: { silent_on_current: verdictCmd.status === "passed", fires_on_bad: redProven ? true : null, fired_on: [] },
      file_path: found.filePath,
    };
  }

  const anchorPaths = input.paths.length > 0 ? input.paths : found.memory.frontmatter.anchor.paths;
  const currentTargets = await readPresumedCorrectTargets(ctx.paths.root, anchorPaths);

  const badExamples = [
    ...(input.bad_example ? [input.bad_example] : []),
    ...extractSensorExamples(found.memory.body),
  ];
  // The lesson's stated correct approach (its `Instead, use:` snippet) is code the sensor must never
  // fire on — a block pattern that matches it is inverted (it blocks the recommended fix).
  const correctExamples = extractCorrectApproachExamples(found.memory.body);

  // ── Presence invariant (require_present): the pattern must REMAIN present; it fires on deletion.
  // Validation is the inverse of the forbidden-pattern kind — the marker MUST be present in the
  // current anchored code, or there is nothing to guard (and it would fire on every commit). ──
  if (input.require_present) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern!, input.flags ?? "");
    } catch (err) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "invalid-regex",
        guidance: `The pattern does not compile: ${String(err)}`,
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
    const presentIn = currentTargets.filter((t) => re.test(t.content));
    if (currentTargets.length > 0 && presentIn.length === 0) {
      return {
        accepted: false,
        memory_id: input.memory_id,
        severity: input.severity,
        reason: "presence-marker-absent",
        guidance:
          `A require_present sensor guards a line that must STAY. The pattern is not present in the ` +
          `current anchored code (${anchorPaths.join(", ") || "no anchor paths"}), so there is nothing to ` +
          `guard and it would fire on every commit. Anchor it to the file that contains the line, and make ` +
          `the pattern match that line exactly.`,
        self_check: { silent_on_current: false, fires_on_bad: null, fired_on: [] },
      };
    }
    const presenceSensor: Sensor = {
      kind: "regex",
      pattern: input.pattern!,
      require_present: true,
      ...(input.flags ? { flags: input.flags } : {}),
      paths: anchorPaths,
      ...(input.exclude?.length ? { exclude: input.exclude } : {}),
      message: input.message?.trim() || deriveMessage(found.memory.body, input.pattern!, undefined),
      ...(input.incident?.trim() ? { incident: input.incident.trim() } : {}),
      severity: input.severity,
      autogen: false,
      last_fired: null,
    };
    await writeFile(found.filePath, serializeMemory({ frontmatter: { ...found.memory.frontmatter, sensor: presenceSensor }, body: found.memory.body }), "utf8");
    return {
      accepted: true,
      memory_id: input.memory_id,
      severity: input.severity,
      guidance:
        `Presence invariant accepted — the gate fires when a change removes this line from ${anchorPaths.join(", ") || "the anchored file(s)"}.` +
        personalScopeNudge,
      self_check: { silent_on_current: true, fires_on_bad: null, fired_on: [] },
      file_path: found.filePath,
    };
  }

  const sensor: Sensor = {
    kind: "regex",
    pattern: input.pattern!,
    ...(input.absent ? { absent: input.absent } : {}),
    ...(input.flags ? { flags: input.flags } : {}),
    paths: anchorPaths,
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    message: input.message?.trim() || deriveMessage(found.memory.body, input.pattern!, input.absent),
    ...(input.incident?.trim() ? { incident: input.incident.trim() } : {}),
    severity: input.severity,
    autogen: false, // deliberately authored by the agent and validated — higher trust than heuristic
    last_fired: null,
  };

  const verdict = judgeProposedSensor(sensor, { currentTargets, badExamples, correctExamples });
  const self_check = {
    silent_on_current: verdict.self_check.silent_on_current,
    fires_on_bad: verdict.self_check.fires_on_bad,
    fired_on: verdict.self_check.fired_on,
  };

  if (!verdict.accepted) {
    const guidance = explainSensorRejection(verdict, { style: "mcp", memoryId: input.memory_id });
    return {
      accepted: false,
      memory_id: input.memory_id,
      severity: input.severity,
      reason: verdict.reason ?? "rejected",
      guidance,
      self_check,
    };
  }

  // Accepted — persist the sensor onto the memory frontmatter.
  const next = {
    frontmatter: { ...found.memory.frontmatter, sensor },
    body: found.memory.body,
  };
  await writeFile(found.filePath, serializeMemory(next), "utf8");

  // A warn sensor that FIRES on the current code is not a clean pass: either the pattern also matches
  // legitimate code (permanent noise agents learn to ignore — field report §3.4), or the faulty code
  // is merely still present (arm-then-fix). Say so instead of a bland accepted:true; a block proposal
  // in the same state is already rejected upstream, so this only reaches warn.
  const firesOnCurrentCaveat =
    !verdict.self_check.silent_on_current && verdict.self_check.fired_on.length > 0
      ? `⚠ NOT silent on the current code — it fires on: ${verdict.self_check.fired_on.join(", ")}. ` +
        `If that code is CORRECT, this warning is noise: tighten the pattern or add an 'absent' companion. ` +
        `If the faulty code is merely still present, fix it, then re-propose at severity "block".`
      : "";
  const guidance = [firesOnCurrentCaveat, proseSelfMatchCaveat(input.pattern!, input.flags, found.memory.body), personalScopeNudge.trim()]
    .filter(Boolean)
    .join(" ");

  return {
    accepted: true,
    memory_id: input.memory_id,
    severity: input.severity,
    ...(guidance ? { guidance } : {}),
    self_check,
    file_path: found.filePath,
  };
}

/**
 * Does the candidate pattern match the PROSE of the memory it guards?
 *
 * Field report 2026-09-04 §3.1: a colour-token sensor blocked the CSS comment that explained the
 * very rule it enforces, and the contradiction was visible three days earlier — the memory body
 * already contained the forbidden class names. So it is worth saying out loud at proposal time.
 *
 * It is a CAVEAT, not a rejection: documenting a rule almost always means quoting what it forbids,
 * so refusing on a self-match would refuse nearly every well-written sensor. The engine's own
 * defences (comments are blanked before matching, documentation files are out of scope unless named
 * exactly) are what make the self-match harmless — this note tells the author which of them is
 * carrying the sensor, so they notice when neither applies.
 */
function proseSelfMatchCaveat(pattern: string, flags: string | undefined, body: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, [...new Set(["m", ...(flags ?? "").split("")])].filter(Boolean).join(""));
  } catch {
    return "";
  }
  const hit = body.split("\n").find((line) => { re.lastIndex = 0; return re.test(line); });
  if (!hit) return "";
  return (
    `Note: the pattern also matches this memory's own prose (“${hit.trim().slice(0, 80)}”). ` +
    "That is normal — a rule usually names what it forbids — and it is harmless because comments are " +
    "blanked before matching and documentation files are only scanned when a sensor names them exactly. " +
    "But it means any code comment or docstring quoting the rule is one engine change away from being " +
    "flagged: keep the pattern anchored to a code-only shape (a call, an assignment, an attribute) " +
    "rather than to a bare word."
  );
}
