import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchProjectDirectory, dispatchStatus } from "./dispatch.js";
import { getMachineName } from "../machine-identity.js";
import { addGrant, removeGrant } from "./grants.js";
import { confirmAuthority } from "./authority.js";
import { BridgeError } from "./protocol.js";
import { hookPeers, peerRequest } from "./peers.js";
import { hookRequest } from "./client.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { DispatchReturns } from "./dispatch-returns.js";
import { resetRoleState } from "./conductor-role.js";

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
    expect(calls.filter(call => call[1] === "/v1/prompt").map(call => call[2])).toEqual([{ target, text: brief.prompt, deliveryId: `dispatch-${result.id}` }]);
    expect(result.brief).toBe("typed");
    const stored = await readFile(path.join(root, `dispatches/${result.id}.json`), "utf8");
    expect(stored).not.toContain(brief.prompt);
    expect((await dispatchStatus())[0]).toMatchObject({ state: "accepted", computer: "Linuxbox" });
  });

  it("keeps anywhere on the least busy computer whatever its quota, skipping only an account with none left", async () => {
    const harnesses = [{ source: "codex", installed: true, usable: true },
      { source: "claude", installed: true, usable: true, accounts: [{ id: "default", usable: true }, { id: "work", usable: true }] }];
    const room = (codex: Record<string, unknown>, work: Record<string, unknown> = { leftPercent: 50 }) =>
      [{ source: "codex", account: "default", ...codex }, { source: "claude", account: "work", ...work }];
    const probe = (usage: Record<string, ReturnType<typeof room>>, working: Record<string, number> = {}) =>
      vi.mocked(peerRequest).mockImplementation(async (peer, route) => route === "/v1/dispatch/capacity"
        ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: working[peer.name] ?? 1, usage: usage[peer.name], harnesses }
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
    // Low quota is not avoided: Desk has 3% of its Codex week left and still wins the tie by name.
    probe({ Desk: room({ leftPercent: 3 }), Linuxbox: room({ leftPercent: 90 }) });
    expect(await new DispatchService().dispatch(brief)).toMatchObject({ computer: "Desk" });
    // An account with none left sits out, and the receipt says why.
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    probe({ Desk: room({ leftPercent: 0, exhausted: true, until }), Linuxbox: room({ leftPercent: 90 }) }, { Linuxbox: 2 });
    const placed = await new DispatchService().dispatch(brief);
    expect(placed).toMatchObject({ computer: "Linuxbox", skipped: [{ computer: "Desk", reason: "Its codex has no quota left for about 3 more hours." }] });
    // The Claude work account is judged on its own: Desk's exhausted Codex does not matter to it.
    probe({ Desk: room({ leftPercent: 0, exhausted: true }), Linuxbox: room({ leftPercent: 90 }, { leftPercent: 0, exhausted: true }) });
    expect(await new DispatchService().dispatch({ ...brief, harness: "claude", account: "work" })).toMatchObject({ computer: "Desk" });
    // Nowhere with quota, this computer included: refused with its own code, never placed.
    probe({ Desk: room({ exhausted: true }), Linuxbox: room({ exhausted: true }) });
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: localID }, servers: ["default"], working: 9, usage: room({ exhausted: true }), harnesses } : { ok: true });
    await expect(new DispatchService().dispatch(brief)).rejects.toMatchObject({ status: 503, message: "No connected computer has codex quota left right now.", details: { code: "out_of_quota" } });
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

    it("starts a Copilot worker with the mode, as it does Claude and Codex", async () => {
      const copilot = { ...target, source: "copilot" };
      vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/dispatch/capacity"
        ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target: copilot, permissionMode: "auto" } : { ok: true });
      const result = await new DispatchService().dispatch({ ...brief, harness: "copilot", model: "gpt-6-sol", effort: "high", permissionMode: "auto" });
      expect(launchBody()).toMatchObject({ kind: "copilot", model: "gpt-6-sol", effort: "high", permissionMode: "auto" });
      expect(result).toMatchObject({ state: "accepted", harness: "copilot", permissionMode: "auto" });
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

    // authority.yaml must be mode 0600, as conductor.yaml.
    it.skipIf(process.platform === "win32")("holds an agent to the release authority policy and leaves the owner's dispatch alone", async () => {
      const agent = { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p1" };
      const hub = { ...brief, computer: "Desk", project: "hub" };
      const launches = () => vi.mocked(peerRequest).mock.calls.filter(call => call[1].startsWith("/v1/workspaces/launch")).map(call => call[2] as Record<string, unknown>);
      // hub is ask-first by default: an agent's worker starts at auto-edits, not the receiving default.
      const started = await new DispatchService().dispatch(hub, agent);
      expect(launches().at(-1)).toMatchObject({ project: "hub", permissionMode: "auto-edits" });
      expect(started).toMatchObject({ state: "accepted", permissionMode: "auto-edits", authority: expect.stringContaining("ask-first for merge") });
      await expect(new DispatchService().dispatch({ ...hub, permissionMode: "auto" }, agent)).rejects.toMatchObject({ status: 403 });
      // An ask-first release is refused before any receipt or launch.
      const receipts = (await dispatchStatus()).length, launched = launches().length;
      await expect(new DispatchService().dispatch({ ...hub, releaseActions: ["merge"] }, agent)).rejects.toMatchObject({ status: 403 });
      expect(await dispatchStatus()).toHaveLength(receipts);
      expect(launches()).toHaveLength(launched);
      // The owner's confirmation lets one through, and the receipt says so.
      const confirmation = await confirmAuthority({ project: "hub", actions: ["merge"] }, "phone", root);
      const confirmed = await new DispatchService().dispatch({ ...hub, releaseActions: ["merge"] }, agent);
      expect(confirmed).toMatchObject({ state: "accepted", releaseActions: ["merge"], authorityConfirmed: confirmation.confirmedAt });
      await expect(new DispatchService().dispatch({ ...hub, releaseActions: ["merge"] }, agent)).rejects.toMatchObject({ status: 403 });
      // The owner (no pane) is neither refused nor lowered, and still gets the line to read.
      const owner = await new DispatchService().dispatch({ ...hub, releaseActions: ["merge", "deploy"] });
      expect(owner).toMatchObject({ state: "accepted", authority: expect.stringContaining("hub") });
      expect(launches().at(-1)).not.toHaveProperty("permissionMode");
      // A project the policy does not name is untouched, and its receipt carries no line.
      const plain = await new DispatchService().dispatch({ ...brief, computer: "Desk", releaseActions: ["publish"] }, agent);
      expect(plain.authority).toBeUndefined();
      expect(launches().at(-1)).not.toHaveProperty("permissionMode");
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

  describe("a conductor's set", () => {
    const origin = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
    beforeEach(async () => {
      resetRoleState();
      await writeFile(path.join(root, "conductor-role.json"), JSON.stringify({ version: 1,
        conductor: { server: "default", pane: "w1:p1", workspace: "w1", tab: "w1:t1", since: "2026-09-29T10:00:00.000Z", by: "owner" } }));
      // Linuxbox does not list this computer back.
      vi.mocked(peerRequest).mockImplementation(async (peer, route) => route.startsWith("/v1/dispatch/capacity")
        ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: peer.name === "Desk" ? 3 : 1,
          ...(route.includes("?") ? { knowsCaller: peer.name !== "Linuxbox" } : {}) }
        : route.startsWith("/v1/workspaces/launch") ? { ok: true, target } : { ok: true });
    });
    afterEach(() => resetRoleState());

    it("places a conductor's work only on computers that link back", async () => {
      const result = await new DispatchService().dispatch(brief, origin);
      expect(result).toMatchObject({ ok: true, computer: "Desk", skipped: [{ computer: "Linuxbox", reason: "Linuxbox does not link back. Run phren bridge link Linuxbox." }] });
      expect(vi.mocked(peerRequest).mock.calls.filter(call => call[1].startsWith("/v1/dispatch/capacity")).every(call => call[1].includes("?name="))).toBe(true);
      await expect(new DispatchService().dispatch({ ...brief, computer: "Linuxbox" }, origin)).rejects.toMatchObject({ status: 409, details: { code: "outside_set" } });
    });

    it("leaves other sessions' dispatches as they were", async () => {
      const result = await new DispatchService().dispatch(brief, { ...origin, pane: "w2:p1" });
      expect(result).toMatchObject({ ok: true, computer: "Linuxbox" });
      expect(vi.mocked(peerRequest).mock.calls.some(call => call[1].includes("?name="))).toBe(false);
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
      // The brief, once typed, starts the conversation.
      if (route.startsWith("/v1/workspaces/panes")) return { panes: [{ id: target.pane, label: "1", agent: "codex", agentStatus: statuses.shift() ?? "idle",
        ...(prompts > 1 ? { sessionId: "00000001-1111-4111-8111-111111111111" } : { starting: true, startingToken: target.startingToken }) }] };
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
    // The pane is seen on its startup screen before anything is typed.
    expect(prompts()).toBe(0);
  }, 15_000);

  function launchingWithoutTarget(pane: Record<string, unknown> | undefined, landed: (prompts: number) => Record<string, unknown> | undefined = () => undefined) {
    let prompts = 0;
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, workspaceId: "w1", tabId: "t1", paneId: "p1", agent: "codex", agentStatus: "idle" };
      if (route.startsWith("/v1/workspaces/panes")) return { panes: pane ? [{ id: "p1", label: "1", agent: "codex", ...(landed(prompts) ?? pane) }] : [] };
      if (route === "/v1/prompt") prompts++;
      return { ok: true };
    });
    return () => vi.mocked(peerRequest).mock.calls.filter(call => call[1] === "/v1/prompt").map(call => call[2]);
  }
  const session = "00000001-1111-4111-8111-111111111111";
  const startingPane = { agentStatus: "idle", starting: true, startingToken: target.startingToken };

  // Seen 2026-09-27: local Codex "send-confirm" sat idle and starting with no brief.
  it("sends the brief to a new agent that has only a starting binding yet, and follows the conversation it starts", async () => {
    const prompts = launchingWithoutTarget(startingPane, sent => sent ? { agentStatus: "working", sessionId: session } : undefined);
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    const { starting: _starting, startingToken: _token, ...binding } = target;
    expect(result).toMatchObject({ ok: true, state: "accepted", target: { ...binding, session } });
    expect(prompts()).toEqual([{ target, text: brief.prompt, deliveryId: `dispatch-${result.id}` }]);
  });

  // Seen 2026-09-30 on the Mini (w4E, ios-chat-no-hscroll): the brief typed into a
  // pane still starting vanished, dispatch said accepted, and the pane sat idle for 100 minutes.
  it("waits for a starting pane to read ready before typing the brief", async () => {
    let looks = 0;
    const prompts = launchingWithoutTarget(startingPane, sent => sent ? { agentStatus: "working", sessionId: session }
      : looks++ < 3 ? { ...startingPane, agentStatus: "unknown" } : undefined);
    const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(result).toMatchObject({ ok: true, state: "accepted" });
    expect(prompts()).toHaveLength(1);
    // Every look before the brief went in read the pane still unclassified, but the last.
    expect(looks).toBeGreaterThanOrEqual(4);
  });

  it("types a swallowed brief again under its own delivery id, and fails the dispatch when it never arrives", async () => {
    const twice = launchingWithoutTarget(startingPane, sent => sent >= 2 ? { agentStatus: "working", sessionId: session } : undefined);
    const retried = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(retried).toMatchObject({ ok: true, state: "accepted" });
    expect(twice().map(call => (call as { deliveryId: string }).deliveryId)).toEqual([`dispatch-${retried.id}`, `dispatch-${retried.id}-2`]);
    const never = launchingWithoutTarget(startingPane);
    const lost = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
    expect(never().filter(call => String((call as { deliveryId: string }).deliveryId).includes(lost.id as string))).toHaveLength(2);
    expect(lost).toMatchObject({ ok: false, state: "uncertain", brief: "typed",
      returned: { state: "failed", read: false, error: expect.stringContaining("never reached codex") } });
    expect(lost.error).toContain("after 2 tries the pane still sits idle with no conversation");
    expect((await dispatchStatus()).find(receipt => receipt.id === lost.id)).toMatchObject({ state: "uncertain", returned: { state: "failed" } });
    // Still watched: a brief that lands after all brings the worker's own return.
    vi.mocked(peerRequest).mockImplementation(async (_peer, route, body) => route === "/v1/dispatch/workers"
      ? { workers: (body as { targets: unknown[] }).targets.map(() => ({ state: "done", session, completed: true, reply: "Tests added.", endedAt: new Date().toISOString() })) } : { ok: true });
    await new DispatchReturns({ peers: async () => [{ name: "Desk", address: "desk.example", username: "sam", port: 22, hostKey: "unused", server: "default" }] }).poll();
    const { starting: _starting, startingToken: _token, ...binding } = target;
    expect((await dispatchStatus()).find(receipt => receipt.id === lost.id)).toMatchObject({ target: { ...binding, session },
      returned: { state: "done", read: false, reply: "Tests added." } });
  });

  // Review of #283: on a loaded machine a typed brief can start its turn after
  // the landed window. Typing it again handed the worker its task twice.
  describe("a first brief that lands after its window", () => {
    const late = (after: Record<string, unknown>) => {
      let looks = 0;
      // Idle on the same binding for the whole landed window, then `after`.
      return launchingWithoutTarget(startingPane, sent => sent && looks++ >= 20 ? after : undefined);
    };
    it.each([
      ["working", { ...startingPane, agentStatus: "working" }],
      ["blocked on an approval", { ...startingPane, agentStatus: "blocked" }],
      ["waiting", { ...startingPane, agentStatus: "waiting" }],
    ])("is not typed again into a pane %s", async (_name, after) => {
      const prompts = late(after);
      const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
      expect(result).toMatchObject({ ok: true, state: "accepted", target });
      expect(result).not.toHaveProperty("returned");
      expect(result.error ?? "").not.toContain("startup screen");
      expect(prompts()).toHaveLength(1);
    });
    it("follows the conversation it started instead of typing it again", async () => {
      const prompts = late({ agentStatus: "idle", sessionId: session });
      const result = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
      const { starting: _starting, startingToken: _token, ...binding } = target;
      expect(result).toMatchObject({ ok: true, state: "accepted", target: { ...binding, session } });
      expect(prompts()).toHaveLength(1);
    });
    it("types nothing into a pane it can no longer read as waiting for the brief", async () => {
      const prompts = late({ ...startingPane, agentStatus: "unknown" });
      const unclassified = await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" });
      expect(unclassified).toMatchObject({ ok: false, state: "uncertain" });
      expect(unclassified.error).toContain("was not typed again");
      expect(prompts()).toHaveLength(1);
      const rebound = late({ ...startingPane, startingToken: "b".repeat(64) });
      expect(await new DispatchService(undefined, undefined, 1).dispatch({ ...brief, computer: "Desk" })).toMatchObject({ ok: false, state: "uncertain" });
      expect(rebound().filter(call => String((call as { deliveryId: string }).deliveryId).endsWith("-2"))).toHaveLength(0);
    });
  });

  // Review of #283: the lock was held while a slow brief was confirmed, so a
  // conductor fanning out got 429 on every dispatch for over a minute.
  it("places another dispatch while one brief is still being confirmed, counting it toward its computer's load", async () => {
    const full = { ...(({ starting: _s, startingToken: _t, ...binding }) => binding)(target), session };
    let hold!: () => void, prompts = 0;
    vi.mocked(peerRequest).mockImplementation(async (peer, route) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, target: full };
      if (route === "/v1/prompt" && prompts++ === 0) await new Promise<void>(resolve => { hold = resolve; });
      return { ok: true };
    });
    const service = new DispatchService(undefined, undefined, 1);
    const first = service.dispatch(brief);
    await vi.waitFor(() => expect(hold).toBeTypeOf("function"));
    // Desk and Linuxbox are equally idle; Desk already has a launch in flight.
    expect(await service.dispatch(brief)).toMatchObject({ ok: true, state: "accepted", computer: "Linuxbox" });
    hold();
    expect(await first).toMatchObject({ ok: true, state: "accepted", computer: "Desk" });
    // Nothing in flight: the tie goes back to Desk by name.
    expect(await service.dispatch(brief)).toMatchObject({ computer: "Desk" });
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
