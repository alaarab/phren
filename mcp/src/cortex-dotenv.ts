import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let _loadedEnvKey: string | undefined;
let _loadedEnvPath: string | null = null;
let _loadedEnvMtimeMs = -1;

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function parseAndApplyDotEnv(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    const value = /^(["'])(.*)\1$/.test(raw) ? raw.slice(1, -1) : raw;
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

function resolveDotEnvPath(cortexPath?: string): string | null {
  const candidates = [
    cortexPath ? path.join(cortexPath, ".env") : null,
    process.env.CORTEX_PATH ? path.join(process.env.CORTEX_PATH, ".env") : null,
    path.join(homeDir(), ".cortex", ".env"),
    path.join(homeDir(), "cortex", ".env"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function bootstrapCortexDotEnv(cortexPath?: string): string | null {
  const cacheKey = `${cortexPath ?? ""}|${process.env.CORTEX_PATH ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
  const envPath = resolveDotEnvPath(cortexPath);
  if (!envPath) {
    _loadedEnvKey = cacheKey;
    _loadedEnvPath = null;
    _loadedEnvMtimeMs = -1;
    return null;
  }

  const mtimeMs = fs.statSync(envPath).mtimeMs;
  if (_loadedEnvKey === cacheKey && _loadedEnvPath === envPath && _loadedEnvMtimeMs === mtimeMs) {
    return envPath;
  }

  parseAndApplyDotEnv(envPath);
  _loadedEnvKey = cacheKey;
  _loadedEnvPath = envPath;
  _loadedEnvMtimeMs = mtimeMs;
  return envPath;
}

export function resetCortexDotEnvBootstrapForTests(): void {
  _loadedEnvKey = undefined;
  _loadedEnvPath = null;
  _loadedEnvMtimeMs = -1;
}
