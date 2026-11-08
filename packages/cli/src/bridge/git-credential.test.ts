import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCredentialCommand, keyedExplicitEnv, prepareKeyedGitboy, removeAgentTokenFile } from "./git-credential.js";
import { cloneStartDirectory, dispatchClonePaths, writeManagedConfig } from "./dispatch-clone.js";
import { explicitAgentCommand } from "./terminal-tmux.js";
import { herdrExplicitCommand, herdrTerminal } from "./terminal-herdr.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { resolveAgentToken, resolveHostToken, writeHostToken } from "./git-host-auth.js";

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

  it("builds only the explicit keyed environment", () => {
    const env = keyedExplicitEnv({ HOME: "/home/sam", PATH: "/bin", CODEX_HOME: "/codex", GITBOY_TOKEN: "secret", GH_TOKEN: "t", GIT_CONFIG_COUNT: "1" },
      { GITBOY_HOST: "gitboy.example.com", GIT_CONFIG_NOSYSTEM: "1" });
    expect(env).toMatchObject({ HOME: "/home/sam", PATH: "/bin", CODEX_HOME: "/codex", GITBOY_HOST: "gitboy.example.com", GIT_CONFIG_NOSYSTEM: "1" });
    expect(env).not.toHaveProperty("GITBOY_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
  });

  it("builds a tmux command with only the explicit environment and no token", () => {
    const env = keyedExplicitEnv({ PATH: "/bin", HOME: "/home/sam", GITBOY_TOKEN: "secret", GH_TOKEN: "secret2" },
      { GITBOY_HOST: "gitboy.example.com", GITBOY_TOKEN_FILE: "/tmp/token", GIT_CONFIG_GLOBAL: "/tmp/config", GIT_CONFIG_NOSYSTEM: "1" });
    const command = explicitAgentCommand("codex", ["-a", "untrusted", "-s", "read-only"], env);
    expect(command).toContain('PATH="$PATH"');
    expect(command).toContain("GITBOY_TOKEN_FILE='/tmp/token'");
    expect(command).toContain("GIT_CONFIG_GLOBAL='/tmp/config'");
    expect(command).not.toContain("secret");
    expect(command).not.toMatch(/\bGITBOY_TOKEN=/);
    expect(command).not.toMatch(/\bGH_TOKEN=/);
    expect(herdrExplicitCommand({ name: "worker", kind: "codex", args: ["-a", "untrusted", "-s", "read-only"], timeoutMs: 1_000, env, envExact: true })).toBe(command);
  });

  it("adds our pane identity variables to the explicit environment", async () => {
    const paneEnv = herdrTerminal.paneEnv?.("default", { workspace: "w1", tab: "t1", pane: "p1" }) ?? {};
    const env = { ...keyedExplicitEnv({ PATH: "/bin" }, { GITBOY_HOST: "gitboy.example.com" }), ...paneEnv };
    expect(await terminalPaneFromEnv(env)).toMatchObject({ server: "default", workspace: "w1", tab: "t1", pane: "p1" });
  });

  it("uses only a managed global config, so user URL overrides do not apply", async () => {
    const dir = await repoFrom("git@gitboy.example.com:o/r.git");
    await git(dir, "config", "user.name", "Sam Owner");
    await git(dir, "config", "user.email", "sam@example.com");
    const managed = dispatchClonePaths("50000000-0000-4000-8000-000000000004").gitConfigFile;
    const user = path.join(root, "user.gitconfig");
    await writeManagedConfig(managed, "gitboy.example.com", dir);
    await writeFile(user, '[credential "https://gitboy.example.com"]\n\thelper = user-helper\n[http "https://gitboy.example.com/"]\n\textraHeader = Authorization: secret\n');
    const url = "https://gitboy.example.com/o/r";
    const managedEnv = { ...process.env, GIT_CONFIG_GLOBAL: managed, GIT_CONFIG_NOSYSTEM: "1" };
    const userEnv = { ...process.env, GIT_CONFIG_GLOBAL: user, GIT_CONFIG_NOSYSTEM: "1" };
    expect((await execFileAsync("git", ["-C", dir, "config", "--get-urlmatch", "credential.helper", url], { env: userEnv })).stdout.trim()).toBe("user-helper");
    expect((await execFileAsync("git", ["-C", dir, "config", "--get-urlmatch", "credential.helper", url], { env: managedEnv })).stdout.trim())
      .toBe("!phren bridge git-credential");
    expect((await execFileAsync("git", ["-C", dir, "config", "--get", "core.sshCommand"], { env: managedEnv })).stdout.trim()).toBe("false");
    expect((await execFileAsync("git", ["-C", dir, "config", "--get", "user.name"], { env: managedEnv })).stdout.trim()).toBe("Sam Owner");
  });

  it("refuses a symlinked project folder that escapes the clone", async () => {
    const repo = path.join(root, "repo");
    const checkout = path.join(repo, "app");
    const clone = path.join(root, "clone");
    const outside = path.join(root, "outside");
    await mkdir(checkout, { recursive: true });
    await mkdir(clone, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(clone, "app"));
    await expect(cloneStartDirectory(clone, repo, checkout)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses clone paths outside the managed root", async () => {
    const dir = await repo();
    const outside = path.join(root, "outside");
    const { createDispatchClone } = await import("./dispatch-clone.js");
    await expect(createDispatchClone(dir, { branch: "agent/escape", dispatchId: "50000000-0000-4000-8000-000000000003",
      paths: { cloneDir: outside, gitConfigFile: path.join(root, "outside.gitconfig"), agentTokenFile: path.join(outside, "phren-agent-token") } }))
      .rejects.toMatchObject({ status: 403 });
    expect(await stat(outside).catch(() => undefined)).toBeUndefined();
  });

  it("refuses a gitboy remote whose owner and repository cannot be derived", async () => {
    const dir = await repoFrom("https://gitboy.example.com/only-one-segment.git");
    const { createDispatchClone } = await import("./dispatch-clone.js");
    await expect(createDispatchClone(dir, { branch: "agent/bad-remote", dispatchId: "50000000-0000-4000-8000-000000000002" }))
      .rejects.toMatchObject({ status: 409 });
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

});
