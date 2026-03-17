import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { PhrenError, phrenErr, phrenOk, isRecord, type PhrenResult } from "./phren-core.js";
import { collectNativeMemoryFiles, debugLog, normalizeProjectNameForCreate, runtimeFile } from "./phren-paths.js";
import { errorMessage, isValidProjectName } from "./utils.js";

export type { HookToolName } from "./provider-adapters.js";
export { HOOK_TOOL_NAMES, hookConfigPath } from "./provider-adapters.js";

export {
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  PhrenError,
  type PhrenErrorCode,
  type PhrenResult,
  phrenOk,
  phrenErr,
  forwardErr,
  parsePhrenErrorCode,
  isRecord,
  withDefaults,
  FINDING_TYPES,
  type FindingType,
  FINDING_TAGS,
  type FindingTag,
  KNOWN_OBSERVATION_TAGS,
  DOC_TYPES,
  type DocType,
  capCache,
  RESERVED_PROJECT_DIR_NAMES,
} from "./phren-core.js";

export {
  ROOT_MANIFEST_FILENAME,
  type InstallMode,
  type SyncMode,
  type PhrenRootManifest,
  type InstallContext,
  homeDir,
  homePath,
  expandHomePath,
  defaultPhrenPath,
  rootManifestPath,
  readRootManifest,
  writeRootManifest,
  resolveInstallContext,
  findNearestPhrenPath,
  isProjectLocalMode,
  runtimeDir,
  tryUnlink,
  sessionsDir,
  runtimeFile,
  installPreferencesFile,
  runtimeHealthFile,
  shellStateFile,
  sessionMetricsFile,
  memoryScoresFile,
  memoryUsageLogFile,
  sessionMarker,
  debugLog,
  appendIndexEvent,
  resolveFindingsPath,
  findPhrenPath,
  ensurePhrenPath,
  findPhrenPathWithArg,
  normalizeProjectNameForCreate,
  findProjectNameCaseInsensitive,
  findArchivedProjectNameCaseInsensitive,
  getProjectDirs,
  collectNativeMemoryFiles,
  computePhrenLiveStateToken,
  getPhrenPath,
  qualityMarkers,
  atomicWriteText,
} from "./phren-paths.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForTask,
  hasExplicitFindingSignal,
  hasExplicitTaskSignal,
  hasExecutionIntent,
  hasDiscoveryIntent,
  shouldAutoCaptureFindingsForLevel,
  shouldAutoCaptureTaskForLevel,
} from "./proactivity.js";

const MEMORY_SCOPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function normalizeMemoryScope(scope?: string | null): string | undefined {
  if (typeof scope !== "string") return undefined;
  const normalized = scope.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!MEMORY_SCOPE_PATTERN.test(normalized)) return undefined;
  return normalized;
}

export function isMemoryScopeVisible(itemScope: string | undefined, activeScope?: string): boolean {
  if (!activeScope) return true;
  if (!itemScope) return true; // Untagged legacy entries are visible to all scoped agents.
  return itemScope === "shared" || itemScope === activeScope;
}

export function impactLogFile(phrenPath: string): string {
  return runtimeFile(phrenPath, "impact.jsonl");
}

export function appendAuditLog(phrenPath: string, event: string, details: string): void {
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
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] appendAuditLog lockWrite: ${errorMessage(err)}\n`);
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Another process may have claimed or removed the stale lock between
              // statSync and unlinkSync. Sleep before retrying to avoid a spin loop.
              Atomics.wait(waiter, 0, 0, pollMs);
              waited += pollMs;
            }
            continue;
          }
        } catch (statErr: unknown) {
          if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] appendAuditLog staleStat: ${errorMessage(statErr)}\n`);
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
        fs.writeFileSync(logPath, lines.slice(-500).join("\n") + "\n");
      }
    } else {
      debugLog(`Audit log skipped (lock timeout): ${event} ${details}`);
    }
  } catch (err: unknown) {
    debugLog(`Audit log write failed: ${errorMessage(err)}`);
  } finally {
    if (hasLock) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] appendAuditLog unlock: ${errorMessage(err)}\n`);
      }
    }
  }
}
