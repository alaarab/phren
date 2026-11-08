import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGitboyWorktree, gitCredentialCommand } from "./git-credential.js";
import { writeHostToken } from "./git-host-auth.js";
import { createLaunchWorktree } from "./launch-worktree.js";

const execFileAsync = promisify(execFile);
const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" });
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv() })).stdout;

describe("the gitboy credential helper", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "phren-git-credential-")));
    process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
    await writeHostToken("gitboy.example.com", "gitboy", "gba_test", "phren-agent", undefined, true);
  });
  afterEach(async () => { delete process.env.PHREN_BRIDGE_HOME; delete process.env.GIT_CONFIG_GLOBAL; await rm(root, { recursive: true, force: true }); });

  it("answers get for https on a stored gitboy host and nothing else", async () => {
    expect(await gitCredentialCommand("get", "protocol=https\nhost=gitboy.example.com\n\n")).toBe("username=x-token\npassword=gba_test\n");
    expect(await gitCredentialCommand("get", "protocol=https\nhost=gitboy.example.com:443\n\n")).toBe("username=x-token\npassword=gba_test\n");
    expect(await gitCredentialCommand("get", "protocol=https\nhost=other.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("get", "protocol=http\nhost=gitboy.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("store", "protocol=https\nhost=gitboy.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("erase", "protocol=https\nhost=gitboy.example.com\n\n")).toBeUndefined();
  });

  it("writes the helper and host path setting into the worktree config, not global", async () => {
    await git(root, "init", "-q", "-b", "main");
    await git(root, "remote", "add", "origin", "https://gitboy.example.com/o/r.git");
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app", "index.ts"), "export {};\n");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "start");
    const worktree = await createLaunchWorktree(path.join(root, "app"), { branch: "agent/test" });

    expect(await configureGitboyWorktree(worktree.path, worktree.branch)).toBe(true);
    const helpers = (await git(worktree.path, "config", "--worktree", "--get-all", "credential.https://gitboy.example.com.helper"))
      .split("\n").slice(0, -1);
    expect(helpers).toEqual(["", "!phren bridge git-credential"]);
    expect((await git(worktree.path, "config", "--worktree", "--get", "credential.https://gitboy.example.com.useHttpPath")).trim()).toBe("false");
    // The same keys are absent from the global config.
    await expect(execFileAsync("git", ["config", "--global", "--get", "credential.https://gitboy.example.com.helper"], { env: gitEnv() })).rejects.toThrow();
  });
});
