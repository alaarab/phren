import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";

const RECOVERY_TEST_TIMEOUT_MS = process.platform === "win32" ? 20000 : 10000;

function git(cwd: string, args: string[], encoding: "utf8" | null = null): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: encoding ?? undefined as any }).toString();
}

function configureRepo(repo: string) {
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo, stdio: "ignore" });
}

describe("handleBackgroundSync recovery", () => {
  let tmp: { path: string; cleanup: () => void };
  const origCortexPath = process.env.CORTEX_PATH;

  beforeEach(() => {
    tmp = makeTempDir("cortex-bg-sync-recovery-");
    vi.resetModules();
  });

  afterEach(() => {
    if (origCortexPath === undefined) delete process.env.CORTEX_PATH;
    else process.env.CORTEX_PATH = origCortexPath;
    tmp.cleanup();
  });

  it("recovers from non-fast-forward push by pull-rebase and retrying push", async () => {
    const remote = path.join(tmp.path, "remote.git");
    const repoA = path.join(tmp.path, "repo-a");
    const repoB = path.join(tmp.path, "repo-b");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoA], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoB], { stdio: "ignore" });
    configureRepo(repoA);
    configureRepo(repoB);

    fs.mkdirSync(path.join(repoA, "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoA, "demo", "backlog.md"), "# backlog\n\n## Active\n\n- Base task\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repoA, stdio: "ignore" });

    execFileSync("git", ["pull", "--quiet"], { cwd: repoB, stdio: "ignore" });

    fs.writeFileSync(path.join(repoA, "demo", "backlog.md"), "# backlog\n\n## Active\n\n- Base task\n- Remote task\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "remote"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push"], { cwd: repoA, stdio: "ignore" });

    fs.writeFileSync(path.join(repoB, "demo", "summary.md"), "# summary\n\nlocal only\n");
    execFileSync("git", ["add", "."], { cwd: repoB, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "local"], { cwd: repoB, stdio: "ignore" });

    process.env.CORTEX_PATH = repoB;
    const { handleBackgroundSync } = await import("../cli-hooks-session.js");
    await handleBackgroundSync();

    execFileSync("git", ["pull", "--quiet"], { cwd: repoA, stdio: "ignore" });
    const summary = fs.readFileSync(path.join(repoA, "demo", "summary.md"), "utf8");
    expect(summary).toContain("local only");

    const runtime = JSON.parse(fs.readFileSync(path.join(repoB, ".governance", "runtime-health.json"), "utf8"));
    expect(runtime.lastSync.lastPushStatus).toBe("saved-pushed");
    expect(runtime.lastSync.lastPullStatus).toBe("ok");
  }, RECOVERY_TEST_TIMEOUT_MS);

  it("keeps commits local when the remote becomes unavailable", async () => {
    const remote = path.join(tmp.path, "remote-down.git");
    const repo = path.join(tmp.path, "repo-down");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repo], { stdio: "ignore" });
    configureRepo(repo);
    fs.mkdirSync(path.join(repo, ".governance"), { recursive: true });

    fs.mkdirSync(path.join(repo, "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "demo", "summary.md"), "# summary\n\nbase\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repo, stdio: "ignore" });

    fs.rmSync(remote, { recursive: true, force: true });

    fs.writeFileSync(path.join(repo, "demo", "summary.md"), "# summary\n\nlocal after remote loss\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "local"], { cwd: repo, stdio: "ignore" });

    process.env.CORTEX_PATH = repo;
    const { handleBackgroundSync } = await import("../cli-hooks-session.js");
    await handleBackgroundSync();

    expect(git(repo, ["log", "--oneline", "-1"], "utf8")).toContain("local");
    expect(fs.existsSync(path.join(repo, ".runtime", "background-sync.lock"))).toBe(false);
  }, RECOVERY_TEST_TIMEOUT_MS);

  it("aborts rebase and leaves commit local when conflicts require manual resolution", async () => {
    const remote = path.join(tmp.path, "remote-manual.git");
    const repoA = path.join(tmp.path, "repo-manual-a");
    const repoB = path.join(tmp.path, "repo-manual-b");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoA], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoB], { stdio: "ignore" });
    configureRepo(repoA);
    configureRepo(repoB);
    fs.mkdirSync(path.join(repoA, ".governance"), { recursive: true });
    fs.mkdirSync(path.join(repoB, ".governance"), { recursive: true });

    fs.mkdirSync(path.join(repoA, "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoA, "demo", "summary.md"), "# summary\n\nshared line\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["pull", "--quiet"], { cwd: repoB, stdio: "ignore" });

    fs.writeFileSync(path.join(repoA, "demo", "summary.md"), "# summary\n\nremote change\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "remote"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push"], { cwd: repoA, stdio: "ignore" });

    fs.writeFileSync(path.join(repoB, "demo", "summary.md"), "# summary\n\nlocal conflicting change\n");
    execFileSync("git", ["add", "."], { cwd: repoB, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "local"], { cwd: repoB, stdio: "ignore" });

    process.env.CORTEX_PATH = repoB;
    const { handleBackgroundSync } = await import("../cli-hooks-session.js");
    await handleBackgroundSync();

    expect(git(repoB, ["log", "--oneline", "-1"], "utf8")).toContain("local");
    expect(fs.existsSync(path.join(repoB, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(repoB, ".runtime", "background-sync.lock"))).toBe(false);
    expect(fs.readFileSync(path.join(repoB, "demo", "summary.md"), "utf8")).toContain("local conflicting change");
    expect(fs.readFileSync(path.join(repoB, "demo", "summary.md"), "utf8")).not.toContain("<<<<<<<");
  }, RECOVERY_TEST_TIMEOUT_MS);

  it("auto-merges backlog conflicts without leaving merge markers behind", async () => {
    const remote = path.join(tmp.path, "remote-backlog.git");
    const repoA = path.join(tmp.path, "repo-backlog-a");
    const repoB = path.join(tmp.path, "repo-backlog-b");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoA], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, repoB], { stdio: "ignore" });
    configureRepo(repoA);
    configureRepo(repoB);
    fs.mkdirSync(path.join(repoA, ".governance"), { recursive: true });
    fs.mkdirSync(path.join(repoB, ".governance"), { recursive: true });

    fs.mkdirSync(path.join(repoA, "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoA, "demo", "backlog.md"), "# demo backlog\n\n## Active\n\n- [ ] Base task\n\n## Queue\n\n## Done\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["pull", "--quiet"], { cwd: repoB, stdio: "ignore" });

    fs.writeFileSync(path.join(repoA, "demo", "backlog.md"), "# demo backlog\n\n## Active\n\n- [ ] Base task\n- [ ] Remote task\n\n## Queue\n\n## Done\n");
    execFileSync("git", ["add", "."], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "remote backlog"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["push"], { cwd: repoA, stdio: "ignore" });

    fs.writeFileSync(path.join(repoB, "demo", "backlog.md"), "# demo backlog\n\n## Active\n\n- [ ] Base task\n- [ ] Local task\n\n## Queue\n\n## Done\n");
    execFileSync("git", ["add", "."], { cwd: repoB, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "local backlog"], { cwd: repoB, stdio: "ignore" });

    process.env.CORTEX_PATH = repoB;
    const { handleBackgroundSync } = await import("../cli-hooks-session.js");
    await handleBackgroundSync();

    execFileSync("git", ["pull", "--quiet"], { cwd: repoA, stdio: "ignore" });
    const backlog = fs.readFileSync(path.join(repoA, "demo", "backlog.md"), "utf8");
    expect(backlog).toContain("Remote task");
    expect(backlog).toContain("Local task");
    expect(backlog).not.toContain("<<<<<<<");
  }, RECOVERY_TEST_TIMEOUT_MS);

});
