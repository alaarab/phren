import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";

const storeRoot = vi.hoisted(() => ({ current: "" }));
vi.mock("../shared.js", async () => {
  const actual = await vi.importActual<typeof import("../shared.js")>("../shared.js");
  return { ...actual, getPhrenPath: () => storeRoot.current };
});

import { handleStoreNamespace } from "./namespaces-store.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

function write(repo: string, rel: string, content: string): void {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(repo: string, rel: string, content: string, message: string): string {
  write(repo, rel, content);
  git(repo, "add", "--", rel);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function configure(repo: string): void {
  git(repo, "config", "user.email", "sam@example.com");
  git(repo, "config", "user.name", "sam");
}

function fixture(rel: string, initial: string) {
  const tmp = makeTempDir("phren-store-sync-");
  cleanups.push(tmp.cleanup);
  const remote = path.join(tmp.path, "remote.git");
  const writer = path.join(tmp.path, "writer");
  const local = path.join(tmp.path, "local");
  git(tmp.path, "init", "--bare", "--initial-branch=main", remote);
  git(tmp.path, "clone", remote, writer);
  configure(writer);
  write(writer, ".gitignore", ".runtime/\n.sessions/\n");
  write(writer, rel, initial);
  git(writer, "add", ".");
  git(writer, "commit", "-m", "initial");
  git(writer, "push", "-u", "origin", "main");
  git(tmp.path, "clone", remote, local);
  configure(local);
  storeRoot.current = local;
  return { local, writer };
}

async function syncOutput(): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => lines.push(args.join(" ")));
  await handleStoreNamespace(["sync"]);
  return lines.join("\n");
}

describe("phren store sync with real Git repositories", () => {
  it("merges divergent FINDINGS.md commits with both bullets and a clean tree", async () => {
    const rel = "project/FINDINGS.md";
    const base = "# Project Findings\n\n## 2026-01-01\n\n- Base bullet\n";
    const { local, writer } = fixture(rel, base);
    commit(local, rel, "# Project Findings\n\n## 2026-01-01\n\n- Local bullet\n", "local finding");
    commit(writer, rel, "# Project Findings\n\n## 2026-01-01\n\n- Remote bullet\n", "remote finding");
    git(writer, "push");

    const output = await syncOutput();

    const merged = fs.readFileSync(path.join(local, rel), "utf8");
    expect(merged).toContain("Local bullet");
    expect(merged).toContain("Remote bullet");
    expect(git(local, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(local, ".git", "MERGE_HEAD"))).toBe(false);
    expect(fs.existsSync(path.join(local, ".git", "rebase-merge"))).toBe(false);
    expect(output).toContain("resolved conflicts in project/FINDINGS.md");
  });

  it("aborts a conflict outside the union set and reports its exact path", async () => {
    const rel = "project/settings.yaml";
    const { local, writer } = fixture(rel, "value: base\n");
    const localHead = commit(local, rel, "value: local\n", "local settings");
    commit(writer, rel, "value: remote\n", "remote settings");
    git(writer, "push");

    const output = await syncOutput();

    expect(output).toContain("NEEDS MANUAL RESOLUTION");
    expect(output).toContain(rel);
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(fs.readFileSync(path.join(local, rel), "utf8")).toBe("value: local\n");
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(local, ".git", "MERGE_HEAD"))).toBe(false);
    expect(fs.existsSync(path.join(local, ".git", "rebase-merge"))).toBe(false);
  });

  it("leaves an existing rebase untouched and prints its recovery command", async () => {
    const rel = "project/FINDINGS.md";
    const { local, writer } = fixture(rel, "# Project Findings\n\n- Base\n");
    const trackedBefore = git(local, "rev-parse", "refs/remotes/origin/main");
    commit(writer, rel, "# Project Findings\n\n- Remote\n", "remote finding");
    git(writer, "push");
    const rebaseDir = path.join(local, ".git", "rebase-merge");
    fs.mkdirSync(rebaseDir);
    write(local, ".git/rebase-merge/sentinel", "untouched\n");

    const output = await syncOutput();

    expect(output).toContain("Git operation in progress (rebase)");
    expect(output).toContain("git rebase --abort");
    expect(fs.readFileSync(path.join(rebaseDir, "sentinel"), "utf8")).toBe("untouched\n");
    expect(git(local, "rev-parse", "refs/remotes/origin/main")).toBe(trackedBefore);
  });
});
