import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { request, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "", terminal_id: "term-checkpoint", agent_status: "idle" }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: vi.fn(async () => ({ ...pane })), snapshot: vi.fn(), rpc: vi.fn() }));
import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { snapshot, rpc, validateTarget } from "./herdr.js";
import { checkpointBoundary, type CheckpointRow } from "./checkpoints.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
vi.mock("./schedule-watch.js", async original => ({ ...await original<object>(), readFinalTurn: vi.fn() }));
vi.mock("./transcripts.js", async original => ({ ...await original<object>(), childAgentTree: vi.fn() }));
import { readFinalTurn } from "./schedule-watch.js";
import { childAgentTree } from "./transcripts.js";
import { noteTurn } from "./turn-records.js";
import type { Target } from "./protocol.js";

const exec = promisify(execFile);
const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
let base: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".scratch"), { recursive: true });
  base = await realpath(await mkdtemp(path.join(process.cwd(), ".scratch/checkpoints-")));
  vi.stubEnv("PHREN_BRIDGE_HOME", base);
  pane.agent_status = "idle";
  vi.mocked(validateTarget).mockReset().mockImplementation(async () => ({ ...pane }));
  vi.mocked(readFinalTurn).mockReset().mockResolvedValue(undefined);
  vi.mocked(childAgentTree).mockReset().mockResolvedValue([]);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
async function fixture() {
  const root = path.join(base, "repo"), worker = path.join(base, "worker");
  const env = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args], { env })).stdout;
  await exec("git", ["init", "-q", "-b", "main", root], { env });
  await writeFile(path.join(root, "file.txt"), "base\n");
  await writeFile(path.join(root, ".gitignore"), "*.log\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");
  await git(root, "worktree", "add", "-qb", "feature", worker);
  pane.cwd = pane.foreground_cwd = worker;
  return { root, worker, git };
}
const call = (suffix = "", data: Record<string, unknown> = {}) => paneRoute({} as PaneRouteContext,
  new URL(`http://localhost/v1/git/checkpoints${suffix}`), { target, expectedRepository: pane.foreground_cwd, ...data }, {} as ServerResponse);
const list = async () => await call() as { state: string; checkpoints: CheckpointRow[]; limit: number };
const preview = async (id: string) => await call("/preview", { checkpointId: id }) as { token: string; files: { path: string; status: string }[] };
const restore = async (id: string, token: string) => await call("/restore", { checkpointId: id, token }) as { recoveryId: string };
const capture = (event = "UserPromptSubmit", turn = 1) => checkpointBoundary(pane.foreground_cwd, target, event, turn, "Fix the file");

it("takes no checkpoints in the main checkout and refuses preview/restore there", async () => {
  const { root, git } = await fixture(); pane.foreground_cwd = root;
  await capture();
  expect(await list()).toMatchObject({ state: "not-isolated", checkpoints: [] });
  for (const suffix of ["/preview", "/restore"]) await expect(call(suffix, { checkpointId: target.session, token: "unused" })).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-not-isolated" } });
  expect(await git(root, "for-each-ref", "refs/phren/checkpoints/")).toBe("");
});

it("captures untracked raw bytes, excludes ignored files, reuses unchanged trees and preserves index/HEAD/stash", async () => {
  const { root, worker, git } = await fixture();
  await writeFile(path.join(worker, "file.txt"), "stashed\n"); await git(worker, "stash", "push", "-qm", "owner stash");
  await writeFile(path.join(worker, "file.txt"), "staged\n"); await git(worker, "add", "file.txt");
  await writeFile(path.join(worker, "file.txt"), "unstaged\r\n");
  await writeFile(path.join(worker, ".gitattributes"), "*.txt text eol=lf\n");
  const binary = Buffer.from([0, 255, 128, 13, 10]); await writeFile(path.join(worker, "untracked.bin"), binary);
  await writeFile(path.join(worker, "secret.log"), "leave me");
  const unusual = process.platform === "win32" ? "odd-name.txt" : "é\tline\n.txt"; await writeFile(path.join(worker, unusual), "odd filename");
  // An inherited Git process must not redirect capture/restore to the main checkout.
  vi.stubEnv("GIT_DIR", path.join(root, ".git")); vi.stubEnv("GIT_WORK_TREE", root); vi.stubEnv("GIT_INDEX_FILE", path.join(root, ".git/index"));
  const indexPath = (await git(worker, "rev-parse", "--git-path", "index")).trim();
  const before = { index: await readFile(indexPath), head: await git(worker, "rev-parse", "HEAD"), branch: await git(worker, "symbolic-ref", "HEAD"), stash: await git(worker, "stash", "list") };
  await capture(); const first = (await list()).checkpoints[0]; expect(first.prompt).toBe("Fix the file");
  await capture("Stop"); expect((await list()).checkpoints).toEqual([first]);
  await writeFile(path.join(worker, "file.txt"), "later"); await rm(path.join(worker, "untracked.bin"));
  await rm(path.join(worker, unusual));
  const p = await preview(first.id); const restored = await restore(first.id, p.token);
  expect(restored.recoveryId).toBeTruthy();
  expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("unstaged\r\n");
  expect(await readFile(path.join(worker, "untracked.bin"))).toEqual(binary);
  expect(await readFile(path.join(worker, unusual), "utf8")).toBe("odd filename");
  expect(await readFile(path.join(worker, "secret.log"), "utf8")).toBe("leave me");
  expect(await readFile(indexPath)).toEqual(before.index);
  expect(await git(worker, "rev-parse", "HEAD")).toBe(before.head); expect(await git(worker, "symbolic-ref", "HEAD")).toBe(before.branch);
  expect(await git(worker, "stash", "list")).toBe(before.stash);
  const refs = (await git(worker, "for-each-ref", "--format=%(refname)", "refs/phren/checkpoints/")).trim().split("\n");
  expect(await git(worker, "ls-tree", "--name-only", refs[0])).not.toContain("secret.log");
});

it("previews added/modified/deleted paths, refuses stale or working restores, and undoes with the recovery id", async () => {
  const { worker } = await fixture();
  await writeFile(path.join(worker, "old.txt"), "old"); await capture(); const first = (await list()).checkpoints[0];
  await writeFile(path.join(worker, "file.txt"), "edited"); await rm(path.join(worker, "old.txt")); await writeFile(path.join(worker, "new.txt"), "new");
  const p = await preview(first.id);
  expect(p.files).toEqual([{ path: "file.txt", status: "M" }, { path: "new.txt", status: "D" }, { path: "old.txt", status: "A" }]);
  await writeFile(path.join(worker, "new.txt"), "newer");
  await expect(restore(first.id, p.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-stale" } });
  const fresh = await preview(first.id); pane.agent_status = "working";
  await expect(restore(first.id, fresh.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-working" } });
  pane.agent_status = "idle";
  await noteTurn(target.server, target.pane, { event: "UserPromptSubmit", terminal: pane.terminal_id, source: target.source, session: target.session });
  await expect(restore(first.id, fresh.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-working" } });
  await noteTurn(target.server, target.pane, { event: "Stop", terminal: pane.terminal_id, source: target.source, session: target.session });
  const result = await restore(first.id, fresh.token);
  expect(await readFile(path.join(worker, "old.txt"), "utf8")).toBe("old"); await expect(readFile(path.join(worker, "new.txt"))).rejects.toThrow();
  const undo = await preview(result.recoveryId); await restore(result.recoveryId, undo.token);
  expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("edited");
  expect(await readFile(path.join(worker, "new.txt"), "utf8")).toBe("newer"); await expect(readFile(path.join(worker, "old.txt"))).rejects.toThrow();
  await expect(call("/preview", { checkpointId: "../../.git" })).rejects.toThrow();
  await expect(call("/preview", { checkpointId: first.id, worktree: "a".repeat(32) })).rejects.toMatchObject({ status: 400 });
  const other = { ...target, session: "22222222-2222-4222-8222-222222222222" };
  await expect(call("/preview", { target: other, checkpointId: first.id })).rejects.toMatchObject({ status: 404 });
});

it.skipIf(process.platform === "win32")("restores file/directory/symlink transitions without following links or deleting ignored obstructions", async () => {
  const { worker } = await fixture();
  await mkdir(path.join(worker, "folder")); await writeFile(path.join(worker, "folder/item"), "inside");
  await writeFile(path.join(worker, "flat"), "flat"); await capture(); const id = (await list()).checkpoints[0].id;
  await rm(path.join(worker, "folder"), { recursive: true });
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "item"), "outside");
  await symlink(outside, path.join(worker, "folder"));
  await rm(path.join(worker, "flat")); await mkdir(path.join(worker, "flat")); await writeFile(path.join(worker, "flat/block.log"), "ignored");
  const blocked = await preview(id); await expect(restore(id, blocked.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-obstructed" } });
  expect(await readFile(path.join(outside, "item"), "utf8")).toBe("outside");
  await rm(path.join(worker, "flat/block.log"));
  const p = await preview(id); await restore(id, p.token);
  expect(await readFile(path.join(worker, "folder/item"), "utf8")).toBe("inside"); expect(await readFile(path.join(worker, "flat"), "utf8")).toBe("flat");
  expect(await readFile(path.join(outside, "item"), "utf8")).toBe("outside");
});

it("bounds conversation history and deletes pruned refs", async () => {
  const { worker, git } = await fixture();
  await capture(); const first = (await list()).checkpoints[0].id, limit = (await list()).limit;
  for (let i = 0; i < limit + 1; i++) { await writeFile(path.join(worker, "file.txt"), `turn ${i}`); await capture("Stop", i + 2); }
  const history = await list(); expect(history.checkpoints).toHaveLength(limit); expect(history.checkpoints.some(row => row.id === first)).toBe(false);
  expect((await git(worker, "for-each-ref", "--format=%(refname)", "refs/phren/checkpoints/")).trim().split("\n")).toHaveLength(limit);
  await expect(preview(first)).rejects.toMatchObject({ status: 404 });
}, 30_000);

async function callbacks(worker: string) {
  vi.mocked(snapshot).mockResolvedValue({ panes: [{ ...pane, pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: "claude" }] });
  vi.mocked(rpc).mockImplementation(async (_server, method) => {
    if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
    throw new Error(`Unexpected RPC ${method}`);
  });
  const post = (event: string, prompt = "Callback prompt", callbackTarget = target) => new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let body = ""; res.on("data", bytes => { body += bytes; }); res.on("end", () => resolve(body));
    });
    req.on("error", reject); req.end(JSON.stringify({ target: callbackTarget, event, cwd: worker, prompt }));
  });
  const hooks = new AgentHooks();
  try { await hooks.start(); } catch (error) { hooks.close(); throw error; }
  return { post, close: () => hooks.close() };
}

it.skipIf(process.platform === "win32")("captures prompt and Stop through the real agent callback socket", async () => {
  const { worker } = await fixture();
  const { post, close } = await callbacks(worker);
  try {
    expect(await post("UserPromptSubmit")).toBe("{}");
    const first = (await list()).checkpoints[0]; expect(first).toMatchObject({ boundary: "prompt", prompt: "Callback prompt" });
    expect(await post("UserPromptSubmit", "Second callback prompt")).toBe("{}");
    await writeFile(path.join(worker, "file.txt"), "stopped edit");
    expect(await post("Stop")).toBe("{}");
    expect((await list()).checkpoints[0]).toMatchObject({ boundary: "stop", prompt: "Second callback prompt", turn: first.turn + 1, filesChanged: 1 });
  } finally { close(); }
});

it.each([
  { session: "22222222-2222-4222-8222-222222222222" },
  { terminal: "previous-terminal" },
  { source: "codex" as const },
])("ignores a previous conversation or terminal's working record (%j)", async extra => {
  const { worker } = await fixture(); await capture(); const id = (await list()).checkpoints[0].id;
  await writeFile(path.join(worker, "file.txt"), "current edit");
  await noteTurn(target.server, target.pane, { event: "UserPromptSubmit", terminal: pane.terminal_id, source: target.source, session: target.session, ...extra });
  const p = await preview(id); await restore(id, p.token);
  expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("base\n");
});

it("reconciles finished background tasks and running children without another Stop", async () => {
  const { worker } = await fixture(); await capture(); const id = (await list()).checkpoints[0].id;
  await writeFile(path.join(worker, "file.txt"), "current edit");
  const stopped = Date.now();
  await noteTurn(target.server, target.pane, { event: "Stop", terminal: pane.terminal_id, source: target.source, session: target.session, background: 1, at: stopped });
  vi.mocked(readFinalTurn).mockResolvedValue({ completed: true, awaited: 1 });
  const p = await preview(id);
  await expect(restore(id, p.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-working" } });
  // The transcript records completion but leaves its old awaited count in the tail.
  vi.mocked(readFinalTurn).mockResolvedValue({ completed: true, awaited: 1, finishedTasks: [new Date(stopped + 1).toISOString()] });
  vi.mocked(childAgentTree).mockResolvedValue([{ state: "running", provider: "claude", children: [] }] as never);
  await expect(restore(id, p.token)).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-working" } });
  vi.mocked(childAgentTree).mockResolvedValue([{ state: "completed", provider: "claude", children: [] }] as never);
  await restore(id, p.token);
  expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("base\n");
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
it.skipIf(process.platform === "win32").each([
  { event: "UserPromptSubmit", session: target.session },
  { event: "UserPromptSubmit", session: "22222222-2222-4222-8222-222222222222" },
  ...["PreToolUse", "PostToolUse", "PreCompact", "PermissionRequest"].map(event => ({ event, session: target.session })),
])("refuses restore when an activity callback arrives during final child discovery ($event, $session)", async ({ event, session }) => {
  const { worker } = await fixture(); await capture(); const id = (await list()).checkpoints[0].id;
  await writeFile(path.join(worker, "file.txt"), "new turn files");
  await noteTurn(target.server, target.pane, { event: "Stop", terminal: pane.terminal_id, source: target.source, session: target.session });
  const p = await preview(id), finalRead = deferred(), releaseRead = deferred(), arrived = deferred(), releaseCallback = deferred();
  const { post, close } = await callbacks(worker);
  let discoveries = 0;
  vi.mocked(childAgentTree).mockImplementation(async () => {
    // The final guard has already read an idle pane and its own stopped turn.
    if (++discoveries === 2) { finalRead.resolve(); await releaseRead.promise; }
    return [];
  });
  let submitted: Promise<string> | undefined;
  try {
    const restoring = restore(id, p.token);
    // Attach the expectation before releasing either side, so rejection cannot become unhandled.
    const refused = expect(restoring).rejects.toMatchObject({ status: 409, details: { code: "checkpoint-working" } });
    await finalRead.promise;
    vi.mocked(rpc).mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") {
        arrived.resolve(); await releaseCallback.promise;
        return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    submitted = post(event, "New turn", { ...target, session });
    await arrived.promise;
    releaseRead.resolve();
    await refused;
    expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("new turn files");
  } finally {
    releaseRead.resolve(); releaseCallback.resolve();
    await submitted; close();
  }
});
