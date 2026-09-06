/**
 * Hivelore GitHub Action — PR memory enrichment script.
 *
 * Reads the .ai/memories/ directory, finds memories relevant to the PR's
 * changed files, and posts/updates a single comment on the PR.
 *
 * Runs entirely from the checked-out repo — no hivelore CLI needed at runtime.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getOctokit } from "@actions/github";

// ── Environment ───────────────────────────────────────────────────────────────

const CHANGED_FILES_RAW = process.env["CHANGED_FILES"] ?? "";
const COMMENT_HEADER = process.env["COMMENT_HEADER"] ?? "## 🧠 Hivelore — Team Memory Check";
const POST_IF_EMPTY = process.env["POST_IF_EMPTY"] === "true";
const MAX_MEMORIES = parseInt(process.env["MAX_MEMORIES"] ?? "10", 10);
const MEMORIES_DIR_REL = process.env["MEMORIES_DIR"] ?? ".ai/memories";
const GH_TOKEN = process.env["GH_TOKEN"] ?? "";
const GH_REPO = process.env["GH_REPO"] ?? "";
const PR_NUMBER = parseInt(process.env["PR_NUMBER"] ?? "0", 10);
const WORKSPACE = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
const PERSIST_REVIEW_LEARNINGS = process.env["PERSIST_REVIEW_LEARNINGS"] !== "false";

const COMMENT_MARKER = "<!-- haive-pr-memory-check -->";

// ── Memory parser (self-contained, no @hivelore/core dep) ──────────────────────

interface Memory {
  id: string;
  title: string;
  type: string;
  scope: string;
  status: string;
  tags: string[];
  anchorPaths: string[];
  requiresHumanApproval: boolean;
  body: string;
  filePath: string;
  /** Set when the memory carries an executable sensor — i.e. it can BLOCK, not merely advise. */
  sensor?: { severity: string; message: string };
}

/**
 * Pull the sensor's severity/message straight out of the frontmatter text.
 *
 * The action deliberately ships its own minimal parser (no workspace dependency), and its nested
 * handling flattens sub-keys, so the sensor block is read from the raw text instead. Only the two
 * fields the PR comment shows are extracted — deliberately not a second implementation of the
 * sensor schema.
 */
export function extractSensor(raw: string): { severity: string; message: string } | undefined {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const block = fm[1]!.match(/^sensor:\n((?:[ \t]+.*\n?)+)/m);
  if (!block) return undefined;
  const severity = block[1]!.match(/^\s+severity:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const message = block[1]!.match(/^\s+message:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!severity && !message) return undefined;
  return { severity: severity ?? "warn", message: message ?? "" };
}

function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw };

  const fmRaw = match[1]!;
  const body = (match[2] ?? "").trim();
  const fm: Record<string, unknown> = {};
  const lines = fmRaw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const kv = line.match(/^(\w[\w_]*):\s*(.*)/);
    if (!kv) { i++; continue; }

    const key = kv[1]!;
    const val = kv[2]!.trim();

    if (val === "") {
      i++;
      const nested: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("  ")) {
        const nl = lines[i]!.trimStart();
        if (nl.startsWith("- ")) {
          nested.push(nl.slice(2).trim().replace(/^['"]|['"]$/g, ""));
        } else {
          const nkv = nl.match(/^(\w[\w_]*):\s*(.*)/);
          if (nkv) {
            const subKey = nkv[1]!;
            i++;
            const subList: string[] = [];
            while (i < lines.length && lines[i]!.startsWith("    ")) {
              const sl = lines[i]!.trimStart();
              if (sl.startsWith("- ")) subList.push(sl.slice(2).trim().replace(/^['"]|['"]$/g, ""));
              i++;
            }
            if (subList.length) fm[subKey] = subList;
            continue;
          }
        }
        i++;
      }
      if (nested.length) fm[key] = nested;
      continue;
    }

    if (val === "true") fm[key] = true;
    else if (val === "false") fm[key] = false;
    else if (val === "null" || val === "~") fm[key] = null;
    else fm[key] = val.replace(/^['"]|['"]$/g, "");
    i++;
  }

  return { fm, body };
}

function extractAnchorPaths(fm: Record<string, unknown>): string[] {
  const top = fm["paths"];
  if (Array.isArray(top))
    return top.filter((x): x is string => typeof x === "string");

  const anchor = fm["anchor"];
  if (anchor !== null && typeof anchor === "object" && !Array.isArray(anchor)) {
    const paths = (anchor as Record<string, unknown>)["paths"];
    if (Array.isArray(paths)) return paths.filter((x): x is string => typeof x === "string");
  }

  return [];
}

function collectBrokenAnchors(workspace: string, memories: Iterable<Memory>): Memory[] {
  const seen = new Set<string>();
  const bad: Memory[] = [];
  for (const m of memories) {
    let hit = false;
    for (const ap of m.anchorPaths) {
      const rel = ap.replace(/\\/g, "/").replace(/^\/+/, "");
      const abs = path.join(workspace, rel);
      if (!fs.existsSync(abs)) {
        hit = true;
        break;
      }
    }
    if (hit && !seen.has(m.id)) {
      seen.add(m.id);
      bad.push(m);
    }
  }
  return bad;
}

function walkDir(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function loadMemories(memoriesDir: string): Memory[] {
  return walkDir(memoriesDir)
    .map((fp): Memory | null => {
      const raw = fs.readFileSync(fp, "utf8");
      const { fm, body } = parseFrontmatter(raw);
      if (!fm["id"]) return null;
      if (fm["type"] === "session_recap") return null;
      if (fm["status"] === "rejected" || fm["status"] === "deprecated") return null;

      const titleMatch = body.match(/^#{1,3}\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1]! : String(fm["id"]);

      const anchorPaths = extractAnchorPaths(fm);
      const tags = Array.isArray(fm["tags"])
        ? (fm["tags"] as string[])
        : typeof fm["tags"] === "string"
        ? String(fm["tags"]).split(",").map((t) => t.trim()).filter(Boolean)
        : [];

      return {
        id: String(fm["id"]),
        title,
        type: String(fm["type"] ?? "unknown"),
        scope: String(fm["scope"] ?? "team"),
        status: String(fm["status"] ?? "draft"),
        tags,
        anchorPaths,
        requiresHumanApproval: fm["requires_human_approval"] === true,
        body,
        filePath: fp,
        ...(extractSensor(raw) ? { sensor: extractSensor(raw)! } : {}),
      };
    })
    .filter((m): m is Memory => m !== null);
}

/**
 * Does a changed file fall under an anchor path?
 *
 * Matching is on PATH SEGMENTS, never on string suffixes. The suffix rule this replaces
 * (`changeNorm.endsWith(anchorNorm)`) matched any two paths that happened to share a tail, so a
 * memory anchored on `packages/core/package.json` matched every `package.json` in the repo and a
 * twenty-line `frontend/public/images/README.md` drew a comment about monorepo version tagging
 * (field report 2026-09-05 §6, PR #78). One confident wrong match teaches a reviewer to skim the
 * whole block, including the PRs where it was right.
 */
export function pathsOverlap(changeNorm: string, anchorNorm: string): boolean {
  if (!changeNorm || !anchorNorm) return false;
  if (changeNorm === anchorNorm) return true;
  // The anchor names a directory that contains the changed file.
  if (changeNorm.startsWith(`${anchorNorm}/`)) return true;
  // The anchor names a file inside a directory the change refers to (rare: directory-valued diffs).
  if (anchorNorm.startsWith(`${changeNorm}/`)) return true;
  return false;
}

/**
 * Files so frequently touched that their presence in a diff carries no information — a roadmap a
 * team convention makes every PR update, a CHANGELOG, a version file. Anchoring on one makes the
 * same memories resurface on every PR: four of eight PRs in field report 2026-09-05 §6 matched
 * `docs/roadmap.md` and NOTHING else, producing four identical comments. Four repetitions are
 * enough for a reviewer to stop reading the block.
 *
 * Pure, and computed from the repo's own history rather than a guessed filename list — a file is
 * high-churn here or it is not.
 */
export function highChurnPaths(
  commitFileLists: string[][],
  opts: { minCommits?: number; threshold?: number } = {},
): Set<string> {
  const minCommits = opts.minCommits ?? 20;
  const threshold = opts.threshold ?? 0.4;
  const out = new Set<string>();
  // Too little history to characterise churn: exclude nothing rather than guess. A shallow
  // checkout must degrade to the old behaviour, never to a silent over-filter.
  if (commitFileLists.length < minCommits) return out;
  const counts = new Map<string, number>();
  for (const files of commitFileLists) {
    for (const file of new Set(files)) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  for (const [file, count] of counts) {
    if (count / commitFileLists.length >= threshold) out.add(file);
  }
  return out;
}

/** Per-commit file lists from the checked-out history. Empty when the checkout is shallow. */
function readCommitFileLists(workspace: string, limit = 60): string[][] {
  try {
    const raw = execFileSync(
      "git",
      ["log", `-${limit}`, "--no-merges", "--name-only", "--format=%x00"],
      { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return raw
      .split("\0")
      .map((chunk) => chunk.split("\n").map((l) => l.trim()).filter(Boolean))
      .filter((files) => files.length > 0);
  } catch {
    return [];
  }
}

function anchorTouchesChanges(changedNorm: string[], anchorPaths: string[]): boolean {
  for (const ap of anchorPaths) {
    const an = ap.replace(/\\/g, "/");
    for (const cf of changedNorm) {
      if (pathsOverlap(cf, an)) return true;
    }
  }
  return false;
}

function memoriesForFiles(
  memories: Memory[],
  changedFiles: string[],
  ignoredPaths: ReadonlySet<string> = new Set(),
): Map<string, Memory[]> {
  const normalizedFiles = changedFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => !ignoredPaths.has(f));
  const result = new Map<string, Memory[]>();

  for (const file of normalizedFiles) {
    const matching = memories.filter((m) =>
      m.anchorPaths.some((ap) => {
        const a = ap.replace(/\\/g, "/");
        return pathsOverlap(file, a);
      }),
    );
    if (matching.length > 0) result.set(file, matching);
  }

  return result;
}


const TYPE_ICON: Record<string, string> = {
  gotcha: "⚠️",
  architecture: "🏗️",
  convention: "📐",
  decision: "🎯",
  glossary: "📖",
  attempt: "🔁",
};

function formatComment(
  header: string,
  fileMemories: Map<string, Memory[]>,
  allActionRequired: Memory[],
  changedFiles: string[],
  brokenAnchors: Memory[],
  ignoredPaths: string[] = [],
): string {
  const lines: string[] = [COMMENT_MARKER, header, ""];

  const totalMemories = [...fileMemories.values()].reduce((s, a) => s + a.length, 0);
  const uniqueIds = new Set([...fileMemories.values()].flat().map((m) => m.id));

  // ── Action Required banner ───────────────────────────────────────────────
  if (allActionRequired.length > 0) {
    lines.push(
      `> ⚠️ **${allActionRequired.length} memory(ies) require human confirmation** before AI agents can act on them.\n`,
    );

    for (const m of allActionRequired) {
      lines.push(`<details>`);
      lines.push(`<summary>⚠️ <strong>${m.title}</strong> <code>${m.scope}/${m.type}</code></summary>\n`);
      lines.push(m.body.trim());
      lines.push(`\n</details>\n`);
    }
    lines.push("---\n");
  }

  // ── Sensors covering the changed files ─────────────────────────────────
  // The memories that can actually REFUSE this change, named before the advisory ones. In field
  // report 2026-09-05 §5 the sensor that predicted the incident existed, was in scope of no changed
  // file, and never appeared here — while ten advisory memories did. Listing what is armed on these
  // exact files is what makes the block at commit time predictable instead of a surprise.
  const armed = [...fileMemories.entries()]
    .flatMap(([file, ms]) => ms.filter((m) => m.sensor).map((m) => ({ file, memory: m })));
  const armedById = new Map<string, { file: string; memory: Memory }>();
  for (const entry of armed) if (!armedById.has(entry.memory.id)) armedById.set(entry.memory.id, entry);
  if (armedById.size > 0) {
    lines.push(`### 🛡️ Sensors armed on these files
`);
    for (const { file, memory } of [...armedById.values()].slice(0, 10)) {
      const icon = memory.sensor!.severity === "block" ? "⛔" : "⚠️";
      lines.push(
        `- ${icon} \`${memory.id}\` (${memory.sensor!.severity}) on \`${file}\`` +
        (memory.sensor!.message ? ` — ${memory.sensor!.message}` : ""),
      );
    }
    lines.push("");
  }

  // ── Broken anchor paths ────────────────────────────────────────────────
  if (brokenAnchors.length > 0) {
    lines.push(
      `### ⚠️ Memories with anchor paths missing in this checkout\n\n` +
      `Those files might have been renamed/moved/deleted — update anchors or refresh memory status.`,
    );
    for (const m of brokenAnchors.slice(0, 12)) {
      const pathsSnippet = m.anchorPaths.slice(0, 3).map((x) => "`" + x + "`").join(", ");
      lines.push(`- **${m.title}** (\`${m.id}\`) · paths: ${pathsSnippet}`);
    }
    if (brokenAnchors.length > 12) {
      lines.push(
        `- *…+${brokenAnchors.length - 12} more — inspect locally with \`hivelore memory verify\`*`,
      );
    }
    lines.push("\n");
  }

  // ── Per-file memories ────────────────────────────────────────────────────
  if (fileMemories.size > 0) {
    lines.push(`**${uniqueIds.size} ${uniqueIds.size === 1 ? "memory" : "memories"} relevant to this PR** (across ${fileMemories.size} file${fileMemories.size > 1 ? "s" : ""}):\n`);

    for (const [file, mems] of fileMemories.entries()) {
      lines.push(`### \`${file}\``);
      for (const m of mems.slice(0, MAX_MEMORIES)) {
        const icon = TYPE_ICON[m.type] ?? "📝";
        const arBadge = m.requiresHumanApproval ? " 🚨 **action required**" : "";
        const scopeBadge = `\`${m.scope}/${m.type}\``;
        const statusBadge = m.status === "stale" ? " *(stale)*" : "";

        lines.push(`<details>`);
        lines.push(
          `<summary>${icon} <strong>${m.title}</strong> ${scopeBadge}${arBadge}${statusBadge}</summary>\n`,
        );

        // Strip the "action required" header for non-AR memories (already surfaced above).
        // Keep the legacy French heading for old auto-generated memories.
        const bodyToShow = m.requiresHumanApproval
          ? m.body.trim()
          : m.body.replace(/^##\s*⚠️ Action (?:required|requise).*\n[\s\S]*?---\n\n/m, "").trim();

        lines.push(bodyToShow.slice(0, 800) + (bodyToShow.length > 800 ? "\n\n…" : ""));
        lines.push(`\n</details>\n`);
      }
      if (mems.length > MAX_MEMORIES) {
        lines.push(`*+${mems.length - MAX_MEMORIES} more — run \`hivelore memory for-files ${file}\`*\n`);
      }
    }
  } else {
    lines.push("✅ **No memories found for the changed files.** The code appears well-understood by the team.");
    lines.push("\n> Tip: run `hivelore memory for-files <file>` locally to check, or `hivelore briefing` for the full context.\n");
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(
    "**Next steps**: run `hivelore memory verify --update stale` locally after refactoring paths, " +
    "or `hivelore memory lint` inside CI.",
  );
  lines.push("");
  lines.push(
    ...(ignoredPaths.length > 0
      ? [`<sub>Ignored for matching (touched by most PRs): ${ignoredPaths.map((p) => `\`${p}\``).join(", ")}</sub>`, ""]
      : []),
    `<sub>🧠 Powered by [Hivelore](https://github.com/Doucs91/hivelore) · ${changedFiles.length} file${changedFiles.length > 1 ? "s" : ""} scanned · ${new Date().toUTCString()}</sub>`,
  );

  return lines.join("\n");
}

// ── GitHub comment management ─────────────────────────────────────────────────

async function findExistingComment(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | undefined> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
  return existing?.id;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function setOutput(key: string, value: string): void {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  } else {
    console.log(`::set-output name=${key}::${value}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── /hivelore remember — the PR loop's capture ack (excellence plan, Phase 3) ────────────────────
// A reviewer replies `/hivelore remember <rule>` on a thread; the action acknowledges it
// (CodeRabbit's "Learnings added" moment) and hands back the exact local command that persists the
// thread as a proposed memory. Automatic persistence writes only to a dedicated branch and opens a
// reviewable PR; it never writes directly to the default branch.
const REMEMBER_RE = /^\/?hivelore\s+remember\b\s*/i;
const TRUSTED_REVIEW_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isTrustedReviewLearningAuthor(authorAssociation: string | undefined): boolean {
  return TRUSTED_REVIEW_ASSOCIATIONS.has((authorAssociation ?? "").toUpperCase());
}

export function reviewLearningContent(input: {
  commentId: number;
  instruction: string;
  author: string;
  path?: string;
  prNumber: number;
}): { file: string; content: string } {
  const day = new Date().toISOString().slice(0, 10);
  const slug = input.instruction.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").trim().split(/\s+/).slice(0, 6).join("-") || "review-learning";
  const id = `${day}-convention-${slug}-${input.commentId}`;
  const quoted = (value: string): string => JSON.stringify(value);
  const anchor = input.path ? `  paths:\n    - ${quoted(input.path)}\n` : "  paths: []\n";
  const content = [
    "---",
    `id: ${quoted(id)}`,
    "type: convention",
    "scope: team",
    "status: proposed",
    `created_at: ${quoted(new Date().toISOString())}`,
    `updated_at: ${quoted(new Date().toISOString())}`,
    `author: ${quoted(input.author)}`,
    `topic: ${quoted(`ingest:github-comment:${input.commentId}`)}`,
    "tags:",
    "  - review-learning",
    "anchor:",
    "  commit: null",
    anchor.trimEnd(),
    "  symbols: []",
    "---",
    "",
    `# Review learning: ${input.instruction.slice(0, 80)}`,
    "",
    input.instruction,
    "",
    input.path ? `Applies to: \`${input.path}\`` : "Applies repository-wide until refined.",
    "",
    `_Captured from PR #${input.prNumber} by @${input.author}. Review, refine, and approve before enforcement._`,
    "",
  ].join("\n");
  return { file: `.ai/memories/team/${id}.md`, content };
}

export async function persistReviewLearning(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  input: Parameters<typeof reviewLearningContent>[0],
): Promise<string | null> {
  const { file, content } = reviewLearningContent(input);
  const branch = `hivelore/review-learning-${input.commentId}`;
  const repository = await octokit.rest.repos.get({ owner, repo });
  const base = repository.data.default_branch;
  const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 422) throw err;
  }
  let existingSha: string | undefined;
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path: file, ref: branch });
    if (!Array.isArray(existing.data) && existing.data.type === "file") existingSha = existing.data.sha;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo, path: file, branch,
    message: `docs(memory): capture review learning from PR #${input.prNumber}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    ...(existingSha ? { sha: existingSha } : {}),
  });
  const existingPulls = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open" });
  if (existingPulls.data[0]?.html_url) return existingPulls.data[0].html_url;
  const pull = await octokit.rest.pulls.create({
    owner, repo, head: branch, base,
    title: `docs(memory): review learning from PR #${input.prNumber}`,
    body: `Captures an explicit \`/hivelore remember\` instruction from PR #${input.prNumber} as a proposed, reviewable team memory.`,
  });
  return pull.data.html_url;
}

export async function handleRememberComment(eventName: string): Promise<boolean> {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath || !fs.existsSync(eventPath)) return false;
  let event: {
    comment?: { id?: number; body?: string; path?: string; author_association?: string; user?: { login?: string } };
    pull_request?: { number?: number };
    issue?: { number?: number; pull_request?: unknown };
  };
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return false;
  }
  const body = (event.comment?.body ?? "").trim();
  if (!REMEMBER_RE.test(body)) {
    console.log("Hivelore: comment does not start with /hivelore remember — nothing to do.");
    return true; // it WAS a comment event; there is no PR scan to run
  }
  if (!isTrustedReviewLearningAuthor(event.comment?.author_association)) {
    console.warn("Hivelore: ignored /hivelore remember from an untrusted commenter.");
    return true;
  }
  const instruction = body.replace(REMEMBER_RE, "").trim().slice(0, 500);
  const prNumber = event.pull_request?.number ?? event.issue?.number;
  if (!prNumber || !instruction) return true;

  const [owner, repo] = GH_REPO.split("/") as [string, string];
  const octokit = getOctokit(GH_TOKEN);
  const author = event.comment?.user?.login ?? "reviewer";
  let persistenceUrl: string | null = null;
  if (PERSIST_REVIEW_LEARNINGS && event.comment?.id) {
    try {
      persistenceUrl = await persistReviewLearning(octokit, owner, repo, {
        commentId: event.comment.id,
        instruction,
        author,
        ...(event.comment.path ? { path: event.comment.path } : {}),
        prNumber,
      });
    } catch (err) {
      console.warn(`Hivelore: could not persist review learning automatically: ${String(err)}`);
    }
  }
  const filePart = event.comment?.path ? ` (anchored to \`${event.comment.path}\`)` : "";
  const ack = [
    `🧠 **Hivelore — learning candidate captured**${filePart}`,
    "",
    `> ${instruction}`,
    "",
    persistenceUrl
      ? `Persisted as a proposed team-memory PR: ${persistenceUrl}`
      : "Automatic persistence was unavailable. Persist locally with:",
    ...(persistenceUrl ? [] : ["```bash", `hivelore ingest --from github-pr ${prNumber}`, "```"]),
    "Then approve/refine it — and consider `hivelore sensors propose` to turn it into a deterministic gate.",
  ].join("\n");

  if (eventName === "pull_request_review_comment" && event.comment?.id) {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner, repo, pull_number: prNumber, comment_id: event.comment.id, body: ack,
    });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: ack });
  }
  console.log(`Hivelore: acknowledged /hivelore remember on PR #${prNumber}.`);
  return true;
}

async function main(): Promise<void> {
  try {
    const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
    if (eventName === "pull_request_review_comment" || eventName === "issue_comment") {
      const handled = await handleRememberComment(eventName);
      if (handled) {
        setOutput("memories_found", "0");
        setOutput("action_required_count", "0");
        setOutput("comment_url", "");
        return;
      }
    }
    const changedFiles = CHANGED_FILES_RAW
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    console.log(`Hivelore: scanning ${changedFiles.length} changed file(s)…`);

    const memoriesDir = path.join(WORKSPACE, MEMORIES_DIR_REL);

    if (!fs.existsSync(memoriesDir)) {
      console.log(`Hivelore: memories directory not found at ${memoriesDir}. Skipping.`);
      setOutput("memories_found", "0");
      setOutput("action_required_count", "0");
      setOutput("comment_url", "");
      process.exit(0);
    }

    const allMemories = loadMemories(memoriesDir);
    console.log(`Hivelore: loaded ${allMemories.length} memories`);

    const changedNorm = changedFiles.map((f) => f.replace(/\\/g, "/"));
    const anchorRelated = allMemories.filter((m) =>
      anchorTouchesChanges(changedNorm, m.anchorPaths),
    );
    const brokenAnchors = collectBrokenAnchors(WORKSPACE, anchorRelated);

    // Drop the files every PR touches before matching: a memory surfaced because the roadmap moved
    // is noise, and noise on four PRs out of eight costs the reviewer's attention on the four where
    // the match was real.
    const churn = highChurnPaths(readCommitFileLists(WORKSPACE));
    const ignoredHere = changedNorm.filter((f) => churn.has(f));
    if (ignoredHere.length > 0) {
      console.log(`Hivelore: ignoring ${ignoredHere.length} high-churn file(s) for matching: ${ignoredHere.join(", ")}`);
    }
    const fileMemories = memoriesForFiles(allMemories, changedFiles, churn);
    const allSurfaced = [...fileMemories.values()].flat();
    const uniqueIds = new Set(allSurfaced.map((m) => m.id));
    const actionRequired = allMemories.filter(
      (m) => m.requiresHumanApproval && m.status !== "rejected",
    );

    console.log(
      `Hivelore: ${uniqueIds.size} unique memories found across ${fileMemories.size} files ` +
      `(${actionRequired.length} action required)`,
    );

    if (uniqueIds.size === 0 && brokenAnchors.length === 0 && !POST_IF_EMPTY) {
      console.log("Hivelore: no memories found, skipping comment.");
      setOutput("memories_found", "0");
      setOutput("action_required_count", "0");
      setOutput("comment_url", "");
      process.exit(0);
    }

    // ── Post / update comment ──────────────────────────────────────────────
    const body = formatComment(
      COMMENT_HEADER,
      fileMemories,
      actionRequired,
      changedFiles,
      brokenAnchors,
      ignoredHere,
    );

    const [owner, repo] = GH_REPO.split("/") as [string, string];
    const octokit = getOctokit(GH_TOKEN);

    const existingId = await findExistingComment(octokit, owner, repo, PR_NUMBER);

    let commentUrl: string;

    if (existingId) {
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingId,
        body,
      });
      commentUrl = data.html_url;
      console.log(`Hivelore: updated existing comment → ${commentUrl}`);
    } else {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: PR_NUMBER,
        body,
      });
      commentUrl = data.html_url;
      console.log(`Hivelore: posted new comment → ${commentUrl}`);
    }

    setOutput("memories_found", String(uniqueIds.size));
    setOutput("action_required_count", String(actionRequired.length));
    setOutput("comment_url", commentUrl);

    // Fail the check if there are action_required memories (optional — decided by workflow)
    if (actionRequired.length > 0) {
      console.log(
        `::warning::Hivelore: ${actionRequired.length} memory(ies) require human confirmation. Review the PR comment.`,
      );
    }

  } catch (err) {
    console.error("Hivelore action error:", err);
    process.exit(1);
  }
}

if (process.env["HIVELORE_ACTION_TEST"] !== "1") main();
