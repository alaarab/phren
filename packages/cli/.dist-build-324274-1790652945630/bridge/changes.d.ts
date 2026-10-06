import { type Json } from "./protocol.js";
import { z } from "zod";
/** One file a shell command changed, with the patch between the working
 * tree before the call and after it. `root` is the repository; `path` is
 * relative to it. */
export declare const changedFileSchema: z.ZodObject<{
    root: z.ZodString;
    path: z.ZodString;
    status: z.ZodString;
    patch: z.ZodString;
    added: z.ZodNumber;
    removed: z.ZodNumber;
    redacted: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export declare const secretName: (file: string) => boolean;
/** Tools whose filesystem changes are captured around the lifecycle callback. */
export declare const SHELL_TOOLS: Set<string>;
export declare function capturesChanges(tool: string, input: Json): boolean;
export declare function namedPaths(command: string, input?: Json): string[];
/** The files a call names in its structured input, never the words of a command line. */
export declare function claimedPaths(input: Json, cwd: string, home?: string): string[];
/** Remove old records first, then oldest records until within the disk budget. */
export declare function pruneChanges(now?: number): Promise<void>;
export declare function startChangeRetention(): Promise<() => void>;
/** Snapshots live only around a shell call. Persisted results are validated
 * when loaded; the LRU retains at most 16 conversations, including loads. */
export declare class ToolChanges {
    /** Called after a non-empty change event is recorded, so modules that follow
     * file changes (the code index) can react without polling. */
    onRecord?: (files: ChangedFile[]) => void;
    private snapshots;
    private results;
    private controllers;
    private claims;
    /** A hook callback's wall-clock cap on Git work; past it the call records
     * no change. Tests about what is captured raise it, since a loaded Windows
     * runner's Git can take longer than a person's machine ever does. */
    private readonly budgetMs;
    constructor(options?: {
        budgetMs?: number;
    });
    private file;
    private budget;
    private discard;
    close(): Promise<void>;
    before(conversation: string, toolUseId: string, cwd: string, command: string, input?: Json): Promise<void>;
    private claim;
    /** Whether another conversation's call named this file while `snapshot` ran. */
    private claimedElsewhere;
    after(conversation: string, toolUseId: string): Promise<void>;
    private compute;
    private cache;
    private load;
    private record;
    recordedPaths(conversation: string): Promise<string[]>;
    view(conversation: string): ChangeLookup;
}
export interface ChangeLookup {
    pending(toolUseId: string): boolean;
    changes(toolUseId: string): Promise<ChangedFile[] | undefined>;
}
/** The tool calls whose output a transcript row carries. */
export declare function outputCallIds(raw: Json, source: string): string[];
