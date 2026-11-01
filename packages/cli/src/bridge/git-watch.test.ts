import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GitWatch, type GitWatchClient } from "./git-watch.js";

const execFileAsync = promisify(execFile);
const platform = process.platform === "linux" ? "linux" : "darwin";
const watcherCounts = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((...args: unknown[]) => {
      const watcher = (actual.watch as unknown as (...args: unknown[]) => import("node:fs").FSWatcher)(...args);
      watcherCounts.opened++;
      const close = watcher.close.bind(watcher);
      watcher.close = () => { watcherCounts.closed++; close(); };
      return watcher;
    }) as unknown as typeof actual.watch,
  };
});

class FakeClient extends EventEmitter implements GitWatchClient {
  readyState: number = WebSocket.OPEN;
  frames: Array<Record<string, unknown>> = [];
  closed?: number;

  send(data: string) { this.frames.push(JSON.parse(data)); }

  close(code?: number) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function changed(client: FakeClient): number {
  return client.frames.filter(frame => frame.type === "changed").length;
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error("Timed out waiting for a watched frame.");
  }, { timeout, interval: 20 });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("live Git changes", () => {
  const created: string[] = [];
  beforeEach(() => { watcherCounts.opened = 0; watcherCounts.closed = 0; });
  afterEach(async () => {
    vi.useRealTimers();
    for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function repository(): Promise<{ root: string; git: (...args: string[]) => Promise<string> }> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "phren-git-watch-")));
    created.push(root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", root, ...args], { env })).stdout;
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "start");
    return { root, git };
  }

  it("sends one changed frame after the debounce when a tracked file is edited", async () => {
    const { root } = await repository();
    const client = new FakeClient();
    const service = new GitWatch({ platform, pollMs: 50 });
    try {
      await service.watch(client, root);
      await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
      await waitFor(() => changed(client) >= 1);
      await sleep(1_500);
      expect(changed(client)).toBe(1);
      const frame = client.frames.find(entry => entry.type === "changed")!;
      expect(Number.isNaN(Date.parse(String(frame.at)))).toBe(false);
    } finally { service.close(); }
  });

  it("debounces a burst to one frame after the final edit, not the first", async () => {
    const { root } = await repository();
    const client = new FakeClient();
    const service = new GitWatch({ platform: "linux", pollMs: 50, debounceMs: 1_000 });
    try {
      await service.watch(client, root);
      await writeFile(path.join(root, "first.txt"), "first\n");
      await waitFor(() => changed(client) >= 1);
      await sleep(1_100);
      await writeFile(path.join(root, "a.txt"), "a\n");
      await sleep(80);
      await writeFile(path.join(root, "b.txt"), "b\n");
      await sleep(80);
      await writeFile(path.join(root, "c.txt"), "c\n");
      await sleep(200);
      expect(changed(client)).toBe(1);
      await waitFor(() => changed(client) >= 2);
      await sleep(1_500);
      expect(changed(client)).toBe(2);
    } finally { service.close(); }
  });

  it("serves two subscribers of one checkout from a single watcher", async () => {
    const { root } = await repository();
    const first = new FakeClient(), second = new FakeClient();
    const service = new GitWatch({ platform, pollMs: 50 });
    const openedBefore = watcherCounts.opened;
    try {
      await service.watch(first, root);
      await service.watch(second, root);
      if (platform !== "linux") expect(watcherCounts.opened - openedBefore).toBe(2);
      await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
      await waitFor(() => changed(first) >= 1 && changed(second) >= 1);
      expect(first.frames.at(-1)).toMatchObject({ type: "changed" });
      expect(second.frames.at(-1)).toMatchObject({ type: "changed" });
    } finally { service.close(); }
  });

  it("stops every watcher resource 30 s after its last subscriber leaves", async () => {
    const { root } = await repository();
    vi.useFakeTimers();
    const first = new FakeClient(), second = new FakeClient();
    const service = new GitWatch({ platform, pollMs: 60_000 });
    const openedBefore = watcherCounts.opened, closedBefore = watcherCounts.closed;
    try {
      await service.watch(first, root);
      await service.watch(second, root);
      const opened = watcherCounts.opened - openedBefore;
      if (platform !== "linux") expect(opened).toBe(2);
      first.close();
      await vi.advanceTimersByTimeAsync(29_999);
      if (platform === "linux") expect(vi.getTimerCount()).toBeGreaterThan(0);
      else expect(watcherCounts.closed - closedBefore).toBe(0);
      second.close();
      await vi.advanceTimersByTimeAsync(29_999);
      if (platform === "linux") expect(vi.getTimerCount()).toBeGreaterThan(0);
      else expect(watcherCounts.closed - closedBefore).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      if (platform === "linux") expect(vi.getTimerCount()).toBe(0);
      else expect(watcherCounts.closed - closedBefore).toBe(opened);
    } finally { service.close(); }
  });

  it("sends an error frame and closes for a folder that is not a Git repository", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "phren-git-watch-plain-")));
    created.push(root);
    const client = new FakeClient();
    const service = new GitWatch({ platform: "linux", pollMs: 50 });
    const openedBefore = watcherCounts.opened;
    try {
      await service.watch(client, root);
      expect(client.frames).toEqual([{ type: "error", code: "git-not-repository", message: expect.any(String) }]);
      expect(client.closed).toBe(1011);
      expect(watcherCounts.opened).toBe(openedBefore);
    } finally { service.close(); }
  });

  it("sends an error frame and closes subscribers when polling stops working", async () => {
    const { root } = await repository();
    const client = new FakeClient();
    const service = new GitWatch({ platform: "linux", pollMs: 20 });
    try {
      await service.watch(client, root);
      await rm(path.join(root, ".git"), { recursive: true, force: true });
      await waitFor(() => client.frames.some(frame => frame.type === "error"));
      expect(client.frames.find(frame => frame.type === "error")).toMatchObject({ type: "error", code: "git-not-repository" });
      expect(client.closed).toBe(1011);
    } finally { service.close(); }
  });

  it("does not start a watcher after shutdown", async () => {
    const { root } = await repository();
    const client = new FakeClient();
    const service = new GitWatch({ platform, pollMs: 50 });
    const openedBefore = watcherCounts.opened;
    service.close();
    await service.watch(client, root);
    expect(watcherCounts.opened).toBe(openedBefore);
    expect(client.frames).toEqual([]);
  });

  it("advertises gitWatch only while the git module is enabled", async () => {
    const { BUILTIN_MODULES } = await import("../modules/registry.js");
    const { capabilitiesForModules } = await import("./server-routes.js");
    const snapshot = (names: string[]) => ({ modules: BUILTIN_MODULES.filter(module => names.includes(module.name)),
      has: (name: string) => names.includes(name) });
    expect(capabilitiesForModules(snapshot(["memory", "git"]) as never).gitWatch).toBe(true);
    expect(capabilitiesForModules(snapshot(["memory"]) as never).gitWatch).toBeUndefined();
  });

  it("polls status on Linux and sends changed only when the status changes", async () => {
    const { root } = await repository();
    const client = new FakeClient();
    const service = new GitWatch({ platform: "linux", pollMs: 40, debounceMs: 30 });
    try {
      await service.watch(client, root);
      await sleep(250);
      expect(changed(client)).toBe(0);
      await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
      await waitFor(() => changed(client) >= 1);
      await sleep(250);
      expect(changed(client)).toBe(1);
    } finally { service.close(); }
  });
});
