import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { request, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "", terminal_id: "term-checkpoint", agent_status: "idle" }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: vi.fn(async () => ({ ...pane })), snapshot: vi.fn(), rpc: vi.fn() }));
import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { snapshot, rpc, validateTarget } from "./herdr.js";
import { checkpointBoundary, type CheckpointRow } from "./checkpoints.js";
import { claudePromptEntryId } from "./prompt-identity.js";
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
afterEach(async () => { await list().catch(() => {}); vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
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
const capture = async (event = "UserPromptSubmit", turn = 1) => {
  checkpointBoundary(pane.foreground_cwd, target, event, turn, "Fix the file");
  await list(); // The public route waits for background capture.
};

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

// Retention cases run 50 real Git snapshots; they assert history, not latency.
it("bounds conversation history and deletes pruned refs", async () => {
  const { worker, git } = await fixture();
  await capture(); const first = (await list()).checkpoints[0].id, limit = (await list()).limit;
  for (let i = 0; i < limit + 1; i++) { await writeFile(path.join(worker, "file.txt"), `turn ${i}`); await capture("Stop", i + 2); }
  const history = await list(); expect(history.checkpoints).toHaveLength(limit); expect(history.checkpoints.some(row => row.id === first)).toBe(false);
  expect((await git(worker, "for-each-ref", "--format=%(refname)", "refs/phren/checkpoints/")).trim().split("\n")).toHaveLength(limit);
  await expect(preview(first)).rejects.toMatchObject({ status: 404 });
}, 120_000);

async function callbacks(worker: string) {
  vi.mocked(snapshot).mockResolvedValue({ panes: [{ ...pane, pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: "claude" }] });
  vi.mocked(rpc).mockImplementation(async (_server, method) => {
    if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
    throw new Error(`Unexpected RPC ${method}`);
  });
  const post = (event: string, prompt = "Callback prompt", callbackTarget = target, extra: Record<string, unknown> = {}) => new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let body = ""; res.on("data", bytes => { body += bytes; }); res.on("end", () => resolve(body));
    });
    req.on("error", reject); req.end(JSON.stringify({ target: callbackTarget, event, cwd: worker, prompt, ...extra }));
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
    await list();
    await writeFile(path.join(worker, "file.txt"), "stopped edit");
    expect(await post("Stop")).toBe("{}");
    expect((await list()).checkpoints[0]).toMatchObject({ boundary: "stop", prompt: "Second callback prompt", turn: first.turn + 1, filesChanged: 1 });
  } finally { close(); }
});

it("records a failed capture in list and continues capturing the conversation", async () => {
  const { worker } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === path.join(worker, "file.txt")) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return actual.lstat(...args);
  }) as typeof lstat);
  try {
    checkpointBoundary(worker, target, "UserPromptSubmit", 1, "first", "claude:prompt:failed");
    expect(await list()).toMatchObject({ checkpoints: [], skippedCaptures: [
      { turn: 1, boundary: "prompt", promptEntryId: "claude:prompt:failed", reason: "checkpoint-failed" },
    ] });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("checkpoint-failed"));
    vi.mocked(lstat).mockImplementation(actual.lstat);
    checkpointBoundary(worker, target, "UserPromptSubmit", 2, "second", "claude:prompt:after-failure");
    expect((await list()).checkpoints).toMatchObject([{ turn: 2, promptEntryId: "claude:prompt:after-failure" }]);
  } finally { vi.mocked(lstat).mockImplementation(actual.lstat); warning.mockRestore(); }
});

// This fixture posts through a Unix-domain callback socket.
it.skipIf(process.platform === "win32")("acknowledges callbacks while capture is blocked and serializes queued boundaries before list", async () => {
  const { worker } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let unblock!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
    const info = await actual.lstat(...args);
    if (String(args[0]) === path.join(worker, "file.txt")) { entered(); await blocked; }
    return info;
  }) as typeof lstat);
  const { post, close } = await callbacks(worker);
  const firstAt = new Date(Date.now() + 60_000).toISOString(), secondAt = new Date(Date.now() + 120_000).toISOString();
  let answer: Awaited<ReturnType<typeof list>> | undefined;
  try {
    let acknowledged = false;
    const sent = post("UserPromptSubmit", "first", target, { promptEntryId: "claude:prompt:slow-first" }).then(value => { acknowledged = true; return value; });
    await started;
    await vi.waitFor(() => expect(acknowledged).toBe(true));
    expect(await sent).toBe("{}");
    // Facts are copied on admission while the first snapshot is still blocked.
    checkpointBoundary(worker, target, "UserPromptSubmit", 2, "second", "claude:prompt:slow-second", firstAt);
    checkpointBoundary(worker, target, "UserPromptSubmit", 3, "third", "claude:prompt:slow-third", secondAt);
    const reading = list().then(value => { answer = value; return value; });
    await new Promise(resolve => setImmediate(resolve));
    expect(answer).toBeUndefined();
    unblock();
    const history = await reading;
    expect(history.checkpoints.map(row => [row.turn, row.promptEntryId])).toEqual([
      [3, "claude:prompt:slow-third"], [2, "claude:prompt:slow-second"], [1, "claude:prompt:slow-first"],
    ]);
    expect(history.checkpoints.find(row => row.turn === 2)).toMatchObject({ at: firstAt, prompt: "second" });
    expect(history.checkpoints.find(row => row.turn === 3)).toMatchObject({ at: secondAt, prompt: "third" });
  } finally { unblock(); await list().catch(() => {}); vi.mocked(lstat).mockImplementation(actual.lstat); close(); }
});

it.skipIf(process.platform === "win32")("selects identical prompts by native id, never by text or time", async () => {
  const { worker } = await fixture();
  const { post, close } = await callbacks(worker);
  const p1 = claudePromptEntryId(["fixture", "callback", "one"].join("-"))!;
  const p2 = claudePromptEntryId(["fixture", "callback", "two"].join("-"))!;
  try {
    await writeFile(path.join(worker, "file.txt"), "state one\n");
    expect(await post("UserPromptSubmit", "continue", target, { promptEntryId: p1 })).toBe("{}");
    const first = (await list()).checkpoints.find(row => row.promptEntryId === p1)!;
    expect(first).toMatchObject({ boundary: "prompt", prompt: "continue", promptEntryId: p1 });
    await writeFile(path.join(worker, "file.txt"), "state two\n");
    expect(await post("UserPromptSubmit", "continue", target, { promptEntryId: p2 })).toBe("{}");
    const second = (await list()).checkpoints.find(row => row.promptEntryId === p2)!;
    expect(second.id).not.toBe(first.id);
    // The current tree is P2's state: P1's snapshot differs, P2's does not.
    expect((await preview(first.id)).files).toEqual([{ path: "file.txt", status: "M" }]);
    expect((await preview(second.id)).files).toEqual([]);
  } finally { close(); }
});

it.skipIf(process.platform === "win32")("creates a distinct prompt checkpoint for each authoritative id even when files are unchanged", async () => {
  const { worker } = await fixture();
  const { post, close } = await callbacks(worker);
  const p1 = claudePromptEntryId(["fixture", "same-tree", "one"].join("-"))!;
  const p2 = claudePromptEntryId(["fixture", "same-tree", "two"].join("-"))!;
  try {
    expect(await post("UserPromptSubmit", "continue", target, { promptEntryId: p1 })).toBe("{}");
    const first = (await list()).checkpoints.find(row => row.promptEntryId === p1)!;
    expect(await post("UserPromptSubmit", "continue", target, { promptEntryId: p2 })).toBe("{}");
    const rows = (await list()).checkpoints;
    const second = rows.find(row => row.promptEntryId === p2)!;
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ boundary: "prompt", filesChanged: 0, promptEntryId: p2 });
    // The earlier row is neither relabelled nor rewritten.
    expect(rows.find(row => row.id === first.id)).toEqual(first);
    expect(rows.filter(row => row.promptEntryId === p1)).toHaveLength(1);
  } finally { close(); }
});

it("prunes a prompt's checkpoint without reassigning its identity", async () => {
  const { worker } = await fixture();
  const p1 = claudePromptEntryId(["fixture", "prune", "one"].join("-"))!, p2 = claudePromptEntryId(["fixture", "prune", "two"].join("-"))!;
  checkpointBoundary(worker, target, "UserPromptSubmit", 1, "continue", p1);
  const first = (await list()).checkpoints.find(row => row.promptEntryId === p1)!;
  checkpointBoundary(worker, target, "UserPromptSubmit", 2, "continue", p2);
  const limit = (await list()).limit;
  for (let i = 0; i < limit - 1; i++) checkpointBoundary(worker, target, "UserPromptSubmit", i + 3, "continue", `claude:prompt:extra-${i}`);
  const history = await list();
  expect(history.checkpoints).toHaveLength(limit);
  expect(history.checkpoints.some(row => row.promptEntryId === p1)).toBe(false);
  expect(history.checkpoints.filter(row => row.promptEntryId === p2)).toHaveLength(1);
  await expect(preview(first.id)).rejects.toMatchObject({ status: 404, details: { code: "checkpoint-not-found" } });
}, 120_000);

it("lists a legacy checkpoint row that predates prompt identities", async () => {
  const { worker, git } = await fixture();
  await capture();
  const ref = (await git(worker, "for-each-ref", "--format=%(refname)", "refs/phren/checkpoints/")).trim().split("\n")[0];
  const tree = (await git(worker, "rev-parse", `${ref}^{tree}`)).trim();
  const legacy = { id: "33333333-3333-4333-8333-333333333333", turn: 1, boundary: "prompt", at: new Date().toISOString(),
    prompt: "legacy prompt", filesChanged: 0 };
  const commit = (await git(worker, "-c", "user.name=Phren checkpoint", "-c", "user.email=checkpoint@phren.local",
    "commit-tree", tree, "-m", JSON.stringify(legacy))).trim();
  await git(worker, "update-ref", ref, commit);
  const row = (await list()).checkpoints.find(value => value.id === legacy.id)!;
  expect(row).toMatchObject(legacy);
  expect(row).not.toHaveProperty("promptEntryId");
});

it("takes no checkpoints from activity-only harness events", async () => {
  const { worker } = await fixture();
  checkpointBoundary(worker, { ...target, source: "opencode" }, "chat.message", 1, "hello", "claude:prompt:not-used");
  expect((await list()).checkpoints).toEqual([]);
});

it.skipIf(process.platform === "win32")("keeps the prompt identity and checkpoint UUID across replacement Hook processes", async () => {
  const { worker } = await fixture();
  const p1 = claudePromptEntryId(["fixture", "restart", "one"].join("-"))!;
  const session = target.session, home = path.join(base, "claude-home");
  const project = path.join(home, "projects", "test"), transcript = path.join(project, `${session}.jsonl`);
  await mkdir(path.join(base, "store"), { recursive: true });
  await mkdir(project, { recursive: true });
  const transcriptRows = [
    { type: "user", uuid: "uuid-restart", timestamp: "2026-01-02T03:04:05.000Z", sessionId: session, promptId: ["fixture", "restart", "one"].join("-"),
      message: { role: "user", content: "continue" } },
    { type: "assistant", uuid: "uuid-restart-answer", parentUuid: "uuid-restart", timestamp: "2026-01-02T03:04:06.000Z", sessionId: session,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
  ];
  await writeFile(transcript, transcriptRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  // Each run starts and closes a real AgentHooks process with its callback
  // socket and the Hook's checkpoint/history routes, under a fake terminal.
  const script = path.join(base, "restart-hook.mts");
  const sources = {
    agentHooks: new URL("./agent-hooks.ts", import.meta.url).href,
    terminal: new URL("./terminal.ts", import.meta.url).href,
    stores: new URL("./agent-hook-stores.ts", import.meta.url).href,
    routes: new URL("./server-routes.ts", import.meta.url).href,
  };
  await writeFile(script, [
    `import { createServer, request } from "node:http";`,
    `import { AgentHooks } from ${JSON.stringify(sources.agentHooks)};`,
    `import { setTerminalProvider } from ${JSON.stringify(sources.terminal)};`,
    `import { localSocket } from ${JSON.stringify(sources.stores)};`,
    `import { createRouteHandler } from ${JSON.stringify(sources.routes)};`,
    `const [mode, worker, targetJson, promptEntryId, session] = process.argv.slice(2);`,
    `const target = JSON.parse(targetJson);`,
    `const pane = { pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: target.source,`,
    `  agent_status: "idle", terminal_id: "term-restart", cwd: worker, foreground_cwd: worker,`,
    `  agent_session: { kind: "id", agent: target.source, value: target.session } };`,
    `const provider = { kind: "fake", ping: async () => {}, snapshot: async () => ({ panes: [pane] }),`,
    `  listPanes: async () => [], processes: async () => ({ foregroundPids: [process.pid] }), readScreen: async () => "",`,
    `  sendKeys: async () => {}, prompt: async () => {}, create: async () => ({}), startAgent: async () => {},`,
    `  focusPane: async () => {}, closePane: async () => {}, renamePane: async () => {}, groupAction: async () => {} };`,
    `const restore = setTerminalProvider(provider);`,
    `const hooks = new AgentHooks();`,
    `await hooks.start();`,
    `let result;`,
    `try {`,
    `  const handler = createRouteHandler({ version: "test",`,
    `    modules: { has: () => true, store: "store", profile: "profile", modules: [], generation: "test" },`,
    `    info: { computer: { id: "computer", name: "computer" }, modules: {}, store: "store", profile: "profile", generation: "test" },`,
    `    computerID: "33333333-3333-4333-8333-333333333333", agentHooks: hooks, streams: {},`,
    `    journal: { recent: async () => [], record: async () => {} },`,
    `    tabActivity: { observe: async () => ({ generation: "test", stamps: new Map() }) }, contextUsage: { read: async () => ({}) } });`,
    `  const http = createServer((req, res) => { void handler(req, res); });`,
    `  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });`,
    `  const base = \`http://127.0.0.1:\${http.address().port}\`;`,
    `  const list = async () => await (await fetch(\`\${base}/v1/git/checkpoints\`, { method: "POST",`,
    `    headers: { "content-type": "application/json" }, body: JSON.stringify({ target, expectedRepository: worker }) })).json();`,
    `  let capture;`,
    `  if (mode === "capture") capture = await new Promise((resolve, reject) => {`,
    `    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {`,
    `      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));`,
    `    });`,
    `    req.on("error", reject);`,
    `    req.end(JSON.stringify({ target, event: "UserPromptSubmit", cwd: worker, prompt: "continue", promptEntryId }));`,
    `  });`,
    `  const checkpoints = await list();`,
    `  const query = new URLSearchParams({ historical: "1", source: "claude", session, beforeLine: "2" });`,
    `  const history = await (await fetch(\`\${base}/v1/transcripts/history?\${query}\`)).json();`,
    `  result = { capture, list: checkpoints, history };`,
    `  http.closeAllConnections(); await new Promise(resolve => http.close(resolve));`,
    `} finally { hooks.close(); restore(); }`,
    `process.stdout.write(JSON.stringify(result), () => process.exit(0));`,
  ].join("\n"));
  const runHook = async (mode: "capture" | "read") => {
    const { stdout } = await exec(process.execPath, ["--import", "tsx", script, mode, worker, JSON.stringify(target), p1, session],
      { cwd: process.cwd(), env: { ...process.env, CLAUDE_CONFIG_DIR: home, PHREN_PATH: path.join(base, "store") } });
    return JSON.parse(stdout) as { capture?: { status: number }; list: { checkpoints: CheckpointRow[] };
      history: { entries: { line: number; promptEntryId?: string }[] } };
  };
  const captured = await runHook("capture");
  expect(captured.capture?.status).toBe(200);
  const before = captured.list.checkpoints.find(row => row.promptEntryId === p1)!;
  expect(before).toBeDefined();
  const after = await runHook("read");
  expect(after.list.checkpoints.find(row => row.promptEntryId === p1)).toMatchObject({ id: before.id, promptEntryId: p1 });
  expect(after.history.entries.find(entry => entry.line === 0)).toMatchObject({ promptEntryId: p1 });
}, 30_000);

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
