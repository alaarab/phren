import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { appendAuditLog, debugLog, getProjectDirs, isRecord, runtimeHealthFile, withDefaults, phrenErr, PhrenError, phrenOk, type PhrenResult, resolveFindingsPath } from "./shared.js";
import { withFileLock } from "./governance-locks.js";
import { errorMessage, isValidProjectName, safeProjectPath } from "./utils.js";
import { runCustomHooks } from "./hooks.js";
import {
  METADATA_REGEX,
  isCitationLine,
  isArchiveStart as isArchiveStartMeta,
  isArchiveEnd as isArchiveEndMeta,
  stripLifecycleMetadata as stripLifecycleMetadataMeta,
} from "./content-metadata.js";

export const MAX_QUEUE_ENTRY_LENGTH = 500;

export interface RetentionPolicy {
  schemaVersion?: number;
  ttlDays: number;
  retentionDays: number;
  autoAcceptThreshold: number;
  minInjectConfidence: number;
  decay: {
    d30: number;
    d60: number;
    d90: number;
    d120: number;
  };
}

export interface WorkflowPolicy {
  schemaVersion?: number;
  lowConfidenceThreshold: number;
  riskySections: Array<"Review" | "Stale" | "Conflicts">;
  taskMode: "off" | "manual" | "suggest" | "auto";
  findingSensitivity: "minimal" | "conservative" | "balanced" | "aggressive";
}

export interface IndexPolicy {
  schemaVersion?: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  includeHidden: boolean;
}

export interface RuntimeHealth {
  schemaVersion?: number;
  lastSessionStartAt?: string;
  lastPromptAt?: string;
  lastStopAt?: string;
  lastAutoSave?: {
    at: string;
    status: "clean" | "saved-local" | "saved-pushed" | "error";
    detail?: string;
  };
  lastGovernance?: {
    at: string;
    status: "ok" | "error";
    detail: string;
  };
  lastSync?: {
    lastPullAt?: string;
    lastPullStatus?: "ok" | "error";
    lastPullDetail?: string;
    lastSuccessfulPullAt?: string;
    lastPushAt?: string;
    lastPushStatus?: "saved-local" | "saved-pushed" | "error";
    lastPushDetail?: string;
    unsyncedCommits?: number;
  };
}

export const GOVERNANCE_SCHEMA_VERSION = 1;

const DEFAULT_POLICY: RetentionPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  ttlDays: 120,
  retentionDays: 365,
  autoAcceptThreshold: 0.75,
  minInjectConfidence: 0.35,
  decay: {
    d30: 1.0,
    d60: 0.85,
    d90: 0.65,
    d120: 0.45,
  },
};

const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  lowConfidenceThreshold: 0.7,
  riskySections: ["Stale", "Conflicts"],
  taskMode: "auto",
  findingSensitivity: "balanced",
};

const DEFAULT_INDEX_POLICY: IndexPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  includeGlobs: ["**/*.md", "**/skills/**/*.md", ".claude/skills/**/*.md"],
  excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
  includeHidden: false,
};

const DEFAULT_RUNTIME_HEALTH: RuntimeHealth = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
};

function governanceDir(phrenPath: string): string {
  return path.join(phrenPath, ".governance");
}

type GovernanceSchema =
  | "retention-policy"
  | "workflow-policy"
  | "index-policy";

function govFile(phrenPath: string, schema: GovernanceSchema): string {
  return path.join(governanceDir(phrenPath), GOVERNANCE_REGISTRY[schema].file);
}

function hasValidSchemaVersion(data: Record<string, unknown>): boolean {
  return !("schemaVersion" in data) || typeof data.schemaVersion === "number";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pickNumber(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return cleaned.length ? cleaned : [...fallback];
}

const GOVERNANCE_VALIDATORS: Record<GovernanceSchema, (data: Record<string, unknown>) => boolean> = {
  "retention-policy": (data) =>
    hasValidSchemaVersion(data)
    && ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"].every(
      (key) => !(key in data) || isFiniteNumber(data[key]),
    )
    && (!("decay" in data) || (() => {
      if (!isRecord(data.decay)) return false;
      const decay = data.decay;
      return ["d30", "d60", "d90", "d120"].every((key) => !(key in decay) || isFiniteNumber(decay[key]));
    })()),
  "workflow-policy": (data) =>
    hasValidSchemaVersion(data)
    && (!("lowConfidenceThreshold" in data) || isFiniteNumber(data.lowConfidenceThreshold))
    && (!("riskySections" in data) || isStringArray(data.riskySections))
    && (!("taskMode" in data) || ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))),
  "index-policy": (data) =>
    hasValidSchemaVersion(data)
    && ["includeGlobs", "excludeGlobs"].every((key) => !(key in data) || isStringArray(data[key]))
    && (!("includeHidden" in data) || typeof data.includeHidden === "boolean"),
};

interface GovernanceRegistryEntry {
  file: string;
  validate: (data: Record<string, unknown>) => boolean;
  defaults: () => Record<string, unknown>;
  normalize: (data: Record<string, unknown>) => Record<string, unknown>;
}

const GOVERNANCE_REGISTRY: Record<GovernanceSchema, GovernanceRegistryEntry> = {
  "retention-policy": {
    file: "retention-policy.json",
    validate: GOVERNANCE_VALIDATORS["retention-policy"],
    defaults: () => ({ ...DEFAULT_POLICY }),
    normalize: (data) => normalizeRetentionPolicy(data) as unknown as Record<string, unknown>,
  },
  "workflow-policy": {
    file: "workflow-policy.json",
    validate: GOVERNANCE_VALIDATORS["workflow-policy"],
    defaults: () => ({ ...DEFAULT_WORKFLOW_POLICY }),
    normalize: (data) => normalizeWorkflowPolicy(data) as unknown as Record<string, unknown>,
  },
  "index-policy": {
    file: "index-policy.json",
    validate: GOVERNANCE_VALIDATORS["index-policy"],
    defaults: () => ({ ...DEFAULT_INDEX_POLICY }),
    normalize: (data) => normalizeIndexPolicy(data) as unknown as Record<string, unknown>,
  },
};

const GOVERNANCE_FILE_SCHEMAS: Record<string, GovernanceSchema> = Object.fromEntries(
  Object.entries(GOVERNANCE_REGISTRY).map(([schema, entry]) => [entry.file, schema as GovernanceSchema]),
);

export function validateGovernanceJson(filePath: string, schema: GovernanceSchema): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!isRecord(data)) {
      debugLog(`validateGovernanceJson: ${filePath} is not a JSON object`);
      return false;
    }
    if (!GOVERNANCE_REGISTRY[schema].validate(data)) {
      debugLog(`validateGovernanceJson: ${filePath} failed ${schema} schema check`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    debugLog(`validateGovernanceJson parse error for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function extractGovernanceVersion(_schema: GovernanceSchema, data: Record<string, unknown>): number {
  return typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
}

function normalizeRuntimeHealth(data: Record<string, unknown>): RuntimeHealth {
  const normalized: RuntimeHealth = { schemaVersion: GOVERNANCE_SCHEMA_VERSION };
  if (typeof data.lastSessionStartAt === "string") normalized.lastSessionStartAt = data.lastSessionStartAt;
  if (typeof data.lastPromptAt === "string") normalized.lastPromptAt = data.lastPromptAt;
  if (typeof data.lastStopAt === "string") normalized.lastStopAt = data.lastStopAt;
  if (isRecord(data.lastAutoSave) && typeof data.lastAutoSave.at === "string" && ["clean", "saved-local", "saved-pushed", "error"].includes(String(data.lastAutoSave.status))) {
    normalized.lastAutoSave = {
      at: data.lastAutoSave.at,
      status: data.lastAutoSave.status as "clean" | "saved-local" | "saved-pushed" | "error",
      detail: typeof data.lastAutoSave.detail === "string" ? data.lastAutoSave.detail : undefined,
    };
  }
  if (isRecord(data.lastGovernance) && typeof data.lastGovernance.at === "string" && ["ok", "error"].includes(String(data.lastGovernance.status)) && typeof data.lastGovernance.detail === "string") {
    normalized.lastGovernance = {
      at: data.lastGovernance.at,
      status: data.lastGovernance.status as "ok" | "error",
      detail: data.lastGovernance.detail,
    };
  }
  if (isRecord(data.lastSync)) {
    normalized.lastSync = {};
    if (typeof data.lastSync.lastPullAt === "string") normalized.lastSync.lastPullAt = data.lastSync.lastPullAt;
    if (["ok", "error"].includes(String(data.lastSync.lastPullStatus))) normalized.lastSync.lastPullStatus = data.lastSync.lastPullStatus as "ok" | "error";
    if (typeof data.lastSync.lastPullDetail === "string") normalized.lastSync.lastPullDetail = data.lastSync.lastPullDetail;
    if (typeof data.lastSync.lastSuccessfulPullAt === "string") normalized.lastSync.lastSuccessfulPullAt = data.lastSync.lastSuccessfulPullAt;
    if (typeof data.lastSync.lastPushAt === "string") normalized.lastSync.lastPushAt = data.lastSync.lastPushAt;
    if (["saved-local", "saved-pushed", "error"].includes(String(data.lastSync.lastPushStatus))) normalized.lastSync.lastPushStatus = data.lastSync.lastPushStatus as "saved-local" | "saved-pushed" | "error";
    if (typeof data.lastSync.lastPushDetail === "string") normalized.lastSync.lastPushDetail = data.lastSync.lastPushDetail;
    if (isFiniteNumber(data.lastSync.unsyncedCommits)) normalized.lastSync.unsyncedCommits = data.lastSync.unsyncedCommits;
  }
  return normalized;
}

function normalizeRetentionPolicy(data: Record<string, unknown>): RetentionPolicy {
  const decay = isRecord(data.decay) ? data.decay : {};
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    ttlDays: pickNumber(data.ttlDays, DEFAULT_POLICY.ttlDays),
    retentionDays: pickNumber(data.retentionDays, DEFAULT_POLICY.retentionDays),
    autoAcceptThreshold: pickNumber(data.autoAcceptThreshold, DEFAULT_POLICY.autoAcceptThreshold),
    minInjectConfidence: pickNumber(data.minInjectConfidence, DEFAULT_POLICY.minInjectConfidence),
    decay: {
      d30: pickNumber(decay.d30, DEFAULT_POLICY.decay.d30),
      d60: pickNumber(decay.d60, DEFAULT_POLICY.decay.d60),
      d90: pickNumber(decay.d90, DEFAULT_POLICY.decay.d90),
      d120: pickNumber(decay.d120, DEFAULT_POLICY.decay.d120),
    },
  };
}

function normalizeWorkflowPolicy(data: Record<string, unknown>): WorkflowPolicy {
  const validSections = new Set(["Review", "Stale", "Conflicts"]);
  const taskMode = ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))
    ? String(data.taskMode) as WorkflowPolicy["taskMode"]
    : DEFAULT_WORKFLOW_POLICY.taskMode;
  const riskySections = Array.isArray(data.riskySections)
    ? data.riskySections.filter((section): section is "Review" | "Stale" | "Conflicts" => validSections.has(String(section)))
    : [];
  const findingSensitivity = ["minimal", "conservative", "balanced", "aggressive"].includes(String(data.findingSensitivity))
    ? String(data.findingSensitivity) as WorkflowPolicy["findingSensitivity"]
    : DEFAULT_WORKFLOW_POLICY.findingSensitivity;
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    lowConfidenceThreshold: pickNumber(data.lowConfidenceThreshold, DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold),
    riskySections: riskySections.length ? riskySections : [...DEFAULT_WORKFLOW_POLICY.riskySections],
    taskMode,
    findingSensitivity,
  };
}

function normalizeIndexPolicy(data: Record<string, unknown>): IndexPolicy {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    includeGlobs: cleanStringArray(data.includeGlobs, DEFAULT_INDEX_POLICY.includeGlobs),
    excludeGlobs: cleanStringArray(data.excludeGlobs, DEFAULT_INDEX_POLICY.excludeGlobs),
    includeHidden: pickBoolean(data.includeHidden, DEFAULT_INDEX_POLICY.includeHidden),
  };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const basename = path.basename(filePath);
    const schema = GOVERNANCE_FILE_SCHEMAS[basename];
    if (schema && !validateGovernanceJson(filePath, schema)) {
      debugLog(`readJsonFile: ${filePath} failed validation, using defaults`);
      return fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const fileVersion = schema ? extractGovernanceVersion(schema, parsed) : (typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0);
    if (fileVersion > GOVERNANCE_SCHEMA_VERSION) {
      debugLog(`Warning: ${filePath} has schemaVersion ${fileVersion}, expected <= ${GOVERNANCE_SCHEMA_VERSION}. Consider updating phren.`);
    }
    return parsed as T;
  } catch (err: unknown) {
    debugLog(`readJsonFile failed for ${filePath}: ${errorMessage(err)}`);
    return fallback;
  }
}

function writeJsonFileUnlocked(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function writeJsonFile(filePath: string, data: unknown): void {
  withFileLock(filePath, () => {
    writeJsonFileUnlocked(filePath, data);
  });
}

export function getRetentionPolicy(phrenPath: string): RetentionPolicy {
  const parsed = readJsonFile<Partial<RetentionPolicy>>(govFile(phrenPath, "retention-policy"), {});
  return withDefaults(parsed, DEFAULT_POLICY);
}

export function updateRetentionPolicy(phrenPath: string, patch: Partial<RetentionPolicy>): PhrenResult<RetentionPolicy> {
  const current = getRetentionPolicy(phrenPath);
  const next: RetentionPolicy = {
    ...current,
    ...patch,
    decay: {
      ...current.decay,
      ...(patch.decay || {}),
    },
  };
  writeJsonFile(govFile(phrenPath, "retention-policy"), next);
  appendAuditLog(phrenPath, "update_policy", JSON.stringify(next));
  return phrenOk(next);
}

export function getWorkflowPolicy(phrenPath: string): WorkflowPolicy {
  const parsed = readJsonFile<Partial<WorkflowPolicy>>(govFile(phrenPath, "workflow-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_WORKFLOW_POLICY);
  const validSections = new Set(["Review", "Stale", "Conflicts"]);
  merged.riskySections = merged.riskySections.filter((section) => validSections.has(section));
  if (!merged.riskySections.length) merged.riskySections = DEFAULT_WORKFLOW_POLICY.riskySections;
  if (!["off", "manual", "suggest", "auto"].includes(merged.taskMode)) {
    merged.taskMode = DEFAULT_WORKFLOW_POLICY.taskMode;
  }
  if (!["minimal", "conservative", "balanced", "aggressive"].includes(merged.findingSensitivity)) {
    merged.findingSensitivity = DEFAULT_WORKFLOW_POLICY.findingSensitivity;
  }
  return merged;
}

export function updateWorkflowPolicy(phrenPath: string, patch: Partial<WorkflowPolicy>): PhrenResult<WorkflowPolicy> {
  const current = getWorkflowPolicy(phrenPath);
  const riskySections = Array.isArray(patch.riskySections)
    ? patch.riskySections.filter((section): section is "Review" | "Stale" | "Conflicts" => ["Review", "Stale", "Conflicts"].includes(String(section)))
    : current.riskySections;
  const taskMode = patch.taskMode && ["off", "manual", "suggest", "auto"].includes(String(patch.taskMode))
    ? patch.taskMode
    : current.taskMode;
  const findingSensitivity = patch.findingSensitivity && ["minimal", "conservative", "balanced", "aggressive"].includes(String(patch.findingSensitivity))
    ? patch.findingSensitivity
    : current.findingSensitivity;
  const next: WorkflowPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    lowConfidenceThreshold: patch.lowConfidenceThreshold ?? current.lowConfidenceThreshold,
    riskySections: riskySections.length ? riskySections : current.riskySections,
    taskMode,
    findingSensitivity,
  };
  writeJsonFile(govFile(phrenPath, "workflow-policy"), next);
  appendAuditLog(phrenPath, "update_workflow_policy", JSON.stringify(next));
  return phrenOk(next);
}

export function getIndexPolicy(phrenPath: string): IndexPolicy {
  const parsed = readJsonFile<Partial<IndexPolicy>>(govFile(phrenPath, "index-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_INDEX_POLICY);
  merged.includeGlobs = merged.includeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
  merged.excludeGlobs = merged.excludeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
  if (!merged.includeGlobs.length) merged.includeGlobs = DEFAULT_INDEX_POLICY.includeGlobs;
  if (!merged.excludeGlobs.length) merged.excludeGlobs = DEFAULT_INDEX_POLICY.excludeGlobs;
  return merged;
}

export function updateIndexPolicy(phrenPath: string, patch: Partial<IndexPolicy>): PhrenResult<IndexPolicy> {
  const current = getIndexPolicy(phrenPath);
  const next: IndexPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    includeGlobs: Array.isArray(patch.includeGlobs)
      ? patch.includeGlobs.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0)
      : current.includeGlobs,
    excludeGlobs: Array.isArray(patch.excludeGlobs)
      ? patch.excludeGlobs.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0)
      : current.excludeGlobs,
    includeHidden: patch.includeHidden ?? current.includeHidden,
  };
  writeJsonFile(govFile(phrenPath, "index-policy"), next);
  appendAuditLog(phrenPath, "update_index_policy", JSON.stringify(next));
  return phrenOk(next);
}

export function getRuntimeHealth(phrenPath: string): RuntimeHealth {
  const parsed = readJsonFile<Record<string, unknown>>(runtimeHealthFile(phrenPath), {});
  if (!isRecord(parsed)) return { ...DEFAULT_RUNTIME_HEALTH };
  return normalizeRuntimeHealth(parsed);
}

export function updateRuntimeHealth(phrenPath: string, patch: Partial<RuntimeHealth>): RuntimeHealth {
  const file = runtimeHealthFile(phrenPath);
  return withFileLock(file, () => {
    const parsed = readJsonFile<Record<string, unknown>>(file, {});
    const current = isRecord(parsed) ? normalizeRuntimeHealth(parsed) : { ...DEFAULT_RUNTIME_HEALTH };
    const next: RuntimeHealth = {
      schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
      ...current,
      ...patch,
      lastAutoSave: patch.lastAutoSave ?? current.lastAutoSave,
      lastGovernance: patch.lastGovernance ?? current.lastGovernance,
      lastSync: patch.lastSync ? { ...(current.lastSync ?? {}), ...patch.lastSync } : current.lastSync,
    };
    writeJsonFileUnlocked(file, next);
    return next;
  });
}

function normalizeBulletForQueue(line: string): string {
  return line.startsWith("- ") ? line.slice(2).trim() : line.trim();
}

function cleanQueueEntryText(raw: string): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeQueueEntryText(
  raw: string,
  opts: { truncate?: boolean } = {},
): PhrenResult<{ text: string; truncated: boolean }> {
  const cleaned = cleanQueueEntryText(raw);
  if (!cleaned) return phrenErr("Memory text cannot be empty.", PhrenError.EMPTY_INPUT);
  if (cleaned.length <= MAX_QUEUE_ENTRY_LENGTH) {
    return phrenOk({ text: cleaned, truncated: false });
  }
  if (!opts.truncate) {
    return phrenErr(
      `Memory text exceeds maximum length of ${MAX_QUEUE_ENTRY_LENGTH} characters (got ${cleaned.length}). Shorten it before saving.`,
      PhrenError.VALIDATION_ERROR,
    );
  }
  return phrenOk({
    text: cleaned.slice(0, MAX_QUEUE_ENTRY_LENGTH - 1).trimEnd() + "…",
    truncated: true,
  });
}

export function appendReviewQueue(
  phrenPath: string,
  project: string,
  section: "Review" | "Stale" | "Conflicts",
  entries: string[],
): PhrenResult<number> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(phrenPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);
  const queuePath = path.join(resolvedDir, "review.md");
  const today = new Date().toISOString().slice(0, 10);

  const normalized: string[] = [];
  for (const entry of entries) {
    const sanitized = normalizeQueueEntryText(normalizeBulletForQueue(entry), { truncate: true });
    if (!sanitized.ok) continue;
    if (sanitized.data.truncated) {
      debugLog(`appendReviewQueue: truncated oversized queue entry for ${project}`);
    }
    normalized.push(sanitized.data.text);
  }
  if (normalized.length === 0) return phrenOk(0);

  return withFileLock(queuePath, () => {
    let content = "";
    if (fs.existsSync(queuePath)) {
      content = fs.readFileSync(queuePath, "utf8");
    } else {
      content = `# ${project} Review Queue\n\n## Review\n\n## Stale\n\n## Conflicts\n`;
    }

    const lines = content.split("\n");
    const secHeader = `## ${section}`;
    let secIdx = lines.findIndex((line) => line.trim() === secHeader);
    if (secIdx === -1) {
      lines.push("", secHeader, "");
      secIdx = lines.length - 2;
    }

    let insertAt = secIdx + 1;
    while (insertAt < lines.length && !lines[insertAt].startsWith("## ")) insertAt++;

    const existing = new Set(lines.map((line) => line.trim()));
    const toInsert: string[] = [];
    for (const entry of normalized) {
      const line = `- [${today}] ${entry}`;
      if (!existing.has(line)) toInsert.push(line);
    }
    if (!toInsert.length) return phrenOk(0);

    lines.splice(insertAt, 0, ...toInsert, "");
    fs.writeFileSync(queuePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
    return phrenOk(toInsert.length);
  });
}

export function pruneDeadMemories(phrenPath: string, project?: string, dryRun?: boolean): PhrenResult<string> {
  const policy = getRetentionPolicy(phrenPath);
  if (project && !isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const dirs = project
    ? (() => {
      const resolvedProject = safeProjectPath(phrenPath, project);
      return resolvedProject ? [resolvedProject] : [];
    })()
    : getProjectDirs(phrenPath).filter((dir) => path.basename(dir) !== "global");
  let pruned = 0;
  const cutoffDays = policy.retentionDays;
  const dryRunDetails: string[] = [];

  for (const dir of dirs) {
    const file = resolveFindingsPath(dir);
    if (!file) continue;
    // Q23: wrap read-modify-write in per-file lock to prevent races with concurrent finding writers
    withFileLock(file, () => {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      let currentDate: string | null = null;
      const next: string[] = [];
      let inArchive = false;

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        // Detect archive block start (both <details> and phren:archive:start markers)
        if (isArchiveStartMeta(line)) {
          inArchive = true;
          next.push(line);
          continue;
        }
        // Detect archive block end
        if (isArchiveEndMeta(line)) {
          inArchive = false;
          next.push(line);
          continue;
        }
        const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
        if (heading) {
          currentDate = heading[1];
          next.push(line);
          continue;
        }
        if (line.startsWith("- ") && !inArchive && currentDate) {
          const age = Math.floor((Date.now() - Date.parse(`${currentDate}T00:00:00Z`)) / 86_400_000);
          if (!Number.isNaN(age) && age > cutoffDays) {
            pruned++;
            if (dryRun) dryRunDetails.push(`[${path.basename(dir)}] ${line.slice(0, 80)}`);
            const nextLine = lines[index + 1] || "";
            if (isCitationLine(nextLine)) {
              index++;
            }
            continue;
          }
        }
        if (isCitationLine(line)) {
          const previous = next.length ? next[next.length - 1] : "";
          if (!previous.startsWith("- ")) continue;
        }
        next.push(line);
      }
      if (!dryRun) {
        const tmpFile = file + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpFile, next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
        fs.renameSync(tmpFile, file);
      }
    });
  }

  if (dryRun) {
    const summary = `[dry-run] Would prune ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`;
    return phrenOk(dryRunDetails.length ? `${summary}\n${dryRunDetails.join("\n")}` : summary);
  }

  appendAuditLog(phrenPath, "prune_memories", `project=${project || "all"} pruned=${pruned}`);
  return phrenOk(`Pruned ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`);
}

function mergeLifecycleAndIdComments(primary: string, fallback: string): string {
  const extract = (line: string, pattern: RegExp): string | undefined => line.match(pattern)?.[0];
  const strip = (line: string): string => {
    let result = line.replace(/\s*<!--\s*fid:[a-z0-9]{8}\s*-->/gi, "");
    result = stripLifecycleMetadataMeta(result);
    return result;
  };

  const fid = extract(primary, METADATA_REGEX.findingId) ?? extract(fallback, METADATA_REGEX.findingId);
  const status = extract(primary, METADATA_REGEX.status) ?? extract(fallback, METADATA_REGEX.status);
  const statusUpdated = extract(primary, METADATA_REGEX.statusUpdated) ?? extract(fallback, METADATA_REGEX.statusUpdated);
  const statusReason = extract(primary, METADATA_REGEX.statusReason) ?? extract(fallback, METADATA_REGEX.statusReason);
  const statusRef = extract(primary, METADATA_REGEX.statusRef) ?? extract(fallback, METADATA_REGEX.statusRef);

  const base = strip(primary).trimEnd();
  const suffix = [fid, status, statusUpdated, statusReason, statusRef].filter((part): part is string => Boolean(part));
  return suffix.length > 0 ? `${base} ${suffix.join(" ")}` : base;
}

export function consolidateProjectFindings(phrenPath: string, project: string, dryRun?: boolean): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const file = resolveFindingsPath(path.join(phrenPath, project));
  if (!file) return phrenErr(`No FINDINGS.md found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  // Q23: wrap entire read-modify-write in per-file lock to prevent races with concurrent finding writers
  const result = withFileLock(file, (): PhrenResult<string> => {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");

    // Q12: Separate the file into "active" lines and verbatim archive/details blocks.
    // Archive blocks (<!-- phren:archive:start/end --> and <details>...</details>) are
    // collected verbatim and appended unchanged after the consolidated active section.
    const archiveBlocks: string[] = [];
    const activeLines: string[] = [];
    let inArchive = false;
    let currentArchiveBlock: string[] = [];

    for (const line of lines) {
      const archiveStart = isArchiveStartMeta(line);
      const archiveEnd = isArchiveEndMeta(line);

      if (!inArchive && archiveStart) {
        inArchive = true;
        currentArchiveBlock = [line];
        // If the start and end are on the same line, close immediately
        if (archiveEnd && isArchiveStartMeta(line) && isArchiveEndMeta(line)) {
          archiveBlocks.push(...currentArchiveBlock);
          currentArchiveBlock = [];
          inArchive = false;
        }
        continue;
      }
      if (inArchive) {
        currentArchiveBlock.push(line);
        if (archiveEnd) {
          archiveBlocks.push(...currentArchiveBlock);
          currentArchiveBlock = [];
          inArchive = false;
        }
        continue;
      }
      activeLines.push(line);
    }
    // Any unclosed archive block goes to archive verbatim
    if (currentArchiveBlock.length) archiveBlocks.push(...currentArchiveBlock);

    // Process only the active section: deduplicate bullets within each date group
    const byDate = new Map<string, Map<string, { bullet: string; citation?: string }>>();
    let currentDate: string | null = null;
    const title = activeLines.find((line: string) => line.startsWith("# ")) || `# ${project} Findings`;
    let totalBullets = 0;
    let uniqueBullets = 0;

    for (let index = 0; index < activeLines.length; index++) {
      const line = activeLines[index];
      const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
      if (heading) {
        const date = heading[1];
        currentDate = date;
        if (!byDate.has(date)) byDate.set(date, new Map<string, { bullet: string; citation?: string }>());
        continue;
      }
      if (line.startsWith("- ") && currentDate) {
        totalBullets++;
        const key = line.trim().toLowerCase().replace(METADATA_REGEX.findingId, "").replace(/\s+/g, " ");
        const nextLine = activeLines[index + 1] || "";
        const citation = isCitationLine(nextLine) ? nextLine : undefined;
        const trimmedBullet = line.trimEnd();
        const existing = byDate.get(currentDate)?.get(key);
        if (!existing) {
          byDate.get(currentDate)?.set(key, { bullet: trimmedBullet, citation });
          uniqueBullets++;
        } else {
          existing.bullet = mergeLifecycleAndIdComments(existing.bullet, trimmedBullet);
          if (!existing.citation && citation) existing.citation = citation;
        }
        if (citation) index++;
      }
    }

    const dates = [...byDate.keys()].sort().reverse();
    const duplicatesRemoved = totalBullets - uniqueBullets;

    if (dryRun) {
      return phrenOk(`[dry-run] ${project}: ${totalBullets} bullets, ${duplicatesRemoved} duplicate(s) would be removed, ${dates.length} date section(s).`);
    }

    // Reconstruct: consolidated active section first, then verbatim archive blocks
    const out: string[] = [title, ""];
    for (const date of dates) {
      const items = [...(byDate.get(date)?.values() || [])];
      if (!items.length) continue;
      out.push(`## ${date}`, "");
      for (const item of items) {
        out.push(item.bullet);
        if (item.citation) out.push(item.citation);
      }
      out.push("");
    }
    // Append archive blocks verbatim (separated by a blank line if there's active content)
    if (archiveBlocks.length) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(...archiveBlocks);
    }

    fs.copyFileSync(file, file + ".bak");
    const tmpFile = file + `.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpFile, out.join("\n").trimEnd() + "\n");
    fs.renameSync(tmpFile, file);
    appendAuditLog(phrenPath, "consolidate_project", `project=${project} dates=${dates.length}`);
    return phrenOk(`Consolidated findings for ${project}.`);
  });
  // Fire post-consolidate hook outside the file lock to avoid deadlock
  // if the hook command reads or writes FINDINGS.md.
  if (result.ok) {
    runCustomHooks(phrenPath, "post-consolidate", { PHREN_PROJECT: project });
  }
  return result;
}
