/** Machine-local credential failures shared by session hooks, polling and doctor. */
import * as fs from "fs";
import { atomicWriteText, runtimeFile } from "../phren-paths.js";
import { tryFileLock, withFileLock } from "../governance/locks.js";
import { runGit } from "../utils-helpers.js";
import type { RunStoreGit } from "./store-merge.js";

export const AUTH_BACKOFF_INITIAL_MS = 60 * 60 * 1000;
export const AUTH_BACKOFF_MAX_MS = 24 * AUTH_BACKOFF_INITIAL_MS;
export const AUTH_UNREGISTER_AFTER_MS = 7 * AUTH_BACKOFF_MAX_MS;

export interface StoreAuthFailure {
  remote: string;
  remoteName: string;
  firstFailedAt: number;
  lastFailedAt: number;
  failures: number;
  retryAt: number;
}

export function isGitAuthFailure(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown } | null;
  const message = [typeof error === "string" ? error : value?.message, value?.stderr].filter(Boolean).join("\n");
  return /could not read (?:Username|Password)|authentication failed|terminal prompts disabled|permission denied \(publickey\)|could not (?:read|get) (?:a )?password/i.test(message)
    || /\b(?:HTTP(?:\/[\d.]+)?|(?:returned )?error|status(?: code)?)[:\s]+(?:401|403)\b|\b(?:401 Unauthorized|403 Forbidden)\b|^(?:401|403)$/im.test(message);
}

export function readStoreAuthFailure(cwd: string): StoreAuthFailure | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(runtimeFile(cwd, "sync-auth.json"), "utf8"));
    if (typeof state?.remote !== "string" || !state.remote || typeof state.remoteName !== "string" || !state.remoteName) return;
    if (![state.firstFailedAt, state.lastFailedAt, state.retryAt, state.failures].every(Number.isFinite)) return;
    if (state.firstFailedAt < 0 || state.lastFailedAt < state.firstFailedAt || state.retryAt < state.lastFailedAt || state.failures < 1) return;
    return state;
  } catch { return; }
}

export function clearStoreAuthFailure(cwd: string): void {
  fs.rmSync(runtimeFile(cwd, "sync-auth.json"), { force: true });
}

/** Read Git's effective URL, including insteadOf rewrites, without contacting it. */
export function storeSyncRemote(cwd: string, name?: string, push = false): { remoteName: string; remote: string } | undefined {
  const git = (args: string[]) => runGit(cwd, args, 5000);
  const branch = name ? null : git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const pushRemote = push && ((branch && git(["config", "--get", `branch.${branch}.pushRemote`])) || git(["config", "--get", "remote.pushDefault"]));
  const remoteName = name || pushRemote || (branch && git(["config", "--get", `branch.${branch}.remote`])) || "origin";
  if (remoteName === ".") return;
  const remote = git(["remote", "get-url", ...(push ? ["--push"] : []), "--", remoteName]);
  return remote ? { remoteName, remote } : undefined;
}

/** Changing the configured remote immediately releases the old credential block. */
export function activeStoreAuthFailure(cwd: string): StoreAuthFailure | undefined {
  const state = readStoreAuthFailure(cwd);
  if (!state) return;
  const current = storeSyncRemote(cwd);
  return current?.remote === state.remote && current.remoteName === state.remoteName ? state : undefined;
}

export function authBackoffActive(state: StoreAuthFailure | undefined, now = Date.now()): boolean {
  return Boolean(state && now < state.retryAt);
}

export function storeAuthDetail(state: StoreAuthFailure): string {
  return `needs credentials: ${state.remote}; next retry ${new Date(state.retryAt).toISOString()}`;
}

export function recordStoreAuthFailure(cwd: string, remoteName: string, remote: string, now = Date.now()): StoreAuthFailure {
  return withFileLock(runtimeFile(cwd, "sync-auth-state"), () => {
    const previous = readStoreAuthFailure(cwd);
    const sameRemote = previous?.remote === remote && previous.remoteName === remoteName;
    const failures = sameRemote ? Math.min(previous.failures + 1, 32) : 1;
    const state: StoreAuthFailure = {
      remote, remoteName, failures,
      firstFailedAt: sameRemote ? previous.firstFailedAt : now,
      lastFailedAt: now,
      retryAt: now + Math.min(AUTH_BACKOFF_INITIAL_MS * 2 ** (failures - 1), AUTH_BACKOFF_MAX_MS),
    };
    atomicWriteText(runtimeFile(cwd, "sync-auth.json"), JSON.stringify(state) + "\n");
    return state;
  });
}

/** Only transport failures affect credentials; local merge errors never do. */
export function withStoreAuthBackoff(git: RunStoreGit, now: () => number = Date.now): RunStoreGit {
  return async (cwd, args) => {
    if (!["fetch", "pull", "push", "ls-remote"].includes(args[0])) return git(cwd, args);
    const separator = args.indexOf("--");
    const remote = storeSyncRemote(cwd, separator >= 0 ? args[separator + 1] : undefined, args[0] === "push");
    if (!remote) return git(cwd, args);
    // Serialize transport probes across processes so startup and polling share one retry.
    const release = tryFileLock(runtimeFile(cwd, "sync-auth-probe"));
    if (!release) return { ok: false, output: "", error: "Store remote check deferred: another sync is running." };
    try {
      const previous = readStoreAuthFailure(cwd);
      const sameRemote = previous?.remote === remote.remote && previous.remoteName === remote.remoteName;
      if (sameRemote && authBackoffActive(previous, now())) {
        return { ok: false, output: "", error: storeAuthDetail(previous) };
      }
      const result = await git(cwd, args);
      // A push-only permission failure must not disable otherwise readable stores.
      if (args[0] === "push") return result;
      if (result.ok) {
        if (sameRemote) clearStoreAuthFailure(cwd);
      } else if (isGitAuthFailure(result.error)) {
        const state = recordStoreAuthFailure(cwd, remote.remoteName, remote.remote, now());
        return { ...result, error: storeAuthDetail(state) };
      } else if (sameRemote) {
        // The last failure was not authentication; do not age it toward removal.
        clearStoreAuthFailure(cwd);
      }
      return result;
    } finally { release(); }
  };
}
