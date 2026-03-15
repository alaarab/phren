import * as fs from "fs";
import * as path from "path";
import { debugLog, runtimeFile } from "./phren-paths.js";
import { errorMessage } from "./utils.js";
export { HOOK_TOOL_NAMES, hookConfigPath } from "./provider-adapters.js";
export { EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS, PhrenError, phrenOk, phrenErr, forwardErr, parsePhrenErrorCode, isRecord, withDefaults, FINDING_TYPES, FINDING_TAGS, KNOWN_OBSERVATION_TAGS, DOC_TYPES, capCache, } from "./phren-core.js";
export { ROOT_MANIFEST_FILENAME, homeDir, homePath, expandHomePath, defaultPhrenPath, rootManifestPath, readRootManifest, writeRootManifest, resolveInstallContext, findNearestPhrenPath, isProjectLocalMode, runtimeDir, tryUnlink, sessionsDir, runtimeFile, installPreferencesFile, runtimeHealthFile, shellStateFile, sessionMetricsFile, memoryScoresFile, memoryUsageLogFile, sessionMarker, debugLog, appendIndexEvent, resolveFindingsPath, findPhrenPath, ensurePhrenPath, findPhrenPathWithArg, normalizeProjectNameForCreate, findProjectNameCaseInsensitive, getProjectDirs, collectNativeMemoryFiles, computePhrenLiveStateToken, getPhrenPath, qualityMarkers, atomicWriteText, } from "./phren-paths.js";
export { PROACTIVITY_LEVELS, getProactivityLevel, getProactivityLevelForFindings, getProactivityLevelForTask, hasExplicitFindingSignal, hasExplicitTaskSignal, hasExecutionIntent, hasDiscoveryIntent, shouldAutoCaptureFindingsForLevel, shouldAutoCaptureTaskForLevel, } from "./proactivity.js";
const RESERVED_PROJECT_DIR_NAMES = new Set(["profiles", "templates", "global"]);
const MEMORY_SCOPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export function normalizeMemoryScope(scope) {
    if (typeof scope !== "string")
        return undefined;
    const normalized = scope.trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (!MEMORY_SCOPE_PATTERN.test(normalized))
        return undefined;
    return normalized;
}
export function isMemoryScopeVisible(itemScope, activeScope) {
    if (!activeScope)
        return true;
    if (!itemScope)
        return true; // Untagged legacy entries are visible to all scoped agents.
    return itemScope === "shared" || itemScope === activeScope;
}
export function impactLogFile(phrenPath) {
    return runtimeFile(phrenPath, "impact.jsonl");
}
export function appendAuditLog(phrenPath, event, details) {
    const logPath = runtimeFile(phrenPath, "audit.log");
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
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] appendAuditLog lockWrite: ${errorMessage(err)}\n`);
                try {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs > staleMs) {
                        try {
                            fs.unlinkSync(lockPath);
                        }
                        catch {
                            // Another process may have claimed or removed the stale lock between
                            // statSync and unlinkSync. Sleep before retrying to avoid a spin loop.
                            Atomics.wait(waiter, 0, 0, pollMs);
                            waited += pollMs;
                        }
                        continue;
                    }
                }
                catch (statErr) {
                    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                        process.stderr.write(`[phren] appendAuditLog staleStat: ${errorMessage(statErr)}\n`);
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
        }
        else {
            debugLog(`Audit log skipped (lock timeout): ${event} ${details}`);
        }
    }
    catch (err) {
        debugLog(`Audit log write failed: ${errorMessage(err)}`);
    }
    finally {
        if (hasLock) {
            try {
                fs.unlinkSync(lockPath);
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] appendAuditLog unlock: ${errorMessage(err)}\n`);
            }
        }
    }
}
