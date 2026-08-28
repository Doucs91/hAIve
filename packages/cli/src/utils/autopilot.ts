import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTOPILOT_DEFAULTS,
  buildCodeMap,
  loadCodeMap,
  loadConfig,
  loadMemoriesFromDir,
  saveCodeMap,
  saveConfig,
  type HaiveConfig,
  type HaivePaths,
} from "@hivelore/core";
import { lintMemoriesAsync } from "../commands/memory-lint.js";

export interface AutopilotRepair {
  code: string;
  message: string;
}

export interface AutopilotRepairOptions {
  applyConfig?: boolean;
  applyCorpus?: boolean;
  applyContext?: boolean;
  applyCodeMap?: boolean;
  applyCodeSearch?: boolean;
  forceCodeMap?: boolean;
}

export interface ProjectContextVersionStatus {
  expectedVersion?: string;
  currentVersion?: string;
  mismatch: boolean;
  canSync: boolean;
}

export async function applyAutopilotRepairs(
  root: string,
  paths: HaivePaths,
  options: AutopilotRepairOptions = {},
): Promise<AutopilotRepair[]> {
  const repairs: AutopilotRepair[] = [];
  const config = await loadConfig(paths);

  if (options.applyConfig) {
    const changed = await ensureAutopilotConfig(paths, config);
    if (changed) {
      repairs.push({
        code: "autopilot-config",
        message: "Enabled autopilot defaults in .ai/hivelore.config.json.",
      });
    }
  }

  const current = await loadConfig(paths);
  const autoRepair = current.autoRepair ?? {};

  if (options.applyContext ?? autoRepair.context ?? current.autopilot) {
    const changed = await syncProjectContextVersion(root, paths);
    if (changed) {
      repairs.push({
        code: "project-context-version",
        message: "Updated .ai/project-context.md version metadata from package.json.",
      });
    }
  }

  if (options.applyCorpus ?? autoRepair.corpus ?? current.autopilot) {
    const report = await lintMemoriesAsync(root, { fix: true, apply: true });
    const applied = report.fixes.filter((fix) => fix.applied);
    if (applied.length > 0) {
      repairs.push({
        code: "memory-lint-fix",
        message: `Applied ${applied.length} safe memory lint fix${applied.length === 1 ? "" : "es"}.`,
      });
    }

    const indexed = await refreshMemorySemanticIndex(paths);
    if (indexed) {
      repairs.push({
        code: "memory-embeddings-index",
        message: "Refreshed memory embeddings index.",
      });
    }
  }

  if (options.applyCodeMap ?? autoRepair.codeMap ?? current.autopilot) {
    const refreshed = await refreshCodeMap(root, paths, Boolean(options.forceCodeMap));
    if (refreshed) {
      repairs.push({
        code: "code-map-refresh",
        message: "Refreshed .ai/code-map.json.",
      });
    }
  }

  if (options.applyCodeSearch ?? autoRepair.codeSearch ?? current.autopilot) {
    const indexed = await refreshCodeSearchIndex(paths);
    if (indexed) {
      repairs.push({
        code: "code-search-index",
        message: "Refreshed code-search embeddings index.",
      });
    }
  }

  return repairs;
}

export async function ensureAutopilotConfig(
  paths: HaivePaths,
  currentConfig?: HaiveConfig,
): Promise<boolean> {
  const current = currentConfig ?? await loadConfig(paths);
  const next: HaiveConfig = {
    ...current,
    autopilot: true,
    defaultScope: "team",
    defaultStatus: "validated",
    autoApproveDelayHours: current.autoApproveDelayHours ?? AUTOPILOT_DEFAULTS.autoApproveDelayHours,
    autoPromoteMinReads: current.autoPromoteMinReads ?? AUTOPILOT_DEFAULTS.autoPromoteMinReads,
    autoSessionEnd: true,
    autoContext: true,
    autoRepair: {
      context: true,
      corpus: true,
      codeMap: true,
      codeSearch: current.autoRepair?.codeSearch ?? true,
    },
    enforcement: {
      ...AUTOPILOT_DEFAULTS.enforcement,
      ...current.enforcement,
      mode: "strict",
      requireBriefingFirst: true,
      requireSessionRecap: true,
      requireMemoryVerify: true,
      blockStaleDecisionChanges: true,
      requireDecisionCoverage: true,
      cleanupGeneratedArtifacts: true,
      toolProfile: current.enforcement?.toolProfile ?? "enforcement",
    },
  };

  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  await saveConfig(paths, next);
  return true;
}

export async function syncProjectContextVersion(
  root: string,
  paths: HaivePaths,
): Promise<boolean> {
  const status = await projectContextVersionStatus(root, paths);
  if (!status.canSync || !status.expectedVersion) return false;

  const original = await readFile(paths.projectContext, "utf8");
  let updated = original
    .replace(
      /^# Project context — Hivelore \(v[^)]+\)$/m,
      `# Project context — Hivelore (v${status.expectedVersion})`,
    )
    .replace(
      /> \*\*Current version\*\*: [^—\n]+—/m,
      `> **Current version**: ${status.expectedVersion} —`,
    );

  if (updated === original && !original.includes("Current version")) {
    updated = original.replace(
      /^(> Repo-native context enforcement[^\n]*\n)/m,
      `$1> **Current version**: ${status.expectedVersion} — @hivelore/core, cli, mcp, embeddings are versioned together.\n`,
    );
  }

  if (updated === original && !original.includes("Current version")) {
    updated = original.replace(
      /^(# Project context[^\n]*\n)/m,
      `$1\n> **Current version**: ${status.expectedVersion}\n`,
    );
  }

  if (updated === original) return false;
  await writeFile(paths.projectContext, updated, "utf8");
  return true;
}

export async function projectContextVersionStatus(
  root: string,
  paths: HaivePaths,
): Promise<ProjectContextVersionStatus> {
  if (!existsSync(paths.projectContext)) {
    return { mismatch: false, canSync: false };
  }
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) {
    return { mismatch: false, canSync: false };
  }

  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
  const expectedVersion = packageJson.version;
  if (!expectedVersion) {
    return { mismatch: false, canSync: false };
  }

  const content = await readFile(paths.projectContext, "utf8");
  const headingVersion = content.match(/^# Project context — Hivelore \(v([^)]+)\)$/m)?.[1];
  const currentLineVersion = content.match(/^> \*\*Current version\*\*: ([^—\n]+)/m)?.[1]?.trim();
  const currentVersion = currentLineVersion ?? headingVersion;

  return {
    expectedVersion,
    currentVersion,
    mismatch: currentVersion !== expectedVersion,
    canSync: true,
  };
}

async function refreshCodeMap(
  root: string,
  paths: HaivePaths,
  force: boolean,
): Promise<boolean> {
  const existing = await loadCodeMap(paths);
  if (existing && !force) return false;

  const map = await buildCodeMap(root, { includeUntracked: true });
  if (
    existing &&
    existing.root === map.root &&
    JSON.stringify(existing.files) === JSON.stringify(map.files)
  ) {
    return false;
  }
  await saveCodeMap(paths, map);
  return true;
}

async function refreshCodeSearchIndex(paths: HaivePaths): Promise<boolean> {
  try {
    const mod = await import("@hivelore/embeddings");
    // Cold start on a large repo embeds every source chunk (~40s/1600 files) — without a
    // heads-up the first briefing just looks hung. stderr keeps MCP stdout (JSON-RPC) clean.
    const cold = !existsSync(mod.codeIndexPath(paths));
    // Load the embedder FIRST: if it can't (wrong Node ABI, missing native dep), the index build
    // never succeeds, `cold` stays true forever, and announcing "one-time" on every invocation is a
    // lie the field reports flagged. Only promise the one-time build once we know it can happen.
    const embedder = await mod.Embedder.create();
    if (cold) {
      console.error(
        "[hivelore] Building the semantic code index (one-time — large repos can take a minute). " +
        "Subsequent briefings reuse the cache.",
      );
    }
    const { report } = await mod.rebuildCodeIndex(paths, embedder);
    if (cold) console.error("[hivelore] Semantic code index ready.");
    return report.added > 0 || report.updated > 0 || report.removed > 0;
  } catch {
    return false;
  }
}

async function refreshMemorySemanticIndex(paths: HaivePaths): Promise<boolean> {
  try {
    if (!existsSync(paths.memoriesDir)) return false;
    const memories = await loadMemoriesFromDir(paths.memoriesDir);
    if (memories.length === 0) return false;
    const mod = await import("@hivelore/embeddings");
    const embedder = await mod.Embedder.create();
    const { report } = await mod.rebuildIndex(paths, embedder);
    return report.added > 0 || report.updated > 0 || report.removed > 0;
  } catch {
    return false;
  }
}
