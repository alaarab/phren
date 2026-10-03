// RC regression source only — UNRUN. Only future temporary state and terminal
// transport doubles; never SSH, enrollment, a provider or the owner's live pane.
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const terminal = vi.hoisted(() => ({ bound: vi.fn(), screen: vi.fn(), prompt: vi.fn(), keys: vi.fn() }));
vi.mock("../herdr.js", () => ({ startingPane: terminal.bound }));
vi.mock("../terminal.js", () => ({ terminalProvider: () => ({ readScreen: terminal.screen, prompt: terminal.prompt, sendKeys: terminal.keys }) }));
import { BridgeError } from "../protocol.js";
import { proxyOperation, proxyView, registerProxy, removeProxy, reverseProxyPlan } from "./remote-proxy.js";

let root: string;
const startingToken = "a".repeat(64);
const request = () => ({ id: "ql-copilot", originComputer: "QL", viaPlatform: "omarchy", provider: "copilot", transport: "existing-reverse-ssh-terminal", label: "QL Copilot",
  terminalTarget: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "copilot", starting: true, startingToken }, terminal: "terminal-1", ownerConfirmed: true });
beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-copilot-proxy-"); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  terminal.bound.mockReset().mockResolvedValue({ agent: "copilot", terminal_id: "terminal-1" });
  terminal.screen.mockReset().mockResolvedValue("Copilot terminal output"); terminal.prompt.mockReset(); terminal.keys.mockReset();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("lists an existing Copilot starting pane without manufacturing a native conversation", async () => {
  const registered = await registerProxy(request());
  const listing = await proxyView("Omarchy");
  const row = listing.proxies[0];
  expect(row).toMatchObject({ provider: "copilot", state: "terminal-only", session: null, nativeSession: null, target: null, chatTarget: null, chatSupported: false,
    identity: { localPaneVerified: true, remoteSessionVerified: false, remoteTransportVerified: false } });
  expect(row.terminalTarget?.startingToken).toBe(startingToken);
  const session = await proxyOperation("session", { proxyId: "ql-copilot" });
  expect(session).toMatchObject({ session: null, nativeSession: null, ownerId: registered.attachment.ownerId });
  await expect(proxyOperation("thread", { proxyId: "ql-copilot", session: startingToken })).rejects.toMatchObject({ status: 409, details: { code: "proxy-no-native-session" } });
});
it("refuses chat delivery and controls before any terminal read, typing or optimistic receipt", async () => {
  const registered = await registerProxy(request()), target = { proxyId: "ql-copilot", ownerId: registered.attachment.ownerId };
  for (const operation of ["turn", "thread", "events", "delivery", "approval", "input", "interrupt", "model", "takeover", "start", "keys", "prompt"]) {
    await expect(proxyOperation(operation, { target, text: "owner request", deliveryId: "delivery-1" })).rejects.toMatchObject({ status: 409, details: { code: "proxy-capability-unsupported", operation, supported: false, session: null } });
  }
  expect(terminal.screen).not.toHaveBeenCalled(); expect(terminal.prompt).not.toHaveBeenCalled(); expect(terminal.keys).not.toHaveBeenCalled();
});
it("discards a screen spanning a terminal change and requires fresh owner registration after reconstruction", async () => {
  const registered = await registerProxy(request()), target = { proxyId: "ql-copilot", ownerId: registered.attachment.ownerId };
  expect(await proxyOperation("screen", { target })).toMatchObject({ scope: "terminal-screen", session: null, transcript: false, screen: "Copilot terminal output" });
  terminal.bound.mockReset().mockResolvedValueOnce({ agent: "copilot", terminal_id: "terminal-1" }).mockResolvedValue({ agent: "copilot", terminal_id: "terminal-2" });
  await expect(proxyOperation("screen", { target })).rejects.toMatchObject({ status: 409, details: { code: "proxy-binding-changed" } });
  terminal.bound.mockRejectedValue(new BridgeError(409, "startingToken retired after restart"));
  expect((await proxyView("Omarchy")).proxies[0]).toMatchObject({ state: "binding-changed", terminalTarget: null, session: null, chatTarget: null });
});
it("requires the exact previous registration owner to replace or remove the one attachment", async () => {
  const first = await registerProxy(request());
  await expect(registerProxy(request())).rejects.toMatchObject({ details: { code: "proxy-owner-changed" } });
  const second = await registerProxy({ ...request(), expectedOwnerId: first.attachment.ownerId });
  expect(second.attachment.ownerId).not.toBe(first.attachment.ownerId);
  await expect(removeProxy({ proxyId: "ql-copilot", ownerId: first.attachment.ownerId, ownerConfirmed: true })).rejects.toMatchObject({ details: { code: "proxy-owner-changed" } });
  await expect(proxyOperation("screen", { proxyId: "ql-copilot", ownerId: first.attachment.ownerId })).rejects.toMatchObject({ details: { code: "proxy-owner-changed" } });
  expect(await removeProxy({ proxyId: "ql-copilot", ownerId: second.attachment.ownerId, ownerConfirmed: true })).toMatchObject({ removed: true, tunnelStopped: false, terminalClosed: false });
  expect((await proxyView("Omarchy")).proxies).toEqual([]);
});
it("rejects generic runners and injected session identity instead of promoting them into Copilot", async () => {
  await expect(registerProxy({ ...request(), provider: "codex" })).rejects.toThrow();
  await expect(registerProxy({ ...request(), terminalTarget: { ...request().terminalTarget, session: "00000000-0000-4000-8000-000000000001" } })).rejects.toThrow();
  await expect(registerProxy({ ...request(), entry: { nativeSession: startingToken }, token: "b".repeat(64) })).rejects.toThrow();
  expect((await proxyView("Omarchy")).proxies).toEqual([]);
  expect(terminal.bound).not.toHaveBeenCalled();
  expect(reverseProxyPlan(request())).toMatchObject({ performed: false, commands: [], enrollmentRequired: false, session: null, chatSupported: false });
});
