import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import {
  buildFrontmatter,
  suggestSensorSeed,
  findProjectRoot,
  inferModulesFromPaths,
  loadConfig,
  loadMemoriesFromDir,
  memoryFilePath,
  resolveHaivePaths,
  serializeMemory,
  type MemoryFrontmatter,
  type MemoryScope,
  type MemoryType,
} from "@hivelore/core";
import { applyAutopilotRepairs } from "../utils/autopilot.js";
import { ui } from "../utils/ui.js";

interface AddOptions {
  type: MemoryType;
  slug?: string;
  title?: string;
  scope?: MemoryScope;
  module?: string;
  tags?: string;
  domain?: string;
  author?: string;
  paths?: string;
  files?: string;
  symbols?: string;
  commit?: string;
  body?: string;
  bodyFile?: string;
  topic?: string;
  activationKeyword?: string;
  activationGlob?: string;
  activationAlways?: boolean;
  dir?: string;
}

export function registerMemoryAdd(memory: Command): void {
  memory
    .command("save")
    .alias("add")
    .description(
      "Save a piece of knowledge as a persistent memory. Mirrors MCP mem_save. Alias: add.\n\n" +
      "  Memory types:\n" +
      "    skill       — reusable procedure/playbook agents follow for a recurring task (e.g. deploy, review)\n" +
      "    convention  — how things are done here (naming, patterns, tooling)\n" +
      "    decision    — a choice made and WHY (tradeoffs, constraints)\n" +
      "    gotcha      — non-obvious behavior that surprises newcomers\n" +
      "    architecture — structural overview of a system or module\n" +
      "    glossary    — domain terms and their meaning in this codebase\n" +
      "    attempt     — failed approach (prefer 'hivelore memory tried' for better structure)\n\n" +
      "  Tips:\n" +
      "    • --paths anchors the memory to source files for staleness detection\n" +
      "    • --topic enables upsert: future adds with the same topic update the existing memory\n" +
      "    • In autopilot mode, memories go directly to validated with team scope by default\n\n" +
      "  Examples:\n" +
      "    hivelore memory add --type gotcha --slug jpa-open-in-view --scope team \\\\\n" +
      "      --paths src/main/resources/application.properties \\\\\n" +
      "      --body \"spring.jpa.open-in-view=false is intentional — do not re-enable.\"\n" +
      "    hivelore memory add --type convention --slug flyway-no-modify --topic flyway \\\\\n" +
      "      --scope team --body \"Never modify existing migrations. Create V{n+1}__desc.sql.\"\n",
    )
    .requiredOption("--type <type>", "skill | convention | decision | gotcha | architecture | glossary | attempt")
    .option("--slug <slug>", "short kebab-case identifier used in the file name (auto-derived from --title/--body when omitted)")
    .option("--title <text>", "memory title — becomes the first heading of the body")
    .option("--scope <scope>", "personal | team | module (default: config default; team in autopilot)")
    .option("--module <name>", "module name (required when scope=module)")
    .option("--tags <csv>", "comma-separated tags for easier retrieval")
    .option("--domain <domain>", "domain (e.g. transactions)")
    .option("--author <author>", "author email or handle")
    .option("--paths <csv>", "anchor to source files — used for staleness detection by hivelore sync")
    .option("--files <csv>", "alias for --paths (matches the MCP `files` parameter)")
    .option("--symbols <csv>", "anchor to specific symbols (class/function names)")
    .option("--commit <sha>", "anchor to a specific commit SHA")
    .option("--body <text>", "memory body content (Markdown) — overrides --title default body")
    // Hidden synonym: agents reliably guess `--content` and a bare "unknown option" dead-ends
    // them. Kept out of help so `--body` stays the one documented flag.
    .addOption(new Option("--content <text>", "alias for --body").hideHelp())
    .option("--body-file <path>", "read memory body from a Markdown file — for long content")
    .option("--no-auto-tag", "disable automatic tag suggestions inferred from anchor paths")
    .option("--topic <key>", "stable key for upsert: if a memory with this topic+scope already exists, update it in-place (revision_count++)")
    .option("--activation-keyword <csv>", "skill only: comma-separated keywords that trigger progressive disclosure of this skill")
    .option("--activation-glob <csv>", "skill only: comma-separated path globs that trigger this skill")
    .option("--activation-always", "skill only: always surface this skill (no triggers needed)")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: AddOptions & { autoTag?: boolean; content?: string }) => {
      if (opts.body === undefined && opts.content !== undefined) opts.body = opts.content;
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.haiveDir)) {
        ui.error(`No .ai/ found at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig(paths);

      const userTags = parseCsv(opts.tags);
      const anchorPaths = parseCsv(opts.paths ?? opts.files);
      // Skill progressive-disclosure triggers (ignored for non-skill types).
      const activation =
        opts.type === "skill" &&
        (opts.activationKeyword || opts.activationGlob || opts.activationAlways)
          ? {
              keywords: parseCsv(opts.activationKeyword),
              globs: parseCsv(opts.activationGlob),
              always: Boolean(opts.activationAlways),
            }
          : undefined;
      const autoTagsEnabled = opts.autoTag !== false;
      const inferredTags = autoTagsEnabled ? inferModulesFromPaths(anchorPaths) : [];
      const mergedTags = Array.from(new Set([...userTags, ...inferredTags]));

      // ── Anchor path validation ────────────────────────────────────────
      if (anchorPaths.length > 0) {
        const missing = anchorPaths.filter((p) => !existsSync(path.resolve(root, p)));
        if (missing.length > 0) {
          ui.warn(`Anchor path${missing.length > 1 ? "s" : ""} not found in project:`);
          for (const p of missing) ui.warn(`  ✗ ${p}`);
          ui.warn(
            "Memories anchored to non-existent paths will be immediately marked stale by \`hivelore sync\`.\n" +
            "  Verify the paths are relative to the project root and the files/directories exist.",
          );
        }
      }

      const title = opts.title ?? titleFromText(opts.slug ?? opts.body ?? opts.topic ?? opts.type);
      const slug = slugify(opts.slug ?? opts.title ?? opts.topic ?? opts.body ?? `${opts.type}-memory`);
      let body: string;
      if (opts.bodyFile !== undefined) {
        if (!existsSync(opts.bodyFile)) {
          ui.error(`--body-file not found: ${opts.bodyFile}`);
          process.exitCode = 1;
          return;
        }
        const fileContent = await readFile(opts.bodyFile, "utf8");
        body = normalizeBody(fileContent, title, Boolean(opts.title));
      } else if (opts.body !== undefined) {
        body = normalizeBody(opts.body, title, Boolean(opts.title));
      } else {
        body = `# ${title}\n\nTODO — write the memory body.\n`;
      }

      // ── Dedup by content hash ─────────────────────────────────────────
      const scope = opts.scope ?? config.defaultScope ?? "personal";
      if (existsSync(paths.memoriesDir)) {
        const incomingHash = createHash("sha256").update(body.trim()).digest("hex").slice(0, 12);
        const allForHash = await loadMemoriesFromDir(paths.memoriesDir);
        const hashDup = allForHash.find(({ memory }) =>
          createHash("sha256").update(memory.body.trim()).digest("hex").slice(0, 12) === incomingHash &&
          memory.frontmatter.scope === scope,
        );
        if (hashDup) {
          ui.error(`Duplicate content detected — identical body already saved as "${hashDup.memory.frontmatter.id}".`);
          ui.error("Use \`hivelore memory update\` to modify it, or change the body to add new information.");
          process.exitCode = 1;
          return;
        }
      }

      // ── Topic upsert ─────────────────────────────────────────────────
      if (opts.topic && existsSync(paths.memoriesDir)) {
        const existing = await loadMemoriesFromDir(paths.memoriesDir);
        const topicMatch = existing.find(({ memory }) =>
          memory.frontmatter.topic === opts.topic &&
          memory.frontmatter.scope === scope &&
          (!opts.module || memory.frontmatter.module === opts.module),
        );
        if (topicMatch) {
          const fm = topicMatch.memory.frontmatter;
          const revisionCount = (fm.revision_count ?? 0) + 1;
          const newFrontmatter: MemoryFrontmatter = {
            ...fm,
            revision_count: revisionCount,
            ...(activation ? { activation } : {}),
            tags: mergedTags.length ? mergedTags : fm.tags,
            anchor: {
              commit: opts.commit ?? fm.anchor.commit,
              paths: anchorPaths.length ? anchorPaths : fm.anchor.paths,
              symbols: parseCsv(opts.symbols).length ? parseCsv(opts.symbols) : fm.anchor.symbols,
            },
          };
          await writeFile(topicMatch.filePath, serializeMemory({ frontmatter: newFrontmatter, body }), "utf8");
          ui.success(`Updated (topic upsert) ${path.relative(root, topicMatch.filePath)}`);
          ui.info(`id=${fm.id}  revision=${revisionCount}`);
          printSensorLoopHint(opts.type, body, newFrontmatter.anchor.paths, Boolean(newFrontmatter.sensor));
          await runPostMemoryAutopilot(root, paths, config);
          return;
        }
      }

      const frontmatter = buildFrontmatter({
        type: opts.type,
        slug,
        scope,
        module: opts.module,
        tags: mergedTags,
        domain: opts.domain,
        author: opts.author,
        paths: anchorPaths,
        symbols: parseCsv(opts.symbols),
        commit: opts.commit,
        topic: opts.topic,
        status: config.defaultStatus === "validated" ? "validated" : undefined,
        activation,
      });
      // Created already-validated by config (defaultStatus), not by explicit review → mark "auto".
      if (frontmatter.status === "validated") frontmatter.validated_by = "auto";

      const file = memoryFilePath(paths, frontmatter.scope, frontmatter.id, frontmatter.module);
      await mkdir(path.dirname(file), { recursive: true });

      if (existsSync(file)) {
        ui.error(`Memory already exists at ${file}`);
        process.exitCode = 1;
        return;
      }

      // Dedup check: warn if a similar slug already exists
      if (existsSync(paths.memoriesDir)) {
        const existing = await loadMemoriesFromDir(paths.memoriesDir);
        const slugTokens = slug.toLowerCase().split(/[-_\s]+/).filter(Boolean);
        const similar = existing.filter(({ memory }) => {
          const id = memory.frontmatter.id.toLowerCase();
          return (
            slugTokens.length >= 2 &&
            slugTokens.filter((t) => id.includes(t)).length >= Math.ceil(slugTokens.length * 0.6)
          );
        });
        if (similar.length > 0) {
          ui.warn(`Possible duplicate — similar memories exist: ${similar.map((m) => m.memory.frontmatter.id).join(", ")}`);
          ui.warn("Consider updating one of these with \`hivelore memory update\` instead.");
        }
      }

      await writeFile(file, serializeMemory({ frontmatter, body }), "utf8");
      ui.success(`Created ${path.relative(root, file)}`);
      ui.info(`id=${frontmatter.id}  scope=${frontmatter.scope}  status=${frontmatter.status}`);
      printSensorLoopHint(opts.type, body, anchorPaths, Boolean(frontmatter.sensor));
      await runPostMemoryAutopilot(root, paths, config);
      if (inferredTags.length > 0) {
        ui.info(`auto-tagged: ${inferredTags.join(", ")}  (use --no-auto-tag to disable)`);
      }

      // Anchorless warning: without paths the memory cannot be verified for staleness
      // (skill, glossary, session_recap are procedure/reference types that don't need code anchors)
      const typeNeedsAnchor = !["skill", "glossary", "session_recap"].includes(opts.type as string);
      if (anchorPaths.length === 0 && typeNeedsAnchor) {
        // Don't just say "add anchors" and leave the author to go find them — the memory text
        // usually names the files it is about. Offer those, prefilled, so the fix is one paste
        // rather than a lookup.
        const suggested = suggestAnchorPathsFromBody(body, root);
        ui.warn(
          `This memory has no anchor paths — staleness cannot be detected automatically.` +
          (suggested.length > 0
            ? `\n  These files are named in the body and exist here:` +
              `\n    hivelore memory update ${frontmatter.id} --paths ${suggested.join(",")}`
            : `\n  Add file anchors: hivelore memory update ${frontmatter.id} --paths <file1,file2>`),
        );
      }

      // Workflow hint
      if (frontmatter.status === "validated") {
        console.log(ui.dim("→ autopilot: memory is already validated and active"));
      } else if (scope === "personal") {
        console.log(
          ui.dim(
            `→ next: hivelore memory approve ${frontmatter.id}  (activate)` +
            `  |  hivelore memory promote ${frontmatter.id}  (share with team)`,
          ),
        );
      } else {
        console.log(
          ui.dim(`→ next: hivelore memory approve ${frontmatter.id}  (mark as validated)`),
        );
      }
    });
}

async function runPostMemoryAutopilot(
  root: string,
  paths: ReturnType<typeof resolveHaivePaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.autopilot && config.autoRepair?.corpus !== true) return;
  const repairs = await applyAutopilotRepairs(root, paths, {
    applyConfig: false,
    applyContext: false,
    applyCorpus: true,
    applyCodeMap: false,
    applyCodeSearch: false,
  });
  for (const repair of repairs) {
    ui.info(repair.message);
  }
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A gotcha/attempt no longer auto-writes a heuristic warn sensor. It closes its prevention loop only
 * once a sensor is VALIDATED via propose_sensor. Print whether the loop is open and, when a candidate
 * can be derived, a SEED to pre-fill that proposal. (Skip when the memory already carries a sensor.)
 */
function printSensorLoopHint(
  type: MemoryType,
  body: string,
  anchorPaths: string[],
  hasSensor: boolean,
): void {
  if (hasSensor) return;
  if (type !== "gotcha" && type !== "attempt") return;
  if (anchorPaths.length === 0) {
    ui.warn(
      "No --paths given — lesson is briefed but NOT enforced. Add --paths to the file(s) where the " +
      "mistake lives, then call propose_sensor (MCP) to close the loop.",
    );
    return;
  }
  const seed = suggestSensorSeed(body, anchorPaths);
  if (seed) {
    ui.warn("Lesson NOT yet enforced — close the loop with a validated sensor via propose_sensor (MCP).");
    ui.info(
      `  candidate pattern=${JSON.stringify(seed.pattern)}` +
      (seed.absent ? `  absent=${JSON.stringify(seed.absent)}` : "") +
      "  — refine, then validate (silent on current code, fires on the bad example).",
    );
  } else {
    ui.warn(
      "Lesson NOT yet enforced and no candidate pattern could be derived from the wording. Author a " +
      "discriminating sensor (pattern = faulty usage, absent = correct-usage marker) via propose_sensor.",
    );
  }
}

function normalizeBody(rawBody: string, title: string, titleExplicit: boolean): string {
  const trimmed = rawBody.trim();
  if (/^#{1,3}\s+\S/m.test(trimmed)) return `${trimmed}\n`;
  const heading = titleExplicit ? title : titleFromText(title);
  return [
    `# ${heading}`,
    "",
    "## Guidance",
    trimmed,
    "",
    "## Why",
    "Recorded in Hivelore so future agents can apply this project rule consistently.",
    "",
  ].join("\n");
}

function titleFromText(value: string): string {
  const cleaned = value
    .replace(/[#*_`>()[\]{}]/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  const base = cleaned || "Memory";
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || "memory";
}

/**
 * Pull path-like tokens out of a memory body and keep the ones that really exist in the repo.
 *
 * Anchors are what make staleness detection possible, but the warning that they were missing used
 * to end at "add file anchors: … --paths <file1,file2>" — leaving the author to go and look up
 * paths they had, in most cases, just written into the body. Deliberately conservative: a token
 * only survives if it has a directory separator, an extension, and a matching file on disk. A wrong
 * anchor is worse than none (it goes stale immediately), so guessing is never worth it.
 */
export function suggestAnchorPathsFromBody(body: string, root: string, limit = 4): string[] {
  const candidates = body.match(/[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,6}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const rel = raw.replace(/^\.\//, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!existsSync(path.join(root, rel))) continue;
    out.push(rel);
    if (out.length >= limit) break;
  }
  return out;
}
