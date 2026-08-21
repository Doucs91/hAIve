import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { HaivePaths } from "./paths.js";
import { parseFileAst, type AstExport } from "./ast-parser.js";

export const CODE_MAP_FILE = "code-map.json";

export type CodeExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "default";

export interface CodeExport {
  name: string;
  kind: CodeExportKind;
  description?: string;
  line: number;
}

export interface CodeFileEntry {
  summary?: string;
  exports: CodeExport[];
  loc: number;
}

export interface CodeMap {
  version: 1;
  /**
   * When this map was last WRITTEN — i.e. when its content last changed, since an unchanged scan
   * no longer rewrites the file (see `saveCodeMap`). Back-filled on load from the runtime sidecar
   * or the file mtime; it is deliberately NOT part of the committed payload, because a per-run
   * timestamp made every `sync` produce a diff and conflict on every `pull` for every developer.
   */
  generated_at: string;
  /**
   * Absolute project root, back-filled on load. Never serialized: it embedded one developer's
   * home directory in a shared file, so no two machines could produce the same bytes.
   */
  root: string;
  /** Digest of the serialized payload — the staleness key, replacing "was it regenerated?". */
  content_hash?: string;
  files: Record<string, CodeFileEntry>;
}

export interface BuildCodeMapOptions {
  includeExtensions?: string[];
  excludeDirs?: string[];
  /** Include untracked files that are not ignored by git. Default: false when the root is a git repo. */
  includeUntracked?: boolean;
}

export const CODE_MAP_DEFAULT_INCLUDE = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".java", ".kt",
  ".py",
  ".go",
  ".rb",
  ".rs",
  ".cs",
  ".php",
];
// Exported so every caller (init, sync, autopilot repair, index-code) EXTENDS the same
// baseline instead of hand-rolling a shorter list — divergent lists made successive
// code-maps disagree on which files exist (test dirs in one build, absent in the next).
export const CODE_MAP_DEFAULT_EXCLUDE = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".turbo",
  ".vitest-cache",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "target",        // Maven/Gradle build output
  ".gradle",
  "__pycache__",
  ".pytest_cache",
  "vendor",        // Go / PHP
];

const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$/i;

export function codeMapPath(paths: HaivePaths): string {
  return path.join(paths.haiveDir, CODE_MAP_FILE);
}

/** Local, gitignored sidecar holding the one field that cannot be deterministic: when we last wrote. */
function codeMapMetaPath(paths: HaivePaths): string {
  return path.join(paths.runtimeDir, "code-map-meta.json");
}

/**
 * Serialize a code-map so that the same source tree always produces the SAME BYTES, on any machine.
 *
 * Two fields used to break that and made the file unversionable: an absolute `root` (one developer's
 * home directory) and a `generated_at` stamped on every run. Together they guaranteed a conflicting
 * diff on every `sync` for every developer — the file could neither be committed nor ignored
 * (`doctor` asks for it). Both now live outside the payload, and `files` keys are sorted so readdir
 * order cannot reshuffle 500 KB of JSON.
 */
export function serializeCodeMap(map: CodeMap): string {
  const files: Record<string, CodeFileEntry> = {};
  for (const key of Object.keys(map.files).sort()) files[key] = map.files[key]!;
  return `${JSON.stringify({ version: map.version, files }, null, 2)}\n`;
}

export function codeMapContentHash(map: CodeMap): string {
  return createHash("sha256").update(serializeCodeMap(map)).digest("hex").slice(0, 16);
}

export async function loadCodeMap(paths: HaivePaths): Promise<CodeMap | null> {
  const file = codeMapPath(paths);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(await readFile(file, "utf8")) as CodeMap;
  // Back-fill the two fields we no longer persist, so every consumer (staleness checks, the
  // embeddings code index, doctor) keeps reading the same shape it always has.
  const generatedAt =
    parsed.generated_at ??
    (await readFile(codeMapMetaPath(paths), "utf8")
      .then((raw) => (JSON.parse(raw) as { generated_at?: string }).generated_at)
      .catch(() => undefined)) ??
    (await stat(file).then((s) => s.mtime.toISOString()).catch(() => new Date(0).toISOString()));
  return { ...parsed, root: parsed.root ?? paths.root, generated_at: generatedAt };
}

/**
 * Write the map only when its content actually changed. An unchanged scan is a no-op, so the file
 * mtime — and therefore every "is the index stale?" check downstream — moves on content change
 * rather than on "did someone run sync?".
 */
export async function saveCodeMap(paths: HaivePaths, map: CodeMap): Promise<void> {
  const file = codeMapPath(paths);
  const payload = serializeCodeMap(map);
  const current = existsSync(file) ? await readFile(file, "utf8").catch(() => null) : null;
  if (current === payload) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, payload, "utf8");
  await mkdir(paths.runtimeDir, { recursive: true }).catch(() => {});
  await writeFile(
    codeMapMetaPath(paths),
    `${JSON.stringify({ generated_at: new Date().toISOString(), content_hash: codeMapContentHash(map) }, null, 2)}\n`,
    "utf8",
  ).catch(() => {});
}

export async function buildCodeMap(
  root: string,
  options: BuildCodeMapOptions = {},
): Promise<CodeMap> {
  const include = new Set(options.includeExtensions ?? CODE_MAP_DEFAULT_INCLUDE);
  const exclude = new Set(options.excludeDirs ?? CODE_MAP_DEFAULT_EXCLUDE);
  const files: Record<string, CodeFileEntry> = {};

  for await (const abs of collectSourceFiles(root, include, exclude, options.includeUntracked)) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (rel.startsWith(".ai/")) continue;
    const content = await readFile(abs, "utf8");
    const ext = path.extname(abs).toLowerCase();
    const entry = await parseFileEntry(content, ext);
    if (entry.exports.length > 0) files[rel] = entry;
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    root,
    files,
  };
}

/**
 * Count source files physically present on disk (FS walk, excluding node_modules/build/hidden dirs),
 * regardless of git tracking. Used by `hivelore doctor` to detect a code-map that captured far fewer
 * files than the repo actually holds (untracked source, or a structure the indexer missed).
 */
export async function countSourceFilesOnDisk(
  root: string,
  options: { excludeDirs?: string[] } = {},
): Promise<number> {
  const include = new Set(CODE_MAP_DEFAULT_INCLUDE);
  const exclude = new Set([...CODE_MAP_DEFAULT_EXCLUDE, ...(options.excludeDirs ?? [])]);
  let count = 0;
  for await (const _file of walkSourceFiles(root, include, exclude)) count++;
  return count;
}

async function* collectSourceFiles(
  root: string,
  include: Set<string>,
  exclude: Set<string>,
  includeUntracked: boolean | undefined,
): AsyncGenerator<string> {
  const gitFiles = gitSourceFiles(root, include, exclude, includeUntracked === true);
  if (gitFiles) {
    for (const rel of gitFiles) yield path.join(root, rel);

    // `git ls-files` in the parent does NOT descend into a subdirectory that is its own git repo
    // (monorepos with embedded/nested repos or submodules). Their real source would silently be
    // invisible — on a real marketplace monorepo this indexed 2 of 1400+ files. So discover nested
    // repos and `git ls-files` each one. This still indexes ONLY tracked source (each repo's own
    // .gitignore is respected) — it does NOT fall back to walking untracked junk, preserving
    // 2026-05-28-decision-codemap-tracked-files-by-default.
    for await (const nested of findNestedGitRepos(root, exclude)) {
      const nestedFiles = gitSourceFiles(nested, include, exclude, includeUntracked === true);
      if (nestedFiles) {
        for (const rel of nestedFiles) yield path.join(nested, rel);
      }
    }
    return;
  }

  yield* walkSourceFiles(root, include, exclude);
}

/**
 * Find subdirectories of `root` that are their own git repositories (contain a `.git` entry).
 * Skips excluded dirs (node_modules, dist, …) and hidden dirs, and does not descend INTO a found
 * repo (its own `git ls-files` covers its subtree). Depth-limited to keep large trees cheap.
 */
async function* findNestedGitRepos(
  root: string,
  exclude: Set<string>,
  depth = 0,
): AsyncGenerator<string> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (exclude.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (existsSync(path.join(full, ".git"))) {
      yield full; // its own ls-files handles its subtree; don't descend further here
    } else {
      yield* findNestedGitRepos(full, exclude, depth + 1);
    }
  }
}

function gitSourceFiles(
  root: string,
  include: Set<string>,
  exclude: Set<string>,
  includeUntracked: boolean,
): string[] | null {
  const args = includeUntracked
    ? ["ls-files", "--cached", "--others", "--exclude-standard"]
    : ["ls-files", "--cached"];
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((rel) => isIncludedSourcePath(rel, include, exclude))
    .sort();
}

async function* walkSourceFiles(
  dir: string,
  include: Set<string>,
  exclude: Set<string>,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      // Skip hidden dirs except .github (workflows can be useful)
      if (entry.isDirectory()) continue;
    }
    if (exclude.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full, include, exclude);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (include.has(ext) && !TEST_FILE_RE.test(entry.name)) yield full;
    }
  }
}

function isIncludedSourcePath(
  rel: string,
  include: Set<string>,
  exclude: Set<string>,
): boolean {
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith(".ai/")) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => exclude.has(part))) return false;
  const base = parts.at(-1) ?? "";
  const ext = path.extname(base).toLowerCase();
  return include.has(ext) && !TEST_FILE_RE.test(base);
}

// `(?:^|;)[ \t]*` so an export sharing a line with a preceding statement
// (`import {App} from "./App"; export const x = App;`) is still detected, not only line-start exports.
const EXPORT_RE =
  /(?:^|;)[ \t]*export\s+(?:default\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+(\*?)\s*([A-Za-z_$][\w$]*)/gm;

const NAMED_REEXPORT_RE = /(?:^|;)[ \t]*export\s*\{([^}]+)\}/gm;

// CommonJS: module.exports = { a, b }, exports.foo = …, module.exports = ident|function|class.
const CJS_OBJECT_RE = /module\.exports\s*=\s*\{([^}]*)\}/m;
const CJS_PROP_RE = /(?:^|[;{\s])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm;
const CJS_DECL_RE = /module\.exports\s*=\s*(?:async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)/m;
const CJS_IDENT_RE = /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/m;

const FILE_HEADER_COMMENT_RE = /^\/\*\*([\s\S]*?)\*\//;

// Java / Kotlin: public/protected class, interface, enum, record, @interface, fun, @RestController etc.
const JAVA_DECL_RE =
  /^(?:[ \t]*)(?:@\w+\s+)*(?:public|protected|private|internal)?\s*(?:static\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*(?:(class|interface|enum|record|@interface|object)\s+([A-Z][A-Za-z0-9_$]*)|(fun|def|func|function)\s+([a-z_][A-Za-z0-9_$]*))/gm;

// Python: def / class at module level (not indented)
const PYTHON_DECL_RE = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// Go: func declarations
const GO_DECL_RE = /^func\s+(?:\(\w+\s+\*?[A-Za-z_][\w]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/gm;

// Rust: pub fn / pub struct / pub enum / pub trait
const RUST_DECL_RE =
  /^pub(?:\([^)]*\))?\s+(fn|struct|enum|trait|type|const|impl|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

/**
 * Parse one file into a code-map entry, preferring a real AST (web-tree-sitter). Falls back to the
 * legacy regex parser when AST parsing is unavailable (unsupported extension, WASM init failure, or a
 * grammar that can't load) so indexing never regresses to zero on an environment without the runtime.
 */
async function parseFileEntry(source: string, ext: string): Promise<CodeFileEntry> {
  const ast = await parseFileAst(source, ext);
  if (ast) return decorateAstEntry(source, ext, ast);
  return parseFile(source, ext);
}

/**
 * Turn AST-extracted symbols (structure only) into a full entry by attaching the same descriptions
 * (JSDoc-above / Python docstring) and file summary the regex parsers produce — keeping the output
 * contract byte-stable for the embeddings indexer and symbol lookup.
 */
function decorateAstEntry(source: string, ext: string, astExports: AstExport[]): CodeFileEntry {
  const lines = source.split("\n");
  const exports: CodeExport[] = astExports.map((e) => {
    const description =
      ext === ".py" ? extractPythonDocstring(lines, e.line - 1) : extractJSDocAbove(lines, e.line - 1);
    return { name: e.name, kind: e.kind, ...(description ? { description } : {}), line: e.line };
  });
  const summary = summarizeForExt(source, ext);
  return { ...(summary ? { summary } : {}), exports, loc: lines.length };
}

function summarizeForExt(source: string, ext: string): string | undefined {
  if (ext === ".py") return extractPythonModuleDocstring(source);
  if (ext === ".java" || ext === ".kt") return extractJavaSummary(source);
  if (ext === ".go" || ext === ".rs") return undefined; // matches the legacy Go/Rust parsers
  return extractFileSummary(source); // JS/TS family
}

function parseFile(source: string, ext: string): CodeFileEntry {
  if (ext === ".java" || ext === ".kt") return parseJvmFile(source);
  if (ext === ".py") return parsePythonFile(source);
  if (ext === ".go") return parseGoFile(source);
  if (ext === ".rs") return parseRustFile(source);
  return parseJsFile(source);
}

function parseJsFile(source: string): CodeFileEntry {
  const exports: CodeExport[] = [];
  const lines = source.split("\n");
  const lineOffsets = computeLineOffsets(source);

  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(source))) {
    const kindRaw = m[2] ?? "";
    const name = m[4] ?? "";
    if (!name) continue;
    const kind: CodeExportKind =
      kindRaw === "function" ? "function" :
      kindRaw === "class" ? "class" :
      kindRaw === "interface" ? "interface" :
      kindRaw === "type" ? "type" :
      kindRaw === "enum" ? "enum" : "const";
    const lineIdx = byteToLine(m.index, lineOffsets);
    const description = extractJSDocAbove(lines, lineIdx);
    exports.push({ name, kind, ...(description ? { description } : {}), line: lineIdx + 1 });
  }

  NAMED_REEXPORT_RE.lastIndex = 0;
  while ((m = NAMED_REEXPORT_RE.exec(source))) {
    const inside = m[1] ?? "";
    const lineIdx = byteToLine(m.index, lineOffsets);
    for (const part of inside.split(",")) {
      const cleaned = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if (!cleaned || cleaned.startsWith("type ")) continue;
      if (exports.some((e) => e.name === cleaned)) continue;
      exports.push({ name: cleaned, kind: "const", line: lineIdx + 1 });
    }
  }

  parseCjsExports(source, lineOffsets, exports);

  const summary = extractFileSummary(source);
  return { ...(summary ? { summary } : {}), exports, loc: source.split("\n").length };
}

/**
 * CommonJS exports — `module.exports = { a, b }`, `exports.foo = …`, `module.exports = ident`,
 * `module.exports = function/class name`. Plain Node CJS files (no ES `export`) would otherwise index
 * to ZERO exports and vanish from the code-map entirely. Appends to `exports`, deduped by name.
 */
function parseCjsExports(source: string, lineOffsets: number[], exports: CodeExport[]): void {
  const add = (name: string, kind: CodeExportKind, index: number): void => {
    const clean = name.trim();
    if (!clean || /^\.\.\./.test(clean) || exports.some((e) => e.name === clean)) return;
    exports.push({ name: clean, kind, line: byteToLine(index, lineOffsets) + 1 });
  };

  // module.exports = function foo / class Foo
  const decl = CJS_DECL_RE.exec(source);
  if (decl) add(decl[2] ?? "", decl[1] === "class" ? "class" : "function", decl.index);

  // module.exports = { a, b: x, c }
  const obj = CJS_OBJECT_RE.exec(source);
  if (obj) {
    for (const part of (obj[1] ?? "").split(",")) {
      const key = part.split(":")[0]?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key, "const", obj.index);
    }
  }

  // exports.foo = … / module.exports.foo = …
  let m: RegExpExecArray | null;
  CJS_PROP_RE.lastIndex = 0;
  while ((m = CJS_PROP_RE.exec(source))) add(m[1] ?? "", "const", m.index);

  // module.exports = ident;  (single re-export of a value) — only when no object/decl already matched
  if (!obj && !decl) {
    const ident = CJS_IDENT_RE.exec(source);
    if (ident) add(ident[1] ?? "", "const", ident.index);
  }
}

function parseJvmFile(source: string): CodeFileEntry {
  const exports: CodeExport[] = [];
  const lines = source.split("\n");
  const lineOffsets = computeLineOffsets(source);
  let m: RegExpExecArray | null;
  JAVA_DECL_RE.lastIndex = 0;
  while ((m = JAVA_DECL_RE.exec(source))) {
    const kindRaw = m[1] ?? m[3] ?? "";
    const name = m[2] ?? m[4] ?? "";
    if (!name) continue;
    const kind: CodeExportKind =
      kindRaw === "class" || kindRaw === "record" || kindRaw === "object" ? "class" :
      kindRaw === "interface" || kindRaw === "@interface" ? "interface" :
      kindRaw === "enum" ? "enum" :
      kindRaw === "fun" || kindRaw === "def" || kindRaw === "func" || kindRaw === "function" ? "function" :
      "const";
    const lineIdx = byteToLine(m.index, lineOffsets);
    const description = extractJSDocAbove(lines, lineIdx);
    exports.push({ name, kind, ...(description ? { description } : {}), line: lineIdx + 1 });
  }
  const summary = extractJavaSummary(source);
  return { ...(summary ? { summary } : {}), exports, loc: lines.length };
}

function parsePythonFile(source: string): CodeFileEntry {
  const exports: CodeExport[] = [];
  const lines = source.split("\n");
  const lineOffsets = computeLineOffsets(source);
  let m: RegExpExecArray | null;
  PYTHON_DECL_RE.lastIndex = 0;
  while ((m = PYTHON_DECL_RE.exec(source))) {
    const keyword = m[1] ?? "";
    const name = m[2] ?? "";
    if (!name || name.startsWith("_")) continue;
    const kind: CodeExportKind = keyword === "class" ? "class" : "function";
    const lineIdx = byteToLine(m.index, lineOffsets);
    const description = extractPythonDocstring(lines, lineIdx);
    exports.push({ name, kind, ...(description ? { description } : {}), line: lineIdx + 1 });
  }
  const summary = extractPythonModuleDocstring(source);
  return { ...(summary ? { summary } : {}), exports, loc: lines.length };
}

function parseGoFile(source: string): CodeFileEntry {
  const exports: CodeExport[] = [];
  const lines = source.split("\n");
  const lineOffsets = computeLineOffsets(source);
  let m: RegExpExecArray | null;
  GO_DECL_RE.lastIndex = 0;
  while ((m = GO_DECL_RE.exec(source))) {
    const name = m[1] ?? "";
    if (!name || !/^[A-Z]/.test(name)) continue; // Only exported (uppercase) in Go
    const lineIdx = byteToLine(m.index, lineOffsets);
    const description = extractJSDocAbove(lines, lineIdx);
    exports.push({ name, kind: "function", ...(description ? { description } : {}), line: lineIdx + 1 });
  }
  return { exports, loc: lines.length };
}

function parseRustFile(source: string): CodeFileEntry {
  const exports: CodeExport[] = [];
  const lines = source.split("\n");
  const lineOffsets = computeLineOffsets(source);
  let m: RegExpExecArray | null;
  RUST_DECL_RE.lastIndex = 0;
  while ((m = RUST_DECL_RE.exec(source))) {
    const kindRaw = m[1] ?? "";
    const name = m[2] ?? "";
    if (!name) continue;
    const kind: CodeExportKind =
      kindRaw === "struct" || kindRaw === "impl" ? "class" :
      kindRaw === "enum" ? "enum" :
      kindRaw === "trait" ? "interface" :
      kindRaw === "fn" ? "function" :
      kindRaw === "type" ? "type" : "const";
    const lineIdx = byteToLine(m.index, lineOffsets);
    const description = extractJSDocAbove(lines, lineIdx);
    exports.push({ name, kind, ...(description ? { description } : {}), line: lineIdx + 1 });
  }
  return { exports, loc: lines.length };
}

function extractJavaSummary(source: string): string | undefined {
  // Java/Kotlin: file-level Javadoc before first class/interface
  const m = source.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return undefined;
  const block = (m[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l && !l.startsWith("@"))
    .join(" ");
  return block ? firstSentence(block) : undefined;
}

function extractPythonDocstring(lines: string[], defLine: number): string | undefined {
  const next = lines[defLine + 1] ?? "";
  const stripped = next.trim();
  if (stripped.startsWith('"""') || stripped.startsWith("'''")) {
    const inner = stripped.replace(/^["']{3}/, "").replace(/["']{3}.*$/, "").trim();
    return inner || undefined;
  }
  return undefined;
}

function extractPythonModuleDocstring(source: string): string | undefined {
  const m = source.match(/^["']{3}([\s\S]*?)["']{3}/);
  if (!m) return undefined;
  return firstSentence((m[1] ?? "").trim());
}

function computeLineOffsets(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") out.push(i + 1);
  }
  return out;
}

function byteToLine(byte: number, offsets: number[]): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const off = offsets[mid] ?? 0;
    if (off <= byte) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function extractJSDocAbove(lines: string[], exportLine: number): string | undefined {
  let i = exportLine - 1;
  // Skip blank lines between JSDoc and export
  while (i >= 0 && (lines[i] ?? "").trim() === "") i--;
  if (i < 0) return undefined;
  const line = (lines[i] ?? "").trim();

  if (line.startsWith("//")) {
    return line.replace(/^\/\/\s*/, "").trim() || undefined;
  }

  // Single-line JSDoc: /** Adds two numbers. */
  const singleLine = line.match(/^\/\*\*\s*(.*?)\s*\*\/\s*$/);
  if (singleLine && singleLine[1]) {
    return firstSentence(singleLine[1]);
  }

  if (line.endsWith("*/")) {
    // Walk up until /**
    const collected: string[] = [];
    // First piece: content of the line before */
    const firstPiece = line.replace(/\*\/\s*$/, "").replace(/^\*\s?/, "").trim();
    if (firstPiece) collected.unshift(firstPiece);
    let j = i - 1;
    while (j >= 0) {
      const l = (lines[j] ?? "").trim();
      if (l.startsWith("/**")) {
        const inner = l.replace(/^\/\*\*/, "").trim();
        if (inner) collected.unshift(inner);
        break;
      }
      collected.unshift(l.replace(/^\*\s?/, "").trim());
      j--;
    }
    const joined = collected.join(" ").trim();
    if (!joined) return undefined;
    return firstSentence(joined);
  }
  return undefined;
}

function firstSentence(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/(?<=\.)\s+/)[0]?.trim();
}

function extractFileSummary(source: string): string | undefined {
  const m = source.match(FILE_HEADER_COMMENT_RE);
  if (!m) return undefined;
  const block = (m[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  if (!block) return undefined;
  const sentence = block.split(/(?<=\.)\s+/)[0]?.trim();
  return sentence;
}

export interface CodeMapQueryOptions {
  file?: string;
  symbol?: string;
}

export function queryCodeMap(map: CodeMap, options: CodeMapQueryOptions): {
  files: Array<{ path: string; entry: CodeFileEntry }>;
} {
  const files: Array<{ path: string; entry: CodeFileEntry }> = [];
  for (const [filePath, entry] of Object.entries(map.files)) {
    if (options.file) {
      if (!filePath.includes(options.file)) continue;
    }
    if (options.symbol) {
      const sym = options.symbol.toLowerCase();
      if (!entry.exports.some((e) => e.name.toLowerCase().includes(sym))) continue;
    }
    files.push({ path: filePath, entry });
  }
  return { files };
}
