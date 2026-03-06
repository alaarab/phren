import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import {
  debugLog,
  withDefaults,
  appendAuditLog,
  isRecord,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
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

export interface MemoryPolicy {
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

export interface MemoryWorkflowPolicy {
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

export interface MemoryScore {
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

const DEFAULT_POLICY: MemoryPolicy = {
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

export const DEFAULT_MEMORY_POLICY = DEFAULT_POLICY;

const DEFAULT_WORKFLOW_POLICY: MemoryWorkflowPolicy = {
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

const DEFAULT_MEMORY_SCORES_FILE: VersionedEntriesFile<MemoryScore> = {
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
  | "memory-policy"
  | "memory-workflow-policy"
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

function isMemoryScore(value: unknown): value is MemoryScore {
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
  "memory-policy": (d) =>
    hasValidSchemaVersion(d)
    && ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"].every(
      (k) => !(k in d) || isFiniteNumber(d[k])
    )
    && (!("decay" in d) || (() => {
      if (!isRecord(d.decay)) return false;
      const decay = d.decay;
      return ["d30", "d60", "d90", "d120"].every((k) => !(k in decay) || isFiniteNumber(decay[k]));
    })()),
  "memory-workflow-policy": (d) =>
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
    return Object.values(entries).every((entry) => isMemoryScore(entry));
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
  "memory-policy": {
    file: "memory-policy.json",
    validate: GOVERNANCE_VALIDATORS["memory-policy"],
    defaults: () => ({ ...DEFAULT_POLICY }),
    normalize: (d) => normalizeMemoryPolicy(d) as unknown as Record<string, unknown>,
  },
  "memory-workflow-policy": {
    file: "memory-workflow-policy.json",
    validate: GOVERNANCE_VALIDATORS["memory-workflow-policy"],
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
    normalize: (d) => normalizeVersionedEntries(d, isMemoryScore) as unknown as Record<string, unknown>,
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
  } catch (err: any) {
    debugLog(`validateGovernanceJson parse error for ${filePath}: ${err.message}`);
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

function normalizeMemoryPolicy(data: Record<string, unknown>): MemoryPolicy {
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

function normalizeWorkflowPolicy(data: Record<string, unknown>): MemoryWorkflowPolicy {
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
  } catch (err: any) {
    debugLog(`readJsonFile failed for ${filePath}: ${err.message}`);
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function actorName(): string {
  const envActor = process.env.CORTEX_ACTOR || process.env.USER || process.env.USERNAME;
  if (envActor) return envActor;
  try {
    return os.userInfo().username;
  } catch {
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
    } catch (err: any) {
      report.results.push({
        file: fileName,
        schema,
        action: "error",
        fromVersion: null,
        toVersion: GOVERNANCE_SCHEMA_VERSION,
        changed: false,
        detail: err.message,
      });
      debugLog(`migrateGovernance: failed to process ${fileName}: ${err.message}`);
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

export function updateAccessControl(cortexPath: string, patch: AccessControlPatch): AccessControl | string {
  const denial = checkMemoryPermission(cortexPath, "policy");
  if (denial) return denial;
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
  return next;
}

function can(role: MemoryRole, action: MemoryAction): boolean {
  if (role === "admin") return true;
  if (role === "maintainer") return action !== "policy";
  if (role === "contributor") return action === "read" || action === "write" || action === "queue";
  return action === "read";
}

export function checkMemoryPermission(cortexPath: string, action: MemoryAction, actor?: string): string | null {
  const role = resolveRole(cortexPath, actor);
  if (can(role, action)) return null;
  return `Permission denied for ${actor || actorName()} (role=${role}) on action=${action}.`;
}

export function getMemoryPolicy(cortexPath: string): MemoryPolicy {
  const parsed = readJsonFile<Partial<MemoryPolicy>>(govFile(cortexPath, "memory-policy"), {});
  return withDefaults(parsed, DEFAULT_POLICY);
}

export function updateMemoryPolicy(cortexPath: string, patch: Partial<MemoryPolicy>): MemoryPolicy | string {
  const denial = checkMemoryPermission(cortexPath, "policy");
  if (denial) return denial;
  const current = getMemoryPolicy(cortexPath);
  const next: MemoryPolicy = {
    ...current,
    ...patch,
    decay: {
      ...current.decay,
      ...(patch.decay || {}),
    },
  };
  writeJsonFile(govFile(cortexPath, "memory-policy"), next);
  appendAuditLog(cortexPath, "update_policy", JSON.stringify(next));
  return next;
}

export function getMemoryWorkflowPolicy(cortexPath: string): MemoryWorkflowPolicy {
  const parsed = readJsonFile<Partial<MemoryWorkflowPolicy>>(govFile(cortexPath, "memory-workflow-policy"), {});
  const merged = withDefaults(parsed, DEFAULT_WORKFLOW_POLICY);
  const validSections = new Set(["Review", "Stale", "Conflicts"]);
  merged.riskySections = merged.riskySections.filter((s) => validSections.has(s));
  if (!merged.riskySections.length) merged.riskySections = DEFAULT_WORKFLOW_POLICY.riskySections;
  return merged;
}

export function updateMemoryWorkflowPolicy(
  cortexPath: string,
  patch: Partial<MemoryWorkflowPolicy>
): MemoryWorkflowPolicy | string {
  const denial = checkMemoryPermission(cortexPath, "policy");
  if (denial) return denial;
  const current = getMemoryWorkflowPolicy(cortexPath);
  const riskySections = Array.isArray(patch.riskySections)
    ? patch.riskySections.filter((s): s is "Review" | "Stale" | "Conflicts" => ["Review", "Stale", "Conflicts"].includes(String(s)))
    : current.riskySections;
  const next: MemoryWorkflowPolicy = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    requireMaintainerApproval: patch.requireMaintainerApproval ?? current.requireMaintainerApproval,
    lowConfidenceThreshold: patch.lowConfidenceThreshold ?? current.lowConfidenceThreshold,
    riskySections: riskySections.length ? riskySections : current.riskySections,
  };
  writeJsonFile(govFile(cortexPath, "memory-workflow-policy"), next);
  appendAuditLog(cortexPath, "update_workflow_policy", JSON.stringify(next));
  return next;
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

export function updateIndexPolicy(cortexPath: string, patch: Partial<IndexPolicy>): IndexPolicy | string {
  const denial = checkMemoryPermission(cortexPath, "policy");
  if (denial) return denial;
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
  return next;
}

export function getRuntimeHealth(cortexPath: string): RuntimeHealth {
  const parsed = readJsonFile<Record<string, unknown>>(govFile(cortexPath, "runtime-health"), {});
  if (!isRecord(parsed)) return { ...DEFAULT_RUNTIME_HEALTH };
  return normalizeRuntimeHealth(parsed);
}

export function updateRuntimeHealth(cortexPath: string, patch: Partial<RuntimeHealth>): RuntimeHealth {
  const current = getRuntimeHealth(cortexPath);
  const next: RuntimeHealth = {
    schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
    ...current,
    ...patch,
    lastAutoSave: patch.lastAutoSave ?? current.lastAutoSave,
    lastGovernance: patch.lastGovernance ?? current.lastGovernance,
  };
  writeJsonFile(govFile(cortexPath, "runtime-health"), next);
  return next;
}

let _scoresCache: Record<string, MemoryScore> | null = null;
let _scoresCachePath: string | null = null;
let _scoresDirty = false;

function loadMemoryScores(cortexPath: string): Record<string, MemoryScore> {
  const file = govFile(cortexPath, "memory-scores");
  if (_scoresCache && _scoresCachePath === file) return _scoresCache;
  const parsed = readJsonFile<Record<string, unknown>>(file, {});
  _scoresCache = isRecord(parsed) ? normalizeVersionedEntries(parsed, isMemoryScore).entries : {};
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

function saveMemoryScores(cortexPath: string, scores: Record<string, MemoryScore>) {
  _scoresCache = scores;
  _scoresCachePath = govFile(cortexPath, "memory-scores");
  _scoresDirty = true;
}

export function flushMemoryScores(cortexPath: string): void {
  if (_scoresDirty && _scoresCache && _scoresCachePath === govFile(cortexPath, "memory-scores")) {
    writeJsonFile(_scoresCachePath, {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      entries: _scoresCache,
    } satisfies VersionedEntriesFile<MemoryScore>);
    _scoresDirty = false;
  }
}

function ensureScoreEntry(scores: Record<string, MemoryScore>, key: string): MemoryScore {
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

export function memoryScoreKey(project: string, filename: string, snippet: string): string {
  const short = snippet.replace(/\s+/g, " ").slice(0, 200);
  const digest = crypto.createHash("sha1").update(`${project}:${filename}:${short}`).digest("hex").slice(0, 12);
  return `${project}/${filename}:${digest}`;
}

export function recordMemoryInjection(cortexPath: string, key: string, sessionId?: string): void {
  const scores = loadMemoryScores(cortexPath);
  const entry = ensureScoreEntry(scores, key);
  entry.impressions += 1;
  entry.lastUsedAt = new Date().toISOString();
  saveMemoryScores(cortexPath, scores);
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
  } catch (err: any) {
    debugLog(`Usage log rotation failed: ${err.message}`);
  }
}

export function recordMemoryFeedback(
  cortexPath: string,
  key: string,
  feedback: "helpful" | "reprompt" | "regression"
): void {
  const scores = loadMemoryScores(cortexPath);
  const entry = ensureScoreEntry(scores, key);
  if (feedback === "helpful") entry.helpful += 1;
  if (feedback === "reprompt") entry.repromptPenalty += 1;
  if (feedback === "regression") entry.regressionPenalty += 1;
  saveMemoryScores(cortexPath, scores);
  appendAuditLog(cortexPath, "memory_feedback", `key=${key} feedback=${feedback}`);
}

export function getMemoryQualityMultiplier(cortexPath: string, key: string): number {
  const scores = loadMemoryScores(cortexPath);
  const entry = scores[key];
  if (!entry) return 1;
  const helpful = entry.helpful;
  const penalties = entry.repromptPenalty + entry.regressionPenalty * 2;
  const raw = 1 + helpful * 0.15 - penalties * 0.2;
  return Math.max(0.2, Math.min(1.5, raw));
}

export function pruneDeadMemories(cortexPath: string, project?: string, dryRun?: boolean): string {
  const denial = checkMemoryPermission(cortexPath, "delete");
  if (denial) return denial;
  const policy = getMemoryPolicy(cortexPath);
  const dirs = project
    ? [path.join(cortexPath, project)]
    : getProjectDirs(cortexPath).filter((d) => path.basename(d) !== "global");
  let pruned = 0;
  const cutoffDays = policy.retentionDays;
  const dryRunDetails: string[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, "LEARNINGS.md");
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
        const age = Math.floor((Date.now() - Date.parse(`${currentDate}T00:00:00Z`)) / 86400000);
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
    return dryRunDetails.length ? `${summary}\n${dryRunDetails.join("\n")}` : summary;
  }

  appendAuditLog(cortexPath, "prune_memories", `project=${project || "all"} pruned=${pruned}`);
  return `Pruned ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`;
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
    appendMemoryQueue(cortexPath, p, "Conflicts", ["Canonical memory drift detected and auto-restored"]);
    appendAuditLog(cortexPath, "canonical_restore", `project=${p}`);
    restored++;
  }

  saveCanonicalLocks(cortexPath, locks);
  return `Canonical locks checked=${checked}, restored=${restored}`;
}

export function consolidateProjectLearnings(cortexPath: string, project: string, dryRun?: boolean): string {
  const denial = checkMemoryPermission(cortexPath, "delete");
  if (denial) return denial;
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const file = path.join(cortexPath, project, "LEARNINGS.md");
  if (!fs.existsSync(file)) return `No LEARNINGS.md found for "${project}".`;

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const byDate = new Map<string, Map<string, { bullet: string; citation?: string }>>();
  let currentDate: string | null = null;
  const title = lines.find((l) => l.startsWith("# ")) || `# ${project} LEARNINGS`;
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
      const existing = byDate.get(currentDate)!.get(key);
      if (!existing) {
        byDate.get(currentDate)!.set(key, { bullet: line, citation });
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
    return `[dry-run] ${project}: ${totalBullets} bullets, ${duplicatesRemoved} duplicate(s) would be removed, ${dates.length} date section(s).`;
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
  return `Consolidated learnings for ${project}.`;
}

function normalizeBulletForQueue(line: string): string {
  return line.startsWith("- ") ? line.slice(2).trim() : line.trim();
}

export function appendMemoryQueue(
  cortexPath: string,
  project: string,
  section: "Review" | "Stale" | "Conflicts",
  entries: string[]
): number {
  const denial = checkMemoryPermission(cortexPath, "queue");
  if (denial) return 0;
  if (!isValidProjectName(project)) return 0;
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return 0;
  const queuePath = path.join(resolvedDir, "MEMORY_QUEUE.md");
  const today = new Date().toISOString().slice(0, 10);

  const normalized = entries.map(normalizeBulletForQueue).filter(Boolean);
  if (normalized.length === 0) return 0;

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
  if (!toInsert.length) return 0;

  lines.splice(insertAt, 0, ...toInsert, "");
  fs.writeFileSync(queuePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  return toInsert.length;
}
