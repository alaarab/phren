import { type PhrenResult } from "../shared.js";
import { type ProjectConfigOverrides } from "../project-config.js";
/** @internal Exported for tests. */
export declare const MAX_QUEUE_ENTRY_LENGTH = 500;
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
/**
 * Outcome of the push leg of a sync.
 *
 * `saved-local` means "committed, nothing to push or no remote" — a success.
 * It used to double as the report for a *failed* push, which is how a store
 * could go two months without syncing while every Stop hook looked healthy.
 * Failures now get their own values:
 *
 * - `pull-failed`          - the fetch/merge leg failed, so push never ran
 * - `push-failed`          — push was attempted and rejected
 * - `unrelated-histories`  — local and remote share no merge base; no amount of
 *                            retrying will fix it, so it is called out by name
 */
export type PushStatus = "saved-local" | "saved-pushed" | "no-upstream" | "pull-failed" | "push-failed" | "unrelated-histories" | "error";
export declare const PUSH_STATUSES: readonly PushStatus[];
/** Push statuses that mean the store is NOT in sync with its remote. */
export declare const FAILED_PUSH_STATUSES: ReadonlySet<PushStatus>;
export type AutoSaveStatus = "clean" | "saved-local" | "saved-pushed" | "no-upstream" | "sync-failed" | "error";
export declare const AUTO_SAVE_STATUSES: readonly AutoSaveStatus[];
export interface RuntimeHealth {
    schemaVersion?: number;
    lastSessionStartAt?: string;
    lastPromptAt?: string;
    lastStopAt?: string;
    lastAutoSave?: {
        at: string;
        status: AutoSaveStatus;
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
        lastPushStatus?: PushStatus;
        lastPushDetail?: string;
        unsyncedCommits?: number;
        /**
         * Consecutive sync attempts that failed to reach the remote. Reset to 0 on
         * any successful push. This is what turns "one flaky push" into "this store
         * has been broken for weeks" without needing to keep a history.
         */
        consecutiveFailures?: number;
        /** Last time a push actually reached the remote. */
        lastSuccessfulPushAt?: string;
        /** Commits ahead of and behind the upstream tracking ref at the last sync outcome. */
        ahead?: number;
        behind?: number;
    };
}
export type SyncStatus = NonNullable<RuntimeHealth["lastSync"]>;
export interface BuildSyncStatusOpts {
    now: string;
    pushStatus: SyncStatus["lastPushStatus"];
    pushDetail?: string;
    pullAt?: string;
    pullStatus?: SyncStatus["lastPullStatus"];
    pullDetail?: string;
    successfulPullAt?: string;
    unsyncedCommits?: number;
    consecutiveFailures?: number;
    successfulPushAt?: string;
}
export declare function buildSyncStatus(opts: BuildSyncStatusOpts): SyncStatus;
/** Warn after this many consecutive failed syncs. */
export declare const SYNC_FAILURE_WARN_RUNS = 3;
/** ...or after this many days without a successful push, whichever comes first. */
export declare const SYNC_FAILURE_WARN_DAYS = 3;
export interface SyncOutageAssessment {
    /** True when the store has been failing long enough to tell the user. */
    degraded: boolean;
    consecutiveFailures: number;
    daysSinceSuccess: number | null;
    /** One-line, user-facing explanation. Empty when not degraded. */
    summary: string;
}
/**
 * Decide whether a store's sync failures have gone on long enough to warrant a
 * visible warning. Pure so both the Stop hook and `phren status` can ask the
 * same question and get the same answer.
 */
export declare function assessSyncOutage(sync: SyncStatus | undefined, nowMs?: number): SyncOutageAssessment;
export type RetentionPolicyPatch = Partial<Omit<RetentionPolicy, "decay">> & {
    decay?: Partial<RetentionPolicy["decay"]>;
};
export declare const GOVERNANCE_SCHEMA_VERSION = 1;
/** Default retention policy. Exported so {@link config/schema} can render one source of truth. */
export declare const DEFAULT_POLICY: RetentionPolicy;
/** Default workflow policy. Exported so {@link config/schema} can render one source of truth. */
export declare const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy;
/** Default index policy. Exported so {@link config/schema} can render one source of truth. */
export declare const DEFAULT_INDEX_POLICY: IndexPolicy;
type GovernanceSchema = "retention-policy" | "workflow-policy" | "index-policy";
export declare function validateGovernanceJson(filePath: string, schema: GovernanceSchema): boolean;
export interface ResolvedConfig {
    findingSensitivity: WorkflowPolicy["findingSensitivity"];
    proactivity: {
        base?: "high" | "medium" | "low";
        findings?: "high" | "medium" | "low";
        tasks?: "high" | "medium" | "low";
    };
    taskMode: WorkflowPolicy["taskMode"];
    retentionPolicy: RetentionPolicy;
    workflowPolicy: WorkflowPolicy;
}
export { VALID_PROACTIVITY_LEVELS, VALID_TASK_MODES, type TaskMode, VALID_FINDING_SENSITIVITY, type FindingSensitivityLevel, VALID_RISKY_SECTIONS, } from "./policy-constants.js";
export declare function getProjectConfigOverrides(phrenPath: string, projectName: string): ProjectConfigOverrides | null;
export declare function mergeConfig(phrenPath: string, projectName?: string, profile?: string): ResolvedConfig;
export declare function getRetentionPolicy(phrenPath: string, projectName?: string): RetentionPolicy;
export declare function updateRetentionPolicy(phrenPath: string, patch: RetentionPolicyPatch): PhrenResult<RetentionPolicy>;
export declare function getWorkflowPolicy(phrenPath: string, projectName?: string): WorkflowPolicy;
export declare function updateWorkflowPolicy(phrenPath: string, patch: Partial<WorkflowPolicy>): PhrenResult<WorkflowPolicy>;
export declare function getIndexPolicy(phrenPath: string): IndexPolicy;
export declare function updateIndexPolicy(phrenPath: string, patch: Partial<IndexPolicy>): PhrenResult<IndexPolicy>;
export declare function getRuntimeHealth(phrenPath: string): RuntimeHealth;
export declare function updateRuntimeHealth(phrenPath: string, patch: Partial<RuntimeHealth>): RuntimeHealth;
export declare function normalizeQueueEntryText(raw: string, opts?: {
    truncate?: boolean;
}): PhrenResult<{
    text: string;
    truncated: boolean;
}>;
/**
 * A queue entry that carries structured provenance alongside its text.
 *
 * `meta` is a pre-rendered run of HTML comments (e.g. `<!-- source:extract -->
 * <!-- phren:cite {...} -->`) appended verbatim to the queue line. It exists so a
 * queued candidate stays *promotable*: `approveQueueItem` reads it back and hands
 * the same repo/commit/source provenance to the normal add-finding path, which
 * makes a promoted finding indistinguishable from one added directly.
 *
 * Producers build the comments themselves (this module deliberately does not import
 * the citation helpers, to keep governance free of a content-layer import cycle).
 */
export interface ReviewQueueEntry {
    text: string;
    meta?: string;
}
export type ReviewQueueEntryInput = string | ReviewQueueEntry;
export declare function appendReviewQueue(phrenPath: string, project: string, section: "Review" | "Stale" | "Conflicts", entries: ReviewQueueEntryInput[]): PhrenResult<number>;
export interface PruneMemoriesResult {
    /** Human-readable summary (plus dry-run detail lines), ready to print. */
    message: string;
    /** Entries deleted for exceeding the retention window. */
    pruned: number;
    /** TTL-expired entries promoted into review.md's `## Stale` section. */
    ttlExpired: number;
}
/**
 * Delete entries past the retention window and promote TTL-expired entries into review.md.
 *
 * TTL promotion lives here rather than in the CLI handler so that nightly maintenance
 * (`handleBackgroundMaintenance`, which calls this directly) gets it too — previously it
 * only ran on a manual `phren maintain prune`, leaving `## Stale` empty while `## Review`
 * filled up.
 */
export declare function pruneDeadMemories(phrenPath: string, project?: string, dryRun?: boolean): PhrenResult<PruneMemoriesResult>;
export declare function consolidateProjectFindings(phrenPath: string, project: string, dryRun?: boolean): PhrenResult<string>;
