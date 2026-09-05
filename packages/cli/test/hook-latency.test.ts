import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/index.js");

/**
 * The Claude Code hooks run on EVERY Edit/Write/Bash. A regression that keeps the process alive
 * after the payload is read is invisible per call and costs 15-20 min per session in aggregate
 * (field reports 2026-09-05 §3 / §7: 2.3 s per hook, both of them, ~250 tool calls a session).
 * The cause was an un-cleared 2 s stdin hard-cap timer holding the event loop open, so the guard
 * that matters is wall time: the hook must exit as soon as stdin closes.
 */
const PAYLOAD = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } });
const MAX_MS = 1500;

async function timeHook(cwd: string, args: string[]): Promise<number> {
  const started = Date.now();
  await new Promise<void>((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd, stdio: ["pipe", "ignore", "ignore"] });
    child.on("close", () => resolve());
    child.stdin.end(PAYLOAD);
  });
  return Date.now() - started;
}

describe("per-tool-call hook latency", () => {
  let dir = "";
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "haive-hook-latency-")); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("`enforce pre-tool-use` exits as soon as stdin closes", async () => {
    expect(await timeHook(dir, ["enforce", "pre-tool-use"])).toBeLessThan(MAX_MS);
  });

  it("`observe` exits as soon as stdin closes", async () => {
    expect(await timeHook(dir, ["observe"])).toBeLessThan(MAX_MS);
  });
});
