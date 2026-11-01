import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { claimedPaths, ToolChanges } from "./changes.js";
import { TranscriptReader } from "./transcripts.js";

// /tmp keeps POSIX paths short; Windows has no /tmp.
const scratchRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const exec = promisify(execFile);
let home: string, repo: string, changes: ToolChanges;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(scratchRoot, "phren-claims-")));
  vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge")); vi.stubEnv("PHREN_PATH", path.join(home, "store"));
  repo = path.join(home, "repo");
  const git = (...args: string[]) => exec("git", ["-c", "user.name=sam", "-c", "user.email=sam@example.com", "-C", repo, ...args]);
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await git("add", "."); await git("commit", "-qm", "start");
  changes = new ToolChanges({ budgetMs: 10_000 });
});
afterEach(async () => { await changes.close(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

const files = async (conversation: string, id: string) => (await changes.view(conversation).changes(id))?.map(file => file.path) ?? [];

it("keeps another agent's edit out of a shell call that ran at the same time", async () => {
  // The conductor starts a read-only grep; meanwhile another agent writes a file.
  await changes.before("claude:conductor", "grep", repo, "grep -rn Menu .");
  await changes.before("claude:worker", "write", repo, "", { file_path: path.join(repo, "SessionWebServersView.swift") });
  await writeFile(path.join(repo, "SessionWebServersView.swift"), "struct View {}\n");
  await changes.after("claude:worker", "write");
  await changes.after("claude:conductor", "grep");
  expect(await files("claude:conductor", "grep")).toEqual([]);
  expect(await files("claude:worker", "write")).toEqual(["SessionWebServersView.swift"]);
});

it("credits each agent only with its own file when both work in one repository", async () => {
  await changes.before("codex:a", "sh", repo, "npm run format");
  await changes.before("claude:b", "edit", repo, "", { file_path: "b.txt" });
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await writeFile(path.join(repo, "b.txt"), "b\n");
  await changes.after("claude:b", "edit");
  await changes.after("codex:a", "sh");
  expect(await files("codex:a", "sh")).toEqual(["a.txt"]);
  expect(await files("claude:b", "edit")).toEqual(["b.txt"]);
});

// Review of #283: a PreToolUse callback that gave up lets the tool run while
// its snapshot is still read; that call shows no diff rather than a wrong one.
it("shows no diff for a call whose before-snapshot was not taken before the tool ran", async () => {
  const taking = changes.before("codex:a", "late", repo, "npm run format");
  // PostToolUse arrives while the snapshot is still being read: the tool already ran.
  await vi.waitFor(() => expect(changes.view("codex:a").pending("late")).toBe(true), { interval: 1 });
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await changes.after("codex:a", "late");
  expect(changes.view("codex:a").pending("late")).toBe(false);
  await taking;
  expect(await files("codex:a", "late")).toEqual([]);
  expect(changes.view("codex:a").pending("late")).toBe(false);
  // A snapshot finished after its callback was abandoned is dropped too.
  await changes.before("codex:a", "abandoned", repo, "npm run format");
  changes.drop("codex:a", "abandoned");
  await writeFile(path.join(repo, "b.txt"), "b\n");
  await changes.after("codex:a", "abandoned");
  expect(await files("codex:a", "abandoned")).toEqual([]);
  // An ordinary call still shows its diff.
  await changes.before("codex:a", "kept", repo, "npm run format");
  await writeFile(path.join(repo, "c.txt"), "c\n");
  await changes.after("codex:a", "kept");
  expect(await files("codex:a", "kept")).toEqual(["c.txt"]);
});

it("claims only structured paths, never words of a command line", () => {
  expect(claimedPaths({ command: "cat /etc/hosts > out.txt" }, "/work")).toEqual([]);
  expect(claimedPaths({ file_path: "src/a.ts" }, "/work")).toEqual([path.resolve("/work", "src/a.ts")]);
  expect(claimedPaths({ patch: "*** Begin Patch\n*** Update File: b.ts\n*** End Patch" }, "/work")).toEqual([path.resolve("/work", "b.ts")]);
  expect(claimedPaths({ path: "~/notes.md" }, "/work", "/home/sam")).toEqual([path.join("/home/sam", "notes.md")]);
});


it("sees a same-size rewrite made in the instant the index last read the file", async () => {
  // The file and the index share one timestamp, and ctime is not trusted, so
  // only Git's racy-entry content check can tell the rewrite apart.
  const readme = path.join(repo, "README.md"), at = Math.floor(Date.now() / 1000) - 100;
  await exec("git", ["-C", repo, "config", "core.trustctime", "false"]);
  await utimes(readme, at, at);
  await exec("git", ["-C", repo, "status", "--porcelain"]);
  await utimes(path.join(repo, ".git/index"), at + 0.5, at + 0.5);
  await changes.before("codex:a", "rewrite", repo, "sed -i s/h/j/ README.md");
  await writeFile(readme, "jello\n"); await utimes(readme, at, at);
  await changes.after("codex:a", "rewrite");
  expect(await files("codex:a", "rewrite")).toEqual(["README.md"]);
});

it("records an edited, a new untracked and a deleted file in one shell call", async () => {
  await writeFile(path.join(repo, "gone.txt"), "bye\n");
  await exec("git", ["-C", repo, "add", "gone.txt"]);
  await exec("git", ["-c", "user.name=sam", "-c", "user.email=sam@example.com", "-C", repo, "commit", "-qm", "gone"]);
  await changes.before("codex:a", "sh", repo, "./script.sh");
  await writeFile(path.join(repo, "README.md"), "hello again\n");
  await writeFile(path.join(repo, "new.txt"), "new\n");
  await rm(path.join(repo, "gone.txt"));
  await changes.after("codex:a", "sh");
  const found = (await changes.view("codex:a").changes("sh"))?.map(file => [file.path, file.status]);
  expect(found).toEqual([["README.md", "M"], ["gone.txt", "D"], ["new.txt", "A"]]);
});

it.each(["corrupt index", "missing Git"])("reports a failed before-read on one Shell card until the repository recovers (%s)", async cause => {
  const index = path.join(repo, ".git/index"), original = await readFile(index), originalPath = process.env.PATH ?? "";
  const breakCapture = async () => {
    if (cause === "corrupt index") await writeFile(index, "corrupt index");
    else vi.stubEnv("PATH", path.join(home, "no-executables"));
  };
  await breakCapture();
  await changes.before("claude:a", "broken-before", repo, "ls");
  expect(changes.view("claude:a").pending("broken-before")).toBe(false);
  const transcript = path.join(home, "claude.jsonl");
  const output = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "broken-before", content: "README.md" }] } };
  await writeFile(transcript, JSON.stringify(output) + "\n");
  const page = await new TranscriptReader(transcript, "claude", undefined, changes.view("claude:a")).read();
  expect(page.entries.map(entry => entry.raw.message)).toEqual([output.message]);
  expect(page.entries[0].raw.phren_change_errors).toMatchObject({ "broken-before": { code: "git-capture-failed" } });
  expect(page.entries[0].raw.phren_changes).toBeUndefined();

  await changes.before("claude:b", "broken-again", repo, "ls");
  await expect(changes.view("claude:b").changes("broken-again")).resolves.toBeUndefined();

  await writeFile(index, original);
  vi.stubEnv("PATH", originalPath);
  await changes.before("claude:b", "recovered", repo, "format");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await changes.after("claude:b", "recovered");
  expect(await files("claude:b", "recovered")).toEqual(["a.txt"]);

  await breakCapture();
  // Refresh discovery too: a missing Git executable fails before roots are
  // collected, but must still reset suppression on this repository's success.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
  try { await changes.before("claude:a", "broken-after-recovery", repo, "ls"); }
  finally { clock.mockRestore(); }
  await expect(changes.view("claude:a").changes("broken-after-recovery")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
});

it("reports a repository failure once across conversations and reports again after recovery", async () => {
  const index = path.join(repo, ".git/index"), original = await readFile(index);
  await changes.before("codex:a", "broken", repo, "format");
  await changes.before("codex:a", "broken-again", repo, "format");
  await changes.before("codex:b", "broken", repo, "format");
  await writeFile(path.join(repo, ".git/index"), "corrupt index");
  await expect(changes.after("codex:a", "broken")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
  await expect(changes.view("codex:a").changes("broken")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
  // The same breakage on a later call of that conversation is not repeated on its row.
  await changes.after("codex:a", "broken-again");
  await expect(changes.view("codex:a").changes("broken-again")).resolves.toBeUndefined();
  // The repository failure is already reported, including for other sessions.
  await expect(changes.after("codex:b", "broken")).resolves.toBeUndefined();
  await expect(changes.view("codex:b").changes("broken")).resolves.toBeUndefined();

  await writeFile(index, original);
  await changes.before("codex:b", "recovered", repo, "format");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await changes.after("codex:b", "recovered");
  expect(await files("codex:b", "recovered")).toEqual(["a.txt"]);

  // A successful capture clears only this repository's suppression mark.
  await changes.before("codex:a", "broken-after-recovery", repo, "format");
  await writeFile(index, "corrupt index");
  await expect(changes.after("codex:a", "broken-after-recovery")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
});

it("keeps a broken repository suppressed even when a healthy checkout and a shared store are captured with it", async () => {
  const healthy = path.join(home, "healthy");
  const git = (...args: string[]) => exec("git", ["-c", "user.name=sam", "-c", "user.email=sam@example.com", "-C", healthy, ...args]);
  await exec("git", ["init", "-q", "-b", "main", healthy]);
  await writeFile(path.join(healthy, "README.md"), "hello\n");
  await git("add", "."); await git("commit", "-qm", "start");

  // The shared store is a Git checkout too, so every capture below takes it
  // alongside the working repository.
  const store = path.join(home, "store");
  const storeGit = (...args: string[]) => exec("git", ["-c", "user.name=sam", "-c", "user.email=sam@example.com", "-C", store, ...args]);
  await exec("git", ["init", "-q", "-b", "main", store]);
  await writeFile(path.join(store, "AGENTS.md"), "store\n");
  await storeGit("add", "."); await storeGit("commit", "-qm", "start");

  // The broken checkout captures its start state, then its index is corrupted.
  await changes.before("codex:a", "broken-1", repo, "format");
  await writeFile(path.join(repo, ".git/index"), "corrupt index");
  await expect(changes.after("codex:a", "broken-1")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });

  // A healthy checkout captures successfully (with the shared store) and must
  // not clear the broken repository's mark.
  await changes.before("codex:a", "healthy", healthy, "format");
  await writeFile(path.join(healthy, "a.txt"), "a\n");
  await expect(changes.after("codex:a", "healthy")).resolves.toBeUndefined();

  // The broken checkout's error is not shown again, even though the store was
  // captured and cleared by the healthy call.
  await rm(path.join(repo, ".git/index"));
  await exec("git", ["-C", repo, "reset", "-q"]);
  await changes.before("codex:a", "broken-2", repo, "format");
  await writeFile(path.join(repo, ".git/index"), "corrupt index");
  await expect(changes.after("codex:a", "broken-2")).resolves.toBeUndefined();
  await expect(changes.view("codex:a").changes("broken-2")).resolves.toBeUndefined();
});

it("reports the capture file cap instead of returning an apparently complete subset", async () => {
  await changes.close();
  changes = new ToolChanges({ budgetMs: 60_000 });
  await changes.before("codex:a", "many", repo, "generate");
  await Promise.all(Array.from({ length: 41 }, (_, i) => writeFile(path.join(repo, `generated-${i}.txt`), "line\n")));
  await expect(changes.after("codex:a", "many")).rejects.toMatchObject({ status: 413, details: { code: "git-output-limit" } });
  await expect(changes.view("codex:a").changes("many")).rejects.toMatchObject({ details: { code: "git-output-limit" } });
}, process.platform === "win32" ? 90_000 : 30_000);
