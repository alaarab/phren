/**
 * What a store sync leaves behind when something dies halfway: Git's own
 * merge/rebase state and index lock, Phren's lock files, pre-merge backup refs
 * and worktrees whose folders are gone. Each is removed only once it is
 * clearly abandoned, never while a process could still own it.
 */
import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "../phren-paths.js";
import { gitOperationRecovery, inProgressGitOperation } from "./git-state.js";
import { BACKUP_REF_PREFIX, type RunStoreGit } from "./store-merge.js";

/** Git state untouched this long is abandoned: no Phren step holds a merge open for minutes. */
export const STALE_GIT_STATE_MS = 60 * 60 * 1000;
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;
export const BACKUP_REF_KEEP_DAYS = 14;

export interface CleanupOptions { now?: number; backupKeepDays?: number }

function gitDir(store: string): string | undefined {
  const dotGit = path.join(store, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(dotGit, "utf8"));
    return match ? path.resolve(store, match[1]) : undefined;
  } catch { return undefined; }
}

function ageMs(file: string, now: number): number | undefined {
  try { return now - fs.statSync(file).mtimeMs; } catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Removes abandoned sync leftovers and says what it removed, one line each. */
export async function cleanupStore(store: string, git: RunStoreGit, options: CleanupOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const done: string[] = [];
  const dir = gitDir(store);
  if (!dir) return done;

  const operation = inProgressGitOperation(store);
  if (operation === "index lock") {
    const age = ageMs(path.join(dir, "index.lock"), now);
    if (age !== undefined && age > STALE_INDEX_LOCK_MS) {
      fs.rmSync(path.join(dir, "index.lock"), { force: true });
      done.push(`removed a Git index lock left ${Math.round(age / 60_000)} minutes ago`);
    }
  } else if (operation && operation !== "sequencer") {
    const marker = { rebase: fs.existsSync(path.join(dir, "rebase-merge")) ? "rebase-merge" : "rebase-apply", merge: "MERGE_HEAD", "cherry-pick": "CHERRY_PICK_HEAD", revert: "REVERT_HEAD" }[operation];
    // The newest of the marker and the index: someone resolving by hand keeps touching the index.
    const ages = [ageMs(path.join(dir, marker), now), ageMs(path.join(dir, "index"), now)].filter((age): age is number => age !== undefined);
    if (ages.length && Math.min(...ages) > STALE_GIT_STATE_MS) {
      const abort = gitOperationRecovery(operation).split(" ").slice(1);
      if ((await git(store, abort)).ok) done.push(`aborted a ${operation} abandoned ${Math.round(Math.min(...ages) / 3_600_000)} hours ago`);
    }
  }

  const keepMs = (options.backupKeepDays ?? BACKUP_REF_KEEP_DAYS) * 86_400_000;
  const refs = await git(store, ["for-each-ref", "--format=%(refname)", BACKUP_REF_PREFIX]);
  if (refs.ok) {
    const old = refs.output.split("\n").filter((ref) => {
      const at = Number(ref.slice(BACKUP_REF_PREFIX.length));
      return Number.isFinite(at) && at > 0 && now - at > keepMs;
    });
    for (const ref of old) if ((await git(store, ["update-ref", "-d", ref])).ok) done.push(`deleted backup ${ref.slice("refs/".length)}`);
  }

  const before = await git(store, ["worktree", "list", "--porcelain"]);
  if ((await git(store, ["worktree", "prune"])).ok) {
    const after = await git(store, ["worktree", "list", "--porcelain"]);
    const count = (text: string) => text.split("\n").filter((line) => line.startsWith("worktree ")).length;
    const pruned = before.ok && after.ok ? count(before.output) - count(after.output) : 0;
    if (pruned > 0) done.push(`pruned ${pruned} worktree record(s) whose folders were gone`);
  }

  // Phren's own locks recover from a dead owner when next taken; one nobody
  // takes again (a renamed lock, a crashed one-off) would otherwise stay forever.
  let entries: string[] = [];
  try { entries = fs.readdirSync(runtimeDir(store)); } catch { /* no runtime folder yet */ }
  for (const name of entries.filter((entry) => entry.endsWith(".lock"))) {
    const file = path.join(runtimeDir(store), name);
    const age = ageMs(file, now);
    if (age === undefined || age < STALE_INDEX_LOCK_MS) continue;
    let pid = Number.NaN;
    try { pid = Number.parseInt(fs.readFileSync(file, "utf8").split("\n")[0], 10); } catch { continue; }
    if (pidAlive(pid)) continue;
    fs.rmSync(file, { force: true });
    done.push(`removed lock ${name} left by a process that has exited`);
  }
  return done;
}
