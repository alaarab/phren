import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import type { RunStoreGit } from "../sync/store-merge.js";
import { addTask } from "./tasks.js";
import { captureTaskWrites, recordTaskWrite, trackTaskWriteCommits } from "./task-receipts.js";

let tmp: ReturnType<typeof makeTempDir>;
let file: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run: RunStoreGit = async (_cwd, args) => {
  try { return { ok: true, output: git(...args) }; }
  catch { return { ok: false, output: "", error: "git failed" }; }
};
const tracked = trackTaskWriteCommits(run);
const commitArgs = ["-c", "commit.gpgsign=false", "commit", "-qm", "task write"];

beforeEach(() => {
  tmp = makeTempDir("task-receipts-");
  initTestPhrenRoot(tmp.path);
  fs.mkdirSync(path.join(tmp.path, "demo"));
  file = path.join(tmp.path, "demo", "tasks.md");
  expect(addTask(tmp.path, "demo", "seed task").ok).toBe(true);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", "demo/tasks.md");
  git(...commitArgs);
});

afterEach(() => tmp.cleanup());

describe("task commit verification", () => {
  it("can verify the first commit of a store with no previous HEAD", async () => {
    git("update-ref", "-d", "HEAD");
    const { write } = await captureTaskWrites(async () => {
      addTask(tmp.path, "demo", "first committed task");
      git("add", "demo/tasks.md");
      expect((await tracked(tmp.path, commitArgs)).ok).toBe(true);
    });
    expect(write).toEqual({ path: file, commit: git("rev-parse", "HEAD") });
    expect(git("show", `${write!.commit}:demo/tasks.md`)).toContain("first committed task");
  });

  it("returns the commit containing the exact write even after HEAD moves", async () => {
    let saved = "";
    const { write } = await captureTaskWrites(async () => {
      expect(addTask(tmp.path, "demo", "new task").ok).toBe(true);
      git("add", "demo/tasks.md");
      expect((await tracked(tmp.path, commitArgs)).ok).toBe(true);
      saved = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(tmp.path, "other.md"), "unrelated\n");
      git("add", "other.md");
      expect((await tracked(tmp.path, commitArgs)).ok).toBe(true);
      expect(git("rev-parse", "HEAD")).not.toBe(saved);
    });
    expect(write).toEqual({ path: file, commit: saved });
    expect(git("show", `${saved}:demo/tasks.md`)).toBe(fs.readFileSync(file, "utf8").trim());
  });

  it("keeps a failed commit null despite an existing HEAD", async () => {
    const head = git("rev-parse", "HEAD");
    const failing = trackTaskWriteCommits(async (cwd, args) => args.includes("commit")
      ? { ok: false, output: "", error: "commit rejected" } : run(cwd, args));
    const { result, write } = await captureTaskWrites(async () => {
      addTask(tmp.path, "demo", "not committed");
      git("add", "demo/tasks.md");
      return failing(tmp.path, commitArgs);
    });
    expect(result.ok).toBe(false);
    expect(write).toEqual({ path: file, commit: null });
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("does not acknowledge an unrelated commit after a write of unchanged task content", async () => {
    const { write } = await captureTaskWrites(async () => {
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, content);
      recordTaskWrite(file, content);
      fs.writeFileSync(path.join(tmp.path, "other.md"), "unrelated\n");
      git("add", "other.md");
      expect((await tracked(tmp.path, commitArgs)).ok).toBe(true);
    });
    expect(write).toEqual({ path: file, commit: null });
  });

  it("does not claim a commit when another writer changed the captured contents", async () => {
    const { write } = await captureTaskWrites(async () => {
      addTask(tmp.path, "demo", "our task");
      // Another process writes after our atomic rename, before sync stages the file.
      fs.appendFileSync(file, "\nConcurrent edit\n");
      git("add", "demo/tasks.md");
      expect((await tracked(tmp.path, commitArgs)).ok).toBe(true);
    });
    expect(write).toEqual({ path: file, commit: null });
  });

  it("keeps the write successful if verification is unavailable", async () => {
    const unverifiable = trackTaskWriteCommits(async (cwd, args) => args[0] === "ls-tree"
      ? { ok: false, output: "", error: "cannot inspect tree" } : run(cwd, args));
    const { result, write } = await captureTaskWrites(async () => {
      addTask(tmp.path, "demo", "saved task");
      git("add", "demo/tasks.md");
      return unverifiable(tmp.path, commitArgs);
    });
    expect(result.ok).toBe(true);
    expect(write).toEqual({ path: file, commit: null });
    expect(git("show", "HEAD:demo/tasks.md")).toContain("saved task");
  });

  it("does not confuse a failed empty commit with the previous successful write", async () => {
    const { result, write } = await captureTaskWrites(async () => {
      const content = fs.readFileSync(file, "utf8");
      recordTaskWrite(file, content);
      return tracked(tmp.path, commitArgs);
    });
    expect(result.ok).toBe(false);
    expect(write).toEqual({ path: file, commit: null });
  });
});
