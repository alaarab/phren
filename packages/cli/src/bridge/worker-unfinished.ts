import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";

/**
 * A worker whose turn ended is not always done. OpenCode in particular ends a
 * turn on a line like "The worktree lacks node_modules. Let me install
 * dependencies." with nothing run after it (hook-permission-mode, 2026-09-30:
 * returned done, its pane closed, 9 files of uncommitted work left behind).
 * Dispatch returns report such a turn as needs-you, never done, so its pane
 * is not closed and the dispatcher nudges it on.
 */

const exec = promisify(execFile);

/** A closing sentence that announces work the turn never did. "Let me know…"
 * is a sign-off, not a step. */
const NEXT_STEP = /^(?:(?:ok(?:ay)?|alright|now|next|then|first|great|good)\b[,.!:]?\s+)*(?:let me(?! know)|let's|i'll|i will|i'm going to|i am going to|i need to|i'm now|i am now|now i)\b|^now,?\s+\w+ing\b/i;

/** The reply's closing sentence when it announces a next step ("Let me…",
 * "I'll…", "Now…"), else undefined. */
export function announcedNextStep(reply: string | undefined): string | undefined {
  const line = reply?.replace(/\r/g, "").split("\n").map(value => value.trim()).filter(Boolean).at(-1);
  if (!line) return undefined;
  const plain = line.replace(/^(?:[-*+>]|\d+[.)])\s+/, "").replace(/[*_`#]+/g, "").trim();
  const last = plain.split(/(?<=[.!?…])\s+/).filter(Boolean).at(-1)?.trim();
  return last && NEXT_STEP.test(last) ? last.slice(0, 160) : undefined;
}

/** Tracked files with uncommitted changes (staged or not) in the checkout at
 * `directory`. Untracked files are left out: a main checkout often holds the
 * owner's own (worktree folders, scratch files) and they are not the worker's.
 * Undefined when it is not a repository or git does not answer in time. */
export async function uncommittedFiles(directory: string, timeoutMs = 3000): Promise<number | undefined> {
  if (!path.isAbsolute(directory)) return undefined;
  countGit("worker-unfinished");
  try {
    const { stdout } = await exec("git", ["-C", directory, "--no-pager", "status", "--porcelain=v1", "--untracked-files=no", "-z"], {
      timeout: timeoutMs, maxBuffer: 1_048_576, env: nonInteractiveGitEnv({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" }),
    });
    // -z: renames carry their source as a second entry with no status.
    return stdout.split("\0").filter(entry => /^[ MADRCTU?!]{2} /.test(entry)).length;
  } catch { return undefined; }
}

const recent = new Map<string, { at: number; files: Promise<number | undefined> }>();
/** `uncommittedFiles` for the returns loop, which asks about a finished
 * worker on every poll (15 s) for as long as its receipt is watched: a read
 * under a minute old answers. */
export function recentUncommitted(directory: string, now = Date.now()): Promise<number | undefined> {
  const hit = recent.get(directory);
  if (hit && now - hit.at < 60_000) return hit.files;
  const files = uncommittedFiles(directory);
  recent.delete(directory); recent.set(directory, { at: now, files });
  while (recent.size > 256) recent.delete(recent.keys().next().value!);
  return files;
}

/** Why a turn that ended is not done: it announced a next step, or it left
 * uncommitted work with no PR reported. Undefined when it reads as done. */
export async function unfinishedTurn(input: { reply?: string; prs?: readonly unknown[]; directory?: string },
  uncommitted?: (directory: string) => Promise<number | undefined>): Promise<string | undefined> {
  const step = announcedNextStep(input.reply);
  if (step) return `Stopped mid-task: ${step}`;
  if (input.prs?.length || !input.directory || !uncommitted) return undefined;
  const files = await uncommitted(input.directory).catch(() => undefined);
  return files ? `Stopped with ${files} uncommitted file${files === 1 ? "" : "s"} and no PR.` : undefined;
}
