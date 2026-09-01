import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHaivePaths } from "@hivelore/core";
import type { HaiveContext } from "../src/context.js";
import { bootstrapProjectSave } from "../src/tools/bootstrap-project-save.js";
import { getProjectContext } from "../src/tools/get-project-context.js";
import { getBriefing } from "../src/tools/get-briefing.js";
import { memList } from "../src/tools/mem-list.js";
import { memSave } from "../src/tools/mem-save.js";
import { memSearch } from "../src/tools/mem-search.js";
import { memSessionEnd } from "../src/tools/mem-session-end.js";
import { memTried } from "../src/tools/mem-tried.js";
import { preCommitCheck } from "../src/tools/precommit-check.js";
import { pendingDistillPath, type PendingDistill } from "../src/session-tracker.js";

describe("Hivelore MCP tools", () => {
  let workDir: string;
  let ctx: HaiveContext;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "haive-mcp-test-"));
    const paths = resolveHaivePaths(workDir);
    await mkdir(paths.personalDir, { recursive: true });
    await mkdir(paths.teamDir, { recursive: true });
    await mkdir(paths.moduleDir, { recursive: true });
    await mkdir(paths.modulesContextDir, { recursive: true });
    ctx = { paths };
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("mem_save", () => {
    it("creates a personal memory by default", async () => {
      const out = await memSave(
        {
          type: "convention",
          slug: "use-pnpm",
          body: "Always use pnpm.",
          scope: "personal",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );
      expect(out.scope).toBe("personal");
      expect(out.id).toMatch(/-convention-use-pnpm$/);
      const written = await readFile(out.file_path, "utf8");
      expect(written).toContain("Always use pnpm.");
      expect(written).toContain("scope: personal");
    });

    it("creates a team memory when scope=team", async () => {
      const out = await memSave(
        {
          type: "decision",
          slug: "no-lodash",
          body: "Decided: no lodash.",
          scope: "team",
          tags: ["dependencies"],
          paths: [],
          symbols: [],
        },
        ctx,
      );
      expect(out.scope).toBe("team");
      expect(out.file_path).toContain("/memories/team/");
    });

    it("does not write body into frontmatter during topic upsert", async () => {
      const created = await memSave(
        {
          type: "decision",
          slug: "topic-upsert",
          body: "# Topic upsert\n\nUse the first rule because it is stable.",
          scope: "team",
          tags: [],
          paths: ["src/service.ts"],
          symbols: [],
          topic: "decision/topic-upsert",
        },
        ctx,
      );

      await memSave(
        {
          type: "decision",
          slug: "topic-upsert",
          body: "# Topic upsert\n\nUse the second rule because it is newer.",
          scope: "team",
          tags: [],
          paths: ["src/service.ts"],
          symbols: [],
          topic: "decision/topic-upsert",
        },
        ctx,
      );

      const written = await readFile(created.file_path, "utf8");
      const frontmatter = written.split("---")[1] ?? "";
      expect(frontmatter).not.toContain("body:");
      expect(written).toContain("Use the second rule");
    });

    it("warns when a validated decision is saved without anchors", async () => {
      await writeFile(
        path.join(ctx.paths.haiveDir, "hivelore.config.json"),
        JSON.stringify({ defaultStatus: "validated" }),
        "utf8",
      );
      const out = await memSave(
        {
          type: "decision",
          slug: "anchorless-validated",
          body: "# Anchorless validated\n\nAlways explain this decision because future agents need context.",
          scope: "team",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );

      expect(out.warning).toContain("validated without paths or symbols");
    });

    it("does not persist a sensor for an anchored gotcha — reports loop_open + routes to propose_sensor", async () => {
      const out = await memSave(
        {
          type: "gotcha",
          slug: "no-bigint",
          body: "# No BigInt\n\n`BigInt` broke JSON serialization. **Instead, use:** Decimal strings.",
          scope: "team",
          tags: [],
          paths: ["src/math.ts"],
          symbols: [],
        },
        ctx,
      );
      // propose_sensor is the sole writer of live sensors: mem_save reports the open loop and points
      // at propose_sensor / the diff miner — no prose-mined seed (it produced junk 7/7 in the field).
      expect(out.loop_open).toBe(true);
      expect(out.proposed_sensor_seed).toBeUndefined();
      expect(out.sensor_hint).toMatch(/propose_sensor/);
      const written = await readFile(out.file_path, "utf8");
      expect(written).not.toContain("sensor:");
    });

    it("rejects when .ai/ does not exist", async () => {
      const emptyCtx: HaiveContext = { paths: resolveHaivePaths(path.join(workDir, "missing")) };
      await expect(
        memSave(
          {
            type: "convention",
            slug: "x",
            body: "y",
            scope: "personal",
            tags: [],
            paths: [],
            symbols: [],
          },
          emptyCtx,
        ),
      ).rejects.toThrow(/No \.ai\/ directory/);
    });
  });

  describe("mem_tried", () => {
    it("records an anchored attempt without a persisted sensor — loop_open + routes to propose_sensor", async () => {
      const out = await memTried(
        {
          what: "Using BigInt in math",
          why_failed: "`BigInt` broke JSON serialization.",
          instead: "use Decimal strings at API boundaries",
          scope: "team",
          tags: [],
          paths: ["src/math.ts"],
        },
        ctx,
      );

      expect(out.loop_open).toBe(true);
      expect(out.proposed_sensor_seed).toBeUndefined();
      const written = await readFile(out.file_path, "utf8");
      expect(written).toContain("type: attempt");
      expect(written).toContain("status: validated");
      expect(written).not.toContain("sensor:");
    });
  });

  describe("mem_search & mem_list", () => {
    beforeEach(async () => {
      await memSave(
        {
          type: "convention",
          slug: "use-pnpm",
          body: "Always use pnpm in this project.",
          scope: "personal",
          tags: ["tooling"],
          paths: [],
          symbols: [],
        },
        ctx,
      );
      await memSave(
        {
          type: "decision",
          slug: "no-lodash",
          body: "Decided to drop lodash.",
          scope: "team",
          tags: ["dependencies"],
          paths: [],
          symbols: [],
        },
        ctx,
      );
    });

    it("mem_search finds by tag substring", async () => {
      const result = await memSearch({ query: "tooling", limit: 20 }, ctx);
      expect(result.matches.length).toBe(1);
      expect(result.matches[0]!.id).toContain("use-pnpm");
      expect(result.matches[0]!.snippet).toContain("pnpm");
    });

    it("mem_search filters by scope", async () => {
      const result = await memSearch(
        { query: "pnpm", scope: "team", limit: 20 },
        ctx,
      );
      expect(result.matches.length).toBe(0);
    });

    it("mem_list returns all memories with no filters", async () => {
      const { memories } = await memList({}, ctx);
      expect(memories.length).toBe(2);
    });

    it("mem_list filters by type", async () => {
      const { memories } = await memList({ type: "decision" }, ctx);
      expect(memories.length).toBe(1);
      expect(memories[0]!.id).toContain("no-lodash");
    });
  });

  describe("get_project_context", () => {
    it("returns null when no project-context.md", async () => {
      const out = await getProjectContext({ list_modules: false }, ctx);
      expect(out.root_context).toBeNull();
    });

    it("returns root context content when present", async () => {
      await writeFile(ctx.paths.projectContext, "# hello", "utf8");
      const out = await getProjectContext({ list_modules: false }, ctx);
      expect(out.root_context).toBe("# hello");
    });

    it("includes module context when requested", async () => {
      const modDir = path.join(ctx.paths.modulesContextDir, "transactions");
      await mkdir(modDir, { recursive: true });
      await writeFile(path.join(modDir, "context.md"), "# transactions", "utf8");
      const out = await getProjectContext(
        { module: "transactions", list_modules: false },
        ctx,
      );
      expect(out.module_context?.name).toBe("transactions");
      expect(out.module_context?.content).toBe("# transactions");
    });

    it("lists available modules when requested", async () => {
      await mkdir(path.join(ctx.paths.modulesContextDir, "a"), { recursive: true });
      await mkdir(path.join(ctx.paths.modulesContextDir, "b"), { recursive: true });
      const out = await getProjectContext({ list_modules: true }, ctx);
      expect(out.available_modules).toEqual(["a", "b"]);
    });
  });

  describe("bootstrap_project_save", () => {
    it("creates the root project-context.md", async () => {
      const out = await bootstrapProjectSave(
        { content: "# Project\n\nHello.", overwrite: false },
        ctx,
      );
      expect(out.action).toBe("created");
      expect(out.file_path).toBe(ctx.paths.projectContext);
      const written = await readFile(ctx.paths.projectContext, "utf8");
      expect(written).toContain("Hello.");
    });

    it("refuses to overwrite without overwrite=true", async () => {
      await writeFile(ctx.paths.projectContext, "old", "utf8");
      await expect(
        bootstrapProjectSave({ content: "new", overwrite: false }, ctx),
      ).rejects.toThrow(/already exists/);
    });

    it("overwrites when overwrite=true", async () => {
      await writeFile(ctx.paths.projectContext, "old", "utf8");
      const out = await bootstrapProjectSave(
        { content: "new", overwrite: true },
        ctx,
      );
      expect(out.action).toBe("overwritten");
      const written = await readFile(ctx.paths.projectContext, "utf8");
      expect(written).toBe("new");
    });

    it("writes module context under .ai/modules/<name>/context.md", async () => {
      const out = await bootstrapProjectSave(
        { content: "# transactions", module: "transactions", overwrite: false },
        ctx,
      );
      expect(out.file_path).toContain("/modules/transactions/context.md");
      const written = await readFile(out.file_path, "utf8");
      expect(written).toBe("# transactions");
    });
  });

  describe("get_briefing relevance priority", () => {
    it("surfaces exact and glob anchors ahead of popular background memories", async () => {
      await mkdir(path.join(workDir, "src", "features"), { recursive: true });
      await writeFile(path.join(workDir, "src", "features", "app.ts"), "export const app = true;\n", "utf8");

      const anchored = await memSave(
        {
          type: "decision",
          slug: "app-feature-policy",
          body: "# App feature policy\n\nAlways use the existing feature boundary because it owns app state.",
          scope: "team",
          tags: [],
          paths: ["src/**/*.ts"],
          symbols: [],
        },
        ctx,
      );
      const popular = await memSave(
        {
          type: "convention",
          slug: "popular-general-note",
          body: "# Popular general note\n\nAlways keep release notes tidy because readers scan them.",
          scope: "team",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );

      const { loadMemoriesFromDir, serializeMemory, trackReads } = await import("@hivelore/core");
      const loaded = await loadMemoriesFromDir(ctx.paths.memoriesDir);
      for (const item of loaded) {
        await writeFile(
          item.filePath,
          serializeMemory({
            frontmatter: { ...item.memory.frontmatter, status: "validated" },
            body: item.memory.body,
          }),
          "utf8",
        );
      }
      for (let i = 0; i < 25; i++) await trackReads(ctx.paths, [popular.id]);

      const briefing = await getBriefing(
        {
          task: "touch the app feature",
          files: ["src/features/app.ts"],
          max_tokens: 4000,
          max_memories: 8,
          include_project_context: false,
          include_module_contexts: false,
          semantic: false,
          include_stale: false,
          track: false,
          format: "full",
          symbols: [],
          min_semantic_score: 0,
        },
        ctx,
      );

      expect(briefing.memories[0]?.id).toBe(anchored.id);
      expect(briefing.memories[0]?.priority).toBe("must_read");
      expect(briefing.memories[0]?.why?.some((w) => w.includes("Glob anchor match"))).toBe(true);
      expect(briefing.breadcrumbs?.start_here[0]).toContain(anchored.id);
      expect(briefing.breadcrumbs?.drill_down.some((d) => d.includes(`mem_get("${anchored.id}")`))).toBe(true);
      // Breadcrumbs are a pointer map, not a copy: the memory body must NOT be re-summarized into start_here.
      expect(briefing.breadcrumbs?.start_here.join("\n")).not.toContain("owns app state");
      // Structured twin: typed pointer for the same memory, still a pointer (no body text).
      const memItem = briefing.breadcrumbs?.start_here_items?.find((i) => i.type === "memory" && i.id === anchored.id);
      expect(memItem).toBeDefined();
      expect(JSON.stringify(memItem)).not.toContain("owns app state");
      // The server stamps its version so a stale MCP vs the repo is detectable in-band.
      expect(typeof briefing.server_version).toBe("string");
      expect(briefing.server_version.length).toBeGreaterThan(0);
      // The breadcrumbs payload is now counted honestly toward the budget.
      expect(briefing.budget.spent.breadcrumbs).toBeGreaterThan(0);
      expect(briefing.estimated_tokens).toBeGreaterThanOrEqual(
        briefing.budget.spent.project + briefing.budget.spent.modules + briefing.budget.spent.memories,
      );
      expect(briefing.briefing_quality.level).toBe("strong");
    });

    // v0.39.2: the hard cap's escape hatch (direct anchor) is unreachable for anchor-less stack seeds,
    // so a STRONG task hit now rescues them to `useful` (never must_read) — see
    // 2026-07-04-decision-stack-pack-rescue-strong-task-evidence.
    it("rescues an unanchored stack-pack seed to useful (never must_read) on a strong task match", async () => {
      const seed = await memSave(
        {
          type: "gotcha",
          slug: "express-async-error-propagation",
          body: "# Express async errors\n\nAsync route handlers do not propagate errors to error middleware without explicit next(err).",
          scope: "team",
          tags: ["express", "error-handling", "stack-pack"],
          paths: [],
          symbols: [],
        },
        ctx,
      );

      const { loadMemoriesFromDir, serializeMemory } = await import("@hivelore/core");
      for (const item of await loadMemoriesFromDir(ctx.paths.memoriesDir)) {
        await writeFile(
          item.filePath,
          serializeMemory({ frontmatter: { ...item.memory.frontmatter, status: "validated" }, body: item.memory.body }),
          "utf8",
        );
      }

      const briefing = await getBriefing(
        {
          task: "express async route handler error propagation middleware",
          files: ["src/routes.ts"],
          max_tokens: 4000, max_memories: 8,
          include_project_context: false, include_module_contexts: false,
          semantic: false, include_stale: false, track: false, format: "full",
          symbols: [], min_semantic_score: 0,
        },
        ctx,
      );

      const seedHit = briefing.memories.find((m) => m.id === seed.id);
      expect(seedHit).toBeDefined();
      expect(seedHit!.priority).toBe("useful");
    });

    it("writes a briefing marker so MCP-native agents satisfy the enforcement gate", async () => {
      const anchored = await memSave(
        {
          type: "decision",
          slug: "routes-policy",
          body: "# Routes policy\n\nAll routes go through the shared router because it centralises auth.",
          scope: "team",
          tags: [],
          paths: ["src/routes.ts"],
          symbols: [],
        },
        ctx,
      );
      const { loadMemoriesFromDir, serializeMemory, readRecentBriefingMarker } = await import("@hivelore/core");
      for (const item of await loadMemoriesFromDir(ctx.paths.memoriesDir)) {
        await writeFile(
          item.filePath,
          serializeMemory({ frontmatter: { ...item.memory.frontmatter, status: "validated" }, body: item.memory.body }),
          "utf8",
        );
      }

      await getBriefing(
        {
          task: "edit the router", files: ["src/routes.ts"],
          max_tokens: 4000, max_memories: 8,
          include_project_context: false, include_module_contexts: false,
          semantic: false, include_stale: false, track: false, format: "full",
          symbols: [], min_semantic_score: 0,
        },
        ctx,
      );

      const marker = await readRecentBriefingMarker(ctx.paths);
      expect(marker).not.toBeNull();
      expect(marker!.source).toBe("mcp-get-briefing");
      expect(marker!.files).toContain("src/routes.ts");
      expect(marker!.memory_ids).toContain(anchored.id);
    });

    it("keeps directly relevant attempts as must_read", async () => {
      const attempt = await memSave(
        {
          type: "attempt",
          slug: "wrong-api-shape",
          body: "# Wrong API shape\n\nDo not use the wrong API shape because it throws; use the typed client instead.",
          scope: "team",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );

      const briefing = await getBriefing(
        {
          task: "wrong api shape",
          files: [],
          max_tokens: 4000,
          max_memories: 8,
          include_project_context: false,
          include_module_contexts: false,
          semantic: false,
          include_stale: false,
          track: false,
          format: "full",
          symbols: [],
          min_semantic_score: 0,
        },
        ctx,
      );

      expect(briefing.memories[0]?.id).toBe(attempt.id);
      expect(briefing.memories[0]?.priority).toBe("must_read");
      expect(briefing.memories[0]?.why?.join(" ")).toContain("Failed-approach");
    });

    it("does not surface retired attempts unless stale memories are explicitly included", async () => {
      const attempt = await memSave(
        {
          type: "attempt",
          slug: "old-cli-flag",
          body: "# Old CLI flag\n\nFixed in 0.10.0; this attempt is kept only for audit history.",
          scope: "team",
          tags: [],
          paths: ["packages/cli/src/commands/init.ts"],
          symbols: [],
        },
        ctx,
      );

      const briefing = await getBriefing(
        {
          task: "edit init command",
          files: ["packages/cli/src/commands/init.ts"],
          max_tokens: 4000,
          max_memories: 8,
          include_project_context: false,
          include_module_contexts: false,
          semantic: false,
          include_stale: false,
          track: false,
          format: "full",
          symbols: [],
          min_semantic_score: 0,
        },
        ctx,
      );

      expect(briefing.memories.some((m) => m.id === attempt.id)).toBe(false);
    });

    it("classifies weak literal-only results as thin/background", async () => {
      await memSave(
        {
          type: "convention",
          slug: "single-word-overlap",
          body: "# Single overlap\n\nAlways document releases because humans read changelogs.",
          scope: "team",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );

      const briefing = await getBriefing(
        {
          task: "release postgres cache auth",
          files: [],
          max_tokens: 4000,
          max_memories: 8,
          include_project_context: false,
          include_module_contexts: false,
          semantic: false,
          include_stale: false,
          track: false,
          format: "full",
          symbols: [],
          min_semantic_score: 0,
        },
        ctx,
      );

      expect(briefing.memories[0]?.priority).toBe("background");
      expect(briefing.briefing_quality.level).toBe("thin");
    });
  });

  describe("pending distill (Phase 2)", () => {
    it("get_briefing surfaces action_required when pending-distill.json exists", async () => {
      // Simulate what SessionTracker writes at shutdown
      const cacheDir = path.join(ctx.paths.haiveDir, ".cache");
      await mkdir(cacheDir, { recursive: true });
      const payload: PendingDistill = {
        session_start: new Date(Date.now() - 30 * 60_000).toISOString(),
        session_end: new Date(Date.now() - 5 * 60_000).toISOString(),
        total_tool_calls: 12,
        tool_summary: "get_briefing ×2, mem_save ×1",
        memories_saved: ["2026-05-03-gotcha-xyz"],
        git_diff_available: false,
      };
      await writeFile(pendingDistillPath(ctx), JSON.stringify(payload), "utf8");

      const briefing = await getBriefing(
        { task: "fix a bug", files: [], max_tokens: 4000, max_memories: 5,
          include_project_context: false, include_module_contexts: false,
          semantic: false, include_stale: false, track: false, format: "full",
          symbols: [], min_semantic_score: 0 },
        ctx,
      );

      const distillItem = briefing.action_required.find(
        (a) => a.id === "__pending_distill__",
      );
      expect(distillItem).toBeDefined();
      expect(distillItem!.summary).toContain("undistilled learnings");
      expect(distillItem!.developer_message).toContain("post_task");
      expect(distillItem!.developer_message).toContain("12 tool calls");
    });

    it("mem_session_end clears the pending-distill marker", async () => {
      const cacheDir = path.join(ctx.paths.haiveDir, ".cache");
      await mkdir(cacheDir, { recursive: true });
      const payload: PendingDistill = {
        session_start: new Date().toISOString(),
        session_end: new Date().toISOString(),
        total_tool_calls: 5,
        tool_summary: "get_briefing ×1",
        memories_saved: [],
        git_diff_available: false,
      };
      const markerPath = pendingDistillPath(ctx);
      await writeFile(markerPath, JSON.stringify(payload), "utf8");
      expect(existsSync(markerPath)).toBe(true);

      await memSessionEnd(
        { goal: "test session", accomplished: "done", discoveries: "",
          files_touched: [], next_steps: "", scope: "personal" },
        ctx,
      );

      expect(existsSync(markerPath)).toBe(false);
    });

    it("mem_session_end refreshes verified_at when updating an existing recap", async () => {
      await memSessionEnd(
        { goal: "first pass", accomplished: "done", discoveries: "",
          files_touched: ["src/old.ts"], next_steps: "", scope: "team" },
        ctx,
      );
      const { loadMemoriesFromDir } = await import("@hivelore/core");
      const before = (await loadMemoriesFromDir(ctx.paths.memoriesDir))
        .find(({ memory }) => memory.frontmatter.type === "session_recap");
      expect(before).toBeDefined();

      await memSessionEnd(
        { goal: "second pass", accomplished: "still done", discoveries: "",
          files_touched: ["src/new.ts"], next_steps: "", scope: "team" },
        ctx,
      );
      const after = (await loadMemoriesFromDir(ctx.paths.memoriesDir))
        .find(({ memory }) => memory.frontmatter.type === "session_recap");

      expect(after?.memory.frontmatter.id).toBe(before?.memory.frontmatter.id);
      expect(after?.memory.frontmatter.revision_count).toBe(1);
      expect(after?.memory.frontmatter.created_at).toBe(before?.memory.frontmatter.created_at);
      expect(after?.memory.frontmatter.verified_at).toEqual(expect.any(String));
    });

    it("get_briefing auto-expires pending-distill older than 7 days", async () => {
      const cacheDir = path.join(ctx.paths.haiveDir, ".cache");
      await mkdir(cacheDir, { recursive: true });
      const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
      const payload: PendingDistill = {
        session_start: old,
        session_end: old,
        total_tool_calls: 3,
        tool_summary: "get_briefing ×1",
        memories_saved: [],
        git_diff_available: false,
      };
      const markerPath = pendingDistillPath(ctx);
      await writeFile(markerPath, JSON.stringify(payload), "utf8");

      await getBriefing(
        { task: "anything", files: [], max_tokens: 4000, max_memories: 5,
          include_project_context: false, include_module_contexts: false,
          semantic: false, include_stale: false, track: false, format: "full",
          symbols: [], min_semantic_score: 0 },
        ctx,
      );

      // File should have been auto-deleted
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  describe("inline auto-promote in get_briefing (Phase 4)", () => {
    it("promotes after 1 read when config autoPromoteMinReads=1", async () => {
      // Autopilot-style config: promote immediately on first read
      await writeFile(
        path.join(ctx.paths.haiveDir, "hivelore.config.json"),
        JSON.stringify({ autoPromoteMinReads: 1 }),
        "utf8",
      );
      const saved = await memSave(
        {
          type: "convention",
          slug: "fast-promote",
          body: "Should promote after just one briefing read.",
          scope: "team",
          tags: ["test"],
          paths: [],
        },
        ctx,
      );
      // Force status to proposed
      const { loadMemoriesFromDir, serializeMemory } = await import("@hivelore/core");
      const mems = await loadMemoriesFromDir(ctx.paths.memoriesDir);
      const target = mems.find((m) => m.memory.frontmatter.id === saved.id);
      expect(target).toBeDefined();
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(
        target!.filePath,
        serializeMemory({
          frontmatter: { ...target!.memory.frontmatter, status: "proposed" },
          body: target!.memory.body,
        }),
        "utf8",
      );
      // A single get_briefing should be enough to promote it
      await getBriefing(
        {
          task: "fast-promote convention test",
          files: [],
          max_tokens: 4000,
          max_memories: 10,
          include_project_context: false,
          include_module_contexts: false,
          semantic: false,
          include_stale: false,
          track: true,
          format: "full",
          symbols: [],
          min_semantic_score: 0,
        },
        ctx,
      );
      const afterMems = await loadMemoriesFromDir(ctx.paths.memoriesDir);
      const promoted = afterMems.find((m) => m.memory.frontmatter.id === saved.id);
      expect(promoted?.memory.frontmatter.status).toBe("validated");
    });

    it("promotes a proposed memory to validated once read_count >= minReads (5)", async () => {
      // Save a proposed memory
      const saved = await memSave(
        {
          type: "convention",
          slug: "auto-promote-me",
          body: "This should auto-promote after 5 reads.",
          scope: "team",
          tags: ["test"],
          paths: [],
          topic: undefined,
          symbols: undefined,
          author: undefined,
        },
        ctx,
      );
      // Manually force status to proposed
      const { loadMemoriesFromDir, serializeMemory } = await import("@hivelore/core");
      const mems = await loadMemoriesFromDir(ctx.paths.memoriesDir);
      const target = mems.find((m) => m.memory.frontmatter.id === saved.id);
      expect(target).toBeDefined();
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(
        target!.filePath,
        serializeMemory({
          frontmatter: { ...target!.memory.frontmatter, status: "proposed" },
          body: target!.memory.body,
        }),
        "utf8",
      );

      // Run get_briefing 5 times — each call increments read_count
      const briefingOpts = {
        task: "auto-promote-me convention test",
        files: [],
        max_tokens: 4000,
        max_memories: 10,
        include_project_context: false,
        include_module_contexts: false,
        semantic: false,
        include_stale: false,
        track: true,
        format: "full" as const,
        symbols: [],
        min_semantic_score: 0,
      };
      for (let i = 0; i < 5; i++) {
        await getBriefing(briefingOpts, ctx);
      }

      // The memory should now be validated on disk
      const afterMems = await loadMemoriesFromDir(ctx.paths.memoriesDir);
      const promoted = afterMems.find((m) => m.memory.frontmatter.id === saved.id);
      expect(promoted?.memory.frontmatter.status).toBe("validated");
    });
  });

  describe("mem_save scope resolution", () => {
    it("respects explicit scope:personal even when config defaultScope is team", async () => {
      // Write a config that would normally force team scope
      await writeFile(
        path.join(ctx.paths.haiveDir, "hivelore.config.json"),
        JSON.stringify({ defaultScope: "team" }),
        "utf8",
      );
      const out = await memSave(
        {
          type: "convention",
          slug: "explicit-personal",
          body: "This is a personal note and should stay personal.",
          scope: "personal",
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );
      expect(out.scope).toBe("personal");
      expect(out.file_path).toContain("/memories/personal/");
    });

    it("falls back to config defaultScope when scope is not provided", async () => {
      await writeFile(
        path.join(ctx.paths.haiveDir, "hivelore.config.json"),
        JSON.stringify({ defaultScope: "team" }),
        "utf8",
      );
      const out = await memSave(
        {
          type: "convention",
          slug: "team-default",
          body: "This should go to team because of defaultScope config.",
          // scope intentionally omitted
          tags: [],
          paths: [],
          symbols: [],
        },
        ctx,
      );
      expect(out.scope).toBe("team");
      expect(out.file_path).toContain("/memories/team/");
    });
  });

  describe("pre_commit_check false-positive handling", () => {
    it("does not block high-confidence mode on literal-only anti-pattern matches", async () => {
      const saved = await memSave(
        {
          type: "gotcha",
          slug: "package-json-generic",
          body: "Avoid changing package.json from npm install output unless dependency changes were intended.",
          scope: "team",
          tags: ["tooling"],
          paths: [],
        },
        ctx,
      );
      const { loadMemoriesFromDir, serializeMemory } = await import("@hivelore/core");
      const target = (await loadMemoriesFromDir(ctx.paths.memoriesDir))
        .find(({ memory }) => memory.frontmatter.id === saved.id);
      expect(target).toBeDefined();
      await writeFile(
        target!.filePath,
        serializeMemory({
          frontmatter: { ...target!.memory.frontmatter, status: "validated" },
          body: target!.memory.body,
        }),
        "utf8",
      );

      const result = await preCommitCheck(
        {
          diff: [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@",
            "+// package json metadata label",
          ].join("\n"),
          paths: ["src/app.ts"],
          block_on: "high-confidence",
          semantic: false,
        },
        ctx,
      );

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.summary.blocking_warnings).toBe(0);
      expect(result.should_block).toBe(false);
      expect(result.warnings[0]?.reasons).toEqual(["literal"]);
    });

    it("does not block high-confidence mode on anchor-only anti-pattern matches", async () => {
      await writeFile(path.join(workDir, "package.json"), "{\"version\":\"1.0.0\"}\n", "utf8");
      await memSave(
        {
          type: "gotcha",
          slug: "package-version-bump",
          body: "Do not change package versions unless preparing a release.",
          scope: "team",
          tags: ["release"],
          paths: ["package.json"],
        },
        ctx,
      );

      const result = await preCommitCheck(
        {
          diff: [
            "diff --git a/package.json b/package.json",
            "--- a/package.json",
            "+++ b/package.json",
            "@@",
            '-  \"description\": \"old\"',
            '+  \"description\": \"new\"',
          ].join("\n"),
          paths: ["package.json"],
          block_on: "high-confidence",
          semantic: false,
        },
        ctx,
      );

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.summary.blocking_warnings).toBe(0);
      expect(result.should_block).toBe(false);
      // Diff-aware literal matching only looks at ADDED lines, so the change to "description"
      // (which the memory body does not mention) is a pure anchor match — no literal noise from
      // the "package.json" diff header. Anchor-only still never blocks in high-confidence mode.
      expect(result.warnings[0]?.reasons).toEqual(["anchor"]);
    });

    it("downgrades docs-only anti-pattern matches to info", async () => {
      await memSave(
        {
          type: "gotcha",
          slug: "npm-build-runtime",
          body: "Avoid npm build changes that alter runtime service behavior unless the deployment path is tested.",
          scope: "team",
          tags: ["build", "runtime"],
          paths: [],
        },
        ctx,
      );

      const result = await preCommitCheck(
        {
          diff: [
            "diff --git a/CHANGELOG.md b/CHANGELOG.md",
            "--- a/CHANGELOG.md",
            "+++ b/CHANGELOG.md",
            "@@",
            "+Mention npm build runtime notes.",
          ].join("\n"),
          paths: ["CHANGELOG.md"],
          block_on: "any",
          semantic: false,
        },
        ctx,
      );

      expect(result.should_block).toBe(false);
      expect(result.summary.info_warnings).toBeGreaterThan(0);
      expect(result.warnings.every((w) => w.level === "info")).toBe(true);
      expect(result.warnings[0]?.rationale).toContain("docs/changelog-only");
    });

    it("keeps .ai usage telemetry non-blocking", async () => {
      await memSave(
        {
          type: "gotcha",
          slug: "usage-log-noise",
          body: "Avoid committing generated usage logs because they are local telemetry.",
          scope: "team",
          tags: ["usage"],
          paths: [],
        },
        ctx,
      );

      const result = await preCommitCheck(
        {
          diff: "+generated usage log entry",
          paths: [".ai/.usage/tool-usage.jsonl"],
          block_on: "any",
          semantic: false,
        },
        ctx,
      );

      expect(result.should_block).toBe(false);
      expect(result.warnings.every((w) => w.level === "info")).toBe(true);
    });
  });

  describe("first-agent bootstrap directive (get_briefing)", () => {
    async function writeCodeMap(files: string[]): Promise<void> {
      for (const file of files) {
        const absolute = path.join(workDir, file);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, "export const fixture = true;\n", "utf8");
      }
      const map = {
        version: 1,
        generated_at: new Date().toISOString(),
        root: workDir,
        files: Object.fromEntries(files.map((f) => [f, { exports: [] }])),
      };
      await writeFile(path.join(ctx.paths.haiveDir, "code-map.json"), JSON.stringify(map), "utf8");
    }

    const briefingArgs = {
      task: "do work", files: [], max_tokens: 4000, max_memories: 5,
      include_project_context: false, include_module_contexts: false,
      semantic: false, include_stale: false, track: false, format: "full" as const,
      symbols: [], min_semantic_score: 0,
    };

    it("surfaces __bootstrap_required__ when the corpus is cold and the repo has main code areas", async () => {
      await writeCodeMap(["packages/api/a.ts", "packages/api/b.ts", "packages/api/c.ts"]);
      // project-context absent + no memories → cold.
      const briefing = await getBriefing(briefingArgs, ctx);
      const item = briefing.action_required.find((a) => a.id === "__bootstrap_required__");
      expect(item).toBeDefined();
      expect(item!.developer_message).toMatch(/first agent/i);
      expect(item!.developer_message).toMatch(/packages\/api/);
    });

    it("does NOT surface the directive when there are no main code areas", async () => {
      await writeCodeMap(["only/one.ts"]); // below the component floor
      const briefing = await getBriefing(briefingArgs, ctx);
      expect(briefing.action_required.find((a) => a.id === "__bootstrap_required__")).toBeUndefined();
    });

    it("goes silent once the knowledge layer is ready", async () => {
      await writeCodeMap(["packages/api/a.ts", "packages/api/b.ts", "packages/api/c.ts"]);
      await writeFile(
        ctx.paths.projectContext,
        "# Project context\n\n## Architecture\n" + "A real, filled overview of the api package. ".repeat(8),
        "utf8",
      );
      // One anchored memory in packages/api carrying a sensor → memory + sensor coverage satisfied.
      await writeFile(
        path.join(ctx.paths.teamDir, "2026-01-01-gotcha-api.md"),
        [
          "---",
          "id: 2026-01-01-gotcha-api",
          "scope: team",
          "type: gotcha",
          "status: validated",
          "created_at: '2026-01-01T00:00:00.000Z'",
          "anchor:",
          "  paths: [packages/api/a.ts]",
          "  symbols: []",
          "sensor:",
          "  kind: regex",
          "  pattern: getUser",
          "  paths: [packages/api/a.ts]",
          "  message: m",
          "  severity: warn",
          "  autogen: true",
          "  last_fired: null",
          "tags: []",
          "---",
          "# Api guard",
          "",
          "Repo-specific rule for the api package.",
          "",
        ].join("\n"),
        "utf8",
      );
      const briefing = await getBriefing(briefingArgs, ctx);
      expect(briefing.action_required.find((a) => a.id === "__bootstrap_required__")).toBeUndefined();
    });
  });
});
