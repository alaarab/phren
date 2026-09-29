import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchProjectDirectory, dispatchStatus } from "./dispatch.js";
import { getMachineName } from "../machine-identity.js";
import { addGrant, removeGrant } from "./grants.js";
import { BridgeError } from "./protocol.js";
import { hookPeers, peerRequest } from "./peers.js";
import { hookRequest } from "./client.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { DispatchReturns } from "./dispatch-returns.js";

vi.mock("./peers.js", () => {
  const hookPeers = vi.fn();
  return { hookPeers, peerRequest: vi.fn(), optionalHookPeers: async () => ({ peers: await hookPeers().catch(() => []) }) };
});
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
    // The brief is offered with the launch; this Hook did not take it there, so it is typed, once per delivery id.
    expect(calls.find(call => call[1].startsWith("/v1/workspaces/launch"))?.[2]).toEqual({ project: "phren", kind: "codex", label: "Tests", model: undefined,
      brief: { id: result.id, text: brief.prompt } });
    expect(calls.at(-1)?.[2]).toEqual({ target, text: brief.prompt, deliveryId: `dispatch-${result.id}` });
    expect(result.brief).toBe("typed");
    const stored = await readFile(path.join(root, `dispatches/${result.id}.json`), "utf8");
    expect(stored).not.toContain(brief.prompt);
    expect((await dispatchStatus())[0]).toMatchObject({ state: "accepted", computer: "Linuxbox" });
  });

  it("launches the worker with the dispatch's model and effort and keeps them on the receipt", async () => {
    const result = await new DispatchService().dispatch({ ...brief, model: "gpt-5.6-terra", effort: "high" });
    const launch = vi.mocked(peerRequest).mock.calls.find(call => call[1].startsWith("/v1/workspaces/launch"))?.[2];
    expect(launch).toMatchObject({ kind: "codex", model: "gpt-5.6-terra", effort: "high" });
    expect((await dispatchStatus())[0]).toMatchObject({ id: result.id, model: "gpt-5.6-terra", effort: "high" });
    await expect(new DispatchService().dispatch({ ...brief, effort: "turbo" } as never)).rejects.toThrow();
  });

  describe("permission mode", () => {
    const launchBody = () => vi.mocked(peerRequest).mock.calls.find(call => call[1].startsWith("/v1/workspaces/launch"))?.[2] as Record<string, unknown>;
    it("goes to the launch, stays on the receipt and needs no note from a Hook that applied it", async () => {
      vi.mocked(peerRequest).mockImplementation(async (peer, route) => route === "/v1/dispatch/capacity"
        ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: peer.name === "Desk" ? 3 : 1 }
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target, permissionMode: "auto-edits" } : { ok: true });
      const result = await new DispatchService().dispatch({ ...brief, permissionMode: "auto-edits" });
      expect(launchBody()).toMatchObject({ kind: "codex", permissionMode: "auto-edits" });
      expect(result).toMatchObject({ state: "accepted", permissionMode: "auto-edits" });
      expect(result.error).toBeUndefined();
      expect((await dispatchStatus())[0]).toMatchObject({ id: result.id, permissionMode: "auto-edits" });
    });

    it("sends nothing when no mode was asked for, and rejects an unknown one", async () => {
      await new DispatchService().dispatch(brief);
      expect(launchBody()).not.toHaveProperty("permissionMode");
      await expect(new DispatchService().dispatch({ ...brief, permissionMode: "yolo" } as never)).rejects.toThrow();
    });

    it("notes on the receipt that an older Hook ignored it, and keeps going", async () => {
      const result = await new DispatchService().dispatch({ ...brief, permissionMode: "full-access" });
      expect(result).toMatchObject({ state: "accepted", permissionMode: "full-access", error: expect.stringContaining("older and ignored permissionMode") });
      expect((await dispatchStatus())[0].error).toContain("Update its Hook");
    });

    // conductor.yaml must be mode 0600; Windows files carry no POSIX mode bits.
    it.skipIf(process.platform === "win32")("caps an agent at its grant's ceiling, auto by default, and never caps the owner", async () => {
      const agent = { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p1" };
      // An agent with no grant gets up to auto, never full-access.
      await expect(new DispatchService().dispatch({ ...brief, computer: "Desk", permissionMode: "auto" }, agent)).resolves.toMatchObject({ state: "accepted" });
      await expect(new DispatchService().dispatch({ ...brief, computer: "Desk", permissionMode: "full-access" }, agent)).rejects.toMatchObject({ status: 403 });
      // A grant with no ceiling keeps that default.
      await addGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"] }, root);
      await expect(new DispatchService().dispatch({ ...brief, computer: "Desk", permissionMode: "full-access" }, agent)).rejects.toMatchObject({ status: 403 });
      const receipts = (await dispatchStatus()).length;
      // A lower ceiling binds; the refusal saves no receipt and launches nothing.
      await removeGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"] }, root);
      await addGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"], maxPermissionMode: "auto-edits" }, root);
      await expect(new DispatchService().dispatch({ ...brief, computer: "Desk", permissionMode: "auto" }, agent)).rejects.toMatchObject({ status: 403 });
      expect(await dispatchStatus()).toHaveLength(receipts);
      // A grant that names full-access allows it.
      await removeGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"] }, root);
      await addGrant({ scope: "project:phren", actions: ["dispatch"], computers: ["Desk"], maxPermissionMode: "full-access" }, root);
      await expect(new DispatchService().dispatch({ ...brief, computer: "Desk", permissionMode: "full-access" }, agent)).resolves.toMatchObject({ state: "accepted" });
      // The owner (no pane) is never capped, grant or not.
      await expect(new DispatchService().dispatch({ ...brief, computer: "Linuxbox", permissionMode: "full-access" })).resolves.toMatchObject({ state: "accepted" });
    });

    it("refuses OpenCode before a receipt is saved", async () => {
      await expect(new DispatchService().dispatch({ ...brief, harness: "opencode", permissionMode: "auto" })).rejects.toMatchObject({ status: 400 });
      expect(await dispatchStatus()).toEqual([]);
      expect(vi.mocked(peerRequest).mock.calls.filter(call => call[1].startsWith("/v1/workspaces/launch"))).toHaveLength(0);
    });
  });

  describe("account targeting", () => {
    const claude = { ...brief, harness: "claude", account: "work" };
    const inventory = (accounts: { id: string; usable: boolean; reason?: string }[]) => [{ source: "claude", installed: true, usable: true, accounts }];
    const capacityFor = (harnesses: unknown, working: number) => ({ product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working, ...(harnesses ? { harnesses } : {}) });

    it("anywhere skips computers without the account, lists why, and launches with the account", async () => {
      vi.mocked(peerRequest).mockImplementation(async (peer, route) => {
        if (route === "/v1/dispatch/capacity") {
          // Desk is the least busy but has no work account; Linuxbox is older and reports nothing.
          if (peer.name === "Desk") return capacityFor(inventory([{ id: "default", usable: true }]), 0);
          return capacityFor(undefined, 0);
        }
        return route.startsWith("/v1/workspaces/launch") ? { ok: true, target: { ...target, source: "claude" } } : { ok: true };
      });
      vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/dispatch/capacity"
        ? { ...capacityFor(inventory([{ id: "default", usable: true }, { id: "work", usable: true }]), 9), computer: { id: localID } }
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target: { ...target, source: "claude" } } : { ok: true });
      const result = await new DispatchService().dispatch(claude);
      expect(result).toMatchObject({ computer: "Laptop", account: "work", state: "accepted" });
      expect(result.skipped.map((item: { computer: string }) => item.computer)).toEqual(["Desk", "Linuxbox"]);
      expect(result.skipped[0].reason).toContain('No claude account "work"');
      expect(vi.mocked(hookRequest).mock.calls.find(call => call[0].startsWith("/v1/workspaces/launch"))?.[1]).toMatchObject({ kind: "claude", account: "work" });
      expect((await dispatchStatus())[0]).toMatchObject({ account: "work" });
    });

    it("an older computer without harnesses stays eligible when no account is asked for", async () => {
      vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity" ? capacityFor(undefined, 0)
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
      expect(await new DispatchService().dispatch(brief)).toMatchObject({ computer: "Desk", state: "accepted" });
      const error = await new DispatchService().dispatch({ ...brief, harness: "claude", account: "work" }).catch(e => e);
      expect(error).toBeInstanceOf(BridgeError);
      expect(error.message).toContain("account work");
    });

    it("a named older computer without harnesses refuses a non-default account before launching", async () => {
      vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity" ? capacityFor(undefined, 0)
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
      await expect(new DispatchService().dispatch({ ...claude, computer: "Desk" })).rejects.toThrow("does not report harnesses");
      expect(vi.mocked(peerRequest).mock.calls.some(call => call[1].startsWith("/v1/workspaces/launch"))).toBe(false);
      expect(await new DispatchService().dispatch({ ...brief, computer: "Desk" })).toMatchObject({ computer: "Desk", state: "accepted" });
    });

    it("a named computer that reports the account unusable fails before launching", async () => {
      vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
        ? capacityFor(inventory([{ id: "default", usable: true }, { id: "work", usable: false, reason: "Not signed in" }]), 0) : { ok: true });
      await expect(new DispatchService().dispatch({ ...claude, computer: "Desk" })).rejects.toThrow("Desk cannot run claude account work: Not signed in");
      expect(vi.mocked(peerRequest).mock.calls.some(call => call[1].startsWith("/v1/workspaces/launch"))).toBe(false);
    });

    it("rejects a malformed account", async () => {
      await expect(new DispatchService().dispatch({ ...claude, account: "../x" })).rejects.toThrow();
    });
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

  // Seen 2026-09-24 on a loaded Mini: a fresh Claude pane read `unknown` to Herdr for
  // a while, the Hook refused the brief ("needs input in the terminal first") before
  // typing anything, and the dispatch was left uncertain with no brief sent.
  function refusingWhileUnknown(statuses: string[]) {
    let prompts = 0;
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, target };
      if (route.startsWith("/v1/workspaces/panes")) return { panes: [{ id: target.pane, label: "1", agent: "codex", starting: true, startingToken: target.startingToken, agentStatus: statuses.shift() ?? "idle" }] };
      if (route === "/v1/prompt" && prompts++ === 0) throw new BridgeError(409, "This agent needs input in the terminal first.");
      return { ok: true };
    });
    return () => prompts;
  }

  it("sends the brief once a starting pane Herdr has not classified yet settles", async () => {
    const prompts = refusingWhileUnknown(["unknown", "idle"]);
    const result = await new DispatchService().dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: true, state: "accepted" });
    expect(prompts()).toBe(2);
  }, 15_000);

  // Seen 2026-09-27 on Linuxbox: a Claude worker in a folder it had not trusted
  // held "Quick safety check: do you trust this folder" and the receipt said uncertain.
  it("reports a startup screen as needing the owner, with the brief unsent", async () => {
    const prompts = refusingWhileUnknown(["blocked"]);
    const result = await new DispatchService().dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "failed", target,
      returned: { state: "needs-you", read: false, question: expect.stringContaining("startup screen (folder trust or sign-in)") } });
    expect(result.error).toContain("The brief was not sent.");
    expect(prompts()).toBe(1);
  }, 15_000);

  function launchingWithoutTarget(pane: Record<string, unknown> | undefined) {
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, workspaceId: "w1", tabId: "t1", paneId: "p1", agent: "codex", agentStatus: "idle" };
      if (route.startsWith("/v1/workspaces/panes")) return { panes: pane ? [{ id: "p1", label: "1", agent: "codex", ...pane }] : [] };
      return { ok: true };
    });
  }

  // Seen 2026-09-27: local Codex "send-confirm" sat idle and starting with no brief.
  it("sends the brief to a new agent that has only a starting binding yet", async () => {
    launchingWithoutTarget({ agentStatus: "idle", starting: true, startingToken: target.startingToken });
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: true, state: "accepted", target });
    expect(vi.mocked(peerRequest).mock.calls.find(call => call[1] === "/v1/prompt")?.[2]).toEqual({ target, text: brief.prompt, deliveryId: `dispatch-${result.id}` });
  });

  it("says the brief was not sent when a new agent never shows a target", async () => {
    launchingWithoutTarget({ agentStatus: "idle" });
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.error).toContain("so the brief was not sent");
    expect(vi.mocked(peerRequest).mock.calls.some(call => call[1] === "/v1/prompt")).toBe(false);
    launchingWithoutTarget({ agentStatus: "blocked" });
    expect(await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" }))
      .toMatchObject({ ok: false, state: "failed", returned: { state: "needs-you" } });
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

  // conductor.yaml must be mode 0600; Windows files carry no POSIX mode bits.
  // The Hook that reads it supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("records granted on a matching receipt and leaves it off when no grant covers the call", async () => {
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
    expect(vi.mocked(hookRequest).mock.calls.find(call => call[0] === "/v1/prompt")?.[1]).toEqual({ target, text: brief.prompt, deliveryId: expect.stringMatching(/^dispatch-[a-f0-9-]{36}$/) });
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

  it("finds a named computer by an alias, the way grants do", async () => {
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Linuxbox", address: "linuxbox.example", username: "sam", port: 22, hostKey: "unused", server: "default" }]);
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
    expect(await new DispatchService().dispatch({ ...brief, computer: "linuxbox.example" })).toMatchObject({ computer: "Linuxbox", state: "accepted" });
    await expect(new DispatchService().dispatch({ ...brief, computer: "Studio" })).rejects.toThrow("Unknown computer");
  });

  it("matches this computer by any of its names, never another's", () => {
    const names = ["Mac.example.net", "Mac", "Sams-Mac"];
    for (const name of ["Mac", "mac.example.net", "MAC.attlocal.net", "Sams-Mac.local", "local"]) expect(isLocalComputer(name, names)).toBe(true);
    for (const name of ["Linuxbox", "Desk", "MacBookPro", ""]) expect(isLocalComputer(name, names)).toBe(false);
  });
});


describe("the project folder a dispatch launches in", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-project-")); vi.stubEnv("PHREN_PATH", path.join(root, "store")); vi.stubEnv("PROJECTS_DIR", ""); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const register = async (name: string, config: string) => {
    await mkdir(path.join(root, "store", name), { recursive: true });
    await writeFile(path.join(root, "store", name, "phren.project.yaml"), config);
  };

  // Seen 2026-09-27: Linuxbox refused project phren although the store named
  // its folder under `sourcePaths: omarchy:`, because dispatch read only sourcePath.
  it("takes this computer's sourcePaths entry over the shared sourcePath", async () => {
    const here = path.join(root, "linux", "phren");
    await mkdir(here, { recursive: true });
    await register("phren", `sourcePath: /Users/someone-else/Projects/phren\nsourcePaths:\n  ${JSON.stringify(getMachineName())}: ${here}\n`);
    expect(await dispatchProjectDirectory("phren", path.join(root, "home"))).toBe(await realpath(here));
  });

  it("falls back to a git checkout named after the project in a usual root", async () => {
    await register("phren-apps", "sourcePath: /Users/someone-else/Sites/phren-apps\n");
    const checkout = path.join(root, "home", "Projects", "phren-apps");
    await mkdir(checkout, { recursive: true });
    await expect(dispatchProjectDirectory("phren-apps", path.join(root, "home"))).rejects.toThrow(/Project phren-apps is not on this computer/);
    await mkdir(path.join(checkout, ".git"));
    expect(await dispatchProjectDirectory("phren-apps", path.join(root, "home"))).toBe(await realpath(checkout));
    // No folder anywhere: the refusal names this computer.
    await register("global", "");
    await expect(dispatchProjectDirectory("global", path.join(root, "home"))).rejects.toThrow(/names no folder for/);
  });
});

// Harness audit §2.2: a brief typed into a starting pane was often never
// confirmed. It now goes with the launch, and the worker's own hook confirms
// it by dispatch id.
describe("a brief that went with the launch", () => {
  let root: string;
  const session = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "00000005-1111-4111-8111-111111111111" };
  const accepted = { accepted: { at: "2026-09-27T10:00:05.000Z", target: session } };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-launch-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk", address: "desk.example", username: "sam", port: 22, hostKey: "unused", server: "default" }]);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

  function receiving(launch: Record<string, unknown>, arrivals: unknown[], panes: unknown[] = []) {
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, workspaceId: "w1", tabId: "t1", paneId: "p1", agent: "codex", briefLaunched: true, ...launch };
      if (route.startsWith("/v1/dispatch/arrival")) return { arrival: arrivals.length > 1 ? arrivals.shift() : arrivals[0] };
      if (route.startsWith("/v1/workspaces/panes")) return { panes };
      throw new Error(`Unexpected ${route}`);
    });
  }
  const prompts = () => vi.mocked(peerRequest).mock.calls.filter(call => call[1] === "/v1/prompt");

  it("is accepted when the worker's hook echoes the dispatch id, with nothing typed", async () => {
    receiving({ agentStatus: "working", target }, [{}, { started: accepted.accepted }, accepted]);
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: true, state: "accepted", brief: "launch", target: session });
    expect(vi.mocked(peerRequest).mock.calls.find(call => call[1].startsWith("/v1/dispatch/arrival"))?.[1]).toBe(`/v1/dispatch/arrival?id=${result.id}`);
    expect(prompts()).toHaveLength(0);
  });

  it("waits on a startup screen as needing the owner, and turns accepted once the worker confirms", async () => {
    receiving({ agentStatus: "blocked" }, [{}]);
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "uncertain", brief: "launch", returned: { state: "needs-you", question: expect.stringContaining("startup screen") } });
    expect(result.error).toContain("The brief is queued as its first prompt");
    expect(prompts()).toHaveLength(0);
    // The owner answers the screen; the returns loop asks the worker's computer again.
    receiving({}, [accepted]);
    await new DispatchReturns().confirmArrivals(await hookPeers());
    expect((await dispatchStatus())[0]).toMatchObject({ state: "accepted", target: session });
    expect((await dispatchStatus())[0].error).toBeUndefined();
  });

  it("stays uncertain, not failed, while the worker has not confirmed", async () => {
    receiving({ agentStatus: "idle", target }, [{}], [{ id: "p1", agentStatus: "idle" }]);
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: false, state: "uncertain", brief: "launch", target });
    expect(result.error).toContain("has not confirmed it yet (last status idle)");
    expect(prompts()).toHaveLength(0);
  });
});
