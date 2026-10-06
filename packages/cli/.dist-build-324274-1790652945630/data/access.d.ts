import { type PhrenResult } from "../shared.js";
import { type AddFindingResult } from "../shared/content.js";
import { type FindingCitation } from "../content/citation.js";
import { type FindingLifecycleStatus } from "../finding/lifecycle.js";
export type { TaskSection, TaskItem, TaskDoc } from "./tasks.js";
export { readTasks, readTasksAcrossProjects, resolveTaskItem, addTask, addTasks, completeTasks, completeTask, removeTask, removeTasks, updateTask, linkTaskIssue, pinTask, unpinTask, workNextTask, tidyDoneTasks, taskMarkdown, appendChildFinding, promoteTask, TASKS_FILENAME, TASK_FILE_ALIASES, canonicalTaskFilePath, resolveTaskFilePath, isTaskFileName, type AddTaskOptions, } from "./tasks.js";
export { addProjectToProfile, listMachines, listProfiles, listProjectCards, removeProjectFromProfile, setMachineProfile, type ProfileInfo, type ProjectCard, } from "../profile-store.js";
export { loadShellState, resetShellState, saveShellState, type ShellState, } from "../shell/state-store.js";
export { getRuntimeHealth as readRuntimeHealth } from "../shared/governance.js";
export { FINDINGS_FILENAME } from "../filenames.js";
export interface FindingItem {
    id: string;
    /** Stable 8-char hex ID embedded as `<!-- fid:XXXXXXXX -->`. Survives reordering and consolidation. */
    stableId?: string;
    date: string;
    text: string;
    citation?: string;
    citationData?: FindingCitation;
    taskItem?: string;
    confidence?: number;
    scope?: string;
    /** Machine hostname where this finding was originally recorded. */
    machine?: string;
    /** Actor (username) who recorded this finding. */
    actor?: string;
    /** First 60 chars of the newer finding that supersedes this one. Set when this finding is stale. */
    supersededBy?: string;
    /** First 60 chars of the older finding this one replaces. */
    supersedes?: string;
    /** Snippets of findings this one contradicts. */
    contradicts?: string[];
    status: FindingLifecycleStatus;
    status_updated?: string;
    status_reason?: string;
    status_ref?: string;
    /** Indicates whether this item comes from archived history blocks (<details> / phren:archive). */
    archived?: boolean;
    /** Tier marker used to distinguish current truth vs archived history. */
    tier?: "current" | "archived";
}
export interface ReadFindingsOptions {
    includeArchived?: boolean;
}
export interface FindingHistoryEntry {
    id: string;
    stableId?: string;
    text: string;
    timeline: FindingItem[];
    current?: FindingItem;
    archivedCount: number;
}
export interface QueueItem {
    id: string;
    section: "Review" | "Stale" | "Conflicts";
    date: string;
    text: string;
    line: string;
    confidence?: number;
    risky: boolean;
    machine?: string;
    model?: string;
}
export interface ProjectQueueItem extends QueueItem {
    project: string;
}
export declare function readFindings(phrenPath: string, project: string, opts?: ReadFindingsOptions): PhrenResult<FindingItem[]>;
/**
 * Parse FINDINGS.md-shaped content into findings. Shared by `readFindings`
 * (the project's FINDINGS.md) and the memory link's scan of archived topic
 * files under `reference/topics/`, which use the same bullet + citation shape.
 */
export declare function parseFindingsContent(content: string, opts?: ReadFindingsOptions): FindingItem[];
export declare function readFindingHistory(phrenPath: string, project: string, findingId?: string): PhrenResult<FindingHistoryEntry[]>;
export declare function addFinding(phrenPath: string, project: string, learning: string): PhrenResult<AddFindingResult>;
export declare function removeFinding(phrenPath: string, project: string, match: string): PhrenResult<string>;
export declare function removeFindings(phrenPath: string, project: string, matches: string[]): PhrenResult<{
    removed: string[];
    errors: string[];
}>;
export declare function editFinding(phrenPath: string, project: string, oldText: string, newText: string): PhrenResult<string>;
export declare function readReviewQueue(phrenPath: string, project: string): PhrenResult<QueueItem[]>;
export type QueueApproveOutcome = "promoted" | "already_present" | "already_archived";
export interface QueueApproveResult {
    outcome: QueueApproveOutcome;
    message: string;
    /** Canonical finding text the verb acted on (confidence marker stripped, type tag kept). */
    text: string;
}
export type QueueRejectOutcome = 
/** Removed from the live FINDINGS.md tier. */
"removed"
/** Removed from reference/topics/*.md, where auto-archive had moved it. */
 | "removed_from_archive"
/** Nothing to remove: the candidate was never written anywhere. Dequeuing *is* the rejection. */
 | "discarded";
export interface QueueRejectResult {
    outcome: QueueRejectOutcome;
    message: string;
    text: string;
}
/**
 * Approve a queue item: make it real, then dequeue.
 *
 * Three outcomes, because a queue line can point at three different realities:
 *
 * - `promoted` — the text is not in FINDINGS.md, so approving *writes* it. This is the
 *   case for every extraction candidate that scored below `autoAcceptThreshold`:
 *   extraction queues those without ever adding them, so the old "just splice the line
 *   out" behaviour silently discarded them. Promotion goes through `addFindingToFile`,
 *   the same path a direct add uses, so dedup, fid assignment, citation metadata, and
 *   the findings-cap auto-archive all behave identically.
 * - `already_present` — the text is already a live finding (govern queues existing
 *   findings for Stale/Conflicts review). Approving means "keep it"; just dequeue.
 * - `already_archived` — the content only exists in `reference/topics/`, because
 *   auto-archive moved it after it was queued. It is still live for retrieval, so the
 *   archive is left untouched and the item is dequeued.
 */
export declare function approveQueueItemDetailed(phrenPath: string, project: string, lineText: string): PhrenResult<QueueApproveResult>;
/** Remove a queue item's line from review.md, promoting it to a finding when needed. */
export declare function approveQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string>;
/**
 * Reject a queue item: destroy the content wherever it actually lives, then dequeue.
 *
 * Rejection removes from the live FINDINGS.md tier *and* from `reference/topics/*.md`,
 * because auto-archive moves findings there without reconciling their queue lines and
 * archived content is still injected into agent prompts. Leaving it would make reject a
 * lie — the hosts tell users rejection removes the finding permanently.
 *
 * Two situations deliberately do NOT succeed quietly:
 * - the content sits in a FINDINGS.md archive block (`<details>` / `phren:archive`),
 *   which the rest of the codebase treats as read-only history; and
 * - several *different* bullets match, so deleting one would be a guess.
 *
 * Both return an error and leave the queue line in place, so the user sees the problem
 * instead of a success message over undeleted content.
 */
export declare function rejectQueueItemDetailed(phrenPath: string, project: string, lineText: string): PhrenResult<QueueRejectResult>;
/** Remove a queue item from review.md AND the corresponding finding wherever it lives. */
export declare function rejectQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string>;
/**
 * Drop a queue line and nothing else.
 *
 * Unlike `rejectQueueItem`, this never touches FINDINGS.md or `reference/topics/`.
 * It is the verb for "stop asking me about this", not "this is wrong" — which is
 * what automated expiry needs: a governance-queued finding that already lives in
 * FINDINGS.md must survive its queue line timing out.
 */
export declare function dequeueQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string>;
/** Edit a queue item's text in review.md and the corresponding finding in FINDINGS.md. */
export declare function editQueueItem(phrenPath: string, project: string, lineText: string, newText: string): PhrenResult<string>;
export declare function readReviewQueueAcrossProjects(phrenPath: string, profile?: string): PhrenResult<ProjectQueueItem[]>;
