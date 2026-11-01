import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Terminal state is scripted per server so the route's own discovery across
// servers is what the tests exercise.
const terminal = vi.hoisted(() => ({
  running: [] as { session: string }[],
  panes: {} as Record<string, Record<string, unknown>[]>,
  fail: false,
  discoveryFail: false,
}));
vi.mock("./herdr.js", async original => ({
  ...await original<object>(),
  servers: async () => terminal.running,
  serversStrict: async () => {
    if (terminal.discoveryFail) throw new Error("server discovery failed");
    return terminal.running;
  },
  snapshot: async (server: string) => {
    if (terminal.fail) throw new Error("terminal unavailable");
    return { panes: terminal.panes[server] ?? [] };
  },
}));
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { worktreeId } from "./git-worktrees.js";

const execFileAsync = promisify(execFile);

describe("worktree removal routes", () => {
  const created: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    terminal.running = []; terminal.panes = {}; terminal.fail = false; terminal.discoveryFail = false;
    for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function repository() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-remove-route-"))); created.push(base);
    const root = path.join(base, "repo"); await mkdir(root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    const beside = path.join(base, "repo-fanout");
    await git(root, "worktree", "add", "-q", "-b", "fanout/review", beside);
    return { root, beside };
  }

  const call = (route: string, body: Record<string, unknown>) => paneRoute({} as PaneRouteContext,
    new URL(`http://localhost${route}`), body, {} as ServerResponse);

  it("blocks removal for a live pane on another terminal server", async () => {
    const { root, beside } = await repository();
    terminal.running = [{ session: "one" }, { session: "two" }];
    terminal.panes = {
      one: [{ pane_id: "p1", cwd: root, foreground_cwd: root }],
      two: [{ pane_id: "p9", cwd: beside, foreground_cwd: beside, title: "Other server worker" }],
    };
    const preview = await call("/v1/git/worktrees/remove/preview", { server: "one", pane: "p1", worktree: worktreeId(beside) }) as
      { sessions: { pane: string; title: string }[]; removable: boolean; reason?: string };
    expect(preview).toMatchObject({
      removable: false,
      reason: "sessions-open",
      sessions: [{ pane: "p9", title: "Other server worker" }],
    });
  });

  it.each(["snapshot fails", "pane directory is missing"])("leaves the worktree intact when the session check is incomplete: %s", async failure => {
    const { root, beside } = await repository();
    terminal.running = [{ session: "one" }];
    terminal.panes = { one: [{ pane_id: "p1", cwd: root, foreground_cwd: root }] };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const preview = await call("/v1/git/worktrees/remove/preview", { server: "one", worktree: worktreeId(beside) }) as { token: string };
      terminal.fail = failure === "snapshot fails";
      if (!terminal.fail) terminal.panes.one.push({ pane_id: "p2" });
      await expect(call("/v1/git/worktrees/remove", { server: "one", worktree: worktreeId(beside), token: preview.token }))
        .rejects.toThrow(terminal.fail ? "terminal unavailable" : "Could not determine a live pane's directory.");
      expect((await stat(beside)).isDirectory()).toBe(true);
    } finally { cwd.mockRestore(); }
  });

  it("leaves the worktree intact when server discovery fails", async () => {
    const { root, beside } = await repository();
    terminal.running = [{ session: "one" }];
    terminal.panes = { one: [{ pane_id: "p1", cwd: root, foreground_cwd: root }] };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const preview = await call("/v1/git/worktrees/remove/preview", { server: "one", worktree: worktreeId(beside) }) as { token: string };
      terminal.discoveryFail = true;
      await expect(call("/v1/git/worktrees/remove", { server: "one", worktree: worktreeId(beside), token: preview.token }))
        .rejects.toThrow("server discovery failed");
      expect((await stat(beside)).isDirectory()).toBe(true);
    } finally { cwd.mockRestore(); }
  });

  it("checks the requested server even when discovery omits it", async () => {
    const { root, beside } = await repository();
    terminal.running = [];
    terminal.panes = { two: [{ pane_id: "p9", cwd: beside, foreground_cwd: beside, title: "Omitted server worker" }] };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const preview = await call("/v1/git/worktrees/remove/preview", { server: "two", worktree: worktreeId(beside) }) as
        { sessions: { pane: string; title: string }[]; removable: boolean; reason?: string };
      expect(preview).toMatchObject({
        removable: false,
        reason: "sessions-open",
        sessions: [{ pane: "p9", title: "Omitted server worker" }],
      });
    } finally { cwd.mockRestore(); }
  });
});
