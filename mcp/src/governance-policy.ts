import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendAuditLog, debugLog, getProjectDirs, isRecord, runtimeFile, withDefaults, cortexErr, CortexError, cortexOk, type CortexResult, resolveFindingsPath } from "./shared.js";
import { withFileLock } from "./governance-locks.js";
import { errorMessage, isValidProjectName, safeProjectPath } from "./utils.js";
import { runCustomHooks } from "./hooks.js";

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
  taskMode: "off" | "manual" | "suggest" | "auto";
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

const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  requireMaintainerApproval: true,
  lowConfidenceThreshold: 0.7,
  riskySections: ["Stale", "Conflicts"],
  taskMode: "manual",
};

const DEFAULT_INDEX_POLICY: IndexPolicy = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  includeGlobs: ["**/*.md", "**/skills/**/*.md", ".claude/skills/**/*.md"],
  excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
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

const DEFAULT_CANONICAL_LOCKS_FILE: VersionedEntriesFile<CanonicalLock> = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  entries: {},
};

const LOCAL_ACCESS_FILE = "access-control.local.json";

function governanceDir(cortexPath: string): string {
  return path.join(cortexPath, ".governance");
}

type GovernanceSchema =
  | "access-control"
  | "retention-policy"
  | "workflow-policy"
  | "index-policy"
  | "runtime-health"
  | "canonical-locks";

function govFile(cortexPath: string, schema: GovernanceSchema): string {
  return path.join(governanceDir(cortexPath), GOVERNANCE_REGISTRY[schema].file);
}

function localAccessFile(cortexPath: string): string {
  return runtimeFile(cortexPath, LOCAL_ACCESS_FILE);
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
  "access-control": (data) =>
    hasValidSchemaVersion(data) && ["admins", "maintainers", "contributors", "viewers"].every(
      (key) => !(key in data) || isStringArray(data[key]),
    ),
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
    && (!("requireMaintainerApproval" in data) || typeof data.requireMaintainerApproval === "boolean")
    && (!("lowConfidenceThreshold" in data) || isFiniteNumber(data.lowConfidenceThreshold))
    && (!("riskySections" in data) || isStringArray(data.riskySections))
    && (!("taskMode" in data) || ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))),
  "index-policy": (data) =>
    hasValidSchemaVersion(data)
    && ["includeGlobs", "excludeGlobs"].every((key) => !(key in data) || isStringArray(data[key]))
    && (!("includeHidden" in data) || typeof data.includeHidden === "boolean"),
  "runtime-health": (data) =>
    hasValidSchemaVersion(data)
    && (!("lastSessionStartAt" in data) || typeof data.lastSessionStartAt === "string")
    && (!("lastPromptAt" in data) || typeof data.lastPromptAt === "string")
    && (!("lastStopAt" in data) || typeof data.lastStopAt === "string")
    && (!("lastAutoSave" in data) || (isRecord(data.lastAutoSave)
      && typeof data.lastAutoSave.at === "string"
      && ["clean", "saved-local", "saved-pushed", "error"].includes(String(data.lastAutoSave.status))
      && (!("detail" in data.lastAutoSave) || typeof data.lastAutoSave.detail === "string")))
    && (!("lastGovernance" in data) || (isRecord(data.lastGovernance)
      && typeof data.lastGovernance.at === "string"
      && ["ok", "error"].includes(String(data.lastGovernance.status))
      && typeof data.lastGovernance.detail === "string"))
    && (!("lastSync" in data) || (isRecord(data.lastSync)
      && (!("lastPullAt" in data.lastSync) || typeof data.lastSync.lastPullAt === "string")
      && (!("lastPullStatus" in data.lastSync) || ["ok", "error"].includes(String(data.lastSync.lastPullStatus)))
      && (!("lastPullDetail" in data.lastSync) || typeof data.lastSync.lastPullDetail === "string")
      && (!("lastSuccessfulPullAt" in data.lastSync) || typeof data.lastSync.lastSuccessfulPullAt === "string")
      && (!("lastPushAt" in data.lastSync) || typeof data.lastSync.lastPushAt === "string")
      && (!("lastPushStatus" in data.lastSync) || ["saved-local", "saved-pushed", "error"].includes(String(data.lastSync.lastPushStatus)))
      && (!("lastPushDetail" in data.lastSync) || typeof data.lastSync.lastPushDetail === "string")
      && (!("unsyncedCommits" in data.lastSync) || isFiniteNumber(data.lastSync.unsyncedCommits)))),
  "canonical-locks": (data) => {
    if (isVersionedEntries(data) && !hasValidSchemaVersion(data)) return false;
    if (isVersionedEntries(data) && !isRecord(data.entries)) return false;
    return Object.values(entriesObject(data)).every((entry) => isCanonicalLock(entry));
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
    normalize: (data) => normalizeAccessControl(data) as unknown as Record<string, unknown>,
  },
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
  "runtime-health": {
    file: "runtime-health.json",
    validate: GOVERNANCE_VALIDATORS["runtime-health"],
    defaults: () => ({ ...DEFAULT_RUNTIME_HEALTH }),
    normalize: (data) => normalizeRuntimeHealth(data) as unknown as Record<string, unknown>,
  },
  "canonical-locks": {
    file: "canonical-locks.json",
    validate: GOVERNANCE_VALIDATORS["canonical-locks"],
    defaults: () => ({ ...DEFAULT_CANONICAL_LOCKS_FILE }),
    normalize: (data) => normalizeVersionedEntries(data, isCanonicalLock) as unknown as Record<string, unknown>,
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

function extractGovernanceVersion(schema: GovernanceSchema, data: Record<string, unknown>): number {
  if (schema === "canonical-locks") {
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
  const taskMode = ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))
    ? String(data.taskMode) as WorkflowPolicy["taskMode"]
    : DEFAULT_WORKFLOW_POLICY.taskMode;
  const riskySections = Array.isArray(data.riskySections)
    ? data.riskySections.filter((section): section is "Review" | "Stale" | "Conflicts" => validSections.has(String(section)))
    : [];
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    requireMaintainerApproval: pickBoolean(data.requireMaintainerApproval, DEFAULT_WORKFLOW_POLICY.requireMaintainerApproval),
    lowConfidenceThreshold: pickNumber(data.lowConfidenceThreshold, DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold),
    riskySections: riskySections.length ? riskySections : [...DEFAULT_WORKFLOW_POLICY.riskySections],
    taskMode,
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

function normalizeVersionedEntries<T>(data: Record<string, unknown>, guard: (value: unknown) => value is T): VersionedEntriesFile<T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(entriesObject(data))) {
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
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
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

function allowEnvironmentActorOverride(): boolean {
  return process.env.CORTEX_TRUST_ENV_ACTOR === "1"
    || process.env.VITEST_WORKER_ID !== undefined
    || process.env.NODE_ENV === "test";
}

function actorName(): string {
  if (allowEnvironmentActorOverride()) {
    const envActor = process.env.CORTEX_ACTOR?.trim();
    if (envActor) return envActor;
  }
  try {
    return os.userInfo().username;
  } catch (err: unknown) {
    debugLog(`actorName: os.userInfo() failed, using "unknown": ${errorMessage(err)}`);
    return "unknown";
  }
}

export function getCurrentActor(): string {
  return actorName();
}

function roleFromAccessControl(acl: AccessControl, actor: string): MemoryRole | null {
  if ((acl.admins || []).includes(actor)) return "admin";
  if ((acl.maintainers || []).includes(actor)) return "maintainer";
  if ((acl.contributors || []).includes(actor)) return "contributor";
  if ((acl.viewers || []).includes(actor)) return "viewer";
  return null;
}

function hasAnyAssignedRole(acl: AccessControl): boolean {
  return [...(acl.admins || []), ...(acl.maintainers || []), ...(acl.contributors || []), ...(acl.viewers || [])].length > 0;
}

function getLocalAccessControl(cortexPath: string): AccessControl {
  const parsed = readJsonFile<Record<string, unknown>>(localAccessFile(cortexPath), {});
  if (!isRecord(parsed)) return { ...DEFAULT_ACCESS };
  return normalizeAccessControl(parsed);
}

function writeLocalAccessControl(cortexPath: string, next: AccessControl): void {
  const file = localAccessFile(cortexPath);
  withFileLock(file, () => {
    writeJsonFileUnlocked(file, next);
  });
}

export function ensureLocalActorAccess(cortexPath: string, actor: string = actorName()): { updated: boolean; role?: MemoryRole; reason?: string } {
  const normalizedActor = actor.trim();
  if (!normalizedActor || normalizedActor === "unknown") {
    return { updated: false, reason: "actor-unavailable" };
  }

  const aclPath = govFile(cortexPath, "access-control");
  if (!fs.existsSync(aclPath)) return { updated: false, reason: "shared-acl-missing" };
  if (!validateGovernanceJson(aclPath, "access-control")) {
    return { updated: false, reason: "shared-acl-invalid" };
  }

  const sharedAcl = getAccessControl(cortexPath);
  if (!hasAnyAssignedRole(sharedAcl)) return { updated: false, reason: "shared-acl-open" };
  if (roleFromAccessControl(sharedAcl, normalizedActor)) {
    return { updated: false, reason: "shared-role-present" };
  }

  const localAcl = getLocalAccessControl(cortexPath);
  if (roleFromAccessControl(localAcl, normalizedActor)) {
    return { updated: false, reason: "local-role-present" };
  }

  const next: AccessControl = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    admins: [...(localAcl.admins || [])],
    maintainers: Array.from(new Set([...(localAcl.maintainers || []), normalizedActor])).sort(),
    contributors: [...(localAcl.contributors || [])],
    viewers: [...(localAcl.viewers || [])],
  };
  writeLocalAccessControl(cortexPath, next);
  appendAuditLog(cortexPath, "ensure_local_actor_access", JSON.stringify({ actor: normalizedActor, role: "maintainer", file: LOCAL_ACCESS_FILE }));
  return { updated: true, role: "maintainer" };
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
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const registryEntry = GOVERNANCE_REGISTRY[schema];
      if (!isRecord(parsed)) {
        if (!dryRun) writeJsonFile(filePath, registryEntry.defaults());
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

      const valid = registryEntry.validate(parsed);
      const next = valid ? registryEntry.normalize(parsed) : registryEntry.defaults();
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

function resolveRole(cortexPath: string, actor: string = actorName()): MemoryRole {
  const aclPath = govFile(cortexPath, "access-control");
  // If the ACL file does not exist, treat as open access (no ACL configured).
  if (!fs.existsSync(aclPath)) return "admin";
  // If the file exists but fails validation, fail closed — return least-privilege role.
  if (!validateGovernanceJson(aclPath, "access-control")) {
    debugLog(`resolveRole: ${aclPath} failed validation, failing closed (viewer)`);
    return "viewer";
  }
  const acl = readJsonFile<AccessControl>(aclPath, DEFAULT_ACCESS);
  if (!hasAnyAssignedRole(acl)) return "admin"; // ACL file present but empty — open access
  const sharedRole = roleFromAccessControl(acl, actor);
  if (sharedRole) return sharedRole;
  const localRole = roleFromAccessControl(getLocalAccessControl(cortexPath), actor);
  if (localRole) return localRole;
  return "viewer";
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
  merged.riskySections = merged.riskySections.filter((section) => validSections.has(section));
  if (!merged.riskySections.length) merged.riskySections = DEFAULT_WORKFLOW_POLICY.riskySections;
  if (!["off", "manual", "suggest", "auto"].includes(merged.taskMode)) {
    merged.taskMode = DEFAULT_WORKFLOW_POLICY.taskMode;
  }
  return merged;
}

export function updateWorkflowPolicy(cortexPath: string, patch: Partial<WorkflowPolicy>): CortexResult<WorkflowPolicy> {
  const denial = checkPermission(cortexPath, "policy");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const current = getWorkflowPolicy(cortexPath);
  const riskySections = Array.isArray(patch.riskySections)
    ? patch.riskySections.filter((section): section is "Review" | "Stale" | "Conflicts" => ["Review", "Stale", "Conflicts"].includes(String(section)))
    : current.riskySections;
  const taskMode = patch.taskMode && ["off", "manual", "suggest", "auto"].includes(String(patch.taskMode))
    ? patch.taskMode
    : current.taskMode;
  const next: WorkflowPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    requireMaintainerApproval: patch.requireMaintainerApproval ?? current.requireMaintainerApproval,
    lowConfidenceThreshold: patch.lowConfidenceThreshold ?? current.lowConfidenceThreshold,
    riskySections: riskySections.length ? riskySections : current.riskySections,
    taskMode,
  };
  writeJsonFile(govFile(cortexPath, "workflow-policy"), next);
  appendAuditLog(cortexPath, "update_workflow_policy", JSON.stringify(next));
  return cortexOk(next);
}

export function getIndexPolicy(cortexPath: string): IndexPolicy {
  const parsed = readJsonFile<Partial<IndexPolicy>>(govFile(cortexPath, "index-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_INDEX_POLICY);
  merged.includeGlobs = merged.includeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
  merged.excludeGlobs = merged.excludeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
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
      ? patch.includeGlobs.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0)
      : current.includeGlobs,
    excludeGlobs: Array.isArray(patch.excludeGlobs)
      ? patch.excludeGlobs.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0)
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
      lastSync: patch.lastSync ? { ...(current.lastSync ?? {}), ...patch.lastSync } : current.lastSync,
    };
    writeJsonFileUnlocked(file, next);
    return next;
  });
}

export function loadCanonicalLocks(cortexPath: string): Record<string, CanonicalLock> {
  const parsed = readJsonFile<Record<string, unknown>>(govFile(cortexPath, "canonical-locks"), {});
  if (!isRecord(parsed)) return {};
  return normalizeVersionedEntries(parsed, isCanonicalLock).entries;
}

function saveCanonicalLocks(cortexPath: string, locks: Record<string, CanonicalLock>) {
  writeJsonFile(govFile(cortexPath, "canonical-locks"), {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    entries: locks,
  } satisfies VersionedEntriesFile<CanonicalLock>);
}

/** Save canonical locks without acquiring a file lock (caller must hold the lock). */
export function saveCanonicalLocksUnlocked(cortexPath: string, locks: Record<string, CanonicalLock>) {
  writeJsonFileUnlocked(govFile(cortexPath, "canonical-locks"), {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    entries: locks,
  } satisfies VersionedEntriesFile<CanonicalLock>);
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeBulletForQueue(line: string): string {
  return line.startsWith("- ") ? line.slice(2).trim() : line.trim();
}

export function appendReviewQueue(
  cortexPath: string,
  project: string,
  section: "Review" | "Stale" | "Conflicts",
  entries: string[],
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
    if (!toInsert.length) return cortexOk(0);

    lines.splice(insertAt, 0, ...toInsert, "");
    fs.writeFileSync(queuePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
    return cortexOk(toInsert.length);
  });
}

export function pruneDeadMemories(cortexPath: string, project?: string, dryRun?: boolean): CortexResult<string> {
  const denial = checkPermission(cortexPath, "delete");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const policy = getRetentionPolicy(cortexPath);
  if (project && !isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const dirs = project
    ? (() => {
      const resolvedProject = safeProjectPath(cortexPath, project);
      return resolvedProject ? [resolvedProject] : [];
    })()
    : getProjectDirs(cortexPath).filter((dir) => path.basename(dir) !== "global");
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
        // Detect archive block start (both <details> and cortex:archive:start markers)
        if (line.includes("<!-- cortex:archive:start -->") || line.includes("<details>")) {
          inArchive = true;
          next.push(line);
          continue;
        }
        // Detect archive block end
        if (line.includes("<!-- cortex:archive:end -->") || line.includes("</details>")) {
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
            if (nextLine.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/)) {
              index++;
            }
            continue;
          }
        }
        if (line.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/)) {
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
    return cortexOk(dryRunDetails.length ? `${summary}\n${dryRunDetails.join("\n")}` : summary);
  }

  appendAuditLog(cortexPath, "prune_memories", `project=${project || "all"} pruned=${pruned}`);
  return cortexOk(`Pruned ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`);
}

export function enforceCanonicalLocks(cortexPath: string, project?: string): string {
  const locks = loadCanonicalLocks(cortexPath);
  const projects = project
    ? [project]
    : getProjectDirs(cortexPath).map((dir) => path.basename(dir)).filter((name) => name !== "global");
  let restored = 0;
  let checked = 0;

  for (const projectName of projects) {
    const file = path.join(cortexPath, projectName, "CANONICAL_MEMORIES.md");
    if (!fs.existsSync(file)) continue;
    checked++;
    const content = fs.readFileSync(file, "utf8");
    const key = `${projectName}/CANONICAL_MEMORIES.md`;
    const lock = locks[key];
    if (!lock) {
      locks[key] = { hash: hashContent(content), snapshot: content, updatedAt: new Date().toISOString() };
      continue;
    }
    const currentHash = hashContent(content);
    if (currentHash === lock.hash) continue;
    withFileLock(file, () => fs.writeFileSync(file, lock.snapshot));
    appendReviewQueue(cortexPath, projectName, "Conflicts", ["Canonical memory drift detected and auto-restored"]);
    appendAuditLog(cortexPath, "canonical_restore", `project=${projectName}`);
    restored++;
  }

  saveCanonicalLocks(cortexPath, locks);
  return `Canonical locks checked=${checked}, restored=${restored}`;
}

export function consolidateProjectFindings(cortexPath: string, project: string, dryRun?: boolean): CortexResult<string> {
  const denial = checkPermission(cortexPath, "delete");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const file = resolveFindingsPath(path.join(cortexPath, project));
  if (!file) return cortexErr(`No FINDINGS.md found for "${project}".`, CortexError.FILE_NOT_FOUND);

  // Q23: wrap entire read-modify-write in per-file lock to prevent races with concurrent finding writers
  const result = withFileLock(file, (): CortexResult<string> => {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");

    // Q12: Separate the file into "active" lines and verbatim archive/details blocks.
    // Archive blocks (<!-- cortex:archive:start/end --> and <details>...</details>) are
    // collected verbatim and appended unchanged after the consolidated active section.
    const archiveBlocks: string[] = [];
    const activeLines: string[] = [];
    let inArchive = false;
    let currentArchiveBlock: string[] = [];

    for (const line of lines) {
      const isArchiveStart = line.includes("<!-- cortex:archive:start -->") || line.includes("<details>");
      const isArchiveEnd = line.includes("<!-- cortex:archive:end -->") || line.includes("</details>");

      if (!inArchive && isArchiveStart) {
        inArchive = true;
        currentArchiveBlock = [line];
        // If the start and end are on the same line, close immediately
        if (isArchiveEnd && line.includes("<!-- cortex:archive:start -->") && line.includes("<!-- cortex:archive:end -->")) {
          archiveBlocks.push(...currentArchiveBlock);
          currentArchiveBlock = [];
          inArchive = false;
        }
        continue;
      }
      if (inArchive) {
        currentArchiveBlock.push(line);
        if (isArchiveEnd) {
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
        const key = line.trim().toLowerCase().replace(/<!--\s*fid:[a-z0-9]{8}\s*-->/g, "").replace(/\s+/g, " ");
        const nextLine = activeLines[index + 1] || "";
        const citation = nextLine.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/) ? nextLine : undefined;
        const trimmedBullet = line.trimEnd();
        const existing = byDate.get(currentDate)?.get(key);
        if (!existing) {
          byDate.get(currentDate)?.set(key, { bullet: trimmedBullet, citation });
          uniqueBullets++;
        } else if (!existing.citation && citation) {
          existing.citation = citation;
        }
        if (citation) index++;
      }
    }

    const dates = [...byDate.keys()].sort().reverse();
    const duplicatesRemoved = totalBullets - uniqueBullets;

    if (dryRun) {
      return cortexOk(`[dry-run] ${project}: ${totalBullets} bullets, ${duplicatesRemoved} duplicate(s) would be removed, ${dates.length} date section(s).`);
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
    appendAuditLog(cortexPath, "consolidate_project", `project=${project} dates=${dates.length}`);
    return cortexOk(`Consolidated findings for ${project}.`);
  });
  // Fire post-consolidate hook outside the file lock to avoid deadlock
  // if the hook command reads or writes FINDINGS.md.
  if (result.ok) {
    runCustomHooks(cortexPath, "post-consolidate", { CORTEX_PROJECT: project });
  }
  return result;
}
