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
const MCP_ENTRYPOINT_RELATIVE_PATH = path.join("mcp", "dist", "index.js");

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

function detectMcpServerPath(): string | undefined {
  const candidates = new Set<string>();
  const envCandidate = normalizeConfiguredPath(process.env.PHREN_MCP_SERVER_PATH ?? process.env.PHREN_MCP_SERVER_PATH);
  if (envCandidate) {
    candidates.add(envCandidate);
  }

  const globalNodeModules = runCommand("npm", ["root", "-g"]);
  if (globalNodeModules) {
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(globalNodeModules, packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  const phrenBinaryPath = runCommand("which", ["phren"]) ?? runCommand("which", ["phren"]);
  if (phrenBinaryPath) {
    const resolvedBinaryPath = safeRealpath(phrenBinaryPath);
    const prefixPath = path.resolve(path.dirname(resolvedBinaryPath), "..");
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(prefixPath, "lib", "node_modules", packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  candidates.add(path.resolve(__dirname, "..", "..", "mcp", "dist", "index.js"));

  // Fallback: extract path from Claude Code or VS Code MCP config files
  const mcpConfigFiles = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".vscode-server", "data", "User", "mcp.json"),
  ];
  for (const configFile of mcpConfigFiles) {
    const mcpPath = extractPhrenPathFromMcpConfig(configFile);
    if (mcpPath) {
      candidates.add(mcpPath);
    }
  }

  // Fallback: scan npx cache for @phren/cli (most recently modified first)
  const npxCacheDir = path.join(os.homedir(), ".npm", "_npx");
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
