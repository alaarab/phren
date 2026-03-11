import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";

bootstrapCortexDotEnv();

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function homePath(...parts: string[]): string {
  return path.join(homeDir(), ...parts);
}

export function expandHomePath(input: string): string {
  if (input === "~") return homeDir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homeDir(), input.slice(2));
  return input;
}

export function defaultCortexPath(): string {
  return process.env.CORTEX_PATH || homePath(".cortex");
}

export function runtimeDir(cortexPath: string): string {
  return path.join(cortexPath, ".runtime");
}

export function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function sessionsDir(cortexPath: string): string {
  return path.join(cortexPath, ".sessions");
}

const runtimeDirsMade = new Set<string>();
export function runtimeFile(cortexPath: string, name: string): string {
  const dir = path.join(cortexPath, ".runtime");
  if (!runtimeDirsMade.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    runtimeDirsMade.add(dir);
  }
  return path.join(dir, name);
}

export function sessionMarker(cortexPath: string, name: string): string {
  const dir = sessionsDir(cortexPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

export function debugLog(msg: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  const cortexPath = defaultCortexPath();
  const logFile = runtimeFile(cortexPath, "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Debug logging is best effort.
  }
}

export function appendIndexEvent(cortexPath: string, event: Record<string, unknown>): void {
  try {
    const file = runtimeFile(cortexPath, "index-events.jsonl");
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendIndexEvent: ${formatError(err)}\n`);
  }
}

function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    throw new Error(`NOT_FOUND: ${label} not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`VALIDATION_ERROR: ${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

let cachedCortexPath: string | null | undefined;
let cachedCortexPathKey: string | undefined;
export function findCortexPath(): string | null {
  const envVal = process.env.CORTEX_PATH;
  const cacheKey = `${envVal ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
  if (cachedCortexPath !== undefined && cachedCortexPathKey === cacheKey) return cachedCortexPath;
  cachedCortexPathKey = cacheKey;
  if (envVal) {
    try {
      cachedCortexPath = fs.statSync(envVal).isDirectory() ? envVal : null;
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findCortexPath stat: ${formatError(err)}\n`);
      cachedCortexPath = null;
    }
    return cachedCortexPath;
  }
  for (const name of [".cortex", "cortex"]) {
    const candidate = homePath(name);
    if (fs.existsSync(candidate)) {
      cachedCortexPath = candidate;
      return candidate;
    }
  }
  cachedCortexPath = null;
  return null;
}

export function ensureCortexPath(): string {
  const existing = findCortexPath();
  if (existing) return existing;
  const defaultPath = homePath(".cortex");
  fs.mkdirSync(defaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(defaultPath, "README.md"),
    `# My Cortex\n\nThis is your personal project store. Each subdirectory is a project.\n\nGet started:\n\n\`\`\`bash\nmkdir my-project\ncd my-project\ntouch CLAUDE.md summary.md FINDINGS.md tasks.md\n\`\`\`\n\nOr run \`cortex:init my-project\` in Claude Code to scaffold one.\n\nPush this directory to a private GitHub repo to sync across machines.\n`
  );
  cachedCortexPathKey = `${process.env.CORTEX_PATH ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
  cachedCortexPath = defaultPath;
  console.error("Created ~/.cortex");
  return defaultPath;
}

export function findCortexPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = expandHomePath(arg);
    return requireDirectory(resolved, "cortex path");
  }
  return ensureCortexPath();
}

export function collectNativeMemoryFiles(): Array<{ project: string; file: string; fullPath: string }> {
  const claudeProjectsDir = homePath(".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const results: Array<{ project: string; file: string; fullPath: string }> = [];
  try {
    for (const entry of fs.readdirSync(claudeProjectsDir)) {
      const memDir = path.join(claudeProjectsDir, entry, "memory");
      if (!fs.existsSync(memDir)) continue;
      for (const file of fs.readdirSync(memDir)) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        const fullPath = path.join(memDir, file);
        const match = file.match(/^MEMORY-(.+)\.md$/);
        const project = match ? match[1] : `native:${entry}`;
        results.push({ project, file, fullPath });
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] collectNativeMemoryFiles: ${formatError(err)}\n`);
  }
  return results;
}

let lazyCortexPath: string | undefined;
export function getCortexPath(): string {
  if (!lazyCortexPath) lazyCortexPath = ensureCortexPath();
  return lazyCortexPath;
}

export function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: runtimeFile(cortexPathLocal, `quality-${today}`),
    lock: runtimeFile(cortexPathLocal, `quality-${today}.lock`),
  };
}
