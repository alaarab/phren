import { z } from "zod";
import { type Json, type Provider } from "./protocol.js";
/** How many folders the archive keeps; the oldest beyond that are deleted. */
export declare const ARCHIVE_MAX_FOLDERS = 500;
export declare const manifestSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodString;
    parent: z.ZodOptional<z.ZodObject<{
        provider: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        computer: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    provider: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        opencode: "opencode";
    }>;
    session: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
    taskLabel: z.ZodString;
    cwd: z.ZodString;
    worktree: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    eventLog: z.ZodString;
    nativeTranscript: z.ZodOptional<z.ZodString>;
    unmanagedPid: z.ZodOptional<z.ZodNumber>;
    createdAt: z.ZodString;
    startedAt: z.ZodString;
    updatedAt: z.ZodString;
    finishedAt: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        failed: "failed";
        queued: "queued";
        running: "running";
    }>;
    exitCode: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodOptional<z.ZodString>;
    resumes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString]>>;
    schedule: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        project: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strict>;
export type FanoutManifest = z.infer<typeof manifestSchema>;
export interface FanoutChild {
    /** Parent-scoped opaque ID. Filesystem paths never cross the bridge. */
    id: string;
    provider: "opencode" | "codex" | "claude";
    session?: string;
    /** The model that manifest named, so the phone can label the worker. */
    model?: string;
    worktreeName?: string;
    branch?: string;
    /** The worker's own checkout, kept off the wire. */
    cwd: string;
    path: string;
    callId: string;
    state: "running" | "completed" | "failed" | "gone";
    /** `blocked: <type> <pattern>` when the plugin refused a permission. */
    reason?: string;
    /** Actual launch time from a validated manifest; queued jobs omit it. */
    startedAt?: string;
    finishedAt?: string;
    transcript: string;
    fanout: {
        resumable: boolean;
    };
    children: FanoutChild[];
}
export declare function storeRoot(env: NodeJS.ProcessEnv): string;
export declare function fanoutRoot(env?: NodeJS.ProcessEnv): string;
/** Bind public worker identities to the canonical store as well as their parent. */
export declare function fanoutChildID(root: string, manifest: FanoutManifest): string;
export declare function containedFanoutRoot(env: NodeJS.ProcessEnv): Promise<string | undefined>;
export declare function nativeClaudeTranscript(candidate: string, session: string): Promise<string | undefined>;
/** Read only manifests explicitly bound to the already validated parent. */
export declare function fanoutChildren(parentProvider: Provider, parentSession: string, env?: NodeJS.ProcessEnv, parentComputer?: string): Promise<FanoutChild[]>;
/** Every fan-out job's worktree with its task label and harness, whatever
 * conversation launched it, so the Changes screen can name the worker editing
 * a checkout. Newest first, bounded like the child listing. */
export declare function fanoutWorktrees(env?: NodeJS.ProcessEnv): Promise<Array<{
    worktree: string;
    label: string;
    provider: FanoutManifest["provider"];
    state: string;
}>>;
/** A blocked fan-out job, with the parent it belongs to, for a push. */
export interface BlockedFanout {
    id: string;
    provider: FanoutChild["provider"];
    label: string;
    parent?: {
        provider: Provider;
        session: string;
        computer?: string;
    };
    reason: string;
    at?: string;
}
/** Every fan-out job that left a blocked.json, for the Hook's push watcher. */
export declare function blockedFanouts(env?: NodeJS.ProcessEnv): Promise<BlockedFanout[]>;
/** The running OpenCode fan-out job a permission request names, when its own
 * manifest confirms the worker session and a parent conversation: the parent
 * is where the phone answers the ask. */
export declare function fanoutAsking(job: unknown, session: string, env?: NodeJS.ProcessEnv): Promise<{
    id: string;
    label: string;
    worktree: string;
    parent: NonNullable<FanoutManifest["parent"]>;
} | undefined>;
export interface FanoutArchiveResult {
    /** Job folders moved (or, on a dry run, that would be moved), by id. */
    moved: string[];
    /** Archive folders deleted past the cap (or that would be deleted). */
    deleted: number;
}
/** Move finished fan-out job folders into the archive.
 *
 * A folder moves when it has exit.txt (without it the job is still running and
 * is never touched), its manifest status is completed, failed or cancelled,
 * and its finishedAt (or exit.txt's mtime when there is none) is over
 * ARCHIVE_AGE_MS old. A folder with no manifest goes too once its exit.txt is
 * that old, gaining a synthesized {status: failed, reason: "no manifest"}
 * manifest in the archive. The archive keeps ARCHIVE_MAX_FOLDERS folders,
 * deleting the oldest beyond that. `dryRun` reports the same work without
 * touching anything. `olderThanMs` replaces the 24 hour age (0 archives every
 * finished job), and `parent` limits the sweep to one parent session's jobs;
 * a folder without a manifest has no parent and is left alone then. */
export declare function archiveFinishedFanouts(env?: NodeJS.ProcessEnv, options?: {
    dryRun?: boolean;
    now?: number;
    olderThanMs?: number;
    parent?: {
        session: string;
        provider?: Provider;
    };
}): Promise<FanoutArchiveResult>;
export declare const FANOUTS_ARCHIVE_USAGE = "Usage: phren bridge fanouts archive [--dry-run] [--parent <session-id>] [--older-than <minutes>]";
/** `--parent` limits the sweep to one parent chat's workers; `--older-than`
 * replaces the 24 hour age, and 0 archives every finished one. */
export declare function parseFanoutArchiveFlags(flags: string[]): {
    dryRun?: boolean;
    parent?: {
        session: string;
    };
    olderThanMs?: number;
};
/** Project raw `opencode run --format json` rows into the small public chat
 * contract. Reasoning, snapshots, costs, and metadata are omitted. Like the
 * Codex mapping, the command, URL or path a tool was given and a bounded
 * output tail cross the wire so the owner can see what a worker is doing.
 * An MCP tool keeps its own arguments and an edit, write or patch carries the
 * changed-file diff the phone draws under the card; both are bounded. */
export declare function visibleOpenCodeRunEvent(raw: Json, cwd?: string): Json | undefined;
/** Project raw `codex exec --json` rows into the shape Codex's own rollout
 * files use, so the existing Codex transcript reader renders them unchanged.
 * Command text, a bounded output tail, and changed paths cross the wire so the
 * owner can see what a worker is doing; diffs, usage, and costs do not. */
export declare function visibleCodexExecEvent(raw: Json): Json | undefined;
