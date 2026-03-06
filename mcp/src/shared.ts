import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import * as yaml from "js-yaml";
import { globSync } from "glob";
import { createRequire } from "module";
import { isValidProjectName, safeProjectPath } from "./utils.js";

// sql.js-fts5 is CJS only, use createRequire for ESM compat
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

// Default timeout for execFileSync calls (30s for most operations, 10s for quick probes like `which`)
export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_QUICK_MS = 10_000;

// Structured error codes for consistent error handling across data-access and MCP tools
export const CortexError = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  INVALID_PROJECT_NAME: "INVALID_PROJECT_NAME",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MALFORMED_JSON: "MALFORMED_JSON",
} as const;

export type CortexErrorCode = typeof CortexError[keyof typeof CortexError];

// Debug logger - writes to ~/.cortex/debug.log when CORTEX_DEBUG=1
export function debugLog(msg: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const logFile = path.join(home, ".cortex", "debug.log");
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* debug log is best-effort; logging errors about logging would recurse */ }
}

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

function governanceDir(cortexPath: string): string {
  return path.join(cortexPath, ".governance");
}

/** Shallow-merge data onto defaults so missing keys get filled in. */
export function withDefaults<T extends object>(data: Partial<T>, defaults: T): T {
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    const val = data[key as keyof T];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        merged[key] = val;
      }
    }
  }
  return merged as T;
}

type GovernanceSchema = "access-control" | "memory-policy" | "memory-workflow-policy" | "index-policy";

const GOVERNANCE_VALIDATORS: Record<GovernanceSchema, (data: Record<string, unknown>) => boolean> = {
  "access-control": (d) =>
    ["admins", "maintainers", "contributors", "viewers"].every(
      (k) => !(k in d) || Array.isArray(d[k])
    ),
  "memory-policy": (d) =>
    ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"].every(
      (k) => !(k in d) || typeof d[k] === "number"
    ),
  "memory-workflow-policy": (d) =>
    (!("riskySections" in d) || Array.isArray(d.riskySections)),
  "index-policy": (d) =>
    ["includeGlobs", "excludeGlobs"].every(
      (k) => !(k in d) || Array.isArray(d[k])
    ),
};

const GOVERNANCE_FILE_SCHEMAS: Record<string, GovernanceSchema> = {
  "access-control.json": "access-control",
  "memory-policy.json": "memory-policy",
  "memory-workflow-policy.json": "memory-workflow-policy",
  "index-policy.json": "index-policy",
};

export function validateGovernanceJson(filePath: string, schema: GovernanceSchema): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      debugLog(`validateGovernanceJson: ${filePath} is not a JSON object`);
      return false;
    }
    const validator = GOVERNANCE_VALIDATORS[schema];
    if (!validator(data as Record<string, unknown>)) {
      debugLog(`validateGovernanceJson: ${filePath} failed ${schema} schema check`);
      return false;
    }
    return true;
  } catch (err: any) {
    debugLog(`validateGovernanceJson parse error for ${filePath}: ${err.message}`);
    return false;
  }
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
    const fileVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
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
    // os.userInfo() can throw in containers or sandboxed environments
    return "unknown";
  }
}

/**
 * Check governance file schema versions and apply any needed migrations.
 * Currently validates versions only; the structure supports future migrations.
 */
export function migrateGovernanceFiles(cortexPath: string): string[] {
  const govDir = governanceDir(cortexPath);
  if (!fs.existsSync(govDir)) return [];

  const files = [
    { name: "memory-policy.json", defaults: DEFAULT_POLICY },
    { name: "access-control.json", defaults: DEFAULT_ACCESS },
    { name: "memory-workflow-policy.json", defaults: DEFAULT_WORKFLOW_POLICY },
    { name: "index-policy.json", defaults: DEFAULT_INDEX_POLICY },
  ];

  const migrated: string[] = [];

  for (const { name, defaults } of files) {
    const filePath = path.join(govDir, name);
    if (!fs.existsSync(filePath)) continue;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const fileVersion = typeof data.schemaVersion === "number" ? data.schemaVersion : 0;

      if (fileVersion > GOVERNANCE_SCHEMA_VERSION) {
        debugLog(`${name} has schemaVersion ${fileVersion} (newer than ${GOVERNANCE_SCHEMA_VERSION}), skipping migration`);
        continue;
      }

      if (fileVersion < GOVERNANCE_SCHEMA_VERSION) {
        const merged = withDefaults(data as any, defaults as any);
        merged.schemaVersion = GOVERNANCE_SCHEMA_VERSION;
        writeJsonFile(filePath, merged);
        migrated.push(name);
        debugLog(`Migrated ${name} from schemaVersion ${fileVersion} to ${GOVERNANCE_SCHEMA_VERSION}`);
      }
    } catch (err: any) {
      debugLog(`migrateGovernanceFiles: failed to process ${name}: ${err.message}`);
    }
  }

  return migrated;
}

function accessFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "access-control.json");
}

function policyFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "memory-policy.json");
}

function workflowPolicyFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "memory-workflow-policy.json");
}

function indexPolicyFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "index-policy.json");
}

function scoreFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "memory-scores.json");
}

function usageLogFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "memory-usage.log");
}

function lockFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "canonical-locks.json");
}

function runtimeHealthFile(cortexPath: string): string {
  return path.join(governanceDir(cortexPath), "runtime-health.json");
}

function resolveRole(cortexPath: string, actor: string = actorName()): MemoryRole {
  const acl = readJsonFile<AccessControl>(accessFile(cortexPath), DEFAULT_ACCESS);
  if ((acl.admins || []).includes(actor)) return "admin";
  if ((acl.maintainers || []).includes(actor)) return "maintainer";
  if ((acl.contributors || []).includes(actor)) return "contributor";
  if ((acl.viewers || []).includes(actor)) return "viewer";
  // Default to least privilege when actor is unknown.
  return "viewer";
}

export function getAccessControl(cortexPath: string): AccessControl {
  const parsed = readJsonFile<Partial<AccessControl>>(accessFile(cortexPath), {});
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
  writeJsonFile(accessFile(cortexPath), next);
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
  const parsed = readJsonFile<Partial<MemoryPolicy>>(policyFile(cortexPath), {});
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
  writeJsonFile(policyFile(cortexPath), next);
  appendAuditLog(cortexPath, "update_policy", JSON.stringify(next));
  return next;
}

export function getMemoryWorkflowPolicy(cortexPath: string): MemoryWorkflowPolicy {
  const parsed = readJsonFile<Partial<MemoryWorkflowPolicy>>(workflowPolicyFile(cortexPath), {});
  const merged = withDefaults(parsed, DEFAULT_WORKFLOW_POLICY);
  // Validate riskySections entries
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
  writeJsonFile(workflowPolicyFile(cortexPath), next);
  appendAuditLog(cortexPath, "update_workflow_policy", JSON.stringify(next));
  return next;
}

export function getIndexPolicy(cortexPath: string): IndexPolicy {
  const parsed = readJsonFile<Partial<IndexPolicy>>(indexPolicyFile(cortexPath), {});
  const merged = withDefaults(parsed, DEFAULT_INDEX_POLICY);
  // Validate glob arrays: filter out non-strings and empty entries
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
  writeJsonFile(indexPolicyFile(cortexPath), next);
  appendAuditLog(cortexPath, "update_index_policy", JSON.stringify(next));
  return next;
}

export function getRuntimeHealth(cortexPath: string): RuntimeHealth {
  return readJsonFile<RuntimeHealth>(runtimeHealthFile(cortexPath), {});
}

export function updateRuntimeHealth(cortexPath: string, patch: Partial<RuntimeHealth>): RuntimeHealth {
  const current = getRuntimeHealth(cortexPath);
  const next: RuntimeHealth = {
    ...current,
    ...patch,
    lastAutoSave: patch.lastAutoSave ?? current.lastAutoSave,
    lastGovernance: patch.lastGovernance ?? current.lastGovernance,
  };
  writeJsonFile(runtimeHealthFile(cortexPath), next);
  return next;
}

let _scoresCache: Record<string, MemoryScore> | null = null;
let _scoresCachePath: string | null = null;

function loadMemoryScores(cortexPath: string): Record<string, MemoryScore> {
  const file = scoreFile(cortexPath);
  if (_scoresCache && _scoresCachePath === file) return _scoresCache;
  _scoresCache = readJsonFile<Record<string, MemoryScore>>(file, {});
  _scoresCachePath = file;
  return _scoresCache;
}

function loadCanonicalLocks(cortexPath: string): Record<string, CanonicalLock> {
  return readJsonFile<Record<string, CanonicalLock>>(lockFile(cortexPath), {});
}

function saveCanonicalLocks(cortexPath: string, locks: Record<string, CanonicalLock>) {
  writeJsonFile(lockFile(cortexPath), locks);
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function saveMemoryScores(cortexPath: string, scores: Record<string, MemoryScore>) {
  _scoresCache = scores;
  _scoresCachePath = scoreFile(cortexPath);
  writeJsonFile(_scoresCachePath, scores);
}

export function flushMemoryScores(cortexPath: string): void {
  if (_scoresCache && _scoresCachePath === scoreFile(cortexPath)) {
    writeJsonFile(_scoresCachePath, _scoresCache);
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
          // Also drop citation line directly attached to this bullet.
          const nextLine = lines[i + 1] || "";
          if (nextLine.match(/^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/)) {
            i++;
          }
          continue;
        }
      }
      // Drop dangling citation comments with no preceding bullet in the kept output.
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

// Validate that a path is a safe, existing directory
function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

// Pure lookup: find an existing cortex root directory, returns null if none found
// Priority: CORTEX_PATH env > ~/.cortex > ~/cortex
export function findCortexPath(): string | null {
  if (process.env.CORTEX_PATH) return process.env.CORTEX_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of [".cortex", "cortex"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Find or create the cortex root directory (creates ~/.cortex on first run)
export function ensureCortexPath(): string {
  const existing = findCortexPath();
  if (existing) return existing;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const defaultPath = path.join(home, ".cortex");
  fs.mkdirSync(defaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(defaultPath, "README.md"),
    `# My Cortex\n\nThis is your personal knowledge base. Each subdirectory is a project.\n\nGet started:\n\n\`\`\`bash\nmkdir my-project\ncd my-project\ntouch CLAUDE.md summary.md LEARNINGS.md backlog.md\n\`\`\`\n\nOr run \`/cortex:init my-project\` in Claude Code to scaffold one.\n\nPush this directory to a private GitHub repo to sync across machines.\n`
  );
  console.error(`Created ~/.cortex`);
  return defaultPath;
}

// Resolve the cortex path from an explicit argument (used by MCP mode)
export function findCortexPathWithArg(arg?: string): string {
  if (arg) {
    const resolved = arg.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    return requireDirectory(resolved, "cortex path");
  }
  return ensureCortexPath();
}

// Figure out which project directories to index
export function getProjectDirs(cortexPath: string, profile?: string): string[] {
  if (profile) {
    if (!isValidProjectName(profile)) {
      console.error(`Invalid CORTEX_PROFILE value: ${profile}`);
      return [];
    }
    const profilePath = path.join(cortexPath, "profiles", `${profile}.yaml`);
    if (fs.existsSync(profilePath)) {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
      const projects = data?.projects;
      if (Array.isArray(projects)) {
        const listed = projects
          .map((p: unknown) => {
            const name = String(p);
            if (!isValidProjectName(name)) {
              console.error(`Skipping invalid project name in profile: ${name}`);
              return null;
            }
            return safeProjectPath(cortexPath, name);
          })
          .filter((p): p is string => p !== null && fs.existsSync(p));

        // Shared spaces are always visible when present.
        const sharedDirs = ["shared", "org"]
          .map((name) => safeProjectPath(cortexPath, name))
          .filter((p): p is string => Boolean(p && fs.existsSync(p) && fs.statSync(p).isDirectory()));

        return [...new Set([...listed, ...sharedDirs])];
      }
    }
  }

  return fs.readdirSync(cortexPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "profiles" && d.name !== "templates")
    .map(d => path.join(cortexPath, d.name));
}

// Classify a file by its name and path
const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "learnings.md": "learnings",
  "knowledge.md": "knowledge",
  "backlog.md": "backlog",
  "changelog.md": "changelog",
  "canonical_memories.md": "canonical",
  "memory_queue.md": "memory-queue",
};

function classifyFile(filename: string, relPath: string): string {
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  return "other";
}

// Find and load the WASM binary for sql.js-fts5
function findWasmBinary(): Buffer | undefined {
  // Most reliable path in packaged installs (including npx cache layouts).
  try {
    const resolved = require.resolve("sql.js-fts5/dist/sql-wasm.wasm") as string;
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved);
  } catch {
    // fall through to path probing
  }

  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 5; i++) {
    const candidateA = path.join(dir, "node_modules", "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateA)) return fs.readFileSync(candidateA);
    const candidateB = path.join(dir, "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateB)) return fs.readFileSync(candidateB);
    dir = path.dirname(dir);
  }
  return undefined;
}

// Compute a hash of all .md file mtimes to use as a cache invalidation key
function computeCortexHash(cortexPath: string, profile?: string): string {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const policy = getIndexPolicy(cortexPath);
  const files: string[] = [];
  for (const dir of projectDirs) {
    try {
      const matched = new Set<string>();
      for (const pattern of policy.includeGlobs) {
        const dot = policy.includeHidden || pattern.startsWith(".") || pattern.includes("/.");
        const mdFiles = globSync(pattern, { cwd: dir, nodir: true, dot, ignore: policy.excludeGlobs });
        for (const f of mdFiles) matched.add(f);
      }
      for (const f of matched) files.push(path.join(dir, f));
    } catch { /* skip unreadable dirs */ }
  }
  files.sort();
  const hash = crypto.createHash("md5");
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  // Include profile in hash so profile changes invalidate cache
  if (profile) hash.update(`profile:${profile}`);
  hash.update(`index-policy:${JSON.stringify(policy)}`);
  return hash.digest("hex");
}

export async function buildIndex(cortexPath: string, profile?: string): Promise<any> {
  const t0 = Date.now();
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  const hash = computeCortexHash(cortexPath, profile);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});

  // Try to load from cache first
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = fs.readFileSync(cacheFile);
      const db = new SQL.Database(cached);
      debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)}) in ${Date.now() - t0}ms`);
      return db;
    } catch {
      debugLog(`Cache load failed, rebuilding index`);
    }
  }

  // Build fresh index
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path
    );
  `);

  const projectDirs = getProjectDirs(cortexPath, profile);
  const indexPolicy = getIndexPolicy(cortexPath);
  let fileCount = 0;

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const mdFilesSet = new Set<string>();
    for (const pattern of indexPolicy.includeGlobs) {
      const dot = indexPolicy.includeHidden || pattern.startsWith(".") || pattern.includes("/.");
      const matched = globSync(pattern, {
        cwd: dir,
        nodir: true,
        dot,
        ignore: indexPolicy.excludeGlobs,
      });
      for (const rel of matched) mdFilesSet.add(rel);
    }
    const mdFiles = [...mdFilesSet].sort();

    for (const relFile of mdFiles) {
      const fullPath = path.join(dir, relFile);
      const filename = path.basename(relFile);
      const type = classifyFile(filename, relFile);

      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        // Strip <details> archive blocks so consolidated entries don't pollute search
        const content = raw.replace(/<details>[\s\S]*?<\/details>/gi, "");
        db.run(
          "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
          [projectName, filename, type, content, fullPath]
        );
        fileCount++;
      } catch {
        // Skip files we can't read
      }
    }
  }

  const buildMs = Date.now() - t0;
  debugLog(`Built FTS index: ${fileCount} files from ${projectDirs.length} projects in ${buildMs}ms`);
  if (process.env.CORTEX_DEBUG) console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);

  // Persist cache to disk for future fast loads
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, db.export());
    // Clean stale cache entries (all except current hash)
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith(".db") || f === `${hash}.db`) continue;
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* stale cache cleanup is best-effort */ }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)}) — total ${Date.now() - t0}ms`);
  } catch {
    debugLog(`Failed to save FTS index cache`);
  }

  return db;
}

// Extract rows from a db.exec result, or null if empty
export function queryRows(db: any, sql: string, params: (string | number)[]): any[][] | null {
  const results = db.exec(sql, params);
  if (!results.length || !results[0].values.length) return null;
  return results[0].values;
}

// Extract a snippet around the match
export function extractSnippet(content: string, query: string, lines: number = 5): string {
  const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => t.toLowerCase());

  if (terms.length === 0) {
    return content.split("\n").slice(0, lines).join("\n");
  }

  const contentLines = content.split("\n");

  const headingIndices: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimStart().startsWith("#")) headingIndices.push(i);
  }

  function nearestHeadingDist(idx: number): number {
    let min = Infinity;
    for (const h of headingIndices) {
      const d = Math.abs(idx - h);
      if (d < min) min = d;
    }
    return min;
  }

  function sectionMiddle(idx: number): number {
    let sectionStart = 0;
    let sectionEnd = contentLines.length;
    for (const h of headingIndices) {
      if (h <= idx) sectionStart = h;
      else { sectionEnd = h; break; }
    }
    return (sectionStart + sectionEnd) / 2;
  }

  let bestIdx = 0;
  let bestScore = 0;
  let bestHeadingDist = Infinity;
  let bestMidDist = Infinity;

  for (let i = 0; i < contentLines.length; i++) {
    const lineLower = contentLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) score++;
    }
    if (score === 0) continue;

    const hDist = nearestHeadingDist(i);
    const nearHeading = hDist <= 3;
    const mDist = Math.abs(i - sectionMiddle(i));

    const better =
      score > bestScore ||
      (score === bestScore && nearHeading && bestHeadingDist > 3) ||
      (score === bestScore && nearHeading === (bestHeadingDist <= 3) && mDist < bestMidDist);

    if (better) {
      bestScore = score;
      bestIdx = i;
      bestHeadingDist = hDist;
      bestMidDist = mDist;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + lines - 1);
  return contentLines.slice(start, end).join("\n");
}

// Detect which cortex project matches a given directory (cwd)
// Matches against path segments to avoid false positives (e.g., "api" matching "/home/user/capital")
export function detectProject(cortexPath: string, cwd: string, profile?: string): string | null {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const cwdSegments = cwd.toLowerCase().split(path.sep);

  const lastSegment = cwdSegments[cwdSegments.length - 1];
  for (const dir of projectDirs) {
    const projectName = path.basename(dir).toLowerCase();
    if (projectName.length <= 3) {
      if (lastSegment === projectName) return path.basename(dir);
    } else {
      if (cwdSegments.includes(projectName)) return path.basename(dir);
    }
  }
  return null;
}

export interface ConsolidationNeeded {
  project: string;
  entriesSince: number;
  daysSince: number | null;
  lastConsolidated: string | null;
}

export interface LearningCitation {
  created_at: string;
  repo?: string;
  file?: string;
  line?: number;
  commit?: string;
}

export interface LearningTrustIssue {
  date: string;
  bullet: string;
  reason: "stale" | "invalid_citation";
}

export interface TrustFilterOptions {
  ttlDays?: number;
  minConfidence?: number;
  decay?: Partial<MemoryPolicy["decay"]>;
}

// Check which projects have enough new learnings to warrant consolidation
export function checkConsolidationNeeded(cortexPath: string, profile?: string): ConsolidationNeeded[] {
  const ENTRY_THRESHOLD = 25;
  const TIME_THRESHOLD_DAYS = 60;
  const MIN_FOR_TIME_CHECK = 10;

  const projectDirs = getProjectDirs(cortexPath, profile);
  const results: ConsolidationNeeded[] = [];
  const today = new Date();

  for (const dir of projectDirs) {
    const learningsPath = path.join(dir, "LEARNINGS.md");
    if (!fs.existsSync(learningsPath)) continue;

    const content = fs.readFileSync(learningsPath, "utf8");
    const lines = content.split("\n");

    const markerMatch = content.match(/<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})/);
    const lastConsolidated = markerMatch ? markerMatch[1] : null;

    let startLine = 0;
    if (markerMatch) {
      startLine = lines.findIndex(l => l.includes("consolidated:")) + 1;
    }

    let inDetails = false;
    let entriesSince = 0;
    for (let i = startLine; i < lines.length; i++) {
      if (lines[i].includes("<details>")) { inDetails = true; continue; }
      if (lines[i].includes("</details>")) { inDetails = false; continue; }
      if (!inDetails && lines[i].match(/^- /)) entriesSince++;
    }

    let daysSince: number | null = null;
    if (lastConsolidated) {
      daysSince = Math.floor((today.getTime() - new Date(lastConsolidated).getTime()) / 86400000);
    }

    const needsByCount = entriesSince >= ENTRY_THRESHOLD;
    const needsByTime = daysSince !== null && daysSince >= TIME_THRESHOLD_DAYS && entriesSince >= MIN_FOR_TIME_CHECK;
    const needsFirst = lastConsolidated === null && entriesSince >= ENTRY_THRESHOLD;

    if (needsByCount || needsByTime || needsFirst) {
      results.push({ project: path.basename(dir), entriesSince, daysSince, lastConsolidated });
    }
  }

  return results;
}

// --- Format validation ---

// Validate LEARNINGS.md format. Returns array of issue strings (empty = valid).
export function validateLearningsFormat(content: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    issues.push("Missing title heading (expected: # Project LEARNINGS)");
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      // Only validate headings that look like they should be dates
      if (/^\d/.test(heading) && !/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        issues.push(`Date heading should be YYYY-MM-DD format: "${line}"`);
      }
    }
  }

  return issues;
}

// Validate backlog.md format. Returns array of issue strings (empty = valid).
export function validateBacklogFormat(content: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    issues.push("Missing title heading");
  }

  const hasSections =
    content.includes("## Active") ||
    content.includes("## Queue") ||
    content.includes("## Done");
  if (!hasSections) {
    issues.push("Missing expected sections (Active, Queue, Done)");
  }

  return issues;
}

// --- Git conflict auto-merge ---

// Extract ours/theirs from a file containing git conflict markers
export function extractConflictVersions(content: string): { ours: string; theirs: string } | null {
  if (!content.includes("<<<<<<<")) return null;

  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let state: "normal" | "ours" | "theirs" = "normal";

  for (const line of content.split("\n")) {
    if (line.startsWith("<<<<<<<")) { state = "ours"; continue; }
    if (line === "=======" || line.startsWith("======= ")) { state = "theirs"; continue; }
    if (line.startsWith(">>>>>>>")) { state = "normal"; continue; }

    if (state === "normal") {
      oursLines.push(line);
      theirsLines.push(line);
    } else if (state === "ours") {
      oursLines.push(line);
    } else {
      theirsLines.push(line);
    }
  }

  return { ours: oursLines.join("\n"), theirs: theirsLines.join("\n") };
}

// Parse LEARNINGS.md into a map of date -> bullet entries
function parseLearningsEntries(content: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let currentDate = "";

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        currentDate = heading;
        if (!entries.has(currentDate)) entries.set(currentDate, []);
      }
    } else if (line.startsWith("- ") && currentDate) {
      entries.get(currentDate)!.push(line);
    }
  }

  return entries;
}

// Merge two LEARNINGS.md versions: union entries per date, newest date first
export function mergeLearnings(ours: string, theirs: string): string {
  const ourEntries = parseLearningsEntries(ours);
  const theirEntries = parseLearningsEntries(theirs);

  const allDates = [...new Set([...ourEntries.keys(), ...theirEntries.keys()])].sort().reverse();

  // Preserve the title line from ours
  const titleLine = ours.split("\n")[0] || "# LEARNINGS";
  const lines = [titleLine, ""];

  for (const date of allDates) {
    const ourItems = ourEntries.get(date) ?? [];
    const theirItems = theirEntries.get(date) ?? [];
    const allItems = [...new Set([...ourItems, ...theirItems])];
    if (allItems.length > 0) {
      lines.push(`## ${date}`, "", ...allItems, "");
    }
  }

  return lines.join("\n");
}

// Parse backlog.md into a map of section name -> bullet entries
function parseBacklogSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
    } else if (line.startsWith("- ") && current) {
      sections.get(current)!.push(line);
    }
  }

  return sections;
}

// Merge two backlog.md versions: union items per section, deduplicated
export function mergeBacklog(ours: string, theirs: string): string {
  const ourSections = parseBacklogSections(ours);
  const theirSections = parseBacklogSections(theirs);

  const sectionOrder = ["Active", "Queue", "Done"];
  const allSections = [...new Set([...ourSections.keys(), ...theirSections.keys()])];
  const ordered = [
    ...sectionOrder.filter(s => allSections.includes(s)),
    ...allSections.filter(s => !sectionOrder.includes(s)),
  ];

  const titleLine = ours.split("\n")[0] || "# backlog";
  const lines = [titleLine, ""];

  for (const section of ordered) {
    const ourItems = ourSections.get(section) ?? [];
    const theirItems = theirSections.get(section) ?? [];
    const allItems = [...new Set([...ourItems, ...theirItems])];
    lines.push(`## ${section}`, "", ...allItems, "");
  }

  return lines.join("\n");
}

// Attempt to auto-resolve git conflicts in LEARNINGS.md and backlog.md files.
// Returns true if all conflicts were resolved, false if any remain.
export function autoMergeConflicts(cortexPath: string): boolean {
  let conflictedFiles: string[];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: cortexPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    conflictedFiles = out ? out.split("\n") : [];
  } catch (err: any) {
    debugLog(`autoMergeConflicts: failed to list conflicted files: ${err.message}`);
    return false;
  }

  if (conflictedFiles.length === 0) return true;

  let allResolved = true;

  for (const relFile of conflictedFiles) {
    const fullPath = path.join(cortexPath, relFile);
    const filename = path.basename(relFile).toLowerCase();

    const canAutoMerge = filename === "learnings.md" || filename === "backlog.md";
    if (!canAutoMerge) {
      debugLog(`Cannot auto-merge: ${relFile} (not a known mergeable file)`);
      allResolved = false;
      continue;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const versions = extractConflictVersions(content);
      if (!versions) continue; // No actual conflict markers

      const merged = filename === "learnings.md"
        ? mergeLearnings(versions.ours, versions.theirs)
        : mergeBacklog(versions.ours, versions.theirs);

      fs.writeFileSync(fullPath, merged);
      execFileSync("git", ["add", "--", relFile], { cwd: cortexPath, stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_MS });
      debugLog(`Auto-merged: ${relFile}`);
    } catch (err: any) {
      debugLog(`Failed to auto-merge ${relFile}: ${err.message}`);
      allResolved = false;
    }
  }

  return allResolved;
}

function getHeadCommit(cwd: string): string | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return commit || undefined;
  } catch {
    // Expected when cwd is not inside a git repo
    return undefined;
  }
}

function getRepoRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS }).trim();
    return root || undefined;
  } catch {
    // Expected when cwd is not inside a git repo
    return undefined;
  }
}

function inferCitationLocation(repoPath: string, commit: string): { file?: string; line?: number } {
  try {
    const raw = execFileSync(
      "git",
      ["show", "--pretty=format:", "--unified=0", "--no-color", commit],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }
    );
    let currentFile = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6).trim();
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk && currentFile) {
        return { file: currentFile, line: Number.parseInt(hunk[1], 10) };
      }
    }
  } catch (err: any) {
    debugLog(`citationLocationFromCommit: git show failed: ${err.message}`);
  }
  return {};
}

function buildCitationComment(citation: LearningCitation): string {
  return `<!-- cortex:cite ${JSON.stringify(citation)} -->`;
}

function parseCitationComment(line: string): LearningCitation | null {
  const match = line.match(/<!--\s*cortex:cite\s+(\{.*\})\s*-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as LearningCitation;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.created_at !== "string" || !parsed.created_at) return null;
    return parsed;
  } catch {
    // Malformed JSON in citation comment, treat as uncitable
    return null;
  }
}

function resolveCitationFile(citation: LearningCitation): string | null {
  if (!citation.file) return null;
  if (path.isAbsolute(citation.file)) return citation.file;
  if (citation.repo) return path.resolve(citation.repo, citation.file);
  return path.resolve(citation.file);
}

function commitExists(repoPath: string, commit: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
    return true;
  } catch {
    // Expected when commit SHA doesn't exist in the repo
    return false;
  }
}

function isCitationValid(citation: LearningCitation): boolean {
  if (citation.repo && !fs.existsSync(citation.repo)) return false;
  if (citation.commit && citation.repo && !commitExists(citation.repo, citation.commit)) return false;

  const resolvedFile = resolveCitationFile(citation);
  if (resolvedFile) {
    if (!fs.existsSync(resolvedFile)) return false;
    if (citation.line !== undefined) {
      if (!Number.isInteger(citation.line) || citation.line < 1) return false;
      const lineCount = fs.readFileSync(resolvedFile, "utf8").split("\n").length;
      if (citation.line > lineCount) return false;
      // Strong validation: if commit+repo are set, line blame must resolve to the cited commit.
      if (citation.commit && citation.repo) {
        const relFile = path.isAbsolute(resolvedFile)
          ? path.relative(citation.repo, resolvedFile)
          : resolvedFile;
        try {
          const out = execFileSync(
            "git",
            ["blame", "-L", `${citation.line},${citation.line}`, "--porcelain", relFile],
            { cwd: citation.repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
          ).trim();
          const first = out.split("\n")[0] || "";
          if (!first.startsWith(citation.commit)) return false;
        } catch {
          // git blame can fail for many reasons (shallow clone, missing file); treat as invalid
          return false;
        }
      }
    }
  }

  return true;
}

function parseLearningDateHeading(line: string): string | null {
  const match = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function isDateStale(headingDate: string, ttlDays: number): boolean {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return false;
  const ageDays = Math.floor((Date.now() - ts) / 86400000);
  return ageDays > ttlDays;
}

function ageDaysForDate(headingDate: string): number | null {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

function confidenceForAge(ageDays: number, decay: MemoryPolicy["decay"]): number {
  if (ageDays <= 30) return decay.d30;
  if (ageDays <= 60) return decay.d60;
  if (ageDays <= 90) return decay.d90;
  return decay.d120;
}

// Keep only trustworthy learning bullets.
// - Legacy bullets (no citation) are kept until they age out by date heading.
// - Cited bullets are only kept if citation validates.
export function filterTrustedLearnings(content: string, ttlDays: number): string {
  return filterTrustedLearningsDetailed(content, { ttlDays }).content;
}

export function filterTrustedLearningsDetailed(content: string, opts: number | TrustFilterOptions): {
  content: string;
  issues: LearningTrustIssue[];
} {
  const options: TrustFilterOptions = typeof opts === "number" ? { ttlDays: opts } : opts;
  const ttlDays = options.ttlDays ?? 120;
  const minConfidence = options.minConfidence ?? 0.35;
  const decay: MemoryPolicy["decay"] = {
    ...DEFAULT_POLICY.decay,
    ...(options.decay || {}),
  };

  const lines = content.split("\n");
  const out: string[] = [];
  const issues: LearningTrustIssue[] = [];
  let currentDate: string | null = null;
  let headingBuffer: string[] = [];
  let inDetails = false;

  const flushHeading = (hasEntries: boolean) => {
    if (headingBuffer.length === 0) return;
    if (hasEntries) {
      out.push(...headingBuffer);
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }
    headingBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("<details>")) {
      inDetails = true;
      continue;
    }
    if (line.includes("</details>")) {
      inDetails = false;
      continue;
    }
    if (inDetails) continue;

    const headingDate = parseLearningDateHeading(line);
    if (headingDate) {
      flushHeading(false);
      currentDate = headingDate;
      headingBuffer = [line];
      continue;
    }

    if (line.startsWith("# ")) {
      if (out.length === 0) out.push(line, "");
      continue;
    }

    if (!line.startsWith("- ")) continue;

    const stale = currentDate ? isDateStale(currentDate, ttlDays) : false;
    if (stale) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
      continue;
    }

    let confidence = 1;
    if (currentDate) {
      const age = ageDaysForDate(currentDate);
      if (age !== null) confidence *= confidenceForAge(age, decay);
    }

    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);
    if (citation && !isCitationValid(citation)) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "invalid_citation" });
      continue;
    }
    if (!citation) confidence *= 0.8;
    if (confidence < minConfidence) {
      issues.push({ date: currentDate || "unknown", bullet: line, reason: "stale" });
      continue;
    }

    flushHeading(true);
    out.push(line);
    if (citation) {
      out.push(next);
      i++;
    }
  }

  return { content: out.join("\n").trim(), issues };
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

export function appendAuditLog(cortexPath: string, event: string, details: string): void {
  const logPath = path.join(cortexPath, ".cortex-audit.log");
  const line = `[${new Date().toISOString()}] ${event} ${details}\n`;
  try {
    fs.appendFileSync(logPath, line);
    const stat = fs.statSync(logPath);
    if (stat.size > 1_000_000) {
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(logPath, lines.slice(-500).join("\n"));
    }
  } catch (err: any) {
    debugLog(`Audit log write failed: ${err.message}`);
  }
}

const LEGACY_FINDINGS_CANDIDATES = [
  "FINDINGS.md",
  "findings.md",
  "LESSONS.md",
  "lessons.md",
  "POSTMORTEM.md",
  "postmortem.md",
  "RETRO.md",
  "retro.md",
];

function normalizeMigratedBullet(raw: string): string {
  const cleaned = raw
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  return cleaned;
}

function shouldPinCanonical(text: string): boolean {
  return /(must|always|never|avoid|required|critical|do not|don't)\b/i.test(text);
}

export function migrateLegacyFindings(
  cortexPath: string,
  project: string,
  opts: { pinCanonical?: boolean; dryRun?: boolean } = {}
): string {
  const denial = checkMemoryPermission(cortexPath, "write");
  if (denial) return denial;
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return `Project "${project}" not found in cortex.`;

  const available = new Map(
    fs.readdirSync(resolvedDir).map((name) => [name.toLowerCase(), name] as const)
  );
  const files = LEGACY_FINDINGS_CANDIDATES
    .map((name) => available.get(name.toLowerCase()))
    .filter((name): name is string => Boolean(name));
  if (!files.length) return `No legacy findings docs found for "${project}".`;

  const seen = new Set<string>();
  const extracted: Array<{ text: string; file: string; line: number }> = [];

  for (const file of files) {
    const fullPath = path.join(resolvedDir, file);
    const lines = fs.readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.match(/^\s*(?:[-*]\s+|\d+\.\s+)/)) continue;
      const bullet = normalizeMigratedBullet(line);
      if (!bullet) continue;
      const key = bullet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push({ text: bullet, file, line: i + 1 });
    }
  }

  if (!extracted.length) {
    return `Legacy findings docs found for "${project}", but no actionable bullet entries were detected.`;
  }

  if (opts.dryRun) {
    return `Found ${extracted.length} migratable findings in ${files.length} file(s) for "${project}".`;
  }

  let migrated = 0;
  let pinned = 0;
  for (const entry of extracted) {
    const learning = `${entry.text} (migrated from ${entry.file})`;
    addLearningToFile(cortexPath, project, learning, {
      repo: resolvedDir,
      file: path.join(resolvedDir, entry.file),
      line: entry.line,
    });
    migrated++;

    if (opts.pinCanonical && shouldPinCanonical(entry.text)) {
      upsertCanonicalMemory(cortexPath, project, entry.text);
      pinned++;
    }
  }

  appendAuditLog(
    cortexPath,
    "migrate_findings",
    `project=${project} files=${files.length} migrated=${migrated} pinned=${pinned}`
  );
  return `Migrated ${migrated} findings for "${project}" from ${files.length} legacy file(s)${opts.pinCanonical ? `; pinned ${pinned} canonical memories` : ""}.`;
}

export function upsertCanonicalMemory(cortexPath: string, project: string, memory: string): string {
  const denial = checkMemoryPermission(cortexPath, "pin");
  if (denial) return denial;
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return `Project "${project}" not found in cortex.`;
  const canonicalPath = path.join(resolvedDir, "CANONICAL_MEMORIES.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = memory.startsWith("- ") ? memory : `- ${memory}`;

  if (!fs.existsSync(canonicalPath)) {
    fs.writeFileSync(
      canonicalPath,
      `# ${project} Canonical Memories\n\n## Pinned\n\n${bullet} _(pinned ${today})_\n`
    );
  } else {
    const content = fs.readFileSync(canonicalPath, "utf8");
    const line = `${bullet} _(pinned ${today})_`;
    if (!content.includes(bullet)) {
      const updated = content.includes("## Pinned")
        ? content.replace("## Pinned", `## Pinned\n\n${line}`)
        : `${content.trimEnd()}\n\n## Pinned\n\n${line}\n`;
      fs.writeFileSync(canonicalPath, updated.endsWith("\n") ? updated : updated + "\n");
    }
  }

  const canonicalContent = fs.readFileSync(canonicalPath, "utf8");
  const locks = loadCanonicalLocks(cortexPath);
  const lockKey = `${project}/CANONICAL_MEMORIES.md`;
  locks[lockKey] = {
    hash: hashContent(canonicalContent),
    snapshot: canonicalContent,
    updatedAt: new Date().toISOString(),
  };
  saveCanonicalLocks(cortexPath, locks);
  appendAuditLog(cortexPath, "pin_memory", `project=${project} memory=${JSON.stringify(memory)}`);
  return `Pinned canonical memory in ${project}.`;
}

// Add a learning to a project's LEARNINGS.md
export function addLearningToFile(
  cortexPath: string,
  project: string,
  learning: string,
  citationInput?: Partial<LearningCitation>
): string {
  const denial = checkMemoryPermission(cortexPath, "write");
  if (denial) return denial;
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return `Invalid project name: "${project}".`;
  const learningsPath = path.join(resolvedDir, "LEARNINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const bullet = learning.startsWith("- ") ? learning : `- ${learning}`;
  const nowIso = new Date().toISOString();
  const cwd = process.cwd();
  const inferredRepo = getRepoRoot(cwd);
  const citation: LearningCitation = {
    created_at: nowIso,
    repo: citationInput?.repo || inferredRepo,
    file: citationInput?.file,
    line: citationInput?.line,
    commit: citationInput?.commit || (inferredRepo ? getHeadCommit(inferredRepo) : undefined),
  };
  if (citation.repo && citation.commit && (!citation.file || !citation.line)) {
    const inferred = inferCitationLocation(citation.repo, citation.commit);
    citation.file = citation.file || inferred.file;
    citation.line = citation.line || inferred.line;
  }
  const citationComment = `  ${buildCitationComment(citation)}`;

  if (!fs.existsSync(learningsPath)) {
    if (!fs.existsSync(resolvedDir)) return `Project "${project}" not found in cortex.`;
    const newContent = `# ${project} LEARNINGS\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
    fs.writeFileSync(learningsPath, newContent);
    appendAuditLog(
      cortexPath,
      "add_learning",
      `project=${project} created=true citation_commit=${citation.commit ?? "none"} citation_file=${citation.file ?? "none"}`
    );
    return `Created LEARNINGS.md for "${project}" and added insight.`;
  }

  const content = fs.readFileSync(learningsPath, "utf8");

  // Soft-validate before writing
  const issues = validateLearningsFormat(content);
  if (issues.length > 0) {
    debugLog(`LEARNINGS.md format warnings for "${project}": ${issues.join("; ")}`);
  }

  const todayHeader = `## ${today}`;
  let updated: string;

  if (content.includes(todayHeader)) {
    updated = content.replace(todayHeader, `${todayHeader}\n\n${bullet}\n${citationComment}`);
  } else {
    const firstHeading = content.match(/^(## \d{4}-\d{2}-\d{2})/m);
    if (firstHeading) {
      updated = content.replace(firstHeading[0], `${todayHeader}\n\n${bullet}\n${citationComment}\n\n${firstHeading[0]}`);
    } else {
      updated = content.trimEnd() + `\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
    }
  }

  const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, updated);
  fs.renameSync(tmpPath, learningsPath);

  appendAuditLog(
    cortexPath,
    "add_learning",
    `project=${project} citation_commit=${citation.commit ?? "none"} citation_file=${citation.file ?? "none"}`
  );
  return `Added learning to ${project}: ${bullet} (with citation metadata)`;
}
