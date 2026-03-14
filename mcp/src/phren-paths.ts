import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import { bootstrapPhrenDotEnv } from "./phren-dotenv.js";
import { PhrenError, isRecord } from "./phren-core.js";
import { errorMessage, isValidProjectName, safeProjectPath } from "./utils.js";

bootstrapPhrenDotEnv();

export type InstallMode = "shared" | "project-local";
export type SyncMode = "managed-git" | "workspace-git";

export interface PhrenRootManifest {
  version: 1;
  installMode: InstallMode;
  syncMode: SyncMode;
  workspaceRoot?: string;
  primaryProject?: string;
}

export interface InstallContext extends PhrenRootManifest {
  phrenPath: string;
}

export const ROOT_MANIFEST_FILENAME = "phren.root.yaml";

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

export function defaultPhrenPath(): string {
  return expandHomePath(process.env.PHREN_PATH || homePath(".phren"));
}

export function rootManifestPath(phrenPath: string): string {
  return path.join(phrenPath, ROOT_MANIFEST_FILENAME);
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

function normalizeManifest(raw: unknown): PhrenRootManifest | null {
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

export function readRootManifest(phrenPath: string): PhrenRootManifest | null {
  const manifestFile = rootManifestPath(phrenPath);
  if (!fs.existsSync(manifestFile)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(manifestFile, "utf8"), { schema: yaml.CORE_SCHEMA });
    return normalizeManifest(parsed);
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] readRootManifest: ${errorMessage(err)}\n`);
    return null;
  }
}

export function writeRootManifest(phrenPath: string, manifest: PhrenRootManifest): void {
  const normalized = normalizeManifest(manifest);
  if (!normalized) {
    throw new Error(`${PhrenError.VALIDATION_ERROR}: invalid phren root manifest for ${phrenPath}`);
  }
  atomicWriteText(rootManifestPath(phrenPath), yaml.dump(normalized, { lineWidth: 1000 }));
}

export function resolveInstallContext(phrenPath: string): InstallContext {
  const resolvedPath = path.resolve(phrenPath);
  const manifest = readRootManifest(resolvedPath);
  if (!manifest) {
    throw new Error(`${PhrenError.NOT_FOUND}: phren root manifest not found: ${rootManifestPath(resolvedPath)}`);
  }
  return { phrenPath: resolvedPath, ...manifest };
}

function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    throw new Error(`${PhrenError.NOT_FOUND}: ${label} not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${PhrenError.VALIDATION_ERROR}: ${label} is not a directory: ${resolved}`);
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

function isPhrenRootCandidate(candidate: string): boolean {
  return hasRootManifest(candidate) || hasInstallMarkers(candidate);
}

export function findNearestPhrenPath(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const localCandidate = path.join(current, ".phren");
    if (isPhrenRootCandidate(localCandidate)) return localCandidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function sharedRootCandidate(): string {
  return homePath(".phren");
}

let cachedPhrenPath: string | null | undefined;
let cachedPhrenPathKey: string | undefined;

export function findPhrenPath(): string | null {
  const cacheKey = [
    ((process.env.PHREN_PATH || process.env.PHREN_PATH) ?? ""),
    process.env.HOME ?? "",
    process.env.USERPROFILE ?? "",
    process.cwd(),
  ].join("|");
  if (cachedPhrenPath !== undefined && cachedPhrenPathKey === cacheKey) return cachedPhrenPath;
  cachedPhrenPathKey = cacheKey;

  const envVal = (process.env.PHREN_PATH || process.env.PHREN_PATH)?.trim();
  if (envVal) {
    const resolved = path.resolve(expandHomePath(envVal));
    cachedPhrenPath = isPhrenRootCandidate(resolved) ? resolved : null;
    return cachedPhrenPath;
  }

  const nearest = findNearestPhrenPath();
  if (nearest) {
    cachedPhrenPath = nearest;
    return nearest;
  }

  const shared = sharedRootCandidate();
  cachedPhrenPath = isPhrenRootCandidate(shared) ? shared : null;
  return cachedPhrenPath;
}

export function ensurePhrenPath(): string {
  const existing = findPhrenPath();
  if (existing) return existing;
  const defaultPath = sharedRootCandidate();
  fs.mkdirSync(defaultPath, { recursive: true });
  writeRootManifest(defaultPath, {
    version: 1,
    installMode: "shared",
    syncMode: "managed-git",
  });
  cachedPhrenPath = defaultPath;
  cachedPhrenPathKey = [
    ((process.env.PHREN_PATH || process.env.PHREN_PATH) ?? ""),
    process.env.HOME ?? "",
    process.env.USERPROFILE ?? "",
    process.cwd(),
  ].join("|");
  return defaultPath;
}

export function findPhrenPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = requireDirectory(path.resolve(expandHomePath(arg)), "phren path");
    if (!hasRootManifest(resolved)) {
      throw new Error(`${PhrenError.NOT_FOUND}: phren root manifest not found: ${rootManifestPath(resolved)}`);
    }
    return resolved;
  }
  const existing = findPhrenPath();
  if (existing) return existing;
  throw new Error(`${PhrenError.NOT_FOUND}: phren root not found. Run 'npx phren init'.`);
}

export function isProjectLocalMode(phrenPath: string): boolean {
  try {
    return resolveInstallContext(phrenPath).installMode === "project-local";
  } catch {
    return false;
  }
}

// Centralized runtime path helpers. All ephemeral/runtime files go in
// subdirectories to keep the phren root clean.
export function runtimeDir(phrenPath: string): string {
  return path.join(phrenPath, ".runtime");
}

/** Unlink a file, ignoring ENOENT. Rethrows any other error. */
export function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function sessionsDir(phrenPath: string): string {
  return path.join(phrenPath, ".sessions");
}

const runtimeDirsMade = new Set<string>();
export function runtimeFile(phrenPath: string, name: string): string {
  const dir = runtimeDir(phrenPath);
  if (!runtimeDirsMade.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    runtimeDirsMade.add(dir);
  }
  return path.join(dir, name);
}

export function installPreferencesFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "install-preferences.json");
}

export function runtimeHealthFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "runtime-health.json");
}

export function shellStateFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "shell-state.json");
}

export function sessionMetricsFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "session-metrics.json");
}

export function memoryScoresFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "memory-scores.json");
}

export function memoryUsageLogFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "memory-usage.log");
}

export function sessionMarker(phrenPath: string, name: string): string {
  const dir = sessionsDir(phrenPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// Debug logging is best-effort and only writes when a phren root already exists.
export function debugLog(msg: string): void {
  if (!(process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) return;
  const phrenPath = findPhrenPath();
  if (!phrenPath) return;
  const logFile = runtimeFile(phrenPath, "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // debug log is best-effort; logging errors about logging would recurse
  }
}

export function appendIndexEvent(phrenPath: string, event: Record<string, unknown>): void {
  try {
    const file = runtimeFile(phrenPath, "index-events.jsonl");
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] appendIndexEvent: ${errorMessage(err)}\n`);
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

export function findProjectNameCaseInsensitive(phrenPath: string, name: string): string | null {
  const needle = name.toLowerCase();
  try {
    for (const entry of fs.readdirSync(phrenPath, { withFileTypes: true })) {
      if (!isProjectDirEntry(entry)) continue;
      if (entry.name.toLowerCase() === needle) return entry.name;
    }
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] findProjectNameCaseInsensitive: ${errorMessage(err)}\n`);
  }
  return null;
}

function getLocalProjectDirs(phrenPath: string, manifest: PhrenRootManifest): string[] {
  const primaryProject = manifest.primaryProject;
  if (!primaryProject || !isValidProjectName(primaryProject)) return [];
  const projectPath = safeProjectPath(phrenPath, primaryProject);
  if (!projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) return [];
  const visible = fs.readdirSync(phrenPath, { withFileTypes: true }).filter(isProjectDirEntry).map((entry) => entry.name);
  if (visible.length !== 1 || visible[0] !== primaryProject) return [];
  return [projectPath];
}

// Figure out which project directories to index.
export function getProjectDirs(phrenPath: string, profile?: string): string[] {
  const manifest = readRootManifest(phrenPath);
  if (manifest?.installMode === "project-local") {
    return getLocalProjectDirs(phrenPath, manifest);
  }

  if (profile) {
    if (!isValidProjectName(profile)) {
      console.error(`${PhrenError.VALIDATION_ERROR}: Invalid PHREN_PROFILE value: ${profile}`);
      return [];
    }
    const profilePath = path.join(phrenPath, "profiles", `${profile}.yaml`);
    if (!fs.existsSync(profilePath)) {
      console.error(`${PhrenError.FILE_NOT_FOUND}: Profile file not found: ${profilePath}`);
      return [];
    }
    try {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8"), { schema: yaml.CORE_SCHEMA });
      const projects = isRecord(data) ? data.projects : undefined;
      if (!Array.isArray(projects)) {
        console.error(`${PhrenError.MALFORMED_YAML}: Profile YAML missing valid "projects" array: ${profilePath}`);
        return [];
      }
      const listed = projects
        .map((p: unknown) => {
          const name = String(p);
          if (!isValidProjectName(name)) {
            console.error(`${PhrenError.VALIDATION_ERROR}: Skipping invalid project name in profile: ${name}`);
            return null;
          }
          return safeProjectPath(phrenPath, name);
        })
        .filter((p): p is string => p !== null && fs.existsSync(p));

      const sharedDirs = ["shared", "org"]
        .map((name) => safeProjectPath(phrenPath, name))
        .filter((p): p is string => Boolean(p && fs.existsSync(p) && fs.statSync(p).isDirectory()));

      return [...new Set([...listed, ...sharedDirs])];
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] getProjectDirs yamlParse: ${errorMessage(err)}\n`);
      console.error(`${PhrenError.MALFORMED_YAML}: Malformed profile YAML: ${profilePath}`);
      return [];
    }
  }

  try {
    return fs.readdirSync(phrenPath, { withFileTypes: true })
      .filter(isProjectDirEntry)
      .map((entry) => path.join(phrenPath, entry.name));
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] getProjectDirs: ${errorMessage(err)}\n`);
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
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] collectNativeMemoryFiles: ${errorMessage(err)}\n`);
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

export function computePhrenLiveStateToken(phrenPath: string): string {
  const parts: string[] = [];
  const projectDirs = getProjectDirs(phrenPath).sort();
  const manifest = readRootManifest(phrenPath);

  for (const projectDir of projectDirs) {
    const project = path.basename(projectDir);
    parts.push(`project:${project}`);
    for (const file of ["CLAUDE.md", "summary.md", "FINDINGS.md", "tasks.md", "review.md", "truths.md", "topic-config.json", "phren.project.yaml"]) {
      pushFileToken(parts, path.join(projectDir, file));
    }
    pushDirTokens(parts, path.join(projectDir, "reference"));
    pushDirTokens(parts, path.join(projectDir, "skills"));
    pushDirTokens(parts, path.join(projectDir, ".claude", "skills"));
  }

  if (manifest?.installMode === "shared") {
    pushDirTokens(parts, path.join(phrenPath, "profiles"));
  }
  pushDirTokens(parts, path.join(phrenPath, "global", "skills"));
  pushFileToken(parts, path.join(phrenPath, ".governance", "access-control.json"));
  pushFileToken(parts, rootManifestPath(phrenPath));
  pushFileToken(parts, runtimeHealthFile(phrenPath));
  pushFileToken(parts, runtimeFile(phrenPath, "audit.log"));
  pushFileToken(parts, memoryUsageLogFile(phrenPath));
  pushFileToken(parts, installPreferencesFile(phrenPath));

  if (manifest?.installMode === "shared") {
    pushDirTokens(parts, homePath(".github", "hooks"));
    pushFileToken(parts, homePath(".cursor", "hooks.json"));
  }

  return parts.sort().join("|");
}

// Lazy singleton for getPhrenPath — shared across all CLI modules.
let lazyPhrenPath: string | undefined;
export function getPhrenPath(): string {
  if (!lazyPhrenPath) {
    const existing = findPhrenPath();
    if (!existing) throw new Error(`${PhrenError.NOT_FOUND}: phren root not found. Run 'npx phren init'.`);
    lazyPhrenPath = existing;
  }
  return lazyPhrenPath;
}

export function qualityMarkers(phrenPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: runtimeFile(phrenPathLocal, `quality-${today}`),
    lock: runtimeFile(phrenPathLocal, `quality-${today}.lock`),
  };
}
