/**
 * Shared process helpers for spawning detached child processes.
 */
import { spawn, type ChildProcess } from "child_process";
import { resolveRuntimeProfile } from "../runtime-profile.js";

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
export function spawnDetachedChild(args: string[], opts: SpawnDetachedChildOptions): ChildProcess {
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
