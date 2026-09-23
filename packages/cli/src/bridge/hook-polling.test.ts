import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { knownPanes, paneChatState, recentServers, resetSharedHerdrState, sharedSnapshot, validateTarget } from "./herdr.js";
import { hookMetrics } from "./metrics.js";
import { repositoryBranch } from "./projects.js";

// A fake Herdr socket per server: it answers session.snapshot from `panes`,
// pane.process_info with one PID and ping, and counts every method.
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "bbbbbbbb-1111-4111-8111-111111111111";
const reported = (value: string) => ({ kind: "id", agent: "claude", source: "herdr:claude", value });
const pane = (value = session) => ({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term", agent: "claude", agent_status: "working", agent_session: reported(value) });
let root: string, panes: Record<string, unknown>[] = [];
const calls = new Map<string, number>();
const servers: Server[] = [];
let now = 1_000_000;
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude" as const, session };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-polling-"));
  for (const name of ["", "sessions/work"]) {
    await mkdir(path.join(root, name), { recursive: true });
    const server = createServer(socket => {
      let text = ""; socket.on("data", bytes => {
        text += bytes; if (!text.includes("\n")) return;
        const request = JSON.parse(text);
        calls.set(request.method, (calls.get(request.method) ?? 0) + 1);
        const result = request.method === "session.snapshot" ? { snapshot: { panes } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 4242 }] } } : {};
        socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(path.join(root, name, "herdr.sock"), resolve));
  }
});
afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("PHREN_HERDR_HOME", root);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  resetSharedHerdrState(); calls.clear(); panes = [pane()];
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("lets every open stream share one snapshot per window", async () => {
  // Three chats ticking together, then again inside the window.
  await Promise.all([1, 2, 3].map(() => validateTarget(target, false, false, 2_500)));
  now += 2_000;
  await Promise.all([1, 2, 3].map(() => validateTarget(target, false, false, 2_500)));
  await sharedSnapshot("default");
  expect(calls.get("session.snapshot")).toBe(1);
  // Past the window the next tick asks Herdr again, once for all of them.
  now += 600;
  await Promise.all([1, 2, 3].map(() => validateTarget(target, false, false, 2_500)));
  expect(calls.get("session.snapshot")).toBe(2);
  // A send never uses the shared snapshot.
  await validateTarget(target, true);
  expect(calls.get("session.snapshot")).toBe(3);
});

it("detects a changed conversation within one window", async () => {
  await validateTarget(target, false, false, 2_500);
  panes = [pane(other)];
  now += 2_500;
  await expect(validateTarget(target, false, false, 2_500)).rejects.toMatchObject({ status: 409 });
});

it("detects a pane that disappeared within one window", async () => {
  await validateTarget(target, false, false, 2_500);
  panes = [];
  now += 2_500;
  await expect(validateTarget(target, false, false, 2_500)).rejects.toMatchObject({ status: 409 });
});

it("never keeps a failed snapshot", async () => {
  vi.stubEnv("PHREN_HERDR_HOME", path.join(root, "missing"));
  await expect(sharedSnapshot("default")).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("PHREN_HERDR_HOME", root);
  expect(objects(await sharedSnapshot("default"))).toHaveLength(1);
});

it("skips the process probe when Herdr reports the session", async () => {
  expect(await paneChatState("default", pane(), { tokenWhenIdentified: false })).toEqual({ sessionId: session });
  expect(calls.get("pane.process_info")).toBeUndefined();
  // Other callers still get the starting token, from one probe.
  const state = await paneChatState("default", pane());
  expect(state.sessionId).toBe(session);
  expect(state.startingToken).toMatch(/^[a-f0-9]{64}$/);
  expect(calls.get("pane.process_info")).toBe(1);
});

it("reads a pane's processes once when the session is not reported", async () => {
  const unreported = { ...pane(), agent_session: undefined };
  // No open transcript: identity is unknown and the lifecycle binding decides.
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  await paneChatState("default", unreported);
  expect(calls.get("pane.process_info")).toBe(1);
});

it("reuses the server list and knows the panes it already holds", async () => {
  expect(knownPanes(15_000)).toBeUndefined();
  expect((await recentServers()).map(server => server.session)).toEqual(["default", "work"]);
  await recentServers(); now += 29_000; await recentServers();
  expect(calls.get("ping")).toBe(2);
  now += 1_000; await recentServers();
  expect(calls.get("ping")).toBe(4);
  expect(knownPanes(15_000)).toBeUndefined();
  await sharedSnapshot("default"); await sharedSnapshot("work");
  expect(knownPanes(15_000)).toHaveLength(2);
  now += 15_000;
  expect(knownPanes(15_000)).toBeUndefined();
});

it("keeps a branch while HEAD is unchanged and rereads it after a checkout", async () => {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  const spawns = () => Number((hookMetrics.snapshot().git as Record<string, { total: number }>).branch?.total ?? 0);
  const before = spawns();
  expect(await repositoryBranch(repo)).toBe("main");
  now += 60_000;
  expect(await repositoryBranch(repo)).toBe("main");
  expect(spawns()).toBe(before + 1);
  git("checkout", "-q", "-b", "feature");
  expect(await repositoryBranch(repo)).toBe("main"); // inside the ten-second window
  now += 10_000;
  expect(await repositoryBranch(repo)).toBe("feature");
  expect(spawns()).toBe(before + 2);
  // Past five minutes git answers again even when HEAD is the same.
  now += 300_000;
  await repositoryBranch(repo);
  expect(spawns()).toBe(before + 3);
});

function objects(value: Record<string, unknown>): unknown[] { return Array.isArray(value.panes) ? value.panes : []; }
