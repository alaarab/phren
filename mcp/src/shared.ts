import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { isValidProjectName, safeProjectPath } from "./utils.js";

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
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cortexPath = process.env.CORTEX_PATH || path.join(home, ".cortex");
  const logFile = runtimeFile(cortexPath, "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* debug log is best-effort; logging errors about logging would recurse */ }
}

export function appendIndexEvent(cortexPath: string, event: Record<string, unknown>): void {
  try {
    const file = runtimeFile(cortexPath, "index-events.jsonl");
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // Observability should not break the indexer.
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
export function findCortexPath(): string | null {
  if (process.env.CORTEX_PATH) {
    const p = process.env.CORTEX_PATH;
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch { /* path does not exist or is not accessible */ }
    return null;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of [".cortex", "cortex"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Find or create the cortex root directory (creates ~/.cortex on first run)
export function ensureCortexPath(): string {
  const existing = findCortexPath();
  if (existing) return existing;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const defaultPath = path.join(home, ".cortex");
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
    const resolved = arg.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    return requireDirectory(resolved, "cortex path");
  }
  return ensureCortexPath();
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
    } catch {
      console.error(`${CortexError.MALFORMED_YAML}: Malformed profile YAML: ${profilePath}`);
      return [];
    }
  }

  return fs.readdirSync(cortexPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.endsWith(".archived") && d.name !== "profiles" && d.name !== "templates" && d.name !== "global")
    .map(d => path.join(cortexPath, d.name));
}

// Collect MEMORY*.md files from native agent memory locations (~/.claude/projects/*/memory/)
export function collectNativeMemoryFiles(): Array<{ project: string; file: string; fullPath: string }> {
  const claudeProjectsDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".claude", "projects");
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
  } catch {
    // best effort
  }
  return results;
}

/** All valid finding type tags — used for writes, search filters, and hook extraction */
export const FINDING_TYPES = ["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Searchable finding tags (same set as FINDING_TYPES, kept as alias for backward compatibility) */
export const FINDING_TAGS = FINDING_TYPES;
export type FindingTag = FindingType;

/** Document types in the FTS index */
export const DOC_TYPES = ["claude", "findings", "reference", "skills", "summary", "backlog", "changelog", "canonical", "memory-queue", "skill", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function appendAuditLog(cortexPath: string, event: string, details: string): void {
  // Migrate: check old location, use new .runtime/ path
  const legacyPath = path.join(cortexPath, ".cortex-audit.log");
  const newPath = runtimeFile(cortexPath, "audit.log");
  // One-time migration: move old audit log to new location
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(legacyPath, newPath); } catch { /* best effort */ }
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
      } catch {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) { fs.unlinkSync(lockPath); continue; }
        } catch { /* ignore */ }
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
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(`Audit log write failed: ${msg}`);
  } finally {
    if (hasLock) try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}
