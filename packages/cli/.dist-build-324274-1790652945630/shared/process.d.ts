/**
 * Shared process helpers for spawning detached child processes.
 */
import { type ChildProcess } from "child_process";
export interface SpawnDetachedChildOptions {
    phrenPath: string;
    logFd?: number;
    cwd?: string;
    extraEnv?: Record<string, string>;
}
/**
 * Spawn a detached child process with the standard phren environment.
 * When logFd is provided, stdout/stderr are redirected to that fd.
 * When omitted, all stdio is ignored.
 * Returns the ChildProcess so callers can attach `.unref()` or `.on("exit", ...)`.
 */
export declare function spawnDetachedChild(args: string[], opts: SpawnDetachedChildOptions): ChildProcess;
