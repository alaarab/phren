import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { CortexError, cortexErr, cortexOk, isRecord, type CortexResult } from "./cortex-core.js";
import { collectNativeMemoryFiles, debugLog, normalizeProjectNameForCreate, runtimeFile } from "./cortex-paths.js";
import { errorMessage, isValidProjectName } from "./utils.js";

export type { HookToolName } from "./provider-adapters.js";
export { HOOK_TOOL_NAMES, hookConfigPath } from "./provider-adapters.js";

export {
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  CortexError,
  type CortexErrorCode,
  type CortexResult,
  cortexOk,
  cortexErr,
  forwardErr,
  parseCortexErrorCode,
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
} from "./cortex-core.js";

export {
  homeDir,
  homePath,
  expandHomePath,
  defaultCortexPath,
  runtimeDir,
  tryUnlink,
  sessionsDir,
  runtimeFile,
  installPreferencesFile,
  runtimeHealthFile,
  canonicalLocksFile,
  shellStateFile,
  sessionMetricsFile,
  memoryScoresFile,
  memoryUsageLogFile,
  sessionMarker,
  debugLog,
  appendIndexEvent,
  resolveFindingsPath,
  findCortexPath,
  ensureCortexPath,
  findCortexPathWithArg,
  normalizeProjectNameForCreate,
  findProjectNameCaseInsensitive,
  getProjectDirs,
  collectNativeMemoryFiles,
  computeCortexLiveStateToken,
  getCortexPath,
  qualityMarkers,
} from "./cortex-paths.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForBacklog,
} from "./proactivity.js";

const RESERVED_PROJECT_DIR_NAMES = new Set(["profiles", "templates", "global"]);

function isProjectDirEntry(entry: fs.Dirent): boolean {
  return entry.isDirectory()
    && !entry.name.startsWith(".")
    && !entry.name.endsWith(".archived")
    && !RESERVED_PROJECT_DIR_NAMES.has(entry.name);
}

function isCanonicalProjectDirName(name: string): boolean {
  return name === name.toLowerCase() && isValidProjectName(name);
}

export function appendAuditLog(cortexPath: string, event: string, details: string): void {
  const logPath = runtimeFile(cortexPath, "audit.log");
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
    debugLog(`Audit log write failed: ${errorMessage(err)}`);
  } finally {
    if (hasLock) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog unlock: ${errorMessage(err)}\n`);
      }
    }
  }
}
