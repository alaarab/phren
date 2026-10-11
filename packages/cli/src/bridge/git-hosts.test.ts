import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectHost, kindFromDomain, parseRemoteUrl } from "./git-hosts.js";
import { gitPulls } from "./git.js";
import { gitPullRequest } from "./git-publish.js";

const execFileAsync = promisify(execFile);

describe("git hosts", () => {
  let created: string | undefined;
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, PHREN_BRIDGE_HOME: process.env.PHREN_BRIDGE_HOME, GITLAB_TOKEN: process.env.GITLAB_TOKEN, GITBOY_TOKEN: process.env.GITBOY_TOKEN };
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (created) await rm(created, { recursive: true, force: true });
    created = undefined;
  });

  /** A repository on `feature` with `origin` at `url`, and its own global config file. */
  async function repository(url: string) {
    const root = created = await realpath(await mkdtemp(path.join(tmpdir(), "phren-hosts-")));
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
    process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
    delete process.env.GITLAB_TOKEN; delete process.env.GITBOY_TOKEN;
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", root, ...args])).stdout;
    await git("init", "-q", "-b", "feature");
    await git("remote", "add", "origin", url);
    return { root, git, global: (...args: string[]) => execFileAsync("git", ["config", "--global", ...args]) };
  }

  it("reads the domain and repository from every remote URL shape", () => {
    expect(parseRemoteUrl("git@github.com:sam/phren.git")).toEqual({ domain: "github.com", path: "sam/phren" });
    expect(parseRemoteUrl("https://github.com/sam/phren")).toEqual({ domain: "github.com", path: "sam/phren" });
    expect(parseRemoteUrl("https://token@GitLab.example.com/group/sub/repo.git")).toEqual({ domain: "gitlab.example.com", path: "group/sub/repo" });
    expect(parseRemoteUrl("ssh://git@git.example.com:2222/team/app.git")).toEqual({ domain: "git.example.com", path: "team/app" });
    expect(parseRemoteUrl("/srv/git/app.git")).toBeNull();
    expect(parseRemoteUrl("file:///srv/git/app.git")).toBeNull();
  });

  it("names the public hosts and self-hosted ones whose name says so, and nothing else", () => {
    expect(kindFromDomain("github.com")).toBe("github");
    expect(kindFromDomain("github.acme.com")).toBe("github");
    expect(kindFromDomain("acme.ghe.com")).toBe("github");
    expect(kindFromDomain("gitlab.com")).toBe("gitlab");
    expect(kindFromDomain("gitlab.acme.com")).toBe("gitlab");
    expect(kindFromDomain("gitboy.home.arpa")).toBe("gitboy");
    expect(kindFromDomain("git.example.com")).toBeNull();
    expect(kindFromDomain("notgithub.com")).toBeNull();
  });

  it("detects the host from the URL, then lets a domain or a remote override it", async () => {
    const { root, git, global } = await repository("git@git.example.com:team/app.git");
    expect(await detectHost(root, "feature")).toMatchObject({ kind: null, source: "none", domain: "git.example.com", remote: "origin", supported: false });
    await global("phren.git.example.com.host", "gitboy");
    expect(await detectHost(root, "feature")).toMatchObject({ kind: "gitboy", name: "gitboy", source: "domain-override", webUrl: "https://git.example.com/team/app" });
    await git("config", "remote.origin.phrenHost", "GitLab");
    expect(await detectHost(root, "feature")).toMatchObject({ kind: "gitlab", source: "remote-override", terms: { short: "MR", long: "merge request", ref: "!" } });
    // An override that names no supported host is ignored.
    await git("config", "remote.origin.phrenHost", "bitbucket");
    expect(await detectHost(root, "feature")).toMatchObject({ kind: "gitboy", source: "domain-override" });
  });

  it("follows the branch's upstream remote before origin", async () => {
    const { root, git } = await repository("https://github.com/sam/phren.git");
    await git("remote", "add", "work", "https://gitlab.com/team/phren.git");
    await git("config", "branch.feature.remote", "work");
    await git("config", "branch.feature.merge", "refs/heads/feature");
    expect(await detectHost(root, "feature")).toMatchObject({ kind: "gitlab", remote: "work", webUrl: "https://gitlab.com/team/phren" });
    expect(await detectHost(root, "other")).toMatchObject({ kind: "github", remote: "origin" });
  });

  it("answers plainly for unknown hosts, and tells an unconnected GitLab or gitboy how to connect", async () => {
    const { root, git } = await repository("git@git.example.com:team/app.git");
    const unknown = await gitPulls(root);
    expect(unknown).toMatchObject({ available: false, reason: "unknown-host", pulls: [], current: null, branch: "feature" });
    expect(String(unknown.message)).toContain("git config remote.origin.phrenHost github|gitlab|gitboy");
    expect(await gitPullRequest(root, false)).toMatchObject({ ok: false, reason: "unknown-host" });

    // GitLab and gitboy are read over HTTP: with no token anywhere they say how to connect.
    for (const kind of ["gitlab", "gitboy"] as const) {
      await git("config", "remote.origin.phrenHost", kind);
      const list = await gitPulls(root);
      expect(list).toMatchObject({ available: false, reason: "auth", host: { kind, supported: true } });
      expect(String(list.message)).toContain(`phren bridge git-host set git.example.com ${kind}`);
    }
  });

});
