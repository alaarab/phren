import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidateRepos, enrollProject } from "./enroll.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "t");
  await writeFile(path.join(dir, "README.md"), "# x\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
}

describe("bridge enroll", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const previousHome = process.env.HOME;
  beforeEach(async () => {
    home = realpathSync.native(await mkdtemp(path.join(tmpdir(), "phren-enroll-")));
    // homedir() reads $HOME on POSIX; the search roots hang off it.
    process.env.HOME = home;
    await mkdir(path.join(home, "store/.config"), { recursive: true });
    await writeFile(path.join(home, "store/.config/machines.yaml"), "");
    await initRepo(path.join(home, "store"));
    env = { ...process.env, PHREN_PATH: path.join(home, "store"), PROJECTS_DIR: path.join(home, "work") };
  });
  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("lists checkouts, marks tracked ones, and dedupes by repository root", async () => {
    await initRepo(path.join(home, "work/alpha"));
    await initRepo(path.join(home, "work/beta"));
    await mkdir(path.join(home, "work/not-a-repo"), { recursive: true });
    await mkdir(path.join(home, "store/beta"), { recursive: true });
    await writeFile(path.join(home, "store/beta/phren.project.yaml"), `sourcePath: ${path.join(home, "work/beta")}\n`);
    const activity = [{ at: "2026-09-12T01:00:00Z", directory: path.join(home, "work/alpha/src") }];
    const repos = await candidateRepos(activity, env);
    expect(repos.map(r => [r.name, r.source, r.registered])).toEqual([
      ["alpha", "activity", false], // trimmed to the checkout root, newest first
      ["beta", "search", true],
    ]);
    expect(repos[0].directory).toBe(path.join(home, "work/alpha"));
    expect(repos[0].lastSeen).toBe("2026-09-12T01:00:00Z");
  });

  it("enrolls an existing checkout and commits the store", async () => {
    await initRepo(path.join(home, "work/gamma"));
    const result = await enrollProject({ directory: path.join(home, "work/gamma") }, env);
    expect(result).toMatchObject({ ok: true, project: "gamma", directory: path.join(home, "work/gamma"), cloned: false, store: "committed" });
    expect(await readFile(path.join(home, "store/gamma/phren.project.yaml"), "utf8")).toContain("sourcePath:");
    expect(git(path.join(home, "store"), "log", "-1", "--format=%s")).toContain("Add project gamma");
    expect((await candidateRepos([], env)).find(r => r.name === "gamma")?.registered).toBe(true);
  });

  it("clones a repository into the projects folder before enrolling it", async () => {
    await initRepo(path.join(home, "upstream/delta.git"));
    await mkdir(path.join(home, "work"), { recursive: true });
    // A file URL is not accepted from the phone; the https form is checked
    // separately below. Point git at the local origin through its insteadOf
    // rewrite so the clone itself is exercised offline.
    const config = path.join(home, ".gitconfig");
    await writeFile(config, `[url "${path.join(home, "upstream/")}"]\n\tinsteadOf = https://example.test/o/\n`);
    const result = await enrollProject({ cloneUrl: "https://example.test/o/delta.git" }, { ...env, GIT_CONFIG_GLOBAL: config });
    expect(result).toMatchObject({ ok: true, project: "delta", directory: path.join(home, "work/delta"), cloned: true });
    expect(git(path.join(home, "work/delta"), "log", "-1", "--format=%s")).toContain("init");
    expect(git(path.join(home, "store"), "log", "-1", "--format=%s")).toContain("Add project delta");
    await expect(enrollProject({ cloneUrl: "https://example.test/o/delta.git" }, { ...env, GIT_CONFIG_GLOBAL: config })).rejects.toThrow("already exists");
  });

  it("rejects paths off this computer and non-repository URLs", async () => {
    await expect(enrollProject({ directory: "relative/path" }, env)).rejects.toThrow("full folder path");
    await expect(enrollProject({ directory: path.join(home, "missing") }, env)).rejects.toThrow("not on this computer");
    await expect(enrollProject({ cloneUrl: "ext::sh -c 'touch /tmp/pwned'" }, env)).rejects.toThrow("GitHub repository URL");
    await expect(enrollProject({ cloneUrl: "/local/path" }, env)).rejects.toThrow("GitHub repository URL");
    await expect(enrollProject({}, env)).rejects.toThrow("Choose a folder");
    await expect(enrollProject({ directory: home }, { ...env, PHREN_PATH: path.join(home, "nowhere") })).rejects.toThrow("not set up");
  });
});
