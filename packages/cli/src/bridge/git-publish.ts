import { spawn } from "node:child_process";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot } from "./projects.js";
import { countGit } from "./metrics.js";
import { defaultBranch, invalidateTree } from "./git.js";

/** Finishing a session from the phone: commit what is staged, push the
 * current branch, open a pull request. Each acts on the repository the
 * existing /v1/git/* routes resolve (the pane's, a child's worktree, or a
 * listed worktree id). A refusal from Git itself (a hook, a rejected push,
 * gh's own error) is a normal answer carrying the output verbatim, since the
 * phone's error channel flattens and truncates text. */

const MAX_OUTPUT = 65_536;
const COMMIT_TIMEOUT_MS = 110_000;
const PUSH_TIMEOUT_MS = 110_000;
const PR_TIMEOUT_MS = 60_000;
const MAX_MESSAGE = 20_000;

interface Run { code: number | null; output: string; missing: boolean; timedOut: boolean }

/** One process with stdout and stderr interleaved in arrival order, bounded,
 * never attached to a terminal and never prompting. */
export function runCombined(command: string, args: string[], cwd: string, timeout: number): Promise<Run> {
  return new Promise(resolve => {
    let output = "", truncated = false, timedOut = false, settled = false;
    const finish = (run: Run) => { if (!settled) { settled = true; resolve(run); } };
    const child = spawn(command, args, {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: nonInteractiveGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }),
    });
    const append = (chunk: Buffer) => {
      if (truncated) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) { output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]"; truncated = true; }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
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

const PULL_URL = /https:\/\/[^\s"'<>]+\/pull\/\d+/;

/** `gh pr create --fill` for the current branch. A missing or signed-out gh
 * is `{ ok: false, reason: "missing" | "auth" }`; gh's own refusal is
 * `reason: "failed"` with its output. A pull request that already exists for
 * the branch comes back as success with `existing: true`. */
export async function gitPullRequest(cwd: string, draft: unknown): Promise<Json> {
  const root = await repository(cwd);
  const branch = await currentBranch(root);
  const version = await runCombined("gh", ["--version"], root, 10_000);
  if (version.missing || version.code !== 0) {
    return { ok: false, reason: "missing", message: "The GitHub CLI (gh) is not installed on this computer. Install it, then run gh auth login there." };
  }
  const auth = await runCombined("gh", ["auth", "status"], root, 15_000);
  if (auth.code !== 0) {
    return { ok: false, reason: "auth", message: "The GitHub CLI is not signed in on this computer. Run gh auth login there.", output: auth.output };
  }
  const run = await runCombined("gh", ["pr", "create", "--fill", "--head", branch, ...(draft === true ? ["--draft"] : [])], root, PR_TIMEOUT_MS);
  const url = PULL_URL.exec(run.output)?.[0];
  if (run.code === 0 && url) return { ok: true, url, branch, draft: draft === true };
  if (url && /already exists/i.test(run.output)) return { ok: true, url, branch, existing: true };
  return { ok: false, reason: "failed", output: run.timedOut ? `${run.output}\n[gh did not finish within ${PR_TIMEOUT_MS / 1000} seconds]`.trim() : run.output || "gh pr create failed." };
}
