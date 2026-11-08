import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGitboyWorktree, gitCredentialCommand, keyedEnvScrub, prepareKeyedGitboy, removeAgentTokenFile } from "./git-credential.js";
import { resolveAgentToken, resolveHostToken, writeHostToken } from "./git-host-auth.js";
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

  async function repoFrom(remote: string): Promise<string> {
    const dir = path.join(root, `repo-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "remote", "add", "origin", remote);
    await writeFile(path.join(dir, "a"), "x\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "start");
    return dir;
  }
  const repo = (domain = "gitboy.example.com") => repoFrom(`https://${domain}/o/r.git`);

  it("answers get for https on a stored gitboy host and nothing else", async () => {
    expect(await gitCredentialCommand("get", "protocol=https\nhost=gitboy.example.com\n\n")).toBe("username=x-token\npassword=gba_test\n");
    expect(await gitCredentialCommand("get", "protocol=https\nhost=gitboy.example.com:443\n\n")).toBe("username=x-token\npassword=gba_test\n");
    expect(await gitCredentialCommand("get", "protocol=https\nhost=other.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("get", "protocol=http\nhost=gitboy.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("store", "protocol=https\nhost=gitboy.example.com\n\n")).toBeUndefined();
    expect(await gitCredentialCommand("erase", "protocol=https\nhost=gitboy.example.com\n\n")).toBeUndefined();
  });

  it("scrubs inherited token and git variables from a keyed launch", () => {
    const scrub = keyedEnvScrub({ GITBOY_TOKEN: "secret", GITBOY_HOST: "keep", GITBOY_OTHER: "x", GIT_CONFIG_COUNT: "1", GH_TOKEN: "t", PATH: "/bin" });
    expect(scrub).toMatchObject({ GITBOY_TOKEN: "", GITBOY_OTHER: "", GIT_CONFIG_COUNT: "", GH_TOKEN: "", GIT_ASKPASS: "", SSH_AUTH_SOCK: "", GIT_SSH_COMMAND: "" });
    expect(scrub).not.toHaveProperty("GITBOY_HOST");
    expect(scrub).not.toHaveProperty("PATH");
    expect(Object.values(scrub).every(value => value === "")).toBe(true);
  });

  it("rewrites an SSH origin to credential-free HTTPS and disables SSH", async () => {
    const dir = await repoFrom("git@gitboy.example.com:o/r.git");
    const worktree = await createLaunchWorktree(dir, { branch: "agent/ssh" });
    expect(await configureGitboyWorktree(worktree.path, worktree.branch)).toBe(true);
    expect((await git(worktree.path, "config", "--worktree", "--get", "remote.origin.url")).trim()).toBe("https://gitboy.example.com/o/r.git");
    expect((await git(worktree.path, "config", "--worktree", "--get", "remote.origin.pushurl")).trim()).toBe("https://gitboy.example.com/o/r.git");
    expect((await git(worktree.path, "config", "--worktree", "--get", "core.sshCommand")).trim()).toBe("false");
    expect((await git(worktree.path, "config", "--worktree", "--get", "http.https://gitboy.example.com/.extraHeader")).trim()).toBe("");
  });

  it("refuses a gitboy remote whose owner and repository cannot be derived", async () => {
    const dir = await repoFrom("https://gitboy.example.com/only-one-segment.git");
    const worktree = await createLaunchWorktree(dir, { branch: "agent/bad-remote" });
    await expect(configureGitboyWorktree(worktree.path, worktree.branch)).rejects.toMatchObject({ status: 409 });
  });

  it("uses only an agent-marked gba_ token and carries the marker through resolveHostToken", async () => {
    expect(await resolveAgentToken("gitboy.example.com")).toMatchObject({ token: "gba_test", agent: true });
    expect(await resolveHostToken("gitboy", "gitboy.example.com")).toMatchObject({ token: "gba_test", agent: true });
    await writeHostToken("ordinary.example.com", "gitboy", "gbp_user", "sam");
    expect(await resolveAgentToken("ordinary.example.com")).toBeUndefined();
    await writeHostToken("not-agent.example.com", "gitboy", "gbp_not", "sam", undefined, true);
    expect(await resolveAgentToken("not-agent.example.com")).toBeUndefined();
    expect(await gitCredentialCommand("get", "protocol=https\nhost=ordinary.example.com\n\n")).toBeUndefined();
  });

  it("writes the agent token to a private file and passes only its path", async () => {
    const dir = await repo();
    const prepared = await prepareKeyedGitboy(dir);
    expect(prepared).toBeDefined();
    expect(prepared!.env).not.toHaveProperty("GITBOY_TOKEN");
    expect(prepared!.env.GITBOY_TOKEN_FILE).toBe(prepared!.tokenFile);
    expect(await readFile(prepared!.tokenFile, "utf8")).toBe("gba_test");
    if (process.platform !== "win32") expect((await stat(prepared!.tokenFile)).mode & 0o777).toBe(0o600);
    await removeAgentTokenFile(prepared!.tokenFile);
    expect(await stat(prepared!.tokenFile).catch(() => undefined)).toBeUndefined();
  });

  it("fails closed when a keyed gitboy checkout has no agent token", async () => {
    const dir = await repo("gitboy-missing.example.com");
    await expect(prepareKeyedGitboy(dir)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("No gitboy agent token") });
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
