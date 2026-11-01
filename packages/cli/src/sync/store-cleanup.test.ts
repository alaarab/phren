import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDir } from "../phren-paths.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { STALE_GIT_STATE_MS, STALE_INDEX_LOCK_MS, cleanupStore } from "./store-cleanup.js";
import { BACKUP_REF_PREFIX } from "./store-merge.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function temp(prefix: string): string {
  const scratch = path.join(process.cwd(), ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveGitEnv(),
  }).trim();
}

async function run(cwd: string, args: string[]): Promise<{ ok: boolean; output: string; error?: string }> {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveGitEnv(),
      }),
    };
  } catch (error: unknown) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return { ok: false, output: String(failed.stdout ?? ""), error: String(failed.stderr ?? failed.message ?? "") };
  }
}

function repo(): string {
  const root = temp("phren-cleanup-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "cleanup-test@example.com");
  git(root, "config", "user.name", "Cleanup test");
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

/** A repository left in the middle of a conflicting merge. */
function conflicted(): string {
  const root = repo();
  const file = path.join(root, "file.txt");
  git(root, "checkout", "--quiet", "-b", "feature");
  fs.writeFileSync(file, "feature\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "feature");
  git(root, "checkout", "--quiet", "main");
  fs.writeFileSync(file, "main\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "main");
  try { git(root, "merge", "--no-ff", "feature"); } catch { /* expected conflict */ }
  expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(true);
  return root;
}

function age(file: string, now: number, ms: number): void {
  const at = new Date(now - ms);
  fs.utimesSync(file, at, at);
}

describe("cleanupStore", () => {
  const indexLocks: [string, number, boolean][] = [
    ["stale", STALE_INDEX_LOCK_MS + 60_000, false],
    ["fresh", 60_000, true],
  ];
  it.each(indexLocks)("removes only a %s Git index lock", async (_label, ms, remains) => {
    const now = Date.now();
    const root = repo();
    const lock = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    age(lock, now, ms);
    const done = await cleanupStore(root, run, { now });
    expect(fs.existsSync(lock)).toBe(remains);
    expect(done.some((line) => line.includes("removed a Git index lock"))).toBe(!remains);
  });

  it("aborts a merge whose marker and index are both abandoned", async () => {
    const now = Date.now();
    const root = conflicted();
    age(path.join(root, ".git", "MERGE_HEAD"), now, STALE_GIT_STATE_MS + 60_000);
    age(path.join(root, ".git", "index"), now, STALE_GIT_STATE_MS + 60_000);
    const done = await cleanupStore(root, run, { now });
    expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("main\n");
    expect(done.some((line) => line.includes("aborted a merge"))).toBe(true);
  });

  it("leaves a merge alone while someone is still resolving its index", async () => {
    const now = Date.now();
    const root = conflicted();
    age(path.join(root, ".git", "MERGE_HEAD"), now, STALE_GIT_STATE_MS + 60_000);
    const done = await cleanupStore(root, run, { now });
    expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(true);
    expect(git(root, "status", "--porcelain")).toContain("UU file.txt");
    expect(done.some((line) => line.includes("aborted"))).toBe(false);
  });

  it("deletes only backup refs past the keep window", async () => {
    const now = Date.now();
    const root = repo();
    const oldRef = `${BACKUP_REF_PREFIX}${now - 15 * 86_400_000}`;
    const recentRef = `${BACKUP_REF_PREFIX}${now - 86_400_000}`;
    git(root, "update-ref", oldRef, "HEAD");
    git(root, "update-ref", recentRef, "HEAD");
    const done = await cleanupStore(root, run, { now });
    const refs = git(root, "for-each-ref", "--format=%(refname)", BACKUP_REF_PREFIX).split("\n").filter(Boolean);
    expect(refs).toEqual([recentRef]);
    expect(done.some((line) => line.includes(`deleted backup ${oldRef.slice("refs/".length)}`))).toBe(true);
  });

  it("prunes worktree records whose folders are gone and keeps live ones", async () => {
    const root = repo();
    const base = temp("phren-worktrees-");
    const live = path.join(base, "live");
    const gone = path.join(base, "gone");
    git(root, "worktree", "add", "--detach", "--quiet", live, "HEAD");
    git(root, "worktree", "add", "--detach", "--quiet", gone, "HEAD");
    fs.rmSync(gone, { recursive: true, force: true });
    const done = await cleanupStore(root, run);
    const listed = git(root, "worktree", "list", "--porcelain");
    expect(listed).toContain(live);
    expect(listed).not.toContain(gone);
    expect(done).toContain("pruned 1 worktree record(s) whose folders were gone");
  });

  it("removes an old lock whose owner exited but keeps fresh and live locks", async () => {
    const now = Date.now();
    const root = repo();
    const dir = runtimeDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(path.join(dir, "dead.lock"), `${exited}\n`);
    fs.writeFileSync(path.join(dir, "live.lock"), `${process.pid}\n`);
    fs.writeFileSync(path.join(dir, "fresh.lock"), `${exited}\n`);
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n");
    age(path.join(dir, "dead.lock"), now, STALE_INDEX_LOCK_MS + 60_000);
    age(path.join(dir, "live.lock"), now, STALE_INDEX_LOCK_MS + 60_000);
    age(path.join(dir, "fresh.lock"), now, 60_000);
    age(path.join(dir, "notes.txt"), now, STALE_INDEX_LOCK_MS + 60_000);
    const done = await cleanupStore(root, run, { now });
    expect(fs.existsSync(path.join(dir, "dead.lock"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "live.lock"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "fresh.lock"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
    expect(done).toContain("removed lock dead.lock left by a process that has exited");
  });
});
