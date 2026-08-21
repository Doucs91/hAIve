import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { findProjectRoot, resolveHaivePaths } from "@hivelore/core";
import { ui } from "../utils/ui.js";

interface EmbeddingsOptions {
  dir?: string;
}

interface EmbeddingsQueryOptions extends EmbeddingsOptions {
  limit?: string;
  minScore?: string;
}

/**
 * v0.32.0: the semantic index verbs live under `hivelore index` (memories | query | status),
 * next to `index code` — one indexing family. The old `embeddings` family stays as a hidden
 * back-compat alias registering the same actions.
 */
export function registerIndexSemantic(idx: Command): void {
  attachSemanticCommands(idx, { memoriesVerb: "memories" });
}

export function registerEmbeddings(program: Command): void {
  const embeddings = program
    .command("embeddings", { hidden: true })
    .description("(hidden alias — canonical: `hivelore index memories|query|status`)");
  attachSemanticCommands(embeddings, { memoriesVerb: "index" });
}

function attachSemanticCommands(embeddings: Command, naming: { memoriesVerb: string }): void {

  embeddings
    .command(naming.memoriesVerb)
    .description("Generate or refresh the semantic embeddings index for all memories")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: EmbeddingsOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      if (!existsSync(paths.memoriesDir)) {
        ui.error(`No .ai/memories at ${root}. Run \`hivelore init\` first.`);
        process.exitCode = 1;
        return;
      }
      const { Embedder, rebuildIndex } = await loadEmbeddings();
      ui.info("Loading embedding model (first run downloads ~110MB)…");
      const embedder = await Embedder.create();
      ui.info(`Model ready: ${embedder.model} (dim=${embedder.dimension}). Indexing memories…`);
      const { report } = await rebuildIndex(paths, embedder);
      ui.success(
        `Indexed ${report.total} memories — added=${report.added} updated=${report.updated} unchanged=${report.unchanged} removed=${report.removed}`,
      );
    });

  embeddings
    .command("query <text>")
    .description("Run a semantic search against the local embeddings index")
    .option("-d, --dir <dir>", "project root")
    .option("--limit <n>", "max results", "10")
    .option("--min-score <n>", "minimum cosine similarity (0-1)", "0")
    .action(async (text: string, opts: EmbeddingsQueryOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const { semanticSearch } = await loadEmbeddings();
      const result = await semanticSearch(paths, text, {
        limit: Number(opts.limit ?? 10),
        minScore: Number(opts.minScore ?? 0),
      });
      if (!result) {
        ui.error("No embeddings index found. Run `hivelore index memories` first.");
        process.exitCode = 1;
        return;
      }
      if (result.hits.length === 0) {
        ui.info("No semantic matches above the threshold.");
        return;
      }
      for (const hit of result.hits) {
        const score = hit.score.toFixed(3);
        console.log(`${ui.bold(score)}  ${hit.id}`);
        console.log(`       ${ui.dim(path.relative(root, hit.file_path))}`);
      }
    });

  embeddings
    .command("status")
    .description("Show the embeddings index status")
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: EmbeddingsOptions) => {
      const root = findProjectRoot(opts.dir);
      const paths = resolveHaivePaths(root);
      const { indexStat } = await loadEmbeddings();
      const stat = await indexStat(paths);
      if (!stat.exists) {
        ui.warn("No embeddings index. Run `hivelore index memories` to create one.");
        return;
      }
      console.log(`${ui.bold("entries:")}    ${stat.count}`);
      console.log(`${ui.bold("model:")}      ${stat.model}`);
      console.log(`${ui.bold("updated_at:")} ${stat.updatedAt}`);
      console.log(`${ui.bold("size:")}       ${(stat.sizeBytes / 1024).toFixed(1)} KB`);
    });
}

async function loadEmbeddings() {
  try {
    return await import("@hivelore/embeddings");
  } catch (error) {
    // Print the real cause. "Could not load" plus an install command is actively misleading when
    // the package IS installed and it is a native dependency that failed for this Node version.
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
    ui.error(`Could not load @hivelore/embeddings: ${detail}`);
    ui.info("Install or reinstall it for this Node version: npm install -g @hivelore/embeddings");
    ui.info("(in the monorepo: `pnpm build`)");
    process.exit(1);
  }
}
