import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as peers from "./peers.js";
import * as harnesses from "./harnesses.js";
import { localMoveAvailability, moveComputers } from "./move-computers.js";
import { recordConductor, recordedConductor, resetRoleState } from "./conductor-role.js";
import { SessionMover, readMove, type MoverDeps } from "./session-move.js";
import { capabilitiesForModules, createRouteHandler, type RouteContext } from "./server-routes.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { admitScopedRequest } from "./scoped-gateway.js";
import { DispatchReturns, observe, workerStates } from "./dispatch-returns.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { peerFingerprint } from "./dispatch-hosts.js";
import { objects, type Json, type Target } from "./protocol.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEWhFCx/BoeHGP4KuXTnSU1szj0tNbYHo3BHMBe4YQ+h";
const from: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "00000003-1111-4111-8111-111111111111" };
const target: Target = { ...from, pane: "w2:p1", workspace: "w2", tab: "w2:t1", session: "00000004-2222-4222-8222-222222222222" };
const A_ID = "70000000-0000-4000-8000-000000000001";
const B_ID = "70000000-0000-4000-8000-000000000002";
const facts = () => ({ computerId: B_ID, hasCheckout: true, harnesses: [{ source: "claude", usable: true, accounts: [
  { id: "default", label: "Personal", usable: true, signedIn: true, fiveHourLeft: 62, weekLeft: 41 },
  { id: "work", label: "Work", usable: true, signedIn: true, fiveHourLeft: 88 },
] }] });
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-move-computer-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  vi.stubEnv("PHREN_PATH", path.join(root, "store"));
  await mkdir(path.join(root, "bridge"));
  await mkdir(path.join(root, "checkout"));
  await mkdir(path.join(root, "store", "repo"), { recursive: true });
  await writeFile(path.join(root, "store", "repo", "summary.md"), "# repo\n");
  await writeFile(path.join(root, "store", "repo", "phren.project.yaml"), `sourcePath: ${path.join(root, "checkout")}\n`);
  await peers.addHookPeer({ name: "remote", address: "remote.test", username: "owner", hostKey: KEY });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRoleState(); await rm(root, { recursive: true, force: true }); });

function fixture(options: { availability?: Json; offline?: boolean; confirmed?: boolean; text?: string; processes?: string[]; reply?: boolean; launchedTarget?: Target } = {}) {
  const sent: Array<{ route: string; data?: Json; timeout?: number }> = [];
  let brief: Json | undefined;
  const launchedTarget = options.launchedTarget ?? target;
  const transport = vi.spyOn(peers, "peerRequest").mockImplementation(async (_peer, route, data, timeout) => {
    sent.push({ route, data, timeout });
    if (options.offline) throw new Error("offline");
    if (route.includes("/availability?")) return options.availability ?? facts();
    if (route.startsWith("/v1/workspaces/launch")) { brief = data?.brief as Json; return { target: launchedTarget, briefLaunched: true }; }
    if (route.startsWith("/v1/dispatch/arrival")) return { arrival: { accepted: { at: new Date().toISOString(), target: launchedTarget } } };
    if (route.startsWith("/v1/workspaces/panes")) return { panes: [{ id: launchedTarget.pane, agentStatus: options.confirmed === false ? "blocked" : "working" }] };
    throw new Error(`Unexpected route ${route}`);
  });
  const pane: Json = { pane_id: from.pane, tab_id: from.tab, workspace_id: from.workspace, terminal_id: "term-1", agent: "claude", agent_status: "idle", cwd: path.join(root, "checkout") };
  const lines: string[] = [JSON.stringify({ type: "user", message: { role: "user", content: `Finish the parser. ${options.text ?? ""}` } })];
  const deliver = vi.fn(async (_target: Target, text: string) => {
    if (options.reply === false) { lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } })); return { ok: true, delivered: true }; }
    const marker = /=== PHREN HANDOFF (\w+) BEGIN ===/.exec(text)?.[1];
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `=== PHREN HANDOFF ${marker} BEGIN ===\n## Goal\n${options.text ?? "Finish the parser."}\n=== PHREN HANDOFF ${marker} END ===` }] } }));
    return { ok: true, delivered: true };
  });
  const terminal = { prompt: vi.fn(), sendKeys: vi.fn(), processes: vi.fn(async () => ({ shellPid: 1, foregroundPids: [] })), closePane: vi.fn() };
  const deps: MoverDeps = { snapshot: async () => ({ panes: [pane] }), identity: async () => from.session, terminal, deliver,
    launch: vi.fn(), inventory: vi.fn(async () => undefined), transcript: async () => lines, git: async () => undefined, processesBelow: async () => options.processes ?? [],
    isConductor: async () => (await recordedConductor())?.pane === from.pane, pollMs: 1 };
  return { mover: new SessionMover(deps), deps, pane, terminal, deliver, transport, sent, brief: () => brief };
}

async function request(mover: SessionMover, method: string, route: string, data: Json = {}, headers = {}) {
  const modules = { has: () => true, modules: BUILTIN_MODULES };
  const capabilities = capabilitiesForModules(modules as never);
  const handler = createRouteHandler({ mover, modules, info: { computer: { id: A_ID, name: "self" }, capabilities }, accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as unknown as RouteContext);
  const req = Readable.from(method === "POST" ? [Buffer.from(JSON.stringify(data))] : []) as IncomingMessage;
  req.method = method; req.url = route; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: JSON.parse(payload) };
}

describe("continue on another computer", () => {
  it("advertises the capability and confirms a peer chat with the full hand-off, preserving the source", async () => {
    const f = fixture();
    expect((await request(f.mover, "GET", "/v1/health")).body.capabilities.moveToComputer).toBe(true);
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote", account: "work" } });
    expect(answer.status).toBe(200);
    await f.mover.settled(from.server, from.pane);
    const moved = await readMove(answer.body.move.id);
    expect(moved, JSON.stringify(moved)).toMatchObject({ state: "moved", mode: "new-chat", placement: "peer", to: { computer: "remote", account: "work" }, handedOffTo: { computer: "remote", target } });
    expect(f.brief()?.text).toContain("Finish the parser.");
    expect(f.brief()?.text).toContain("different checkout");
    expect(f.sent.find(call => call.route.startsWith("/v1/workspaces/launch"))?.data).toMatchObject({ project: "repo", kind: "claude", account: "work" });
    expect(f.terminal.prompt).not.toHaveBeenCalled(); expect(f.terminal.sendKeys).not.toHaveBeenCalled(); expect(f.terminal.closePane).not.toHaveBeenCalled();
    expect(f.deps.launch).not.toHaveBeenCalled(); expect(f.pane.agent).toBe("claude");
    // The receiving Hook reports the relocation without looking for the peer pane locally.
    const state = await workerStates({ targets: [from] }, { snapshot: async () => ({ panes: [f.pane] }), moves: async () => [moved!] } as never);
    expect(state.workers[0]).toMatchObject({ state: "unknown", moved: { to: { computer: "remote" } } });
    const receipt = { id: "old", computer: "local", harness: "claude", target: from } as Receipt;
    observe(receipt, state.workers[0], Date.now(), await peers.hookPeers());
    expect(receipt).toMatchObject({ computer: "remote", target });
  });

  it.each([
    ["offline", undefined, true, "offline"],
    ["no checkout", { ...facts(), hasCheckout: false }, false, "no checkout"],
    ["harness unavailable", { hasCheckout: true, harnesses: [] }, false, "not usable"],
    ["account unavailable", facts(), false, "not usable"],
  ] as const)("refuses %s before asking the source", async (name, availability, offline, error) => {
    const f = fixture({ availability, offline });
    await expect(f.mover.start({ target: from, to: { harness: "claude", computer: "remote", ...(name === "account unavailable" ? { account: "missing" } : {}) } }, { owner: true })).rejects.toThrow(error);
    expect(f.deliver).not.toHaveBeenCalled(); expect(f.sent.some(row => row.route.includes("/launch"))).toBe(false);
  });

  it.each([[{}, { origin: "agent" }], [{ "x-phren-origin": "peer" }, {}]] as const)("refuses agent and peer initiated cross-computer moves", async (headers, origin) => {
    const f = fixture();
    expect((await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" }, ...origin }, headers)).status).toBe(403);
    expect(f.transport).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
    expect((await request(f.mover, "GET", "/v1/sessions/move/computers?project=repo", {}, { "x-phren-origin": "peer" })).status).toBe(403);
  });

  it.each(["gitboy-read", "gitboy-write"] as const)("scoped %s keys cannot list or move chats", scope => {
    for (const line of ["GET /v1/sessions/move/computers?project=repo", "GET /v1/sessions/move/availability?project=repo", "POST /v1/sessions/move"]) {
      expect(admitScopedRequest(scope, `${line} HTTP/1.1\r\nHost: phren.local\r\nContent-Length: 0\r\n\r\n`)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses unknown peers with 404 and cross-computer conductors with 409 before launch", async () => {
    const f = fixture();
    expect((await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "codex", computer: "unknown" } })).status).toBe(404);
    await recordConductor(from.server, f.pane, "owner", from.session);
    const old = await recordedConductor();
    const result = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" } });
    expect(result.status).toBe(409); expect(result.body.error).toContain("local to each Hook");
    expect(await recordedConductor()).toEqual(old); expect(f.deliver).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it("keeps the source open and unannotated when the peer is blocked after launch", async () => {
    const f = fixture({ confirmed: false });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "failed" });
    expect((await readMove(move.id))?.handedOffTo).toBeUndefined(); expect(f.pane.agent).toBe("claude"); expect(f.terminal.closePane).not.toHaveBeenCalled();
  });

  it("redacts credentials with a recognizable Authorization header before peer launch", async () => {
    const secret = "ghp_" + "a".repeat(36);
    const f = fixture({ text: `Finish parser. Authorization: Bearer ${secret}` });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(JSON.stringify(f.sent)).not.toContain(secret);
    expect(await readMove(move.id)).toMatchObject({ state: "moved" });
    expect(f.brief()?.text).toContain("Authorization: [redacted]");
  });
});

describe("continuation computers", () => {
  it("lists self, verified peers, offline peers, missing checkouts and safe account room", async () => {
    const f = fixture();
    await peers.addHookPeer({ name: "offline", address: "offline.test", username: "owner", hostKey: KEY });
    await peers.addHookPeer({ name: "empty", address: "empty.test", username: "owner", hostKey: KEY });
    f.transport.mockImplementation(async (peer, _route, _data, timeout) => {
      expect(timeout).toBe(10_000);
      if (peer.name === "offline") throw new Error("offline");
      return { ...facts(), hasCheckout: peer.name !== "empty", token: "must-not-leak" };
    });
    const answer = await moveComputers("repo", "self", async () => facts() as never);
    expect(answer).toMatchObject({ localClaudeLogins: 2, computers: [
      { name: "self", self: true, online: true, hasCheckout: true },
      { name: "remote", self: false, online: true, hasCheckout: true, harnesses: [{ accounts: [{ id: "default", fiveHourLeft: 62, weekLeft: 41 }, { id: "work", fiveHourLeft: 88 }] }] },
      { name: "offline", online: false, hasCheckout: false, harnesses: [] }, { name: "empty", online: true, hasCheckout: false },
    ] });
    expect(JSON.stringify(answer)).not.toMatch(/must-not-leak|signedIn|usable.*signedIn/);
  });

  it("gets hasCheckout and Claude room from the receiving Hook's own checkout and usage", async () => {
    vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: [{ source: "claude", installed: true, usable: true, accounts: [{ id: "work", label: "Work", key: "private-identity", usable: true, signedIn: true }] }] });
    const answer = await localMoveAvailability("repo", async () => ({ accounts: [{ source: "claude", account: { id: "work", label: "Work", key: "private-identity" }, windows: [
      { id: "five_hour", usedPercent: 38 }, { id: "seven_day", usedPercent: 59 },
    ] }] }));
    expect(answer).toMatchObject({ hasCheckout: true, harnesses: [{ source: "claude", accounts: [{ id: "work", fiveHourLeft: 62, weekLeft: 41 }] }] });
    expect(JSON.stringify(answer)).not.toContain("private-identity");
    expect((await localMoveAvailability("absent", async () => ({}))).hasCheckout).toBe(false);
  });
});

describe("review regressions", () => {
  it("omits process argv from the peer hand-off, including short passwords and environment credentials", async () => {
    const f = fixture({ processes: ["12 server --password=hunter2", "13 worker --token tiny-token", "14 FOO_TOKEN=shortsecret runner", "15 fetch --secret tiny-secret --key small-key"] });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved" });
    expect(JSON.stringify(f.sent)).not.toMatch(/hunter2|tiny-token|shortsecret|tiny-secret|small-key|--password|--token|FOO_TOKEN/);
    expect(f.brief()?.text).toContain("4 child processes running");
  });

  it("refuses a credential reconstructed by control-character normalization before sending any peer brief", async () => {
    const f = fixture({ text: "ghp_" + "a".repeat(18) + "\x01" + "a".repeat(18) });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "failed", error: expect.stringContaining("The hand-off contains a credential") });
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
  });

  it("reports and explicitly launches a non-default Claude login when no account is requested", async () => {
    const availability = facts();
    availability.harnesses[0].accounts[0].usable = false;
    const f = fixture({ availability });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    expect(move).toMatchObject({ to: { account: "work" }, accountChoice: expect.stringContaining("work") });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved", to: { account: "work" } });
    expect(f.sent.find(call => call.route.includes("/launch"))?.data).toMatchObject({ account: "work" });
  });

  it("disables peer Copilot with a reason and rejects it before asking for a hand-off", async () => {
    const f = fixture({ availability: { hasCheckout: true, harnesses: [{ source: "copilot", usable: true }] } });
    const listing = await moveComputers("repo", "self", async () => ({ hasCheckout: true, harnesses: [{ source: "copilot", usable: true }] }));
    expect(listing).toMatchObject({ computers: [
      { self: true, harnesses: [{ source: "copilot", usable: true }] },
      { self: false, harnesses: [{ source: "copilot", usable: false, reason: expect.stringContaining("does not confirm") }] },
    ] });
    await expect(f.mover.start({ target: from, to: { harness: "copilot", computer: "remote" } }, { owner: true }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("Copilot") });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
  });

  it("does not route a moved worker's approvals to another SSH account on the same host", async () => {
    const f = fixture();
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    const moved = (await readMove(move.id))!;
    const observation = (await workerStates({ targets: [from] }, { moves: async () => [moved] } as never)).workers[0];
    const enrolled = (await peers.hookPeers())[0];
    const anotherAccount = { ...enrolled, username: "another_owner" };
    const receipt = { id: "old", computer: "worker-source", harness: "claude", target: from } as Receipt;
    observe(receipt, observation, Date.now(), [anotherAccount]);
    expect(receipt.computer).toBe("worker-source");
    expect(receipt.target).toEqual(from);
    expect(receipt.error).toContain("destination identity");
    // The same enrolled OS account still resolves through a different local alias.
    observe(receipt, observation, Date.now(), [{ ...enrolled, name: "same-owner" }]);
    expect(receipt.computer).toBe("same-owner");
    expect(receipt.target).toEqual(target);
  });

  it.each([true, false])("uses the dispatcher's pinned destination identity across differing aliases (identity known: %s)", async known => {
    const f = fixture();
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    const moved = (await readMove(move.id))!;
    const observation = (await workerStates({ targets: [from] }, { moves: async () => [moved] } as never)).workers[0];
    const destination = { ...(await peers.hookPeers())[0], name: "my-destination" };
    // The source's alias collides with another host in the dispatcher's directory.
    const wrong = { ...destination, name: "remote", hostKey: "ssh-ed25519 other-public-key" };
    const source = { ...wrong, name: "worker-source" };
    const directory = [source, wrong, ...(known ? [destination] : [])];
    const id = "60000000-0000-4000-8000-000000000006";
    const now = new Date().toISOString();
    await mkdir(path.join(root, "bridge", "dispatches"), { recursive: true });
    await writeFile(path.join(root, "bridge", "dispatches", `${id}.json`), JSON.stringify({
      id, computer: source.name, harness: "claude", project: "repo", label: "existing worker", state: "accepted", target: from, createdAt: now, updatedAt: now,
    }));
    const request = vi.fn(async (peer: peers.HookPeer, route: string, data?: Json) => {
      if (route === "/v1/approvals/answer") { expect(peer.name).toBe(destination.name); return { ok: true }; }
      expect(route).toBe("/v1/dispatch/workers");
      if (peer.name === source.name) return { workers: [observation] };
      expect(peer.name).toBe(destination.name);
      expect(data).toMatchObject({ targets: [{ ...target, dispatch: move.id }] });
      return { workers: [{ state: "blocked", session: target.session, approval: { actionId: "ask-new", tool: "Bash", at: now } }] };
    });
    const returns = new DispatchReturns({ peers: async () => directory, request, isLocal: () => false });
    await returns.poll();
    const receipt = (await dispatchStatus())[0];
    expect(receipt.computer).toBe(known ? destination.name : source.name);
    expect(peerFingerprint(destination)).toBe(moved.computerFingerprint);
    if (!known) expect(receipt.error).toContain("receipt routing was retained");
    if (known) {
      expect(receipt.moves?.[0].to.computer).toBe(destination.name);
      await returns.poll();
      expect((await dispatchStatus())[0].approval?.actionId).toBe("ask-new");
      await returns.answerApproval(id, { kind: "allow" } as never, "ask-new");
    }
    expect(request.mock.calls.some(([peer]) => peer.name === wrong.name)).toBe(false);
  });
});

const credentialNames = ["password", "passwd", "pwd", "token", "secret", "api-key", "api_key", "auth", "bearer"];
const credentialForms = [
  { name: "flag equals", render: (name: string, value: string) => `--${name}=${value}` },
  { name: "flag space", render: (name: string, value: string) => `--${name} ${value}` },
  { name: "mapping key", render: (name: string, value: string) => `${name}: ${value}` },
  { name: "environment assignment", render: (name: string, value: string) => `${name.toUpperCase()}=${value}` },
  { name: "quoted JSON key and value", render: (name: string, value: string) => `"${name}": "${value} with spaces"` },
  { name: "quoted shell value", render: (name: string, value: string) => `--${name} '${value} with spaces'` },
  { name: "headers", render: (_name: string, value: string) => `Authorization: Bearer ${value}\nAuthorization: Basic ${value}\nBearer ${value}` },
  { name: "Bearer values after auth keys", render: (_name: string, value: string) => `--auth Bearer ${value}\nauth: Bearer ${value}\nAUTH=Bearer ${value}` },
  { name: "URL userinfo", render: (_name: string, value: string) => `https://owner:${value}@example.test/path\npostgres://owner:${value}@db.test/app\nhttps://${value}@example.test/` },
  { name: "prefixed environment key", render: (_name: string, value: string) => `SERVICE_TOKEN=${value}\nAPI_KEY=${value}` },
];

describe("whole outbound hand-off redaction", () => {
  for (const reply of [true, false]) {
    it.each(credentialForms)(`redacts $name in the ${reply ? "agent" : "fallback"} hand-off`, async form => {
      const secrets = credentialNames.map((_name, index) => `z9-v${index},tail${index}`);
      const text = credentialNames.map((name, index) => form.render(name, secrets[index])).join("\n");
      const f = fixture({ text: `Finish the parser.\n${text}`, reply });
      if (!reply) {
        let clock = Date.now();
        f.deps.now = () => clock += 1000;
        f.deps.sleep = async () => {};
      }
      const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" }, handoffTimeoutMs: 5000 }, { owner: true });
      await f.mover.settled(from.server, from.pane);
      expect(await readMove(move.id)).toMatchObject({ state: "moved", handoff: { source: reply ? "agent" : "fallback" } });
      expect(f.brief()?.text).toContain("[redacted]");
      for (const secret of secrets) for (const part of secret.split(",")) expect(JSON.stringify(f.sent)).not.toContain(part);
      expect(f.brief()?.text).toContain("Finish the parser");
    });
  }
});

describe("worker returns home", () => {
  it("routes A→B→A worker returns and approvals locally without a self peer entry", async () => {
    const self = { id: A_ID, name: "dispatcher-a" };
    const onB = fixture();
    vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: [] });
    expect((await request(onB.mover, "GET", "/v1/sessions/move/availability?project=repo")).body.computerId).toBe(A_ID);
    const outward = await onB.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await onB.mover.settled(from.server, from.pane);
    const away = (await readMove(outward.id))!;
    const homeTarget = { ...from, pane: "w1:p9", session: "80000000-0000-4000-8000-000000000008" };
    await peers.addHookPeer({ name: "back-home", address: "home.test", username: "owner", hostKey: KEY.slice(0, -1) + "i" });
    const back = fixture({ availability: { ...facts(), computerId: A_ID }, launchedTarget: homeTarget });
    back.deps.snapshot = async () => ({ panes: [{ pane_id: target.pane, tab_id: target.tab, workspace_id: target.workspace,
      terminal_id: "term-b", agent: "claude", agent_status: "idle", cwd: path.join(root, "checkout") }] });
    back.deps.identity = async () => target.session;
    const inward = await back.mover.start({ target, to: { harness: "claude", computer: "back-home" } }, { owner: true });
    await back.mover.settled(target.server, target.pane);
    const home = (await readMove(inward.id))!;
    expect(home).toMatchObject({ state: "moved", computerId: A_ID });
    const outwardObservation = (await workerStates({ targets: [from] }, { moves: async () => [away] } as never)).workers[0];
    const inwardObservation = (await workerStates({ targets: [target] }, { moves: async () => [home] } as never)).workers[0];
    const peerB = (await peers.hookPeers())[0];
    const id = "90000000-0000-4000-8000-000000000009";
    const now = new Date().toISOString();
    await mkdir(path.join(root, "bridge", "dispatches"), { recursive: true });
    await writeFile(path.join(root, "bridge", "dispatches", `${id}.json`), JSON.stringify({
      id, computer: self.name, computerId: self.id, harness: "claude", project: "repo", label: "round trip", state: "accepted", target: from, createdAt: now, updatedAt: now,
    }));
    let answered = false;
    const localAnswer = vi.fn(async () => { answered = true; });
    const localWorkers = vi.fn(async (input: Json) => {
      if (objects(input.targets)[0].session === from.session) return { workers: [outwardObservation] };
      expect(input).toMatchObject({ targets: [{ ...homeTarget, dispatch: inward.id }] });
      return { workers: [answered ? { state: "done", completed: true, session: homeTarget.session, hook: true, endedAt: now, reply: "Finished on A." }
        : { state: "blocked", session: homeTarget.session, approval: { actionId: "home-ask", tool: "Bash", at: now } }] };
    });
    const remoteWorkers = vi.fn(async (peer: peers.HookPeer, route: string, input?: Json) => {
      expect(peer.name).toBe(peerB.name);
      expect(route).toBe("/v1/dispatch/workers");
      expect(input).toMatchObject({ targets: [{ ...target, dispatch: outward.id }] });
      return { workers: [inwardObservation] };
    });
    const returns = new DispatchReturns({ localComputer: self, peers: async () => [peerB], request: remoteWorkers,
      isLocal: computer => computer === self.name, localWorkers, localAnswer });
    await returns.poll();
    expect((await dispatchStatus())[0]).toMatchObject({ computer: peerB.name, target });
    await returns.poll();
    expect((await dispatchStatus())[0]).toMatchObject({ computer: self.name, computerId: A_ID, target: homeTarget });
    await returns.poll();
    expect((await dispatchStatus())[0].approval?.actionId).toBe("home-ask");
    await returns.answerApproval(id, { kind: "allow" } as never, "home-ask");
    expect(localAnswer).toHaveBeenCalledWith(homeTarget, "home-ask", { kind: "allow" });
    await returns.poll();
    expect((await dispatchStatus())[0].returned).toMatchObject({ state: "done", reply: "Finished on A." });
    expect(remoteWorkers).toHaveBeenCalledTimes(1);
  });
});
