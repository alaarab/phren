import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
// /tmp keeps POSIX paths short; Windows has no /tmp.
const scratchRoot = process.platform === "win32" ? tmpdir() : "/tmp";
import { promisify } from "node:util";
import { claimedPaths, ToolChanges } from "./changes.js";

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


it("surfaces a failed post-tool Git read instead of recording a clean result", async () => {
  await changes.before("codex:a", "broken", repo, "format");
  await writeFile(path.join(repo, ".git/index"), "corrupt index");
  await expect(changes.after("codex:a", "broken")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
  await expect(changes.view("codex:a").changes("broken")).rejects.toMatchObject({ details: { code: "git-capture-failed" } });
});

it("reports the capture file cap instead of returning an apparently complete subset", async () => {
  await changes.close();
  changes = new ToolChanges({ budgetMs: 60_000 });
  await changes.before("codex:a", "many", repo, "generate");
  await Promise.all(Array.from({ length: 41 }, (_, i) => writeFile(path.join(repo, `generated-${i}.txt`), "line\n")));
  await expect(changes.after("codex:a", "many")).rejects.toMatchObject({ status: 413, details: { code: "git-output-limit" } });
  await expect(changes.view("codex:a").changes("many")).rejects.toMatchObject({ details: { code: "git-output-limit" } });
}, process.platform === "win32" ? 90_000 : 30_000);
