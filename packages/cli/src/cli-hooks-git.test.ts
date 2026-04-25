import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir } from "./test-helpers.js";
import { addTeamPathspecs, TEAM_STORE_PATHSPECS } from "./cli-hooks-git.js";

function gitInit(cwd: string): void {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "test@phren"], { cwd });
  execFileSync("git", ["config", "user.name", "phren-test"], { cwd });
  // empty commit so refs exist
  execFileSync("git", ["commit", "--allow-empty", "-m", "init", "--quiet"], { cwd });
}

function gitStaged(cwd: string): string[] {
  return execFileSync("git", ["diff", "--name-only", "--cached"], { cwd, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("addTeamPathspecs", () => {
  let tmp: { path: string; cleanup: () => void };
  let store: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-team-pathspec-");
    store = tmp.path;
    gitInit(store);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("stages team-safe files when only some pathspecs match", async () => {
    // Real-world shape: a team store with arc/ but no */truths.md anywhere
    fs.mkdirSync(path.join(store, "arc", "journal"), { recursive: true });
    fs.writeFileSync(path.join(store, "arc", "journal", "2026-04-20-alaarab.md"), "# entry\n");
    fs.writeFileSync(path.join(store, "arc", "tasks.md"), "- [ ] task\n");
    fs.writeFileSync(path.join(store, "arc", "FINDINGS.md"), "- [pattern] finding\n");

    const staged = await addTeamPathspecs(store);
    expect(staged).toBeGreaterThan(0);

    const stagedFiles = gitStaged(store);
    expect(stagedFiles).toContain("arc/journal/2026-04-20-alaarab.md");
    expect(stagedFiles).toContain("arc/tasks.md");
    expect(stagedFiles).toContain("arc/FINDINGS.md");
  });

  it("does not abort when a pathspec matches no files", async () => {
    // Regression: pre-fix, a missing */truths.md aborted the whole `git add`
    // and stranded everything else. Now each spec runs independently.
    fs.mkdirSync(path.join(store, "arc", "journal"), { recursive: true });
    fs.writeFileSync(path.join(store, "arc", "journal", "2026-04-20-alaarab.md"), "# entry\n");
    // intentionally NO truths.md anywhere

    const staged = await addTeamPathspecs(store);
    // Some pathspecs match nothing, but the journal one should succeed
    expect(staged).toBeGreaterThanOrEqual(1);
    expect(gitStaged(store)).toContain("arc/journal/2026-04-20-alaarab.md");
  });

  it("stages nothing and does not throw when the working tree is clean", async () => {
    const staged = await addTeamPathspecs(store);
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(gitStaged(store)).toEqual([]);
  });

  it("does not stage paths outside the team-safe list", async () => {
    fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(store, ".runtime", "memory-scores.json"), "{}\n");
    fs.mkdirSync(path.join(store, "arc"), { recursive: true });
    fs.writeFileSync(path.join(store, "arc", "FINDINGS.md"), "- [pattern] finding\n");

    await addTeamPathspecs(store);
    const stagedFiles = gitStaged(store);
    expect(stagedFiles).toContain("arc/FINDINGS.md");
    expect(stagedFiles.some((p) => p.startsWith(".runtime/"))).toBe(false);
  });

  it("TEAM_STORE_PATHSPECS includes the journal/tasks/findings/reference/skills patterns", () => {
    expect(TEAM_STORE_PATHSPECS).toContain("*/journal/*");
    expect(TEAM_STORE_PATHSPECS).toContain("*/tasks.md");
    expect(TEAM_STORE_PATHSPECS).toContain("*/FINDINGS.md");
    expect(TEAM_STORE_PATHSPECS).toContain("*/reference/**");
    expect(TEAM_STORE_PATHSPECS).toContain("*/skills/**");
  });
});
