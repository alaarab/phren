import { type TaskClaim, type TaskItem } from "../data/tasks.js";
export interface ClaimOutcome {
    /** True when this computer holds the claim after syncing; false after a release. */
    claimed: boolean;
    item?: TaskItem;
    /** The claim that won when another computer's reached the remote first. */
    heldBy?: TaskClaim;
    /** False when the claim could not reach the store's remote. */
    synced: boolean;
    detail: string;
    error?: string;
}
/**
 * Claims a task across unlinked conductors: pull the store so a claim already
 * pushed elsewhere refuses this one, write the claim, then commit and push.
 * When another computer's claim reached the remote first, the store merge
 * keeps theirs, so the task is read again after the push to see who won.
 */
export declare function claimTaskSynced(phrenPath: string, project: string, match: string, claim: TaskClaim, opts?: {
    release?: boolean;
    force?: boolean;
}): Promise<ClaimOutcome>;
