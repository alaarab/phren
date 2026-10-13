import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface ConfigSource {
  get<T>(section: string, defaultValue?: T): T;
}

export interface ResolvedRuntimeConfig {
  configuredMcpServerPath?: string;
  detectedMcpServerPath?: string;
  mcpServerPath?: string;
  nodePath: string;
  storePath: string;
}

const PACKAGE_NAMES = ["@phren/cli", "phren"];
const MCP_ENTRYPOINT_RELATIVE_PATH = path.join("dist", "index.js");

export function resolveRuntimeConfig(config: ConfigSource): ResolvedRuntimeConfig {
  const nodePath = normalizeCommandPath(config.get<string>("nodePath", "node")) ?? "node";
  const configuredMcpServerPath = normalizeConfiguredPath(config.get<string>("mcpServerPath", ""));
  const storePath = normalizeConfiguredPath(config.get<string>("storePath", "")) ?? path.join(os.homedir(), ".phren");

  if (configuredMcpServerPath) {
    return {
      configuredMcpServerPath,
      mcpServerPath: configuredMcpServerPath,
      nodePath,
      storePath,
    };
  }

  const detectedMcpServerPath = detectMcpServerPath();
  return {
    detectedMcpServerPath,
    mcpServerPath: detectedMcpServerPath,
    nodePath,
    storePath,
  };
}

export function pathExists(targetPath: string | undefined): boolean {
  return Boolean(targetPath && fs.existsSync(targetPath));
}

export interface RuntimePathCheck {
  ok: boolean;
  missing: Array<"mcpServer" | "store">;
  /** Names what is missing and where it was looked for, or "" when nothing is. */
  message: string;
}

/**
 * Before spawning the MCP server, confirm the entry file and store directory
 * are actually there. A missing path otherwise shows up only as an empty tree
 * and a crashed graph; this turns it into one message naming the gap.
 */
export function checkRuntimePaths(
  runtime: ResolvedRuntimeConfig,
  options: { remote?: boolean } = {},
): RuntimePathCheck {
  const missing: Array<"mcpServer" | "store"> = [];
  const descriptions: string[] = [];

  if (!isFile(runtime.mcpServerPath)) {
    missing.push("mcpServer");
    descriptions.push(
      runtime.mcpServerPath
        ? `the MCP server file at ${runtime.mcpServerPath}`
        : "an MCP server file (no phren.mcpServerPath is set, and auto-detection found none in the MCP config files, npm/npx caches, or PATH)",
    );
  }

  if (!isDirectory(runtime.storePath)) {
    missing.push("store");
    descriptions.push(`the store directory at ${runtime.storePath}`);
  }

  if (missing.length === 0) {
    return { ok: true, missing, message: "" };
  }

  const hints: string[] = [];
  if (missing.includes("mcpServer")) {
    hints.push("Set phren.mcpServerPath to phren's dist/index.js, or run 'npx @phren/cli init'.");
  }
  if (missing.includes("store")) {
    hints.push("Set phren.storePath, or run 'phren init' to create a store.");
  }
  const remoteNote = options.remote
    ? " This extension runs on the workspace side, so it checked the Remote/WSL filesystem, not your local machine."
    : "";

  return {
    ok: false,
    missing,
    message: `Phren can't start because ${joinNatural(descriptions)} ${
      missing.length > 1 ? "are" : "is"
    } missing.${remoteNote} ${hints.join(" ")}`,
  };
}

/** Path to the `phren` CLI when it is on PATH, for offering "Run phren doctor". */
export function phrenBinaryPath(): string | undefined {
  const whichCmd = process.platform === "win32" ? "where.exe" : "which";
  return runCommand(whichCmd, ["phren"]);
}

function isFile(targetPath: string | undefined): boolean {
  if (!targetPath) {
    return false;
  }
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(targetPath: string | undefined): boolean {
  if (!targetPath) {
    return false;
  }
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function detectMcpServerPath(): string | undefined {
  const candidates = new Set<string>();
  const envCandidate = normalizeConfiguredPath(process.env.PHREN_MCP_SERVER_PATH ?? process.env.PHREN_MCP_PATH);
  if (envCandidate) {
    candidates.add(envCandidate);
  }

  const globalNodeModules = runCommand("npm", ["root", "-g"]);
  if (globalNodeModules) {
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(globalNodeModules, packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  const phrenPath = phrenBinaryPath();
  if (phrenPath) {
    const resolvedBinaryPath = safeRealpath(phrenPath);
    const prefixPath = path.resolve(path.dirname(resolvedBinaryPath), "..");
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(prefixPath, "lib", "node_modules", packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  candidates.add(path.resolve(__dirname, "..", "..", "dist", "index.js"));

  // Fallback: extract path from Claude Code or VS Code MCP config files
  const mcpConfigFiles = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".vscode-server", "data", "User", "mcp.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "mcp.json"),
  ];
  for (const configFile of mcpConfigFiles) {
    const mcpPath = extractPhrenPathFromMcpConfig(configFile);
    if (mcpPath) {
      candidates.add(mcpPath);
    }
  }

  // Fallback: scan npx cache for @phren/cli (most recently modified first)
  // Windows: %APPDATA%/npm-cache/_npx/ or %LOCALAPPDATA%/npm-cache/_npx/
  // Linux/Mac: ~/.npm/_npx/
  const npxCacheDirs: string[] = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      npxCacheDirs.push(path.join(process.env.APPDATA, "npm-cache", "_npx"));
    }
    if (process.env.LOCALAPPDATA) {
      npxCacheDirs.push(path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx"));
    }
  } else {
    npxCacheDirs.push(path.join(os.homedir(), ".npm", "_npx"));
  }
  for (const npxCacheDir of npxCacheDirs) {
    try {
      const hashes = fs.readdirSync(npxCacheDir)
        .map((name) => ({ name, mtime: safeStat(path.join(npxCacheDir, name))?.mtimeMs ?? 0 }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { name } of hashes) {
        candidates.add(path.join(npxCacheDir, name, "node_modules", "@phren/cli", MCP_ENTRYPOINT_RELATIVE_PATH));
      }
    } catch {
      // npx cache dir doesn't exist — skip
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeConfiguredPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "~") {
    return os.homedir();
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

function normalizeCommandPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.includes("/") || trimmed.includes("\\")) {
    return normalizeConfiguredPath(trimmed);
  }

  return trimmed;
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

function extractPhrenPathFromMcpConfig(configFile: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(configFile, "utf8");
  } catch {
    // File doesn't exist — skip
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[phren] Failed to parse MCP config ${configFile}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }

  // Claude Code uses mcpServers.phren, VS Code MCP uses servers.phren
  const phrenEntry = (parsed?.mcpServers as Record<string, unknown>)?.phren ?? (parsed?.servers as Record<string, unknown>)?.phren;
  const args: unknown[] = (phrenEntry as Record<string, unknown>)?.args as unknown[];
  if (Array.isArray(args)) {
    // args[0] is the path to index.js — normalize ~/... and relative paths
    const candidate = typeof args[0] === "string" ? normalizeConfiguredPath(args[0]) : undefined;
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function safeStat(targetPath: string): fs.Stats | undefined {
  try {
    return fs.statSync(targetPath);
  } catch {
    return undefined;
  }
}

function runCommand(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return undefined;
    }
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stdout || undefined;
  } catch {
    return undefined;
  }
}
