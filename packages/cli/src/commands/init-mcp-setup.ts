/**
 * Auto-configure haive-mcp in supported AI clients.
 *
 * Two layers:
 *   User-level (global, written once):
 *     - Cursor  (~/.cursor/mcp.json)
 *     - VS Code (~/.config/Code/User/mcp.json or ~/Library/Application Support/Code/User/mcp.json)
 *     - Claude Code (~/.claude.json mcpServers field)
 *     - Windsurf (~/.codeium/windsurf/mcp_config.json)
 *
 *   Project-level (per project, written at hivelore init, includes HAIVE_PROJECT_ROOT):
 *     - Cursor  (<root>/.cursor/mcp.json)
 *     - VS Code (<root>/.vscode/mcp.json)
 *     - Claude Code (<root>/.mcp.json)
 *
 * Project-level configs take precedence over user-level when the client opens that
 * workspace, ensuring the MCP server always resolves the correct project root even
 * when the same haive process serves multiple projects.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const HAIVE_MCP_ENTRY = {
  command: "hivelore",
  args: ["mcp", "--stdio"],
};

function projectMcpEntry(root: string) {
  return {
    command: "hivelore",
    args: ["mcp", "--stdio"],
    env: { HAIVE_PROJECT_ROOT: root },
  };
}

// ── Cursor ────────────────────────────────────────────────────────────────────

function cursorMcpPath(): string {
  return path.join(HOME, ".cursor", "mcp.json");
}

async function configureCursor(): Promise<ConfigureResult> {
  const mcpPath = cursorMcpPath();
  const cursorDir = path.join(HOME, ".cursor");
  if (!existsSync(cursorDir)) return { client: "Cursor", status: "not_installed" };

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(await readFile(mcpPath, "utf8")); } catch { /* ignore malformed */ }
  }
  config.mcpServers ??= {};
  if (config.mcpServers["hivelore"]) return { client: "Cursor", status: "already_configured" };

  if (isDeadLegacyCommand((config.mcpServers["haive"] as { command?: unknown } | undefined)?.command)) delete config.mcpServers["haive"];
  config.mcpServers["hivelore"] = HAIVE_MCP_ENTRY;
  await mkdir(cursorDir, { recursive: true });
  await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf8");
  return { client: "Cursor", status: "configured", path: mcpPath };
}

// ── VS Code ───────────────────────────────────────────────────────────────────

function vscodeMcpPath(): string | null {
  const candidates = [
    path.join(HOME, ".config", "Code", "User", "mcp.json"),         // Linux
    path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"), // macOS
    path.join(HOME, "AppData", "Roaming", "Code", "User", "mcp.json"),             // Windows
    path.join(HOME, ".config", "Code - Insiders", "User", "mcp.json"),
  ];
  // Return the first one whose *parent directory* exists
  for (const c of candidates) {
    if (existsSync(path.dirname(c))) return c;
  }
  return null;
}

async function configureVSCode(): Promise<ConfigureResult> {
  const mcpPath = vscodeMcpPath();
  if (!mcpPath) return { client: "VS Code", status: "not_installed" };

  let config: { servers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(await readFile(mcpPath, "utf8")); } catch { /* ignore */ }
  }
  config.servers ??= {};
  if (config.servers["hivelore"]) return { client: "VS Code", status: "already_configured" };

  if (isDeadLegacyCommand((config.servers["haive"] as { command?: unknown } | undefined)?.command)) delete config.servers["haive"];
  config.servers["hivelore"] = { ...HAIVE_MCP_ENTRY, type: "stdio" };
  await mkdir(path.dirname(mcpPath), { recursive: true });
  await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf8");
  return { client: "VS Code", status: "configured", path: mcpPath };
}

// ── Claude Code ───────────────────────────────────────────────────────────────

function claudeConfigPath(): string | null {
  const p = path.join(HOME, ".claude.json");
  if (existsSync(p)) return p;
  // Some versions put it here
  const p2 = path.join(HOME, ".config", "claude", "claude.json");
  if (existsSync(path.dirname(p2))) return p2;
  return null;
}

async function configureClaude(): Promise<ConfigureResult> {
  // Claude Code stores MCP servers in ~/.claude.json under mcpServers key
  const cfgPath = claudeConfigPath() ?? path.join(HOME, ".claude.json");
  if (!existsSync(cfgPath) && !existsSync(path.join(HOME, ".claude"))) {
    return { client: "Claude Code", status: "not_installed" };
  }

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(cfgPath)) {
    try { config = JSON.parse(await readFile(cfgPath, "utf8")); } catch { /* ignore */ }
  }
  config.mcpServers ??= {};
  if (config.mcpServers["hivelore"]) return { client: "Claude Code", status: "already_configured" };

  config.mcpServers["hivelore"] = { ...HAIVE_MCP_ENTRY, type: "stdio" };
  await writeFile(cfgPath, JSON.stringify(config, null, 2), "utf8");
  return { client: "Claude Code", status: "configured", path: cfgPath };
}

// ── Windsurf ─────────────────────────────────────────────────────────────────

function windsurfMcpPath(): string | null {
  const candidates = [
    path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    path.join(HOME, ".windsurf", "mcp.json"),
  ];
  for (const c of candidates) {
    if (existsSync(path.dirname(c))) return c;
  }
  return null;
}

async function configureWindsurf(): Promise<ConfigureResult> {
  const mcpPath = windsurfMcpPath();
  if (!mcpPath) return { client: "Windsurf", status: "not_installed" };

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(await readFile(mcpPath, "utf8")); } catch { /* ignore */ }
  }
  config.mcpServers ??= {};
  if (config.mcpServers["hivelore"]) return { client: "Windsurf", status: "already_configured" };

  if (isDeadLegacyCommand((config.mcpServers["haive"] as { command?: unknown } | undefined)?.command)) delete config.mcpServers["haive"];
  config.mcpServers["hivelore"] = HAIVE_MCP_ENTRY;
  await mkdir(path.dirname(mcpPath), { recursive: true });
  await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf8");
  return { client: "Windsurf", status: "configured", path: mcpPath };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ConfigureResult {
  client: string;
  status: "configured" | "already_configured" | "not_installed" | "error";
  path?: string;
  error?: string;
}

export async function autoConfigureMcpClients(): Promise<ConfigureResult[]> {
  const results: ConfigureResult[] = [];
  const configurators = [configureCursor, configureVSCode, configureClaude, configureWindsurf];
  for (const fn of configurators) {
    try {
      results.push(await fn());
    } catch (err) {
      const name = fn.name.replace("configure", "");
      results.push({ client: name, status: "error", error: String(err) });
    }
  }
  return results;
}

/** A user-scope MCP config file and the JSON key its servers live under. */
const USER_SCOPE_CONFIGS: Array<{ client: string; file: string; key: "mcpServers" | "servers" }> = [
  { client: "Claude Code (user)", file: path.join(HOME, ".claude.json"), key: "mcpServers" },
  { client: "Claude Code (user)", file: path.join(HOME, ".config", "claude", "claude.json"), key: "mcpServers" },
  { client: "Cursor (user)", file: path.join(HOME, ".cursor", "mcp.json"), key: "mcpServers" },
  { client: "Windsurf (user)", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
];

/** Legacy commands left by the haive → hivelore rename. They no longer exist on any PATH. */
function isDeadLegacyCommand(command: unknown): boolean {
  return typeof command === "string" && /(?:^|[\\/])haive(?:-mcp)?$/.test(command.trim());
}

export interface LegacyMcpSweepResult {
  client: string;
  path: string;
  /** Server keys removed from that file. */
  removed: string[];
  error?: string;
}

/**
 * Remove MCP entries left over from the `haive` → `hivelore` rename in USER-scope client configs.
 *
 * `hivelore init` has always written a correct project `.mcp.json`, so every report of "hivelore MCP
 * is unavailable" looked like a repo problem and was fixed as one — three times. The actual entry
 * lives in the user's global config, survives every reinstall, points at a binary that no longer
 * exists, and fails with `ENOENT: haive-mcp` at the start of every session in every project. Worse,
 * a stale `haive` key made the setup path report "already configured", so the tool skipped writing
 * the working one. An upgrade has to sweep BOTH scopes (field report 2026-09-04 §7.5).
 *
 * Only entries whose command is the dead binary are removed — a user who kept a working server under
 * the old name keeps it.
 */
/** Read-only counterpart of {@link sweepLegacyUserScopeMcpEntries} — reports without writing. */
export async function detectLegacyUserScopeMcpEntries(): Promise<LegacyMcpSweepResult[]> {
  const results: LegacyMcpSweepResult[] = [];
  for (const { client, file, key } of USER_SCOPE_CONFIGS) {
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const servers = config[key] as Record<string, { command?: unknown }> | undefined;
      if (!servers) continue;
      const removed = Object.entries(servers)
        .filter(([name, entry]) => name === "haive" && isDeadLegacyCommand(entry?.command))
        .map(([name]) => name);
      if (removed.length > 0) results.push({ client, path: file, removed });
    } catch {
      // A malformed user config is not this command's business to report.
    }
  }
  return results;
}

export async function sweepLegacyUserScopeMcpEntries(): Promise<LegacyMcpSweepResult[]> {
  const results: LegacyMcpSweepResult[] = [];
  for (const { client, file, key } of USER_SCOPE_CONFIGS) {
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const servers = config[key] as Record<string, { command?: unknown }> | undefined;
      if (!servers) continue;
      const removed = Object.entries(servers)
        .filter(([name, entry]) => name === "haive" && isDeadLegacyCommand(entry?.command))
        .map(([name]) => name);
      if (removed.length === 0) continue;
      for (const name of removed) delete servers[name];
      await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
      results.push({ client, path: file, removed });
    } catch (err) {
      results.push({ client, path: file, removed: [], error: String(err) });
    }
  }
  return results;
}

/**
 * Write project-level MCP configs that include HAIVE_PROJECT_ROOT so that
 * each AI client uses the correct project root regardless of the server's CWD.
 *
 * These files are machine-specific (absolute paths) and should be gitignored.
 * hivelore init appends them to .gitignore automatically.
 *
 * Project-level configs take precedence over user-level configs in Cursor and
 * VS Code when the workspace is opened. This is the canonical fix for the
 * "MCP server uses wrong project root in multi-project setups" bug.
 */
export async function configureProjectMcpClients(root: string): Promise<ConfigureResult[]> {
  const entry = projectMcpEntry(root);
  const results: ConfigureResult[] = [];

  // ── Cursor: <root>/.cursor/mcp.json ──────────────────────────────────────
  try {
    const cursorPath = path.join(root, ".cursor", "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(cursorPath)) {
      try { config = JSON.parse(await readFile(cursorPath, "utf8")); } catch { /* keep empty */ }
    }
    config.mcpServers ??= {};
    delete config.mcpServers["haive"]; // legacy key superseded by "hivelore"
    config.mcpServers["hivelore"] = entry;
    await mkdir(path.dirname(cursorPath), { recursive: true });
    await writeFile(cursorPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    results.push({ client: "Cursor (project)", status: "configured", path: cursorPath });
  } catch (err) {
    results.push({ client: "Cursor (project)", status: "error", error: String(err) });
  }

  // ── VS Code: <root>/.vscode/mcp.json ─────────────────────────────────────
  try {
    const vscodePath = path.join(root, ".vscode", "mcp.json");
    let config: { servers?: Record<string, unknown> } = {};
    if (existsSync(vscodePath)) {
      try { config = JSON.parse(await readFile(vscodePath, "utf8")); } catch { /* keep empty */ }
    }
    config.servers ??= {};
    delete config.servers["haive"]; // legacy key superseded by "hivelore"
    config.servers["hivelore"] = { ...entry, type: "stdio" };
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(vscodePath, JSON.stringify(config, null, 2) + "\n", "utf8");
    results.push({ client: "VS Code (workspace)", status: "configured", path: vscodePath });
  } catch (err) {
    results.push({ client: "VS Code (workspace)", status: "error", error: String(err) });
  }

  // ── Claude Code: <root>/.mcp.json ────────────────────────────────────────
  try {
    const mcpPath = path.join(root, ".mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpPath)) {
      try { config = JSON.parse(await readFile(mcpPath, "utf8")); } catch { /* keep empty */ }
    }
    config.mcpServers ??= {};
    delete config.mcpServers["haive"]; // legacy key superseded by "hivelore"
    config.mcpServers["hivelore"] = { ...entry, type: "stdio" };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    results.push({ client: "Claude Code (project)", status: "configured", path: mcpPath });
  } catch (err) {
    results.push({ client: "Claude Code (project)", status: "error", error: String(err) });
  }

  return results;
}
