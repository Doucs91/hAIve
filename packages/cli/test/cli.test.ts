import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/index.js");

// Pin the agent context: the enforcement suite tests the AGENT workflow contract, and the
// relaxed human mode (v0.30.1) is env-driven — without pinning, results depend on whether the
// suite runs inside an agent shell (CLAUDECODE set locally) or a bare CI runner (no signals).
const PINNED_ENV: NodeJS.ProcessEnv = { ...process.env, HAIVE_AGENT: "1" };

async function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await exec("node", [CLI, ...args], { cwd, env: PINNED_ENV });
}

async function runWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd, env: PINNED_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

async function runAllowFailure(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd,
      env: { ...PINNED_ENV, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function writeLockstepPackageJsons(root: string, version: string): Promise<void> {
  const packageFiles = [
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/mcp/package.json",
    "packages/embeddings/package.json",
  ];
  for (const rel of packageFiles) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(
      path.join(root, rel),
      JSON.stringify({ name: rel === "package.json" ? "test-root" : rel, version, type: "module" }, null, 2) + "\n",
      "utf8",
    );
  }
}

describe("Hivelore CLI integration", () => {
  let workDir: string;

  beforeAll(async () => {
    if (!existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI}. Run \`pnpm build\` first.`);
    }
    workDir = await mkdtemp(path.join(tmpdir(), "haive-cli-test-"));
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("init creates the .ai/ structure and bridges", async () => {
    // --bridge-targets all: the default is now auto-detection (machine/repo clients + AGENTS.md);
    // this test exercises the full generation path independent of the machine it runs on.
    await run(workDir, ["init", "--dir", workDir, "--bridge-targets", "all"]);
    expect(existsSync(path.join(workDir, ".ai"))).toBe(true);
    expect(existsSync(path.join(workDir, ".ai/project-context.md"))).toBe(true);
    expect(existsSync(path.join(workDir, ".ai/memories/personal"))).toBe(true);
    expect(existsSync(path.join(workDir, ".ai/memories/team"))).toBe(true);
    expect(existsSync(path.join(workDir, ".ai/memories/module"))).toBe(true);
    expect(existsSync(path.join(workDir, ".ai", ".runtime", "README.md"))).toBe(true);
    // Native agent bridges are generated for every supported target (reach).
    expect(existsSync(path.join(workDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(workDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(workDir, ".github/copilot-instructions.md"))).toBe(true);
    expect(existsSync(path.join(workDir, ".cursor/rules/haive-memories.mdc"))).toBe(true);
    expect(existsSync(path.join(workDir, ".roo/rules/haive.md"))).toBe(true);
    expect(existsSync(path.join(workDir, "GEMINI.md"))).toBe(true);
    expect(existsSync(path.join(workDir, "CONVENTIONS.md"))).toBe(true);
    expect(existsSync(path.join(workDir, ".clinerules"))).toBe(true);
    // The complementary "always use the MCP" Cursor nudge is still written.
    expect(
      existsSync(path.join(workDir, ".cursor/rules/haive-mcp-required.mdc")),
    ).toBe(true);
    const claudeSettings = path.join(workDir, ".claude/settings.local.json");
    expect(existsSync(claudeSettings)).toBe(true);
    const hooks = await readFile(claudeSettings, "utf8");
    expect(hooks).toContain("hivelore enforce session-start");
    expect(hooks).toContain("hivelore enforce pre-tool-use");
    expect(existsSync(path.join(workDir, ".github/workflows/hivelore-enforcement.yml"))).toBe(true);
    const syncWorkflow = await readFile(path.join(workDir, ".github/workflows/hivelore-sync.yml"), "utf8");
    expect(syncWorkflow).toContain("Doucs91/hivelore/packages/github-action@v");
    expect(syncWorkflow).not.toContain("Doucs91/hivelore/packages/github-action@main");
    // No-op-safe harness quality regression gate is wired into the generated CI.
    expect(syncWorkflow).toContain("pr-eval-gate");
    expect(syncWorkflow).toContain("hivelore eval --regression-gate");
    const enforcementWorkflow = await readFile(path.join(workDir, ".github/workflows/hivelore-enforcement.yml"), "utf8");
    expect(enforcementWorkflow).toContain("HIVELORE_BASE_SHA");
    expect(enforcementWorkflow).toContain("HIVELORE_HEAD_SHA");
    expect(enforcementWorkflow).toContain("<!-- haive:prevention-receipt -->");
    expect(enforcementWorkflow).toContain("hivelore stats receipt --since 7d --comment");
    // The comment body is rendered by the CLI, never by a program inlined in YAML — an embedded
    // multi-line jq script is what made this generated workflow unparseable before v0.55.0.
    expect(enforcementWorkflow).not.toContain("jq -nr");
    expect(enforcementWorkflow).toContain("if: always() && github.event_name == 'pull_request'");
    expect(enforcementWorkflow).toContain("gh api --method PATCH");
    const config = JSON.parse(await readFile(path.join(workDir, ".ai/hivelore.config.json"), "utf8")) as {
      autopilot?: boolean;
      defaultScope?: string;
      defaultStatus?: string;
      autoRepair?: { context?: boolean; corpus?: boolean; codeMap?: boolean; codeSearch?: boolean };
      enforcement?: { mode?: string; requireBriefingFirst?: boolean; requireMemoryVerify?: boolean };
    };
    expect(config.autopilot).toBe(true);
    expect(config.defaultScope).toBe("team");
    expect(config.defaultStatus).toBe("validated");
    expect(config.autoRepair?.context).toBe(true);
    expect(config.autoRepair?.corpus).toBe(true);
    expect(config.autoRepair?.codeMap).toBe(true);
    expect(config.autoRepair?.codeSearch).toBe(true);
    expect(config.enforcement?.mode).toBe("strict");
    expect(config.enforcement?.requireBriefingFirst).toBe(true);
    expect(config.enforcement?.requireMemoryVerify).toBe(true);
  });

  it("init --stack seeds backend packs whose memories carry executable sensors", async () => {
    const stackDir = await mkdtemp(path.join(tmpdir(), "haive-stack-test-"));
    try {
      await run(stackDir, ["init", "--stack", "django,fastapi", "--no-bootstrap", "-y", "--dir", stackDir]);
      const teamDir = path.join(stackDir, ".ai/memories/team");
      const files = (await readdir(teamDir)).filter((f) => f.endsWith(".md"));
      expect(files.some((f) => f.includes("django"))).toBe(true);
      expect(files.some((f) => f.includes("fastapi"))).toBe(true);

      const debugFile = files.find((f) => f.includes("django-debug"));
      expect(debugFile).toBeDefined();
      const body = await readFile(path.join(teamDir, debugFile!), "utf8");
      expect(body).toContain("sensor:");
      expect(body).toContain("DEBUG");
      expect(body).toContain("severity: warn");

      // The seeded sensor must actually fire on a matching diff.
      const diffFile = path.join(stackDir, "bad.diff");
      await writeFile(
        diffFile,
        "diff --git a/settings.py b/settings.py\n--- a/settings.py\n+++ b/settings.py\n@@ -1 +1 @@\n+DEBUG = True\n",
        "utf8",
      );
      const { stdout } = await run(stackDir, ["sensors", "check", "--diff-file", diffFile, "--dir", stackDir]);
      expect(stdout).toContain("hit(s)");
      expect(stdout).toContain("django-debug");
    } finally {
      await rm(stackDir, { recursive: true, force: true });
    }
  });

  it("sync --inject-bridge injects into both CLAUDE.md and AGENTS.md", async () => {
    const bridgeDir = await mkdtemp(path.join(tmpdir(), "haive-bridge-test-"));
    try {
      // Explicit targets: default detection is machine-dependent (a bare CI runner has no
      // ~/.claude), and this test asserts on the CLAUDE.md bridge specifically.
      await run(bridgeDir, [
        "init", "--no-bootstrap", "--stack", "none", "-y",
        "--bridge-targets", "claude,agents", "--dir", bridgeDir,
      ]);
      await run(bridgeDir, [
        "memory", "add", "--type", "convention", "--slug", "bridge-demo",
        "--body", "Always use the bridge demo convention.", "--scope", "team", "--dir", bridgeDir,
      ]);
      await run(bridgeDir, ["sync", "--inject-bridge", "--quiet", "--dir", bridgeDir]);

      const claude = await readFile(path.join(bridgeDir, "CLAUDE.md"), "utf8");
      const agents = await readFile(path.join(bridgeDir, "AGENTS.md"), "utf8");
      expect(claude).toContain("bridge-demo");
      expect(claude).toContain("haive:bridge-start");
      expect(agents).toContain("haive:memories-start");
      expect(agents).toContain("haive:bridge-start");
      expect(agents).toContain("bridge-demo");
    } finally {
      await rm(bridgeDir, { recursive: true, force: true });
    }
  });

  it("native bridge generation preserves existing human content and appends only a managed block", async () => {
    const bridgeDir = await mkdtemp(path.join(tmpdir(), "haive-native-preserve-"));
    try {
      await mkdir(path.join(bridgeDir, ".github"), { recursive: true });
      await writeFile(path.join(bridgeDir, "AGENTS.md"), "# Human agent notes\n\nKeep this root guidance.\n", "utf8");
      await writeFile(
        path.join(bridgeDir, ".github/copilot-instructions.md"),
        "# Human Copilot notes\n\nKeep this Copilot guidance.\n",
        "utf8",
      );

      await run(bridgeDir, ["init", "--no-bootstrap", "--stack", "none", "-y", "--dir", bridgeDir]);

      const agents = await readFile(path.join(bridgeDir, "AGENTS.md"), "utf8");
      const copilot = await readFile(path.join(bridgeDir, ".github/copilot-instructions.md"), "utf8");

      expect(agents).toContain("Keep this root guidance.");
      expect(agents).toContain("haive:bridge-start");
      expect(agents).toContain("Working through Hivelore");
      expect(copilot).toContain("Keep this Copilot guidance.");
      expect(copilot).toContain("haive:bridge-start");
      expect(copilot).toContain("Working through Hivelore");
    } finally {
      await rm(bridgeDir, { recursive: true, force: true });
    }
  });

  it("bridges sync skips native files with broken Hivelore markers instead of overwriting them", async () => {
    const bridgeDir = await mkdtemp(path.join(tmpdir(), "haive-native-invalid-"));
    try {
      await run(bridgeDir, ["init", "--no-bootstrap", "--stack", "none", "--no-bridges", "-y", "--dir", bridgeDir]);
      const agentsPath = path.join(bridgeDir, "AGENTS.md");
      const broken = "# Human agent notes\n\n<!-- haive:bridge-start -->\npartial generated block\n";
      await writeFile(agentsPath, broken, "utf8");

      const sync = await run(bridgeDir, ["bridges", "sync", "--only", "agents", "--dir", bridgeDir]);
      const after = await readFile(agentsPath, "utf8");
      expect(after).toBe(broken);
      expect(sync.stderr + sync.stdout).toContain("marker mismatch");
      expect(sync.stdout).toContain("1 skipped");

      const status = await run(bridgeDir, ["bridges", "status", "--dir", bridgeDir]);
      expect(status.stdout).toContain("agents");
      expect(status.stdout).toContain("invalid");
    } finally {
      await rm(bridgeDir, { recursive: true, force: true });
    }
  });

  it("eval --baseline then --compare reports a delta", async () => {
    const evalDir = await mkdtemp(path.join(tmpdir(), "haive-eval-test-"));
    try {
      await run(evalDir, ["init", "--no-bootstrap", "--stack", "none", "-y", "--dir", evalDir]);
      // A memory carrying a sensor that fires on a known-bad diff (deterministic, no embeddings).
      const memFile = path.join(evalDir, ".ai/memories/team/2099-01-01-gotcha-evaltest.md");
      await writeFile(
        memFile,
        [
          "---",
          "id: 2099-01-01-gotcha-evaltest",
          "scope: team",
          "type: gotcha",
          "status: validated",
          "created_at: 2099-01-01T00:00:00.000Z",
          "anchor:",
          "  paths: []",
          "  symbols: []",
          "tags: []",
          "sensor:",
          "  kind: regex",
          '  pattern: "EVILPATTERN"',
          '  message: "no evil"',
          "  severity: warn",
          "  autogen: false",
          "  last_fired: null",
          "---",
          "# Evil pattern",
          "Do not use EVILPATTERN.",
        ].join("\n"),
        "utf8",
      );
      const specFile = path.join(evalDir, "spec.json");
      await writeFile(
        specFile,
        JSON.stringify({
          sensors: [
            { name: "evil", diff: "+ const x = EVILPATTERN;", expect_fire_ids: ["2099-01-01-gotcha-evaltest"] },
          ],
        }),
        "utf8",
      );

      const blFile = path.join(evalDir, "bl.json");
      await run(evalDir, ["eval", "--spec", specFile, "--baseline", "--baseline-file", blFile, "--dir", evalDir]);
      expect(existsSync(blFile)).toBe(true);

      const { stdout } = await run(evalDir, ["eval", "--spec", specFile, "--compare", "--baseline-file", blFile, "--dir", evalDir]);
      expect(stdout).toContain("vs baseline");
      expect(stdout).toContain("UNCHANGED");
      expect(stdout).toContain("catch-rate");
    } finally {
      await rm(evalDir, { recursive: true, force: true });
    }
  });

  it("ingest --from sonar-api degrades gracefully when no credentials are configured", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "haive-sonarapi-test-"));
    try {
      await run(d, ["init", "--no-bootstrap", "--stack", "none", "-y", "--dir", d]);
      let out = "";
      try {
        const r = await run(d, ["ingest", "--from", "sonar-api", "--dir", d]);
        out = r.stdout + r.stderr;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        out = (err.stdout ?? "") + (err.stderr ?? "");
      }
      // Clear, actionable message — never a crash/stack trace; the rest of Hivelore is unaffected.
      expect(out).toMatch(/sonar-url|SONAR_HOST_URL/);
      expect(out).not.toMatch(/at Object\.|node:internal/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("eval --regression-gate is a no-op (exit 0) when no baseline exists", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "haive-gate-test-"));
    try {
      await run(d, ["init", "--no-bootstrap", "--stack", "none", "-y", "--dir", d]);
      const memFile = path.join(d, ".ai/memories/team/2099-01-01-gotcha-gate.md");
      await writeFile(
        memFile,
        [
          "---", "id: 2099-01-01-gotcha-gate", "scope: team", "type: gotcha", "status: validated",
          "created_at: 2099-01-01T00:00:00.000Z", "anchor:", "  paths: []", "  symbols: []", "tags: []",
          "sensor:", "  kind: regex", '  pattern: "GATEPATTERN"', '  message: "no gate"',
          "  severity: warn", "  autogen: false", "  last_fired: null", "---", "# Gate", "Avoid GATEPATTERN.",
        ].join("\n"),
        "utf8",
      );
      const specFile = path.join(d, "spec.json");
      await writeFile(
        specFile,
        JSON.stringify({ sensors: [{ name: "g", diff: "+ GATEPATTERN", expect_fire_ids: ["2099-01-01-gotcha-gate"] }] }),
        "utf8",
      );
      // No baseline written → gate must skip, not fail.
      const r = await run(d, ["eval", "--spec", specFile, "--regression-gate", "--dir", d]);
      expect(r.stdout + r.stderr).toMatch(/regression gate skipped/i);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("init writes project-level MCP configs with HAIVE_PROJECT_ROOT", async () => {
    // These files are written by hivelore init to fix the multi-project CWD bug.
    const cursorMcp = path.join(workDir, ".cursor", "mcp.json");
    const vscodeMcp = path.join(workDir, ".vscode", "mcp.json");
    const claudeMcp = path.join(workDir, ".mcp.json");

    expect(existsSync(cursorMcp)).toBe(true);
    expect(existsSync(vscodeMcp)).toBe(true);
    expect(existsSync(claudeMcp)).toBe(true);

    const cursorConfig = JSON.parse(await readFile(cursorMcp, "utf8")) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    expect(cursorConfig.mcpServers["hivelore"]).toBeDefined();
    expect(cursorConfig.mcpServers["hivelore"]!.command).toBe("hivelore");
    expect(cursorConfig.mcpServers["hivelore"]!.args).toEqual(["mcp", "--stdio"]);
    expect(cursorConfig.mcpServers["hivelore"]!.env?.["HAIVE_PROJECT_ROOT"]).toBe(workDir);
  });

  it("agent status reports the selected Hivelore mode", async () => {
    const { stdout } = await run(workDir, ["agent", "status", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as {
      initialized: boolean;
      recommended_mode: string;
      project_mcp: Array<{ present: boolean }>;
    };
    expect(report.initialized).toBe(true);
    expect(["mcp", "wrapped", "fallback"]).toContain(report.recommended_mode);
    expect(report.project_mcp.some((item) => item.present)).toBe(true);
  });

  it("agent setup writes project configs and mode metadata without global config", async () => {
    const { stdout } = await run(workDir, ["agent", "setup", "--no-global", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as {
      detection: { recommended_mode: string };
      mode_file: string;
      global_skipped_reason?: string;
    };
    expect(["mcp", "wrapped", "fallback"]).toContain(report.detection.recommended_mode);
    expect(report.global_skipped_reason).toContain("disabled");
    expect(existsSync(report.mode_file)).toBe(true);
  });

  it("doctor --json exposes scores and structured sections", async () => {
    const { stdout } = await run(workDir, ["doctor", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as {
      scores: { protection_score: number; context_quality_score: number; corpus_quality_score: number };
      sections: Record<string, unknown[]>;
      findings: Array<{ code: string; section: string }>;
    };
    expect(report.scores.protection_score).toEqual(expect.any(Number));
    expect(report.scores.context_quality_score).toEqual(expect.any(Number));
    expect(report.scores.corpus_quality_score).toEqual(expect.any(Number));
    expect(report.sections["Agent coverage"]).toBeDefined();
    expect(report.findings.every((finding) => typeof finding.section === "string")).toBe(true);
  });

  it("doctor treats stack-pack seeds as generic guidance, not anchorless repo policy", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-stack-doctor-"));
    try {
      await writeFile(
        path.join(repo, "package.json"),
        JSON.stringify({ dependencies: { next: "latest", react: "latest" } }, null, 2),
        "utf8",
      );
      // Stack packs are opt-in since v0.55.0 (an empty corpus is the honest default), so ask for
      // them explicitly — which also keeps the opt-in path covered.
      await run(repo, ["init", "--no-mcp-setup", "--stack", "auto", "--dir", repo]);
      const { stdout } = await run(repo, ["doctor", "--json", "--dir", repo]);
      const report = JSON.parse(stdout) as { findings: Array<{ code: string; severity: string }> };

      expect(report.findings.some((finding) => finding.code === "stack-pack-seeds")).toBe(true);
      expect(report.findings.some((finding) => finding.code === "anchorless-majority")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("default help only shows the core harness surface", async () => {
    const { stdout } = await run(workDir, ["--help"]);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("briefing");
    expect(stdout).toContain("enforce");
    expect(stdout).toContain("Golden path (what you type day to day)");
    expect(stdout).not.toContain("playback");
    expect(stdout).not.toContain("snapshot");
    expect(stdout).not.toContain("benchmark");
  });

  it("default root help documents the golden path and CLI<->MCP verb parity", async () => {
    const { stdout } = await run(workDir, ["--help"]);
    expect(stdout).toContain("Golden path");
    // The memory verbs are advertised as mirroring the MCP tool names.
    expect(stdout).toContain("memory save/search/get/delete");
    expect(stdout).toContain("mem_save/mem_search/mem_get/mem_delete");
  });

  it("advanced help exposes maintenance commands but not the removed experimental surface", async () => {
    const { stdout } = await run(workDir, ["--advanced", "--help"]);
    expect(stdout).toContain("benchmark");
    expect(stdout).toContain("dashboard");
    // v0.32.0 surface reduction — deleted commands must not resurface (match command
    // names at line start; prose like "observability snapshot" is fine).
    expect(stdout).not.toMatch(/\n  playback[\s[]/);
    expect(stdout).not.toMatch(/\n  snapshot[\s[]/);
    expect(stdout).not.toMatch(/\n  hub[\s[]/);
    expect(stdout).not.toMatch(/\n  tui[\s[]/);
  });

  it("phase C/D/E: bench is renamed to selftest (alias bench), and advanced families are documented", async () => {
    // C: selftest is canonical; bench kept as alias (commander renders "selftest|bench").
    const advanced = await run(workDir, ["--advanced", "--help"]);
    expect(advanced.stdout).toContain("selftest");
    // E: the advanced surface is grouped by family — only in advanced help, so the
    // default golden-path help stays focused (those names must not leak into core).
    expect(advanced.stdout).toContain("Advanced surface, by family");
    expect(advanced.stdout).toContain("reports:");
    expect(advanced.stdout).toContain("runtime:");
    const help = await run(workDir, ["--help"]);
    expect(help.stdout).not.toContain("Advanced surface, by family");
  });

  it("default memory help hides corpus maintenance commands", async () => {
    const { stdout } = await run(workDir, ["memory", "--help"]);
    expect(stdout).toContain("add");
    expect(stdout).toContain("tried");
    expect(stdout).toContain("lint");
    expect(stdout).not.toContain("conflict-candidates");
    expect(stdout).not.toContain("import-changelog");
    expect(stdout).not.toContain("auto-promote");
  });

  it("init adds project-level MCP configs to .gitignore", async () => {
    const gitignore = await readFile(path.join(workDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".cursor/mcp.json");
    expect(gitignore).toContain(".vscode/mcp.json");
    expect(gitignore).toContain(".mcp.json");
  });

  it("memory add uses autopilot defaults by default", async () => {
    await run(workDir, [
      "memory",
      "add",
      "--type", "convention",
      "--slug", "use pnpm",
      "--tags", "tooling,setup",
      "--body", "Always use pnpm in this project.",
      "--dir", workDir,
    ]);
    const teamDir = path.join(workDir, ".ai/memories/team");
    const files = await readdir(teamDir);
    expect(files.length).toBe(1);
    const content = await readFile(path.join(teamDir, files[0]!), "utf8");
    expect(content).toContain("scope: team");
    expect(content).toContain("status: validated");
    expect(content).toContain("Always use pnpm in this project.");
    // Embeddings index generation is BEST-EFFORT: it needs the Transformers.js model, which can fail
    // to download in CI (the old hard assertion flaked releases). Assert it when the model produced an
    // index; never fail the build when the model is unavailable — the behavior under test is the
    // autopilot memory write above, not the optional index.
    const indexPath = path.join(workDir, ".ai/.cache/embeddings/embeddings-index.json");
    if (existsSync(indexPath)) {
      const idx = JSON.parse(await readFile(indexPath, "utf8")) as { entries?: unknown[] };
      expect(Array.isArray(idx.entries) ? idx.entries.length : 1).toBeGreaterThan(0);
    } else {
      console.warn("[cli.test] embeddings index not generated (model unavailable) — skipping optional index assertion");
    }
  });

  it("memory list returns the added memory", async () => {
    const { stdout } = await run(workDir, ["memory", "list", "--dir", workDir]);
    expect(stdout).toContain("convention");
    expect(stdout).toContain("use-pnpm");
  });

  it("memory query finds by tag substring", async () => {
    const { stdout } = await run(workDir, ["memory", "query", "tooling", "--dir", workDir]);
    expect(stdout).toContain("use-pnpm");
  });

  it("memory add --activation writes skill progressive-disclosure triggers", async () => {
    await run(workDir, [
      "memory", "add",
      "--type", "skill",
      "--slug", "deploy-playbook",
      "--activation-keyword", "deploy,release",
      "--activation-glob", "scripts/**",
      "--body", "# Deploy\n\nSteps to deploy this service.",
      "--dir", workDir,
    ]);
    const teamDir = path.join(workDir, ".ai/memories/team");
    const files = await readdir(teamDir);
    const withContent = await Promise.all(
      files.map(async (f) => ({ f, c: await readFile(path.join(teamDir, f), "utf8") })),
    );
    const skill = withContent.find((x) => x.c.includes("type: skill"));
    expect(skill).toBeDefined();
    expect(skill!.c).toContain("activation:");
    expect(skill!.c).toContain("deploy");
    expect(skill!.c).toContain("scripts/**");
  });

  it("memory feedback records an applied outcome", async () => {
    const { stdout: addOut } = await run(workDir, [
      "memory", "add",
      "--type", "convention",
      "--slug", "fb-target",
      "--body", "A memory to give feedback on.",
      "--dir", workDir,
    ]);
    const id = /id=(\S+)/.exec(addOut)?.[1];
    expect(id).toBeTruthy();
    const { stdout } = await run(workDir, ["memory", "feedback", id!, "--applied", "--dir", workDir]);
    expect(stdout).toContain("Recorded 'applied'");
    expect(stdout).toContain("applied=1");
  });

  it("sensors promote flips an autogenerated sensor to block", async () => {
    await run(workDir, [
      "memory",
      "tried",
      "--what", "Enabling open in view",
      "--why-failed", "`open-in-view=true` leaks sessions.",
      "--instead", "keep open-in-view=false",
      "--paths", "src/app.properties",
      "--scope", "team",
      "--dir", workDir,
    ]);

    const teamDir = path.join(workDir, ".ai/memories/team");
    const files = await readdir(teamDir);
    const sensorFile = files.find((file) => file.includes("enabling-open-in-view"));
    expect(sensorFile).toBeDefined();
    const id = sensorFile!.replace(/\.md$/, "");
    // The CLI no longer auto-writes a heuristic sensor on `memory tried`; author a validated warn
    // sensor through the propose path (the CLI mirror of MCP propose_sensor) before promoting it.
    const proposed = await run(workDir, [
      "sensors", "propose", id,
      "--pattern", "open-in-view\\s*=\\s*[\"']?true[\"']?",
      "--severity", "warn",
      "--json",
      "--dir", workDir,
    ]);
    expect(JSON.parse(proposed.stdout)).toMatchObject({ accepted: true, memory_id: id, severity: "warn" });
    const rejectedJson = await runAllowFailure(workDir, [
      "sensors", "propose", "missing-memory", "--pattern", "x", "--json", "--dir", workDir,
    ]);
    expect(rejectedJson.code).toBe(1);
    expect(JSON.parse(rejectedJson.stdout)).toMatchObject({ accepted: false, reason: "memory-not-found" });
    let content = await readFile(path.join(teamDir, sensorFile!), "utf8");
    expect(content).toContain("sensor:");
    expect(content).toContain("severity: warn");

    await expect(run(workDir, ["sensors", "promote", id, "--dir", workDir])).rejects.toMatchObject({ code: 1 });

    const sensorlessFile = files.find((file) => file.includes("use-pnpm"));
    expect(sensorlessFile).toBeDefined();
    const sensorlessId = sensorlessFile!.replace(/\.md$/, "");
    await expect(
      run(workDir, ["sensors", "promote", sensorlessId, "--yes", "--dir", workDir]),
    ).rejects.toMatchObject({ code: 1 });

    await run(workDir, ["sensors", "promote", id, "--yes", "--dir", workDir]);

    content = await readFile(path.join(teamDir, sensorFile!), "utf8");
    expect(content).toContain("severity: block");
  });

  it("eval automatically includes .ai/eval/spec.json sensor cases", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-eval-spec-"));
    try {
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      await run(repo, [
        "memory",
        "tried",
        "--what", "Bad feature flag",
        "--why-failed", "`open-in-view=true` leaks sessions.",
        "--instead", "keep open-in-view=false",
        "--paths", "src/app.properties",
        "--scope", "team",
        "--dir", repo,
      ]);
      const teamFiles = await readdir(path.join(repo, ".ai/memories/team"));
      const sensorId = teamFiles.find((file) => file.includes("bad-feature-flag"))!.replace(/\.md$/, "");
      // The CLI no longer auto-writes a sensor; author a validated one via the propose path.
      await run(repo, [
        "sensors", "propose", sensorId,
        "--pattern", "open-in-view\\s*=\\s*[\"']?true[\"']?",
        "--severity", "warn",
        "--dir", repo,
      ]);
      await mkdir(path.join(repo, ".ai/eval"), { recursive: true });
      await writeFile(
        path.join(repo, ".ai/eval/spec.json"),
        JSON.stringify({
          sensors: [
            {
              name: "feature flag regression",
              diff:
                "diff --git a/src/app.properties b/src/app.properties\n" +
                "+++ b/src/app.properties\n" +
                "@@\n" +
                "+open-in-view=true\n",
              paths: ["src/app.properties"],
              expect_fire_ids: [sensorId],
            },
          ],
        }, null, 2),
        "utf8",
      );

      const { stdout } = await run(repo, ["eval", "--json", "--dir", repo]);
      const report = JSON.parse(stdout) as {
        spec_source: string;
        report: { sensors: { catch_rate: number; cases: unknown[] } | null };
      };
      expect(report.spec_source).toContain(".ai/eval/spec.json");
      expect(report.report.sensors?.catch_rate).toBe(1);
      expect(report.report.sensors?.cases.length).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("semantic eval fails closed when no embeddings index is available", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-semantic-eval-missing-"));
    try {
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await run(repo, [
        "memory", "add", "--type", "convention", "--scope", "team", "--slug", "semantic-target",
        "--body", "Always validate semantic ranking with a real index.", "--dir", repo,
      ]);
      const [memoryFile] = await readdir(path.join(repo, ".ai/memories/team"));
      const memoryId = path.basename(memoryFile!, ".md");
      await mkdir(path.join(repo, ".ai/eval"), { recursive: true });
      await writeFile(
        path.join(repo, ".ai/eval/spec.json"),
        JSON.stringify({
          retrieval: [{
            name: "semantic index required",
            task: "How must semantic ranking be validated?",
            expect_ids: [memoryId],
          }],
        }),
        "utf8",
      );
      await rm(path.join(repo, ".ai/.cache/embeddings"), { recursive: true, force: true });
      const result = await runAllowFailure(repo, ["eval", "--semantic-ranking", "--dir", repo]);
      expect(result.code).toBe(1);
      expect(result.stderr + result.stdout).toContain("Semantic eval requested");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("memory promote moves a memory from personal to team with status=proposed", async () => {
    await run(workDir, [
      "memory",
      "add",
      "--type", "gotcha",
      "--slug", "manual review",
      "--scope", "personal",
      "--body", "Keep this local until promoted.",
      "--dir", workDir,
    ]);

    const personalDir = path.join(workDir, ".ai/memories/personal");
    const beforeFiles = await readdir(personalDir);
    const id = beforeFiles[0]!.replace(/\.md$/, "");

    await run(workDir, ["memory", "promote", id, "--dir", workDir]);

    const afterPersonal = await readdir(personalDir);
    expect(afterPersonal.length).toBe(0);

    const teamDir = path.join(workDir, ".ai/memories/team");
    const teamFiles = await readdir(teamDir);
    const promotedFile = teamFiles.find((file) => file.includes("manual-review"));
    expect(promotedFile).toBeDefined();
    const promoted = await readFile(path.join(teamDir, promotedFile!), "utf8");
    expect(promoted).toContain("scope: team");
    expect(promoted).toContain("status: proposed");
  });

  it("memory show prints metadata and body", async () => {
    const teamDir = path.join(workDir, ".ai/memories/team");
    const teamFiles = await readdir(teamDir);
    const file = teamFiles.find((item) => item.includes("use-pnpm"));
    expect(file).toBeDefined();
    const id = file!.replace(/\.md$/, "");
    const { stdout } = await run(workDir, ["memory", "show", id, "--dir", workDir]);
    expect(stdout).toContain(id);
    expect(stdout).toContain("scope:");
    expect(stdout).toContain("confidence:");
    expect(stdout).toContain("Always use pnpm");
  });

  // ── Phase A: CLI verbs mirror MCP tool names (mem_save/mem_search/mem_get/mem_delete) ──
  // Canonical verbs are save/search/get/delete; the old verbs add/query/show/rm stay as aliases.
  it("memory canonical verb 'search' works and 'query' alias still resolves", async () => {
    const canonical = await run(workDir, ["memory", "search", "tooling", "--dir", workDir]);
    const alias = await run(workDir, ["memory", "query", "tooling", "--dir", workDir]);
    expect(canonical.stdout).toContain("use-pnpm");
    // Same command behind both verbs → identical match line.
    expect(alias.stdout).toContain("use-pnpm");
  });

  it("memory canonical verb 'get' works and 'show' alias still resolves", async () => {
    const teamDir = path.join(workDir, ".ai/memories/team");
    const file = (await readdir(teamDir)).find((item) => item.includes("use-pnpm"));
    const id = file!.replace(/\.md$/, "");
    const canonical = await run(workDir, ["memory", "get", id, "--dir", workDir]);
    const alias = await run(workDir, ["memory", "show", id, "--dir", workDir]);
    expect(canonical.stdout).toContain("Always use pnpm");
    expect(alias.stdout).toContain("Always use pnpm");
  });

  it("default memory help surfaces canonical verbs and keeps old verbs as aliases", async () => {
    const { stdout } = await run(workDir, ["memory", "--help"]);
    // Canonical verbs visible in the core surface.
    expect(stdout).toContain("save");
    expect(stdout).toContain("search");
    expect(stdout).toContain("get");
    expect(stdout).toContain("delete");
    // Commander renders the alias next to the canonical name (e.g. "save|add").
    expect(stdout).toContain("add");
    expect(stdout).toContain("query");
  });

  it("memory lint --fix dry-run reports simple fixes and --apply writes headings", async () => {
    const malformed = path.join(workDir, ".ai/memories/team/2099-01-01-decision-lint-heading-fix.md");
    await writeFile(malformed, [
      "---",
      "id: 2099-01-01-decision-lint-heading-fix",
      "scope: team",
      "type: decision",
      "status: validated",
      "created_at: 2099-01-01T00:00:00.000Z",
      "anchor:",
      "  paths: []",
      "  symbols: []",
      "tags: []",
      "---",
      "Always keep API stable because clients depend on it.",
      "",
    ].join("\n"), "utf8");

    const dry = await run(workDir, ["memory", "lint", "--fix", "--dry-run", "--json", "--dir", workDir]);
    const dryReport = JSON.parse(dry.stdout) as {
      findings: Array<{ id: string; code: string }>;
      fixes: Array<{ id: string; actions: string[]; applied: boolean }>;
    };
    const targetFix = dryReport.fixes.find((f) => f.id.includes("lint-heading-fix"));
    expect(targetFix?.applied).toBe(false);
    expect(targetFix?.actions).toContain("add missing Markdown heading");

    await run(workDir, ["memory", "lint", "--fix", "--apply", "--dir", workDir]);
    const teamFiles = await readdir(path.join(workDir, ".ai/memories/team"));
    const lintFile = teamFiles.find((f) => f.includes("lint-heading-fix"));
    expect(lintFile).toBeDefined();
    const content = await readFile(path.join(workDir, ".ai/memories/team", lintFile!), "utf8");
    expect(content).toContain("# Decision Lint Heading Fix");
  });

  it("memory rm --yes deletes the file and removes the usage entry", async () => {
    await run(workDir, [
      "memory", "add",
      "--type", "gotcha",
      "--slug", "deleteme",
      "--scope", "personal",
      "--body", "x",
      "--dir", workDir,
    ]);
    const personalDir = path.join(workDir, ".ai/memories/personal");
    const filesBefore = await readdir(personalDir);
    expect(filesBefore.length).toBe(1);
    const id = filesBefore[0]!.replace(/\.md$/, "");

    await run(workDir, ["memory", "rm", id, "--yes", "--dir", workDir]);

    const filesAfter = await readdir(personalDir);
    expect(filesAfter.length).toBe(0);
  });

  it("memory rm errors on unknown id", async () => {
    let threw = false;
    try {
      await run(workDir, ["memory", "rm", "nonexistent-id", "--yes", "--dir", workDir]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("enforce pre-tool-use ADVISES by default: allows the write and injects the relevant policy (P0)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-pretool-advise-"));
    try {
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "guarded.ts"), "export const guarded = true;\n", "utf8");
      await run(repo, [
        "memory", "add", "--type", "decision", "--slug", "guarded-edit-policy",
        "--paths", "src/guarded.ts", "--body", "Always load the guarded edit policy before changing this file.",
        "--dir", repo,
      ]);
      await run(repo, ["memory", "approve", "--all", "--dir", repo]).catch(() => { /* autopilot may pre-validate */ });

      const payload = JSON.stringify({
        cwd: repo, session_id: "advise-session", tool_name: "Write",
        tool_input: { file_path: "src/guarded.ts" },
      });
      const res = await runWithInput(repo, ["enforce", "pre-tool-use", "--dir", repo], payload);
      // Advise default: never blocks…
      expect(res.code).toBe(0);
      // …and injects the relevant memory as PreToolUse additionalContext (no round-trip, no command).
      expect(res.stdout).toContain("additionalContext");
      expect(res.stdout).toContain("guarded-edit-policy");
      // The context is recorded, so a follow-up edit clean-passes with no further output.
      const again = await runWithInput(repo, ["enforce", "pre-tool-use", "--dir", repo], payload);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe("");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("enforce pre-tool-use BLOCKS under preEditGate:block, recording context so the retry passes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-pretool-block-"));
    try {
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      const cfgPath = path.join(repo, ".ai/hivelore.config.json");
      const cfg = existsSync(cfgPath) ? JSON.parse(await readFile(cfgPath, "utf8")) : {};
      cfg.enforcement = { ...(cfg.enforcement ?? {}), preEditGate: "block" };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "guarded.ts"), "export const guarded = true;\n", "utf8");
      await run(repo, [
        "memory", "add", "--type", "decision", "--slug", "guarded-edit-policy",
        "--paths", "src/guarded.ts", "--body", "Always load the guarded edit policy before changing this file.",
        "--dir", repo,
      ]);
      await run(repo, ["memory", "approve", "--all", "--dir", repo]).catch(() => { /* autopilot may pre-validate */ });

      const payload = JSON.stringify({
        cwd: repo, session_id: "block-session", tool_name: "Write",
        tool_input: { file_path: "src/guarded.ts" },
      });
      const blocked = await runWithInput(repo, ["enforce", "pre-tool-use", "--dir", repo], payload);
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain("guarded-edit-policy");
      // No separate briefing command — the context is recorded, so re-issuing the edit passes.
      expect(blocked.stderr).toContain("re-issue the same edit");
      const retry = await runWithInput(repo, ["enforce", "pre-tool-use", "--dir", repo], payload);
      expect(retry.code).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("decision-coverage ignores generated .ai artifacts like project-context.md (P0)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-artifact-cov-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      // A validated decision anchored to the generated artifact (worst case for the old behaviour).
      await run(repo, [
        "memory", "add", "--type", "decision", "--slug", "context-doc-policy",
        "--paths", ".ai/project-context.md", "--body", "Keep the project context current.", "--dir", repo,
      ]);
      await run(repo, ["memory", "approve", "--all", "--dir", repo]).catch(() => { /* autopilot */ });
      await exec("git", ["add", "-A"], { cwd: repo });
      await exec("git", ["commit", "-m", "base", "--no-verify"], { cwd: repo });

      // Stage a change to ONLY the generated artifact.
      await writeFile(path.join(repo, ".ai/project-context.md"), "# Project context — Hivelore\n\nedited\n", "utf8");
      await exec("git", ["add", ".ai/project-context.md"], { cwd: repo });

      const res = await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo]);
      const report = JSON.parse(res.stdout) as { findings: Array<{ code: string }> };
      const codes = report.findings.map((f) => f.code);
      // The generated artifact is excluded → no decision coverage is demanded for it.
      expect(codes).not.toContain("decision-coverage-missing");
      expect(codes).toContain("decision-coverage-no-changes");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("briefing satisfies the agent-agnostic local enforcement gate", async () => {
    await run(workDir, ["briefing", "--task", "local enforcement smoke", "--budget", "quick", "--dir", workDir]);
    const { stdout } = await run(workDir, ["enforce", "check", "--stage", "local", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as {
      should_block: boolean;
      score: { score: number; threshold: number };
      findings: Array<{ code: string }>;
    };
    expect(report.should_block).toBe(false);
    expect(report.score.score).toBeGreaterThanOrEqual(report.score.threshold);
    expect(report.findings.some((f) => f.code === "briefing-loaded")).toBe(true);
  });

  it("briefing prints breadcrumbs and drill-down calls before deeper memory bodies", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-cli-breadcrumbs-"));
    try {
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      await run(repo, [
        "memory", "add",
        "--type", "decision",
        "--slug", "breadcrumb-policy",
        "--paths", "src/breadcrumb.ts",
        "--body", "Always follow the breadcrumb policy before editing this file.",
        "--dir", repo,
      ]);
      await run(repo, ["memory", "approve", "--all", "--dir", repo]).catch(() => { /* autopilot may pre-validate */ });

      const { stdout } = await run(repo, [
        "briefing",
        "--task", "edit breadcrumb file",
        "--files", "src/breadcrumb.ts",
        "--budget", "quick",
        "--dir", repo,
      ]);

      expect(stdout).toContain("=== Breadcrumbs ===");
      expect(stdout).toContain("Start here:");
      expect(stdout).toContain("breadcrumb-policy");
      expect(stdout).toContain("Drill down only if needed:");
      expect(stdout).toContain("mem_get(");
      expect(stdout).toContain("code_search(");
      // The breadcrumbs map must stay a terse pointer list — it must not duplicate the memory body
      // (which is printed in full just below). Guard against the breadcrumbs re-bloating.
      const startHereBlock = stdout.slice(
        stdout.indexOf("Start here:"),
        stdout.indexOf("Drill down only if needed:"),
      );
      expect(startHereBlock).not.toContain("Always follow the breadcrumb policy");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("index code --status reports a code-search index built from an older code-map as stale", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-cli-idxstatus-"));
    try {
      const aiDir = path.join(repo, ".ai");
      await mkdir(path.join(aiDir, ".cache", "embeddings"), { recursive: true });
      await writeFile(
        path.join(aiDir, "code-map.json"),
        JSON.stringify({ version: 1, generated_at: "2026-06-05T00:00:00.000Z", root: repo, files: {} }),
        "utf8",
      );
      await writeFile(
        path.join(aiDir, ".cache", "embeddings", "code-embeddings-index.json"),
        JSON.stringify({
          model: "fake",
          dimension: 4,
          updated_at: "",
          source_generated_at: "2026-06-01T00:00:00.000Z",
          entries: [],
        }),
        "utf8",
      );

      const { stdout } = await run(repo, ["index", "code", "--status", "--json", "--dir", repo]);
      const status = JSON.parse(stdout) as {
        code_map: { stale: boolean };
        code_search_index: { present: boolean; stale: boolean | null };
      };
      expect(status.code_map.stale).toBe(false); // no files listed → nothing newer than generation
      expect(status.code_search_index.present).toBe(true);
      expect(status.code_search_index.stale).toBe(true); // built from the older 06-01 code-map
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("enforce cleanup preserves cache ignores and briefing markers", async () => {
    await run(workDir, ["briefing", "--task", "cleanup preservation smoke", "--budget", "quick", "--dir", workDir]);
    const cacheDir = path.join(workDir, ".ai/.cache");
    const runtimeScratch = path.join(workDir, ".ai/.runtime/scratch");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(runtimeScratch, { recursive: true });
    await writeFile(path.join(cacheDir, "temporary.json"), "{}", "utf8");
    await writeFile(path.join(runtimeScratch, "temporary.txt"), "scratch", "utf8");

    await run(workDir, ["enforce", "cleanup", "--dir", workDir]);

    expect(existsSync(path.join(cacheDir, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "temporary.json"))).toBe(false);
    expect(existsSync(runtimeScratch)).toBe(false);
    expect(existsSync(path.join(workDir, ".ai/.runtime/enforcement/briefings/default.json"))).toBe(true);

    const { stdout } = await run(workDir, ["enforce", "status", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as { should_block: boolean; findings: Array<{ code: string }> };
    expect(report.should_block).toBe(false);
    expect(report.findings.some((f) => f.code === "briefing-loaded")).toBe(true);
  });

  it("precommit --json stays machine-readable when no files are staged", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-precommit-json-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);

      const { stdout, stderr } = await run(repo, ["precommit", "--json", "--dir", repo]);
      const report = JSON.parse(stdout) as {
        should_block: boolean;
        summary: { anti_patterns: number; relevant_memories: number; stale_anchors: number };
        notice?: string;
      };

      expect(stderr).toBe("");
      expect(report.should_block).toBe(false);
      expect(report.summary.anti_patterns).toBe(0);
      expect(report.summary.relevant_memories).toBe(0);
      expect(report.summary.stale_anchors).toBe(0);
      expect(report.notice).toContain("No staged changes");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("pre-commit stages the re-synced project-context version (atomic release commit)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-atomic-ctx-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "x", version: "9.9.9" }), "utf8");
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);

      // Force a stale version header, commit it as the baseline (mimics a release whose
      // bump landed in package.json but not yet in project-context.md).
      const ctx = path.join(repo, ".ai/project-context.md");
      await writeFile(ctx, "# Project context — Hivelore (v0.0.1)\n\n> **Current version**: 0.0.1 — x\n\nbody\n", "utf8");
      await exec("git", ["add", "-A"], { cwd: repo });
      await exec("git", ["commit", "-m", "base", "--no-verify"], { cwd: repo });

      // Pre-commit gate runs the lightweight repair (heading → 9.9.9) and must stage it.
      await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--dir", repo]);

      const staged = await exec("git", ["show", ":.ai/project-context.md"], { cwd: repo });
      expect(staged.stdout).toContain("v9.9.9");
      // No leftover unstaged drift → the workflow has nothing to commit as a [skip ci] tip.
      const driftExit = await new Promise<number | null>((resolve) => {
        const child = spawn("git", ["diff", "--quiet", "--", ".ai/project-context.md"], { cwd: repo });
        child.on("close", (code) => resolve(code));
      });
      expect(driftExit).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("hivelore briefing --files records anchored policy ids so the decision-coverage gate unblocks (fix A)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-briefing-marker-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);

      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/pay.ts"), "export const pay = 1;\n", "utf8");
      // A validated policy decision anchored to the file that will change.
      await run(repo, [
        "memory", "save", "--type", "decision", "--slug", "pay-decimal-policy",
        "--scope", "team", "--paths", "src/pay.ts",
        "--body", "Payments must use Decimal, never float.", "--dir", repo,
      ]);
      await run(repo, ["memory", "approve", "--all", "--dir", repo]).catch(() => { /* already validated in autopilot */ });
      await exec("git", ["add", "-A"], { cwd: repo });
      await exec("git", ["commit", "-m", "base", "--no-verify"], { cwd: repo });

      // Stage a change to the anchored file → decision-coverage now has a relevant policy.
      await writeFile(path.join(repo, "src/pay.ts"), "export const pay = 2;\n", "utf8");
      await exec("git", ["add", "src/pay.ts"], { cwd: repo });

      // Run the EXACT command the gate suggests as its fix.
      await run(repo, ["briefing", "--files", "src/pay.ts", "--task", "edit payments", "--dir", repo]);

      const res = await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo]);
      const report = JSON.parse(res.stdout) as { findings: Array<{ code: string }> };
      const codes = report.findings.map((f) => f.code);
      // The fix command must actually unblock the gate.
      expect(codes).toContain("decision-coverage-pass");
      expect(codes).not.toContain("decision-coverage-missing");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("commit-msg hook blocks a skip-ci directive on a commit that changes shippable code (E prevention)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-commit-msg-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      const msgFile = path.join(repo, "COMMIT_MSG.txt");

      // Shippable code staged + a skip-ci directive in the body → blocked.
      await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");
      await exec("git", ["add", "package.json"], { cwd: repo });
      await writeFile(msgFile, "feat: real code change\n\nincidentally mentions [skip ci] in the body\n", "utf8");
      const blocked = await runAllowFailure(repo, ["enforce", "commit-msg", msgFile, "--dir", repo]);
      expect(blocked.code).toBe(1);

      // Same staged code, clean message → allowed.
      await writeFile(msgFile, "feat: real code change\n", "utf8");
      const clean = await runAllowFailure(repo, ["enforce", "commit-msg", msgFile, "--dir", repo]);
      expect(clean.code).toBe(0);

      // skip-ci directive but only .ai/ staged (a legit sync commit) → allowed.
      await exec("git", ["reset"], { cwd: repo });
      await writeFile(path.join(repo, ".ai/note.md"), "note\n", "utf8");
      await exec("git", ["add", ".ai/note.md"], { cwd: repo });
      await writeFile(msgFile, "chore: hivelore sync [skip ci]\n", "utf8");
      const aiOnly = await runAllowFailure(repo, ["enforce", "commit-msg", msgFile, "--dir", repo]);
      expect(aiOnly.code).toBe(0);

      // A `#` comment line mentioning the directive must NOT block (git strips comments).
      await exec("git", ["add", "package.json"], { cwd: repo });
      await writeFile(msgFile, "feat: code\n\n# note: avoid [skip ci] here\n", "utf8");
      const commented = await runAllowFailure(repo, ["enforce", "commit-msg", msgFile, "--dir", repo]);
      expect(commented.code).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("sensors check records a prevention event surfaced by the dashboard (outcome measurement)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-prevention-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none"]);
      // A validated gotcha carrying a regex sensor that fires on a sentinel token.
      const mem = path.join(repo, ".ai/memories/team/2099-01-01-gotcha-forbidden-token.md");
      await writeFile(mem, [
        "---",
        "id: 2099-01-01-gotcha-forbidden-token",
        "scope: team",
        "type: gotcha",
        "status: validated",
        "created_at: 2099-01-01T00:00:00.000Z",
        "anchor:",
        "  paths: []",
        "  symbols: []",
        "tags: []",
        "sensor:",
        "  kind: regex",
        "  pattern: FORBIDDEN_TOKEN",
        "  paths: []",
        "  message: do not use FORBIDDEN_TOKEN",
        "  severity: warn",
        "  autogen: false",
        "---",
        "Never introduce FORBIDDEN_TOKEN; use the approved API instead.",
        "",
      ].join("\n"), "utf8");

      const diffFile = path.join(repo, "change.diff");
      await writeFile(diffFile, [
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -0,0 +1 @@",
        "+const x = FORBIDDEN_TOKEN;",
        "",
      ].join("\n"), "utf8");

      const check = await run(repo, ["sensors", "check", "--diff-file", diffFile, "--json", "--dir", repo]);
      const checkReport = JSON.parse(check.stdout) as { hits: Array<{ memory_id: string }> };
      expect(checkReport.hits.some((h) => h.memory_id === "2099-01-01-gotcha-forbidden-token")).toBe(true);

      const dash = await run(repo, ["dashboard", "--json", "--dir", repo]);
      const report = JSON.parse(dash.stdout) as {
        prevention: {
          total_events: number;
          memories_with_catches: number;
          top: Array<{ id: string; prevented_count: number }>;
          trend: { last_7d: number; last_30d: number; weekly: number[] };
          recurrence: { recurring_count: number };
        };
      };
      expect(report.prevention.total_events).toBeGreaterThanOrEqual(1);
      expect(report.prevention.top.some((p) => p.id === "2099-01-01-gotcha-forbidden-token")).toBe(true);
      // The event log feeds the trend: the catch we just recorded shows up in the last-7d window.
      expect(report.prevention.trend.last_7d).toBeGreaterThanOrEqual(1);
      // A single catch is not recurrence.
      expect(report.prevention.recurrence.recurring_count).toBe(0);

      const receipt = await run(repo, ["stats", "receipt", "--since", "7d", "--dir", repo]);
      expect(receipt.stdout).toContain("Hivelore prevention receipt — last 7 days");
      expect(receipt.stdout).toContain("2099-01-01-gotcha-forbidden-token");
      expect(receipt.stdout).toContain("Trend:");
      const receiptJson = JSON.parse((await run(repo, ["stats", "receipt", "--json", "--dir", repo])).stdout) as {
        total: number; previous_total: number; events: Array<{ id: string; kind: string }>;
      };
      expect(receiptJson.total).toBeGreaterThanOrEqual(1);
      expect(receiptJson.events[0]).toMatchObject({ id: "2099-01-01-gotcha-forbidden-token", kind: "regex" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("session end --auto falls back to a git diff recap when no observation log exists", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-auto-session-end-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      // --no-bridges keeps the recap focused on the user's change, not the 12 generated bridges.
      await run(repo, ["init", "--dir", repo, "--no-mcp-setup", "--stack", "none", "--no-bridges"]);
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "changed.ts"), "export const changed = true;\n", "utf8");

      const { stdout } = await run(repo, ["session", "end", "--auto", "--dir", repo]);

      expect(stdout).toContain("Session recap");
      const personalDir = path.join(repo, ".ai/memories/personal");
      const files = await readdir(personalDir);
      const recapFile = files.find((file) => file.includes("session_recap"))!;
      const content = await readFile(path.join(personalDir, recapFile), "utf8");
      // New format: meaningful goal derived from file count or recent commits, not raw bash commands
      expect(content).toMatch(/Session with \d+ changed file|Session with recent commits/);
      // git porcelain groups untracked files by parent dir, so src/ may appear instead of src/changed.ts
      expect(content).toMatch(/src\/changed\.ts|src\//)
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("CI enforcement warns but does not block when only session recap is missing", async () => {
    const { stdout } = await run(workDir, ["enforce", "ci", "--json", "--dir", workDir]);
    const report = JSON.parse(stdout) as {
      should_block: boolean;
      findings: Array<{ code: string; severity: string }>;
    };
    const recap = report.findings.find((f) => f.code === "session-recap-missing");
    expect(report.should_block).toBe(false);
    expect(recap?.severity).toBe("warn");
  });

  it("CI enforcement scans the committed base/head diff, not only staged changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-ci-diff-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/status.ts"), "export const status = \"OK\";\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });

      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await writeFile(
        path.join(repo, ".ai/memories/team/2026-01-01-attempt-lowercase-status.md"),
        [
          "---",
          "id: 2026-01-01-attempt-lowercase-status",
          "scope: team",
          "type: attempt",
          "status: validated",
          "created_at: '2026-01-01T00:00:00.000Z'",
          "anchor:",
          "  paths: [src/status.ts]",
          "  symbols: []",
          // A deterministic block sensor is what hard-blocks under the anchored-gate policy: a
          // sensor-less anti-pattern only surfaces as review (it's relevance, not proof of violation).
          "sensor:",
          "  kind: regex",
          "  pattern: 'status\\s*=\\s*\"ok\"'",
          "  message: return uppercase OK/KO",
          "  severity: block",
          "  paths: [src/status.ts]",
          "  last_fired: null",
          "tags: []",
          "---",
          "# lowercase status",
          "",
          "Using lowercase status ok failed. Return uppercase OK or KO.",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(path.join(repo, "src/status.ts"), "export const status = \"ok\";\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "--no-verify", "-m", "introduce lowercase status"], { cwd: repo });

      // Isolate from the ambient GitHub Actions env: on the CI runner GITHUB_SHA /
      // GITHUB_BASE_REF / GITHUB_EVENT_PATH point at the Hivelore CI commit (absent from
      // this temp repo), which made `enforce ci` diff an unknown SHA → empty diff →
      // exit 0. Clearing them makes it diff this repo's own HEAD~1..HEAD as intended.
      const result = await runAllowFailure(repo, ["enforce", "ci", "--json", "--dir", repo], {
        GITHUB_SHA: "",
        GITHUB_BASE_REF: "",
        GITHUB_HEAD_REF: "",
        GITHUB_REF: "",
        GITHUB_EVENT_PATH: "",
        HIVELORE_BASE_SHA: "",
        HIVELORE_HEAD_SHA: "",
        HAIVE_BASE_REF: "",
      });
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(2);
      expect(report.should_block).toBe(true);
      expect(report.findings.some((f) => f.code === "precommit-policy-block")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("CI enforcement reconstructs decision coverage without a local briefing marker", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-ci-decision-coverage-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/guarded.ts"), "export const guarded = true;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });

      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await writeFile(
        path.join(repo, ".ai/memories/team/2026-01-01-decision-guarded-file.md"),
        [
          "---",
          "id: 2026-01-01-decision-guarded-file",
          "scope: team",
          "type: decision",
          "status: validated",
          "created_at: '2026-01-01T00:00:00.000Z'",
          "anchor:",
          "  paths: [src/guarded.ts]",
          "  symbols: []",
          "tags: []",
          "---",
          "# Guarded file policy",
          "",
          "This file is guarded by a repo-specific policy.",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(path.join(repo, "src/guarded.ts"), "export const guarded = false;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "--no-verify", "-m", "change guarded file"], { cwd: repo });

      const result = await runAllowFailure(repo, ["enforce", "ci", "--json", "--dir", repo], {
        GITHUB_SHA: "",
        GITHUB_BASE_REF: "",
        GITHUB_HEAD_REF: "",
        GITHUB_REF: "",
        GITHUB_EVENT_PATH: "",
        HIVELORE_BASE_SHA: "",
        HIVELORE_HEAD_SHA: "",
        HAIVE_BASE_REF: "",
      });
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string; memory_ids?: string[] }>;
      };

      expect(result.code).toBe(0);
      expect(report.should_block).toBe(false);
      const coverage = report.findings.find((f) => f.code === "decision-coverage-ci-pass");
      expect(coverage?.severity).toBe("ok");
      expect(coverage?.memory_ids).toContain("2026-01-01-decision-guarded-file");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("bootstrap gate reports on a cold codebase, blocks only when opted in, then clears once filled", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-bootstrap-gate-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "packages/api"), { recursive: true });
      for (const [f, body] of [["a", "getUser"], ["b", "listUsers"], ["c", "delUser"]]) {
        await writeFile(path.join(repo, `packages/api/${f}.ts`), `export function ${body}(){ return 1 }\n`, "utf8");
      }
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await run(repo, ["index", "code", "--dir", repo]);

      // A committed map can retain paths from an ignored/nested checkout that is absent in CI.
      // Those stale entries must not manufacture bootstrap areas in the current checkout.
      const codeMapFile = path.join(repo, ".ai/code-map.json");
      const codeMap = JSON.parse(await readFile(codeMapFile, "utf8")) as { files: Record<string, unknown> };
      const sampleEntry = Object.values(codeMap.files)[0];
      codeMap.files["ignored-ref/a.ts"] = sampleEntry;
      codeMap.files["ignored-ref/b.ts"] = sampleEntry;
      codeMap.files["ignored-ref/c.ts"] = sampleEntry;
      await writeFile(codeMapFile, JSON.stringify(codeMap, null, 2), "utf8");

      // Stage a production-code change on a cold corpus. Bootstrap is a PROCESS gate: since v0.55.0
      // it reports at every stage and refuses at none, unless the repo opts in with
      // enforcement.processGate="block" — which this test then does, to keep the strict path covered.
      await writeFile(path.join(repo, "packages/api/a.ts"), "export function getUser(){ return 2 }\n", "utf8");
      await exec("git", ["add", "packages/api/a.ts"], { cwd: repo });
      const preCommit = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(preCommit.findings.find((f) => f.code === "bootstrap-incomplete")?.severity).toBe("warn");
      const prePush = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(prePush.findings.find((f) => f.code === "bootstrap-incomplete")?.severity).toBe("warn");

      // Opted in, the cold baseline blocks the sharing point again.
      const strictCfgPath = path.join(repo, ".ai", "hivelore.config.json");
      const strictCfg = JSON.parse(await readFile(strictCfgPath, "utf8")) as { enforcement?: Record<string, unknown> };
      await writeFile(
        strictCfgPath,
        JSON.stringify({ ...strictCfg, enforcement: { ...strictCfg.enforcement, processGate: "block" } }, null, 2),
        "utf8",
      );
      const prePushStrict = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(prePushStrict.findings.find((f) => f.code === "bootstrap-incomplete")?.severity).toBe("error");
      await writeFile(strictCfgPath, JSON.stringify(strictCfg, null, 2), "utf8");

      // Fill the knowledge layer: real project-context + an anchored memory with a sensor on the area.
      await writeFile(
        path.join(repo, ".ai/project-context.md"),
        "# Project context\n\n## Architecture\n" + "A real, filled overview of the api package. ".repeat(8),
        "utf8",
      );
      await writeFile(
        path.join(repo, ".ai/memories/team/2026-01-01-gotcha-api.md"),
        [
          "---", "id: 2026-01-01-gotcha-api", "scope: team", "type: gotcha", "status: validated",
          "created_at: '2026-01-01T00:00:00.000Z'",
          "anchor:", "  paths: [packages/api/a.ts]", "  symbols: []",
          "sensor:", "  kind: regex", "  pattern: getUser", "  paths: [packages/api/a.ts]",
          "  message: m", "  severity: warn", "  autogen: true", "  last_fired: null",
          "tags: []", "---", "# Api guard", "", "Repo-specific rule.", "",
        ].join("\n"),
        "utf8",
      );
      const ready = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(ready.findings.some((f) => f.code === "bootstrap-complete" && f.severity === "ok")).toBe(true);
      expect(ready.findings.some((f) => f.code === "bootstrap-incomplete")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("migrates a pre-rename repo: haive.config.json + haive-*.yml → hivelore.* (no duplicates)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-kill-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await mkdir(path.join(repo, ".github/workflows"), { recursive: true });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/app.ts"), "export const a = 1;\n", "utf8");
      // Pre-rename artifacts carrying a custom setting + legacy workflow markers.
      await writeFile(path.join(repo, ".ai/haive.config.json"), JSON.stringify({ enforcement: { reviewMatches: true } }), "utf8");
      await writeFile(path.join(repo, ".github/workflows/haive-sync.yml"), "name: haive-sync\n", "utf8");
      await writeFile(path.join(repo, ".github/workflows/haive-enforcement.yml"), "# haive:enforcement-workflow:start\nname: haive-enforcement\n# haive:enforcement-workflow:end\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "init"], { cwd: repo });

      await run(repo, ["init", "--with-ci", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await run(repo, ["enforce", "install", "--dir", repo]);

      // Config migrated, custom setting preserved, legacy gone.
      expect(existsSync(path.join(repo, ".ai/hivelore.config.json"))).toBe(true);
      expect(existsSync(path.join(repo, ".ai/haive.config.json"))).toBe(false);
      const cfg = JSON.parse(await readFile(path.join(repo, ".ai/hivelore.config.json"), "utf8")) as { enforcement?: { reviewMatches?: boolean } };
      expect(cfg.enforcement?.reviewMatches).toBe(true);

      // Workflows migrated — new names exist and the legacy ones are gone (no double CI runs).
      expect(existsSync(path.join(repo, ".github/workflows/hivelore-sync.yml"))).toBe(true);
      expect(existsSync(path.join(repo, ".github/workflows/hivelore-enforcement.yml"))).toBe(true);
      expect(existsSync(path.join(repo, ".github/workflows/haive-sync.yml"))).toBe(false);
      expect(existsSync(path.join(repo, ".github/workflows/haive-enforcement.yml"))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("hides fuzzy anti-pattern review matches by default, surfaces them with reviewMatches=true", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-review-off-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/util.ts"), "export const fmt = (d: string) => d;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "init"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await run(repo, ["memory", "tried", "--what", "moment import", "--why-failed", "bundle bloat", "--instead", "date-fns", "--paths", "src/", "--dir", repo]);
      // A diff that fuzzy-matches the lesson (literal/semantic), but carries NO deterministic sensor.
      await writeFile(path.join(repo, "src/util.ts"), "export const fmt = (d: string) => d;\nimport moment from 'moment';\n", "utf8");
      await exec("git", ["add", "src/util.ts"], { cwd: repo });

      const off = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string }> };
      expect(off.findings.some((f) => f.code === "anti-pattern-review")).toBe(false);

      const cfgPath = path.join(repo, ".ai/hivelore.config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { enforcement?: Record<string, unknown> };
      cfg.enforcement = { ...cfg.enforcement, reviewMatches: true };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      const on = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string }> };
      expect(on.findings.some((f) => f.code === "anti-pattern-review")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("doctor hides informational findings by default and shows them with --all", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-doctor-floor-"));
    try {
      await exec("git", ["init"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/util.ts"), "export const fmt = (d: string) => d;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "init"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const def = (await runAllowFailure(repo, ["doctor", "--dir", repo])).stdout;
      expect(def).toContain("informational finding(s) hidden");
      const all = (await runAllowFailure(repo, ["doctor", "--all", "--dir", repo])).stdout;
      expect(all).not.toContain("informational finding(s) hidden");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps process gates advisory by default, and blocks only when processGate is set to block", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-human-relax-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/app.ts"), "export const a = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      // Stage a change with NO briefing marker.
      await writeFile(path.join(repo, "src/app.ts"), "export const a = 2;\n", "utf8");
      await exec("git", ["add", "src/app.ts"], { cwd: repo });

      // COMMIT stage is advisory for everyone: process gates never block a local commit (they enforce
      // at the sharing points). Even an agent sees briefing-missing as a warning at pre-commit.
      const agentCommit = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { actor?: string; should_block: boolean; findings: Array<{ code: string; severity: string }> };
      expect(agentCommit.actor).toContain("agent");
      expect(agentCommit.findings.find((f) => f.code === "briefing-missing")?.severity).toBe("warn");

      // SHARING point (pre-push), default config: process gates are ADVISORY for everyone,
      // agents included (enforcement.processGate defaults to "warn" since v0.55.0). A push carrying
      // clean, tested code must not be refused because no session recap was written — that refusal
      // teaches `--no-verify`, which costs the developer the sensors too.
      const agent = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo])).stdout,
      ) as { actor?: string; should_block: boolean; findings: Array<{ code: string; severity: string; message: string }> };
      expect(agent.actor).toContain("agent");
      const advisory = agent.findings.find((f) => f.code === "briefing-missing");
      expect(advisory?.severity).toBe("warn");
      expect(advisory?.message).toContain("processGate");
      // Nothing deterministic fired, so nothing refuses the push.
      expect(agent.should_block).toBe(false);

      // The score is still reported when it is under target, but it is a measurement, never a verdict.
      const scoreFinding = agent.findings.find((f) => f.code === "enforcement-score-below-threshold");
      if (scoreFinding) {
        expect(scoreFinding.severity).toBe("warn");
        expect(scoreFinding.message).toContain("does not block");
      }

      // Human context (HAIVE_AGENT=0 override): also advisory, and still labelled as a human actor.
      const human = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo], { HAIVE_AGENT: "0" })).stdout,
      ) as { actor?: string; findings: Array<{ code: string; severity: string; message: string }> };
      expect(human.actor).toContain("human");
      expect(human.findings.find((f) => f.code === "briefing-missing")?.severity).toBe("warn");

      // Opt back in: processGate="block" restores the pre-v0.55.0 gate for teams that want it,
      // and humanCommits still carves humans out of it.
      const cfgPath = path.join(repo, ".ai", "hivelore.config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { enforcement?: Record<string, unknown> };
      cfg.enforcement = { ...cfg.enforcement, processGate: "block" };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      const blocking = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string; message: string }> };
      expect(blocking.findings.find((f) => f.code === "briefing-missing")?.severity).toBe("error");

      const relaxedHuman = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-push", "--json", "--dir", repo], { HAIVE_AGENT: "0" })).stdout,
      ) as { findings: Array<{ code: string; severity: string; message: string }> };
      const relaxed = relaxedHuman.findings.find((f) => f.code === "briefing-missing");
      expect(relaxed?.severity).toBe("warn");
      expect(relaxed?.message).toContain("humanCommits");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("command sensors: the gate runs the lesson's oracle and blocks on failure, warns when unrunnable", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-cmd-sensor-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/refund.ts"), "export const refund = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      // Opt in to command execution (off by default — runs repo-authored commands).
      const cfgPath = path.join(repo, ".ai", "hivelore.config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { enforcement?: Record<string, unknown> };
      cfg.enforcement = { ...cfg.enforcement, runCommandSensors: true };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

      // A lesson whose oracle FAILS (the behaviour bug is "present"), scoped to src/.
      const failing = [
        "---",
        "id: 2024-01-01-attempt-refund-exceeds-capture",
        "scope: team", "type: attempt", "status: validated",
        "created_at: 2024-01-01T00:00:00.000Z",
        "anchor:", "  paths: [\"src/\"]", "  symbols: []", "tags: []",
        "sensor:",
        "  kind: test",
        "  command: \"node -e \\\"console.error('refund exceeds capture'); process.exit(1)\\\"\"",
        "  message: Refund invariant broken — clamp to the captured amount.",
        "  severity: block",
        "  paths: [\"src/\"]",
        "---",
        "# refund exceeding captured amount", "",
      ].join("\n");
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await writeFile(path.join(repo, ".ai/memories/team/2024-01-01-attempt-refund-exceeds-capture.md"), failing, "utf8");

      await writeFile(path.join(repo, "src/refund.ts"), "export const refund = 2;\n", "utf8");
      await exec("git", ["add", "src/refund.ts"], { cwd: repo });
      const res = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string; message: string }> };
      const block = res.findings.find((f) => f.code === "sensor-block");
      expect(block?.severity).toBe("error");
      expect(block?.message).toContain("refund exceeds capture"); // oracle output tail is in the finding

      // An UNRUNNABLE oracle must warn, never block (the oracle said nothing about the code).
      const unrunnable = failing
        .replace("2024-01-01-attempt-refund-exceeds-capture", "2024-01-02-attempt-unrunnable-oracle")
        .replace(/command: .*/, "command: \"definitely-not-a-real-binary-hivelore --check\"")
        .replace("# refund exceeding captured amount", "# unrunnable oracle");
      await writeFile(path.join(repo, ".ai/memories/team/2024-01-02-attempt-unrunnable-oracle.md"), unrunnable, "utf8");
      await rm(path.join(repo, ".ai/memories/team/2024-01-01-attempt-refund-exceeds-capture.md"));
      const res2 = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      const unrun = res2.findings.find((f) => f.code === "command-sensor-unrunnable");
      expect(unrun?.severity).toBe("warn");
      expect(res2.findings.some((f) => f.code === "sensor-block")).toBe(false);

      cfg.enforcement = { ...cfg.enforcement, runCommandSensors: true, commandSensorUnrunnable: "block" };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      const strictRes = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(strictRes.findings.find((f) => f.code === "command-sensor-unrunnable")?.severity).toBe("error");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a blocked gate leads with a headline that names a lesson-refusal (not the cold-repo baseline)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-headline-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/d.ts"), "export const x = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      // A validated regex BLOCK sensor scoped to src/ (deterministic — always error, no opt-in).
      const mem = [
        "---",
        "id: 2024-02-02-attempt-no-moment",
        "scope: team", "type: attempt", "status: validated",
        "created_at: 2024-02-02T00:00:00.000Z",
        "anchor:", "  paths: [\"src/\"]", "  symbols: []", "tags: []",
        "sensor:",
        "  kind: regex",
        "  pattern: \"moment\"",
        "  message: Use date-fns, not moment.",
        "  severity: block",
        "  paths: [\"src/\"]",
        "---",
        "# no moment", "",
      ].join("\n");
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await writeFile(path.join(repo, ".ai/memories/team/2024-02-02-attempt-no-moment.md"), mem, "utf8");

      // The diff repeats the lesson: the headline must name THE CHANGE, above bootstrap/score noise.
      await writeFile(path.join(repo, "src/d.ts"), "export const x = 1;\nimport moment from 'moment';\n", "utf8");
      await exec("git", ["add", "src/d.ts"], { cwd: repo });
      const caught = await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--dir", repo]);
      expect(caught.stdout).toContain("A documented lesson refused this commit");
      expect(caught.stdout).toContain("2024-02-02-attempt-no-moment");
      // The deterministic block is named; at COMMIT stage the process/score noise is suppressed
      // (Lever: silence-on-success / commit-advisory) so the lesson-refusal is the signal, not buried.
      // The headline names the LESSON, the file, and the offending line — not a code and not a score.
      expect(caught.stdout).toContain("A documented lesson refused this commit");
      expect(caught.stdout).toContain("2024-02-02-attempt-no-moment");
      expect(caught.stdout).toContain("src/d.ts");
      expect(caught.stdout).not.toContain("top penalties:");
      // ONE lesson, ONE mention. The anti-pattern matcher and the sensor runner both fire on this
      // memory; reporting them separately turned a single bad line into four lines of output.
      const mentions = caught.stdout.split("2024-02-02-attempt-no-moment").length - 1;
      expect(mentions, `lesson mentioned ${mentions}x:\n${caught.stdout}`).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("sensors scaffold generates a pending post-incident test + the wiring command from a lesson", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-scaffold-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeFile(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "x", devDependencies: { vitest: "^2" } }),
        "utf8",
      );
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/pay.ts"), "export const x = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const mem = [
        "---",
        "id: 2024-03-03-attempt-refund-exceeds-capture",
        "scope: team", "type: attempt", "status: validated",
        "created_at: 2024-03-03T00:00:00.000Z",
        "anchor:", "  paths: [\"src/\"]", "  symbols: []", "tags: []",
        "---",
        "# refund exceeded the captured amount", "",
        "**Why it failed / do NOT use:** prod #442 — refunds must clamp", "",
        "**Instead, use:** clamp to the capture", "",
      ].join("\n");
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await writeFile(path.join(repo, ".ai/memories/team/2024-03-03-attempt-refund-exceeds-capture.md"), mem, "utf8");

      const out = await run(repo, ["sensors", "scaffold", "2024-03-03-attempt-refund-exceeds-capture", "--dir", repo]);
      expect(out.stdout).toContain("tests/incidents/refund-exceeds-capture.test.ts");
      expect(out.stdout).toContain("--kind test"); // prints the arming command, never arms it

      const testFile = await readFile(path.join(repo, "tests/incidents/refund-exceeds-capture.test.ts"), "utf8");
      expect(testFile).toContain('import { describe, it, expect } from "vitest";');
      expect(testFile).toContain("it.todo("); // pending — the suite stays green until written
      expect(testFile).toContain("2024-03-03-attempt-refund-exceeds-capture"); // provenance in the header

      // No sensor was armed by scaffolding (propose_sensor stays the sole writer).
      const list = await run(repo, ["sensors", "list", "--dir", repo]);
      expect(list.stdout).not.toContain("2024-03-03-attempt-refund-exceeds-capture");

      // Behaviour-loop accounting: the pending, unarmed scaffold is an OPEN loop — doctor nudges it.
      const doc = JSON.parse((await runAllowFailure(repo, ["doctor", "--json", "--dir", repo])).stdout) as {
        findings: Array<{ code: string; severity: string; message: string }>;
      };
      const unarmed = doc.findings.find((f) => f.code === "post-incident-test-unarmed");
      expect(unarmed?.severity).toBe("warn");
      expect(unarmed?.message).toContain("2024-03-03-attempt-refund-exceeds-capture");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("ingest --from github-pr turns review-thread instructions into proposed review-learning memories (idempotent)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-pr-ingest-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src/payments"), { recursive: true });
      await writeFile(path.join(repo, "src/payments/refund.ts"), "export const r = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const payload = [
        {
          id: 100, path: "src/payments/refund.ts", line: 3,
          body: "Never refund more than the captured amount — clamp it.",
          user: { login: "sady", type: "User" },
          html_url: "https://github.com/o/r/pull/7#discussion_r100",
          pull_request_url: "https://api.github.com/repos/o/r/pulls/7",
        },
        { id: 101, body: "LGTM 🚀", user: { login: "sady", type: "User" } },
        {
          id: 102, body: "You must always await this call.",
          user: { login: "bot-reviewer", type: "Bot" },
        },
      ];
      await writeFile(path.join(repo, "comments.json"), JSON.stringify(payload), "utf8");

      const out = await run(repo, ["ingest", "--from", "github-pr", "comments.json", "--dir", repo]);
      expect(out.stdout).toContain("review-learning");

      const teamDir = path.join(repo, ".ai/memories/team");
      const memoryFiles = await readdir(teamDir);
      const learningFile = memoryFiles.find((f) => f.includes("never-refund"));
      expect(learningFile).toBeDefined();
      const content = await readFile(path.join(teamDir, learningFile!), "utf8");
      expect(content).toContain("status: proposed");
      expect(content).toContain("- review-learning");
      expect(content).toContain("src/payments/refund.ts");
      expect(content).toContain("PR #7");

      // Idempotent per thread: re-ingesting the same payload creates nothing new.
      const again = await run(repo, ["ingest", "--from", "github-pr", "comments.json", "--dir", repo]);
      expect(again.stdout).toContain("already ingested");
      expect((await readdir(teamDir)).length).toBe(memoryFiles.length);
      const evalSpec = JSON.parse(await readFile(path.join(repo, ".ai/eval/spec.json"), "utf8")) as {
        proposed_retrieval?: Array<{ expect_ids: string[] }>;
      };
      expect(evalSpec.proposed_retrieval).toHaveLength(memoryFiles.length);
      expect(evalSpec.proposed_retrieval?.[0]?.expect_ids).toContain(memoryFiles[0]!.replace(/\.md$/, ""));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("session end --auto distills failure observations into proposed auto-captured drafts (no dupes, never validated)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-autocapture-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/a.ts"), "export const a = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const obs = [
        { ts: "2026-07-04T10:00:00Z", tool: "Bash", summary: "Bash: pnpm test failed — refund.spec assertion", files: ["src/a.ts"], failure_hint: true },
        { ts: "2026-07-04T10:02:00Z", tool: "Bash", summary: "Bash: pnpm test failed —   refund.spec assertion", files: ["src/a.ts"], failure_hint: true },
        { ts: "2026-07-04T10:03:00Z", tool: "Bash", summary: "grep -rn nothing src", failure_hint: true },
        { ts: "2026-07-04T10:04:00Z", tool: "Edit", summary: "edited src/a.ts", files: ["src/a.ts"] },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n";
      const obsFile = path.join(repo, ".ai/.cache/observations.jsonl");
      await mkdir(path.dirname(obsFile), { recursive: true });
      await writeFile(obsFile, obs, "utf8");

      const out = await run(repo, ["session", "end", "--auto", "--dir", repo]);
      expect(out.stdout + out.stderr).toContain("auto-captured as proposed lesson");

      const personal = path.join(repo, ".ai/memories/personal");
      const drafts: string[] = [];
      for (const f of await readdir(personal)) {
        const content = await readFile(path.join(personal, f), "utf8");
        if (content.includes("type: attempt") && content.includes("- auto-captured")) drafts.push(content);
      }
      // One draft for the clustered retry; the exploratory grep is dropped.
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toContain("status: proposed"); // never born validated
      expect(drafts[0]).toContain("pnpm test failed");
      expect(drafts[0]).toContain("2 occurrences");
      expect(drafts[0]).not.toContain("sensor:"); // never armed automatically

      // Idempotence: same observations again → no duplicate draft.
      await writeFile(obsFile, obs, "utf8");
      await run(repo, ["session", "end", "--auto", "--dir", repo]);
      let count = 0;
      for (const f of await readdir(personal)) {
        const c = await readFile(path.join(personal, f), "utf8");
        if (c.includes("type: attempt") && c.includes("- auto-captured")) count++;
      }
      expect(count).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("an AST block sensor fires on a structural introduction but not on the same text in a comment", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-ast-gate-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/pay.ts"), "export const ok = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const mem = [
        "---", "id: 2024-05-05-attempt-stripe-no-idempotency", "scope: team", "type: attempt", "status: validated",
        "created_at: 2024-05-05T00:00:00.000Z",
        "anchor:", "  paths: [\"src/\"]", "  symbols: []", "tags: []",
        "sensor:", "  kind: ast", "  rule:", "    pattern: \"stripe.paymentIntents.create($$$)\"", "  absent: idempotencyKey",
        "  message: Pass an idempotencyKey to paymentIntents.create.", "  severity: block", "  paths: [\"src/\"]",
        "---", "# stripe without idempotency", "",
      ].join("\n");
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await writeFile(path.join(repo, ".ai/memories/team/2024-05-05-attempt-stripe-no-idempotency.md"), mem, "utf8");

      // A comment mentioning the API is NOT an introduction — the regex engine's false-positive class.
      await writeFile(path.join(repo, "src/pay.ts"), "export const ok = 1;\n// stripe.paymentIntents.create must be idempotent\n", "utf8");
      await exec("git", ["add", "src/pay.ts"], { cwd: repo });
      const clean = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; message: string }> };
      expect(clean.findings.some((f) => f.code === "sensor-block")).toBe(false);
      await exec("git", ["commit", "-m", "comment only", "--no-verify"], { cwd: repo });

      // The real faulty call blocks, with the matched construct in the finding.
      await writeFile(
        path.join(repo, "src/pay.ts"),
        "export const charge = (a: number) => stripe.paymentIntents.create({ amount: a });\n",
        "utf8",
      );
      await exec("git", ["add", "src/pay.ts"], { cwd: repo });
      const manual = JSON.parse((await runAllowFailure(repo, ["sensors", "check", "--json", "--dir", repo])).stdout) as {
        scanned: number;
        hits: Array<{ memory_id: string; severity: string }>;
      };
      expect(manual.scanned).toBeGreaterThan(0);
      expect(manual.hits).toContainEqual(expect.objectContaining({
        memory_id: "2024-05-05-attempt-stripe-no-idempotency",
        severity: "block",
      }));
      const caught = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string; message: string }> };
      const block = caught.findings.find((f) => f.code === "sensor-block");
      expect(block?.severity).toBe("error");
      expect(block?.message).toContain("AST sensor");
      expect(block?.message).toContain("paymentIntents.create");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a diff that weakens a sensor (block→warn, changed oracle) surfaces a sensor-weakened review finding", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-weakened-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/d.ts"), "export const x = 1;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      const id = "2024-04-04-attempt-no-moment";
      const memoryFile = path.join(repo, `.ai/memories/team/${id}.md`);
      const mem = (severity: string, pattern: string): string => [
        "---", `id: ${id}`, "scope: team", "type: attempt", "status: validated",
        "created_at: 2024-04-04T00:00:00.000Z",
        "anchor:", "  paths: [\"src/\"]", "  symbols: []", "tags: []",
        "sensor:", "  kind: regex", `  pattern: "${pattern}"`,
        "  message: Use date-fns.", `  severity: ${severity}`, "  paths: [\"src/\"]",
        "---", "# no moment", "",
      ].join("\n");
      await mkdir(path.join(repo, ".ai/memories/team"), { recursive: true });
      await writeFile(memoryFile, mem("block", "moment"), "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "arm sensor", "--no-verify"], { cwd: repo });

      // Stage a demotion of the very sensor that guards src/ — the gate must call it out for review.
      await writeFile(memoryFile, mem("warn", "momentjs-only"), "utf8");
      await exec("git", ["add", memoryFile], { cwd: repo });
      const res = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string; message: string }> };
      const weakened = res.findings.find((f) => f.code === "sensor-weakened");
      expect(weakened?.severity).toBe("warn"); // review, never a block — legitimate demotions exist
      expect(weakened?.message).toContain(id);
      expect(weakened?.message).toContain("severity-demoted");
      expect(weakened?.message).toContain("oracle-changed");

      const cfgPath = path.join(repo, ".ai/hivelore.config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as { enforcement?: Record<string, unknown> };
      cfg.enforcement = { ...cfg.enforcement, sensorWeakeningGate: "block" };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      const strict = JSON.parse(
        (await runAllowFailure(repo, ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo])).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(strict.findings.find((f) => f.code === "sensor-weakened")?.severity).toBe("error");

      const approved = JSON.parse(
        (await runAllowFailure(
          repo,
          ["enforce", "check", "--stage", "pre-commit", "--json", "--dir", repo],
          { HIVELORE_SENSOR_WEAKENING_APPROVALS: id },
        )).stdout,
      ) as { findings: Array<{ code: string; severity: string }> };
      expect(approved.findings.find((f) => f.code === "sensor-weakened")).toBeUndefined();
      expect(approved.findings.find((f) => f.code === "sensor-weakening-approved")?.severity).toBe("ok");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("quarantines a command sensor after two identical-input flaps and manual promote clears it", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-flaky-sensor-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/check.ts"), "export const stable = true;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);

      await writeFile(path.join(repo, "oracle.mjs"), [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const file = '.oracle-counter';",
        "const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;",
        "writeFileSync(file, String(n));",
        "process.exit(n % 2 === 0 ? 1 : 0);",
      ].join("\n"), "utf8");
      const id = "2026-07-03-attempt-flaky-oracle";
      const memoryFile = path.join(repo, `.ai/memories/team/${id}.md`);
      await writeFile(memoryFile, [
        "---", `id: ${id}`, "scope: team", "type: attempt", "status: validated",
        "created_at: 2026-07-03T00:00:00.000Z", "anchor:", "  paths: [src/]", "  symbols: []", "tags: []",
        "sensor:", "  kind: test", "  command: node oracle.mjs", "  message: Flaky invariant failed.",
        "  red_proven: true", "  severity: block", "  paths: [src/]", "---", "# Flaky oracle", "",
      ].join("\n"), "utf8");
      await writeFile(path.join(repo, "change.diff"), [
        "diff --git a/src/check.ts b/src/check.ts", "--- a/src/check.ts", "+++ b/src/check.ts",
        "@@ -1 +1 @@", "+export const stable = true;", "",
      ].join("\n"), "utf8");

      const check = ["sensors", "check", "--commands", "--diff-file", "change.diff", "--json", "--dir", repo];
      await run(repo, check); // pass
      await runAllowFailure(repo, check); // fail: first flap
      await run(repo, check); // pass: second flap
      const fourth = JSON.parse((await run(repo, check)).stdout) as { command_hits: Array<{ severity: string }> };
      expect(fourth.command_hits[0]?.severity).toBe("warn");

      await run(repo, ["sync", "--no-verify", "--no-promote", "--no-bridges", "--no-deps", "--no-contracts", "--no-cross-repo", "--dir", repo]);
      let content = await readFile(memoryFile, "utf8");
      expect(content).toContain("severity: warn");
      expect(content.match(/^> Quarantined /gm)).toHaveLength(1);
      await run(repo, ["sync", "--no-verify", "--no-promote", "--no-bridges", "--no-deps", "--no-contracts", "--no-cross-repo", "--dir", repo]);
      content = await readFile(memoryFile, "utf8");
      expect(content.match(/^> Quarantined /gm)).toHaveLength(1);

      await run(repo, ["sensors", "promote", id, "--yes", "--dir", repo]);
      content = await readFile(memoryFile, "utf8");
      expect(content).toContain("severity: block");
      expect(content).not.toContain("> Quarantined");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("sync proposes one gate-miss lesson when a gate-passed commit is reverted", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-gate-miss-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      const initial = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      const syncArgs = ["sync", "--no-verify", "--no-promote", "--no-bridges", "--no-deps", "--no-contracts", "--no-cross-repo", "--dir", repo];
      await run(repo, syncArgs); // first run initializes git-watch at HEAD

      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/feature.ts"), "export const broken = true;\n", "utf8");
      await exec("git", ["add", "src/feature.ts"], { cwd: repo });
      await exec("git", ["commit", "-m", "feat: break refunds"], { cwd: repo });
      const commitA = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      const gate = await runAllowFailure(repo, ["enforce", "ci", "--json", "--dir", repo], {
        HIVELORE_BASE_SHA: initial,
        HIVELORE_HEAD_SHA: commitA,
      });
      expect(gate.code).toBe(0);

      await exec("git", ["revert", "--no-edit", commitA], { cwd: repo });
      await run(repo, syncArgs);
      const teamDir = path.join(repo, ".ai/memories/team");
      let gateMissFiles = (await readdir(teamDir)).filter((file) => file.includes("gate-miss-"));
      expect(gateMissFiles).toHaveLength(1);
      const content = await readFile(path.join(teamDir, gateMissFiles[0]!), "utf8");
      expect(content).toContain("status: proposed");
      expect(content).toContain("gate-miss");
      expect(content).toContain(`Reverted SHA: ${commitA}`);
      expect(content).toContain("The gate PASSED this commit");
      expect(content).toContain("proposed_sensor_seed:");

      await run(repo, syncArgs);
      gateMissFiles = (await readdir(teamDir)).filter((file) => file.includes("gate-miss-"));
      expect(gateMissFiles).toHaveLength(1);
      const doctor = JSON.parse((await run(repo, ["doctor", "--json", "--dir", repo])).stdout) as {
        findings: Array<{ code: string }>;
      };
      expect(doctor.findings.some((finding) => finding.code === "gate-miss-drafts")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("finish gate blocks shippable work left as an uncommitted local diff", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-finish-dirty-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeLockstepPackageJsons(repo, "0.1.0");
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });

      await mkdir(path.join(repo, "packages/cli/src"), { recursive: true });
      await writeFile(path.join(repo, "packages/cli/src/index.ts"), "export const changed = true;\n", "utf8");

      const result = await runAllowFailure(repo, ["enforce", "finish", "--json", "--dir", repo]);
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(2);
      expect(report.should_block).toBe(true);
      expect(report.findings.some((f) => f.code === "git-sync-uncommitted-shippable")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("finish gate blocks committed shippable changes without a lockstep version bump", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-finish-version-"));
    const remote = await mkdtemp(path.join(tmpdir(), "haive-finish-remote-"));
    try {
      await exec("git", ["init", "--bare"], { cwd: remote });
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeLockstepPackageJsons(repo, "0.1.0");
      await mkdir(path.join(repo, "packages/cli/src"), { recursive: true });
      await writeFile(path.join(repo, "packages/cli/src/index.ts"), "export const initial = true;\n", "utf8");
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });

      await writeFile(path.join(repo, "packages/cli/src/index.ts"), "export const initial = true;\nexport const changed = true;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "change shippable code without bump"], { cwd: repo });

      const result = await runAllowFailure(repo, ["enforce", "finish", "--json", "--dir", repo]);
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(2);
      expect(report.should_block).toBe(true);
      expect(report.findings.some((f) => f.code === "release-version-missing")).toBe(true);
      expect(report.findings.some((f) => f.code === "git-sync-unpushed-commits")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("finish gate blocks already-pushed shippable HEAD changes without a lockstep version bump", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-finish-pushed-version-"));
    const remote = await mkdtemp(path.join(tmpdir(), "haive-finish-pushed-remote-"));
    try {
      await exec("git", ["init", "--bare"], { cwd: remote });
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeLockstepPackageJsons(repo, "0.1.0");
      await mkdir(path.join(repo, "packages/cli/src"), { recursive: true });
      await writeFile(path.join(repo, "packages/cli/src/index.ts"), "export const initial = true;\n", "utf8");
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });

      await writeFile(path.join(repo, "packages/cli/src/index.ts"), "export const initial = true;\nexport const pushed = true;\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "push shippable code without bump"], { cwd: repo });
      await exec("git", ["push"], { cwd: repo });

      const result = await runAllowFailure(repo, ["enforce", "finish", "--json", "--dir", repo]);
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(2);
      expect(report.should_block).toBe(true);
      expect(report.findings.some((f) => f.code === "release-version-missing")).toBe(true);
      expect(report.findings.some((f) => f.code === "git-sync-unpushed-commits")).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("finish gate blocks when pushed GitHub Actions runs did not pass", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-failed-"));
    const remote = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-remote-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-bin-"));
    try {
      await exec("git", ["init", "--bare"], { cwd: remote });
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeLockstepPackageJsons(repo, "0.1.0");
      await writeFile(path.join(repo, "README.md"), "Initial docs.\n", "utf8");
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });

      await writeFile(path.join(repo, "README.md"), "Initial docs.\nUpdated docs.\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "docs update"], { cwd: repo });
      await exec("git", ["push"], { cwd: repo });
      await exec("git", ["remote", "set-url", "origin", "https://github.com/example/haive-test.git"], { cwd: repo });
      await writeFile(
        path.join(fakeBin, "gh"),
        "#!/bin/sh\nprintf '%s\\n' '[{\"databaseId\":123,\"workflowName\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]'\n",
        "utf8",
      );
      await chmod(path.join(fakeBin, "gh"), 0o755);

      const result = await runAllowFailure(repo, ["enforce", "finish", "--json", "--dir", repo], {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      });
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(2);
      expect(report.should_block).toBe(true);
      expect(report.findings.some((f) => f.code === "github-actions-failed")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("finish gate passes only after pushed GitHub Actions runs are successful", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-pass-"));
    const remote = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-pass-remote-"));
    const fakeBin = await mkdtemp(path.join(tmpdir(), "haive-finish-actions-pass-bin-"));
    try {
      await exec("git", ["init", "--bare"], { cwd: remote });
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await exec("git", ["config", "user.name", "Hivelore Test"], { cwd: repo });
      await writeLockstepPackageJsons(repo, "0.1.0");
      await writeFile(path.join(repo, "README.md"), "Initial docs.\n", "utf8");
      await run(repo, ["init", "--manual", "--no-mcp-setup", "--stack", "none", "--no-bootstrap", "--dir", repo]);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "initial"], { cwd: repo });
      await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });

      await writeFile(path.join(repo, "README.md"), "Initial docs.\nUpdated docs.\n", "utf8");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "docs update"], { cwd: repo });
      await exec("git", ["push"], { cwd: repo });
      await exec("git", ["remote", "set-url", "origin", "https://github.com/example/haive-test.git"], { cwd: repo });
      await writeFile(
        path.join(fakeBin, "gh"),
        "#!/bin/sh\nprintf '%s\\n' '[{\"databaseId\":123,\"workflowName\":\"ci\",\"status\":\"completed\",\"conclusion\":\"success\"}]'\n",
        "utf8",
      );
      await chmod(path.join(fakeBin, "gh"), 0o755);

      const result = await runAllowFailure(repo, ["enforce", "finish", "--json", "--dir", repo], {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      });
      const report = JSON.parse(result.stdout) as {
        should_block: boolean;
        findings: Array<{ code: string; severity: string }>;
      };

      expect(result.code).toBe(0);
      expect(report.should_block).toBe(false);
      expect(report.findings.some((f) => f.code === "github-actions-pass")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("run wraps arbitrary agent commands with a Hivelore session marker", async () => {
    const { stdout } = await run(workDir, ["run", "--dir", workDir, "--", "node", "-e", "console.log(process.env.HAIVE_ENFORCEMENT)"]);
    expect(stdout).toContain("strict");
  });

  it("benchmark report summarizes agent benchmark reports", async () => {
    const benchDir = path.join(workDir, "benchmarks", "agent-benchmark");
    const fixtureDir = path.join(benchDir, "sample-haive");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(path.join(fixtureDir, "BENCHMARK_AGENT_REPORT.md"), [
        "# Benchmark Agent Report",
        "",
        "## Commands Run",
        "- `hivelore briefing`",
        "- `npm test`",
        "",
        "## Files Read",
        "- `src/index.ts`",
        "",
        "## Files Modified",
        "- `src/index.ts`",
        "",
        "## Test Iterations",
        "- Iteration 1: passed",
        "",
        "## Key Decisions Made",
        "- followed policy",
        "",
        "## Hivelore Memory Impact",
        "Yes, directly shaped the fix.",
        "",
      ].join("\n"), "utf8");
    });

    const { stdout } = await run(workDir, ["benchmark", "report", "--dir", benchDir]);
    expect(stdout).toContain("Hivelore Agent Benchmark Report");
    expect(stdout).toContain("sample-haive");
    expect(stdout).toContain("Hivelore impact");
    expect(stdout).toContain("Evidence grade: **insufficient**");
  });

  it("benchmark evidence becomes decision-ready only with ten independently evaluated pairs", async () => {
    const benchDir = path.join(workDir, "benchmarks", "paired-contract");
    const report = (runner: string, evaluator: string): string => [
      "# Benchmark Agent Report", "", "## Outcome",
      "- Task completed: yes", "- Tests passed: yes", "- Policy violations: 0",
      "- Duration seconds: 10", "- Total tokens: 1000",
      `- Runner ID: ${runner}`, `- Evaluator ID: ${evaluator}`, "- Independent evaluation: yes", "",
    ].join("\n");
    for (let task = 1; task <= 10; task++) {
      for (const group of ["haive", "plain"]) {
        const dir = path.join(benchDir, `task-${task}-${group}`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "BENCHMARK_AGENT_REPORT.md"), report(`runner-${group}`, "blind-reviewer"), "utf8");
      }
    }
    const { stdout } = await run(workDir, ["benchmark", "report", "--dir", benchDir, "--json"]);
    const result = JSON.parse(stdout) as { summary: { paired_tasks: number; evidence_grade: string } };
    expect(result.summary).toMatchObject({ paired_tasks: 10, evidence_grade: "decision-ready" });
  });

  it("doctor --json reports stale-draft-memories when a draft is older than 30 days", async () => {
    const draftDir = await mkdtemp(path.join(tmpdir(), "haive-doctor-draft-test-"));
    try {
      await run(draftDir, ["init", "--dir", draftDir, "--no-mcp-setup"]);
      // Write a memory with draft status and a created_at > 30 days ago
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      const memId = "2020-01-01-decision-old-draft";
      await writeFile(
        path.join(draftDir, ".ai/memories/team", `${memId}.md`),
        [
          "---",
          `id: ${memId}`,
          "scope: team",
          "type: decision",
          "status: draft",
          `created_at: '${oldDate}'`,
          "anchor:",
          "  paths: []",
          "  symbols: []",
          "tags: []",
          "---",
          "# Old draft decision",
          "",
          "This has been sitting in draft for a long time.",
        ].join("\n"),
        "utf8",
      );
      const { stdout } = await run(draftDir, ["doctor", "--json", "--dir", draftDir]);
      const report = JSON.parse(stdout) as { findings: Array<{ code: string; message: string }> };
      const finding = report.findings.find((f) => f.code === "stale-draft-memories");
      expect(finding).toBeDefined();
      expect(finding?.message).toContain(memId);
    } finally {
      await rm(draftDir, { recursive: true, force: true });
    }
  });
});
