import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import { CortexError, isRecord } from "./cortex-core.js";
import { errorMessage, isValidProjectName, safeProjectPath } from "./utils.js";

bootstrapCortexDotEnv();

export type InstallMode = "shared" | "project-local";
export type SyncMode = "managed-git" | "workspace-git";

export interface CortexRootManifest {
  version: 1;
  installMode: InstallMode;
  syncMode: SyncMode;
  workspaceRoot?: string;
  primaryProject?: string;
}

export interface InstallContext extends CortexRootManifest {
  cortexPath: string;
}

export const ROOT_MANIFEST_FILENAME = "cortex.root.yaml";

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
  return expandHomePath(process.env.CORTEX_PATH || homePath(".cortex"));
}

export function rootManifestPath(cortexPath: string): string {
  return path.join(cortexPath, ROOT_MANIFEST_FILENAME);
}

export function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function isInstallMode(value: unknown): value is InstallMode {
  return value === "shared" || value === "project-local";
}

function isSyncMode(value: unknown): value is SyncMode {
  return value === "managed-git" || value === "workspace-git";
}

function normalizeManifest(raw: unknown): CortexRootManifest | null {
  if (!isRecord(raw)) return null;
  const version = Number(raw.version);
  const installMode = raw.installMode;
  const syncMode = raw.syncMode;
  if (version !== 1 || !isInstallMode(installMode) || !isSyncMode(syncMode)) return null;

  const workspaceRoot = typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim()
    ? path.resolve(expandHomePath(raw.workspaceRoot))
    : undefined;
  const primaryProject = typeof raw.primaryProject === "string" && raw.primaryProject.trim()
    ? raw.primaryProject.trim()
    : undefined;

  if (installMode === "project-local") {
    if (!workspaceRoot || !primaryProject || !isValidProjectName(primaryProject)) return null;
  }

  return {
    version: 1,
    installMode,
    syncMode,
    workspaceRoot,
    primaryProject,
  };
}

export function readRootManifest(cortexPath: string): CortexRootManifest | null {
  const manifestFile = rootManifestPath(cortexPath);
  if (!fs.existsSync(manifestFile)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(manifestFile, "utf8"), { schema: yaml.CORE_SCHEMA });
    return normalizeManifest(parsed);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readRootManifest: ${errorMessage(err)}\n`);
    return null;
  }
}

export function writeRootManifest(cortexPath: string, manifest: CortexRootManifest): void {
  const normalized = normalizeManifest(manifest);
  if (!normalized) {
    throw new Error(`${CortexError.VALIDATION_ERROR}: invalid cortex root manifest for ${cortexPath}`);
  }
  atomicWriteText(rootManifestPath(cortexPath), yaml.dump(normalized, { lineWidth: 1000 }));
}

export function resolveInstallContext(cortexPath: string): InstallContext {
  const resolvedPath = path.resolve(cortexPath);
  const manifest = readRootManifest(resolvedPath);
  if (!manifest) {
    throw new Error(`${CortexError.NOT_FOUND}: cortex root manifest not found: ${rootManifestPath(resolvedPath)}`);
  }
  return { cortexPath: resolvedPath, ...manifest };
}

function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    throw new Error(`${CortexError.NOT_FOUND}: ${label} not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${CortexError.VALIDATION_ERROR}: ${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

function hasRootManifest(candidate: string): boolean {
  return fs.existsSync(rootManifestPath(candidate));
}

function hasInstallMarkers(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "machines.yaml"))
    || fs.existsSync(path.join(candidate, ".governance"))
    || fs.existsSync(path.join(candidate, "global"));
}

function isCortexRootCandidate(candidate: string): boolean {
  return hasRootManifest(candidate) || hasInstallMarkers(candidate);
}

export function findNearestCortexPath(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const localCandidate = path.join(current, ".cortex");
    if (isCortexRootCandidate(localCandidate)) return localCandidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function sharedRootCandidate(): string {
  return homePath(".cortex");
}

let cachedCortexPath: string | null | undefined;
let cachedCortexPathKey: string | undefined;

export function findCortexPath(): string | null {
  const cacheKey = [
    process.env.CORTEX_PATH ?? "",
    process.env.HOME ?? "",
    process.env.USERPROFILE ?? "",
    process.cwd(),
  ].join("|");
  if (cachedCortexPath !== undefined && cachedCortexPathKey === cacheKey) return cachedCortexPath;
  cachedCortexPathKey = cacheKey;

  const envVal = process.env.CORTEX_PATH?.trim();
  if (envVal) {
    const resolved = path.resolve(expandHomePath(envVal));
    cachedCortexPath = isCortexRootCandidate(resolved) ? resolved : null;
    return cachedCortexPath;
  }

  const nearest = findNearestCortexPath();
  if (nearest) {
    cachedCortexPath = nearest;
    return nearest;
  }

  const shared = sharedRootCandidate();
  cachedCortexPath = isCortexRootCandidate(shared) ? shared : null;
  return cachedCortexPath;
}

export function ensureCortexPath(): string {
  const existing = findCortexPath();
  if (existing) return existing;
  const defaultPath = sharedRootCandidate();
  fs.mkdirSync(defaultPath, { recursive: true });
  writeRootManifest(defaultPath, {
    version: 1,
    installMode: "shared",
    syncMode: "managed-git",
  });
  cachedCortexPath = defaultPath;
  cachedCortexPathKey = [
    process.env.CORTEX_PATH ?? "",
    process.env.HOME ?? "",
    process.env.USERPROFILE ?? "",
    process.cwd(),
  ].join("|");
  return defaultPath;
}

export function findCortexPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = requireDirectory(path.resolve(expandHomePath(arg)), "cortex path");
    if (!hasRootManifest(resolved)) {
      throw new Error(`${CortexError.NOT_FOUND}: cortex root manifest not found: ${rootManifestPath(resolved)}`);
    }
    return resolved;
  }
  const existing = findCortexPath();
  if (existing) return existing;
  throw new Error(`${CortexError.NOT_FOUND}: cortex root not found. Run 'npx cortex init'.`);
}

export function isProjectLocalMode(cortexPath: string): boolean {
  try {
    return resolveInstallContext(cortexPath).installMode === "project-local";
  } catch {
    return false;
  }
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

// Debug logging is best-effort and only writes when a cortex root already exists.
export function debugLog(msg: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  const cortexPath = findCortexPath();
  if (!cortexPath) return;
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
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendIndexEvent: ${errorMessage(err)}\n`);
  }
}

/** Resolve the canonical findings file for a project directory. */
export function resolveFindingsPath(projectDir: string): string | undefined {
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (fs.existsSync(findingsPath)) return findingsPath;
  return undefined;
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

function getLocalProjectDirs(cortexPath: string, manifest: CortexRootManifest): string[] {
  const primaryProject = manifest.primaryProject;
  if (!primaryProject || !isValidProjectName(primaryProject)) return [];
  const projectPath = safeProjectPath(cortexPath, primaryProject);
  if (!projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) return [];
  const visible = fs.readdirSync(cortexPath, { withFileTypes: true }).filter(isProjectDirEntry).map((entry) => entry.name);
  if (visible.length !== 1 || visible[0] !== primaryProject) return [];
  return [projectPath];
}

// Figure out which project directories to index.
export function getProjectDirs(cortexPath: string, profile?: string): string[] {
  const manifest = readRootManifest(cortexPath);
  if (manifest?.installMode === "project-local") {
    return getLocalProjectDirs(cortexPath, manifest);
  }

  if (profile) {
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

  try {
    return fs.readdirSync(cortexPath, { withFileTypes: true })
      .filter(isProjectDirEntry)
      .map((entry) => path.join(cortexPath, entry.name));
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] getProjectDirs: ${errorMessage(err)}\n`);
    return [];
  }
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
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
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
  const manifest = readRootManifest(cortexPath);

  for (const projectDir of projectDirs) {
    const project = path.basename(projectDir);
    parts.push(`project:${project}`);
    for (const file of ["CLAUDE.md", "summary.md", "FINDINGS.md", "tasks.md", "MEMORY_QUEUE.md", "CANONICAL_MEMORIES.md", "topic-config.json", "cortex.project.yaml"]) {
      pushFileToken(parts, path.join(projectDir, file));
    }
    pushDirTokens(parts, path.join(projectDir, "reference"));
    pushDirTokens(parts, path.join(projectDir, "skills"));
    pushDirTokens(parts, path.join(projectDir, ".claude", "skills"));
  }

  if (manifest?.installMode === "shared") {
    pushDirTokens(parts, path.join(cortexPath, "profiles"));
  }
  pushDirTokens(parts, path.join(cortexPath, "global", "skills"));
  pushFileToken(parts, path.join(cortexPath, ".governance", "access-control.json"));
  pushFileToken(parts, rootManifestPath(cortexPath));
  pushFileToken(parts, runtimeHealthFile(cortexPath));
  pushFileToken(parts, runtimeFile(cortexPath, "audit.log"));
  pushFileToken(parts, memoryUsageLogFile(cortexPath));
  pushFileToken(parts, installPreferencesFile(cortexPath));

  if (manifest?.installMode === "shared") {
    pushDirTokens(parts, homePath(".github", "hooks"));
    pushFileToken(parts, homePath(".cursor", "hooks.json"));
  }

  return parts.sort().join("|");
}

// Lazy singleton for getCortexPath — shared across all CLI modules.
let lazyCortexPath: string | undefined;
export function getCortexPath(): string {
  if (!lazyCortexPath) {
    const existing = findCortexPath();
    if (!existing) throw new Error(`${CortexError.NOT_FOUND}: cortex root not found. Run 'npx cortex init'.`);
    lazyCortexPath = existing;
  }
  return lazyCortexPath;
}

export function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: runtimeFile(cortexPathLocal, `quality-${today}`),
    lock: runtimeFile(cortexPathLocal, `quality-${today}.lock`),
  };
}
