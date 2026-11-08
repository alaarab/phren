import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus, reconcileInterruptedDispatches, updateReceipt } from "./dispatch.js";
import { findIdempotencyKey, idempotencyKeyFile, idempotencyLockFile, requestIdempotencyCancel, reserveIdempotencyKey, updateIdempotencyPhase } from "./dispatch-idempotency.js";
import { DispatchReturns } from "./dispatch-returns.js";
import { dispatchClonePaths } from "./dispatch-clone.js";
import { recordBriefArrival, writeLaunchBrief } from "./launch-brief.js";
import { closeRequestFromArgs, dispatchInputFromArgs } from "./dispatch-command.js";
import { waitForDispatch } from "./dispatch-wait.js";
import { cancelDispatch, closeVerifiedWorker, paneBinding, paneRunsTarget } from "./worker-close.js";
import { hookRequest } from "./client.js";
import { hookPeers, peerRequest } from "./peers.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import { atomicInPrivateDir, type Json } from "./protocol.js";

vi.mock("./peers.js", () => {
  const hookPeers = vi.fn();
  return { hookPeers, peerRequest: vi.fn(), optionalHookPeers: async () => ({ peers: await hookPeers().catch(() => []) }) };
});
vi.mock("./computer-names.js", () => ({ localNames: () => ["Laptop.example.net", "Laptop"] }));
vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));

const localID = "30000000-0000-4000-8000-000000000009";
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", starting: true, startingToken: "a".repeat(64) };
const brief = { computer: "local", project: "phren", harness: "codex", prompt: "A private worker brief", label: "Tests" };
const service = () => new DispatchService(undefined, undefined, 1);

describe("local dispatch", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-local-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.mocked(hookPeers).mockResolvedValue([]);
    vi.mocked(peerRequest).mockResolvedValue({ ok: true });
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

  const launches = () => vi.mocked(hookRequest).mock.calls.filter(call => call[0].startsWith("/v1/workspaces/launch"));

  it("reads the brief from stdin, never argv, and refuses both or an oversized brief", async () => {
    const secret = "SECRET-BRIEF-FROM-STDIN";
    const args = ["local", "demo", "--harness", "claude", "--prompt-file", "-", "--idempotency-key", "gitboy:host:1"];
    const input = await dispatchInputFromArgs(args, Readable.from([secret]));
    expect(input).toMatchObject({ computer: "local", project: "demo", harness: "claude", prompt: secret, label: "gitboy:host:1", idempotencyKey: "gitboy:host:1" });
    expect(args.join(" ")).not.toContain(secret);
    expect((await dispatchInputFromArgs(["local", "demo", "--prompt", "short"])).label).toBe("gitboy agent");
    await expect(dispatchInputFromArgs(["local", "demo", "--prompt", "a", "--prompt-file", "-"], Readable.from(["b"])))
      .rejects.toThrow("exactly one");
    await expect(dispatchInputFromArgs(["local", "demo", "--prompt-file", "-"], Readable.from(["x".repeat(32769)])))
      .rejects.toThrow("too large");
    await writeFile(path.join(root, "oversized-brief"), "x".repeat(40000));
    await expect(dispatchInputFromArgs(["local", "demo", "--prompt-file", path.join(root, "oversized-brief")]))
      .rejects.toThrow("too large");
    let chunks = 0;
    async function* endless() { for (;;) { chunks++; yield "x".repeat(1024); } }
    await expect(dispatchInputFromArgs(["local", "demo", "--prompt-file", "-"], Readable.from(endless())))
      .rejects.toThrow("too large");
    expect(chunks).toBeLessThan(40);
  });

  it("returns the dispatch a key already started, and one concurrent pair starts one agent", async () => {
    const key = "gitboy:gitboy.dev:session-1";
    const first = await service().dispatch({ ...brief, worktree: true, idempotencyKey: key });
    expect(first).toMatchObject({ existing: false, dispatch: first.id, id: first.id });
    expect((await findIdempotencyKey(key))?.phase).toBe("launched");
    const again = await service().dispatch({ ...brief, worktree: true, idempotencyKey: key });
    expect(again).toMatchObject({ existing: true, dispatch: first.id, id: first.id });
    expect(launches()).toHaveLength(1);

    const other = "gitboy:gitboy.dev:session-2";
    const [a, b] = await Promise.all([
      service().dispatch({ ...brief, worktree: true, idempotencyKey: other }),
      service().dispatch({ ...brief, worktree: true, idempotencyKey: other }),
    ]);
    expect(a.id).toBe(b.id);
    expect([a.existing, b.existing].sort()).toEqual([false, true]);
    expect(launches()).toHaveLength(2);
  });

  it("survives a reload of the store and names the worktree branch", async () => {
    const key = "gitboy:gitboy.dev:session-3";
    const first = await service().dispatch({ ...brief, idempotencyKey: key, worktree: true });
    expect(first).toMatchObject({ existing: false, branch: "agent/gitboy-gitboy.dev-session-3" });
    expect(launches()[0][1]).toMatchObject({ worktree: { branch: "agent/gitboy-gitboy.dev-session-3" } });

    const reloaded = await service().dispatch({ ...brief, worktree: true, idempotencyKey: key });
    expect(reloaded).toMatchObject({ existing: true, id: first.id });
    expect(launches()).toHaveLength(1);

    const named = await service().dispatch({ ...brief, idempotencyKey: "gitboy:gitboy.dev:session-4", worktree: true, branch: "agent/42-1a2b3c4d" });
    expect(named.branch).toBe("agent/42-1a2b3c4d");
    expect(launches()[1][1]).toMatchObject({ worktree: { branch: "agent/42-1a2b3c4d" } });
  });

  it("refuses a keyed dispatch without a managed worktree clone", async () => {
    await expect(service().dispatch({ ...brief, idempotencyKey: "gitboy:host:no-clone" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("requires --worktree") });
    expect(launches()).toHaveLength(0);
  });

  it("refuses full-access, non-supervised modes and non-claude/codex harnesses for a keyed dispatch", async () => {
    await expect(service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:full", permissionMode: "full-access" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("full-access") });
    await expect(service().dispatch({ ...brief, harness: "claude", worktree: true, idempotencyKey: "gitboy:host:auto", permissionMode: "auto" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("supervised") });
    await expect(service().dispatch({ ...brief, harness: "copilot", worktree: true, idempotencyKey: "gitboy:host:copilot", permissionMode: "auto" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("claude or codex") });
    expect(launches()).toHaveLength(0);
    const placed = await service().dispatch({ ...brief, harness: "codex", worktree: true, idempotencyKey: "gitboy:host:supervised" });
    expect(placed).toMatchObject({ permissionMode: "supervised" });
    expect(launches().at(-1)?.[1]).toMatchObject({ permissionMode: "supervised" });
  });

  it("publishes one reservation under concurrent owners and never reclaims an unreadable one", async () => {
    const key = "gitboy:host:race";
    const [a, b] = await Promise.all([
      reserveIdempotencyKey(key, randomUUID(), randomUUID()),
      reserveIdempotencyKey(key, randomUUID(), randomUUID()),
    ]);
    expect([a.reserved, b.reserved].sort()).toEqual([false, true]);
    const record = await findIdempotencyKey(key);
    expect(record).toBeDefined();
    expect(await updateIdempotencyPhase(key, randomUUID(), "failed")).toBe(false);

    const corrupt = "gitboy:host:corrupt";
    await reserveIdempotencyKey(corrupt, randomUUID(), randomUUID());
    await writeFile(idempotencyKeyFile(corrupt), "");
    await expect(reserveIdempotencyKey(corrupt, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining("unreadable") });
  });

  it("fails closed on a stale idempotency lock instead of unlinking it", async () => {
    const key = "gitboy:host:stale-lock";
    await reserveIdempotencyKey(key, randomUUID(), randomUUID(), {}, Date.now() - 31 * 24 * 60 * 60_000);
    await writeFile(idempotencyLockFile(key), JSON.stringify({ owner: randomUUID(), createdAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    await expect(reserveIdempotencyKey(key, randomUUID(), randomUUID()))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining("stale owner") });
    expect(await readFile(idempotencyLockFile(key), "utf8")).toContain("owner");
  });

  it("turns a stale reservation into a failed interrupted launch and never relaunches", async () => {
    const key = "gitboy:host:interrupted";
    const id = randomUUID();
    await reserveIdempotencyKey(key, id, randomUUID(), { project: "phren", harness: "codex", label: "Interrupted", computer: "local" },
      Date.now() - 6 * 60_000);
    await reconcileInterruptedDispatches();
    expect((await dispatchStatus()).find(row => row.id === id)).toMatchObject({
      state: "failed", error: "launch interrupted", returned: { state: "failed", error: "launch interrupted" },
    });
    expect(await service().dispatch({ ...brief, worktree: true, idempotencyKey: key }))
      .toMatchObject({ existing: true, id, state: "failed", error: "launch interrupted" });
    expect(launches()).toHaveLength(0);
  });

  it("recovers an interrupted launch from its arrival record", async () => {
    const key = "gitboy:host:arrived";
    const id = randomUUID();
    await reserveIdempotencyKey(key, id, randomUUID(), { project: "phren", harness: "codex", label: "Arrived", computer: "local" },
      Date.now() - 6 * 60_000);
    // A SessionStart arrival always names the agent's session.
    const arrived = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "019a0000-0000-7000-8000-000000000001", starting: true, startingToken: "b".repeat(64) };
    await writeLaunchBrief({ id, text: "brief" });
    await recordBriefArrival(id, "SessionStart", arrived);
    await reconcileInterruptedDispatches();
    // Recovered by its session, so the target drops the starting-token fields.
    const { starting: _starting, startingToken: _token, ...identified } = arrived;
    const recovered = (await dispatchStatus()).find(row => row.id === id);
    expect(recovered).toMatchObject({ state: "accepted", target: identified });
    expect(recovered?.target).not.toHaveProperty("startingToken");
    expect((await findIdempotencyKey(key))?.phase).toBe("launched");
  });

  it("persists a cancel before the first receipt and never launches", async () => {
    const key = "gitboy:host:pre-receipt";
    const id = randomUUID();
    await reserveIdempotencyKey(key, id, randomUUID(), { project: "phren", harness: "codex", label: "Pre", computer: "local" });
    expect(await cancelDispatch({ idempotencyKey: key })).toMatchObject({ dispatch: id, closed: false });
    expect((await dispatchStatus()).find(row => row.id === id)).toMatchObject({
      state: "failed", error: "cancelled", returned: { state: "failed", error: "cancelled" },
    });
    expect(await service().dispatch({ ...brief, worktree: true, idempotencyKey: key })).toMatchObject({ existing: true, id, state: "failed", error: "cancelled" });
    expect(launches()).toHaveLength(0);
  });

  it("retains a failed clone, removes its secrets, and deletes it after retention", async () => {
    const key = "gitboy:host:retain";
    const placed = await service().dispatch({ ...brief, idempotencyKey: key, worktree: true });
    const paths = dispatchClonePaths(placed.id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "managed config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    await updateReceipt(placed.id, value => {
      value.returned = { state: "failed", at: new Date().toISOString(), error: "boom", read: false };
      return true;
    });
    const returns = new DispatchReturns({ now: () => Date.now(), request: async () => ({}), peers: async () => [],
      isLocal: () => true, localWorkers: async () => ({ workers: [] }) });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }) } as unknown as TerminalProvider);
    try {
      await returns.cleanup();
      expect(await stat(paths.cloneDir).then(() => true, () => false)).toBe(true);
      expect(await stat(paths.gitConfigFile).catch(() => undefined)).toBeUndefined();
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
      expect((await dispatchStatus()).find(row => row.id === placed.id)?.retainedUntil).toEqual(expect.any(String));
      await updateReceipt(placed.id, value => { value.retainedUntil = new Date(Date.now() - 1_000).toISOString(); return true; });
      await reconcileInterruptedDispatches();
      expect(await stat(paths.cloneDir).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("keeps a failed clone and token while its pane still runs, even after retention", async () => {
    const placed = await service().dispatch({ ...brief, idempotencyKey: "gitboy:host:failed-alive", worktree: true });
    const paths = dispatchClonePaths(placed.id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "managed config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    await updateReceipt(placed.id, value => {
      value.returned = { state: "failed", at: new Date().toISOString(), error: "usage limit", read: false };
      value.endedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
      value.retainedUntil = new Date(Date.now() - 1_000).toISOString();
      return true;
    });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [{ pane_id: target.pane,
      workspace_id: target.workspace, tab_id: target.tab, agent: target.source }] }) } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect(await stat(paths.cloneDir).then(() => true, () => false)).toBe(true);
      expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
      expect((await dispatchStatus()).find(row => row.id === placed.id)?.endedAt).toBeUndefined();
    } finally { restore(); }
  });

  it("deletes a failed clone after retention once its pane is confirmed gone", async () => {
    const placed = await service().dispatch({ ...brief, idempotencyKey: "gitboy:host:failed-gone", worktree: true });
    const paths = dispatchClonePaths(placed.id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "managed config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    await updateReceipt(placed.id, value => {
      value.returned = { state: "failed", at: new Date().toISOString(), error: "usage limit", read: false };
      value.endedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
      value.retainedUntil = new Date(Date.now() - 1_000).toISOString();
      return true;
    });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }) } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect(await stat(paths.cloneDir).catch(() => undefined)).toBeUndefined();
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("never touches a peer dispatch's files when cleaning up", async () => {
    const id = randomUUID();
    const paths = dispatchClonePaths(id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    const at = new Date().toISOString();
    await atomicInPrivateDir(path.join(root, "dispatches", `${id}.json`), {
      id, computer: "Peer", project: "phren", harness: "codex", label: "peer", state: "accepted",
      createdAt: at, updatedAt: at, returned: { state: "failed", at, error: "boom", read: false },
      cloneDir: paths.cloneDir, gitConfigFile: paths.gitConfigFile, agentTokenFile: paths.agentTokenFile,
    });
    const returns = new DispatchReturns({ now: () => Date.now(), request: async () => ({}), peers: async () => [],
      isLocal: () => false, localWorkers: async () => ({ workers: [] }) });
    await returns.cleanup();
    expect(await stat(paths.cloneDir).then(() => true, () => false)).toBe(true);
    expect(await stat(paths.gitConfigFile).then(() => true, () => false)).toBe(true);
    expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
  });

  it("does not delete a done clone while its worker is still bound", async () => {
    const placed = await service().dispatch({ ...brief, idempotencyKey: "gitboy:host:live-done", worktree: true });
    const paths = dispatchClonePaths(placed.id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    await updateReceipt(placed.id, value => {
      value.returned = { state: "done", at: new Date().toISOString(), reply: "ok", read: true };
      value.retainedUntil = new Date(Date.now() - 1_000).toISOString();
      return true;
    });
    const restore = setTerminalProvider({
      snapshot: async () => ({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
        terminal_id: "term-1", agent: target.source, agent_status: "idle", startingToken: target.startingToken }] }),
    } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect(await stat(paths.cloneDir).then(() => true, () => false)).toBe(true);
    } finally { restore(); }
  });

  it("transfers a cancel that lands before first-receipt creation", async () => {
    const key = "gitboy:host:between";
    vi.mocked(hookRequest).mockImplementation(async route => {
      if (route === "/v1/dispatch/capacity") {
        await requestIdempotencyCancel(key);
        return { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 0 };
      }
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, target };
      return { ok: true };
    });
    const result = await service().dispatch({ ...brief, worktree: true, idempotencyKey: key });
    expect(result).toMatchObject({ state: "failed", error: "cancelled" });
    expect(launches()).toHaveLength(0);
  });

  it("closes a running dispatch once and its wait ends cancelled", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:close" });
    let panes = [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      terminal_id: "term-1", agent: target.source, agent_status: "working", startingToken: target.startingToken }];
    const closePane = vi.fn(async () => { panes = []; });
    const restore = setTerminalProvider({
      snapshot: async () => ({ panes }),
      closePane,
    } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: true });
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: false });
      expect(closePane).toHaveBeenCalledTimes(1);
    } finally { restore(); }

    const lines: Json[] = [];
    const code = await waitForDispatch(placed.id, { intervalMs: 1, jitter: false, out: line => lines.push(line),
      request: async (route, data) => {
        if (route === "/v1/dispatch") return { dispatches: await dispatchStatus() };
        if (route.startsWith("/v1/dispatch/returns")) return { returns: [] };
        return { ok: true, ...(data ?? {}) };
      } });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatchObject({ dispatch: placed.id, state: "failed", final: true, error: "cancelled" });
  });

  it("closes by idempotency key, refuses both forms, and an unknown key closes nothing", async () => {
    const key = "gitboy:host:close-key";
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: key });
    let panes = [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      terminal_id: "term-1", agent: target.source, agent_status: "working", startingToken: target.startingToken }];
    const closePane = vi.fn(async () => { panes = []; });
    const restore = setTerminalProvider({
      snapshot: async () => ({ panes }),
      closePane,
    } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ idempotencyKey: key })).toMatchObject({ dispatch: placed.id, closed: true });
      expect(await cancelDispatch({ idempotencyKey: "gitboy:host:missing" })).toEqual({ ok: true, closed: false });
      await expect(cancelDispatch({ dispatch: placed.id, idempotencyKey: key } as never)).rejects.toThrow();
      expect(closeRequestFromArgs(["--idempotency-key", key])).toEqual({ idempotencyKey: key });
      expect(closeRequestFromArgs([placed.id])).toEqual({ dispatch: placed.id });
      expect(() => closeRequestFromArgs([placed.id, "--idempotency-key", key])).toThrow();
      expect(closePane).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it("leaves an unconfirmed close pending and retries it later", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:pending" });
    let panes = [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      terminal_id: "term-1", agent: target.source, agent_status: "working", startingToken: target.startingToken }];
    let remove = false;
    const closePane = vi.fn(async () => { if (remove) panes = []; });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes }), closePane } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: false, pending: true });
      remove = true;
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: true });
    } finally { restore(); }
  });

  it("finalizes a vanished worker without closing a pane", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:gone" });
    const closePane = vi.fn(async () => undefined);
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }), closePane } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: false, gone: true });
      expect(closePane).not.toHaveBeenCalled();
      expect((await dispatchStatus()).find(row => row.id === placed.id)).toMatchObject({
        closedAt: expect.any(String), returned: { state: "failed", error: "cancelled" },
      });
    } finally { restore(); }
  });

  it("does not treat a replacement session or missing evidence as the recorded worker", () => {
    const recorded = { ...target, session: "s-recorded" };
    expect(paneRunsTarget(recorded as never, { agent: "codex" }, { sessionId: "s-other" })).toBe(false);
    expect(paneRunsTarget(recorded as never, { agent: "codex" }, { sessionId: "s-recorded" })).toBe(true);
    expect(paneBinding(target as never, { agent: "codex" }, {})).toBe("unknown");
  });

  it("keeps a cancellation pending when the pane snapshot fails", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:snapshot" });
    const restore = setTerminalProvider({ snapshot: async () => { throw new Error("snapshot down"); }, closePane: vi.fn() } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: false, pending: true });
      expect((await dispatchStatus()).find(row => row.id === placed.id)).toMatchObject({ cancelRequestedAt: expect.any(String) });
      expect((await dispatchStatus()).find(row => row.id === placed.id)?.closedAt).toBeUndefined();
    } finally { restore(); }
  });

  it("records cancelRequestedAt during placement instead of reporting gone", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:placing" });
    const file = path.join(root, "dispatches", `${placed.id}.json`);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...receipt, state: "launching" }));
    expect(await cancelDispatch({ dispatch: placed.id })).toMatchObject({ dispatch: placed.id, closed: false, pending: true });
    expect(JSON.parse(await readFile(file, "utf8")).cancelRequestedAt).toEqual(expect.any(String));
  });

  it("lets the launcher close a pane cancelled during placement", async () => {
    let panes = [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      terminal_id: "term-1", agent: target.source, agent_status: "working", startingToken: target.startingToken }];
    const closePane = vi.fn(async () => { panes = []; });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes }), closePane } as unknown as TerminalProvider);
    vi.mocked(hookRequest).mockImplementation(async (route, data) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) {
        const file = path.join(root, "dispatches", `${String((data?.brief as Json).id)}.json`);
        const receipt = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...receipt, cancelRequestedAt: new Date().toISOString() }));
        return { ok: true, target };
      }
      return { ok: true };
    });
    try {
      const result = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:launcher-cancel" });
      expect(result).toMatchObject({ state: "failed", error: "cancelled" });
      expect(closePane).toHaveBeenCalled();
      expect((await findIdempotencyKey("gitboy:host:launcher-cancel"))?.phase).toBe("failed");
    } finally { restore(); }
  });

  it("keeps a lost-reply launch pending, and recovers its worker from the arrival record", async () => {
    const id = randomUUID();
    const base = { id, computer: "local", project: "phren", harness: "codex", label: "Lost reply", idempotencyKey: `gitboy:host:${id}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "uncertain" } as unknown as Parameters<typeof closeVerifiedWorker>[0];
    const closePane = vi.fn(async () => undefined);
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }), closePane } as unknown as TerminalProvider);
    try {
      // No target and no arrival: the worker may be running somewhere; never claim it gone.
      expect(await closeVerifiedWorker(base)).toMatchObject({ dispatch: id, closed: false, pending: true });
      expect(closePane).not.toHaveBeenCalled();
    } finally { restore(); }

    // With the worker's arrival record, the binding is recovered and the pane is closed through it.
    const arrived = { server: "default", workspace: "w9", tab: "t9", pane: "p9", source: "codex", session: "019a0000-0000-7000-8000-000000000009" };
    await writeLaunchBrief({ id, text: "brief" });
    await recordBriefArrival(id, "SessionStart", arrived);
    let panes = [{ pane_id: "p9", workspace_id: "w9", tab_id: "t9", terminal_id: "term-9", agent: "codex", agent_status: "working", sessionId: arrived.session }];
    const close = vi.fn(async () => { panes = []; });
    const restoreLive = setTerminalProvider({ snapshot: async () => ({ panes }), closePane: close } as unknown as TerminalProvider);
    try {
      const result = await closeVerifiedWorker(base);
      expect(result).not.toMatchObject({ gone: true, pending: true });
      expect(close).toHaveBeenCalled();
    } finally { restoreLive(); }
  });

  const ambiguousReceipt = async (key: string, outcome: "ambiguous" | "not-started" = "ambiguous") => {
    const id = randomUUID();
    const paths = dispatchClonePaths(id);
    await mkdir(path.join(paths.cloneDir, ".git"), { recursive: true });
    await writeFile(paths.gitConfigFile, "managed config\n");
    await writeFile(paths.agentTokenFile, "token\n");
    const at = new Date().toISOString();
    const startingToken = "c".repeat(64);
    await reserveIdempotencyKey(key, id, randomUUID(), { project: "phren", harness: "codex", label: "Ambiguous",
      computer: "local", startingToken, cloneDir: paths.cloneDir, gitConfigFile: paths.gitConfigFile, agentTokenFile: paths.agentTokenFile });
    await atomicInPrivateDir(path.join(root, "dispatches", `${id}.json`), {
      id, computer: "local", project: "phren", harness: "codex", label: "Ambiguous", idempotencyKey: key,
      createdAt: at, updatedAt: at, state: "uncertain", launchOutcome: outcome, launchServer: "default", startingToken,
      returned: { state: "failed", at, error: "504", read: false },
      cloneDir: paths.cloneDir, gitConfigFile: paths.gitConfigFile, agentTokenFile: paths.agentTokenFile,
    });
    return { id, paths, startingToken };
  };

  it("records a starting token before the launch request", async () => {
    const placed = await service().dispatch({ ...brief, worktree: true, idempotencyKey: "gitboy:host:starting-token" });
    const body = launches()[0][1] as Json;
    expect(body.startingToken).toMatch(/^[a-f0-9]{64}$/);
    expect((await dispatchStatus()).find(row => row.id === placed.id)?.startingToken).toBe(body.startingToken);
  });

  it("keeps a 504 launch pending until a successful scan proves no worker, then removes its token", async () => {
    const { id, paths } = await ambiguousReceipt("gitboy:host:504");
    const failing = setTerminalProvider({ snapshot: async () => { throw new Error("snapshot down"); }, closePane: vi.fn() } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: id })).toMatchObject({ dispatch: id, closed: false, pending: true });
      expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
    } finally { failing(); }
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }), closePane: vi.fn() } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: id })).toMatchObject({ dispatch: id, closed: false, gone: true });
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("adopts a pane carrying the launch's starting token and closes it", async () => {
    const { id, paths, startingToken } = await ambiguousReceipt("gitboy:host:adopt");
    let panes = [{ pane_id: "p9", workspace_id: "w9", tab_id: "t9", terminal_id: "term-9", agent: "codex",
      agent_status: "working", startingToken }];
    const closePane = vi.fn(async () => { panes = []; });
    const restore = setTerminalProvider({ snapshot: async () => ({ panes }), closePane } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: id })).toMatchObject({ dispatch: id, closed: true });
      expect(closePane).toHaveBeenCalled();
      expect((await dispatchStatus()).find(row => row.id === id)).toMatchObject({
        launchOutcome: "started", target: { pane: "p9" },
      });
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("finalizes a not-started refusal without scanning", async () => {
    const { id, paths } = await ambiguousReceipt("gitboy:host:not-started", "not-started");
    const snapshot = vi.fn(async () => { throw new Error("must not scan"); });
    const restore = setTerminalProvider({ snapshot, closePane: vi.fn() } as unknown as TerminalProvider);
    try {
      expect(await cancelDispatch({ dispatch: id })).toMatchObject({ dispatch: id, closed: false, gone: true });
      expect(snapshot).not.toHaveBeenCalled();
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("reconcile keeps an ambiguous token until a scan, and removes it after 24 hours", async () => {
    const { id, paths } = await ambiguousReceipt("gitboy:host:reconcile-504");
    const failing = setTerminalProvider({ snapshot: async () => { throw new Error("snapshot down"); } } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
    } finally { failing(); }
    const restore = setTerminalProvider({ snapshot: async () => ({ panes: [] }) } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
      expect((await dispatchStatus()).find(row => row.id === id)?.scanSince).toEqual(expect.any(String));
      await updateReceipt(id, value => { value.scanSince = new Date(Date.now() - 25 * 60 * 60_000).toISOString(); return true; });
      await reconcileInterruptedDispatches();
      expect(await stat(paths.agentTokenFile).catch(() => undefined)).toBeUndefined();
    } finally { restore(); }
  });

  it("reconcile adopts a pane carrying the launch's starting token", async () => {
    const { id, paths, startingToken } = await ambiguousReceipt("gitboy:host:reconcile-adopt");
    const panes = [{ pane_id: "p9", workspace_id: "w9", tab_id: "t9", terminal_id: "term-9", agent: "codex",
      agent_status: "working", startingToken }];
    const restore = setTerminalProvider({ snapshot: async () => ({ panes }) } as unknown as TerminalProvider);
    try {
      await reconcileInterruptedDispatches();
      expect((await dispatchStatus()).find(row => row.id === id)).toMatchObject({
        launchOutcome: "started", target: { pane: "p9" },
      });
      expect(await stat(paths.agentTokenFile).then(() => true, () => false)).toBe(true);
    } finally { restore(); }
  });

});
