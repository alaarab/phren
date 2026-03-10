import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import { CortexError, isRecord } from "./cortex-core.js";
import { errorMessage, isValidProjectName, safeProjectPath } from "./utils.js";

bootstrapCortexDotEnv();

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

// Centralized runtime path helpers. All ephemeral/runtime files go in
// subdirectories to keep the cortex root clean.
export function runtimeDir(cortexPath: string): string {
  return path.join(cortexPath, ".runtime");
}

/** Unlink a file, ignoring ENOENT. Rethrows any other error. */
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
  const dir = runtimeDir(cortexPath);
  if (!runtimeDirsMade.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    runtimeDirsMade.add(dir);
  }
  return path.join(dir, name);
}

export function installPreferencesFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "install-preferences.json");
}

export function runtimeHealthFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "runtime-health.json");
}

export function canonicalLocksFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "canonical-locks.json");
}

export function shellStateFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "shell-state.json");
}

export function sessionMetricsFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "session-metrics.json");
}

export function memoryScoresFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "memory-scores.json");
}

export function memoryUsageLogFile(cortexPath: string): string {
  return path.join(runtimeDir(cortexPath), "memory-usage.log");
}

export function sessionMarker(cortexPath: string, name: string): string {
  const dir = sessionsDir(cortexPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// Debug logger - writes to ~/.cortex/.runtime/debug.log when CORTEX_DEBUG=1
export function debugLog(msg: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  const cortexPath = defaultCortexPath();
  const logFile = runtimeFile(cortexPath, "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // debug log is best-effort; logging errors about logging would recurse
  }
}

export function appendIndexEvent(cortexPath: string, event: Record<string, unknown>): void {
  try {
    const file = runtimeFile(cortexPath, "index-events.jsonl");
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err: unknown) {
    // Observability should not break the indexer.
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendIndexEvent: ${errorMessage(err)}\n`);
  }
}

/** Resolve the canonical findings file for a project directory. */
export function resolveFindingsPath(projectDir: string): string | undefined {
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (fs.existsSync(findingsPath)) return findingsPath;
  return undefined;
}

// Validate that a path is a safe, existing directory
function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    throw new Error(`${CortexError.NOT_FOUND}: ${label} not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${CortexError.VALIDATION_ERROR}: ${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

// Pure lookup: find an existing cortex root directory, returns null if none found
// Priority: CORTEX_PATH env > ~/.cortex > ~/cortex
// Memoized: keyed on CORTEX_PATH+HOME so test overrides are respected.
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
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findCortexPath stat: ${errorMessage(err)}\n`);
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

// Find or create the cortex root directory (creates ~/.cortex on first run)
export function ensureCortexPath(): string {
  const existing = findCortexPath();
  if (existing) return existing;
  const defaultPath = homePath(".cortex");
  fs.mkdirSync(defaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(defaultPath, "README.md"),
    `# My Cortex\n\nThis is your personal project store. Each subdirectory is a project.\n\nGet started:\n\n\`\`\`bash\nmkdir my-project\ncd my-project\ntouch CLAUDE.md summary.md FINDINGS.md backlog.md\n\`\`\`\n\nOr run \`/cortex:init my-project\` in Claude Code to scaffold one.\n\nPush this directory to a private GitHub repo to sync across machines.\n`
  );
  cachedCortexPathKey = `${process.env.CORTEX_PATH ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
  cachedCortexPath = defaultPath;
  console.error("Created ~/.cortex");
  return defaultPath;
}

// Resolve the cortex path from an explicit argument (used by MCP mode)
export function findCortexPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = expandHomePath(arg);
    return requireDirectory(resolved, "cortex path");
  }
  return ensureCortexPath();
}

const RESERVED_PROJECT_DIR_NAMES = new Set(["profiles", "templates", "global"]);

function isProjectDirEntry(entry: fs.Dirent): boolean {
  return entry.isDirectory()
    && !entry.name.startsWith(".")
    && !entry.name.endsWith(".archived")
    && !RESERVED_PROJECT_DIR_NAMES.has(entry.name);
}

export function normalizeProjectNameForCreate(name: string): string {
  return name.trim().toLowerCase();
}

export function findProjectNameCaseInsensitive(cortexPath: string, name: string): string | null {
  const needle = name.toLowerCase();
  try {
    for (const entry of fs.readdirSync(cortexPath, { withFileTypes: true })) {
      if (!isProjectDirEntry(entry)) continue;
      if (entry.name.toLowerCase() === needle) return entry.name;
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findProjectNameCaseInsensitive: ${errorMessage(err)}\n`);
  }
  return null;
}

// Figure out which project directories to index
export function getProjectDirs(cortexPath: string, profile?: string): string[] {
  if (profile) {
    // Q18: when a profile is explicitly set, fail closed — never widen to all projects.
    // If the profile file is missing or malformed we return [] rather than leaking
    // unrelated projects into the caller's view.
    if (!isValidProjectName(profile)) {
      console.error(`${CortexError.VALIDATION_ERROR}: Invalid CORTEX_PROFILE value: ${profile}`);
      return [];
    }
    const profilePath = path.join(cortexPath, "profiles", `${profile}.yaml`);
    if (!fs.existsSync(profilePath)) {
      console.error(`${CortexError.FILE_NOT_FOUND}: Profile file not found: ${profilePath}`);
      return [];
    }
    try {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8"), { schema: yaml.CORE_SCHEMA });
      const projects = isRecord(data) ? data.projects : undefined;
      if (!Array.isArray(projects)) {
        console.error(`${CortexError.MALFORMED_YAML}: Profile YAML missing valid "projects" array: ${profilePath}`);
        return [];
      }
      const listed = projects
        .map((p: unknown) => {
          const name = String(p);
          if (!isValidProjectName(name)) {
            console.error(`${CortexError.VALIDATION_ERROR}: Skipping invalid project name in profile: ${name}`);
            return null;
          }
          return safeProjectPath(cortexPath, name);
        })
        .filter((p): p is string => p !== null && fs.existsSync(p));

      // Shared spaces are always visible when present.
      const sharedDirs = ["shared", "org"]
        .map((name) => safeProjectPath(cortexPath, name))
        .filter((p): p is string => Boolean(p && fs.existsSync(p) && fs.statSync(p).isDirectory()));

      return [...new Set([...listed, ...sharedDirs])];
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] getProjectDirs yamlParse: ${errorMessage(err)}\n`);
      console.error(`${CortexError.MALFORMED_YAML}: Malformed profile YAML: ${profilePath}`);
      return [];
    }
  }

  return fs.readdirSync(cortexPath, { withFileTypes: true })
    .filter(isProjectDirEntry)
    .map((entry) => path.join(cortexPath, entry.name));
}

// Collect MEMORY*.md files from native agent memory locations (~/.claude/projects/*/memory/)
export function collectNativeMemoryFiles(): Array<{ project: string; file: string; fullPath: string }> {
  const claudeProjectsDir = homePath(".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const results: Array<{ project: string; file: string; fullPath: string }> = [];
  try {
    for (const entry of fs.readdirSync(claudeProjectsDir)) {
      const memDir = path.join(claudeProjectsDir, entry, "memory");
      if (!fs.existsSync(memDir)) continue;
      for (const file of fs.readdirSync(memDir)) {
        if (!file.endsWith(".md")) continue;
        if (file === "MEMORY.md") continue;
        const fullPath = path.join(memDir, file);
        const match = file.match(/^MEMORY-(.+)\.md$/);
        const project = match ? match[1] : `native:${entry}`;
        results.push({ project, file, fullPath });
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] collectNativeMemoryFiles: ${errorMessage(err)}\n`);
  }
  return results;
}

function pushFileToken(parts: string[], filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) parts.push(`${filePath}:${stat.mtimeMs}:${stat.size}`);
  } catch {
    parts.push(`${filePath}:missing`);
  }
}

function pushDirTokens(parts: string[], dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    parts.push(`${dirPath}:missing`);
    return;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      pushDirTokens(parts, fullPath);
      continue;
    }
    const stat = fs.statSync(fullPath);
    parts.push(`${fullPath}:${stat.mtimeMs}:${stat.size}`);
  }
}

export function computeCortexLiveStateToken(cortexPath: string): string {
  const parts: string[] = [];
  const projectDirs = getProjectDirs(cortexPath).sort();

  for (const projectDir of projectDirs) {
    const project = path.basename(projectDir);
    parts.push(`project:${project}`);
    for (const file of ["CLAUDE.md", "summary.md", "FINDINGS.md", "backlog.md", "MEMORY_QUEUE.md", "CANONICAL_MEMORIES.md"]) {
      pushFileToken(parts, path.join(projectDir, file));
    }
    pushDirTokens(parts, path.join(projectDir, "skills"));
    pushDirTokens(parts, path.join(projectDir, ".claude", "skills"));
  }

  pushDirTokens(parts, path.join(cortexPath, "profiles"));
  pushDirTokens(parts, path.join(cortexPath, "global", "skills"));
  pushFileToken(parts, path.join(cortexPath, ".governance", "access-control.json"));
  pushFileToken(parts, runtimeHealthFile(cortexPath));
  pushFileToken(parts, runtimeFile(cortexPath, "audit.log"));
  pushFileToken(parts, memoryUsageLogFile(cortexPath));
  pushFileToken(parts, installPreferencesFile(cortexPath));

  pushDirTokens(parts, homePath(".github", "hooks"));
  pushFileToken(parts, homePath(".cursor", "hooks.json"));

  return parts.sort().join("|");
}

// Lazy singleton for getCortexPath — shared across all CLI modules.
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
