import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "../utils.js";

/**
 * Write JSON to a file atomically using temp-file + rename.
 * Ensures the parent directory exists before writing.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

// ── Session state types & helpers (shared between MCP tools and hooks) ───────

export interface SessionState {
  sessionId: string;
  project?: string;
  agentScope?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  findingsAdded: number;
  tasksCompleted: number;
  /** When true, this session was created by a lifecycle hook, not an explicit MCP call. */
  hookCreated?: boolean;
  /** When true, this session was created by the coding agent runtime. */
  agentCreated?: boolean;
}

export function sessionsDir(phrenPath: string): string {
  const dir = path.join(phrenPath, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionFileForId(phrenPath: string, sessionId: string): string {
  return path.join(sessionsDir(phrenPath), `session-${sessionId}.json`);
}

export function isSessionStateFileName(name: string): boolean {
  return name.startsWith("session-") &&
    name.endsWith(".json") &&
    !name.endsWith("-messages.json");
}

export function readSessionStateFile(file: string): SessionState | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: unknown) {
    // ENOENT is expected for missing files — only log other errors
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      debugError("readSessionStateFile", err);
    }
    return null;
  }
}

export function writeSessionStateFile(file: string, state: SessionState): void {
  atomicWriteJson(file, state);
}

/**
 * Log an error to stderr when PHREN_DEBUG is enabled.
 * Centralises the repeated `if (PHREN_DEBUG) stderr.write(...)` pattern.
 */
export function debugError(scope: string, err: unknown): void {
  if (process.env.PHREN_DEBUG) {
    process.stderr.write(
      `[phren] ${scope}: ${errorMessage(err)}\n`,
    );
  }
}

interface SessionFileEntry<T> {
  fullPath: string;
  data: T;
  mtimeMs: number;
}

/**
 * Enumerate all `session-*.json` files under `dir`, parse each one via `parse`,
 * and keep entries where `filter` returns true.
 *
 * Returns an array of `{ fullPath, data, mtimeMs }` sorted newest-mtime-first.
 * `includeMtime` controls whether `fs.statSync` is called (some callers don't need it).
 */
export function scanSessionFiles<T>(
  dir: string,
  parse: (filePath: string) => T | null,
  filter: (data: T, fullPath: string) => boolean,
  opts?: { includeMtime?: boolean; errorScope?: string },
): SessionFileEntry<T>[] {
  const includeMtime = opts?.includeMtime ?? true;
  const errorScope = opts?.errorScope ?? "scanSessionFiles";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    debugError(`${errorScope} readdir`, err);
    return [];
  }

  const results: SessionFileEntry<T>[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isSessionStateFileName(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const data = parse(fullPath);
      if (data === null) continue;
      if (!filter(data, fullPath)) continue;
      let mtimeMs = 0;
      if (includeMtime) {
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch { /* keep 0 */ }
      }
      results.push({ fullPath, data, mtimeMs });
    } catch (err: unknown) {
      debugError(`${errorScope} entry`, err);
    }
  }

  if (includeMtime) {
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  return results;
}
