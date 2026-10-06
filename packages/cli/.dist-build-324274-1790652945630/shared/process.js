/**
 * Shared process helpers for spawning detached child processes.
 */
import { spawn } from "child_process";
import { resolveRuntimeProfile } from "../runtime-profile.js";
/**
 * Spawn a detached child process with the standard phren environment.
 * When logFd is provided, stdout/stderr are redirected to that fd.
 * When omitted, all stdio is ignored.
 * Returns the ChildProcess so callers can attach `.unref()` or `.on("exit", ...)`.
 */
export function spawnDetachedChild(args, opts) {
    return spawn(process.execPath, args, {
        cwd: opts.cwd ?? process.cwd(),
        detached: true,
        stdio: opts.logFd !== undefined ? ["ignore", opts.logFd, opts.logFd] : "ignore",
        env: {
            ...process.env,
            PHREN_PATH: opts.phrenPath,
            PHREN_PROFILE: resolveRuntimeProfile(opts.phrenPath),
            ...opts.extraEnv,
        },
    });
}
