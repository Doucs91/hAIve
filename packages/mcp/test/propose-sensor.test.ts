import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMemoriesFromDir, resolveHaivePaths } from "@hivelore/core";
import type { HaiveContext } from "../src/context.js";
import { memTried } from "../src/tools/mem-tried.js";
import { proposeSensor } from "../src/tools/propose-sensor.js";

/**
 * propose_sensor: the agent proposes a sensor; core validates it before trusting it to block.
 * A discriminating proposal (silent on the correct code, fires on the bad example) is accepted;
 * a broad proposal that matches the current correct code is rejected and NOT written.
 */
describe("proposeSensor — agent proposes, core validates", () => {
  let workDir: string;
  let ctx: HaiveContext;
  let memoryId: string;
  const anchor = "src/pay.ts";
  const correctCode = [
    "export async function charge(a: number, key: string) {",
    "  return stripe.paymentIntents.create(",
    "    { amount: a },",
    "    { idempotencyKey: key },",
    "  );",
    "}",
  ].join("\n");

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-propose-"));
    const paths = resolveHaivePaths(workDir);
    await mkdir(paths.haiveDir, { recursive: true });
    ctx = { paths };
    // The anchored file currently holds CORRECT code (idempotencyKey present).
    await mkdir(path.join(workDir, "src"), { recursive: true });
    await writeFile(path.join(workDir, anchor), correctCode, "utf8");
    // A captured lesson to attach the sensor to.
    const tried = await memTried(
      {
        what: "stripe.paymentIntents.create without an idempotencyKey",
        why_failed: "a retry double-charged the customer",
        instead: "pass { idempotencyKey } as the second arg",
        scope: "team",
        module: undefined,
        tags: [],
        paths: [anchor],
        author: undefined,
      },
      ctx,
    );
    memoryId = tried.id;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function loadSensor() {
    const all = await loadMemoriesFromDir(ctx.paths.memoriesDir);
    return all.find(({ memory }) => memory.frontmatter.id === memoryId)?.memory.frontmatter.sensor;
  }

  it("accepts a discriminating block proposal (silent on current, fires on bad)", async () => {
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "stripe\\.paymentIntents\\.create",
        absent: "idempotencyKey",
        bad_example: "stripe.paymentIntents.create({ amount: 1 });",
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(true);
    expect(out.self_check.silent_on_current).toBe(true);
    expect(out.self_check.fires_on_bad).toBe(true);
    const sensor = await loadSensor();
    expect(sensor?.severity).toBe("block");
    expect(sensor?.absent).toBe("idempotencyKey");
  });

  it("rejects a broad block proposal that fires on the current correct code, and does NOT write it", async () => {
    const before = await loadSensor();
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "stripe\\.paymentIntents\\.create",
        absent: undefined, // broad — matches correct usage too
        bad_example: undefined,
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("fires-on-current");
    expect(out.self_check.fired_on).toContain(anchor);
    // unchanged on disk
    expect(await loadSensor()).toEqual(before);
  });

  it("validates against HEAD, not the working tree still holding the documented bad pattern", async () => {
    // The realistic sequence: the agent writes the bad pattern, hits the failure, calls mem_tried,
    // then proposes a sensor — all BEFORE reverting. The uncommitted bad code must not reject the
    // proposal with fires-on-current; HEAD (last gated state) is the presumed-correct baseline.
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
      cwd: workDir,
    });
    await writeFile(
      path.join(workDir, anchor),
      `${correctCode}\nstripe.paymentIntents.create({ amount: 2 });\n`,
      "utf8",
    );
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "stripe\\.paymentIntents\\.create",
        absent: "idempotencyKey",
        bad_example: "stripe.paymentIntents.create({ amount: 1 });",
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(true);
    expect(out.self_check.silent_on_current).toBe(true);
  });

  it("refuses to silently overwrite a validated sensor, unless replace=true", async () => {
    const first = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "stripe\\.paymentIntents\\.create",
        absent: "idempotencyKey",
        bad_example: "stripe.paymentIntents.create({ amount: 1 });",
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(first.accepted).toBe(true);
    const firstSensor = await loadSensor();
    expect(firstSensor?.autogen).toBe(false);

    // A second, different proposal must NOT silently replace the first (the field-report bug:
    // both answered accepted:true, the second overwrote the first, protection was lost).
    const second = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "process\\.env\\.SECRET",
        absent: undefined,
        bad_example: "const s = process.env.SECRET;",
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("sensor-exists");
    // The first sensor is untouched on disk.
    expect(await loadSensor()).toEqual(firstSensor);

    // With replace=true the caller opts in to overwrite deliberately.
    const replaced = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "stripe\\.paymentIntents\\.create",
        absent: "idempotencyKey",
        bad_example: "stripe.paymentIntents.create({ amount: 1 });",
        severity: "block",
        message: "Replaced deliberately.",
        flags: undefined,
        paths: [],
        replace: true,
      },
      ctx,
    );
    expect(replaced.accepted).toBe(true);
    expect((await loadSensor())?.message).toBe("Replaced deliberately.");
  });

  it("command sensor: a passing oracle can be persisted at warn without RED proof", async () => {
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        kind: "test",
        pattern: undefined,
        command: "node -e \"process.exit(0)\"",
        timeout_ms: 30_000,
        absent: undefined,
        bad_example: undefined,
        severity: "warn",
        message: "Refund invariant broken — see the lesson.",
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(true);
    const sensor = await loadSensor();
    expect(sensor?.kind).toBe("test");
    expect(sensor?.command).toContain("process.exit(0)");
    expect(sensor?.timeout_ms).toBe(30_000);
    expect(sensor?.severity).toBe("warn");
  });

  it("command sensor: a block proposal whose oracle FAILS on the current tree is rejected (fails-on-current)", async () => {
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        kind: "test",
        pattern: undefined,
        command: "node -e \"console.error('refund exceeds capture'); process.exit(1)\"",
        timeout_ms: undefined,
        absent: undefined,
        bad_example: undefined,
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("fails-on-current");
    expect(out.guidance).toContain("presumed-correct");
  });

  it("command sensor: an unrunnable command is rejected with its own reason, never as a test failure", async () => {
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        kind: "shell",
        pattern: undefined,
        command: "definitely-not-a-real-binary-hivelore --check",
        timeout_ms: undefined,
        absent: undefined,
        bad_example: undefined,
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("command-unrunnable");
  });

  it("rejects an invalid regex without throwing", async () => {
    const out = await proposeSensor(
      {
        memory_id: memoryId,
        pattern: "(unclosed",
        absent: undefined,
        bad_example: undefined,
        severity: "block",
        message: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("invalid-regex");
  });
});

describe("proposeSensor — personal-scope promotion nudge", () => {
  let workDir: string;
  let ctx: HaiveContext;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-propose-nudge-"));
    const paths = resolveHaivePaths(workDir);
    await mkdir(paths.haiveDir, { recursive: true });
    ctx = { paths };
    await mkdir(path.join(workDir, "src"), { recursive: true });
    await writeFile(path.join(workDir, "src/pay.ts"), "export const ok = 1;\n", "utf8");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("nudges promotion when an accepted sensor lands on a personal memory; silent on team", async () => {
    const personal = await memTried(
      { what: "personal trap", why_failed: "x", scope: "personal", tags: [], paths: ["src/pay.ts"] },
      ctx,
    );
    const out = await proposeSensor(
      {
        memory_id: personal.id,
        pattern: "moment\\(",
        bad_example: "const d = moment();",
        severity: "block",
        kind: "regex",
        absent: undefined,
        command: undefined,
        timeout_ms: undefined,
        message: undefined,
        incident: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(true);
    expect(out.guidance).toMatch(/personal-scoped/);
    expect(out.guidance).toMatch(new RegExp(`memory promote ${personal.id}`));

    const team = await memTried(
      { what: "team trap", why_failed: "x", scope: "team", tags: [], paths: ["src/pay.ts"] },
      ctx,
    );
    const outTeam = await proposeSensor(
      {
        memory_id: team.id,
        pattern: "dayjs\\(",
        bad_example: "const d = dayjs();",
        severity: "block",
        kind: "regex",
        absent: undefined,
        command: undefined,
        timeout_ms: undefined,
        message: undefined,
        incident: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(outTeam.accepted).toBe(true);
    expect(outTeam.guidance ?? "").not.toMatch(/personal-scoped/);
  });
});

describe("proposeSensor — a PENDING oracle must not arm a block sensor", () => {
  let workDir: string;
  let ctx: HaiveContext;
  let lessonId: string;
  const stub = [
    "// Post-incident guard generated by Hivelore from x.",
    'import { describe, it, expect } from "vitest";',
    'describe("incident", () => {',
    '  it.todo("reproduces the incident and stays fixed");',
    "});",
  ].join("\n");

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-pending-oracle-"));
    const paths = resolveHaivePaths(workDir);
    await mkdir(paths.haiveDir, { recursive: true });
    ctx = { paths };
    await mkdir(path.join(workDir, "tests/incidents"), { recursive: true });
    await writeFile(path.join(workDir, "tests/incidents/x.test.ts"), stub, "utf8");
    const tried = await memTried(
      { what: "pending oracle lesson", why_failed: "x", scope: "team", tags: [], paths: ["src/"] },
      ctx,
    );
    lessonId = tried.id;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects block with oracle-pending (a todo stub passes on anything = fake protection)", async () => {
    const out = await proposeSensor(
      {
        memory_id: lessonId,
        kind: "test",
        command: 'node -e "process.exit(0)" tests/incidents/x.test.ts',
        severity: "block",
        pattern: undefined,
        absent: undefined,
        bad_example: undefined,
        timeout_ms: undefined,
        message: undefined,
        incident: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("oracle-pending");
    expect(out.guidance).toMatch(/tests\/incidents\/x\.test\.ts/);
  });

  it("accepts warn but carries the pending-stub note; a real assertion arms block cleanly", async () => {
    const warn = await proposeSensor(
      {
        memory_id: lessonId,
        kind: "test",
        command: 'node -e "process.exit(0)" tests/incidents/x.test.ts',
        severity: "warn",
        pattern: undefined,
        absent: undefined,
        bad_example: undefined,
        timeout_ms: undefined,
        message: undefined,
        incident: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(warn.accepted).toBe(true);
    expect(warn.guidance).toMatch(/PENDING stub/);

    await writeFile(
      path.join(workDir, "tests/incidents/x.test.ts"),
      stub.replace('it.todo("reproduces the incident and stays fixed");', 'it("guards", () => { expect(1).toBe(1); });'),
      "utf8",
    );
    const block = await proposeSensor(
      {
        memory_id: lessonId,
        kind: "test",
        command: 'node -e "process.exit(0)" tests/incidents/x.test.ts',
        severity: "block",
        pattern: undefined,
        absent: undefined,
        bad_example: undefined,
        timeout_ms: undefined,
        message: undefined,
        incident: undefined,
        flags: undefined,
        paths: [],
      },
      ctx,
    );
    expect(block.accepted).toBe(false);
    expect(block.reason).toBe("red-required");
  });
});

describe("proposeSensor — prove-RED (red_ref) and env containment", () => {
  let workDir: string;
  let ctx: HaiveContext;
  let lessonId: string;
  let incidentSha: string;
  const oracle = `node -e "process.exit(require('fs').readFileSync('src/x.txt','utf8').includes('good')?0:1)"`;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-red-"));
    const paths = resolveHaivePaths(workDir);
    await mkdir(paths.haiveDir, { recursive: true });
    ctx = { paths };
    const { execSync } = await import("node:child_process");
    const git = (cmd: string) => execSync(cmd, { cwd: workDir, stdio: "pipe" });
    git("git init -b main");
    git("git config user.email t@t.co && git config user.name T");
    await mkdir(path.join(workDir, "src"), { recursive: true });
    // Incident state: the bug is present (oracle FAILS here).
    await writeFile(path.join(workDir, "src/x.txt"), "bad\n", "utf8");
    git("git add -A && git commit -m incident");
    incidentSha = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf8" }).trim();
    // Fixed state at HEAD (oracle PASSES here).
    await writeFile(path.join(workDir, "src/x.txt"), "good\n", "utf8");
    git("git add -A && git commit -m fix");
    const tried = await memTried(
      { what: "x.txt regressed to bad", why_failed: "incident", scope: "team", tags: [], paths: ["src/x.txt"] },
      ctx,
    );
    lessonId = tried.id;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const propose = (command: string, red_ref?: string, severity: "warn" | "block" = "block") =>
    proposeSensor(
      {
        memory_id: lessonId, kind: "test", command, severity, red_ref,
        pattern: undefined, absent: undefined, bad_example: undefined,
        timeout_ms: undefined, message: undefined, incident: undefined, flags: undefined, paths: [],
      },
      ctx,
    );

  it("accepts with red_proven when the oracle is GREEN on HEAD and RED on the incident ref", async () => {
    const out = await propose(oracle, incidentSha);
    expect(out.accepted).toBe(true);
    expect(out.guidance).toMatch(/RED proven/);
    const { readFile: rf } = await import("node:fs/promises");
    const written = await rf(out.file_path!, "utf8");
    expect(written).toContain("red_proven: true");
  });

  it("rejects red-not-proven when the oracle also passes on the incident state", async () => {
    const out = await propose('node -e "process.exit(0)"', incidentSha);
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("red-not-proven");
  });

  it("rejects red-unrunnable when the oracle ERRORS (missing module) on the incident state, not fails an assertion", async () => {
    // The exact false-RED class: at the pre-fix ref the guarded module does not exist yet, so the
    // oracle exits non-zero for "Cannot find module" — a broken harness, NOT a demonstrated incident.
    const { execSync } = await import("node:child_process");
    const git = (cmd: string) => execSync(cmd, { cwd: workDir, stdio: "pipe" });
    // A ref where src/mod.js is absent (oracle cannot load it).
    await writeFile(path.join(workDir, "placeholder.txt"), "x", "utf8");
    git("git add -A && git commit -m pre-module");
    const preModuleSha = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf8" }).trim();
    // HEAD adds the module so the oracle PASSES on the current tree (required before prove-RED runs).
    await writeFile(path.join(workDir, "src/mod.js"), "module.exports = { ok: () => 0 };\n", "utf8");
    git("git add -A && git commit -m add-module");
    const out = await propose(`node -e "require('./src/mod.js').ok()"`, preModuleSha);
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("red-unrunnable");
    expect(out.guidance).toMatch(/proves nothing|could not RUN/i);
  });

  it("rejects red-ref-invalid on a bogus ref, and requires red_ref for block", async () => {
    const bad = await propose(oracle, "not-a-real-ref-xyz");
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toBe("red-ref-invalid");
    const plain = await propose(oracle);
    expect(plain.accepted).toBe(false);
    expect(plain.reason).toBe("red-required");
  });

  it("passes red_ref to git without shell expansion", async () => {
    const marker = path.join(workDir, "shell-injection-marker");
    const out = await propose(oracle, `$(touch ${marker})`);
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("red-ref-invalid");
    await expect(import("node:fs/promises").then(({ access }) => access(marker))).rejects.toThrow();
  });

  it("runs the oracle with a scrubbed env — a block proposal whose command asserts the secret is ABSENT passes", async () => {
    process.env.TEST_SECRET_X_HIVE = "leak";
    try {
      const out = await propose('test -z "$TEST_SECRET_X_HIVE"', undefined, "warn");
      // Scrubbed env → the var is invisible → command exits 0 on current tree → accepted.
      expect(out.accepted).toBe(true);
    } finally {
      delete process.env.TEST_SECRET_X_HIVE;
    }
  });
});
