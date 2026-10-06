import { type PhrenResult } from "../shared.js";
export type TaskSection = "Active" | "Queue" | "Done";
export { TASK_FILE_ALIASES, TASKS_FILENAME, isTaskFileName } from "../filenames.js";
export interface TaskItem {
    /** Positional ID for display (e.g. "A1", "Q3"). Recomputed on every read — use stableId for persistent references. */
    id: string;
    /** Content-addressed stable ID embedded in the file as `<!-- bid:HASH -->`. Survives reordering and completions. */
    stableId?: string;
    section: TaskSection;
    line: string;
    checked: boolean;
    priority?: "high" | "medium" | "low";
    context?: string;
    pinned?: boolean;
    githubIssue?: number;
    githubUrl?: string;
    /** The computer (and optionally the session) that took this task; see claimTask. */
    claim?: TaskClaim;
    rank?: number;
    lastActivity?: string;
    createdAt?: string;
    sessionId?: string;
    scope?: string;
    childFindings?: string[];
    speculative?: boolean;
    parentFinding?: string;
}
/**
 * A conductor's claim on a task, written under it in tasks.md as
 * `  Claimed: <computer> <ISO time> [session:<id>]`. Conductors that are not
 * linked coordinate through the synced store: a claimed task is Active and
 * belongs to the claiming computer until it is done or released.
 */
export interface TaskClaim {
    computer: string;
    at: string;
    session?: string;
}
export interface TaskDoc {
    project: string;
    title: string;
    items: Record<TaskSection, TaskItem[]>;
    issues: string[];
    path: string;
}
export declare function stripBulletPrefix(line: string): {
    checked: boolean;
    body: string;
};
/** Strip the metadata comment from a raw line, returning the clean text and any extracted fields. */
export declare function stripBid(text: string): {
    clean: string;
    bid?: string;
    rank?: number;
    lastActivity?: string;
    createdAt?: string;
    sessionId?: string;
    scope?: string;
    childFindings?: string[];
    parentFinding?: string;
    speculative?: boolean;
};
/**
 * Apply gravity to tasks: items with stale lastActivity drift toward higher rank numbers.
 * Only affects display order — does not mutate the file.
 */
export declare function applyGravity(items: TaskItem[]): TaskItem[];
export declare function canonicalTaskFilePath(phrenPath: string, project: string): string | null;
export declare function resolveTaskFilePath(phrenPath: string, project: string): string | null;
export declare function readTasks(phrenPath: string, project: string): PhrenResult<TaskDoc>;
export declare function readTasksAcrossProjects(phrenPath: string, profile?: string): TaskDoc[];
export declare function resolveTaskItem(phrenPath: string, project: string, match: string): PhrenResult<TaskItem>;
export interface AddTaskOptions {
    createdAt?: string;
    sessionId?: string;
    scope?: string;
    speculative?: boolean;
    parentFinding?: string;
}
export declare function addTask(phrenPath: string, project: string, item: string, opts?: AddTaskOptions): PhrenResult<TaskItem>;
export declare function addTasks(phrenPath: string, project: string, items: string[], opts?: Pick<AddTaskOptions, "scope">): PhrenResult<{
    added: string[];
    errors: string[];
}>;
export declare function completeTasks(phrenPath: string, project: string, matches: string[]): PhrenResult<{
    completed: string[];
    errors: string[];
}>;
export declare function completeTask(phrenPath: string, project: string, match: string): PhrenResult<string>;
export declare function removeTask(phrenPath: string, project: string, match: string): PhrenResult<string>;
export declare function removeTasks(phrenPath: string, project: string, matches: string[]): PhrenResult<{
    removed: string[];
    errors: string[];
}>;
export declare function updateTask(phrenPath: string, project: string, match: string, updates: {
    text?: string;
    priority?: string;
    context?: string;
    replace_context?: boolean;
    section?: string;
    github_issue?: number | string;
    github_url?: string;
    unlink_github?: boolean;
}): PhrenResult<string>;
export declare function pinTask(phrenPath: string, project: string, match: string): PhrenResult<string>;
export declare function unpinTask(phrenPath: string, project: string, match: string): PhrenResult<string>;
export declare function reorderTask(phrenPath: string, project: string, match: string, targetRank: number): PhrenResult<string>;
export declare function appendChildFinding(phrenPath: string, project: string, match: string, findingId: string): PhrenResult<string>;
export declare function promoteTask(phrenPath: string, project: string, match: string, moveToActive: boolean): PhrenResult<TaskItem>;
/** A claim this old may be taken over with `force`: its conductor has likely gone. */
export declare const STALE_CLAIM_MS: number;
/**
 * Takes a task for `claim.computer`: moves it to Active and records the claim.
 * Refuses a task another computer holds unless `force` is set and that claim
 * is stale; claiming again from the same computer refreshes it. With
 * `release`, clears this computer's claim and returns the task to the Queue.
 */
export declare function claimTask(phrenPath: string, project: string, match: string, claim: TaskClaim, opts?: {
    release?: boolean;
    force?: boolean;
    now?: number;
}): PhrenResult<TaskItem>;
export declare function workNextTask(phrenPath: string, project: string): PhrenResult<string>;
export declare function tidyDoneTasks(phrenPath: string, project: string, keep?: number, dryRun?: boolean): PhrenResult<string>;
export declare function taskMarkdown(doc: TaskDoc): string;
export declare function linkTaskIssue(phrenPath: string, project: string, match: string, link: {
    github_issue?: number | string;
    github_url?: string;
    unlink?: boolean;
}): PhrenResult<TaskItem>;
