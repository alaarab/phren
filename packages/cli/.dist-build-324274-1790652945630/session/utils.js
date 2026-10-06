import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "../utils.js";
// The coding agent (@phren/agent) imports the sessions directory from here.
export { sessionsDir } from "../phren-paths.js";
import { atomicWriteText } from "../phren-paths.js";
/**
 * Write JSON to a file atomically using temp-file + rename.
 * Ensures the parent directory exists before writing.
 */
export function atomicWriteJson(filePath, data) {
    atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}
export function runtimeSessionsDir(phrenPath) {
    const dir = path.join(phrenPath, ".runtime", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function sessionFileForId(phrenPath, sessionId) {
    return path.join(runtimeSessionsDir(phrenPath), `session-${sessionId}.json`);
}
export function isSessionStateFileName(name) {
    return name.startsWith("session-") &&
        name.endsWith(".json") &&
        !name.endsWith("-messages.json");
}
export function readSessionStateFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch (err) {
        // ENOENT is expected for missing files — only log other errors
        if (err.code !== "ENOENT") {
            debugError("readSessionStateFile", err);
        }
        return null;
    }
}
export function writeSessionStateFile(file, state) {
    atomicWriteJson(file, state);
}
/**
 * Log an error to stderr when PHREN_DEBUG is enabled.
 * Centralises the repeated `if (PHREN_DEBUG) stderr.write(...)` pattern.
 */
export function debugError(scope, err) {
    if (process.env.PHREN_DEBUG) {
        process.stderr.write(`[phren] ${scope}: ${errorMessage(err)}\n`);
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
        if (!entry.isFile() || !isSessionStateFileName(entry.name))
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
