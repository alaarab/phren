import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";
import { detectHost } from "./git-hosts.js";
import { resolveHostToken } from "./git-host-auth.js";

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
export async function configureGitboyWorktree(worktreePath: string, branch = ""): Promise<boolean> {
  const host = await detectHost(worktreePath, branch);
  if (host.kind !== "gitboy" || !host.domain) return false;
  await git(worktreePath, "config", "--local", "extensions.worktreeConfig", "true");
  const key = `credential.https://${host.domain}`;
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "");
  await git(worktreePath, "config", "--worktree", "--add", `${key}.helper`, "!phren bridge git-credential");
  await git(worktreePath, "config", "--worktree", `${key}.useHttpPath`, "false");
  return true;
}

/**
 * The API half: a keyed dispatch in a gitboy checkout gets the stored token as
 * GITBOY_HOST/GITBOY_TOKEN. The token is read from the Hook's git-hosts.json
 * only, never from the caller's environment.
 */
export async function gitHostLaunchEnv(cwd: string, keyed: boolean): Promise<Record<string, string> | undefined> {
  if (!keyed) return undefined;
  const host = await detectHost(cwd, "");
  if (host.kind !== "gitboy" || !host.domain) return undefined;
  const stored = await resolveHostToken("gitboy", host.domain, { env: {}, cli: false });
  return { GITBOY_HOST: host.domain, GITBOY_TOKEN: stored?.token ?? "", GIT_TERMINAL_PROMPT: "0" };
}

/** A git credential request for a host with a stored gitboy token, answered for `get` only. */
export async function gitCredentialAnswer(request: string): Promise<{ username: string; password: string } | undefined> {
  const protocol = /(?:^|\n)protocol=(.+)/.exec(request)?.[1]?.trim().toLowerCase();
  const host = /(?:^|\n)host=(.+)/.exec(request)?.[1]?.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (protocol !== "https" || !host) return undefined;
  const stored = await resolveHostToken("gitboy", host, { env: {}, cli: false });
  if (!stored) return undefined;
  return { username: "x-token", password: stored.token };
}

/** The `phren bridge git-credential` helper: get answers, store and erase do nothing. */
export async function gitCredentialCommand(operation: string | undefined, request: string): Promise<string | undefined> {
  if (operation !== "get") return undefined;
  const answer = await gitCredentialAnswer(request);
  return answer ? `username=${answer.username}\npassword=${answer.password}\n` : undefined;
}
