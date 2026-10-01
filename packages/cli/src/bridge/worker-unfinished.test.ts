import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announcedNextStep, checkoutRoot, recentUncommitted, sharedCheckout, uncommittedFiles, unfinishedTurn, UNKNOWN } from "./worker-unfinished.js";

describe("a turn that ended mid-task", () => {
  it("reads a closing sentence that announces a next step", () => {
    for (const reply of ["The worktree lacks node_modules. Let me install dependencies.", "I'll run the suite next.", "Now let me check the tests:",
      "Okay, now I need to rebuild.", "Found it.\n\n**Now running the bridge suite.**", "- Next, I'm going to open the PR.", "Let's fix the lint errors."]) {
      expect(announcedNextStep(reply), reply).toBeTruthy();
    }
    for (const reply of ["PR #12 is open. Tests pass.", "Let me know if you want changes.", "Done. I fixed the lint errors.",
      "Now the tests pass.", "Summary:\n- Let me install dependencies was the old step\n- Tests pass.", "", undefined]) {
      expect(announcedNextStep(reply), String(reply)).toBeUndefined();
    }
    expect(announcedNextStep("The worktree lacks node_modules. Let me install dependencies.")).toBe("Let me install dependencies.");
  });

  // Review of #283: each of these finished replies read as "Stopped mid-task",
  // so the pane stayed open and the dispatcher was told the worker needs it.
  it.each([
    "All done. PR #12 is open.\n\nI'll leave the merge to you.",
    "Done. I'll wait for your review.",
    "Tests pass. Let's merge once CI is green.",
    "Done. Let's merge once CI is green",
    "I'll stop here.",
    "I'll be around if anything else comes up.",
    "Now passing: 42 tests.",
    "Now I wait for CI.",
    "Now everything passes.",
    "Now nothing is left.",
    "I\u2019ll hand it back to you.",
    "Pushed the branch. I will check back once the build finishes.",
    "Here is the change:\n```\nlet me = 1;\n```",
  ])("reads a finished reply as finished: %s", reply => {
    expect(announcedNextStep(reply)).toBeUndefined();
  });

  it.each([
    ["The worktree lacks node_modules. Let me install dependencies.", "Let me install dependencies."],
    ["Let me run the suite.", "Let me run the suite."],
    ["Let me run:\n```\npnpm install\n```", "Let me run:"],
    ["Let me run:\n\n```sh\npnpm install\npnpm test\n```\n", "Let me run:"],
    ["Now running the bridge suite.", "Now running the bridge suite."],
    ["I\u2019ll fix the failing test next.", "I'll fix the failing test next."],
    ["I need to rebuild first.", "I need to rebuild first."],
  ])("reads a reply that announces a next step: %s", (reply, step) => {
    expect(announcedNextStep(reply)).toBe(step);
  });

  it("counts uncommitted work only when no PR was reported or named", async () => {
    const uncommitted = async () => 3;
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, uncommitted)).toEqual({ unfinished: "Stopped with 3 uncommitted files and no PR." });
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w", prs: [{ url: "https://github.com/o/r/pull/1" }] }, uncommitted)).toEqual({});
    expect(await unfinishedTurn({ reply: "Opened https://github.com/o/r/pull/7.", directory: "/w" }, uncommitted)).toEqual({});
    expect(await unfinishedTurn({ reply: "PR #7 is up.", directory: "/w" }, uncommitted)).toEqual({});
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => 0)).toEqual({});
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => undefined)).toEqual({});
    expect(await unfinishedTurn({ reply: "Done." }, uncommitted)).toEqual({});
  });

  // A git status that timed out on a loaded Mini read as clean, so the turn was
  // done and its pane closed with the work uncommitted.
  it("reports a checkout git could not read as unchecked, never as clean", async () => {
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => UNKNOWN)).toEqual({ unchecked: true });
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => { throw new Error("slow disk"); })).toEqual({ unchecked: true });
    // An announced step still wins.
    expect(await unfinishedTurn({ reply: "Let me commit.", directory: "/w" }, async () => UNKNOWN)).toEqual({ unfinished: "Stopped mid-task: Let me commit." });
  });

  it("keeps a checkout read for a minute, but never an unknown one", async () => {
    const read = vi.fn(async (_directory: string) => 2 as number | typeof UNKNOWN);
    expect(await recentUncommitted("/cache/a", 0, read)).toBe(2);
    expect(await recentUncommitted("/cache/a", 59_999, read)).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(UNKNOWN);
    expect(await recentUncommitted("/cache/a", 60_000, read)).toBe(UNKNOWN);
    // The unknown read is dropped: the next poll asks git again.
    read.mockResolvedValue(5);
    expect(await recentUncommitted("/cache/a", 60_001, read)).toBe(5);
    expect(read).toHaveBeenCalledTimes(3);
    read.mockRejectedValueOnce(new Error("spawn failed"));
    expect(await recentUncommitted("/cache/b", 0, read)).toBe(UNKNOWN);
  });

  describe("in a real checkout", () => {
    let repo: string | undefined;
    afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = undefined; });
    it("counts tracked changes, staged or not, and leaves untracked files out", async () => {
      repo = await mkdtemp(path.join(tmpdir(), "phren-unfinished-"));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo!, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q");
      await writeFile(path.join(repo, "a.txt"), "a"); await writeFile(path.join(repo, "b.txt"), "b");
      git("add", "."); git("commit", "-qm", "init");
      expect(await uncommittedFiles(repo)).toBe(0);
      await writeFile(path.join(repo, "a.txt"), "changed"); await writeFile(path.join(repo, "scratch.txt"), "owner's");
      git("mv", "b.txt", "c.txt");
      expect(await uncommittedFiles(repo)).toBe(2);
      expect(await uncommittedFiles(path.join(repo, "missing"))).toBeUndefined();
      expect(await uncommittedFiles("relative")).toBeUndefined();
      // Git that does not answer in time is unknown, not clean.
      expect(await uncommittedFiles(repo, 1)).toBe(UNKNOWN);
      const outside = await mkdtemp(path.join(tmpdir(), "phren-not-repo-"));
      try { expect(await uncommittedFiles(outside)).toBeUndefined(); } finally { await rm(outside, { recursive: true, force: true }); }
    });

    it("tells a checkout another pane works in from the worker's own worktree", async () => {
      repo = await mkdtemp(path.join(tmpdir(), "phren-shared-"));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo!, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q"); await writeFile(path.join(repo, "a.txt"), "a"); git("add", "."); git("commit", "-qm", "init");
      const worktree = path.join(repo, ".worktrees", "w1");
      git("worktree", "add", "-q", worktree);
      expect(await checkoutRoot(path.join(repo, "src"))).toBe(repo);
      expect(await checkoutRoot(worktree)).toBe(worktree);
      // The owner's pane in the main checkout shares it; the worker's worktree is its own.
      expect(await sharedCheckout(repo, [path.join(repo, "packages")])).toBe(true);
      expect(await sharedCheckout(worktree, [repo, "/elsewhere", undefined, "relative"])).toBe(false);
      expect(await sharedCheckout(repo, [worktree])).toBe(false);
    });
  });
});
