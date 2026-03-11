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

const PACKAGE_NAMES = ["@alaarab/cortex", "cortex"];
const MCP_ENTRYPOINT_RELATIVE_PATH = path.join("mcp", "dist", "index.js");

export function resolveRuntimeConfig(config: ConfigSource): ResolvedRuntimeConfig {
  const nodePath = normalizeCommandPath(config.get<string>("nodePath", "node")) ?? "node";
  const configuredMcpServerPath = normalizeConfiguredPath(config.get<string>("mcpServerPath", ""));
  const storePath = normalizeConfiguredPath(config.get<string>("storePath", "")) ?? path.join(os.homedir(), ".cortex");

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
  const envCandidate = normalizeConfiguredPath(process.env.CORTEX_MCP_SERVER_PATH);
  if (envCandidate) {
    candidates.add(envCandidate);
  }

  const globalNodeModules = runCommand("npm", ["root", "-g"]);
  if (globalNodeModules) {
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(globalNodeModules, packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  const cortexBinaryPath = runCommand("which", ["cortex"]);
  if (cortexBinaryPath) {
    const resolvedBinaryPath = safeRealpath(cortexBinaryPath);
    const prefixPath = path.resolve(path.dirname(resolvedBinaryPath), "..");
    for (const packageName of PACKAGE_NAMES) {
      candidates.add(path.join(prefixPath, "lib", "node_modules", packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
    }
  }

  candidates.add(path.resolve(__dirname, "..", "..", "mcp", "dist", "index.js"));

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
