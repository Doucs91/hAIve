import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const READMES = [
  ["README.md", path.join(ROOT, "README.md")],
  ["packages/cli/README.md", path.join(ROOT, "packages", "cli", "README.md")],
] as const;

/**
 * Documentation is a deliverable, so it gets checked like one.
 *
 * Both READMEs sat six weeks behind the code and named things that no longer existed:
 * `haive-enforcement.yml` and `haive.config.json` had been renamed in v0.51, four of the fifteen
 * default MCP tools were missing, and the gate section described process gates as blocking after
 * v0.55.0 made them advisory. None of it was catchable by review, because nothing compared the prose
 * to the source.
 *
 * These assertions cover the failure modes that actually occurred: a name that drifted, a command
 * that does not exist, a config key that was never real.
 */

const CLI = path.join(ROOT, "packages", "cli", "dist", "index.js");

/**
 * Does the CLI accept this command? Asked by INVOKING it, not by parsing `--help`: hidden
 * back-compat aliases (`install-hooks`) are real and absent from help, while a command that was
 * never registered (`hivelore tui` — documented here for months with its own section and keybinding
 * table) falls through to the root usage banner. Only invocation tells the two apart.
 */
function accepts(command: string): boolean {
  try {
    const out = execFileSync(process.execPath, [CLI, command, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.includes(`hivelore ${command}`);
  } catch {
    return false;
  }
}

describe("README accuracy", () => {
  const configSource = readFileSync(path.join(ROOT, "packages", "core", "src", "config.ts"), "utf8");

  for (const [label, file] of READMES) {
    describe(label, () => {
      const text = readFileSync(file, "utf8");

      it("cites only commands the CLI registers", () => {
        const cited = new Set(
          [...text.matchAll(/(?:^|[`\s])hivelore ([a-z][a-z-]+)/gm)].map((m) => m[1]!),
        );
        const phantom = [...cited].filter((c) => !accepts(c));
        expect(phantom, `documented but not registered: ${phantom.join(", ")}`).toEqual([]);
      });

      it("cites only enforcement config keys that exist", () => {
        const cited = new Set(
          // `(?<![-\w])` so `hivelore-enforcement.yml` is not read as a config key.
          [...text.matchAll(/(?<![-\w])enforcement\.([a-zA-Z]+)/g)].map((m) => m[1]!),
        );
        const missing = [...cited].filter((k) => !new RegExp(`\\b${k}\\?:`).test(configSource));
        expect(missing, `documented but absent from config.ts: ${missing.join(", ")}`).toEqual([]);
      });

      it("uses no pre-rename filenames", () => {
        // v0.51 renamed haive -> hivelore. These lived on in the npm README for six weeks.
        expect(text).not.toContain("haive.config.json");
        expect(text).not.toContain("haive-enforcement.yml");
        expect(text).not.toContain("haive-sync.yml");
      });
    });
  }

  it("documents every MCP tool the default profile exposes", () => {
    const server = readFileSync(path.join(ROOT, "packages", "mcp", "src", "server.ts"), "utf8");
    const lines = server.split("\n");
    const start = lines.findIndex((l) => l.includes("ENFORCEMENT_PROFILE_TOOLS = ["));
    const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("]"));
    const exposed = [...new Set([...lines.slice(start, end).join("\n").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!))];

    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const documented = new Set([...readme.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]!));
    const missing = exposed.filter((t) => !documented.has(t));
    expect(missing, `exposed by default but undocumented: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps each shared claim in exactly one README", () => {
    const npm = readFileSync(path.join(ROOT, "packages", "cli", "README.md"), "utf8");
    // The npm page is the command reference; the concepts live in the root README and are linked.
    // Restating them is how the two drifted into saying different, both-wrong things.
    for (const duplicated of ["## Memory lifecycle", "## Multi-component projects", "## Semantic search"]) {
      expect(npm, `${duplicated} belongs in the root README only`).not.toContain(duplicated);
    }
    expect(npm).toContain("github.com/Doucs91/hivelore#readme");
  });
});
