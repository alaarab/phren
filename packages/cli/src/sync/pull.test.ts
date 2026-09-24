import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullAtSessionStart } from "../cli/session-git.js";
import { tryFileLock } from "../governance/locks.js";
import { getRuntimeHealth } from "../governance/policy.js";
import { writeInstallPreferences } from "../init/preferences.js";
import { runtimeFile } from "../phren-paths.js";
import { getMachineName, storeCommitMessage } from "../machine-identity.js";
import { initTestPhrenRoot, makeTempDir, writeFile } from "../test-helpers.js";
import { describeAutoSave } from "./outcome.js";
import { parsePullInterval, periodicPullEnabled, pollStore, readPollState, type RunGit, resolvePullInterval, runPollGit, startPullPolling } from "./pull.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function temp() {
  const dir = makeTempDir("phren-poll-");
  cleanups.push(dir.cleanup);
  return dir.path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  }).trim();
}

function fixture() {
  const root = temp();
  const remote = path.join(root, "remote.git");
  const writer = path.join(root, "writer");
  const reader = path.join(root, "reader");
  git(root, "init", "--bare", "--initial-branch=knowledge", remote);
  git(root, "clone", remote, writer);
  for (const repo of [writer]) {
    git(repo, "config", "user.email", "poll-test@example.com");
    git(repo, "config", "user.name", "Poll test");
  }
  writeFile(path.join(writer, ".gitignore"), ".runtime/\n.sessions/\n");
  writeFile(path.join(writer, "project", "summary.md"), "original\n");
  git(writer, "add", ".");
  git(writer, "commit", "-m", "initial");
  git(writer, "push", "-u", "origin", "knowledge");
  git(root, "clone", "--origin=cloud", remote, reader);
  git(reader, "config", "user.email", "poll-test@example.com");
  git(reader, "config", "user.name", "Poll test");
  const commit = (repo: string, text: string) => {
    writeFile(path.join(repo, "project", "summary.md"), text);
    git(repo, "add", ".");
    git(repo, "commit", "-m", text.trim());
    return git(repo, "rev-parse", "HEAD");
  };
  const publish = (text = "from phone\n") => {
    const sha = commit(writer, text);
    git(writer, "push");
    return sha;
  };
  return { reader, writer, publish, commit };
}

describe("periodic pull settings", () => {
  it("defaults to off, with local preferences and environment overrides", () => {
    const root = temp();
    expect(resolvePullInterval(root, {})).toBe(0);
    writeInstallPreferences(root, { pullIntervalSeconds: 600 });
    expect(resolvePullInterval(root, {})).toBe(600);
    expect(resolvePullInterval(root, { PHREN_PULL_INTERVAL_SECONDS: "120" })).toBe(120);
    expect(resolvePullInterval(root, { PHREN_PULL_INTERVAL_SECONDS: "off" })).toBe(0);
    expect(resolvePullInterval(root, { PHREN_PULL_INTERVAL_SECONDS: "bad" })).toBe(600);
    for (const invalid of ["", "10", "60s", "60.1", "-1", "86401", NaN, null, {}]) {
      expect(parsePullInterval(invalid)).toBeUndefined();
    }
    expect(parsePullInterval("0")).toBe(0);
    expect(parsePullInterval("30")).toBe(30);
    expect(parsePullInterval("86400")).toBe(86400);
  });

  it("respects manual and project-local installs", () => {
    const root = temp();
    initTestPhrenRoot(root);
    expect(periodicPullEnabled(root)).toBe(true);
    writeInstallPreferences(root, { managementPreset: "manual" });
    expect(periodicPullEnabled(root)).toBe(false);
    writeInstallPreferences(root, { managementPreset: "assisted" });
    expect(periodicPullEnabled(root)).toBe(true);
    initTestPhrenRoot(root, { installMode: "project-local", syncMode: "workspace-git", workspaceRoot: root, primaryProject: "demo" });
    expect(periodicPullEnabled(root)).toBe(false);
  });
});

describe("store polling with real Git repositories", () => {
  it("shares a single remote check across concurrent clients and skips unchanged fetches", async () => {
    const { reader } = fixture();
    const run = vi.fn(runPollGit);
    const results = await Promise.all([pollStore(reader, 60, run, 100_000), pollStore(reader, 60, run, 100_000)]);
    expect(results.map((r) => r.status).sort()).toEqual(["not-due", "unchanged"]);
    expect((await pollStore(reader, 60, run, 159_999)).status).toBe("not-due");
    expect(run.mock.calls.filter(([, args]) => args[0] === "ls-remote")).toHaveLength(1);
    expect(run.mock.calls.some(([, args]) => ["fetch", "merge", "pull"].includes(args[0]))).toBe(false);
    expect((await pollStore(reader, 60, run, 160_000)).status).toBe("unchanged");
  });

  it("fast-forwards the configured upstream, even with a non-origin remote and non-main branch", async () => {
    const { reader, publish } = fixture();
    const remoteHead = publish();
    expect((await pollStore(reader, 60)).status).toBe("updated");
    expect(git(reader, "rev-parse", "HEAD")).toBe(remoteHead);
    // Git may check out CRLF under the Windows runner's core.autocrlf.
    expect(fs.readFileSync(path.join(reader, "project", "summary.md"), "utf8").replace(/\r\n/g, "\n")).toBe("from phone\n");
    expect(git(reader, "status", "--porcelain")).toBe("");
  });

  it("commits uncommitted store writes before pulling instead of deferring them", async () => {
    const { reader, publish, commit } = fixture();
    publish();
    writeFile(path.join(reader, "notes.md"), "local draft\n");
    expect((await pollStore(reader, 60, runPollGit, 100_000)).status).toBe("updated");
    expect(fs.readFileSync(path.join(reader, "notes.md"), "utf8")).toBe("local draft\n");
    expect(git(reader, "show", "HEAD:notes.md")).toBe("local draft");
    expect(git(reader, "status", "--porcelain")).toBe("");
    // The auto-save names the computer that wrote it.
    expect(git(reader, "log", "--format=%s").split("\n")).toContain(storeCommitMessage("auto-save phren (periodic pull)"));
    expect(storeCommitMessage("phren: demo(findings)")).toBe(`phren: demo(findings) [${getMachineName()}]`);
    const localHead = commit(reader, "local ahead\n");
    const run = vi.fn(runPollGit);
    expect((await pollStore(reader, 60, run, 220_000)).status).toBe("unchanged");
    expect(git(reader, "rev-parse", "HEAD")).toBe(localHead);
    expect(run.mock.calls.some(([, args]) => args[0] === "fetch")).toBe(false);
  });

  it("commits a task written through add_task before pulling and keeps both sides of tasks.md", async () => {
    const { reader, writer } = fixture();
    const tasksPath = (repo: string) => path.join(repo, "project", "tasks.md");
    const localTasks = "# task\n\n## Active\n\n## Queue\n\n- [ ] Local task written by add_task\n\n## Done\n";
    writeFile(tasksPath(reader), localTasks);

    // The task is still uncommitted when the sync routine runs; the remote has not moved.
    expect((await pollStore(reader, 60, runPollGit, 100_000)).status).toBe("unchanged");
    expect(git(reader, "show", "HEAD:project/tasks.md")).toContain("Local task written by add_task");
    expect(git(reader, "status", "--porcelain")).toBe("");

    // A second computer adds a task to the same file and pushes.
    const remoteTasks = "# task\n\n## Active\n\n## Queue\n\n- [ ] Remote task from another computer\n\n## Done\n";
    writeFile(tasksPath(writer), remoteTasks);
    git(writer, "add", ".");
    git(writer, "commit", "-m", "remote task");
    git(writer, "push");

    expect((await pollStore(reader, 60, runPollGit, 160_000)).status).toBe("updated");
    const merged = fs.readFileSync(tasksPath(reader), "utf8");
    expect(merged).toContain("Local task written by add_task");
    expect(merged).toContain("Remote task from another computer");
    expect(merged).not.toContain("<<<<<<<");
    expect(git(reader, "status", "--porcelain")).toBe("");
  });

  it("defers diverged history without starting a rebase or changing local commits", async () => {
    const { reader, publish, commit } = fixture();
    const localHead = commit(reader, "local change\n");
    publish();
    const result = await pollStore(reader, 60);
    expect(result.status).toBe("deferred");
    expect(result.detail).toContain("diverged");
    expect(git(reader, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(reader, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(reader, ".git", "rebase-merge"))).toBe(false);
    // The outcome is logged and kept with ahead/behind counts for doctor and status.
    const sync = getRuntimeHealth(reader).lastSync;
    expect(sync).toMatchObject({ lastPullStatus: "error", ahead: 1 });
    expect(typeof sync?.behind).toBe("number");
    const log = fs.readFileSync(runtimeFile(reader, "background-sync.log"), "utf8");
    expect(log).toMatch(new RegExp(`periodic-pull: failed deferred: Periodic pull deferred: local and remote history diverged\\..* \\(ahead 1, behind ${sync?.behind}\\)\\n`));
  });

  it("logs a quiet unchanged poll only when it follows a different outcome", async () => {
    const { reader } = fixture();
    const log = () => fs.readFileSync(runtimeFile(reader, "background-sync.log"), "utf8").trim().split("\n");
    expect((await pollStore(reader, 60, runPollGit, 100_000)).status).toBe("unchanged");
    expect(log()).toEqual([expect.stringMatching(/periodic-pull: ok unchanged: Remote is unchanged\. \(ahead 0, behind 0\)$/)]);
    expect((await pollStore(reader, 60, runPollGit, 200_000)).status).toBe("unchanged");
    expect(log()).toHaveLength(1);
    expect(getRuntimeHealth(reader).lastSync).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("moves a corrupt poll state aside and logs it instead of silently resetting", async () => {
    const { reader } = fixture();
    const state = runtimeFile(reader, "pull-poll.json");
    writeFile(state, "{ not json");
    expect(readPollState(reader)).toEqual({});
    expect(fs.existsSync(state)).toBe(false);
    const aside = fs.readdirSync(path.dirname(state)).filter((name) => name.startsWith("pull-poll.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(state), aside[0]), "utf8")).toBe("{ not json");
    expect(fs.readFileSync(runtimeFile(reader, "background-sync.log"), "utf8"))
      .toContain(`periodic-pull: poll state was corrupt (`);
    writeFile(state, "[1]");
    expect(readPollState(reader)).toEqual({});
    expect(fs.readFileSync(runtimeFile(reader, "background-sync.log"), "utf8")).toContain("(not a JSON object)");
  });

  it("describes a failed auto-save with its first error line and ahead/behind", () => {
    expect(describeAutoSave({ status: "sync-failed", detail: "merge conflict in phren/tasks.md\nhint: fix it", at: "2026-09-22T10:00:00.000Z" }, { ahead: 23, behind: 140 }))
      .toBe("sync failed: merge conflict in phren/tasks.md (ahead 23, behind 140) @ 2026-09-22T10:00:00.000Z");
    expect(describeAutoSave({ status: "saved-pushed" }, { ahead: 0, behind: 0 })).toBe("last auto-save: saved-pushed");
    expect(describeAutoSave({ status: "error", detail: "git add failed" }, undefined)).toBe("auto-save failed: git add failed");
    expect(describeAutoSave(undefined, undefined)).toBe("no auto-save runtime record yet");
  });

  it("leaves in-progress Git operations and held Phren locks alone", async () => {
    const { reader, publish } = fixture();
    publish();
    fs.mkdirSync(path.join(reader, ".git", "rebase-merge"));
    const run = vi.fn(runPollGit);
    expect((await pollStore(reader, 60, run, 100_000)).status).toBe("deferred");
    expect(run.mock.calls.some(([, args]) => args[0] === "ls-remote")).toBe(false);
    fs.rmdirSync(path.join(reader, ".git", "rebase-merge"));
    const release = tryFileLock(runtimeFile(reader, "git-op"));
    expect(release).not.toBeNull();
    try {
      expect((await pollStore(reader, 60, run, 160_000)).detail).toContain("another Phren Git operation");
      expect(tryFileLock(runtimeFile(reader, "git-op"))).toBeNull();
    } finally { release?.(); }
    expect((await pollStore(reader, 60, run, 220_000)).status).toBe("updated");
  });

  it("backs off failed network checks and resets after recovery", async () => {
    const { reader } = fixture();
    let offline = true;
    const run = vi.fn<RunGit>((cwd, args) => args[0] === "ls-remote" && offline
      ? Promise.resolve({ ok: false, output: "", error: "offline" }) : runPollGit(cwd, args));
    expect((await pollStore(reader, 60, run, 100_000)).status).toBe("error");
    expect(getRuntimeHealth(reader).lastSync?.lastPullStatus).toBe("error");
    expect((await pollStore(reader, 60, run, 160_000)).status).toBe("not-due");
    expect((await pollStore(reader, 60, run, 220_000)).status).toBe("error");
    expect((await pollStore(reader, 60, run, 459_999)).status).toBe("not-due");
    offline = false;
    expect((await pollStore(reader, 60, run, 460_000)).status).toBe("unchanged");
    expect(getRuntimeHealth(reader).lastSync?.lastPullStatus).toBe("ok");
    expect((await pollStore(reader, 60, run, 520_000)).status).toBe("unchanged");
  });

  it("does no Git work when disabled, and no network work without an upstream", async () => {
    const { reader } = fixture();
    const run = vi.fn(runPollGit);
    expect((await pollStore(reader, 0, run)).status).toBe("not-due");
    expect(run).not.toHaveBeenCalled();
    git(reader, "branch", "--unset-upstream");
    expect((await pollStore(reader, 60, run)).detail).toContain("No tracking remote");
    expect(run.mock.calls.some(([, args]) => args[0] === "ls-remote")).toBe(false);
    run.mockClear();
    initTestPhrenRoot(reader, { installMode: "project-local", syncMode: "workspace-git", workspaceRoot: reader, primaryProject: "project" });
    expect((await pollStore(reader, 60, run)).status).toBe("not-due");
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a conflicting startup rebase but preserves one that was already in progress", async () => {
    const { reader, publish, commit } = fixture();
    const localHead = commit(reader, "local change\n");
    publish();
    expect((await pullAtSessionStart(reader)).ok).toBe(false);
    expect(git(reader, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(reader, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(reader, ".git", "rebase-merge"))).toBe(false);
    expect(() => git(reader, "pull", "--rebase", "--quiet")).toThrow();
    const stoppedHead = git(reader, "rev-parse", "HEAD");
    expect((await pullAtSessionStart(reader)).error).toContain("already has a Git operation");
    expect(fs.existsSync(path.join(reader, ".git", "rebase-merge"))).toBe(true);
    expect(git(reader, "rev-parse", "HEAD")).toBe(stoppedHead);
    git(reader, "rebase", "--abort");
  });
});

describe("running MCP polling", () => {
  it("waits for the interval, reloads settings, refreshes other clients' changes, and stops cleanly", async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, ".git"));
    writeInstallPreferences(root, { pullIntervalSeconds: 60 });
    vi.stubEnv("PHREN_PULL_INTERVAL_SECONDS", "");
    vi.useFakeTimers();
    let head = "a".repeat(40);
    const run = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { ok: true, output: args[1] === "HEAD" ? head : path.join(root, ".git") };
      if (args[0] === "status") return { ok: true, output: "" };
      if (args[0] === "symbolic-ref") return { ok: true, output: "refs/heads/main" };
      if (args[0] === "for-each-ref") return { ok: true, output: "origin\trefs/heads/main\trefs/remotes/origin/main" };
      if (args[0] === "ls-remote") return { ok: true, output: `${head}\trefs/heads/main` };
      throw new Error(`Unexpected Git call: ${args}`);
    });
    const onChange = vi.fn(async () => {});
    const poller = startPullPolling(root, { git: run, onChange, runExclusive: (fn) => fn() });
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(run.mock.calls.some(([, args]) => args[0] === "ls-remote")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.mock.calls.filter(([, args]) => args[0] === "ls-remote")).toHaveLength(1);
      head = "b".repeat(40); // A different MCP process pulled this store.
      await vi.advanceTimersByTimeAsync(5000);
      expect(onChange).toHaveBeenCalledTimes(1);
      writeInstallPreferences(root, { pullIntervalSeconds: 600 });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(run.mock.calls.filter(([, args]) => args[0] === "ls-remote")).toHaveLength(1);
      writeInstallPreferences(root, { pullIntervalSeconds: 0 });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(run.mock.calls.filter(([, args]) => args[0] === "ls-remote")).toHaveLength(1);
      writeInstallPreferences(root, { pullIntervalSeconds: 30 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(run.mock.calls.filter(([, args]) => args[0] === "ls-remote")).toHaveLength(2);
    } finally { await poller.stop(); }
    const calls = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(calls);
  });
});
