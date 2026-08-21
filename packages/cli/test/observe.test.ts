import { describe, expect, it } from "vitest";
import { detectFailure, isExpectedNonzeroExit } from "../src/commands/observe.js";

describe("isExpectedNonzeroExit", () => {
  it("treats grep / pipelines / test as expected non-zero", () => {
    expect(isExpectedNonzeroExit("grep -i error file.txt")).toBe(true);
    expect(isExpectedNonzeroExit("pnpm build 2>&1 | head -15")).toBe(true);
    expect(isExpectedNonzeroExit("rg foo")).toBe(true);
    expect(isExpectedNonzeroExit("test -f x || true")).toBe(true);
    expect(isExpectedNonzeroExit("diff a b")).toBe(true);
  });
  it("does not excuse a plain failing command", () => {
    expect(isExpectedNonzeroExit("pnpm build")).toBe(false);
    expect(isExpectedNonzeroExit("node script.js")).toBe(false);
    expect(isExpectedNonzeroExit("")).toBe(false);
  });
});

describe("detectFailure", () => {
  it("does NOT flag a grep|head that exits non-zero (the false-positive case)", () => {
    const flagged = detectFailure({
      tool_name: "Bash",
      tool_input: { command: "pnpm build 2>&1 | grep -iE 'error' | head -15" },
      tool_response: { exit_code: 1 },
    });
    expect(flagged).toBe(false);
  });

  it("flags a plain command that exits non-zero", () => {
    const flagged = detectFailure({
      tool_name: "Bash",
      tool_input: { command: "node build.js" },
      tool_response: { exit_code: 1 },
    });
    expect(flagged).toBe(true);
  });

  it("flags a real error signature even inside a pipeline", () => {
    const flagged = detectFailure({
      tool_name: "Bash",
      tool_input: { command: "pnpm build | tee log" },
      tool_response: "src/x.ts: error TS2304: Cannot find name 'foo'",
    });
    expect(flagged).toBe(true);
  });
});

/**
 * Precision, measured rather than assumed.
 *
 * On 256 real observations captured in this repository, ALL THREE `failure_hint` flags were false
 * positives — and the third fired while investigating the second: running
 * `grep -A22 "function detectFailure" observe.ts` was recorded as a failure because its output is
 * the list of error strings this function matches on. Reading the detector triggered the detector.
 *
 * The rule that fixes the whole class: a command that exited 0 did not fail, whatever words appear
 * in its output.
 */
describe("detectFailure — a command that exited 0 did not fail", () => {
  const bash = (command: string, response: Record<string, unknown>) =>
    detectFailure({ tool_name: "Bash", tool_input: { command }, tool_response: response });

  it("does not flag a successful grep whose OUTPUT quotes error strings", () => {
    expect(
      bash('grep -A22 "function detectFailure" packages/cli/src/commands/observe.ts', {
        exit_code: 0,
        stdout:
          'if (/\\b(command not found|No such file or directory|ERR_MODULE_NOT_FOUND|ENOENT|EACCES)\\b/.test(t)) return true;',
      }),
    ).toBe(false);
  });

  it("does not flag a passing typecheck piped through grep", () => {
    expect(
      bash('pnpm -r typecheck 2>&1 | grep -E "error|Error|FAIL" | head -20', { exit_code: 0, stdout: "" }),
    ).toBe(false);
  });

  it("still flags a command that actually failed", () => {
    expect(bash("pnpm build", { exit_code: 1, stdout: "error TS2304: Cannot find name 'churn'." })).toBe(true);
    expect(bash("node missing.js", { exit_code: 1, stdout: "Error: Cannot find module './missing.js'" })).toBe(true);
  });

  it("keeps the text fallback when the harness reports no exit code at all", () => {
    expect(
      detectFailure({
        tool_name: "Bash",
        tool_input: { command: "node app.js" },
        tool_response: "Error: Cannot find module 'express'",
      }),
    ).toBe(true);
  });

  it("still ignores a bare non-zero exit from a command that routinely returns one", () => {
    expect(bash("grep -q needle haystack.txt", { exit_code: 1, stdout: "" })).toBe(false);
  });
});
