import { z } from "zod";
/** A branch name the phone may ask for: plain characters, no leading dash or
 * dot, and `git check-ref-format --branch` has the final say. */
export declare const worktreeBranch: z.ZodString;
export declare const launchWorktreeSchema: z.ZodObject<{
    branch: z.ZodString;
}, z.core.$strict>;
export type LaunchWorktreeRequest = z.infer<typeof launchWorktreeSchema>;
/** The worktree folder's name for a branch: `phren/fix-login` is `phren-fix-login`. */
export declare function worktreeFolderName(branch: string): string;
export interface LaunchWorktree {
    /** Where the agent starts: the same folder inside the new worktree as the project folder in its repository. */
    cwd: string;
    /** The new worktree's root. */
    path: string;
    branch: string;
    /** Removes the worktree and its branch when the launch fails before anything ran there. */
    discard(): Promise<void>;
}
/** Creates the worktree, or refuses with a message the phone shows as is. */
export declare function createLaunchWorktree(cwd: string, request: LaunchWorktreeRequest): Promise<LaunchWorktree>;
