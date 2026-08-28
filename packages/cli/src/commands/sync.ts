import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  appendProposedRetrievalCases,
  DEFAULT_AUTO_PROMOTE_RULE,
  assessSensorHealth,
  sensorPromotedAtMap,
  buildFrontmatter,
  existingGateMissShas,
  findProjectRoot,
  getUsage,
  gatePassedShas,
  isAutoPromoteEligible,
  isDecaying,
  isStackPackSeed,
  loadCodeMap,
  loadConfig,
  loadMemoriesFromDir,
  loadSensorLedger,
  loadUsageIndex,
  pullCrossRepoSources,
  planGitWatch,
  proposeGateMissDrafts,
  resolveHaivePaths,
  resolveManifestFiles,
  serializeMemory,
  withQuarantineNote,
  trackDependencies,
  verifyAnchor,
  watchContracts,
  type GitCommit,
  type GitWatchState,
} from "@hivelore/core";
import { BRIDGE_TARGETS, type BridgeTarget } from "@hivelore/core";
import { ui } from "../utils/ui.js";
import { applyAutopilotRepairs } from "../utils/autopilot.js";
import { writeBridgeFiles } from "../utils/bridge-files.js";

const BRIDGE_START = "<!-- haive:memories-start -->";
const BRIDGE_END = "<!-- haive:memories-end -->";

interface SyncOptions {
  dir?: string;
  quiet?: boolean;
  since?: string;
  verify?: boolean;
  promote?: boolean;
  injectBridge?: boolean;
  bridgeFile?: string;
  bridgeMaxMemories?: string;
  embed?: boolean;
  noCrossRepo?: boolean;
  noDeps?: boolean;
  noContracts?: boolean;
  noBridges?: boolean;
  dryRun?: boolean;
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description(
      "Refresh memory state after a git pull or merge.\n" +
      "  What it does:\n" +
      "    1. Verifies anchor paths — marks stale if files/symbols moved or deleted\n" +
      "    2. Re-validates previously stale memories that are now fresh\n" +
      "    3. Auto-promotes proposed memories (by usage count or time delay in autopilot)\n" +
      "    4. Auto-refreshes code-map if source files changed\n" +
      "    5. Reports decay warnings for memories unused >90 days\n\n" +
      "  Install git hooks to run sync automatically: hivelore enforce install\n\n" +
      "  Examples:\n" +
      "    hivelore sync\n" +
      "    hivelore sync --dry-run      # preview what would change without writing\n" +
      "    hivelore sync --since main   # also report memories changed since main\n" +
      "    hivelore sync --embed        # also rebuild embeddings index\n",
    )
    .option("-d, --dir <dir>", "project root")
    .option("--quiet", "minimal output (suitable for git hooks)")
    .option(
      "--since <ref>",
      "git ref/commit to compare against; report memories added/modified/removed since",
    )
    .option("--no-verify", "skip the anchor verification step")
    .option("--no-promote", "skip the auto-promotion step")
    .option(
      "--inject-bridge",
      "refresh CLAUDE.md + AGENTS.md Hivelore managed blocks (or --bridge-file legacy custom injection)",
    )
    .option("--bridge-file <path>", "bridge file to inject into (default: CLAUDE.md)")
    .option("--bridge-max-memories <n>", "max memories to inject into bridge file", "5")
    .option("--embed", "rebuild embeddings index after sync (requires @haive/embeddings)")
    .option("--no-cross-repo", "skip cross-repo memory pull even if crossRepoSources is configured")
    .option("--no-deps", "skip dependency version tracking")
    .option("--no-contracts", "skip contract file diff checking")
    .option("--no-bridges", "skip auto-refresh of existing native agent bridge files (.cursor/rules, .clinerules, …)")
    .option("--dry-run", "report what would change without writing any files")
    .action(async (opts: SyncOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.memoriesDir)) {
        if (!opts.quiet) ui.warn(`No .ai/memories at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }

      const log = (msg: string): void => {
        if (!opts.quiet) console.log(msg);
      };

      const config = await loadConfig(paths);
      const autoApproveDelayHours = config.autoApproveDelayHours ?? null;
      const autoPromoteMinReads = config.autoPromoteMinReads ?? DEFAULT_AUTO_PROMOTE_RULE.minReads;
      const autoRepair = config.autoRepair ?? {};

      const dryRun = opts.dryRun === true;
      if (dryRun) log(ui.yellow("(dry run — no files will be written)"));

      let staleMarked = 0;
      let revalidated = 0;
      let promoted = 0;
      let autoApproved = 0;
      let quarantined = 0;

      // Corpus-touching quarantine pass. The gate only downgrades flaky command sensors in memory;
      // sync persists the conclusion so every machine sees the same warn severity.
      const quarantineCandidates = await loadMemoriesFromDir(paths.memoriesDir);
      const sensorHealth = new Map(
        assessSensorHealth(await loadSensorLedger(paths), new Date(), {
          promotedAt: sensorPromotedAtMap(quarantineCandidates.map((m) => m.memory.frontmatter)),
        }).map((health) => [health.memory_id, health]),
      );
      for (const { memory, filePath } of quarantineCandidates) {
        const sensor = memory.frontmatter.sensor;
        const health = sensorHealth.get(memory.frontmatter.id);
        if (!sensor || (sensor.kind !== "shell" && sensor.kind !== "test") ||
            sensor.severity !== "block" || !health?.quarantine_pending) continue;
        if (!dryRun) {
          const at = new Date().toISOString();
          await writeFile(filePath, serializeMemory({
            frontmatter: { ...memory.frontmatter, sensor: { ...sensor, severity: "warn" } },
            body: withQuarantineNote(memory.body, at, health.flap_count),
          }), "utf8");
        }
        quarantined++;
      }

      if (opts.verify !== false) {
        const memories = await loadMemoriesFromDir(paths.memoriesDir);
        for (const { memory, filePath } of memories) {
          // session_recap records historical context — staleness doesn't apply.
          // If one was incorrectly stale-marked by a prior sync, auto-revalidate it now.
          if (memory.frontmatter.type === "session_recap") {
            if (memory.frontmatter.status === "stale") {
              if (!dryRun) {
                await writeFile(
                  filePath,
                  serializeMemory({
                    frontmatter: {
                      ...memory.frontmatter,
                      status: "validated",
                      stale_reason: null,
                      verified_at: new Date().toISOString(),
                    },
                    body: memory.body,
                  }),
                  "utf8",
                );
              }
              revalidated++;
            }
            continue;
          }
          const isAnchored =
            memory.frontmatter.anchor.paths.length > 0 ||
            memory.frontmatter.anchor.symbols.length > 0;
          if (!isAnchored) continue;

          const result = await verifyAnchor(memory, { projectRoot: root });
          const verifiedAt = new Date().toISOString();

          if (result.stale) {
            if (memory.frontmatter.status !== "stale") {
              if (!dryRun) {
                await writeFile(
                  filePath,
                  serializeMemory({
                    frontmatter: {
                      ...memory.frontmatter,
                      status: "stale",
                      verified_at: verifiedAt,
                      stale_reason: result.reason,
                    },
                    body: memory.body,
                  }),
                  "utf8",
                );
              }
              staleMarked++;
            }
          } else if (memory.frontmatter.status === "stale") {
            if (!dryRun) {
              await writeFile(
                filePath,
                serializeMemory({
                  frontmatter: {
                    ...memory.frontmatter,
                    status: "validated",
                    verified_at: verifiedAt,
                    stale_reason: null,
                  },
                  body: memory.body,
                }),
                "utf8",
              );
            }
            revalidated++;
          }
        }
      }

      if (opts.promote !== false) {
        const memories = await loadMemoriesFromDir(paths.memoriesDir);
        const usage = await loadUsageIndex(paths);
        const nowMs = Date.now();
        for (const { memory, filePath } of memories) {
          const fm = memory.frontmatter;
          if (fm.type === "session_recap") continue;

          // Usage-based auto-promotion (existing logic, threshold from config)
          if (
            isAutoPromoteEligible(fm, getUsage(usage, fm.id), {
              minReads: autoPromoteMinReads,
              maxRejections: DEFAULT_AUTO_PROMOTE_RULE.maxRejections,
            })
          ) {
            if (!dryRun) {
              await writeFile(
                filePath,
                serializeMemory({ frontmatter: { ...fm, status: "validated" }, body: memory.body }),
                "utf8",
              );
            }
            promoted++;
            continue;
          }

          // Time-based auto-approve: proposed memories older than N hours → validated.
          // EXCEPTION: `auto-captured` drafts (passive-capture distillation) never age into
          // validated — a machine-observed lesson needs an explicit human/agent approve.
          if (
            autoApproveDelayHours !== null &&
            fm.status === "proposed" &&
            fm.scope === "team" &&
            !fm.tags.includes("auto-captured")
          ) {
            const ageHours =
              (nowMs - new Date(fm.created_at).getTime()) / (1000 * 60 * 60);
            if (ageHours >= autoApproveDelayHours) {
              if (!dryRun) {
                await writeFile(
                  filePath,
                  serializeMemory({
                    frontmatter: {
                      ...fm,
                      status: "validated",
                      verified_at: new Date().toISOString(),
                    },
                    body: memory.body,
                  }),
                  "utf8",
                );
              }
              autoApproved++;
            }
          }
        }
      }

      if (!dryRun && (config.autopilot || autoRepair.context || autoRepair.corpus)) {
        const repairs = await applyAutopilotRepairs(root, paths, {
          applyContext: autoRepair.context ?? config.autopilot,
          applyCorpus: autoRepair.corpus ?? config.autopilot,
          applyCodeMap: false,
          applyCodeSearch: false,
        });
        for (const repair of repairs) log(ui.dim(`autopilot: ${repair.message}`));
      }

      const sinceReport = opts.since ? collectSinceChanges(root, opts.since) : null;

      // Run after verify/auto-promotion so a brand-new gate-miss always remains proposed on the sync
      // that creates it. The next normal sync may verify its candidate anchors like any other lesson.
      const gateMissIds = await processGateMissWatch(root, paths, dryRun);
      if (gateMissIds.length > 0) {
        log(ui.yellow(`gate-miss: proposed ${gateMissIds.length} lesson(s): ${gateMissIds.join(", ")}`));
        // Golden-set plumbing (excellence plan, Phase 5): every gate miss is exactly the labeled
        // retrieval case the self-synthesized eval can't produce — "given the reverted commit's
        // subject as the task, the new lesson must surface". Proposed only; a human approves it
        // into the scored set with `hivelore eval --approve-cases`.
        if (!dryRun) {
          try {
            const freshlyLoaded = await loadMemoriesFromDir(paths.memoriesDir);
            const cases = gateMissIds.flatMap((id) => {
              const loaded = freshlyLoaded.find((m) => m.memory.frontmatter.id === id);
              const heading = loaded?.memory.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
              if (!heading) return [];
              return [{ name: `gate-miss:${id}`, task: heading, expect_ids: [id] }];
            });
            if (cases.length > 0) {
              const specFile = path.join(root, ".ai", "eval", "spec.json");
              const raw = existsSync(specFile) ? await readFile(specFile, "utf8") : null;
              await mkdir(path.dirname(specFile), { recursive: true });
              await writeFile(specFile, appendProposedRetrievalCases(raw, cases), "utf8");
              log(ui.dim(`gate-miss: ${cases.length} proposed golden eval case(s) → .ai/eval/spec.json (approve with \`hivelore eval --approve-cases\`)`));
            }
          } catch { /* best-effort — golden-set plumbing must never break sync */ }
        }
      }

      const draftMemories = (await loadMemoriesFromDir(paths.memoriesDir)).filter(
        (m) => m.memory.frontmatter.status === "draft",
      );
      const draftCount = draftMemories.length;

      const autoApprovedNote = autoApproved > 0 ? ` · ${autoApproved} auto-approved` : "";
      log(
        `${ui.dim("sync:")} ${staleMarked} stale · ${revalidated} revalidated · ${promoted} promoted · ${quarantined} quarantined${autoApprovedNote}${sinceReport ? ` · ${sinceReport.added.length}+/${sinceReport.modified.length}~/${sinceReport.removed.length}- since ${opts.since}` : ""}`,
      );
      if (!opts.quiet && draftCount > 0) {
        log(
          ui.dim(
            `ℹ ${draftCount} memor${draftCount === 1 ? "y" : "ies"} in draft — run \`hivelore memory approve <id>\` to activate or \`hivelore memory list --status draft\` to review`,
          ),
        );
      }

      if (opts.injectBridge) {
        const maxInject = Math.max(1, Number(opts.bridgeMaxMemories ?? 5));
        if (opts.bridgeFile) {
          await injectBridge(path.resolve(opts.bridgeFile), paths.memoriesDir, maxInject, root, opts.quiet);
        } else if (!dryRun) {
          const res = await writeBridgeFiles(root, paths, {
            targets: ["claude", "agents"],
            maxMemories: maxInject,
            onlyExisting: true,
          });
          for (const warning of res.warnings) ui.warn(`bridge refresh failed: ${warning}`);
          const touched = res.created.length + res.updated.length;
          if (touched > 0) {
            log(ui.dim(`bridges: refreshed ${touched} instruction bridge file(s)`));
          }
        } else {
          const res = await writeBridgeFiles(root, paths, {
            targets: ["claude", "agents"],
            maxMemories: maxInject,
            onlyExisting: true,
            dryRun,
          });
          for (const warning of res.warnings) ui.warn(`bridge refresh failed: ${warning}`);
          const touched = res.created.length + res.updated.length;
          if (touched > 0) {
            log(ui.dim(`bridges: would refresh ${touched} instruction bridge file(s)`));
          }
        }
      }

      // ── Auto-refresh existing native bridges (keep reach configs fresh) ─────
      // Refresh only files that already exist on disk, so a pull/merge never leaves
      // stale native bridge configs behind and never creates surprise files.
      if (opts.noBridges !== true) {
        try {
          const res = await writeBridgeFiles(root, paths, {
            targets: BRIDGE_TARGETS,
            onlyExisting: true,
            dryRun,
          });
          const touched = res.created.length + res.updated.length;
          for (const warning of res.warnings) ui.warn(`bridge refresh failed: ${warning}`);
          if (touched > 0) {
            log(
              ui.dim(
                `bridges: ${dryRun ? "would refresh" : "refreshed"} ${touched} native bridge file(s)` +
                (res.unchanged.length > 0 ? ` · ${res.unchanged.length} unchanged` : "") +
                (res.skipped.length > 0 ? ` · ${res.skipped.length} skipped` : ""),
              ),
            );
          }
        } catch (err) {
          if (!opts.quiet) ui.warn(`bridge refresh failed: ${String(err)}`);
        }
      }

      if (sinceReport && !opts.quiet) {
        if (sinceReport.added.length > 0) {
          log(ui.bold("\nNew memories:"));
          for (const f of sinceReport.added) log(`  + ${f}`);
        }
        if (sinceReport.modified.length > 0) {
          log(ui.bold("\nModified:"));
          for (const f of sinceReport.modified) log(`  ~ ${f}`);
        }
        if (sinceReport.removed.length > 0) {
          log(ui.bold("\nRemoved:"));
          for (const f of sinceReport.removed) log(`  - ${f}`);
        }
      }

      // Decay report: memories not read in >90 days
      if (!opts.quiet) {
        const allForDecay = await loadMemoriesFromDir(paths.memoriesDir);
        const usageForDecay = await loadUsageIndex(paths);
        const decaying = allForDecay.filter(({ memory }) => {
          const fm = memory.frontmatter;
          if (fm.status === "rejected" || fm.status === "deprecated" || fm.status === "stale") return false;
          const u = getUsage(usageForDecay, fm.id);
          return isDecaying(u, fm.created_at);
        });
        if (decaying.length > 0) {
          log(ui.yellow(`\n⚠  ${decaying.length} memor${decaying.length === 1 ? "y" : "ies"} not read in >90 days (consider reviewing or deprecating):`));
          for (const { memory } of decaying) {
            log(ui.dim(`   ${memory.frontmatter.id}`));
          }
        }
      }

      // ── Cross-repo pull ────────────────────────────────────────────────────────
      if (opts.noCrossRepo !== true && (config.crossRepoSources ?? []).length > 0) {
        try {
          const crossReports = await pullCrossRepoSources(paths, config, root);
          for (const r of crossReports) {
            const total = r.imported.length + r.updated.length;
            if (total > 0 || r.errors.length > 0) {
              log(
                ui.dim(
                  `cross-repo [${r.source}]: ${r.imported.length} imported · ${r.updated.length} updated · ${r.skipped.length} unchanged` +
                  (r.errors.length > 0 ? ` · ⚠ ${r.errors.length} error(s)` : ""),
                ),
              );
              for (const e of r.errors) ui.warn(`  cross-repo error: ${e}`);
            }
          }
        } catch (err) {
          ui.warn(`cross-repo pull failed: ${String(err)}`);
        }
      }

      // ── Dependency tracker ─────────────────────────────────────────────────────
      if (opts.noDeps !== true) {
        try {
          const manifestFiles = resolveManifestFiles(root, config.dependencyFiles);
          if (manifestFiles.length > 0) {
            const depResults = await trackDependencies(root, paths.haiveDir, manifestFiles);
            for (const result of depResults) {
              const majorBumps = result.changes.filter((c) => c.isMajorBump);
              const minorChanges = result.changes.filter((c) => !c.isMajorBump);
              if (result.changes.length > 0) {
                log(
                  ui.yellow(
                    `⚠  dependency changes in ${result.file}: ${majorBumps.length} major bump(s) · ${minorChanges.length} minor change(s)`,
                  ),
                );
                for (const c of majorBumps) {
                  log(ui.yellow(`   MAJOR: ${c.name} ${c.from} → ${c.to}`));
                }
                for (const c of minorChanges) {
                  log(ui.dim(`   minor: ${c.name} ${c.from} → ${c.to}`));
                }
                // Create a gotcha memory for major bumps
                if (majorBumps.length > 0) {
                  const slugParts = result.file.replace(/[^a-z0-9]/gi, "-").toLowerCase();
                  const slug = `dep-major-bump-${slugParts}-${Date.now().toString(36)}`;
                  const depList = majorBumps
                    .map((c) => `- 🔴 **${c.name}** : \`${c.from}\` → \`${c.to}\``)
                    .join("\n");
                  const body =
                    `## ⚠️ Action required — human confirmation required\n\n` +
                    `Dependencies in \`${result.file}\` changed major version.\n` +
                    `A major version can contain **breaking changes** that affect this project.\n\n` +
                    `${depList}\n\n` +
                    `---\n\n` +
                    `**🚫 Do not modify code autonomously.**\n\n` +
                    `Inform the developer with this message:\n\n` +
                    `> *"I detected that ${majorBumps.map((c) => `\`${c.name}\``).join(", ")} ` +
                    `changed major version (${majorBumps.map((c) => `${c.from} → ${c.to}`).join(", ")}). ` +
                    `This can introduce incompatibilities in this project. ` +
                    `Do you want me to analyze the impact and propose updates?"*\n\n` +
                    `Wait for **explicit confirmation** before acting.\n\n` +
                    `**Next steps (if confirmed):**\n` +
                    `- Check the CHANGELOG: \`hivelore memory import-changelog --from node_modules/<pkg>/CHANGELOG.md\`\n` +
                    `- Verify anchored memories: \`hivelore memory verify\``;
                  const fm = buildFrontmatter({
                    type: "gotcha",
                    slug,
                    scope: "team",
                    status: "validated",
                    tags: ["dependency", "breaking-change", "auto-generated", "requires-human-approval"],
                    paths: [result.file],
                    topic: `dep-bump-${slugParts}`,
                  });
                  if (!dryRun) {
                    const teamDir = path.join(paths.memoriesDir, "team");
                    await mkdir(teamDir, { recursive: true });
                    await writeFile(
                      path.join(teamDir, `${fm.id}.md`),
                      serializeMemory({ frontmatter: { ...fm, requires_human_approval: true }, body }),
                      "utf8",
                    );
                  }
                  log(ui.yellow(`   → memory${dryRun ? " would be" : ""} created: ${fm.id}`));
                }
              }
            }
          }
        } catch (err) {
          ui.warn(`dependency tracker failed: ${String(err)}`);
        }
      }

      // ── Contract watcher ───────────────────────────────────────────────────────
      if (opts.noContracts !== true && (config.contractFiles ?? []).length > 0) {
        try {
          const diffs = await watchContracts(root, paths.haiveDir, config.contractFiles!);
          for (const diff of diffs) {
            const breaking = diff.changes.filter((c) => c.severity === "breaking");
            const additive = diff.changes.filter((c) => c.severity === "additive");
            log(
              ui.yellow(
                `⚠  contract changed [${diff.contract}]: ${breaking.length} breaking · ${additive.length} additive`,
              ),
            );
            for (const c of diff.changes) {
              const icon = c.severity === "breaking" ? "🔴" : c.severity === "additive" ? "🟢" : "🟡";
              log(`   ${icon} ${c.description}`);
            }
            // Create a gotcha memory for breaking contract changes
            if (breaking.length > 0) {
              const slug = `contract-breaking-${diff.contract.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
              const breakingList = breaking.map((c) => `- 🔴 **${c.kind}** : ${c.description}`).join("\n");
              const addList = additive.length > 0
                ? `\n\n### Non-breaking changes (additive)\n` +
                  additive.map((c) => `- 🟢 ${c.description}`).join("\n")
                : "";
              const body =
                `## ⚠️ Action required — human confirmation required\n\n` +
                `Contract **\`${diff.contract}\`** (\`${diff.file}\`) was modified.\n` +
                `**Breaking changes** were detected — this project may consume that contract.\n\n` +
                `${breakingList}${addList}\n\n` +
                `---\n\n` +
                `**🚫 Do not modify code autonomously.**\n\n` +
                `Inform the developer with this message:\n\n` +
                `> *"I detected that contract \`${diff.contract}\` changed: ` +
                `${breaking.length} breaking change(s) detected. ` +
                `This project may depend on that contract. ` +
                `Do you want me to analyze the impact and propose updates?"*\n\n` +
                `Wait for **explicit confirmation** before acting.\n\n` +
                `**Next steps (if confirmed):**\n` +
                `- Search usages: \`hivelore memory for-files <affected files>\`\n` +
                `- Check related memories: \`hivelore memory search ${diff.contract}\``;
              const fm = buildFrontmatter({
                type: "gotcha",
                slug,
                scope: "team",
                status: "validated",
                tags: ["api-contract", "breaking-change", diff.contract, "auto-generated", "requires-human-approval"],
                paths: [diff.file],
                topic: `contract-breaking-${diff.contract}`,
              });
              if (!dryRun) {
                const teamDir = path.join(paths.memoriesDir, "team");
                await mkdir(teamDir, { recursive: true });
                await writeFile(
                  path.join(teamDir, `${fm.id}.md`),
                  serializeMemory({ frontmatter: { ...fm, requires_human_approval: true }, body }),
                  "utf8",
                );
              }
              log(ui.yellow(`   → memory${dryRun ? " would be" : ""} created: ${fm.id}`));
            }
          }
        } catch (err) {
          ui.warn(`contract watcher failed: ${String(err)}`);
        }
      }

      // ── Auto-refresh code-map if source files changed since it was generated ──
      const existingMap = await loadCodeMap(paths);
      if (!dryRun && !existingMap && (config.autopilot || autoRepair.codeMap)) {
        try {
          const { buildCodeMap, saveCodeMap } = await import("@hivelore/core");
          log(ui.dim("code-map: missing — building index…"));
          const newMap = await buildCodeMap(root);
          await saveCodeMap(paths, newMap);
          log(ui.dim(`code-map: built (${Object.keys(newMap.files).length} files)`));
        } catch {
          // Non-fatal — code-map refresh is best-effort
        }
      } else if (existingMap) {
        const mapAge = new Date(existingMap.generated_at).getTime();
        // Check if any tracked source files are newer than the map
        const gitResult = spawnSync(
          "git",
          [
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            `@{${new Date(mapAge).toISOString()}}..HEAD`,
            "--",
            "*.ts", "*.tsx", "*.js", "*.jsx",
            "*.java", "*.kt",
            "*.py",
            "*.go",
            "*.rs",
            "*.cs",
            "*.php",
          ],
          { cwd: root, encoding: "utf8" },
        );
        const changedSourceFiles = (gitResult.stdout ?? "").trim();
        if (changedSourceFiles.length > 0) {
          if (!dryRun) {
            try {
              const { buildCodeMap, saveCodeMap } = await import("@hivelore/core");
              log(ui.dim("code-map: source files changed — refreshing index…"));
              const newMap = await buildCodeMap(root);
              await saveCodeMap(paths, newMap);
              log(ui.dim(`code-map: refreshed (${Object.keys(newMap.files).length} files)`));
            } catch {
              // Non-fatal — code-map refresh is best-effort
            }
          } else {
            log(ui.dim("code-map: source files changed — would refresh index (skipped in dry-run)"));
          }
        }
      }

      // --embed or autopilot autoRepair.codeSearch: rebuild embeddings index after sync
      if (!dryRun && (opts.embed || autoRepair.codeSearch)) {
        try {
          const { Embedder, rebuildCodeIndex, rebuildIndex } = await import("@hivelore/embeddings");
          log(ui.dim("embed: rebuilding index…"));
          const embedder = await Embedder.create();
          const { report } = await rebuildIndex(paths, embedder);
          const { report: codeReport } = await rebuildCodeIndex(paths, embedder);
          log(
            ui.dim(
              `embed: memory index rebuilt (${report.added} added, ${report.updated} updated, ${report.removed} removed)`,
            ),
          );
          log(
            ui.dim(
              `embed: code index rebuilt (${codeReport.total} symbols, ${codeReport.added} added, ${codeReport.updated} updated, ${codeReport.removed} removed)`,
            ),
          );
        } catch (error) {
          // "not available or index build failed" told a user whose package WAS installed to install
          // it — the real cause was a native dep that could not load under their Node version, and
          // the message hid it. Say which of the two it is, and always print the underlying error.
          const rawDetail = error instanceof Error ? (error.stack ?? error.message) : String(error);
          // Never emit an empty detail after the colon (field report §4.2 saw exactly that): fall back
          // to the first non-empty line, then the error name, so the message always carries a cause.
          const detail =
            rawDetail.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ??
            (error instanceof Error ? error.name : "unknown error");
          const absent = detail.includes("@hivelore/embeddings") &&
            /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(detail);
          ui.warn(
            absent
              ? "--embed: @hivelore/embeddings is not installed. Install it (`npm install -g @hivelore/embeddings`), then run `hivelore index memories`."
              : `--embed: @hivelore/embeddings is installed but the index build failed: ${detail}\n` +
                "  Reinstall it for this Node version (`npm install -g @hivelore/embeddings`), then run `hivelore doctor`.",
          );
        }
      }
    });
}

async function processGateMissWatch(
  root: string,
  paths: ReturnType<typeof resolveHaivePaths>,
  dryRun: boolean,
): Promise<string[]> {
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (headResult.status !== 0) return [];
  const head = headResult.stdout.trim();
  if (!head) return [];
  const stateFile = path.join(paths.runtimeDir, "enforcement", "git-watch.json");
  let state: GitWatchState | null = null;
  try { state = JSON.parse(await readFile(stateFile, "utf8")) as GitWatchState; } catch { /* first sync */ }
  const plan = planGitWatch(state, head);
  if (plan.action === "initialize") {
    if (!dryRun) {
      await mkdir(path.dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify(plan.next, null, 2) + "\n", "utf8");
    }
    return [];
  }
  if (plan.action === "idle") return [];

  const proposals = proposeGateMissDrafts(
    readGitCommitsRange(root, plan.range),
    existingGateMissShas(await loadMemoriesFromDir(paths.memoriesDir)),
    gatePassedShas(await loadSensorLedger(paths)),
    { pathExists: (rel) => existsSync(path.join(root, rel)) },
  );
  const ids: string[] = [];
  for (const proposal of proposals) {
    const fm = {
      ...buildFrontmatter({
        type: "attempt",
        slug: proposal.slug,
        scope: "team",
        status: "proposed",
        tags: ["gate-miss", proposal.kind],
        paths: proposal.paths,
        topic: `gate-miss-${proposal.reverted_sha}`,
      }),
      status: "proposed" as const,
    };
    ids.push(fm.id);
    if (!dryRun) {
      await mkdir(paths.teamDir, { recursive: true });
      await writeFile(
        path.join(paths.teamDir, `${fm.id}.md`),
        serializeMemory({ frontmatter: fm, body: proposal.body }),
        "utf8",
      );
    }
  }
  if (!dryRun) {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(plan.next, null, 2) + "\n", "utf8");
  }
  return ids;
}

function readGitCommitsRange(root: string, range: string): GitCommit[] {
  const result = spawnSync(
    "git",
    ["log", "--reverse", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", range],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) return [];
  const commits: GitCommit[] = [];
  for (const block of result.stdout.split("\x1e").filter((part) => part.trim())) {
    const [shaRaw, subjectRaw, bodyRaw, filesRaw = ""] = block.split("\x1f");
    const sha = shaRaw?.trim();
    const subject = subjectRaw?.trim();
    if (!sha || !subject) continue;
    commits.push({
      sha,
      subject,
      body: bodyRaw?.trim() ?? "",
      files: filesRaw.split("\n").map((file) => file.trim()).filter(Boolean),
    });
  }
  return commits;
}

/** First meaningful line of a memory body, condensed to a single bridge-friendly summary. */
function bridgeSummaryLine(body: string): string {
  const firstLine = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())     // strip markdown heading markers
    .find((l) => l.length > 0) ?? "";
  const oneLine = firstLine.replace(/\s+/g, " ");
  return oneLine.length > 140 ? oneLine.slice(0, 137) + "…" : oneLine;
}

async function injectBridge(
  bridgeFile: string,
  memoriesDir: string,
  maxMemories: number,
  root: string,
  quiet?: boolean,
): Promise<void> {
  if (!existsSync(memoriesDir)) return;

  const all = await loadMemoriesFromDir(memoriesDir);
  const top = all
    .filter(({ memory }) => {
      const s = memory.frontmatter.status;
      if (memory.frontmatter.type === "session_recap") return false;
      // Generic stack-pack seeds are background context, not repo-specific
      // breadcrumbs — keep them out of the always-loaded bridge.
      if (isStackPackSeed(memory.frontmatter)) return false;
      return s === "validated" || s === "proposed";
    })
    .sort((a, b) => {
      const score = (m: typeof a) => {
        const s = m.memory.frontmatter.status;
        return (s === "validated" ? 2 : 1);
      };
      return score(b) - score(a);
    })
    .slice(0, maxMemories);

  // One line per memory: the bridge is a table of contents, not the full corpus.
  // Agents pull the full body on demand via get_briefing / mem_get.
  const block = top
    .map((m) => {
      const fm = m.memory.frontmatter;
      const unverified = fm.status === "proposed" ? " [UNVERIFIED]" : "";
      return `- \`${fm.id}\` (${fm.scope}/${fm.type})${unverified} — ${bridgeSummaryLine(m.memory.body)}`;
    })
    .join("\n");

  const injected =
    `${BRIDGE_START}\n` +
    `<!-- AUTO-GENERATED by hivelore sync --inject-bridge — do not edit between these markers -->\n` +
    `<!-- Top memories — call get_briefing / mem_get for the full body. -->\n\n` +
    block +
    `\n\n${BRIDGE_END}`;

  const fileExists = existsSync(bridgeFile);
  let existing = fileExists ? await readFile(bridgeFile, "utf8") : "";
  // Normalize line endings to avoid \r\n accumulation
  existing = existing.replace(/\r\n/g, "\n");

  const startIdx = existing.indexOf(BRIDGE_START);
  const endIdx = existing.indexOf(BRIDGE_END);

  // Detect partial markers — safer to abort than silently corrupt the file
  if (startIdx !== -1 && endIdx === -1) {
    ui.warn(`${path.relative(root, bridgeFile)}: found ${BRIDGE_START} without ${BRIDGE_END}. Fix the file manually before running --inject-bridge.`);
    return;
  }
  if (startIdx === -1 && endIdx !== -1) {
    ui.warn(`${path.relative(root, bridgeFile)}: found ${BRIDGE_END} without ${BRIDGE_START}. Fix the file manually before running --inject-bridge.`);
    return;
  }

  let updated: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    updated = existing.slice(0, startIdx) + injected + existing.slice(endIdx + BRIDGE_END.length);
  } else {
    if (!fileExists && !quiet) {
      ui.info(`Creating ${path.relative(root, bridgeFile)} with hivelore memory block.`);
    }
    updated = existing + (existing.endsWith("\n") ? "" : "\n") + "\n" + injected + "\n";
  }

  await writeFile(bridgeFile, updated, "utf8");
  if (!quiet) {
    console.log(
      ui.dim(`bridge: injected ${top.length} memor${top.length === 1 ? "y" : "ies"} into ${path.relative(root, bridgeFile)}`),
    );
  }
}

interface SinceReport {
  added: string[];
  modified: string[];
  removed: string[];
}

function collectSinceChanges(root: string, ref: string): SinceReport | null {
  const result = spawnSync(
    "git",
    ["-C", root, "diff", "--name-status", "--diff-filter=AMD", `${ref}...HEAD`, "--", ".ai/memories"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;

  const report: SinceReport = { added: [], modified: [], removed: [] };
  for (const line of result.stdout.split("\n")) {
    const [status, ...rest] = line.split("\t");
    const file = rest.join("\t").trim();
    if (!file) continue;
    if (status === "A") report.added.push(file);
    else if (status === "M") report.modified.push(file);
    else if (status === "D") report.removed.push(file);
  }
  return report;
}
