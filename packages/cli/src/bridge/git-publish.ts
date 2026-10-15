import { spawn } from "node:child_process";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot } from "./projects.js";
import { countGit } from "./metrics.js";
import { defaultBranch, invalidatePulls, invalidateTree } from "./git.js";
import { z } from "zod";
import { detectHost, providerFor, unknownHost } from "./git-hosts.js";
import { writeHostToken } from "./git-host-auth.js";
import { HostApiError } from "./git-host-http.js";

/** Finishing a session from the phone: commit what is staged, push the
 * current branch, open a pull request. Each acts on the repository the
 * existing /v1/git/* routes resolve (the pane's, a child's worktree, or a
 * listed worktree id). A refusal from Git itself (a hook, a rejected push,
 * gh's own error) is a normal answer carrying the output verbatim, since the
 * phone's error channel flattens and truncates text. */

const MAX_OUTPUT = 65_536;
const COMMIT_TIMEOUT_MS = 110_000;
const PUSH_TIMEOUT_MS = 110_000;
const MAX_MESSAGE = 20_000;
/** After a timeout's SIGTERM: SIGKILL after this long, answer after twice it. */
const KILL_GRACE_MS = 2_000;

interface Run { code: number | null; output: string; missing: boolean; timedOut: boolean }

/** One process with stdout and stderr interleaved in arrival order, bounded,
 * never attached to a terminal and never prompting. */
export function runCombined(command: string, args: string[], cwd: string, timeout: number, extraEnv: NodeJS.ProcessEnv = {}, killGraceMs = KILL_GRACE_MS): Promise<Run> {
  return new Promise(resolve => {
    let output = "", truncated = false, timedOut = false, settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (run: Run) => {
      if (settled) return;
      // The SIGKILL escalation is left to fire: git exiting on SIGTERM must
      // not spare a hook's child that ignores it.
      settled = true; clearTimeout(deadline); resolve(run);
    };
    // Its own process group, so a timeout reaches what a Git hook started too.
    const group = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd, stdio: ["ignore", "pipe", "pipe"], detached: group,
      env: nonInteractiveGitEnv({ ...process.env, ...extraEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }),
    });
    const append = (chunk: Buffer) => {
      if (truncated) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) { output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]"; truncated = true; }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const kill = (signal: NodeJS.Signals) => {
      try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { child.kill(signal); }
    };
    // The SIGKILL goes only to a group that still has a member: a group id is
    // not reused while any member lives, so a hook's child that ignored
    // SIGTERM is still ours. Residual race, not closed: if every member exited
    // during the grace and the id was then taken by a new group, the probe
    // cannot tell the two apart; that needs both an emptied group and an id
    // reuse inside one grace period.
    const escalate = () => {
      if (!group || !child.pid) { child.kill("SIGKILL"); return; }
      try { process.kill(-child.pid, 0); } catch { return; }
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone since the probe */ }
    };
    // A timeout signals the group at most twice: SIGTERM now, and one grace
    // later SIGKILL if the group is still there, whether or not git has
    // exited; never again after that.
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(escalate, killGraceMs).unref();
      // A descendant outside the group can hold the pipes open forever:
      // answer at the deadline whether or not 'close' ever comes.
      deadline = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        finish({ code: null, output: output.trimEnd(), missing: false, timedOut: true });
      }, killGraceMs * 2);
    }, timeout);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ code: null, output: error.message, missing: error.code === "ENOENT", timedOut: false });
    });
    child.on("close", code => {
      clearTimeout(timer);
      finish({ code, output: output.trimEnd(), missing: false, timedOut });
    });
  });
}

async function repository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.");
  return root;
}

async function currentBranch(root: string): Promise<string> {
  const branch = (await git(root, "branch", "--show-current")).trim();
  if (!branch) throw new BridgeError(409, "HEAD is detached. Check out a branch on the computer first.");
  return branch;
}

async function config(root: string, key: string): Promise<string | undefined> {
  return (await git(root, "config", "--get", key).catch(() => "")).trim() || undefined;
}

/** `git commit` of the index only: no `-a`, no `--no-verify`, no amend. A
 * hook's refusal comes back as `{ ok: false, output }`, exactly as printed. */
export async function gitCommit(cwd: string, message: unknown): Promise<Json> {
  if (typeof message !== "string" || !message.trim()) throw new BridgeError(400, "Write a commit message first.");
  if (message.length > MAX_MESSAGE || message.includes("\0")) throw new BridgeError(400, "The commit message is too long.");
  const root = await repository(cwd);
  // `diff --cached --quiet` exits 1 when something is staged.
  const staged = await git(root, "diff", "--cached", "--quiet").then(() => false, () => true);
  if (!staged) throw new BridgeError(409, "Nothing is staged. Stage the files to commit first.");
  invalidateTree(root);
  try {
    countGit("projects");
    const run = await runCombined("git", ["-C", root, "--no-pager", "commit", "--quiet", "--cleanup=strip", "-m", message], root, COMMIT_TIMEOUT_MS);
    if (run.code !== 0) {
      return { ok: false, output: run.timedOut ? `${run.output}\n[git commit did not finish within ${COMMIT_TIMEOUT_MS / 1000} seconds]`.trim() : run.output || "git commit failed." };
    }
    const [sha, short, subject] = (await git(root, "log", "-1", "--format=%H%x00%h%x00%s")).trim().split("\0");
    return { ok: true, sha, short, subject, branch: (await git(root, "branch", "--show-current")).trim(), ...(run.output ? { output: run.output } : {}) };
  } finally { invalidateTree(root); }
}

/** The current branch to its upstream, or to `origin` with the upstream set.
 * Never forced: no `--force`, no `+` refspec, no `--no-verify`. The default
 * branch needs the phone's explicit `confirmDefault`. */
export async function gitPush(cwd: string, confirmDefault: unknown): Promise<Json> {
  const root = await repository(cwd);
  const branch = await currentBranch(root);
  const upstreamRemote = await config(root, `branch.${branch}.remote`);
  const merge = await config(root, `branch.${branch}.merge`);
  const tracked = !!upstreamRemote && upstreamRemote !== "." && !!merge?.startsWith("refs/heads/");
  const remote = tracked ? upstreamRemote! : "origin";
  const remotes = (await git(root, "remote").catch(() => "")).split("\n").map(line => line.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new BridgeError(409, tracked ? `The upstream remote ${remote} is not configured.` : "This branch has no upstream and the repository has no origin remote.");
  }
  const destination = tracked ? merge!.slice("refs/heads/".length) : branch;
  const fallback = await defaultBranch(root, remote);
  if ((destination === fallback || branch === fallback) && confirmDefault !== true) {
    throw new BridgeError(409, `${branch} is the default branch. Confirm to push it.`, { defaultBranch: fallback });
  }
  const args = ["-C", root, "--no-pager", "push", "--porcelain", ...(tracked ? [] : ["--set-upstream"]), remote, `refs/heads/${branch}:refs/heads/${destination}`];
  countGit("projects");
  const run = await runCombined("git", args, root, PUSH_TIMEOUT_MS);
  invalidateTree(root);
  if (run.code !== 0) {
    return { ok: false, output: run.timedOut ? `${run.output}\n[git push did not finish within ${PUSH_TIMEOUT_MS / 1000} seconds]`.trim() : run.output || "git push failed." };
  }
  return { ok: true, branch, remote, upstream: `${remote}/${destination}`, setUpstream: !tracked, output: run.output };
}

/** Open a pull or merge request for the current branch on the remote's host
 * (git-hosts.ts). GitHub's: `gh pr create --fill`; a missing or signed-out
 * CLI is `{ ok: false, reason: "missing" | "auth" }`, the host's own refusal
 * `reason: "failed"` with its output, and a request that already exists for
 * the branch is success with `existing: true`. A stubbed host is
 * `reason: "unsupported"`, an unrecognised one `reason: "unknown-host"`. */
export async function gitPullRequest(cwd: string, draft: unknown): Promise<Json> {
  const root = await repository(cwd);
  const branch = await currentBranch(root);
  const host = await detectHost(root, branch);
  const provider = providerFor(host);
  if (!provider) { const { reason, message } = unknownHost(host); return { ok: false, reason, message, host }; }
  try { return { ...await provider.open(root, branch, draft === true, host), host }; }
  finally { invalidatePulls(root); }
}

const MergeBody = z.object({
  number: z.number().int().positive(),
  method: z.enum(["merge", "squash", "rebase"]).default("merge"),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  deleteBranch: z.boolean().optional(),
});

/** Merge one pull or merge request on the remote's host. The host decides:
 * its refusal (checks, approvals, conflicts, a head that moved past
 * `expectedHeadSha`) is `{ ok: false, reason: "blocked", message }`. */
export async function gitMergeRequest(cwd: string, data: unknown): Promise<Json> {
  const request = MergeBody.parse(data);
  const root = await repository(cwd);
  const branch = (await git(root, "branch", "--show-current").catch(() => "")).trim();
  const host = await detectHost(root, branch);
  const provider = providerFor(host);
  if (!provider) { const { reason, message } = unknownHost(host); return { ok: false, reason, message, host }; }
  try { return { ...await provider.merge(root, request, host), host }; }
  finally { invalidatePulls(root); }
}

/** Connect (or, with an empty token, disconnect) this repository's GitLab or
 * gitboy host: the token is checked against the host first and stored in the
 * Hook's git-hosts.json with the account it signs in as. GitHub keeps gh's. */
export async function gitHostToken(cwd: string, data: unknown): Promise<Json> {
  const { token, expectedHost } = z.object({ token: z.string().max(4096), expectedHost: z.string().trim().min(1).max(253).optional() }).parse(data);
  const root = await repository(cwd);
  const branch = (await git(root, "branch", "--show-current").catch(() => "")).trim();
  const host = await detectHost(root, branch);
  // Use this freshly resolved host for both comparison and token validation.
  if (expectedHost !== undefined && host.domain !== expectedHost.toLowerCase()) {
    throw new BridgeError(409, "The project's remote changed. Reopen to review the new host.", { code: "host-changed" });
  }
  const provider = providerFor(host);
  if (!provider || !host.domain || !host.kind) { const { reason, message } = unknownHost(host); return { ok: false, reason, message, host }; }
  if (host.kind === "github" || !provider.whoami) return { ok: false, reason: "unsupported", message: "GitHub uses the GitHub CLI's sign-in: run gh auth login on this computer.", host };
  const kind = host.kind;
  if (!token.trim()) { await writeHostToken(host.domain, kind, ""); return { ok: true, disconnected: true, domain: host.domain, host }; }
  try {
    const identity = await provider.whoami(root, host, token.trim());
    const user = identity.user.replaceAll(token.trim(), "[redacted]");
    await writeHostToken(host.domain, kind, token.trim(), user || undefined);
    return { ok: true, domain: host.domain, kind, ...(user ? { user } : {}), host };
  } catch (error) {
    if (error instanceof HostApiError) return { ok: false, reason: error.reason, message: error.reason === "auth" ? `${host.name} refused that token.` : `${host.name} could not validate that token.`, host };
    throw error;
  }
}
