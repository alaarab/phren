import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import {
  debugLog,
  withDefaults,
  appendAuditLog,
  isRecord,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
  cortexOk,
  cortexErr,
  CortexError,
  type CortexResult,
} from "./shared.js";

type MemoryRole = "admin" | "maintainer" | "contributor" | "viewer";
type MemoryAction = "read" | "write" | "queue" | "pin" | "policy" | "delete";

interface AccessControl {
  schemaVersion?: number;
  admins?: string[];
  maintainers?: string[];
  contributors?: string[];
  viewers?: string[];
}

export interface AccessControlPatch {
  admins?: string[];
  maintainers?: string[];
  contributors?: string[];
  viewers?: string[];
}

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
  requireMaintainerApproval: boolean;
  lowConfidenceThreshold: number;
  riskySections: Array<"Review" | "Stale" | "Conflicts">;
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
}

export interface EntryScore {
  impressions: number;
  helpful: number;
  repromptPenalty: number;
  regressionPenalty: number;
  lastUsedAt: string;
}

interface CanonicalLock {
  hash: string;
  snapshot: string;
  updatedAt: string;
}

interface VersionedEntriesFile<T> {
  schemaVersion?: number;
  entries: Record<string, T>;
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

export const DEFAULT_RETENTION_POLICY = DEFAULT_POLICY;

const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  requireMaintainerApproval: true,
  lowConfidenceThreshold: 0.7,
  riskySections: ["Stale", "Conflicts"],
};

const DEFAULT_INDEX_POLICY: IndexPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  includeGlobs: [
    "**/*.md",
    ".claude/skills/**/*.md",
  ],
  excludeGlobs: [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
  ],
  includeHidden: false,
};

const DEFAULT_ACCESS: AccessControl = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  admins: [],
  maintainers: [],
  contributors: [],
  viewers: [],
};

const DEFAULT_RUNTIME_HEALTH: RuntimeHealth = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
};

const DEFAULT_MEMORY_SCORES_FILE: VersionedEntriesFile<EntryScore> = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  entries: {},
};

const DEFAULT_CANONICAL_LOCKS_FILE: VersionedEntriesFile<CanonicalLock> = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  entries: {},
};

function governanceDir(cortexPath: string): string {
  return path.join(cortexPath, ".governance");
}

type GovernanceSchema =
  | "access-control"
  | "retention-policy"
  | "workflow-policy"
  | "index-policy"
  | "runtime-health"
  | "memory-scores"
  | "canonical-locks";

function hasValidSchemaVersion(data: Record<string, unknown>): boolean {
  return !("schemaVersion" in data) || typeof data.schemaVersion === "number";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

function isEntryScore(value: unknown): value is EntryScore {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.impressions)
    && isFiniteNumber(value.helpful)
    && isFiniteNumber(value.repromptPenalty)
    && isFiniteNumber(value.regressionPenalty)
    && typeof value.lastUsedAt === "string";
}

function isCanonicalLock(value: unknown): value is CanonicalLock {
  if (!isRecord(value)) return false;
  return typeof value.hash === "string"
    && typeof value.snapshot === "string"
    && typeof value.updatedAt === "string";
}

function isVersionedEntries(data: Record<string, unknown>): boolean {
  return "entries" in data || "schemaVersion" in data;
}

function entriesObject(data: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(data.entries)) return data.entries;
  return data;
}

const GOVERNANCE_VALIDATORS: Record<GovernanceSchema, (data: Record<string, unknown>) => boolean> = {
  "access-control": (d) =>
    hasValidSchemaVersion(d) && ["admins", "maintainers", "contributors", "viewers"].every(
      (k) => !(k in d) || isStringArray(d[k])
    ),
  "retention-policy": (d) =>
    hasValidSchemaVersion(d)
    && ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"].every(
      (k) => !(k in d) || isFiniteNumber(d[k])
    )
    && (!("decay" in d) || (() => {
      if (!isRecord(d.decay)) return false;
      const decay = d.decay;
      return ["d30", "d60", "d90", "d120"].every((k) => !(k in decay) || isFiniteNumber(decay[k]));
    })()),
  "workflow-policy": (d) =>
    hasValidSchemaVersion(d)
    && (!("requireMaintainerApproval" in d) || typeof d.requireMaintainerApproval === "boolean")
    && (!("lowConfidenceThreshold" in d) || isFiniteNumber(d.lowConfidenceThreshold))
    && (!("riskySections" in d) || isStringArray(d.riskySections)),
  "index-policy": (d) =>
    hasValidSchemaVersion(d)
    && ["includeGlobs", "excludeGlobs"].every((k) => !(k in d) || isStringArray(d[k]))
    && (!("includeHidden" in d) || typeof d.includeHidden === "boolean"),
  "runtime-health": (d) =>
    hasValidSchemaVersion(d)
    && (!("lastSessionStartAt" in d) || typeof d.lastSessionStartAt === "string")
    && (!("lastPromptAt" in d) || typeof d.lastPromptAt === "string")
    && (!("lastStopAt" in d) || typeof d.lastStopAt === "string")
    && (!("lastAutoSave" in d) || (isRecord(d.lastAutoSave)
      && typeof d.lastAutoSave.at === "string"
      && ["clean", "saved-local", "saved-pushed", "error"].includes(String(d.lastAutoSave.status))
      && (!("detail" in d.lastAutoSave) || typeof d.lastAutoSave.detail === "string")))
    && (!("lastGovernance" in d) || (isRecord(d.lastGovernance)
      && typeof d.lastGovernance.at === "string"
      && ["ok", "error"].includes(String(d.lastGovernance.status))
      && typeof d.lastGovernance.detail === "string")),
  "memory-scores": (d) => {
    if (isVersionedEntries(d) && !hasValidSchemaVersion(d)) return false;
    if (isVersionedEntries(d) && !isRecord(d.entries)) return false;
    const entries = entriesObject(d);
    return Object.values(entries).every((entry) => isEntryScore(entry));
  },
  "canonical-locks": (d) => {
    if (isVersionedEntries(d) && !hasValidSchemaVersion(d)) return false;
    if (isVersionedEntries(d) && !isRecord(d.entries)) return false;
    const entries = entriesObject(d);
    return Object.values(entries).every((entry) => isCanonicalLock(entry));
  },
};

interface GovernanceRegistryEntry {
  file: string;
  validate: (data: Record<string, unknown>) => boolean;
  defaults: () => Record<string, unknown>;
  normalize: (data: Record<string, unknown>) => Record<string, unknown>;
}

const GOVERNANCE_REGISTRY: Record<GovernanceSchema, GovernanceRegistryEntry> = {
  "access-control": {
    file: "access-control.json",
    validate: GOVERNANCE_VALIDATORS["access-control"],
    defaults: () => ({ ...DEFAULT_ACCESS }),
    normalize: (d) => normalizeAccessControl(d) as unknown as Record<string, unknown>,
  },
  "retention-policy": {
    file: "retention-policy.json",
    validate: GOVERNANCE_VALIDATORS["retention-policy"],
    defaults: () => ({ ...DEFAULT_POLICY }),
    normalize: (d) => normalizeRetentionPolicy(d) as unknown as Record<string, unknown>,
  },
  "workflow-policy": {
    file: "workflow-policy.json",
    validate: GOVERNANCE_VALIDATORS["workflow-policy"],
    defaults: () => ({ ...DEFAULT_WORKFLOW_POLICY }),
    normalize: (d) => normalizeWorkflowPolicy(d) as unknown as Record<string, unknown>,
  },
  "index-policy": {
    file: "index-policy.json",
    validate: GOVERNANCE_VALIDATORS["index-policy"],
    defaults: () => ({ ...DEFAULT_INDEX_POLICY }),
    normalize: (d) => normalizeIndexPolicy(d) as unknown as Record<string, unknown>,
  },
  "runtime-health": {
    file: "runtime-health.json",
    validate: GOVERNANCE_VALIDATORS["runtime-health"],
    defaults: () => ({ ...DEFAULT_RUNTIME_HEALTH }),
    normalize: (d) => normalizeRuntimeHealth(d) as unknown as Record<string, unknown>,
  },
  "memory-scores": {
    file: "memory-scores.json",
    validate: GOVERNANCE_VALIDATORS["memory-scores"],
    defaults: () => ({ ...DEFAULT_MEMORY_SCORES_FILE }),
    normalize: (d) => normalizeVersionedEntries(d, isEntryScore) as unknown as Record<string, unknown>,
  },
  "canonical-locks": {
    file: "canonical-locks.json",
    validate: GOVERNANCE_VALIDATORS["canonical-locks"],
    defaults: () => ({ ...DEFAULT_CANONICAL_LOCKS_FILE }),
    normalize: (d) => normalizeVersionedEntries(d, isCanonicalLock) as unknown as Record<string, unknown>,
  },
};

const GOVERNANCE_FILE_SCHEMAS: Record<string, GovernanceSchema> = Object.fromEntries(
  Object.entries(GOVERNANCE_REGISTRY).map(([schema, entry]) => [entry.file, schema as GovernanceSchema])
);

export function validateGovernanceJson(filePath: string, schema: GovernanceSchema): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      debugLog(`validateGovernanceJson: ${filePath} is not a JSON object`);
      return false;
    }
    if (!GOVERNANCE_REGISTRY[schema].validate(data as Record<string, unknown>)) {
      debugLog(`validateGovernanceJson: ${filePath} failed ${schema} schema check`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    debugLog(`validateGovernanceJson parse error for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function extractGovernanceVersion(schema: GovernanceSchema, data: Record<string, unknown>): number {
  if (schema === "memory-scores" || schema === "canonical-locks") {
    return isVersionedEntries(data) && typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
  }
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
  return normalized;
}

function normalizeAccessControl(data: Record<string, unknown>): AccessControl {
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    admins: cleanStringArray(data.admins, DEFAULT_ACCESS.admins || []),
    maintainers: cleanStringArray(data.maintainers, DEFAULT_ACCESS.maintainers || []),
    contributors: cleanStringArray(data.contributors, DEFAULT_ACCESS.contributors || []),
    viewers: cleanStringArray(data.viewers, DEFAULT_ACCESS.viewers || []),
  };
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
  const riskySections = Array.isArray(data.riskySections)
    ? data.riskySections.filter((s): s is "Review" | "Stale" | "Conflicts" => validSections.has(String(s)))
    : [];
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    requireMaintainerApproval: pickBoolean(data.requireMaintainerApproval, DEFAULT_WORKFLOW_POLICY.requireMaintainerApproval),
    lowConfidenceThreshold: pickNumber(data.lowConfidenceThreshold, DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold),
    riskySections: riskySections.length ? riskySections : [...DEFAULT_WORKFLOW_POLICY.riskySections],
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

function normalizeVersionedEntries<T>(data: Record<string, unknown>, guard: (v: unknown) => v is T): VersionedEntriesFile<T> {
  const entries = entriesObject(data);
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (guard(value)) out[key] = value;
  }
  return { schemaVersion: GOVERNANCE_SCHEMA_VERSION, entries: out };
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
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fileVersion = schema ? extractGovernanceVersion(schema, parsed) : (typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0);
    if (fileVersion > GOVERNANCE_SCHEMA_VERSION) {
      debugLog(`Warning: ${filePath} has schemaVersion ${fileVersion}, expected <= ${GOVERNANCE_SCHEMA_VERSION}. Consider updating cortex.`);
    }
    return parsed as T;
  } catch (err: unknown) {
    debugLog(`readJsonFile failed for ${filePath}: ${errorMessage(err)}`);
    return fallback;
  }
}

export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  const maxWait = Number.parseInt(process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS || "5000", 10) || 5000;
  const pollInterval = Number.parseInt(process.env.CORTEX_FILE_LOCK_POLL_MS || "100", 10) || 100;
  const staleThreshold = Number.parseInt(process.env.CORTEX_FILE_LOCK_STALE_MS || "30000", 10) || 30000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms: number) => Atomics.wait(waiter, 0, 0, ms);

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let waited = 0;
  let hasLock = false;
  while (waited < maxWait) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      hasLock = true;
      break;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleThreshold) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        sleep(pollInterval);
        waited += pollInterval;
        continue;
      }
      sleep(pollInterval);
      waited += pollInterval;
    }
  }

  if (!hasLock) {
    const msg = `withFileLock: could not acquire lock for "${path.basename(filePath)}" within ${maxWait}ms`;
    debugLog(msg);
    throw new Error(msg);
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* lock may not exist */ }
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

function actorName(): string {
  const envActor = process.env.CORTEX_ACTOR || process.env.USER || process.env.USERNAME;
  if (envActor) return envActor;
  try {
    return os.userInfo().username;
  } catch (err: unknown) {
    debugLog(`actorName: os.userInfo() failed, using "unknown": ${errorMessage(err)}`);
    return "unknown";
  }
}

export interface GovernanceMigrationOptions {
  dryRun?: boolean;
}

export interface GovernanceMigrationResult {
  file: string;
  schema: GovernanceSchema;
  action: "missing" | "up-to-date" | "migrated" | "invalid-fallback" | "skipped-newer-version" | "error";
  fromVersion: number | null;
  toVersion: number;
  changed: boolean;
  detail?: string;
}

export interface GovernanceMigrationReport {
  schemaVersion: number;
  dryRun: boolean;
  migratedFiles: string[];
  results: GovernanceMigrationResult[];
}

export function migrateGovernance(cortexPath: string, options: GovernanceMigrationOptions = {}): GovernanceMigrationReport {
  const dryRun = !!options.dryRun;
  const report: GovernanceMigrationReport = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    dryRun,
    migratedFiles: [],
    results: [],
  };
  const govDir = governanceDir(cortexPath);

  for (const [fileName, schema] of Object.entries(GOVERNANCE_FILE_SCHEMAS)) {
    const filePath = path.join(govDir, fileName);
    if (!fs.existsSync(filePath)) {
      report.results.push({
        file: fileName,
        schema,
        action: "missing",
        fromVersion: null,
        toVersion: GOVERNANCE_SCHEMA_VERSION,
        changed: false,
      });
      continue;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const reg = GOVERNANCE_REGISTRY[schema];
      if (!isRecord(parsed)) {
        if (!dryRun) writeJsonFile(filePath, reg.defaults());
        report.results.push({
          file: fileName,
          schema,
          action: "invalid-fallback",
          fromVersion: null,
          toVersion: GOVERNANCE_SCHEMA_VERSION,
          changed: true,
          detail: "file is not a JSON object",
        });
        report.migratedFiles.push(fileName);
        continue;
      }

      const fromVersion = extractGovernanceVersion(schema, parsed);
      if (fromVersion > GOVERNANCE_SCHEMA_VERSION) {
        report.results.push({
          file: fileName,
          schema,
          action: "skipped-newer-version",
          fromVersion,
          toVersion: fromVersion,
          changed: false,
          detail: `file schemaVersion ${fromVersion} is newer than supported ${GOVERNANCE_SCHEMA_VERSION}`,
        });
        continue;
      }

      const valid = reg.validate(parsed);
      const next = valid ? reg.normalize(parsed) : reg.defaults();
      const changed = JSON.stringify(parsed) !== JSON.stringify(next);
      const action = valid ? (changed ? "migrated" : "up-to-date") : "invalid-fallback";

      if (changed) {
        if (!dryRun) writeJsonFile(filePath, next);
        report.migratedFiles.push(fileName);
      }

      report.results.push({
        file: fileName,
        schema,
        action,
        fromVersion,
        toVersion: GOVERNANCE_SCHEMA_VERSION,
        changed,
        detail: valid ? undefined : "failed schema validation; defaulted to safe shape",
      });
    } catch (err: unknown) {
      report.results.push({
        file: fileName,
        schema,
        action: "error",
        fromVersion: null,
        toVersion: GOVERNANCE_SCHEMA_VERSION,
        changed: false,
        detail: errorMessage(err),
      });
      debugLog(`migrateGovernance: failed to process ${fileName}: ${errorMessage(err)}`);
    }
  }

  return report;
}

export function migrateGovernanceFiles(cortexPath: string): string[] {
  return migrateGovernance(cortexPath).migratedFiles;
}

function govFile(cortexPath: string, schema: GovernanceSchema): string {
  return path.join(governanceDir(cortexPath), GOVERNANCE_REGISTRY[schema].file);
}

function usageLogFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "memory-usage.log");
}

function scoresJournalFile(cortexPath: string): string {
  const dir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "scores.jsonl");
}

interface ScoreJournalEntry {
  key: string;
  delta: { impressions?: number; helpful?: number; repromptPenalty?: number; regressionPenalty?: number };
  at: string;
}

function appendScoreJournal(cortexPath: string, key: string, delta: ScoreJournalEntry["delta"]): void {
  const file = scoresJournalFile(cortexPath);
  const entry: ScoreJournalEntry = { key, delta, at: new Date().toISOString() };
  withFileLock(file, () => {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  });
}

function readScoreJournal(cortexPath: string): ScoreJournalEntry[] {
  const file = scoresJournalFile(cortexPath);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as ScoreJournalEntry; }
        catch { return null; }
      })
      .filter((e): e is ScoreJournalEntry => e !== null);
  } catch {
    return [];
  }
}

function claimScoreJournal(cortexPath: string): ScoreJournalEntry[] {
  const file = scoresJournalFile(cortexPath);
  let claimedFile: string | null = null;
  withFileLock(file, () => {
    if (!fs.existsSync(file)) return;
    claimedFile = `${file}.${crypto.randomUUID()}.claim`;
    fs.renameSync(file, claimedFile);
    fs.writeFileSync(file, "");
  });
  if (!claimedFile) return [];
  try {
    return fs.readFileSync(claimedFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as ScoreJournalEntry; }
        catch { return null; }
      })
      .filter((e): e is ScoreJournalEntry => e !== null);
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(claimedFile); } catch { /* best effort */ }
  }
}

function aggregateJournalScores(entries: ScoreJournalEntry[]): Record<string, { impressions: number; helpful: number; repromptPenalty: number; regressionPenalty: number }> {
  const agg: Record<string, { impressions: number; helpful: number; repromptPenalty: number; regressionPenalty: number }> = {};
  for (const entry of entries) {
    if (!agg[entry.key]) agg[entry.key] = { impressions: 0, helpful: 0, repromptPenalty: 0, regressionPenalty: 0 };
    const a = agg[entry.key];
    if (entry.delta.impressions) a.impressions += entry.delta.impressions;
    if (entry.delta.helpful) a.helpful += entry.delta.helpful;
    if (entry.delta.repromptPenalty) a.repromptPenalty += entry.delta.repromptPenalty;
    if (entry.delta.regressionPenalty) a.regressionPenalty += entry.delta.regressionPenalty;
  }
  return agg;
}

function resolveRole(cortexPath: string, actor: string = actorName()): MemoryRole {
  const acl = readJsonFile<AccessControl>(govFile(cortexPath, "access-control"), DEFAULT_ACCESS);
  if ((acl.admins || []).includes(actor)) return "admin";
  if ((acl.maintainers || []).includes(actor)) return "maintainer";
  if ((acl.contributors || []).includes(actor)) return "contributor";
  if ((acl.viewers || []).includes(actor)) return "viewer";
  return "viewer";
}

export function getAccessControl(cortexPath: string): AccessControl {
  const parsed = readJsonFile<Partial<AccessControl>>(govFile(cortexPath, "access-control"), {});
  return withDefaults(parsed, DEFAULT_ACCESS);
}

export function updateAccessControl(cortexPath: string, patch: AccessControlPatch): CortexResult<AccessControl> {
  const denial = checkPermission(cortexPath, "policy");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const current = getAccessControl(cortexPath);
  const next: AccessControl = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    admins: patch.admins ?? current.admins ?? [],
    maintainers: patch.maintainers ?? current.maintainers ?? [],
    contributors: patch.contributors ?? current.contributors ?? [],
    viewers: patch.viewers ?? current.viewers ?? [],
  };
  writeJsonFile(govFile(cortexPath, "access-control"), next);
  appendAuditLog(cortexPath, "update_access", JSON.stringify(next));
  return cortexOk(next);
}

function can(role: MemoryRole, action: MemoryAction): boolean {
  if (role === "admin") return true;
  if (role === "maintainer") return action !== "policy";
  if (role === "contributor") return action === "read" || action === "write" || action === "queue";
  return action === "read";
}

export function checkPermission(cortexPath: string, action: MemoryAction, actor?: string): string | null {
  const role = resolveRole(cortexPath, actor);
  if (can(role, action)) return null;
  return `Permission denied for ${actor || actorName()} (role=${role}) on action=${action}.`;
}

export function getRetentionPolicy(cortexPath: string): RetentionPolicy {
  const parsed = readJsonFile<Partial<RetentionPolicy>>(govFile(cortexPath, "retention-policy"), {});
  return withDefaults(parsed, DEFAULT_POLICY);
}

export function updateRetentionPolicy(cortexPath: string, patch: Partial<RetentionPolicy>): CortexResult<RetentionPolicy> {
  const denial = checkPermission(cortexPath, "policy");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const current = getRetentionPolicy(cortexPath);
  const next: RetentionPolicy = {
    ...current,
    ...patch,
    decay: {
      ...current.decay,
      ...(patch.decay || {}),
    },
  };
  writeJsonFile(govFile(cortexPath, "retention-policy"), next);
  appendAuditLog(cortexPath, "update_policy", JSON.stringify(next));
  return cortexOk(next);
}

export function getWorkflowPolicy(cortexPath: string): WorkflowPolicy {
  const parsed = readJsonFile<Partial<WorkflowPolicy>>(govFile(cortexPath, "workflow-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_WORKFLOW_POLICY);
  const validSections = new Set(["Review", "Stale", "Conflicts"]);
  merged.riskySections = merged.riskySections.filter((s) => validSections.has(s));
  if (!merged.riskySections.length) merged.riskySections = DEFAULT_WORKFLOW_POLICY.riskySections;
  return merged;
}

export function updateWorkflowPolicy(
  cortexPath: string,
  patch: Partial<WorkflowPolicy>
): CortexResult<WorkflowPolicy> {
  const denial = checkPermission(cortexPath, "policy");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const current = getWorkflowPolicy(cortexPath);
  const riskySections = Array.isArray(patch.riskySections)
    ? patch.riskySections.filter((s): s is "Review" | "Stale" | "Conflicts" => ["Review", "Stale", "Conflicts"].includes(String(s)))
    : current.riskySections;
  const next: WorkflowPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    requireMaintainerApproval: patch.requireMaintainerApproval ?? current.requireMaintainerApproval,
    lowConfidenceThreshold: patch.lowConfidenceThreshold ?? current.lowConfidenceThreshold,
    riskySections: riskySections.length ? riskySections : current.riskySections,
  };
  writeJsonFile(govFile(cortexPath, "workflow-policy"), next);
  appendAuditLog(cortexPath, "update_workflow_policy", JSON.stringify(next));
  return cortexOk(next);
}

export function getIndexPolicy(cortexPath: string): IndexPolicy {
  const parsed = readJsonFile<Partial<IndexPolicy>>(govFile(cortexPath, "index-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_INDEX_POLICY);
  merged.includeGlobs = merged.includeGlobs.filter((g) => typeof g === "string" && g.trim().length > 0);
  merged.excludeGlobs = merged.excludeGlobs.filter((g) => typeof g === "string" && g.trim().length > 0);
  if (!merged.includeGlobs.length) merged.includeGlobs = DEFAULT_INDEX_POLICY.includeGlobs;
  if (!merged.excludeGlobs.length) merged.excludeGlobs = DEFAULT_INDEX_POLICY.excludeGlobs;
  return merged;
}

export function updateIndexPolicy(cortexPath: string, patch: Partial<IndexPolicy>): CortexResult<IndexPolicy> {
  const denial = checkPermission(cortexPath, "policy");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const current = getIndexPolicy(cortexPath);
  const next: IndexPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    includeGlobs: Array.isArray(patch.includeGlobs)
      ? patch.includeGlobs.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : current.includeGlobs,
    excludeGlobs: Array.isArray(patch.excludeGlobs)
      ? patch.excludeGlobs.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : current.excludeGlobs,
    includeHidden: patch.includeHidden ?? current.includeHidden,
  };
  writeJsonFile(govFile(cortexPath, "index-policy"), next);
  appendAuditLog(cortexPath, "update_index_policy", JSON.stringify(next));
  return cortexOk(next);
}

export function getRuntimeHealth(cortexPath: string): RuntimeHealth {
  const parsed = readJsonFile<Record<string, unknown>>(govFile(cortexPath, "runtime-health"), {});
  if (!isRecord(parsed)) return { ...DEFAULT_RUNTIME_HEALTH };
  return normalizeRuntimeHealth(parsed);
}

export function updateRuntimeHealth(cortexPath: string, patch: Partial<RuntimeHealth>): RuntimeHealth {
  const file = govFile(cortexPath, "runtime-health");
  return withFileLock(file, () => {
    const parsed = readJsonFile<Record<string, unknown>>(file, {});
    const current = isRecord(parsed) ? normalizeRuntimeHealth(parsed) : { ...DEFAULT_RUNTIME_HEALTH };
    const next: RuntimeHealth = {
      schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
      ...current,
      ...patch,
      lastAutoSave: patch.lastAutoSave ?? current.lastAutoSave,
      lastGovernance: patch.lastGovernance ?? current.lastGovernance,
    };
    writeJsonFileUnlocked(file, next);
    return next;
  });
}

let _scoresCache: Record<string, EntryScore> | null = null;
let _scoresCachePath: string | null = null;
let _scoresDirty = false;

function loadEntryScores(cortexPath: string): Record<string, EntryScore> {
  const file = govFile(cortexPath, "memory-scores");
  if (_scoresCache && _scoresCachePath === file) return _scoresCache;
  const parsed = readJsonFile<Record<string, unknown>>(file, {});
  _scoresCache = isRecord(parsed) ? normalizeVersionedEntries(parsed, isEntryScore).entries : {};
  _scoresCachePath = file;
  _scoresDirty = false;
  return _scoresCache;
}

export function loadCanonicalLocks(cortexPath: string): Record<string, CanonicalLock> {
  const parsed = readJsonFile<Record<string, unknown>>(govFile(cortexPath, "canonical-locks"), {});
  if (!isRecord(parsed)) return {};
  return normalizeVersionedEntries(parsed, isCanonicalLock).entries;
}

export function saveCanonicalLocks(cortexPath: string, locks: Record<string, CanonicalLock>) {
  writeJsonFile(govFile(cortexPath, "canonical-locks"), {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    entries: locks,
  } satisfies VersionedEntriesFile<CanonicalLock>);
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function saveEntryScores(cortexPath: string, scores: Record<string, EntryScore>) {
  _scoresCache = scores;
  _scoresCachePath = govFile(cortexPath, "memory-scores");
  _scoresDirty = true;
}

export function flushEntryScores(cortexPath: string): void {
  const journalEntries = claimScoreJournal(cortexPath);
  if (journalEntries.length > 0) {
    const scores = loadEntryScores(cortexPath);
    const agg = aggregateJournalScores(journalEntries);
    for (const [key, deltas] of Object.entries(agg)) {
      const entry = ensureScoreEntry(scores, key);
      entry.impressions += deltas.impressions;
      entry.helpful += deltas.helpful;
      entry.repromptPenalty += deltas.repromptPenalty;
      entry.regressionPenalty += deltas.regressionPenalty;
    }
    _scoresCache = scores;
    _scoresDirty = true;
  }

  if (_scoresDirty && _scoresCache && _scoresCachePath === govFile(cortexPath, "memory-scores")) {
    writeJsonFile(_scoresCachePath, {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      entries: _scoresCache,
    } satisfies VersionedEntriesFile<EntryScore>);
    _scoresDirty = false;
  }
}

function ensureScoreEntry(scores: Record<string, EntryScore>, key: string): EntryScore {
  if (!scores[key]) {
    scores[key] = {
      impressions: 0,
      helpful: 0,
      repromptPenalty: 0,
      regressionPenalty: 0,
      lastUsedAt: new Date(0).toISOString(),
    };
  }
  return scores[key];
}

export function entryScoreKey(project: string, filename: string, snippet: string): string {
  const short = snippet.replace(/\s+/g, " ").slice(0, 200);
  const digest = crypto.createHash("sha1").update(`${project}:${filename}:${short}`).digest("hex").slice(0, 12);
  return `${project}/${filename}:${digest}`;
}

export function recordInjection(cortexPath: string, key: string, sessionId?: string): void {
  appendScoreJournal(cortexPath, key, { impressions: 1 });
  const session = sessionId || "none";
  const logFile = usageLogFile(cortexPath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    `${new Date().toISOString()}\tinject\t${session}\t${key}\n`
  );
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > 1_000_000) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(logFile, lines.slice(-500).join("\n"));
    }
  } catch (err: unknown) {
    debugLog(`Usage log rotation failed: ${errorMessage(err)}`);
  }
}

export function recordFeedback(
  cortexPath: string,
  key: string,
  feedback: "helpful" | "reprompt" | "regression"
): void {
  const delta: ScoreJournalEntry["delta"] = {};
  if (feedback === "helpful") delta.helpful = 1;
  if (feedback === "reprompt") delta.repromptPenalty = 1;
  if (feedback === "regression") delta.regressionPenalty = 1;
  appendScoreJournal(cortexPath, key, delta);
  appendAuditLog(cortexPath, "memory_feedback", `key=${key} feedback=${feedback}`);
}

export function getQualityMultiplier(cortexPath: string, key: string): number {
  const scores = loadEntryScores(cortexPath);
  const entry = scores[key];
  let helpful = entry ? entry.helpful : 0;
  let repromptPenalty = entry ? entry.repromptPenalty : 0;
  let regressionPenalty = entry ? entry.regressionPenalty : 0;
  let impressions = entry ? entry.impressions : 0;
  let lastUsedAt = entry ? entry.lastUsedAt : "";

  // Include unflushed journal deltas
  const journalEntries = readScoreJournal(cortexPath).filter(e => e.key === key);
  for (const je of journalEntries) {
    if (je.delta.helpful) helpful += je.delta.helpful;
    if (je.delta.repromptPenalty) repromptPenalty += je.delta.repromptPenalty;
    if (je.delta.regressionPenalty) regressionPenalty += je.delta.regressionPenalty;
    if (je.delta.impressions) impressions += je.delta.impressions;
    // Track most recent journal timestamp as lastUsedAt
    if (je.at && (!lastUsedAt || je.at > lastUsedAt)) lastUsedAt = je.at;
  }

  if (!entry && journalEntries.length === 0) return 1;

  // ACT-R activation scoring components:

  // 1. Temporal decay: recency of last retrieval
  let recencyBoost = 0;
  if (lastUsedAt) {
    const lastUsedMs = new Date(lastUsedAt).getTime();
    if (!Number.isNaN(lastUsedMs)) {
      const daysSinceUse = Math.max(0, (Date.now() - lastUsedMs) / 86_400_000);
      if (daysSinceUse <= 7) {
        recencyBoost = 0.15;          // recently used: boost
      } else if (daysSinceUse <= 30) {
        recencyBoost = 0;             // neutral
      } else {
        recencyBoost = -0.1 * Math.min(3, (daysSinceUse - 30) / 30); // decay up to -0.3
      }
    }
  }

  // 2. Usage frequency: log-scaled impressions (diminishing returns)
  const frequencyBoost = impressions > 0 ? Math.min(0.2, Math.log2(impressions + 1) * 0.05) : 0;

  // 3. Feedback signals (existing)
  const penalties = repromptPenalty + regressionPenalty * 2;
  const feedbackScore = helpful * 0.15 - penalties * 0.2;

  // Combine all components
  const raw = 1 + feedbackScore + recencyBoost + frequencyBoost;
  return Math.max(0.2, Math.min(1.5, raw));
}

interface RetrievalLogEntry {
  file: string;
  section: string;
  retrievedAt: string;
}

export function recordRetrieval(cortexPath: string, file: string, section: string): void {
  const dir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "retrieval-log.jsonl");
  const entry: RetrievalLogEntry = { file, section, retrievedAt: new Date().toISOString() };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");

  // Truncate to last 1000 lines if >500KB (same pattern as audit log)
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 500_000) {
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      fs.writeFileSync(logPath, lines.slice(-1000).join("\n") + "\n");
    }
  } catch {
    // best effort
  }
}

function readRetrievalLog(cortexPath: string): RetrievalLogEntry[] {
  const logPath = path.join(cortexPath, ".runtime", "retrieval-log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as RetrievalLogEntry; }
        catch { return null; }
      })
      .filter((e): e is RetrievalLogEntry => e !== null);
  } catch {
    return [];
  }
}

export function pruneDeadMemories(cortexPath: string, project?: string, dryRun?: boolean): CortexResult<string> {
  const denial = checkPermission(cortexPath, "delete");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const policy = getRetentionPolicy(cortexPath);
  if (project && !isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const dirs = project
    ? (() => { const p = safeProjectPath(cortexPath, project); return p ? [p] : []; })()
    : getProjectDirs(cortexPath).filter((d) => path.basename(d) !== "global");
  let pruned = 0;
  const cutoffDays = policy.retentionDays;
  const dryRunDetails: string[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, "FINDINGS.md");
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    let currentDate: string | null = null;
    const next: string[] = [];
    let inDetails = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("<details>")) { inDetails = true; next.push(line); continue; }
      if (line.includes("</details>")) { inDetails = false; next.push(line); continue; }
      const m = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
      if (m) {
        currentDate = m[1];
        next.push(line);
        continue;
      }
      if (line.startsWith("- ") && !inDetails && currentDate) {
        const age = Math.floor((Date.now() - Date.parse(`${currentDate}T00:00:00Z`)) / 86_400_000);
        if (!Number.isNaN(age) && age > cutoffDays) {
          pruned++;
          if (dryRun) dryRunDetails.push(`[${path.basename(dir)}] ${line.slice(0, 80)}`);
          const nextLine = lines[i + 1] || "";
          if (nextLine.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/)) {
            i++;
          }
          continue;
        }
      }
      if (line.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/)) {
        const prev = next.length ? next[next.length - 1] : "";
        if (!prev.startsWith("- ")) continue;
      }
      next.push(line);
    }
    if (!dryRun) {
      fs.copyFileSync(file, file + ".bak");
      fs.writeFileSync(file, next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
    }
  }

  if (dryRun) {
    const summary = `[dry-run] Would prune ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`;
    return cortexOk(dryRunDetails.length ? `${summary}\n${dryRunDetails.join("\n")}` : summary);
  }

  appendAuditLog(cortexPath, "prune_memories", `project=${project || "all"} pruned=${pruned}`);
  return cortexOk(`Pruned ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`);
}

export function enforceCanonicalLocks(cortexPath: string, project?: string): string {
  const locks = loadCanonicalLocks(cortexPath);
  const projects = project
    ? [project]
    : getProjectDirs(cortexPath).map((d) => path.basename(d)).filter((p) => p !== "global");
  let restored = 0;
  let checked = 0;

  for (const p of projects) {
    const file = path.join(cortexPath, p, "CANONICAL_MEMORIES.md");
    if (!fs.existsSync(file)) continue;
    checked++;
    const content = fs.readFileSync(file, "utf8");
    const key = `${p}/CANONICAL_MEMORIES.md`;
    const lock = locks[key];
    if (!lock) {
      locks[key] = { hash: hashContent(content), snapshot: content, updatedAt: new Date().toISOString() };
      continue;
    }
    const currentHash = hashContent(content);
    if (currentHash === lock.hash) continue;
    fs.writeFileSync(file, lock.snapshot);
    appendReviewQueue(cortexPath, p, "Conflicts", ["Canonical memory drift detected and auto-restored"]);
    appendAuditLog(cortexPath, "canonical_restore", `project=${p}`);
    restored++;
  }

  saveCanonicalLocks(cortexPath, locks);
  return `Canonical locks checked=${checked}, restored=${restored}`;
}

export function consolidateProjectFindings(cortexPath: string, project: string, dryRun?: boolean): CortexResult<string> {
  const denial = checkPermission(cortexPath, "delete");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const file = path.join(cortexPath, project, "FINDINGS.md");
  if (!fs.existsSync(file)) return cortexErr(`No FINDINGS.md found for "${project}".`, CortexError.FILE_NOT_FOUND);

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const byDate = new Map<string, Map<string, { bullet: string; citation?: string }>>();
  let currentDate: string | null = null;
  const title = lines.find((l) => l.startsWith("# ")) || `# ${project} Findings`;
  let totalBullets = 0;
  let uniqueBullets = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (heading) {
      currentDate = heading[1];
      if (!byDate.has(currentDate)) byDate.set(currentDate, new Map());
      continue;
    }
    if (line.startsWith("- ") && currentDate) {
      totalBullets++;
      const key = line.trim().toLowerCase().replace(/\s+/g, " ");
      const nextLine = lines[i + 1] || "";
      const citation = nextLine.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/) ? nextLine : undefined;
      const trimmedBullet = line.trimEnd();
      const existing = byDate.get(currentDate)!.get(key);
      if (!existing) {
        byDate.get(currentDate)!.set(key, { bullet: trimmedBullet, citation });
        uniqueBullets++;
      } else if (!existing.citation && citation) {
        existing.citation = citation;
      }
      if (citation) i++;
    }
  }

  const dates = [...byDate.keys()].sort().reverse();
  const duplicatesRemoved = totalBullets - uniqueBullets;

  if (dryRun) {
    return cortexOk(`[dry-run] ${project}: ${totalBullets} bullets, ${duplicatesRemoved} duplicate(s) would be removed, ${dates.length} date section(s).`);
  }

  const out: string[] = [title, ""];
  for (const d of dates) {
    const items = [...(byDate.get(d)?.values() || [])];
    if (!items.length) continue;
    out.push(`## ${d}`, "");
    for (const item of items) {
      out.push(item.bullet);
      if (item.citation) out.push(item.citation);
    }
    out.push("");
  }
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, out.join("\n").trimEnd() + "\n");
  appendAuditLog(cortexPath, "consolidate_project", `project=${project} dates=${dates.length}`);
  return cortexOk(`Consolidated findings for ${project}.`);
}

function normalizeBulletForQueue(line: string): string {
  return line.startsWith("- ") ? line.slice(2).trim() : line.trim();
}

export function appendReviewQueue(
  cortexPath: string,
  project: string,
  section: "Review" | "Stale" | "Conflicts",
  entries: string[]
): CortexResult<number> {
  const denial = checkPermission(cortexPath, "queue");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
  const queuePath = path.join(resolvedDir, "MEMORY_QUEUE.md");
  const today = new Date().toISOString().slice(0, 10);

  const normalized = entries.map(normalizeBulletForQueue).filter(Boolean);
  if (normalized.length === 0) return cortexOk(0);

  let content = "";
  if (fs.existsSync(queuePath)) {
    content = fs.readFileSync(queuePath, "utf8");
  } else {
    content = `# ${project} Memory Queue\n\n## Review\n\n## Stale\n\n## Conflicts\n`;
  }

  const lines = content.split("\n");
  const secHeader = `## ${section}`;
  let secIdx = lines.findIndex((l) => l.trim() === secHeader);
  if (secIdx === -1) {
    lines.push("", secHeader, "");
    secIdx = lines.length - 2;
  }

  let insertAt = secIdx + 1;
  while (insertAt < lines.length && !lines[insertAt].startsWith("## ")) insertAt++;

  const existing = new Set(lines.map((l) => l.trim()));
  const toInsert: string[] = [];
  for (const entry of normalized) {
    const line = `- [${today}] ${entry}`;
    if (!existing.has(line)) toInsert.push(line);
  }
  if (!toInsert.length) return cortexOk(0);

  lines.splice(insertAt, 0, ...toInsert, "");
  fs.writeFileSync(queuePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  return cortexOk(toInsert.length);
}
