import * as fs from "fs";
import * as os from "os";
import * as path from "path";
let _loadedEnvKey;
let _loadedEnvPath = null;
let _loadedEnvMtimeMs = -1;
function homeDir() {
    return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function parseAndApplyDotEnv(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1)
            continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const raw = trimmed.slice(eqIdx + 1).trim();
        const value = /^(["'])(.*)\1$/.test(raw) ? raw.slice(1, -1) : raw;
        if (key && !(key in process.env))
            process.env[key] = value;
    }
}
function resolveDotEnvPath(phrenPath) {
    const envPath = process.env.PHREN_PATH;
    const candidates = [
        phrenPath ? path.join(phrenPath, ".env") : null,
        envPath ? path.join(envPath, ".env") : null,
        path.join(homeDir(), ".phren", ".env"),
    ].filter((candidate) => Boolean(candidate));
    const seen = new Set();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        if (fs.existsSync(resolved))
            return resolved;
    }
    return null;
}
export function bootstrapPhrenDotEnv(phrenPath) {
    const cacheKey = `${phrenPath ?? ""}|${process.env.PHREN_PATH ?? ""}|${process.env.HOME ?? ""}|${process.env.USERPROFILE ?? ""}`;
    const envPath = resolveDotEnvPath(phrenPath);
    if (!envPath) {
        _loadedEnvKey = cacheKey;
        _loadedEnvPath = null;
        _loadedEnvMtimeMs = -1;
        return null;
    }
    const mtimeMs = fs.statSync(envPath).mtimeMs;
    if (_loadedEnvKey === cacheKey && _loadedEnvPath === envPath && _loadedEnvMtimeMs === mtimeMs) {
        return envPath;
    }
    parseAndApplyDotEnv(envPath);
    _loadedEnvKey = cacheKey;
    _loadedEnvPath = envPath;
    _loadedEnvMtimeMs = mtimeMs;
    return envPath;
}
export function resetPhrenDotEnvBootstrapForTests() {
    _loadedEnvKey = undefined;
    _loadedEnvPath = null;
    _loadedEnvMtimeMs = -1;
}
