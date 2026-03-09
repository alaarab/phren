import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";

// Default timeout for execFileSync calls (30s for most operations, 10s for quick probes like `which`)
export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_QUICK_MS = 10_000;

// Structured error codes for consistent error handling across data-access and MCP tools
export const CortexError = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  INVALID_PROJECT_NAME: "INVALID_PROJECT_NAME",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MALFORMED_JSON: "MALFORMED_JSON",
  MALFORMED_YAML: "MALFORMED_YAML",
  NOT_FOUND: "NOT_FOUND",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  EMPTY_INPUT: "EMPTY_INPUT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INDEX_ERROR: "INDEX_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type CortexErrorCode = typeof CortexError[keyof typeof CortexError];

// Discriminated union for typed error returns in the data-access layer.
// Replaces `T | string` patterns so callers can structurally distinguish errors.
export type CortexResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: CortexErrorCode };

export function cortexOk<T>(data: T): CortexResult<T> {
  return { ok: true, data };
}

export function cortexErr<T>(error: string, code?: CortexErrorCode): CortexResult<T> {
  return { ok: false, error, code };
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

export type HookToolName = "claude" | "copilot" | "cursor" | "codex";

export function hookConfigPath(tool: HookToolName): string {
  switch (tool) {
    case "claude":
      return homePath(".claude", "settings.json");
    case "copilot":
      return homePath(".github", "hooks", "cortex.json");
    case "cursor":
      return homePath(".cursor", "hooks.json");
    case "codex":
      return homePath(".codex", "config.json");
  }
}

// Forward a failed CortexResult to a different result type (re-types the error branch).
// Safe to call after an `if (!result.ok)` guard; extracts error and code from the union.
export function forwardErr<T>(result: CortexResult<unknown>): CortexResult<T> {
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: false, error: "unexpected forward of ok result" };
}

const ERROR_CODES = new Set(Object.values(CortexError));

// Extract the error code from a legacy error string (e.g. "PROJECT_NOT_FOUND: ...").
// Returns the code if the string starts with a known CortexError, or undefined.
export function parseCortexErrorCode(msg: string): CortexErrorCode | undefined {
  const prefix = msg.split(":")[0]?.trim();
  if (prefix && ERROR_CODES.has(prefix as CortexErrorCode)) return prefix as CortexErrorCode;
  return undefined;
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

const _runtimeDirsMade = new Set<string>();
export function runtimeFile(cortexPath: string, name: string): string {
  const dir = path.join(cortexPath, ".runtime");
  if (!_runtimeDirsMade.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    _runtimeDirsMade.add(dir);
  }
  return path.join(dir, name);
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
  } catch { /* debug log is best-effort; logging errors about logging would recurse */ }
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

/**
 * Resolve the findings file for a project directory, falling back to LEARNINGS.md
 * if FINDINGS.md doesn't exist. Returns undefined if neither exists.
 */
export function resolveFindingsPath(projectDir: string): string | undefined {
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (fs.existsSync(findingsPath)) return findingsPath;
  const legacyPath = path.join(projectDir, "LEARNINGS.md");
  if (fs.existsSync(legacyPath)) return legacyPath;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow-merge data onto defaults so missing keys get filled in. */
export function withDefaults<T extends object>(data: Partial<T>, defaults: T): T {
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    const val = data[key as keyof T];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        merged[key] = val;
      }
    }
  }
  return merged as T;
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
let _cachedCortexPath: string | null | undefined;
let _cachedCortexPathKey: string | undefined;
export function findCortexPath(): string | null {
  const envVal = process.env.CORTEX_PATH;
  const cacheKey = `${envVal ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
  if (_cachedCortexPath !== undefined && _cachedCortexPathKey === cacheKey) return _cachedCortexPath;
  _cachedCortexPathKey = cacheKey;
  if (envVal) {
    try {
      _cachedCortexPath = fs.statSync(envVal).isDirectory() ? envVal : null;
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findCortexPath stat: ${errorMessage(err)}\n`);
      _cachedCortexPath = null;
    }
    return _cachedCortexPath;
  }
  for (const name of [".cortex", "cortex"]) {
    const candidate = homePath(name);
    if (fs.existsSync(candidate)) { _cachedCortexPath = candidate; return candidate; }
  }
  _cachedCortexPath = null;
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
  console.error(`Created ~/.cortex`);
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
  return entry.isDirectory() &&
    !entry.name.startsWith(".") &&
    !entry.name.endsWith(".archived") &&
    !RESERVED_PROJECT_DIR_NAMES.has(entry.name);
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
    .map(d => path.join(cortexPath, d.name));
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
      for (const f of fs.readdirSync(memDir)) {
        if (!f.endsWith(".md")) continue;
        if (f === "MEMORY.md") continue;
        const fullPath = path.join(memDir, f);
        const match = f.match(/^MEMORY-(.+)\.md$/);
        const project = match ? match[1] : `native:${entry}`;
        results.push({ project, file: f, fullPath });
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] collectNativeMemoryFiles: ${errorMessage(err)}\n`);
  }
  return results;
}

export interface ProjectNameMigrationReport {
  renamedProjects: Array<{ from: string; to: string }>;
  updatedProfiles: Array<{ profile: string; replacements: Array<{ from: string; to: string }> }>;
  renamedNativeMemories: Array<{ from: string; to: string }>;
  archivedNativeMemories: Array<{ from: string; archivedAs: string; reason: string }>;
}

function isCanonicalProjectDirName(name: string): boolean {
  return name === name.toLowerCase() && isValidProjectName(name);
}

function readYamlObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return isRecord(parsed) ? parsed : null;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readYamlObject ${filePath}: ${errorMessage(err)}\n`);
    return null;
  }
}

export function migrateProjectNames(cortexPath: string, dryRun: boolean = false): CortexResult<ProjectNameMigrationReport> {
  const report: ProjectNameMigrationReport = {
    renamedProjects: [],
    updatedProfiles: [],
    renamedNativeMemories: [],
    archivedNativeMemories: [],
  };

  const entries = fs.readdirSync(cortexPath, { withFileTypes: true }).filter(isProjectDirEntry);
  const projectRenames = new Map<string, string>();
  const occupiedNames = new Set(entries.map((entry) => entry.name.toLowerCase()));

  for (const entry of entries) {
    if (isCanonicalProjectDirName(entry.name)) continue;
    const target = normalizeProjectNameForCreate(entry.name);
    if (!isValidProjectName(target)) {
      return cortexErr(`Cannot migrate project "${entry.name}" to invalid canonical name "${target}".`, CortexError.INVALID_PROJECT_NAME);
    }
    if (entry.name.toLowerCase() !== target || occupiedNames.has(target) && target !== entry.name.toLowerCase()) {
      return cortexErr(`Cannot migrate project "${entry.name}" because canonical target "${target}" already exists.`, CortexError.AMBIGUOUS_MATCH);
    }
    projectRenames.set(entry.name, target);
  }

  const isSameFilesystemEntry = (fromPath: string, toPath: string): boolean => {
    try {
      const fromStat = fs.statSync(fromPath);
      const toStat = fs.statSync(toPath);
      return fromStat.dev === toStat.dev && fromStat.ino === toStat.ino;
    } catch {
      return false;
    }
  };

  const renamePathPreservingCase = (fromPath: string, toPath: string): void => {
    if (fromPath === toPath) return;
    if (isSameFilesystemEntry(fromPath, toPath)) {
      const ext = path.extname(toPath);
      const base = path.basename(toPath, ext);
      const tempPath = path.join(
        path.dirname(fromPath),
        `.cortex-case-rename-${base}-${process.pid}-${Date.now()}${ext}.tmp`,
      );
      fs.renameSync(fromPath, tempPath);
      fs.renameSync(tempPath, toPath);
      return;
    }
    fs.renameSync(fromPath, toPath);
  };

  for (const [from, to] of projectRenames.entries()) {
    report.renamedProjects.push({ from, to });
    if (!dryRun) renamePathPreservingCase(path.join(cortexPath, from), path.join(cortexPath, to));
  }

  const profilesDir = path.join(cortexPath, "profiles");
  if (fs.existsSync(profilesDir)) {
    for (const file of fs.readdirSync(profilesDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const fullPath = path.join(profilesDir, file);
      const parsed = readYamlObject(fullPath);
      if (!parsed) continue;
      const projects = Array.isArray(parsed.projects) ? parsed.projects.map((value) => String(value)) : null;
      if (!projects) continue;
      const replacements: Array<{ from: string; to: string }> = [];
      const nextProjects = projects.map((name) => {
        const replacement = projectRenames.get(name);
        if (!replacement) return name;
        replacements.push({ from: name, to: replacement });
        return replacement;
      });
      if (!replacements.length) continue;
      report.updatedProfiles.push({ profile: file, replacements });
      if (!dryRun) {
        const updated = { ...parsed, projects: Array.from(new Set(nextProjects)) };
        fs.writeFileSync(fullPath, yaml.dump(updated, { lineWidth: 120, noRefs: true }));
      }
    }
  }

  for (const memory of collectNativeMemoryFiles()) {
    const targetProject = projectRenames.get(memory.project);
    if (!targetProject) continue;
    const targetPath = path.join(path.dirname(memory.fullPath), `MEMORY-${targetProject}.md`);
    if (memory.fullPath === targetPath) continue;
    if (fs.existsSync(targetPath)) {
      if (isSameFilesystemEntry(memory.fullPath, targetPath)) {
        report.renamedNativeMemories.push({ from: memory.fullPath, to: targetPath });
        if (!dryRun) renamePathPreservingCase(memory.fullPath, targetPath);
        continue;
      }
      const sourceContent = fs.readFileSync(memory.fullPath, "utf8");
      const targetContent = fs.readFileSync(targetPath, "utf8");
      if (sourceContent === targetContent) {
        const archivedAs = `${memory.fullPath}.case-migration.bak`;
        report.archivedNativeMemories.push({
          from: memory.fullPath,
          archivedAs,
          reason: "duplicate-content",
        });
        if (!dryRun) fs.renameSync(memory.fullPath, archivedAs);
        continue;
      }
      const archivedAs = `${memory.fullPath}.case-conflict.bak`;
      report.archivedNativeMemories.push({
        from: memory.fullPath,
        archivedAs,
        reason: "target-exists-with-different-content",
      });
      if (!dryRun) fs.renameSync(memory.fullPath, archivedAs);
      continue;
    }
    report.renamedNativeMemories.push({ from: memory.fullPath, to: targetPath });
    if (!dryRun) fs.renameSync(memory.fullPath, targetPath);
  }

  return cortexOk(report);
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
    parts.push(`${fullPath}:${fs.statSync(fullPath).mtimeMs}:${fs.statSync(fullPath).size}`);
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
  pushFileToken(parts, path.join(cortexPath, ".governance", "runtime-health.json"));
  pushFileToken(parts, runtimeFile(cortexPath, "audit.log"));
  pushFileToken(parts, path.join(cortexPath, ".governance", "memory-usage.log"));
  pushFileToken(parts, path.join(cortexPath, ".runtime", "install-preferences.json"));

  pushDirTokens(parts, homePath(".github", "hooks"));
  pushFileToken(parts, homePath(".cursor", "hooks.json"));

  return parts.sort().join("|");
}

/** All valid finding type tags — used for writes, search filters, and hook extraction */
export const FINDING_TYPES = ["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Searchable finding tags (same set as FINDING_TYPES, kept as alias for backward compatibility) */
export const FINDING_TAGS = FINDING_TYPES;
export type FindingTag = FindingType;

/** Canonical set of known observation tags — derived from FINDING_TYPES */
export const KNOWN_OBSERVATION_TAGS: Set<string> = new Set(FINDING_TYPES);

/** Document types in the FTS index */
export const DOC_TYPES = ["claude", "findings", "reference", "skills", "summary", "backlog", "changelog", "canonical", "memory-queue", "skill", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function appendAuditLog(cortexPath: string, event: string, details: string): void {
  // Migrate: check old location, use new .runtime/ path
  const legacyPath = path.join(cortexPath, ".cortex-audit.log");
  const newPath = runtimeFile(cortexPath, "audit.log");
  // One-time migration: move old audit log to new location
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(legacyPath, newPath); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog migrate: ${errorMessage(err)}\n`);
    }
  }
  const logPath = newPath;
  const line = `[${new Date().toISOString()}] ${event} ${details}\n`;
  const lockPath = logPath + ".lock";
  const maxWait = 5000;
  const pollMs = 50;
  const staleMs = 30_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  // Q82: use an inline lock (same protocol as withFileLock) to guard the
  // append + conditional rotation so concurrent processes don't read the same
  // old content and race to write a truncated version each.
  let waited = 0;
  let hasLock = false;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    while (waited < maxWait) {
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
        hasLock = true;
        break;
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog lockWrite: ${errorMessage(err)}\n`);
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) { fs.unlinkSync(lockPath); continue; }
        } catch (statErr: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog staleStat: ${errorMessage(statErr)}\n`);
        }
        Atomics.wait(waiter, 0, 0, pollMs);
        waited += pollMs;
      }
    }
    if (hasLock) {
      fs.appendFileSync(logPath, line);
      const stat = fs.statSync(logPath);
      if (stat.size > 1_000_000) {
        const content = fs.readFileSync(logPath, "utf8");
        const lines = content.split("\n");
        fs.writeFileSync(logPath, lines.slice(-500).join("\n"));
      }
    } else {
      debugLog(`Audit log skipped (lock timeout): ${event} ${details}`);
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    debugLog(`Audit log write failed: ${msg}`);
  } finally {
    if (hasLock) try { fs.unlinkSync(lockPath); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog unlock: ${errorMessage(err)}\n`);
    }
  }
}

// Lazy singleton for getCortexPath — shared across all CLI modules.
let _lazyCortexPath: string | undefined;
export function getCortexPath(): string {
  if (!_lazyCortexPath) _lazyCortexPath = ensureCortexPath();
  return _lazyCortexPath;
}

// ── Cache eviction helper ────────────────────────────────────────────────────

const CACHE_MAX = 1000;
const CACHE_EVICT = 100;

export function capCache<K, V>(cache: Map<K, V>): void {
  if (cache.size > CACHE_MAX) {
    const it = cache.keys();
    for (let i = 0; i < CACHE_EVICT; i++) {
      const k = it.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }
}

export function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: runtimeFile(cortexPathLocal, `quality-${today}`),
    lock: runtimeFile(cortexPathLocal, `quality-${today}.lock`),
  };
}
