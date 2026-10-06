import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";
import { gitRoot } from "./projects.js";
import { BridgeError } from "./protocol.js";

/** A launch in a worktree of its own: `git worktree add` from the project's
 * current HEAD into `<repo>/.claude/worktrees/<name>` on a new branch, so the
 * agent's edits stay off the checkout the owner works in. The Changes
 * screen's Workers tab then lists it through `/v1/git/worktrees`. */

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  countGit("launch-worktree");
  // A checkout of a large repository can take longer than a status read.
  return (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    timeout: 120_000, maxBuffer: 1_048_576, env: nonInteractiveGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" }),
  })).stdout;
}

/** A branch name the phone may ask for: plain characters, no leading dash or
 * dot, and `git check-ref-format --branch` has the final say. */
export const worktreeBranch = z.string().trim().min(1).max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "A branch name uses letters, digits, dots, dashes, underscores and slashes.");

export const launchWorktreeSchema = z.object({ branch: worktreeBranch }).strict();
export type LaunchWorktreeRequest = z.infer<typeof launchWorktreeSchema>;

/** The worktree folder's name for a branch: `phren/fix-login` is `phren-fix-login`. */
export function worktreeFolderName(branch: string): string {
  return branch.replace(/[/.]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

export interface LaunchWorktree {
  /** Where the agent starts: the same folder inside the new worktree as the project folder in its repository. */
  cwd: string;
  /** The new worktree's root. */
  path: string;
  branch: string;
  /** Removes the worktree and its branch when the launch fails before anything ran there. */
  discard(): Promise<void>;
}

/** Creates the worktree, or refuses with a message the phone shows as is. */
export async function createLaunchWorktree(cwd: string, request: LaunchWorktreeRequest): Promise<LaunchWorktree> {
  const branch = request.branch;
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This folder is not a Git repository, so it cannot have a worktree. Turn off Work in a new worktree or choose a repository.");
  const head = (await git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").catch(() => "")).trim();
  if (!head) throw new BridgeError(409, "This repository has no commits yet, so there is no HEAD to start a worktree from.");
  if (!await git(root, "check-ref-format", "--branch", branch).then(() => true, () => false)) {
    throw new BridgeError(400, `"${branch}" is not a valid Git branch name.`);
  }
  if (await git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false)) {
    throw new BridgeError(409, `A branch named "${branch}" already exists in this repository. Choose another branch name.`);
  }
  const worktree = path.join(root, ".claude", "worktrees", worktreeFolderName(branch));
  if (await stat(worktree).then(() => true, () => false)) {
    throw new BridgeError(409, `The folder .claude/worktrees/${worktreeFolderName(branch)} already exists. Choose another branch name.`);
  }
  await mkdir(path.dirname(worktree), { recursive: true });
  try { await git(root, "worktree", "add", "-b", branch, worktree, head); }
  catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").at(-1) : "";
    throw new BridgeError(409, `Git could not create the worktree${detail ? `: ${detail.replace(/^fatal:\s*/, "")}` : "."}`);
  }
  const abs = await realpath(worktree);
  const inside = path.relative(root, await realpath(cwd));
  const start = inside && !inside.startsWith("..") ? path.join(abs, inside) : abs;
  const startDir = await stat(start).then(value => value.isDirectory(), () => false) ? start : abs;
  return {
    cwd: startDir, path: abs, branch,
    async discard() {
      await git(root, "worktree", "remove", "--force", abs).catch(() => rm(abs, { recursive: true, force: true }));
      await git(root, "worktree", "prune").catch(() => undefined);
      await git(root, "branch", "-D", branch).catch(() => undefined);
    },
  };
}
