import { execFile } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";
import { detectHost } from "./git-hosts.js";
import { resolveAgentToken } from "./git-host-auth.js";
import { BridgeError } from "./protocol.js";

/**
 * The gitboy path's credentials. The Hook's stored `gba_` agent token is the
 * only one a keyed dispatch may use: a credential helper in the worktree's own
 * config answers git, and the agent environment carries the same token for the
 * API. The token never enters argv, a remote URL or a log.
 */

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  countGit("git-credential");
  return (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    timeout: 30_000, maxBuffer: 1_048_576, env: nonInteractiveGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" }),
  })).stdout;
}

/**
 * Configure the worktree itself (never the global config): clear any inherited
 * helper for this host, add the Hook's helper, and keep git from applying the
 * path-specific matching that could send the token to another repository path.
 */
async function configureWorktreeForHost(worktreePath: string, domain: string): Promise<void> {
  await git(worktreePath, "config", "--local", "extensions.worktreeConfig", "true");
  const key = `credential.https://${domain}`;
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "");
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "!phren bridge git-credential");
  await git(worktreePath, "config", "--worktree", `${key}.useHttpPath`, "false");
}

export async function configureGitboyWorktree(worktreePath: string, branch = ""): Promise<boolean> {
  const host = await detectHost(worktreePath, branch);
  if (host.kind !== "gitboy" || !host.domain) return false;
  await configureWorktreeForHost(worktreePath, host.domain);
  return true;
}

/** Write the agent token to a private file in the checkout's git dir, never to the environment. */
export async function writeAgentTokenFile(cwd: string, token: string): Promise<string> {
  const gitDir = (await git(cwd, "rev-parse", "--absolute-git-dir")).trim();
  if (!path.isAbsolute(gitDir)) throw new BridgeError(409, "This checkout's git directory is not available.");
  const file = path.join(gitDir, "phren-agent-token");
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError(409, "An agent token file already exists in this checkout; close the earlier dispatch first.");
    throw error;
  });
  try { await handle.writeFile(token); await handle.sync(); } finally { await handle.close(); }
  return file;
}

/** Remove a token file this Hook wrote; only the expected file name is ever touched. */
export async function removeAgentTokenFile(file: string | undefined): Promise<void> {
  if (!file || !path.isAbsolute(file) || path.basename(file) !== "phren-agent-token") return;
  await unlink(file).catch(() => undefined);
}

export interface KeyedGitboy {
  env: Record<string, string>;
  tokenFile: string;
}

/**
 * A keyed dispatch in a gitboy checkout uses this computer's stored agent token
 * and fails closed when there is none. The token goes to a 0600 file in the
 * checkout's git dir; the agent gets only GITBOY_TOKEN_FILE.
 */
export async function prepareKeyedGitboy(cwd: string, worktreePath?: string): Promise<KeyedGitboy | undefined> {
  const host = await detectHost(cwd, "");
  if (host.kind !== "gitboy" || !host.domain) return undefined;
  const stored = await resolveAgentToken(host.domain);
  if (!stored) {
    throw new BridgeError(409, `No gitboy agent token for ${host.domain}. Run phren bridge git-host set ${host.domain} gitboy with a gba_ token.`);
  }
  if (worktreePath) await configureWorktreeForHost(worktreePath, host.domain);
  const tokenFile = await writeAgentTokenFile(cwd, stored.token);
  return { env: { GITBOY_HOST: host.domain, GITBOY_TOKEN_FILE: tokenFile, GIT_TERMINAL_PROMPT: "0" }, tokenFile };
}

/** Backwards-compatible environment helper: keyed gitboy launches only. */
export async function gitHostLaunchEnv(cwd: string, keyed: boolean): Promise<Record<string, string> | undefined> {
  if (!keyed) return undefined;
  return (await prepareKeyedGitboy(cwd))?.env;
}

/** A git credential request for a host with a stored gitboy token, answered for `get` only. */
export async function gitCredentialAnswer(request: string): Promise<{ username: string; password: string } | undefined> {
  const protocol = /(?:^|\n)protocol=(.+)/.exec(request)?.[1]?.trim().toLowerCase();
  const host = /(?:^|\n)host=(.+)/.exec(request)?.[1]?.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (protocol !== "https" || !host) return undefined;
  const stored = await resolveAgentToken(host);
  if (!stored) return undefined;
  return { username: "x-token", password: stored.token };
}

/** The `phren bridge git-credential` helper: get answers, store and erase do nothing. */
export async function gitCredentialCommand(operation: string | undefined, request: string): Promise<string | undefined> {
  if (operation !== "get") return undefined;
  const answer = await gitCredentialAnswer(request);
  return answer ? `username=${answer.username}\npassword=${answer.password}\n` : undefined;
}
