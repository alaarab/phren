import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus } from "./dispatch.js";
import { BridgeError } from "./protocol.js";
import { hookPeers, peerRequest } from "./peers.js";

vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", starting: true, startingToken: "a".repeat(64) };
const brief = { computer: "anywhere", project: "phren", harness: "codex", prompt: "A private worker brief", label: "Tests" };

describe("dispatch receipts and selection", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.mocked(hookPeers).mockResolvedValue(["Desk", "Linuxbox"].map(name => ({ name, address: "desk.example", username: "sam", port: 22, hostKey: "unused", server: "default" })));
    vi.mocked(peerRequest).mockImplementation(async (peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, servers: ["default"], working: peer.name === "Desk" ? 3 : 1 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("chooses the least busy connected peer and sends a project slug and bound first prompt", async () => {
    const result = await new DispatchService().dispatch(brief);
    expect(result).toMatchObject({ ok: true, state: "accepted", computer: "Linuxbox", target });
    const calls = vi.mocked(peerRequest).mock.calls;
    expect(calls.find(call => call[1].startsWith("/v1/workspaces/launch"))?.[2]).toEqual({ project: "phren", kind: "codex", label: "Tests", model: undefined });
    expect(calls.at(-1)?.[2]).toEqual({ target, text: brief.prompt });
    const stored = await readFile(path.join(root, `dispatches/${result.id}.json`), "utf8");
    expect(stored).not.toContain(brief.prompt);
    expect((await dispatchStatus())[0]).toMatchObject({ state: "accepted", computer: "Linuxbox" });
  });

  it("keeps an uncertain target after lost prompt acknowledgement and never retries", async () => {
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, target };
      throw new BridgeError(504, "Reply lost");
    });
    const result = await new DispatchService().dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "uncertain", target });
    expect(vi.mocked(peerRequest).mock.calls.filter(call => call[1] === "/v1/prompt")).toHaveLength(1);
    expect((await dispatchStatus())[0].state).toBe("uncertain");
  });

  it("breaks ties by name and propagates explicit enrollment failures", async () => {
    vi.mocked(peerRequest).mockRejectedValue(new BridgeError(403, "Key not enrolled"));
    await expect(new DispatchService().dispatch({ ...brief, computer: "Desk" })).rejects.toThrow("Key not enrolled");
    await expect(new DispatchService().dispatch(brief)).rejects.toThrow("No enrolled computer");
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { target } : { ok: true, deliveryUncertain: true });
    expect(await new DispatchService().dispatch(brief)).toMatchObject({ computer: "Desk", state: "uncertain" });
  });

  it("excludes offline peers and refuses a peer without Herdr before launching", async () => {
    vi.mocked(peerRequest).mockImplementation(async (peer, route) => {
      if (peer.name === "Desk") throw new BridgeError(503, "Offline");
      return route === "/v1/dispatch/capacity" ? { product: "phren-hook", protocol: 1, servers: ["default"], working: 2 }
        : route.startsWith("/v1/workspaces/launch") ? { target } : { ok: true };
    });
    expect(await new DispatchService().dispatch(brief)).toMatchObject({ computer: "Linuxbox", state: "accepted" });
    vi.mocked(peerRequest).mockResolvedValue({ product: "phren-hook", protocol: 1, servers: [], working: 0 });
    await expect(new DispatchService().dispatch({ ...brief, computer: "Desk" })).rejects.toThrow("Herdr is not running");
  });

  it("retains ambiguous launches and refuses to prompt a mismatched target", async () => {
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, servers: ["default"], working: 0 }
      : { target: { ...target, source: "claude" } });
    const result = await new DispatchService().dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "uncertain" });
    expect(vi.mocked(peerRequest).mock.calls.some(call => call[1] === "/v1/prompt")).toBe(false);
    const file = path.join(root, `dispatches/${result.id}.json`);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...receipt, state: "sending" }));
    expect((await dispatchStatus())[0].state).toBe("uncertain");
  });

  it("admits only one placement while a remote preflight is pending", async () => {
    let release!: (value: Record<string, unknown>) => void;
    vi.mocked(peerRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const service = new DispatchService();
    const first = service.dispatch({ ...brief, computer: "Desk" });
    await expect(service.dispatch({ ...brief, computer: "Desk" })).rejects.toMatchObject({ status: 429 });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release({ product: "phren-hook", protocol: 1, servers: ["default"], working: 0 });
    expect(await first).toMatchObject({ ok: true });
  });

  it("rejects invalid briefs and unknown targets before opening any connection", async () => {
    await expect(new DispatchService().dispatch({ ...brief, project: "../phren" })).rejects.toThrow();
    await expect(new DispatchService().dispatch({ ...brief, prompt: "x".repeat(32769) })).rejects.toThrow();
    await expect(new DispatchService().dispatch({ ...brief, computer: "Missing" })).rejects.toThrow("Unknown computer");
    expect(peerRequest).not.toHaveBeenCalled();
  });
});
