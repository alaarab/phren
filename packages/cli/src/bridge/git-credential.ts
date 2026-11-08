import { execFile } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";
import { detectHost, type GitHost } from "./git-hosts.js";
import { resolveAgentToken } from "./git-host-auth.js";
import { BridgeError } from "./protocol.js";

/**
 * The gitboy path's credentials. The Hook's stored `gba_` agent token is the
 * only one a keyed dispatch may use: a credential helper in the worktree's own
 * config answers git, and the agent environment carries the same token for the
 * API. The token never enters argv, a remote URL or a log.
 */

/** Variables a keyed worker must never inherit from the Hook or the caller. */
export const KEYED_ENV_STRIP = ["GITBOY_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS",
  "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND"] as const;
const KEYED_ENV_KEEP = new Set(["GITBOY_HOST", "GITBOY_TOKEN_FILE"]);

/**
 * Empty-value overlay for a keyed launch. Empty values are what tmux `-e NAME=`
 * and Herdr/Codex env overlays understand, and they carry no secret. GITBOY_*
 * and GIT_CONFIG_* names are discovered from the Hook's own environment.
 */
export function keyedEnvScrub(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = new Set<string>(KEYED_ENV_STRIP);
  for (const key of Object.keys(base)) {
    if (KEYED_ENV_KEEP.has(key)) continue;
    if (key.startsWith("GITBOY_") || key.startsWith("GIT_CONFIG_")) names.add(key);
  }
  return Object.fromEntries([...names].map(key => [key, ""]));
}

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
/** The credential-free HTTPS remote for a gitboy host, or a refusal when owner/repo cannot be derived. */
export function credentialFreeRemote(host: Pick<GitHost, "domain" | "webUrl">): string {
  if (!host.domain || !host.webUrl) throw new BridgeError(409, "This gitboy checkout has no owner/repository in its remote URL, so a keyed dispatch cannot use it.");
  let pathname: string;
  try { pathname = new URL(host.webUrl).pathname; } catch { throw new BridgeError(409, "This gitboy checkout's remote URL cannot be parsed."); }
  const parts = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new BridgeError(409, "This gitboy checkout has no owner/repository in its remote URL, so a keyed dispatch cannot use it.");
  return `https://${host.domain}/${parts[0]}/${parts[1]}.git`;
}

async function configureWorktreeForHost(worktreePath: string, host: Pick<GitHost, "domain" | "webUrl" | "remote">): Promise<void> {
  if (!host.domain) throw new BridgeError(409, "This checkout has no gitboy host.");
  const url = credentialFreeRemote(host);
  await git(worktreePath, "config", "--local", "extensions.worktreeConfig", "true");
  // The agent may only push over HTTPS with the stored token; an SSH origin
  // would use the owner's identity, so rewrite both URL forms and disable SSH.
  for (const remote of new Set(["origin", host.remote ?? "origin"])) {
    await git(worktreePath, "config", "--worktree", `remote.${remote}.url`, url);
    await git(worktreePath, "config", "--worktree", `remote.${remote}.pushurl`, url);
  }
  await git(worktreePath, "config", "--worktree", "core.sshCommand", "false");
  await git(worktreePath, "config", "--worktree", `http.https://${host.domain}/.extraHeader`, "");
  const key = `credential.https://${host.domain}`;
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "");
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "!phren bridge git-credential");
  await git(worktreePath, "config", "--worktree", `${key}.useHttpPath`, "false");
}

export async function configureGitboyWorktree(worktreePath: string, branch = ""): Promise<boolean> {
  const host = await detectHost(worktreePath, branch);
  if (host.kind !== "gitboy" || !host.domain) return false;
  await configureWorktreeForHost(worktreePath, host);
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
  // Keyed dispatches exist for gitboy's runner. A checkout Phren can't place
  // on a gitboy host with an agent token is refused, never launched with
  // whatever git credentials the computer happens to have.
  const stored = host.domain ? await resolveAgentToken(host.domain) : undefined;
  if (!host.domain || !stored) {
    const domain = host.domain ?? "this checkout's host";
    throw new BridgeError(409, `No gitboy agent token for ${domain}. Run phren bridge git-host set ${domain} gitboy with a gba_ token.`);
  }
  if (worktreePath) await configureWorktreeForHost(worktreePath, host);
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
