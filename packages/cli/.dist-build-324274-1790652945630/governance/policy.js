import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { appendAuditLog, debugLog, getProjectDirs, isRecord, runtimeDir, runtimeHealthFile, withDefaults, phrenErr, PhrenError, phrenOk, resolveFindingsPath } from "../shared.js";
import { withFileLock, isFiniteNumber, hasValidSchemaVersion } from "../shared/governance.js";
import { errorMessage, isValidProjectName } from "../utils.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { readProjectConfig } from "../project-config.js";
import { getActiveProfileDefaults } from "../profile-store.js";
import { runCustomHooks } from "../hooks.js";
import { METADATA_REGEX, isCitationLine, isArchiveStart as isArchiveStartMeta, isArchiveEnd as isArchiveEndMeta, stripLifecycleMetadata as stripLifecycleMetadataMeta, } from "../content/metadata.js";
import { VALID_FINDING_SENSITIVITY, VALID_PROACTIVITY_LEVELS, VALID_TASK_MODES, VALID_RISKY_SECTIONS, } from "./policy-constants.js";
/** @internal Exported for tests. */
export const MAX_QUEUE_ENTRY_LENGTH = 500;
export const PUSH_STATUSES = [
    "saved-local", "saved-pushed", "no-upstream", "pull-failed", "push-failed", "unrelated-histories", "error",
];
/** Push statuses that mean the store is NOT in sync with its remote. */
export const FAILED_PUSH_STATUSES = new Set([
    "pull-failed", "push-failed", "unrelated-histories", "error",
]);
export const AUTO_SAVE_STATUSES = [
    "clean", "saved-local", "saved-pushed", "no-upstream", "sync-failed", "error",
];
export function buildSyncStatus(opts) {
    return {
        ...(opts.pullAt !== undefined ? { lastPullAt: opts.pullAt } : {}),
        ...(opts.pullStatus !== undefined ? { lastPullStatus: opts.pullStatus } : {}),
        ...(opts.pullDetail !== undefined ? { lastPullDetail: opts.pullDetail } : {}),
        ...(opts.successfulPullAt !== undefined ? { lastSuccessfulPullAt: opts.successfulPullAt } : {}),
        lastPushAt: opts.now,
        lastPushStatus: opts.pushStatus,
        ...(opts.pushDetail !== undefined ? { lastPushDetail: opts.pushDetail } : {}),
        ...(opts.unsyncedCommits !== undefined ? { unsyncedCommits: opts.unsyncedCommits } : {}),
        ...(opts.consecutiveFailures !== undefined ? { consecutiveFailures: opts.consecutiveFailures } : {}),
        ...(opts.successfulPushAt !== undefined ? { lastSuccessfulPushAt: opts.successfulPushAt } : {}),
    };
}
/** Warn after this many consecutive failed syncs. */
export const SYNC_FAILURE_WARN_RUNS = 3;
/** ...or after this many days without a successful push, whichever comes first. */
export const SYNC_FAILURE_WARN_DAYS = 3;
/**
 * Decide whether a store's sync failures have gone on long enough to warrant a
 * visible warning. Pure so both the Stop hook and `phren status` can ask the
 * same question and get the same answer.
 */
export function assessSyncOutage(sync, nowMs = Date.now()) {
    const consecutiveFailures = sync?.consecutiveFailures ?? 0;
    const failingNow = sync?.lastPushStatus !== undefined && FAILED_PUSH_STATUSES.has(sync.lastPushStatus);
    let daysSinceSuccess = null;
    const successAt = sync?.lastSuccessfulPushAt;
    if (successAt) {
        const parsed = Date.parse(successAt);
        if (!Number.isNaN(parsed))
            daysSinceSuccess = (nowMs - parsed) / 86_400_000;
    }
    const staleTooLong = failingNow && daysSinceSuccess !== null && daysSinceSuccess >= SYNC_FAILURE_WARN_DAYS;
    const degraded = (failingNow && consecutiveFailures >= SYNC_FAILURE_WARN_RUNS) || staleTooLong;
    if (!degraded)
        return { degraded: false, consecutiveFailures, daysSinceSuccess, summary: "" };
    const parts = [];
    if (consecutiveFailures > 0)
        parts.push(`${consecutiveFailures} consecutive failed sync${consecutiveFailures === 1 ? "" : "s"}`);
    if (daysSinceSuccess !== null)
        parts.push(`last successful push ${Math.floor(daysSinceSuccess)}d ago`);
    if (sync?.unsyncedCommits)
        parts.push(`${sync.unsyncedCommits} unpushed commit(s)`);
    const cause = sync?.lastPushStatus === "unrelated-histories"
        ? "local and remote histories are unrelated — the remote was most likely re-initialized"
        : (sync?.lastPushDetail || sync?.lastPullDetail || "see `phren status` for details");
    return {
        degraded: true,
        consecutiveFailures,
        daysSinceSuccess,
        summary: `phren has not synced (${parts.join(", ")}): ${cause}`,
    };
}
export const GOVERNANCE_SCHEMA_VERSION = 1;
/** Default retention policy. Exported so {@link config/schema} can render one source of truth. */
export const DEFAULT_POLICY = {
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
/** Default workflow policy. Exported so {@link config/schema} can render one source of truth. */
export const DEFAULT_WORKFLOW_POLICY = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    lowConfidenceThreshold: 0.7,
    riskySections: ["Stale", "Conflicts"],
    taskMode: "auto",
    findingSensitivity: "balanced",
};
/** Default index policy. Exported so {@link config/schema} can render one source of truth. */
export const DEFAULT_INDEX_POLICY = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    // Skills are instructions you invoke by name, not knowledge to retrieve:
    // indexed, they crowd the findings out of a prompt's context budget (nine of
    // twelve injections in one session were skill files). They stay reachable
    // through list_skills and the global AGENTS.md.
    includeGlobs: ["**/*.md"],
    excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/skills/**", "**/.claude/skills/**"],
    includeHidden: false,
};
const DEFAULT_RUNTIME_HEALTH = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
};
function governanceDir(phrenPath) {
    return path.join(phrenPath, ".config");
}
function govFile(phrenPath, schema) {
    return path.join(governanceDir(phrenPath), GOVERNANCE_REGISTRY[schema].file);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function pickNumber(value, fallback) {
    return isFiniteNumber(value) ? value : fallback;
}
function pickBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function cleanStringArray(value, fallback) {
    if (!Array.isArray(value))
        return [...fallback];
    const cleaned = value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
    return cleaned.length ? cleaned : [...fallback];
}
const GOVERNANCE_VALIDATORS = {
    "retention-policy": (data) => hasValidSchemaVersion(data)
        && ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"].every((key) => !(key in data) || isFiniteNumber(data[key]))
        && (!("decay" in data) || (() => {
            if (!isRecord(data.decay))
                return false;
            const decay = data.decay;
            return ["d30", "d60", "d90", "d120"].every((key) => !(key in decay) || isFiniteNumber(decay[key]));
        })()),
    "workflow-policy": (data) => hasValidSchemaVersion(data)
        && (!("lowConfidenceThreshold" in data) || isFiniteNumber(data.lowConfidenceThreshold))
        && (!("riskySections" in data) || isStringArray(data.riskySections))
        && (!("taskMode" in data) || ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))),
    "index-policy": (data) => hasValidSchemaVersion(data)
        && ["includeGlobs", "excludeGlobs"].every((key) => !(key in data) || isStringArray(data[key]))
        && (!("includeHidden" in data) || typeof data.includeHidden === "boolean"),
};
const GOVERNANCE_REGISTRY = {
    "retention-policy": {
        file: "retention-policy.json",
        validate: GOVERNANCE_VALIDATORS["retention-policy"],
        defaults: () => ({ ...DEFAULT_POLICY }),
        normalize: (data) => normalizeRetentionPolicy(data),
    },
    "workflow-policy": {
        file: "workflow-policy.json",
        validate: GOVERNANCE_VALIDATORS["workflow-policy"],
        defaults: () => ({ ...DEFAULT_WORKFLOW_POLICY }),
        normalize: (data) => normalizeWorkflowPolicy(data),
    },
    "index-policy": {
        file: "index-policy.json",
        validate: GOVERNANCE_VALIDATORS["index-policy"],
        defaults: () => ({ ...DEFAULT_INDEX_POLICY }),
        normalize: (data) => normalizeIndexPolicy(data),
    },
};
const GOVERNANCE_FILE_SCHEMAS = Object.fromEntries(Object.entries(GOVERNANCE_REGISTRY).map(([schema, entry]) => [entry.file, schema]));
export function validateGovernanceJson(filePath, schema) {
    try {
        if (!fs.existsSync(filePath))
            return true;
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
    }
    catch (err) {
        debugLog(`validateGovernanceJson parse error for ${filePath}: ${errorMessage(err)}`);
        return false;
    }
}
function extractGovernanceVersion(_schema, data) {
    return typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
}
function normalizeRuntimeHealth(data) {
    const normalized = { schemaVersion: GOVERNANCE_SCHEMA_VERSION };
    if (typeof data.lastSessionStartAt === "string")
        normalized.lastSessionStartAt = data.lastSessionStartAt;
    if (typeof data.lastPromptAt === "string")
        normalized.lastPromptAt = data.lastPromptAt;
    if (typeof data.lastStopAt === "string")
        normalized.lastStopAt = data.lastStopAt;
    if (isRecord(data.lastAutoSave) && typeof data.lastAutoSave.at === "string" && AUTO_SAVE_STATUSES.includes(String(data.lastAutoSave.status))) {
        normalized.lastAutoSave = {
            at: data.lastAutoSave.at,
            status: data.lastAutoSave.status,
            detail: typeof data.lastAutoSave.detail === "string" ? data.lastAutoSave.detail : undefined,
        };
    }
    if (isRecord(data.lastGovernance) && typeof data.lastGovernance.at === "string" && ["ok", "error"].includes(String(data.lastGovernance.status)) && typeof data.lastGovernance.detail === "string") {
        normalized.lastGovernance = {
            at: data.lastGovernance.at,
            status: data.lastGovernance.status,
            detail: data.lastGovernance.detail,
        };
    }
    if (isRecord(data.lastSync)) {
        normalized.lastSync = {};
        if (typeof data.lastSync.lastPullAt === "string")
            normalized.lastSync.lastPullAt = data.lastSync.lastPullAt;
        if (["ok", "error"].includes(String(data.lastSync.lastPullStatus)))
            normalized.lastSync.lastPullStatus = data.lastSync.lastPullStatus;
        if (typeof data.lastSync.lastPullDetail === "string")
            normalized.lastSync.lastPullDetail = data.lastSync.lastPullDetail;
        if (typeof data.lastSync.lastSuccessfulPullAt === "string")
            normalized.lastSync.lastSuccessfulPullAt = data.lastSync.lastSuccessfulPullAt;
        if (typeof data.lastSync.lastPushAt === "string")
            normalized.lastSync.lastPushAt = data.lastSync.lastPushAt;
        if (PUSH_STATUSES.includes(String(data.lastSync.lastPushStatus)))
            normalized.lastSync.lastPushStatus = data.lastSync.lastPushStatus;
        if (typeof data.lastSync.lastPushDetail === "string")
            normalized.lastSync.lastPushDetail = data.lastSync.lastPushDetail;
        if (isFiniteNumber(data.lastSync.unsyncedCommits))
            normalized.lastSync.unsyncedCommits = data.lastSync.unsyncedCommits;
        if (isFiniteNumber(data.lastSync.consecutiveFailures))
            normalized.lastSync.consecutiveFailures = data.lastSync.consecutiveFailures;
        if (typeof data.lastSync.lastSuccessfulPushAt === "string")
            normalized.lastSync.lastSuccessfulPushAt = data.lastSync.lastSuccessfulPushAt;
        if (isFiniteNumber(data.lastSync.ahead))
            normalized.lastSync.ahead = data.lastSync.ahead;
        if (isFiniteNumber(data.lastSync.behind))
            normalized.lastSync.behind = data.lastSync.behind;
    }
    return normalized;
}
function normalizeRetentionPolicy(data) {
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
function normalizeWorkflowPolicy(data) {
    const validSections = new Set(["Review", "Stale", "Conflicts"]);
    const taskMode = ["off", "manual", "suggest", "auto"].includes(String(data.taskMode))
        ? String(data.taskMode)
        : DEFAULT_WORKFLOW_POLICY.taskMode;
    const riskySections = Array.isArray(data.riskySections)
        ? data.riskySections.filter((section) => validSections.has(String(section)))
        : [];
    const findingSensitivity = ["minimal", "conservative", "balanced", "aggressive"].includes(String(data.findingSensitivity))
        ? String(data.findingSensitivity)
        : DEFAULT_WORKFLOW_POLICY.findingSensitivity;
    return {
        schemaVersion: GOVERNANCE_SCHEMA_VERSION,
        lowConfidenceThreshold: pickNumber(data.lowConfidenceThreshold, DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold),
        riskySections: riskySections.length ? riskySections : [...DEFAULT_WORKFLOW_POLICY.riskySections],
        taskMode,
        findingSensitivity,
    };
}
function normalizeIndexPolicy(data) {
    return {
        schemaVersion: GOVERNANCE_SCHEMA_VERSION,
        includeGlobs: cleanStringArray(data.includeGlobs, DEFAULT_INDEX_POLICY.includeGlobs),
        excludeGlobs: cleanStringArray(data.excludeGlobs, DEFAULT_INDEX_POLICY.excludeGlobs),
        includeHidden: pickBoolean(data.includeHidden, DEFAULT_INDEX_POLICY.includeHidden),
    };
}
export { VALID_PROACTIVITY_LEVELS, VALID_TASK_MODES, VALID_FINDING_SENSITIVITY, VALID_RISKY_SECTIONS, } from "./policy-constants.js";
function pickEnum(value, allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : undefined;
}
function pickPositiveInt(value) {
    return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}
function pickUnitInterval(value) {
    return isFiniteNumber(value) && value >= 0 && value <= 1 ? value : undefined;
}
function normalizeProjectConfigOverrides(raw) {
    if (!isRecord(raw))
        return undefined;
    const retentionRaw = isRecord(raw.retentionPolicy) ? raw.retentionPolicy : undefined;
    const decayRaw = retentionRaw && isRecord(retentionRaw.decay) ? retentionRaw.decay : undefined;
    const retentionPolicy = retentionRaw
        ? {
            ttlDays: pickPositiveInt(retentionRaw.ttlDays),
            retentionDays: pickPositiveInt(retentionRaw.retentionDays),
            autoAcceptThreshold: pickUnitInterval(retentionRaw.autoAcceptThreshold),
            minInjectConfidence: pickUnitInterval(retentionRaw.minInjectConfidence),
            decay: decayRaw
                ? {
                    d30: pickUnitInterval(decayRaw.d30),
                    d60: pickUnitInterval(decayRaw.d60),
                    d90: pickUnitInterval(decayRaw.d90),
                    d120: pickUnitInterval(decayRaw.d120),
                }
                : undefined,
        }
        : undefined;
    if (retentionPolicy && retentionPolicy.decay && Object.values(retentionPolicy.decay).every((value) => value === undefined)) {
        delete retentionPolicy.decay;
    }
    const workflowRaw = isRecord(raw.workflowPolicy) ? raw.workflowPolicy : undefined;
    const workflowPolicy = workflowRaw
        ? {
            lowConfidenceThreshold: pickUnitInterval(workflowRaw.lowConfidenceThreshold),
            riskySections: Array.isArray(workflowRaw.riskySections)
                ? workflowRaw.riskySections.filter((section) => typeof section === "string" && VALID_RISKY_SECTIONS.includes(section))
                : undefined,
        }
        : undefined;
    if (workflowPolicy && workflowPolicy.riskySections && workflowPolicy.riskySections.length === 0) {
        delete workflowPolicy.riskySections;
    }
    const overrides = {
        findingSensitivity: pickEnum(raw.findingSensitivity, VALID_FINDING_SENSITIVITY),
        proactivity: pickEnum(raw.proactivity, VALID_PROACTIVITY_LEVELS),
        proactivityFindings: pickEnum(raw.proactivityFindings, VALID_PROACTIVITY_LEVELS),
        proactivityTask: pickEnum(raw.proactivityTask, VALID_PROACTIVITY_LEVELS),
        taskMode: pickEnum(raw.taskMode, VALID_TASK_MODES),
        retentionPolicy: retentionPolicy && Object.values(retentionPolicy).some((value) => value !== undefined)
            ? retentionPolicy
            : undefined,
        workflowPolicy: workflowPolicy && Object.values(workflowPolicy).some((value) => value !== undefined)
            ? workflowPolicy
            : undefined,
    };
    return overrides;
}
function readProjectConfigOverrides(phrenPath, projectName) {
    try {
        const config = readProjectConfig(phrenPath, projectName);
        return normalizeProjectConfigOverrides(config.config);
    }
    catch {
        return undefined;
    }
}
export function getProjectConfigOverrides(phrenPath, projectName) {
    return readProjectConfigOverrides(phrenPath, projectName) ?? null;
}
export function mergeConfig(phrenPath, projectName, profile) {
    const globalRetention = getRetentionPolicyGlobal(phrenPath);
    const globalWorkflow = getWorkflowPolicyGlobal(phrenPath);
    if (projectName && !isValidProjectName(projectName)) {
        debugLog(`mergeConfig: invalid project name "${projectName}", using global defaults`);
        projectName = undefined;
    }
    // Load profile-level defaults (global → profile → project resolution chain)
    let profileDefaults;
    try {
        profileDefaults = getActiveProfileDefaults(phrenPath, profile);
    }
    catch {
        // profile defaults are best-effort
    }
    // Apply profile defaults on top of global to get the profile-level base
    const profileRetention = profileDefaults?.retentionPolicy
        ? {
            schemaVersion: globalRetention.schemaVersion,
            ttlDays: profileDefaults.retentionPolicy.ttlDays ?? globalRetention.ttlDays,
            retentionDays: profileDefaults.retentionPolicy.retentionDays ?? globalRetention.retentionDays,
            autoAcceptThreshold: profileDefaults.retentionPolicy.autoAcceptThreshold ?? globalRetention.autoAcceptThreshold,
            minInjectConfidence: profileDefaults.retentionPolicy.minInjectConfidence ?? globalRetention.minInjectConfidence,
            decay: {
                d30: profileDefaults.retentionPolicy.decay?.d30 ?? globalRetention.decay.d30,
                d60: profileDefaults.retentionPolicy.decay?.d60 ?? globalRetention.decay.d60,
                d90: profileDefaults.retentionPolicy.decay?.d90 ?? globalRetention.decay.d90,
                d120: profileDefaults.retentionPolicy.decay?.d120 ?? globalRetention.decay.d120,
            },
        }
        : globalRetention;
    const profileWorkflow = profileDefaults
        ? {
            schemaVersion: globalWorkflow.schemaVersion,
            lowConfidenceThreshold: profileDefaults.workflowPolicy?.lowConfidenceThreshold ?? globalWorkflow.lowConfidenceThreshold,
            riskySections: profileDefaults.workflowPolicy?.riskySections?.length
                ? profileDefaults.workflowPolicy.riskySections
                : globalWorkflow.riskySections,
            taskMode: profileDefaults.taskMode ?? globalWorkflow.taskMode,
            findingSensitivity: profileDefaults.findingSensitivity ?? globalWorkflow.findingSensitivity,
        }
        : globalWorkflow;
    if (!projectName) {
        return {
            findingSensitivity: profileWorkflow.findingSensitivity,
            proactivity: {
                base: profileDefaults?.proactivity,
                findings: profileDefaults?.proactivityFindings,
                tasks: profileDefaults?.proactivityTask,
            },
            taskMode: profileWorkflow.taskMode,
            retentionPolicy: profileRetention,
            workflowPolicy: profileWorkflow,
        };
    }
    const overrides = readProjectConfigOverrides(phrenPath, projectName);
    if (!overrides) {
        return {
            findingSensitivity: profileWorkflow.findingSensitivity,
            proactivity: {
                base: profileDefaults?.proactivity,
                findings: profileDefaults?.proactivityFindings,
                tasks: profileDefaults?.proactivityTask,
            },
            taskMode: profileWorkflow.taskMode,
            retentionPolicy: profileRetention,
            workflowPolicy: profileWorkflow,
        };
    }
    // Merge retention policy: profile as base, project overrides on top
    const retentionOverride = overrides.retentionPolicy;
    const mergedRetention = retentionOverride
        ? {
            schemaVersion: profileRetention.schemaVersion,
            ttlDays: retentionOverride.ttlDays ?? profileRetention.ttlDays,
            retentionDays: retentionOverride.retentionDays ?? profileRetention.retentionDays,
            autoAcceptThreshold: retentionOverride.autoAcceptThreshold ?? profileRetention.autoAcceptThreshold,
            minInjectConfidence: retentionOverride.minInjectConfidence ?? profileRetention.minInjectConfidence,
            decay: {
                d30: retentionOverride.decay?.d30 ?? profileRetention.decay.d30,
                d60: retentionOverride.decay?.d60 ?? profileRetention.decay.d60,
                d90: retentionOverride.decay?.d90 ?? profileRetention.decay.d90,
                d120: retentionOverride.decay?.d120 ?? profileRetention.decay.d120,
            },
        }
        : profileRetention;
    // Merge workflow policy: profile as base, project overrides on top
    const workflowOverride = overrides.workflowPolicy;
    const mergedWorkflow = {
        schemaVersion: profileWorkflow.schemaVersion,
        lowConfidenceThreshold: workflowOverride?.lowConfidenceThreshold ?? profileWorkflow.lowConfidenceThreshold,
        riskySections: workflowOverride?.riskySections?.length
            ? workflowOverride.riskySections
            : profileWorkflow.riskySections,
        taskMode: overrides.taskMode ?? profileWorkflow.taskMode,
        findingSensitivity: overrides.findingSensitivity ?? profileWorkflow.findingSensitivity,
    };
    return {
        findingSensitivity: mergedWorkflow.findingSensitivity,
        proactivity: {
            base: overrides.proactivity ?? profileDefaults?.proactivity,
            findings: overrides.proactivityFindings ?? profileDefaults?.proactivityFindings,
            tasks: overrides.proactivityTask ?? profileDefaults?.proactivityTask,
        },
        taskMode: mergedWorkflow.taskMode,
        retentionPolicy: mergedRetention,
        workflowPolicy: mergedWorkflow,
    };
}
function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath))
            return fallback;
        const basename = path.basename(filePath);
        const schema = GOVERNANCE_FILE_SCHEMAS[basename];
        if (schema && !validateGovernanceJson(filePath, schema)) {
            debugLog(`readJsonFile: ${filePath} failed validation, using defaults`);
            return fallback;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const fileVersion = schema ? extractGovernanceVersion(schema, parsed) : (typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0);
        if (fileVersion > GOVERNANCE_SCHEMA_VERSION) {
            debugLog(`Warning: ${filePath} has schemaVersion ${fileVersion}, expected <= ${GOVERNANCE_SCHEMA_VERSION}. Consider updating phren.`);
        }
        return parsed;
    }
    catch (err) {
        debugLog(`readJsonFile failed for ${filePath}: ${errorMessage(err)}`);
        return fallback;
    }
}
function writeJsonFileUnlocked(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmpPath, filePath);
}
function writeJsonFile(filePath, data) {
    withFileLock(filePath, () => {
        writeJsonFileUnlocked(filePath, data);
    });
}
function getRetentionPolicyGlobal(phrenPath) {
    const parsed = readJsonFile(govFile(phrenPath, "retention-policy"), {});
    return withDefaults(parsed, DEFAULT_POLICY);
}
export function getRetentionPolicy(phrenPath, projectName) {
    if (projectName)
        return mergeConfig(phrenPath, projectName).retentionPolicy;
    return getRetentionPolicyGlobal(phrenPath);
}
export function updateRetentionPolicy(phrenPath, patch) {
    const current = getRetentionPolicy(phrenPath);
    const next = {
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
function getWorkflowPolicyGlobal(phrenPath) {
    const parsed = readJsonFile(govFile(phrenPath, "workflow-policy"), {});
    const merged = withDefaults(parsed, DEFAULT_WORKFLOW_POLICY);
    const validSections = new Set(["Review", "Stale", "Conflicts"]);
    merged.riskySections = merged.riskySections.filter((section) => validSections.has(section));
    if (!merged.riskySections.length)
        merged.riskySections = DEFAULT_WORKFLOW_POLICY.riskySections;
    if (!["off", "manual", "suggest", "auto"].includes(merged.taskMode)) {
        merged.taskMode = DEFAULT_WORKFLOW_POLICY.taskMode;
    }
    if (!["minimal", "conservative", "balanced", "aggressive"].includes(merged.findingSensitivity)) {
        merged.findingSensitivity = DEFAULT_WORKFLOW_POLICY.findingSensitivity;
    }
    return merged;
}
export function getWorkflowPolicy(phrenPath, projectName) {
    if (projectName)
        return mergeConfig(phrenPath, projectName).workflowPolicy;
    return getWorkflowPolicyGlobal(phrenPath);
}
export function updateWorkflowPolicy(phrenPath, patch) {
    const current = getWorkflowPolicy(phrenPath);
    const riskySections = Array.isArray(patch.riskySections)
        ? patch.riskySections.filter((section) => ["Review", "Stale", "Conflicts"].includes(String(section)))
        : current.riskySections;
    const taskMode = patch.taskMode && ["off", "manual", "suggest", "auto"].includes(String(patch.taskMode))
        ? patch.taskMode
        : current.taskMode;
    const findingSensitivity = patch.findingSensitivity && ["minimal", "conservative", "balanced", "aggressive"].includes(String(patch.findingSensitivity))
        ? patch.findingSensitivity
        : current.findingSensitivity;
    const next = {
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
export function getIndexPolicy(phrenPath) {
    const parsed = readJsonFile(govFile(phrenPath, "index-policy"), {});
    const merged = withDefaults(parsed, DEFAULT_INDEX_POLICY);
    merged.includeGlobs = merged.includeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
    merged.excludeGlobs = merged.excludeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0);
    if (!merged.includeGlobs.length)
        merged.includeGlobs = DEFAULT_INDEX_POLICY.includeGlobs;
    if (!merged.excludeGlobs.length)
        merged.excludeGlobs = DEFAULT_INDEX_POLICY.excludeGlobs;
    return merged;
}
export function updateIndexPolicy(phrenPath, patch) {
    const current = getIndexPolicy(phrenPath);
    const next = {
        schemaVersion: current.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
        includeGlobs: Array.isArray(patch.includeGlobs)
            ? patch.includeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0)
            : current.includeGlobs,
        excludeGlobs: Array.isArray(patch.excludeGlobs)
            ? patch.excludeGlobs.filter((glob) => typeof glob === "string" && glob.trim().length > 0)
            : current.excludeGlobs,
        includeHidden: patch.includeHidden ?? current.includeHidden,
    };
    writeJsonFile(govFile(phrenPath, "index-policy"), next);
    appendAuditLog(phrenPath, "update_index_policy", JSON.stringify(next));
    return phrenOk(next);
}
export function getRuntimeHealth(phrenPath) {
    const parsed = readJsonFile(runtimeHealthFile(phrenPath), {});
    if (!isRecord(parsed))
        return { ...DEFAULT_RUNTIME_HEALTH };
    return normalizeRuntimeHealth(parsed);
}
export function updateRuntimeHealth(phrenPath, patch) {
    const file = runtimeHealthFile(phrenPath);
    return withFileLock(file, () => {
        const parsed = readJsonFile(file, {});
        const current = isRecord(parsed) ? normalizeRuntimeHealth(parsed) : { ...DEFAULT_RUNTIME_HEALTH };
        const next = {
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
function normalizeBulletForQueue(line) {
    return line.startsWith("- ") ? line.slice(2).trim() : line.trim();
}
function cleanQueueEntryText(raw) {
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
export function normalizeQueueEntryText(raw, opts = {}) {
    const cleaned = cleanQueueEntryText(raw);
    if (!cleaned)
        return phrenErr("Memory text cannot be empty.", PhrenError.EMPTY_INPUT);
    if (cleaned.length <= MAX_QUEUE_ENTRY_LENGTH) {
        return phrenOk({ text: cleaned, truncated: false });
    }
    if (!opts.truncate) {
        return phrenErr(`Memory text exceeds maximum length of ${MAX_QUEUE_ENTRY_LENGTH} characters (got ${cleaned.length}). Shorten it before saving.`, PhrenError.VALIDATION_ERROR);
    }
    return phrenOk({
        text: cleaned.slice(0, MAX_QUEUE_ENTRY_LENGTH - 1).trimEnd() + "…",
        truncated: true,
    });
}
/** Matches a string made up entirely of HTML comments (and whitespace). */
const QUEUE_META_ONLY_RE = /^(?:\s*<!--(?:(?!-->)[\s\S])*?-->)+\s*$/;
/** Strip every HTML comment from a line. */
function stripQueueComments(line) {
    return line.replace(/<!--(?:(?!-->)[\s\S])*?-->/g, " ");
}
/**
 * Identity key for queue dedup: the entry's visible text with the date prefix,
 * bullet marker, and metadata comments removed. Comment-insensitive so a line
 * that gained provenance metadata still dedups against the same text queued
 * before metadata existed.
 */
function queueDedupKey(line) {
    return stripQueueComments(line.trim())
        .replace(/^-\s*/, "")
        .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
}
export function appendReviewQueue(phrenPath, project, section, entries) {
    if (!isValidProjectName(project))
        return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
    const resolvedDir = storeAwareProjectPath(phrenPath, project);
    if (!resolvedDir || !fs.existsSync(resolvedDir))
        return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);
    const queuePath = path.join(resolvedDir, "review.md");
    const today = new Date().toISOString().slice(0, 10);
    const normalized = [];
    for (const entry of entries) {
        const rawText = typeof entry === "string" ? entry : entry.text;
        const rawMeta = typeof entry === "string" ? "" : (entry.meta ?? "");
        const sanitized = normalizeQueueEntryText(normalizeBulletForQueue(rawText), { truncate: true });
        if (!sanitized.ok)
            continue;
        if (sanitized.data.truncated) {
            debugLog(`appendReviewQueue: truncated oversized queue entry for ${project}`);
        }
        // Metadata must be comments only and single-line — anything else would leak
        // producer-controlled markup into a file humans read and agents may render.
        const meta = rawMeta.replace(/[\r\n]+/g, " ").trim();
        const safeMeta = meta && QUEUE_META_ONLY_RE.test(meta) ? meta : "";
        if (meta && !safeMeta) {
            debugLog(`appendReviewQueue: dropped non-comment queue metadata for ${project}`);
        }
        normalized.push({ text: sanitized.data.text, meta: safeMeta });
    }
    if (normalized.length === 0)
        return phrenOk(0);
    return withFileLock(queuePath, () => {
        let content = "";
        if (fs.existsSync(queuePath)) {
            content = fs.readFileSync(queuePath, "utf8");
        }
        else {
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
        while (insertAt < lines.length && !lines[insertAt].startsWith("## "))
            insertAt++;
        // Dedup by entry text only (date prefix and metadata comments stripped) so the
        // same finding isn't queued again every day.
        const existingKeys = new Set(lines.filter((line) => line.trim().startsWith("- ")).map(queueDedupKey));
        const toInsert = [];
        for (const entry of normalized) {
            const key = queueDedupKey(entry.text);
            if (!key || existingKeys.has(key))
                continue;
            existingKeys.add(key);
            toInsert.push(`- [${today}] ${entry.text}${entry.meta ? ` ${entry.meta}` : ""}`);
        }
        if (!toInsert.length)
            return phrenOk(0);
        lines.splice(insertAt, 0, ...toInsert, "");
        fs.writeFileSync(queuePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
        return phrenOk(toInsert.length);
    });
}
/**
 * Read the retrieval log once and index the most recent retrieval per document key.
 * Keys match what cli-hooks-output's recordRetrieval writes: `<project>/FINDINGS.md:<type>`.
 */
function lastRetrievalByDocument(phrenPath) {
    const byKey = new Map();
    const logPath = path.join(runtimeDir(phrenPath), "retrieval-log.jsonl");
    if (!fs.existsSync(logPath))
        return byKey;
    try {
        for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
            if (!line)
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof entry.file !== "string" || typeof entry.retrievedAt !== "string")
                continue;
            const ts = Date.parse(entry.retrievedAt);
            if (Number.isNaN(ts))
                continue;
            const key = `${entry.file}:${entry.section}`;
            if (ts > (byKey.get(key) || 0))
                byKey.set(key, ts);
        }
    }
    catch (err) {
        debugLog(`pruneDeadMemories: retrieval log unreadable: ${errorMessage(err)}`);
    }
    return byKey;
}
/**
 * Findings past their TTL that haven't been retrieved recently, rendered for the queue.
 * Entries without a `<!-- created: -->` stamp are skipped defensively.
 */
function collectTtlExpiredEntries(file, project, ttlDays, lastRetrieval) {
    const retrievalGraceDays = Math.floor(ttlDays / 2);
    const now = Date.now();
    const expired = [];
    let content;
    try {
        content = fs.readFileSync(file, "utf8");
    }
    catch (err) {
        debugLog(`pruneDeadMemories: ${file} unreadable for TTL scan: ${errorMessage(err)}`);
        return expired;
    }
    for (const line of content.split("\n")) {
        if (!line.startsWith("- "))
            continue;
        const createdMatch = line.match(/<!--\s*created:\s*(\d{4}-\d{2}-\d{2})\s*-->/);
        if (!createdMatch)
            continue;
        const createdDate = createdMatch[1];
        const createdMs = Date.parse(`${createdDate}T00:00:00Z`);
        if (Number.isNaN(createdMs))
            continue;
        if (Math.floor((now - createdMs) / 86_400_000) <= ttlDays)
            continue;
        // Retrieval is logged at document level, so look up the document key rather than
        // the bullet.
        const retrievedAt = lastRetrieval.get(`${project}/${path.basename(file)}:findings`) || 0;
        const daysSinceRetrieval = retrievedAt ? Math.floor((now - retrievedAt) / 86_400_000) : Infinity;
        if (daysSinceRetrieval <= retrievalGraceDays)
            continue;
        expired.push(`[ttl-expired: ${createdDate}] ${line.slice(2).trim()}`);
    }
    return expired;
}
/**
 * Delete entries past the retention window and promote TTL-expired entries into review.md.
 *
 * TTL promotion lives here rather than in the CLI handler so that nightly maintenance
 * (`handleBackgroundMaintenance`, which calls this directly) gets it too — previously it
 * only ran on a manual `phren maintain prune`, leaving `## Stale` empty while `## Review`
 * filled up.
 */
export function pruneDeadMemories(phrenPath, project, dryRun) {
    if (project && !isValidProjectName(project))
        return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
    const dirs = project
        ? (() => {
            const resolvedProject = storeAwareProjectPath(phrenPath, project);
            return resolvedProject ? [resolvedProject] : [];
        })()
        : getProjectDirs(phrenPath).filter((dir) => path.basename(dir) !== "global");
    let pruned = 0;
    const dryRunDetails = [];
    for (const dir of dirs) {
        const file = resolveFindingsPath(dir);
        if (!file)
            continue;
        // Resolve per project: a project's own retentionDays override must win over
        // the global window, as it already does on the injection path.
        const cutoffDays = getRetentionPolicy(phrenPath, path.basename(dir)).retentionDays;
        // Q23: see docs/decisions/Q23-per-file-lock-concurrent-writers.md
        withFileLock(file, () => {
            const lines = fs.readFileSync(file, "utf8").split("\n");
            let currentDate = null;
            const next = [];
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
                        if (dryRun)
                            dryRunDetails.push(`[${path.basename(dir)}] ${line.slice(0, 80)}`);
                        const nextLine = lines[index + 1] || "";
                        if (isCitationLine(nextLine)) {
                            index++;
                        }
                        continue;
                    }
                }
                if (isCitationLine(line)) {
                    const previous = next.length ? next[next.length - 1] : "";
                    if (!previous.startsWith("- "))
                        continue;
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
    // TTL enforcement: promote entries older than ttlDays that haven't been retrieved recently.
    const lastRetrieval = lastRetrievalByDocument(phrenPath);
    let ttlExpired = 0;
    for (const dir of dirs) {
        const file = resolveFindingsPath(dir);
        if (!file)
            continue;
        const projectName = path.basename(dir);
        const expiredEntries = collectTtlExpiredEntries(file, projectName, getRetentionPolicy(phrenPath, projectName).ttlDays, lastRetrieval);
        if (!expiredEntries.length)
            continue;
        ttlExpired += expiredEntries.length;
        if (dryRun) {
            for (const entry of expiredEntries) {
                dryRunDetails.push(`[dry-run] [${projectName}] Would move to review queue: ${entry.slice(0, 120)}`);
            }
            continue;
        }
        appendReviewQueue(phrenPath, projectName, "Stale", expiredEntries);
    }
    const ttlLine = ttlExpired > 0
        ? `\n${dryRun ? "Would move" : "Moved"} ${ttlExpired} TTL-expired entr${ttlExpired === 1 ? "y" : "ies"} to review.md`
        : "";
    if (dryRun) {
        const summary = `[dry-run] Would prune ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.`;
        const detail = dryRunDetails.length ? `${summary}\n${dryRunDetails.join("\n")}` : summary;
        return phrenOk({ message: `${detail}${ttlLine}`, pruned, ttlExpired });
    }
    appendAuditLog(phrenPath, "prune_memories", `project=${project || "all"} pruned=${pruned} ttl_expired=${ttlExpired}`);
    return phrenOk({
        message: `Pruned ${pruned} stale memory entr${pruned === 1 ? "y" : "ies"}.${ttlLine}`,
        pruned,
        ttlExpired,
    });
}
function mergeLifecycleAndIdComments(primary, fallback) {
    const extract = (line, pattern) => line.match(pattern)?.[0];
    const strip = (line) => {
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
    const suffix = [fid, status, statusUpdated, statusReason, statusRef].filter((part) => Boolean(part));
    return suffix.length > 0 ? `${base} ${suffix.join(" ")}` : base;
}
export function consolidateProjectFindings(phrenPath, project, dryRun) {
    if (!isValidProjectName(project))
        return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
    const file = resolveFindingsPath(path.join(phrenPath, project));
    if (!file)
        return phrenErr(`No FINDINGS.md found for "${project}".`, PhrenError.FILE_NOT_FOUND);
    // Q23: see docs/decisions/Q23-per-file-lock-concurrent-writers.md
    const result = withFileLock(file, () => {
        const raw = fs.readFileSync(file, "utf8");
        const lines = raw.split("\n");
        // Q12: see docs/decisions/Q12-active-vs-archive-separation.md
        const archiveBlocks = [];
        const activeLines = [];
        let inArchive = false;
        let currentArchiveBlock = [];
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
        if (currentArchiveBlock.length)
            archiveBlocks.push(...currentArchiveBlock);
        // Process only the active section: deduplicate bullets within each date group
        const byDate = new Map();
        let currentDate = null;
        const title = activeLines.find((line) => line.startsWith("# ")) || `# ${project} Findings`;
        let totalBullets = 0;
        let uniqueBullets = 0;
        for (let index = 0; index < activeLines.length; index++) {
            const line = activeLines[index];
            const heading = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
            if (heading) {
                const date = heading[1];
                currentDate = date;
                if (!byDate.has(date))
                    byDate.set(date, new Map());
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
                }
                else {
                    existing.bullet = mergeLifecycleAndIdComments(existing.bullet, trimmedBullet);
                    if (!existing.citation && citation)
                        existing.citation = citation;
                }
                if (citation)
                    index++;
            }
        }
        const dates = [...byDate.keys()].sort().reverse();
        const duplicatesRemoved = totalBullets - uniqueBullets;
        if (dryRun) {
            return phrenOk(`[dry-run] ${project}: ${totalBullets} bullets, ${duplicatesRemoved} duplicate(s) would be removed, ${dates.length} date section(s).`);
        }
        // Reconstruct: consolidated active section first, then verbatim archive blocks
        const out = [title, ""];
        for (const date of dates) {
            const items = [...(byDate.get(date)?.values() || [])];
            if (!items.length)
                continue;
            out.push(`## ${date}`, "");
            for (const item of items) {
                out.push(item.bullet);
                if (item.citation)
                    out.push(item.citation);
            }
            out.push("");
        }
        // Append archive blocks verbatim (separated by a blank line if there's active content)
        if (archiveBlocks.length) {
            if (out.length && out[out.length - 1] !== "")
                out.push("");
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
