/**
 * A GitHub store remote over SSH whose key GitHub refuses, on a computer
 * where `gh` is signed in: the store switches to HTTPS with `gh` as its
 * credential helper instead of failing quietly until someone looks. One
 * computer's store sat diverged for two days that way while gh worked.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { atomicWriteText, runtimeFile } from "../phren-paths.js";
import { appendSyncLog } from "./outcome.js";
import type { RunStoreGit } from "./store-merge.js";

const exec = promisify(execFile);
/** A failed switch is retried at most this often. */
export const AUTH_HEAL_RETRY_MS = 60 * 60 * 1000;

export interface AuthHealResult { healed: boolean; detail: string }

/** The HTTPS URL of a GitHub SSH remote (`git@github.com:o/r.git`, `ssh://git@github.com/o/r`), else undefined. */
export function githubHttpsUrl(remote: string): string | undefined {
  const match = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : undefined;
}

/** gh from PATH, else where Homebrew and Linux packages put it (a service's PATH is often bare). */
async function signedInGh(): Promise<string | undefined> {
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, process.platform === "win32" ? "gh.exe" : "gh")),
    "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh",
  ];
  const gh = candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!gh) return undefined;
  try {
    // The token itself is discarded; only whether gh has one matters.
    await exec(gh, ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 });
    return gh;
  } catch { return undefined; }
}

interface HealState { remote: string; at: number; detail: string }

function readHealState(cwd: string): HealState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(runtimeFile(cwd, "sync-auth-heal.json"), "utf8"));
    return typeof state?.remote === "string" && Number.isFinite(state.at) && typeof state.detail === "string" ? state : undefined;
  } catch { return undefined; }
}

/**
 * Called after a transport command failed authentication. Switches the named
 * remote to HTTPS through gh when that answers, and otherwise says what to do.
 * `git` is the unguarded runner, so the probe never re-enters the backoff.
 */
export async function healStoreAuth(cwd: string, remoteName: string, remote: string, git: RunStoreGit, now = Date.now()): Promise<AuthHealResult> {
  const https = githubHttpsUrl(remote);
  if (!https) return { healed: false, detail: "" };
  const previous = readHealState(cwd);
  if (previous?.remote === remote && now - previous.at < AUTH_HEAL_RETRY_MS) return { healed: false, detail: previous.detail };
  const fail = (detail: string): AuthHealResult => {
    atomicWriteText(runtimeFile(cwd, "sync-auth-heal.json"), JSON.stringify({ remote, at: now, detail }) + "\n");
    appendSyncLog(cwd, "auth", detail);
    return { healed: false, detail };
  };
  const gh = await signedInGh();
  if (!gh) {
    return fail(`GitHub refused this computer's SSH key for ${remote}, and gh is not signed in here. Add the key to GitHub, or run 'gh auth login' and then 'phren doctor --fix'.`);
  }
  const helper = `!${gh.includes(" ") ? `"${gh}"` : gh} auth git-credential`;
  // An empty helper first drops inherited ones (a stale keychain entry would answer before gh).
  const probe = await git(cwd, ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "ls-remote", "--quiet", "--", https, "HEAD"]);
  if (!probe.ok) {
    return fail(`GitHub refused this computer's SSH key for ${remote}, and HTTPS through gh failed too: ${(probe.error ?? "").split("\n").find(Boolean)?.slice(0, 200) ?? "unknown error"}`);
  }
  const steps = [
    ["config", "--local", "--replace-all", "credential.https://github.com.helper", ""],
    ["config", "--local", "--add", "credential.https://github.com.helper", helper],
    ["remote", "set-url", "--", remoteName, https],
  ];
  for (const step of steps) {
    const result = await git(cwd, step);
    if (!result.ok) return fail(`Could not switch ${remoteName} to HTTPS: ${(result.error ?? "").split("\n").find(Boolean)?.slice(0, 200) ?? "git config failed"}`);
  }
  fs.rmSync(runtimeFile(cwd, "sync-auth-heal.json"), { force: true });
  const detail = `GitHub refused this computer's SSH key for ${remote}; switched ${remoteName} to ${https} with gh as its credential helper.`;
  appendSyncLog(cwd, "auth", detail);
  return { healed: true, detail };
}
