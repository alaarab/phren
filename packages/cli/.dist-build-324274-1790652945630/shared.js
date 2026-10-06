import * as fs from "fs";
import * as path from "path";
import { debugLog, runtimeFile } from "./phren-paths.js";
import { errorMessage } from "./utils.js";
import { withFileLock } from "./governance/locks.js";
const MAX_LOG_LINES = 1000;
export { HOOK_TOOL_NAMES, hookConfigPath } from "./provider-adapters.js";
export { EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS, PhrenError, phrenOk, phrenErr, forwardErr, parsePhrenErrorCode, isRecord, withDefaults, FINDING_TYPES, FINDING_TAGS, KNOWN_OBSERVATION_TAGS, DOC_TYPES, capCache, RESERVED_PROJECT_DIR_NAMES, } from "./phren-core.js";
export { ROOT_MANIFEST_FILENAME, isInstallMode, homeDir, homePath, expandHomePath, defaultPhrenPath, rootManifestPath, readRootManifest, writeRootManifest, resolveInstallContext, findNearestPhrenPath, isProjectLocalMode, runtimeDir, tryUnlink, sessionsDir, runtimeFile, installPreferencesFile, runtimeHealthFile, shellStateFile, sessionMetricsFile, memoryScoresFile, memoryUsageLogFile, lookupEventsLogFile, sessionMarker, debugLog, appendIndexEvent, resolveFindingsPath, findPhrenPath, ensurePhrenPath, findPhrenPathWithArg, normalizeProjectNameForCreate, projectSlugFromPath, canonicalProjectKey, findProjectNameCaseInsensitive, findProjectNamesByCanonicalKey, findArchivedProjectNameCaseInsensitive, getProjectDirs, listInvalidProjectDirs, collectNativeMemoryFiles, nativeMemoryEnabled, computePhrenLiveStateToken, getPhrenPath, qualityMarkers, atomicWriteText, ensurePrivateDir, ftsCacheRoot, ensureFtsCacheRootPrivate, } from "./phren-paths.js";
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
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        withFileLock(logPath, () => {
            fs.appendFileSync(logPath, line);
            const stat = fs.statSync(logPath);
            if (stat.size > 1_000_000) {
                const content = fs.readFileSync(logPath, "utf8");
                const lines = content.split("\n");
                fs.writeFileSync(logPath, lines.slice(-MAX_LOG_LINES).join("\n") + "\n");
            }
        });
    }
    catch (err) {
        debugLog(`Audit log write failed: ${errorMessage(err)}`);
    }
}
