import * as fs from "fs";
import * as path from "path";

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

/**
 * Log an error to stderr when CORTEX_DEBUG is enabled.
 * Centralises the repeated `if (CORTEX_DEBUG) stderr.write(...)` pattern.
 */
export function debugError(scope: string, err: unknown): void {
  if (process.env.CORTEX_DEBUG) {
    process.stderr.write(
      `[cortex] ${scope}: ${err instanceof Error ? err.message : String(err)}\n`,
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
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
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
