import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus } from "./dispatch.js";
import { closeRequestFromArgs, dispatchInputFromArgs } from "./dispatch-command.js";
import { waitForDispatch } from "./dispatch-wait.js";
import { cancelDispatch } from "./worker-close.js";
import { hookRequest } from "./client.js";
import { hookPeers, peerRequest } from "./peers.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import type { Json } from "./protocol.js";

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
  });

  it("returns the dispatch a key already started, and one concurrent pair starts one agent", async () => {
    const key = "gitboy:gitboy.dev:session-1";
    const first = await service().dispatch({ ...brief, idempotencyKey: key });
    expect(first).toMatchObject({ existing: false, dispatch: first.id, id: first.id });
    const again = await service().dispatch({ ...brief, idempotencyKey: key });
    expect(again).toMatchObject({ existing: true, dispatch: first.id, id: first.id });
    expect(launches()).toHaveLength(1);

    const other = "gitboy:gitboy.dev:session-2";
    const [a, b] = await Promise.all([
      service().dispatch({ ...brief, idempotencyKey: other }),
      service().dispatch({ ...brief, idempotencyKey: other }),
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

    const reloaded = await service().dispatch({ ...brief, idempotencyKey: key });
    expect(reloaded).toMatchObject({ existing: true, id: first.id });
    expect(launches()).toHaveLength(1);

    const named = await service().dispatch({ ...brief, idempotencyKey: "gitboy:gitboy.dev:session-4", worktree: true, branch: "agent/42-1a2b3c4d" });
    expect(named.branch).toBe("agent/42-1a2b3c4d");
    expect(launches()[1][1]).toMatchObject({ worktree: { branch: "agent/42-1a2b3c4d" } });
  });

  it("refuses full-access for a dispatch with an idempotency key", async () => {
    await expect(service().dispatch({ ...brief, idempotencyKey: "gitboy:host:full", permissionMode: "full-access" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("full-access") });
    expect(launches()).toHaveLength(0);
  });

  it("closes a running dispatch once and its wait ends cancelled", async () => {
    const placed = await service().dispatch({ ...brief, idempotencyKey: "gitboy:host:close" });
    const closePane = vi.fn(async () => undefined);
    const restore = setTerminalProvider({
      snapshot: async () => ({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
        terminal_id: "term-1", agent: target.source, agent_status: "working" }] }),
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
    const placed = await service().dispatch({ ...brief, idempotencyKey: key });
    const closePane = vi.fn(async () => undefined);
    const restore = setTerminalProvider({
      snapshot: async () => ({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
        terminal_id: "term-1", agent: target.source, agent_status: "working" }] }),
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
});
