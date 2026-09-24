import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus } from "./dispatch.js";
import { addGrant } from "./grants.js";
import { BridgeError } from "./protocol.js";
import { hookPeers, peerRequest } from "./peers.js";
import { hookRequest } from "./client.js";
import { isLocalComputer } from "./dispatch-hosts.js";

vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
// This computer is "Laptop" and its own Hook is faked: tests never reach a real Hook.
vi.mock("./computer-names.js", () => ({ localNames: () => ["Laptop.example.net", "Laptop"] }));
vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", starting: true, startingToken: "a".repeat(64) };
const brief = { computer: "anywhere", project: "phren", harness: "codex", prompt: "A private worker brief", label: "Tests" };
const remoteID = "30000000-0000-4000-8000-000000000001";
const localID = "30000000-0000-4000-8000-000000000009";

describe("dispatch receipts and selection", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.mocked(hookPeers).mockResolvedValue(["Desk", "Linuxbox"].map(name => ({ name, address: "desk.example", username: "sam", port: 22, hostKey: "unused", server: "default" })));
    vi.mocked(peerRequest).mockImplementation(async (peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: peer.name === "Desk" ? 3 : 1 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
    // Busier than any peer unless a test says otherwise.
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 9 }
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
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
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
    vi.mocked(hookRequest).mockRejectedValue(new BridgeError(503, "Local Hook not running"));
    await expect(new DispatchService().dispatch({ ...brief, computer: "Desk" })).rejects.toThrow("Key not enrolled");
    const none = await new DispatchService().dispatch(brief).catch(error => error);
    expect(none).toBeInstanceOf(BridgeError);
    expect(none.message).toContain("No enrolled computer");
    // Every peer that sat out placement is named with its reason.
    expect(none.details).toEqual({ skipped: [{ computer: "Desk", reason: "Key not enrolled" }, { computer: "Laptop", reason: "Local Hook not running" },
      { computer: "Linuxbox", reason: "Key not enrolled" }] });
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { target } : { ok: true, deliveryUncertain: true });
    expect(await new DispatchService().dispatch(brief)).toMatchObject({ computer: "Desk", state: "uncertain" });
  });

  it("excludes offline peers and refuses a peer without Herdr before launching", async () => {
    vi.mocked(peerRequest).mockImplementation(async (peer, route) => {
      if (peer.name === "Desk") throw new BridgeError(503, "Offline");
      return route === "/v1/dispatch/capacity" ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 2 }
        : route.startsWith("/v1/workspaces/launch") ? { target } : { ok: true };
    });
    const placed = await new DispatchService().dispatch(brief);
    expect(placed).toMatchObject({ computer: "Linuxbox", state: "accepted", skipped: [{ computer: "Desk", reason: "Offline" }] });
    expect((await dispatchStatus())[0].skipped).toEqual([{ computer: "Desk", reason: "Offline" }]);
    vi.mocked(peerRequest).mockResolvedValue({ product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: [], working: 0 });
    await expect(new DispatchService().dispatch({ ...brief, computer: "Desk" })).rejects.toThrow("Herdr is not running");
  });

  it("retains ambiguous launches and refuses to prompt a mismatched target", async () => {
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
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
    release({ product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 });
    expect(await first).toMatchObject({ ok: true });
  });

  it("rejects invalid briefs and unknown targets before opening any connection", async () => {
    await expect(new DispatchService().dispatch({ ...brief, project: "../phren" })).rejects.toThrow();
    await expect(new DispatchService().dispatch({ ...brief, prompt: "x".repeat(32769) })).rejects.toThrow();
    await expect(new DispatchService().dispatch({ ...brief, computer: "Missing" })).rejects.toThrow("Unknown computer");
    expect(peerRequest).not.toHaveBeenCalled();
  });

  it("validates and persists an explicit parent with the remote computer identity", async () => {
    const computerID = "10000000-0000-4000-8000-000000000001";
    const parentTarget = { server: "default", workspace: "parent-w", tab: "parent-t", pane: "parent-p", source: "codex" as const,
      session: "aaaaaaaa-1111-4111-8111-111111111111" };
    const parent = { provider: "codex" as const, session: parentTarget.session, computer: computerID };
    const validateParentTarget = vi.fn(async () => ({}));
    const result = await new DispatchService({ computerID, validateParentTarget }).dispatch({
      ...brief, computer: "Desk", parent, parentTarget,
    });
    expect(validateParentTarget).toHaveBeenCalledWith(parentTarget);
    expect(result).toMatchObject({ parent, parentTarget, computerId: remoteID });
    const stored = JSON.parse(await readFile(path.join(root, `dispatches/${result.id}.json`), "utf8"));
    expect(stored).toMatchObject({ parent, parentTarget, computerId: remoteID });
  });

  it("records granted on a matching receipt and leaves it off when no grant covers the call", async () => {
    expect((await new DispatchService().dispatch({ ...brief, computer: "Desk" })).granted).toBeUndefined();
    await addGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"] }, root);
    const granted = await new DispatchService().dispatch({ ...brief, computer: "Desk" });
    expect(granted).toMatchObject({ ok: true, granted: "project:phren" });
    // A computers-restricted grant never covers a peer outside its list.
    vi.mocked(hookPeers).mockResolvedValue(["Desk", "Linuxbox"].map(name => ({ name, address: "desk.example", username: "sam", port: 22, hostKey: "unused", server: "default" })));
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
    const other = await new DispatchService().dispatch({ ...brief, computer: "Linuxbox" });
    expect(other.granted).toBeUndefined();
  });
});

describe("dispatch to this computer", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-local-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("places on this computer through its own Hook with no hooks.yaml and no SSH", async () => {
    vi.mocked(hookPeers).mockRejectedValue(new BridgeError(409, "Configure peers and verified host keys in the Hook's hooks.yaml first."));
    for (const name of ["Laptop", "laptop.example.net", "local"]) {
      const result = await new DispatchService().dispatch({ ...brief, computer: name });
      expect(result).toMatchObject({ ok: true, state: "accepted", computer: "Laptop", computerId: localID, target });
    }
    expect(vi.mocked(peerRequest)).not.toHaveBeenCalled();
    const routes = vi.mocked(hookRequest).mock.calls.map(call => call[0]);
    expect(routes.filter(route => route.startsWith("/v1/workspaces/launch"))).toHaveLength(3);
    expect(vi.mocked(hookRequest).mock.calls.find(call => call[0] === "/v1/prompt")?.[1]).toEqual({ target, text: brief.prompt });
  });

  it("still refuses an unknown computer when hooks.yaml is missing", async () => {
    vi.mocked(hookPeers).mockRejectedValue(new BridgeError(409, "Configure peers and verified host keys in the Hook's hooks.yaml first."));
    await expect(new DispatchService().dispatch({ ...brief, computer: "Desk" })).rejects.toThrow("hooks.yaml");
    expect(vi.mocked(hookRequest)).not.toHaveBeenCalled();
  });

  it("lets anywhere choose this computer when it is the least busy", async () => {
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Linuxbox", address: "linuxbox.example", username: "sam", port: 22, hostKey: "unused", server: "default" }]);
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 4 } : { ok: true });
    expect(await new DispatchService().dispatch(brief)).toMatchObject({ ok: true, computer: "Laptop" });
  });

  it("matches this computer by any of its names, never another's", () => {
    const names = ["Mac.example.net", "Mac", "Sams-Mac"];
    for (const name of ["Mac", "mac.example.net", "MAC.attlocal.net", "Sams-Mac.local", "local"]) expect(isLocalComputer(name, names)).toBe(true);
    for (const name of ["Linuxbox", "Desk", "MacBookPro", ""]) expect(isLocalComputer(name, names)).toBe(false);
  });
});

