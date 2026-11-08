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

/** Variables a keyed worker may inherit from the Hook's own environment. */
export const KEYED_ENV_ALLOW = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR"] as const;
const KEYED_ENV_CONFIG_DIRS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

/**
 * The exact environment for a keyed worker: a small allowlist plus the values
 * this Hook owns. Nothing else from process.env is copied, so no caller or
 * Hook token reaches the harness.
 */
export function keyedExplicitEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...KEYED_ENV_ALLOW, ...KEYED_ENV_CONFIG_DIRS]) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
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

/** Write the agent token to an exact private file path. */
export async function writeAgentTokenFileAt(file: string, token: string): Promise<string> {
  if (!path.isAbsolute(file) || path.basename(file) !== "phren-agent-token") throw new BridgeError(409, "The agent token file path is not valid.");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError(409, "An agent token file already exists in this checkout; close the earlier dispatch first.");
    throw error;
  });
  try { await handle.writeFile(token); await handle.sync(); } finally { await handle.close(); }
  return file;
}

/** Write the agent token to a private file in the checkout's git dir, never to the environment. */
export async function writeAgentTokenFile(cwd: string, token: string): Promise<string> {
  const gitDir = (await git(cwd, "rev-parse", "--absolute-git-dir")).trim();
  if (!path.isAbsolute(gitDir)) throw new BridgeError(409, "This checkout's git directory is not available.");
  return writeAgentTokenFileAt(path.join(gitDir, "phren-agent-token"), token);
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
export interface KeyedGitboyOptions {
  /** The exact token file path (the clone's git dir). */
  tokenFile?: string;
  /** The managed global config the clone and the agent use. */
  gitConfigFile?: string;
}

/**
 * A keyed dispatch in a gitboy checkout uses this computer's stored agent token
 * and fails closed when there is none. The token goes to a 0600 file; the agent
 * gets only GITBOY_TOKEN_FILE (and, for a clone, its managed GIT_CONFIG_GLOBAL).
 */
export async function prepareKeyedGitboy(cwd: string, options: KeyedGitboyOptions = {}): Promise<KeyedGitboy | undefined> {
  const host = await detectHost(cwd, "");
  // Keyed dispatches exist for gitboy's runner. A checkout Phren can't place
  // on a gitboy host with an agent token is refused, never launched with
  // whatever git credentials the computer happens to have.
  const stored = host.domain ? await resolveAgentToken(host.domain) : undefined;
  if (!host.domain || !stored) {
    const domain = host.domain ?? "this checkout's host";
    throw new BridgeError(409, `No gitboy agent token for ${domain}. Run phren bridge git-host set ${domain} gitboy with a gba_ token.`);
  }
  const tokenFile = options.tokenFile ? await writeAgentTokenFileAt(options.tokenFile, stored.token) : await writeAgentTokenFile(cwd, stored.token);
  return {
    env: {
      GITBOY_HOST: host.domain,
      GITBOY_TOKEN_FILE: tokenFile,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.gitConfigFile ? { GIT_CONFIG_GLOBAL: options.gitConfigFile, GIT_CONFIG_NOSYSTEM: "1" } : {}),
    },
    tokenFile,
  };
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
