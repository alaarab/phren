import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
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

/** A sentence that announces work the turn never did: "Let me…", "I'll…",
 * "I need to…", or "Now" with a working verb. Whatever follows the subject in
 * HANDOVER, or a sentence waiting on something (CONDITIONAL, read by
 * `awaitedInReply` instead), is not one: a done worker that says "I'll wait
 * for your review" must not read as needs-you. "Let me know…" is a sign-off. */
const NEXT_STEP = /^(?:(?:ok(?:ay)?|alright|now|next|then|first|great|good)\b[,.!:]?\s+)*(?:let me(?! know)|let's|let us|i'll|i will|i'm going to|i am going to|i need to|i'm now|i am now|now i)\s+(.*)$/i;
const NOW_DOING = /^now,?\s+(?:adding|applying|building|checking|cleaning|committing|compiling|creating|debugging|editing|fixing|generating|implementing|installing|investigating|launching|looking|moving|opening|patching|pushing|reading|rebuilding|refactoring|removing|rerunning|re-running|running|searching|setting|starting|testing|trying|updating|verifying|wiring|working|writing)\b/i;
/** What a finished worker says it does next: wait, leave it to the owner, stop, be around. */
const HANDOVER = /^(?:just\s+)?(?:wait|await|leave|stop|hold|pause|be|hand|defer|stand|end|wrap|let you|keep an eye|check back|merge|ship|land|release|discuss|review|done|finished|ready)\b/i;
const CONDITIONAL = /\b(?:once|when|whenever|after|as soon as|if|until|unless)\b/i;

/** A sentence that waits on something other than the owner: "Now waiting on
 * the MacBook rerun.", "I'll push once it passes.", "Let's merge once CI is
 * green." (ios-fast-voice2, 2026-10-01: returned done and closed with its test
 * run going). Waiting for the owner's review or answer is a handover. */
const WAITS = /(?<!\bwhile\s)\b(?:wait(?:ing|s)?|await(?:ing|s)?)\s+(?:on|for|until)\b/i;
/** "Once it passes", "when the build finishes": waiting on a job, not an "if". */
const ONCE_DONE = /\b(?:once|when|after|as soon as|until)\s+(?:it|its|the|that|this|they|both|all|my|ci)\b/i;
const FUTURE = /\b(?:i'll|i will|we'll|we will|let's|let us|then i|will)\b/i;
const OWNER = /\b(?:you|your|yours|owner|reviewers?|approv\w*|let me know)\b/i;
const NEGATED = /\b(?:nothing|no longer|not|no need|without)\b|n't\b/i;

/** The closing paragraph's prose lines: blank lines end a paragraph and fenced
 * code is skipped, so "Let me run:" before a closing code block is still in it. */
function closingLines(reply: string): string[] {
  let fenced = false, lines: string[] = [];
  for (const raw of reply.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (!line) { if (lines.length) lines = [...lines, ""]; continue; }
    if (lines.at(-1) === "") lines = [];
    lines.push(line);
  }
  return lines.filter(Boolean);
}

const LIST_ITEM = /^(?:[-*+>]|\d+[.)])\s+/;
const sentences = (line: string) => line.replace(LIST_ITEM, "").replace(/[*_`#]+/g, "").replace(/[\u2018\u2019]/g, "'").trim()
  .split(/(?<=[.!?\u2026])\s+/).map(sentence => sentence.trim()).filter(Boolean);

function nextStep(sentence: string): boolean {
  if (CONDITIONAL.test(sentence)) return false;
  const step = NEXT_STEP.exec(sentence);
  return step ? !HANDOVER.test(step[1]) : NOW_DOING.test(sentence);
}

/** The first sentence of the reply's closing paragraph that announces a next
 * step ("Let me…", "I'll…", "Now running…"), else undefined. The closing line
 * counts even as a list item; earlier lines only as prose, so a summary list
 * that quotes an old step is not one. */
export function announcedNextStep(reply: string | undefined): string | undefined {
  const lines = reply ? closingLines(reply) : [];
  const found = lines.flatMap((line, index) => index === lines.length - 1 || !LIST_ITEM.test(line) ? sentences(line) : []).find(nextStep);
  return found?.slice(0, 160);
}

/** The first sentence of the reply's closing paragraph that waits on work
 * still to finish ("Now waiting on the rerun.", "I'll push once it passes."),
 * else undefined. */
export function awaitedInReply(reply: string | undefined): string | undefined {
  const found = (reply ? closingLines(reply) : []).flatMap(sentences).find(sentence => !OWNER.test(sentence) && !NEGATED.test(sentence)
    && (WAITS.test(sentence) || (ONCE_DONE.test(sentence) && FUTURE.test(sentence))));
  return found?.slice(0, 160);
}

/** A checkout git could not read in time (or at all): its work is unknown,
 * so a turn there is never closed on the strength of it. */
export const UNKNOWN = "unknown";
export type Uncommitted = number | typeof UNKNOWN | undefined;

/** Tracked files with uncommitted changes (staged or not) in the checkout at
 * `directory`. Untracked files are left out: a main checkout often holds the
 * owner's own (worktree folders, scratch files) and they are not the worker's.
 * Undefined when it is not a repository; UNKNOWN when git does not answer in
 * time or fails otherwise. */
export async function uncommittedFiles(directory: string, timeoutMs = 3000): Promise<Uncommitted> {
  if (!path.isAbsolute(directory)) return undefined;
  countGit("worker-unfinished");
  try {
    const { stdout } = await exec("git", ["-C", directory, "--no-pager", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=no", "-z"], {
      timeout: timeoutMs, maxBuffer: 1_048_576, env: nonInteractiveGitEnv({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" }),
    });
    // -z: renames carry their source as a second entry with no status.
    return stdout.split("\0").filter(entry => /^[ MADRCTU?!]{2} /.test(entry)).length;
  } catch (error) {
    const failed = error as { code?: unknown; killed?: boolean; stderr?: unknown };
    // Exit 128 naming no repository (or no such folder) is a plain answer, not a slow one.
    if (failed.code === 128 && !failed.killed && /not a git repository|cannot change to/i.test(String(failed.stderr ?? ""))) return undefined;
    return UNKNOWN;
  }
}

const recent = new Map<string, { at: number; files: Promise<Uncommitted> }>();
/** `uncommittedFiles` for the returns loop, which asks about a finished
 * worker on every poll (15 s) for as long as its receipt is watched: a read
 * under a minute old answers. An UNKNOWN read is not kept, so the next poll
 * (and the close recheck) asks git again. */
export function recentUncommitted(directory: string, now = Date.now(), read: (directory: string) => Promise<Uncommitted> = uncommittedFiles): Promise<Uncommitted> {
  const hit = recent.get(directory);
  if (hit && now - hit.at < 60_000) return hit.files;
  const files = read(directory).catch((): Uncommitted => UNKNOWN);
  recent.delete(directory); recent.set(directory, { at: now, files });
  while (recent.size > 256) recent.delete(recent.keys().next().value!);
  void files.then(value => { if (value === UNKNOWN && recent.get(directory)?.files === files) recent.delete(directory); });
  return files;
}

/** The checkout `directory` is in: the nearest folder holding `.git` (a
 * linked worktree's is a file), or undefined outside any. */
export async function checkoutRoot(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory)) return undefined;
  let folder = path.resolve(directory);
  for (let depth = 0; depth < 64; depth++) {
    if (await lstat(path.join(folder, ".git")).then(() => true, () => false)) return folder;
    const parent = path.dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
  return undefined;
}

/** Whether any of `folders` (other panes' working folders) is in the same
 * checkout as `directory`. Uncommitted files there may be the owner's or a
 * sibling worker's, so they say nothing about this worker. */
export async function sharedCheckout(directory: string, folders: readonly unknown[]): Promise<boolean> {
  const root = await checkoutRoot(directory);
  if (!root) return false;
  const others = [...new Set(folders.filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder)))].slice(0, 64);
  for (const folder of others) if (folder.startsWith(root) && await checkoutRoot(folder) === root) return true;
  return false;
}

/** A pull request the reply itself names: a GitHub PR link or "PR #12". */
const PR_NAMED = /\/pull\/\d+|\bPR\s*#\d+/i;

/** Why a turn that ended is not done: it announced a next step, or it left
 * uncommitted work with no PR reported or named in the reply (`unfinished`). `unchecked` when its
 * checkout could not be read: the turn may be done, but it is not safe to
 * close. Empty when it reads as done. */
export async function unfinishedTurn(input: { reply?: string; prs?: readonly unknown[]; directory?: string },
  uncommitted?: (directory: string) => Promise<Uncommitted>): Promise<{ unfinished?: string; unchecked?: true }> {
  const step = announcedNextStep(input.reply);
  if (step) return { unfinished: `Stopped mid-task: ${step}` };
  const waiting = awaitedInReply(input.reply);
  if (waiting) return { unfinished: `Stopped waiting: ${waiting}` };
  if (input.prs?.length || PR_NAMED.test(input.reply ?? "") || !input.directory || !uncommitted) return {};
  const files = await uncommitted(input.directory).catch((): Uncommitted => UNKNOWN);
  if (files === UNKNOWN) return { unchecked: true };
  return files ? { unfinished: `Stopped with ${files} uncommitted file${files === 1 ? "" : "s"} and no PR.` } : {};
}
