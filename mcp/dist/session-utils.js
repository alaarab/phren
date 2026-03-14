import * as fs from "fs";
import * as path from "path";
/**
 * Write JSON to a file atomically using temp-file + rename.
 * Ensures the parent directory exists before writing.
 */
export function atomicWriteJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmpPath, filePath);
}
/**
 * Log an error to stderr when PHREN_DEBUG is enabled.
 * Centralises the repeated `if (PHREN_DEBUG) stderr.write(...)` pattern.
 */
export function debugError(scope, err) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) {
        process.stderr.write(`[phren] ${scope}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
/**
 * Enumerate all `session-*.json` files under `dir`, parse each one via `parse`,
 * and keep entries where `filter` returns true.
 *
 * Returns an array of `{ fullPath, data, mtimeMs }` sorted newest-mtime-first.
 * `includeMtime` controls whether `fs.statSync` is called (some callers don't need it).
 */
export function scanSessionFiles(dir, parse, filter, opts) {
    const includeMtime = opts?.includeMtime ?? true;
    const errorScope = opts?.errorScope ?? "scanSessionFiles";
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        debugError(`${errorScope} readdir`, err);
        return [];
    }
    const results = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json"))
            continue;
        const fullPath = path.join(dir, entry.name);
        try {
            const data = parse(fullPath);
            if (data === null)
                continue;
            if (!filter(data, fullPath))
                continue;
            let mtimeMs = 0;
            if (includeMtime) {
                try {
                    mtimeMs = fs.statSync(fullPath).mtimeMs;
                }
                catch { /* keep 0 */ }
            }
            results.push({ fullPath, data, mtimeMs });
        }
        catch (err) {
            debugError(`${errorScope} entry`, err);
        }
    }
    if (includeMtime) {
        results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    return results;
}
