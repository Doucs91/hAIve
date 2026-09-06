import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHaivePaths } from "@hivelore/core";
import type { HaiveContext } from "../src/context.js";
import { getBriefing } from "../src/tools/get-briefing.js";

const input = {
  task: "anything", files: [], max_tokens: 4000, max_memories: 4,
  include_project_context: false, include_module_contexts: false,
  semantic: false, include_stale: false, track: false,
  format: "full" as const, symbols: [] as string[], min_semantic_score: 0,
};

/**
 * A recap is a claim about the CURRENT state of the project, and it decays. The one in field
 * report 2026-09-05 §4 was eight days and thirty PRs old, described a product name that had been
 * decided and a payment integration that had shipped, and was printed undated at the top of every
 * session. Dating it and expiring it is what makes it safe to keep showing.
 */
describe("session recap staleness", () => {
  let root: string;
  let ctx: HaiveContext;
  let memDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "haive-recap-"));
    const paths = resolveHaivePaths(root);
    memDir = path.join(paths.memoriesDir, "team");
    await mkdir(memDir, { recursive: true });
    ctx = { paths } as HaiveContext;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeRecap = async (createdAt: string): Promise<void> => {
    const fm = [
      "---", "id: recap", "scope: team", "type: session_recap", "status: validated",
      `created_at: "${createdAt}"`, `verified_at: "${createdAt}"`,
      "anchor:", "  paths: []", "  symbols: []", "tags: []", "---",
    ].join("\n");
    await writeFile(
      path.join(memDir, "recap.md"),
      `${fm}\n## Goal\nShip the naming decision.\n\n**Next steps:**\n- decide the product name\n`,
      "utf8",
    );
  };

  it("dates a fresh recap and keeps its content", async () => {
    const today = new Date().toISOString();
    await writeRecap(today);
    const out = await getBriefing(input, ctx);
    expect(out.last_session?.stale).toBe(false);
    expect(out.last_session?.as_of).toBe(today);
    expect(out.last_session?.age_days).toBe(0);
    expect(out.last_session?.body).toContain("Ship the naming decision");
  });

  it("expires an old recap instead of presenting it as the current state", async () => {
    await writeRecap(new Date(Date.now() - 20 * 86_400_000).toISOString());
    const out = await getBriefing(input, ctx);
    expect(out.last_session?.stale).toBe(true);
    expect(out.last_session?.age_days).toBeGreaterThan(7);
    expect(out.last_session?.body).toContain("No recent session recap");
    // The stale claim itself must not survive into the briefing head.
    expect(out.last_session?.body).not.toContain("Ship the naming decision");
  });
});
