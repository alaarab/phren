import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { pullAtSessionStart, recoverPushConflict } from "../cli/session-git.js";
import { runtimeFile } from "../phren-paths.js";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { conflictStrategy } from "./conflict-resolve.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  }).trim();
}

const read = (repo: string, rel: string) => fs.readFileSync(path.join(repo, rel), "utf8").replace(/\r\n/g, "\n");
const task = (bid: string, text: string, done = false) =>
  `- [${done ? "x" : " "}] ${text} <!-- bid:${bid} rank:3 created:2026-09-20T10:00:00.000Z scope:shared -->`;
const tasks = (queue: string[], done: string[] = []) =>
  ["# demo tasks", "", "## Active", "", "## Queue", "", ...queue, "", "## Done", "", ...done, ""].join("\n");
const topic = (now: string, bullets: string[]) =>
  ["# demo - sync", "", `<!-- phren:now:start at=${now} hash=abc123abc123 -->`, "## Now", "", `Summary as of ${now}.`, "<!-- phren:now:end -->", "",
    "## 2026-09-20", "", ...bullets, ""].join("\n");
const summary = (knows: string) =>
  ["# demo", "", "A sample project.", "", `<!-- phren:knows:start at=${knows} -->`, "## What phren knows", "", `- ${knows}`, "<!-- phren:knows:end -->", ""].join("\n");

const A = task("a1a1a1a1", "Ship the release notes");
const B = task("b2b2b2b2", "Fix the flaky sync test");
const C = task("c3c3c3c3", "Rename the settings screen");

/** A bare remote, a phone-side writer clone and the local store clone that syncs. */
function fixture(files: Record<string, string>) {
  const dir = makeTempDir("phren-conflict-");
  cleanups.push(dir.cleanup);
  const remote = path.join(dir.path, "remote.git");
  const writer = path.join(dir.path, "writer");
  const local = path.join(dir.path, "local");
  git(dir.path, "init", "--bare", "--initial-branch=main", remote);
  git(dir.path, "clone", remote, writer);
  for (const [rel, text] of Object.entries({ ".gitignore": ".runtime/\n.sessions/\n", ...files })) writeFile(path.join(writer, rel), text);
  for (const repo of [writer]) { git(repo, "config", "user.email", "sync@example.com"); git(repo, "config", "user.name", "Sync test"); }
  git(writer, "add", ".");
  git(writer, "commit", "-m", "initial");
  git(writer, "push", "-u", "origin", "main");
  git(dir.path, "clone", remote, local);
  git(local, "config", "user.email", "sync@example.com");
  git(local, "config", "user.name", "Sync test");
  const commit = (repo: string, changes: Record<string, string>, message: string) => {
    for (const [rel, text] of Object.entries(changes)) writeFile(path.join(repo, rel), text);
    git(repo, "add", ".");
    git(repo, "commit", "-m", message);
  };
  return { local, writer, commit };
}

describe("conflictStrategy", () => {
  it("classifies the store files sync can resolve", () => {
    expect(conflictStrategy("demo/tasks.md")).toBe("tasks");
    expect(conflictStrategy("demo/FINDINGS.md")).toBe("findings");
    expect(conflictStrategy(".config/task-archive/demo.md")).toBe("archive");
    expect(conflictStrategy("demo/reference/topics/sync.md")).toBe("topic");
    expect(conflictStrategy("demo/summary.md")).toBe("summary");
    expect(conflictStrategy("demo/settings.yaml")).toBeNull();
  });
});

describe("store sync conflict resolution with two clones and a bare remote", () => {
  it("merges tasks.md by task id and takes the incoming generated blocks", async () => {
    const D = task("d4d4d4d4", "Add the sync doctor check");
    const E = task("e5e5e5e5", "Document apns.json");
    const { local, writer, commit } = fixture({
      "demo/tasks.md": tasks([A, B, C]),
      "demo/reference/topics/sync.md": topic("2026-09-20T00:00:00Z", ["- Base bullet"]),
      "demo/summary.md": summary("2026-09-20"),
    });
    // Local: completes B, adds D, edits A, removes nothing; regenerates both blocks and adds a topic bullet.
    commit(local, {
      "demo/tasks.md": tasks([task("a1a1a1a1", "Ship the release notes (local)"), C, D], [task("b2b2b2b2", "Fix the flaky sync test", true)]),
      "demo/reference/topics/sync.md": topic("2026-09-21T00:00:00Z", ["- Base bullet", "- Local bullet"]),
      "demo/summary.md": summary("2026-09-21 local"),
    }, "local work");
    // Remote: edits A and B, removes C, adds E; regenerates both blocks.
    commit(writer, {
      "demo/tasks.md": tasks([task("a1a1a1a1", "Ship the release notes (remote)"), task("b2b2b2b2", "Fix the flaky sync test on Linux"), E]),
      "demo/reference/topics/sync.md": topic("2026-09-22T00:00:00Z", ["- Base bullet"]),
      "demo/summary.md": summary("2026-09-22 remote"),
    }, "remote work");
    git(writer, "push");

    const result = await pullAtSessionStart(local);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("resolved conflicts in");
    expect(read(local, "demo/tasks.md")).toBe(tasks(
      [task("a1a1a1a1", "Ship the release notes (remote)"), D, E],
      [task("b2b2b2b2", "Fix the flaky sync test", true)],
    ));
    expect(read(local, "demo/reference/topics/sync.md")).toBe(topic("2026-09-22T00:00:00Z", ["- Base bullet", "- Local bullet"]));
    expect(read(local, "demo/summary.md")).toBe(summary("2026-09-22 remote"));
    expect(git(local, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(local, ".git", "MERGE_HEAD"))).toBe(false);

    // The background sync's push-conflict recovery path uses the same merge and can now push.
    const recovered = await recoverPushConflict(local);
    expect(recovered.ok).toBe(true);
    git(writer, "pull");
    expect(read(writer, "demo/tasks.md")).toBe(read(local, "demo/tasks.md"));
  });

  it("aborts on any other conflicted file and logs every conflicted path", async () => {
    const { local, writer, commit } = fixture({ "demo/tasks.md": tasks([A, B]), "demo/notes.md": "base\n" });
    commit(local, { "demo/tasks.md": tasks([task("a1a1a1a1", "Ship it (local)"), B]), "demo/notes.md": "local\n" }, "local");
    const localHead = git(local, "rev-parse", "HEAD");
    commit(writer, { "demo/tasks.md": tasks([task("a1a1a1a1", "Ship it (remote)"), B]), "demo/notes.md": "remote\n" }, "remote");
    git(writer, "push");

    const result = await pullAtSessionStart(local);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("demo/notes.md");
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(local, ".git", "MERGE_HEAD"))).toBe(false);
    const log = fs.readFileSync(runtimeFile(local, "background-sync.log"), "utf8");
    expect(log).toMatch(/session-start-pull: failed Merge aborted; manual resolution is required for: .*demo\/notes\.md/);
    expect(log).toContain("(ahead 1, behind 1)");
  });
});
