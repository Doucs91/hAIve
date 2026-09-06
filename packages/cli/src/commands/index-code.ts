import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  buildCodeMap,
  CODE_MAP_DEFAULT_EXCLUDE,
  codeMapPath,
  resolveCodeMapFile,
  findProjectRoot,
  loadCodeMap,
  resolveHaivePaths,
  saveCodeMap,
} from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface IndexCodeOptions {
  dir?: string;
  exclude?: string;
  status?: boolean;
  json?: boolean;
}

export function registerIndexCode(program: Command): Command {
  const idx = program
    .command("index")
    .description(
      "Build local indexes that let AIs look up symbols instead of grepping.\n\n" +
      "  Run once after init, then hivelore sync refreshes it automatically when source changes.",
    );
  idx.action(() => idx.help());
  idx
    .command("code")
    .description(
      "Scan source files and write .ai/code-map.json (file → exports + 1-line description).\n\n" +
      "  Supported languages: TypeScript, JavaScript, Java, Python, Go, Rust, C#, PHP.\n" +
      "  The map is used by:\n" +
      "    • get_briefing (symbol_locations) — look up where a class/function lives\n" +
      "    • code_map MCP tool — browse exports without grepping\n" +
      "    • hivelore briefing --symbols — look up symbols from the CLI\n\n" +
      "  Run automatically by hivelore init (autopilot mode) and hivelore sync (if source changed).\n\n" +
      "  Example:\n" +
      "    hivelore index code\n" +
      "    hivelore index code --status        # report freshness without rebuilding\n" +
      "    hivelore index code --exclude generated,proto\n",
    )
    .option("-d, --dir <dir>", "project root")
    .option(
      "--exclude <csv>",
      "extra directory names to skip (comma-separated)",
      "",
    )
    .option("--status", "report code-map / code-search index freshness without rebuilding")
    .option("--json", "with --status, emit machine-readable JSON (for CI / agents)")
    .action(async (opts: IndexCodeOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);

      if (opts.status) {
        await reportIndexStatus(root, paths, opts.json === true);
        return;
      }

      const extraExcludes = (opts.exclude ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      ui.info(`Indexing source files in ${root}…`);
      const map = await buildCodeMap(root, {
        includeUntracked: true,
        excludeDirs: [...CODE_MAP_DEFAULT_EXCLUDE, ...extraExcludes],
      });

      await saveCodeMap(paths, map);
      const fileCount = Object.keys(map.files).length;
      const exportCount = Object.values(map.files).reduce((s, f) => s + f.exports.length, 0);
      ui.success(
        `Indexed ${fileCount} file(s) with ${exportCount} export(s) → ${path.relative(root, codeMapPath(paths))}`,
      );
    });

  idx
    .command("code-search")
    .description(
      "Build the semantic-search embeddings index for code (powers the code_search MCP tool).\n\n" +
      "  Reads .ai/code-map.json (run `hivelore index code` first) and embeds each exported\n" +
      "  symbol's metadata (filename + name + kind + description).\n\n" +
      "  Re-runs are incremental: unchanged entries keep their cached vectors, only the\n" +
      "  diff is re-embedded. First run downloads the bge-small-en-v1.5 model (~110MB).\n",
    )
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: IndexCodeOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);

      let mod: typeof import("@hivelore/embeddings");
      try {
        mod = await import("@hivelore/embeddings");
      } catch {
        ui.error(
          "@hivelore/embeddings is not installed. Install it (`pnpm add @hivelore/embeddings`) " +
          "then run `hivelore index code-search`.",
        );
        process.exit(1);
      }

      ui.info("Loading embedder (first run downloads ~110MB)…");
      const embedder = await mod.Embedder.create();
      ui.info(`Embedding code-map symbols…`);
      try {
        const { report } = await mod.rebuildCodeIndex(paths, embedder);
        ui.success(
          `Code-search index ready: ${report.total} symbols ` +
          `(+${report.added} new, ~${report.updated} updated, =${report.unchanged} cached, -${report.removed} removed)`,
        );
      } catch (err) {
        ui.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
  return idx;
}

async function reportIndexStatus(
  root: string,
  paths: ReturnType<typeof resolveHaivePaths>,
  asJson: boolean,
): Promise<void> {
  const mapFile = resolveCodeMapFile(paths);
  const map = mapFile ? await loadCodeMap(paths) : null;
  const fileCount = map ? Object.keys(map.files).length : 0;
  const exportCount = map
    ? Object.values(map.files).reduce((s, f) => s + f.exports.length, 0)
    : 0;
  const mapMtime = mapFile ? statSync(mapFile).mtime.toISOString() : null;

  // Code-search embeddings index lives under .ai/.cache/embeddings/ (built by `index code-search`).
  const searchIndexFile = path.join(paths.haiveDir, ".cache", "embeddings", "code-embeddings-index.json");
  const searchIndexPresent = existsSync(searchIndexFile);

  // Freshness verdicts (cheap — no re-walk, no embedding):
  //  • code-map is stale if any file it lists was modified after the map was generated.
  //  • the search index is stale if it was built from a different (older) code-map generation.
  const codeMapStale = map ? isCodeMapStale(root, map.generated_at, Object.keys(map.files)) : false;
  let searchIndexStale: boolean | null = null;
  if (searchIndexPresent && map) {
    try {
      const mod = await import("@hivelore/embeddings");
      const idx = await mod.loadCodeIndex(paths);
      if (idx) searchIndexStale = mod.isCodeIndexStale(idx.source_generated_at, map.generated_at);
    } catch {
      // embeddings not installed — report presence without a freshness verdict
    }
  }

  const status = {
    code_map: {
      present: map !== null,
      path: mapFile ? path.relative(root, mapFile) : path.relative(root, codeMapPath(paths)),
      files: fileCount,
      exports: exportCount,
      generated_at: map?.generated_at ?? null,
      file_mtime: mapMtime,
      stale: codeMapStale,
    },
    code_search_index: {
      present: searchIndexPresent,
      path: path.relative(root, searchIndexFile),
      stale: searchIndexStale,
    },
  };

  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    if (!status.code_map.present) process.exitCode = 1;
    return;
  }

  if (!status.code_map.present) {
    ui.warn(`No code-map at ${status.code_map.path}. Run \`hivelore index code\`.`);
    process.exitCode = 1;
    return;
  }
  ui.info(
    `code-map: ${fileCount} file(s), ${exportCount} export(s) · generated ${status.code_map.generated_at ?? "?"}` +
      (codeMapStale ? " · ⚠ STALE — source changed since generation; run `hivelore index code`" : " · fresh"),
  );
  if (!searchIndexPresent) {
    ui.info("code-search index: missing — run `hivelore index code-search` for semantic code lookup.");
  } else if (searchIndexStale) {
    ui.info(
      `code-search index: present (${status.code_search_index.path}) · ⚠ STALE — built from an older ` +
        "code-map; run `hivelore index code-search`",
    );
  } else {
    ui.info(`code-search index: present (${status.code_search_index.path})` + (searchIndexStale === false ? " · fresh" : ""));
  }
}

/** True if any file the code-map lists has an mtime newer than the map's generation time. Cheap (stat only). */
function isCodeMapStale(root: string, generatedAt: string, files: string[]): boolean {
  const gen = Date.parse(generatedAt);
  if (Number.isNaN(gen)) return false;
  for (const file of files) {
    try {
      if (statSync(path.join(root, file)).mtimeMs > gen) return true;
    } catch {
      // file moved/deleted since generation — also a form of drift, but stat errors are ignored here
    }
  }
  return false;
}
