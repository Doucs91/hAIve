/**
 * `hivelore observe` — passive-capture endpoint for Claude Code's PostToolUse hook.
 *
 * Reads a single JSON payload on stdin (Claude Code's hook protocol) and appends
 * a compact observation record to `.ai/.cache/observations.jsonl`. The session-end
 * step later distills these records into proposed memories.
 *
 * Critical properties:
 *   - exit 0 ALWAYS (a hook that errors interrupts the user's flow)
 *   - bounded I/O (caps stdin read; no LLM call; no network)
 *   - tolerant to missing .ai/ (silently no-op if haive isn't initialized here)
 */
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { findProjectRoot, resolveHaivePaths } from "@hivelore/core";

const MAX_STDIN_BYTES = 256 * 1024; // 256 KB cap
const TRUNCATE_FIELD = 800;

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown> | string;
  cwd?: string;
  session_id?: string;
}

interface Observation {
  ts: string;
  session_id?: string;
  cwd?: string;
  tool: string;
  summary: string;
  files?: string[];
  /** True when the tool response signals a failure — candidate for mem_tried. */
  failure_hint?: true;
}

function truncate(s: unknown, max = TRUNCATE_FIELD): string {
  if (s == null) return "";
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function extractFiles(payload: HookPayload): string[] {
  const files = new Set<string>();
  const input = payload.tool_input ?? {};
  for (const k of ["file_path", "path", "notebook_path"]) {
    const v = input[k];
    if (typeof v === "string") files.add(v);
  }
  // Bash tool: try to spot file-ish args
  const cmd = input["command"];
  if (typeof cmd === "string") {
    const matches = cmd.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|md|json|yml|yaml)\b/g);
    if (matches) for (const m of matches) files.add(m);
  }
  return [...files].slice(0, 8);
}

function buildSummary(payload: HookPayload): string {
  const tool = payload.tool_name ?? "?";
  const input = payload.tool_input ?? {};
  if (tool === "Bash") return `Bash: ${truncate(input["command"], 200)}`;
  if (tool === "Edit") return `Edit ${truncate(input["file_path"], 200)}`;
  if (tool === "Write") return `Write ${truncate(input["file_path"], 200)}`;
  return `${tool}: ${truncate(input, 200)}`;
}

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        process.stdin.destroy();
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 2000); // hard cap so a stuck hook never blocks Claude
  });
}

/**
 * Commands that routinely exit non-zero WITHOUT a real failure, so a bare exit code is not a
 * failure signal for them: `grep`/`rg` (exit 1 = no match), `find`, `test`/`[`/`[[`, `diff`
 * (exit 1 = differs), and ANY pipeline (the last stage — often `head` — sets the exit code, and
 * SIGPIPE/`head` closing a pipe makes earlier stages "fail"). These were the false positives that
 * trained agents to ignore the "N failures detected" nudge — don't flag them on exit code alone.
 */
export function isExpectedNonzeroExit(command: string): boolean {
  if (!command) return false;
  if (command.includes("|")) return true; // pipeline — exit code is the last stage's, not meaningful
  if (/\|\|\s*true\b/.test(command)) return true; // explicitly tolerated
  return /(^|\s|;|&&)(grep|egrep|fgrep|rg|ag|find|test|diff|\[\[?)\b/.test(command);
}

/**
 * Detect whether the tool response signals a failure worth capturing as mem_tried.
 * Checks exit codes for Bash and error patterns in all tool responses.
 * Best-effort — false negatives are acceptable; false positives create noise (and noise that gets
 * ignored is worse than silence), so bare non-zero exits from grep/pipes/etc. are NOT flagged.
 */
/**
 * Did the command report SUCCESS? A tool that exited 0 did not fail, whatever words are in its
 * output — and that is the whole fix for the defect below.
 */
function exitedCleanly(payload: HookPayload): boolean {
  const response = payload.tool_response;
  if (typeof response !== "object" || response === null) return false;
  const code = (response as Record<string, unknown>)["exit_code"] ??
               (response as Record<string, unknown>)["exitCode"];
  return code === 0;
}

export function detectFailure(payload: HookPayload): boolean {
  const response = payload.tool_response;
  if (!response) return false;

  const responseText = typeof response === "string" ? response : JSON.stringify(response);

  // A command that exited 0 SUCCEEDED. Its output may still contain the words the signatures below
  // look for — because it printed source code, a log, a regex, or this very function.
  //
  // Measured on 256 real observations from this repo: every one of the 3 `failure_hint` flags was a
  // false positive, and the third fired while investigating the second — `grep -A22 "function
  // detectFailure" observe.ts` was marked as a failure because its output is the list of strings
  // this function matches on. Reading the detector triggered the detector.
  //
  // Exit codes stay authoritative (guarded by `isExpectedNonzeroExit`); text signatures are now
  // only a fallback for when the harness reports no code at all. False negatives are acceptable
  // here and false positives are not: noise that gets ignored is worse than silence.
  if (exitedCleanly(payload)) return false;

  // Bash: a non-zero exit is a failure signal ONLY when the command isn't one that routinely
  // exits non-zero (grep no-match, a pipeline's last stage, etc.). Real build/test/runtime errors
  // still get caught by the reliable text signatures below regardless of the command shape.
  if (payload.tool_name === "Bash") {
    const command = typeof payload.tool_input?.["command"] === "string"
      ? (payload.tool_input["command"] as string)
      : "";
    if (typeof response === "object") {
      const code = (response as Record<string, unknown>)["exit_code"] ??
                   (response as Record<string, unknown>)["exitCode"];
      if (typeof code === "number" && code !== 0 && !isExpectedNonzeroExit(command)) return true;
    }
    // Text patterns that reliably indicate a hard failure in Bash output
    if (/\b(command not found|No such file or directory|ERR_MODULE_NOT_FOUND|ENOENT|EACCES)\b/.test(responseText)) return true;
    if (/\berror TS\d+:/i.test(responseText)) return true; // TypeScript compile error
  }

  // Edit/Write/Read: tool-level error (file not found, permission denied)
  if (["Edit", "Write", "Read"].includes(payload.tool_name ?? "")) {
    if (typeof response === "object") {
      const err = (response as Record<string, unknown>)["error"] ??
                  (response as Record<string, unknown>)["message"];
      if (typeof err === "string" && err.length > 0) return true;
    }
  }

  // Generic: error messages that suggest something went wrong
  if (/^\s*(Error|FAILED|ENOENT|EACCES|unknown option|Cannot find module)\b/m.test(responseText)) return true;

  return false;
}

export function registerObserve(program: Command): void {
  program
    .command("observe")
    .description(
      "Passive-capture endpoint for Claude Code PostToolUse hooks.\n\n" +
      "  Reads a JSON payload on stdin and appends an observation record to\n" +
      "  .ai/.cache/observations.jsonl. Always exits 0; never blocks the agent.\n" +
      "  Wired up automatically by `hivelore enforce install`.",
    )
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: { dir?: string }) => {
      try {
        const raw = await readStdin(MAX_STDIN_BYTES);
        if (!raw.trim()) return;

        let payload: HookPayload;
        try {
          payload = JSON.parse(raw) as HookPayload;
        } catch {
          return; // malformed payload — silently no-op
        }

        const root = (() => {
          try { return findProjectRoot(opts.dir ?? payload.cwd); } catch { return null; }
        })();
        if (!root) return;

        const paths = resolveHaivePaths(root);
        if (!existsSync(paths.haiveDir)) return; // not a haive project

        const failureHint = detectFailure(payload);
        const observation: Observation = {
          ts: new Date().toISOString(),
          session_id: payload.session_id,
          cwd: payload.cwd,
          tool: payload.tool_name ?? "?",
          summary: buildSummary(payload),
          files: extractFiles(payload),
          ...(failureHint ? { failure_hint: true as const } : {}),
        };

        const cacheDir = path.join(paths.haiveDir, ".cache");
        await mkdir(cacheDir, { recursive: true });
        await appendFile(
          path.join(cacheDir, "observations.jsonl"),
          JSON.stringify(observation) + "\n",
          "utf8",
        );
      } catch {
        // Hooks must never break the user's flow — swallow everything.
      }
    });
}
