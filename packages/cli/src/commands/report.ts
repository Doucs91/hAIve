import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  findProjectRoot,
  formatFrictionIssue,
  groupFriction,
  loadFrictionState,
  readFrictionReports,
  resolveHaivePaths,
  setFrictionStatus,
  type FrictionGroup,
} from "@hivelore/core";

const run = promisify(execFile);

/** Where friction with Hivelore itself goes when a human decides to publish it. */
const DEFAULT_FEEDBACK_REPO = "Doucs91/hivelore";

const KIND_ICON: Record<string, string> = {
  bug: "✗",
  suggestion: "✦",
  docs: "📖",
  confusing: "?",
};

async function loadGroups(root: string): Promise<FrictionGroup[]> {
  const paths = resolveHaivePaths(root);
  const [reports, state] = await Promise.all([
    readFrictionReports(paths),
    loadFrictionState(paths),
  ]);
  return groupFriction(reports, state);
}

function renderGroup(group: FrictionGroup): string[] {
  const icon = KIND_ICON[group.kind] ?? "•";
  const times = group.count > 1 ? ` \x1b[33m(${group.count}×)\x1b[0m` : "";
  const status =
    group.status === "open" ? "" : ` \x1b[90m[${group.status}${group.url ? ` ${group.url}` : ""}]\x1b[0m`;
  const lines = [
    `  ${icon} \x1b[1m${group.fingerprint}\x1b[0m  ${group.kind} · ${group.surface}${times}${status}`,
    `      ${group.summary}`,
  ];
  if (group.latest.repro) lines.push(`      \x1b[90mrepro: ${group.latest.repro.split("\n")[0]}\x1b[0m`);
  return lines;
}

export function registerReport(program: Command): void {
  const report = program
    .command("report")
    .description(
      "Review friction that AI agents hit with Hivelore itself, then publish what is worth publishing.\n\n" +
        "  Agents record friction locally via the `report_friction` MCP tool — nothing is ever sent\n" +
        "  automatically. This command is the human gate: you read the journal, and you decide what\n" +
        "  becomes a GitHub issue. Reports are deduplicated, so the occurrence count is the ranking.",
    );

  report
    .command("list")
    .description("List recorded friction, most-reported first")
    .option("--all", "include entries already submitted or dismissed", false)
    .option("--json", "emit JSON", false)
    .option("-d, --dir <dir>", "project root")
    .action(async (opts: { all: boolean; json: boolean; dir?: string }) => {
      const root = opts.dir ?? findProjectRoot(process.cwd());
      const groups = (await loadGroups(root)).filter((g) => opts.all || g.status === "open");

      if (opts.json) {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }
      if (groups.length === 0) {
        console.log("No friction recorded. Agents report it with the `report_friction` MCP tool.");
        return;
      }

      const open = groups.filter((g) => g.status === "open").length;
      console.log(
        `\nHivelore friction journal — ${groups.length} entr${groups.length === 1 ? "y" : "ies"}` +
          `${opts.all ? "" : ` (${open} open)`}\n`,
      );
      for (const group of groups) console.log(renderGroup(group).join("\n"));
      console.log(
        `\n  Publish one:  hivelore report submit <id> --yes` +
          `\n  Drop one:     hivelore report dismiss <id>\n`,
      );
    });

  report
    .command("submit <fingerprint>")
    .description("Open a GitHub issue from a journal entry (prints a preview unless --yes)")
    .option("--repo <owner/name>", "target repository", DEFAULT_FEEDBACK_REPO)
    .option("-y, --yes", "actually create the issue", false)
    .option("-d, --dir <dir>", "project root")
    .action(
      async (fingerprint: string, opts: { repo: string; yes: boolean; dir?: string }) => {
        const root = opts.dir ?? findProjectRoot(process.cwd());
        const paths = resolveHaivePaths(root);
        const group = (await loadGroups(root)).find((g) => g.fingerprint === fingerprint);
        if (!group) {
          console.error(`✗ No friction entry with id "${fingerprint}". Run \`hivelore report list\`.`);
          process.exitCode = 1;
          return;
        }

        const { title, body } = formatFrictionIssue(group);

        // Preview by default. Creating a public issue is irreversible and outward-facing, so it
        // takes an explicit --yes — the same bar `sensors promote` uses.
        if (!opts.yes) {
          console.log(`\n\x1b[1mWould open on ${opts.repo}:\x1b[0m\n`);
          console.log(`\x1b[1m${title}\x1b[0m\n`);
          console.log(body);
          console.log(
            `\n\x1b[33mPreview only.\x1b[0m Re-run with --yes to create it.` +
              `\nRead it first: never publish secrets or customer code.\n`,
          );
          return;
        }

        try {
          const { stdout } = await run("gh", [
            "issue",
            "create",
            "--repo",
            opts.repo,
            "--title",
            title,
            "--body",
            body,
          ]);
          const url = stdout.trim().split("\n").pop() ?? "";
          await setFrictionStatus(paths, fingerprint, "submitted", url || undefined);
          console.log(`✓ Issue created: ${url}`);
        } catch (error) {
          // No `gh`, or not authenticated — fall back to a prefilled URL so the entry is still
          // actionable without adding a hard dependency on the GitHub CLI.
          const url =
            `https://github.com/${opts.repo}/issues/new` +
            `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
          console.error(
            `✗ Could not run \`gh issue create\` (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`,
          );
          console.log(`\nOpen this instead:\n${url}\n`);
          console.log(`Then record it:  hivelore report dismiss ${fingerprint}`);
        }
      },
    );

  report
    .command("dismiss <fingerprint>")
    .description("Mark a journal entry as handled so it stops showing in `list`")
    .option("--url <url>", "link to the issue/PR that handled it")
    .option("-d, --dir <dir>", "project root")
    .action(async (fingerprint: string, opts: { url?: string; dir?: string }) => {
      const root = opts.dir ?? findProjectRoot(process.cwd());
      const paths = resolveHaivePaths(root);
      const group = (await loadGroups(root)).find((g) => g.fingerprint === fingerprint);
      if (!group) {
        console.error(`✗ No friction entry with id "${fingerprint}".`);
        process.exitCode = 1;
        return;
      }
      await setFrictionStatus(paths, fingerprint, "dismissed", opts.url);
      console.log(`✓ Dismissed ${fingerprint} — ${group.summary}`);
    });
}
