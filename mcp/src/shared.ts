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

export interface ProjectNameMigrationReport {
  renamedProjects: Array<{ from: string; to: string }>;
  updatedProfiles: Array<{ profile: string; replacements: Array<{ from: string; to: string }> }>;
  renamedNativeMemories: Array<{ from: string; to: string }>;
  archivedNativeMemories: Array<{ from: string; archivedAs: string; reason: string }>;
}

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

function readYamlObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return isRecord(parsed) ? parsed : null;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readYamlObject ${filePath}: ${errorMessage(err)}\n`);
    return null;
  }
}

export function migrateProjectNames(cortexPath: string, dryRun: boolean = false): CortexResult<ProjectNameMigrationReport> {
  const report: ProjectNameMigrationReport = {
    renamedProjects: [],
    updatedProfiles: [],
    renamedNativeMemories: [],
    archivedNativeMemories: [],
  };

  const entries = fs.readdirSync(cortexPath, { withFileTypes: true }).filter(isProjectDirEntry);
  const projectRenames = new Map<string, string>();
  const occupiedNames = new Set(entries.map((entry) => entry.name.toLowerCase()));

  for (const entry of entries) {
    if (isCanonicalProjectDirName(entry.name)) continue;
    const target = normalizeProjectNameForCreate(entry.name);
    if (!isValidProjectName(target)) {
      return cortexErr(`Cannot migrate project "${entry.name}" to invalid canonical name "${target}".`, CortexError.INVALID_PROJECT_NAME);
    }
    if (entry.name.toLowerCase() !== target || occupiedNames.has(target) && target !== entry.name.toLowerCase()) {
      return cortexErr(`Cannot migrate project "${entry.name}" because canonical target "${target}" already exists.`, CortexError.AMBIGUOUS_MATCH);
    }
    projectRenames.set(entry.name, target);
  }

  const isSameFilesystemEntry = (fromPath: string, toPath: string): boolean => {
    try {
      const fromStat = fs.statSync(fromPath);
      const toStat = fs.statSync(toPath);
      return fromStat.dev === toStat.dev && fromStat.ino === toStat.ino;
    } catch {
      return false;
    }
  };

  const renamePathPreservingCase = (fromPath: string, toPath: string): void => {
    if (fromPath === toPath) return;
    if (isSameFilesystemEntry(fromPath, toPath)) {
      const ext = path.extname(toPath);
      const base = path.basename(toPath, ext);
      const tempPath = path.join(
        path.dirname(fromPath),
        `.cortex-case-rename-${base}-${process.pid}-${Date.now()}${ext}.tmp`,
      );
      fs.renameSync(fromPath, tempPath);
      fs.renameSync(tempPath, toPath);
      return;
    }
    fs.renameSync(fromPath, toPath);
  };

  for (const [from, to] of projectRenames.entries()) {
    report.renamedProjects.push({ from, to });
    if (!dryRun) renamePathPreservingCase(path.join(cortexPath, from), path.join(cortexPath, to));
  }

  const profilesDir = path.join(cortexPath, "profiles");
  if (fs.existsSync(profilesDir)) {
    for (const file of fs.readdirSync(profilesDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const fullPath = path.join(profilesDir, file);
      const parsed = readYamlObject(fullPath);
      if (!parsed) continue;
      const projects = Array.isArray(parsed.projects) ? parsed.projects.map((value) => String(value)) : null;
      if (!projects) continue;
      const replacements: Array<{ from: string; to: string }> = [];
      const nextProjects = projects.map((name) => {
        const replacement = projectRenames.get(name);
        if (!replacement) return name;
        replacements.push({ from: name, to: replacement });
        return replacement;
      });
      if (!replacements.length) continue;
      report.updatedProfiles.push({ profile: file, replacements });
      if (!dryRun) {
        const updated = { ...parsed, projects: Array.from(new Set(nextProjects)) };
        fs.writeFileSync(fullPath, yaml.dump(updated, { lineWidth: 120, noRefs: true }));
      }
    }
  }

  for (const memory of collectNativeMemoryFiles()) {
    const targetProject = projectRenames.get(memory.project);
    if (!targetProject) continue;
    const targetPath = path.join(path.dirname(memory.fullPath), `MEMORY-${targetProject}.md`);
    if (memory.fullPath === targetPath) continue;
    if (fs.existsSync(targetPath)) {
      if (isSameFilesystemEntry(memory.fullPath, targetPath)) {
        report.renamedNativeMemories.push({ from: memory.fullPath, to: targetPath });
        if (!dryRun) renamePathPreservingCase(memory.fullPath, targetPath);
        continue;
      }
      const sourceContent = fs.readFileSync(memory.fullPath, "utf8");
      const targetContent = fs.readFileSync(targetPath, "utf8");
      if (sourceContent === targetContent) {
        const archivedAs = `${memory.fullPath}.case-migration.bak`;
        report.archivedNativeMemories.push({
          from: memory.fullPath,
          archivedAs,
          reason: "duplicate-content",
        });
        if (!dryRun) fs.renameSync(memory.fullPath, archivedAs);
        continue;
      }
      const archivedAs = `${memory.fullPath}.case-conflict.bak`;
      report.archivedNativeMemories.push({
        from: memory.fullPath,
        archivedAs,
        reason: "target-exists-with-different-content",
      });
      if (!dryRun) fs.renameSync(memory.fullPath, archivedAs);
      continue;
    }
    report.renamedNativeMemories.push({ from: memory.fullPath, to: targetPath });
    if (!dryRun) fs.renameSync(memory.fullPath, targetPath);
  }

  return cortexOk(report);
}

export function appendAuditLog(cortexPath: string, event: string, details: string): void {
  // Migrate: check old location, use new .runtime/ path
  const legacyPath = path.join(cortexPath, ".cortex-audit.log");
  const newPath = runtimeFile(cortexPath, "audit.log");
  // One-time migration: move old audit log to new location
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    try {
      fs.renameSync(legacyPath, newPath);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog migrate: ${errorMessage(err)}\n`);
    }
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
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendAuditLog lockWrite: ${errorMessage(err)}\n`);
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Another process may have claimed or removed the stale lock between
              // statSync and unlinkSync — safe to ignore and continue waiting.
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
