import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { announcedNextStep, uncommittedFiles, unfinishedTurn } from "./worker-unfinished.js";

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

  it("counts uncommitted work only when no PR was reported", async () => {
    const uncommitted = async () => 3;
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, uncommitted)).toBe("Stopped with 3 uncommitted files and no PR.");
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w", prs: [{ url: "https://github.com/o/r/pull/1" }] }, uncommitted)).toBeUndefined();
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => 0)).toBeUndefined();
    expect(await unfinishedTurn({ reply: "Done.", directory: "/w" }, async () => { throw new Error("slow disk"); })).toBeUndefined();
    expect(await unfinishedTurn({ reply: "Done." }, uncommitted)).toBeUndefined();
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
    });
  });
});
