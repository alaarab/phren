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
  changes = new ToolChanges();
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

it("still credits a shell call with the files it changed itself", async () => {
  await changes.before("claude:conductor", "echo", repo, "echo hi > notes.txt");
  await writeFile(path.join(repo, "notes.txt"), "hi\n");
  await changes.after("claude:conductor", "echo");
  expect(await files("claude:conductor", "echo")).toEqual(["notes.txt"]);
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

it("claims only structured paths, never words of a command line", () => {
  expect(claimedPaths({ command: "cat /etc/hosts > out.txt" }, "/work")).toEqual([]);
  expect(claimedPaths({ file_path: "src/a.ts" }, "/work")).toEqual(["/work/src/a.ts"]);
  expect(claimedPaths({ patch: "*** Begin Patch\n*** Update File: b.ts\n*** End Patch" }, "/work")).toEqual(["/work/b.ts"]);
  expect(claimedPaths({ path: "~/notes.md" }, "/work", "/home/sam")).toEqual(["/home/sam/notes.md"]);
});
