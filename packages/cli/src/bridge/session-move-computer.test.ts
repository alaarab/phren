import * as hookClient from "./client.js";
import * as terminals from "./terminal.js";
import { relocationSupport } from "./worker-relocation.js";
import { writeLaunchBrief, recordBriefArrival } from "./launch-brief.js";
import * as herdr from "./herdr.js";
import { herdrTerminal } from "./terminal-herdr.js";
import { ConductorSuccessionService } from "./conductor-succession.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as peers from "./peers.js";
import * as harnesses from "./harnesses.js";
import { localMoveAvailability, moveComputers } from "./move-computers.js";
import { recordConductor, recordedConductor, resetRoleState } from "./conductor-role.js";
import { SessionMover, conversationCopy, listMoves, readMove, sourceOutOfUsage, targetSummaryBody, type MoverDeps } from "./session-move.js";
import { finalTurnFromLines } from "./schedule-watch.js";
import { capabilitiesForModules, createRouteHandler, type RouteContext } from "./server-routes.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { admitScopedRequest } from "./scoped-gateway.js";
import { DispatchReturns, observe, workerStates } from "./dispatch-returns.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { peerFingerprint } from "./dispatch-hosts.js";
import { setTerminalProvider } from "./terminal.js";
import { continuationPlacement, fetchContinuationConversation, launchContinuation, saveContinuationConversation } from "./continuation-launch.js";
import { redactPeerHandoff } from "./peer-handoff.js";
import { LaunchLimiter } from "./limits.js";
import { BridgeError, objects, type Json, type Target } from "./protocol.js";

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

function fixture(options: { availability?: Json; offline?: boolean; confirmed?: boolean; text?: string; processes?: string[]; reply?: boolean; launchedTarget?: Target; exhausted?: boolean; history?: string[]; recovered?: boolean } = {}) {
  const sent: Array<{ route: string; data?: Json; timeout?: number }> = [];
  let brief: Json | undefined;
  const launchedTarget = options.launchedTarget ?? target;
  const transport = vi.spyOn(peers, "peerRequest").mockImplementation(async (_peer, route, data, timeout) => {
    sent.push({ route, data, timeout });
    if (options.offline) throw new Error("offline");
    if (route.includes("/availability?")) return options.availability ?? facts();
    if (route.startsWith("/v1/sessions/move/launch?id=")) return { state: "placed", result: { target: launchedTarget, briefLaunched: true } };
    if (route.startsWith("/v1/sessions/move/launch")) { brief = data?.brief as Json; return { target: launchedTarget, briefLaunched: true }; }
    if (route.startsWith("/v1/dispatch/arrival")) return { arrival: { accepted: { at: new Date().toISOString(), target: launchedTarget } } };
    if (route.startsWith("/v1/workspaces/panes")) return { panes: [{ id: launchedTarget.pane, agentStatus: options.confirmed === false ? "blocked" : "working" }] };
    throw new Error(`Unexpected route ${route}`);
  });
  const pane: Json = { pane_id: from.pane, tab_id: from.tab, workspace_id: from.workspace, terminal_id: "term-1", agent: "claude", agent_status: "idle", cwd: path.join(root, "checkout") };
  const lines: string[] = [JSON.stringify({ type: "user", message: { role: "user", content: `Finish the parser. ${options.text ?? ""}` } })];
  for (const text of options.history ?? []) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }));
  if (options.exhausted) lines.push(
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Parser half done; tokens.ts still open." }] } }),
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] } }));
  // The limit reset and the chat went on: the agent can answer a hand-off request again.
  if (options.recovered) lines.push(
    JSON.stringify({ type: "user", message: { role: "user", content: "Carry on." } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Back on the parser." }] } }));
  const deliver = vi.fn(async (_target: Target, text: string) => {
    if (options.reply === false) { lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } })); return { ok: true, delivered: true }; }
    const marker = /=== PHREN HANDOFF (\w+) BEGIN ===/.exec(text)?.[1];
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `=== PHREN HANDOFF ${marker} BEGIN ===\n## Goal\n${options.text ?? "Finish the parser."}\n=== PHREN HANDOFF ${marker} END ===` }] } }));
    return { ok: true, delivered: true };
  });
  const terminal = { prompt: vi.fn(), sendKeys: vi.fn(), processes: vi.fn(async () => ({ shellPid: 1, foregroundPids: [] })), closePane: vi.fn() };
  const deps: MoverDeps = { snapshot: async () => ({ panes: [pane] }), identity: async () => from.session, terminal, deliver,
    launch: vi.fn(), inventory: vi.fn(async () => undefined), transcript: async () => lines, conversation: async () => ({ lines, complete: true }), git: async () => undefined, processesBelow: async () => options.processes ?? [],
    isConductor: async () => (await recordedConductor())?.pane === from.pane, pollMs: 1 };
  return { mover: new SessionMover(deps), deps, pane, terminal, deliver, transport, sent, brief: () => brief };
}

async function request(mover: SessionMover, method: string, route: string, data: Json = {}, headers = {}, overrides: Partial<RouteContext> = {}) {
  const modules = { has: () => true, modules: BUILTIN_MODULES };
  const capabilities = capabilitiesForModules(modules as never);
  const handler = createRouteHandler({ mover, modules, info: { computer: { id: A_ID, name: "self" }, capabilities }, accountUsage: { read: async () => ({ accounts: [] }) }, launches: new LaunchLimiter(), streams: {}, ...overrides } as unknown as RouteContext);
  const req = Readable.from(method === "POST" ? [Buffer.from(JSON.stringify(data))] : []) as IncomingMessage;
  req.method = method; req.url = route; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: JSON.parse(payload) };
}

describe.skipIf(process.platform === "win32")("continue on another computer", () => {
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
    expect(f.sent.find(call => call.route.startsWith("/v1/sessions/move/launch"))?.data).toMatchObject({ project: "repo", to: { harness: "claude", account: "work" } });
    expect(f.terminal.prompt).not.toHaveBeenCalled(); expect(f.terminal.sendKeys).not.toHaveBeenCalled(); expect(f.terminal.closePane).not.toHaveBeenCalled();
    expect(f.deps.launch).not.toHaveBeenCalled(); expect(f.pane.agent).toBe("claude");
    // The receiving Hook reports the relocation without looking for the peer pane locally.
    const state = await workerStates({ targets: [from] }, { snapshot: async () => ({ panes: [f.pane] }), moves: async () => [moved!] } as never);
    expect(state.workers[0]).toMatchObject({ state: "unknown", moved: { to: { computer: "remote" } } });
    const receipt = { id: "old", computer: "local", harness: "claude", target: from } as Receipt;
    observe(receipt, state.workers[0], Date.now(), await peers.hookPeers());
    expect(receipt).toMatchObject({ computer: "remote", target });
  });

  it("has the agent on the peer build the hand-off when the source's account is out of usage", async () => {
    const f = fixture({ exhausted: true });
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote", account: "work" } });
    expect(answer.status).toBe(200);
    await f.mover.settled(from.server, from.pane);
    const moved = await readMove(answer.body.move.id);
    expect(moved, JSON.stringify(moved)).toMatchObject({ state: "moved", placement: "peer", continuation: "summary-by-target", handedOffTo: { computer: "remote", target } });
    // The exhausted source is never asked; the peer gets the conversation and is told to summarize it.
    expect(f.deliver).not.toHaveBeenCalled();
    const text = String(f.brief()?.text);
    expect(text).toContain("out of usage");
    expect(text).toContain("Finish the parser.");
    expect(text).toContain("Parser half done; tokens.ts still open.");
    expect(moved?.handoff).toMatchObject({ source: "fallback", reason: expect.stringContaining("out of usage") });
  });

  it("fits a long conversation into the brief as sent, after redaction lengthens it", async () => {
    // Short credential values grow when redacted; the newest turns still fit and the move still goes.
    const history = Array.from({ length: 60 }, (_, i) => `turn ${i} ${"token=x ".repeat(200)}`);
    const f = fixture({ exhausted: true, history });
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" } });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(answer.body.move.id)).toMatchObject({ state: "moved", continuation: "summary-by-target" });
    const text = String(f.brief()?.text);
    expect(text.length).toBeLessThanOrEqual(32_768);
    expect(text).toContain("turn 59 ");
    expect(text).not.toContain("turn 0 ");
    expect(text).not.toContain("token=x");
  });

  it("copies the whole conversation for the destination to pull through the intent route, beside the excerpt", async () => {
    const history = Array.from({ length: 60 }, (_, i) => `turn ${i} ${"y".repeat(2_000)}`);
    const f = fixture({ exhausted: true, history });
    // The copy reads the whole transcript, not the tail the hand-off reads: here an earlier turn only it has.
    const tail = await f.deps.transcript(from);
    f.deps.conversation = async () => ({ lines: [JSON.stringify({ type: "user", message: { role: "user", content: "The very first ask." } }), ...tail], complete: true });
    expect((await request(f.mover, "GET", "/v1/health")).body.capabilities).toMatchObject({ moveSummaryByTarget: true, moveConversationCopy: true });
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" } });
    await f.mover.settled(from.server, from.pane);
    const id = answer.body.move.id as string;
    expect(await readMove(id)).toMatchObject({ state: "moved", continuation: "summary-by-target" });
    // The brief keeps room for the line the destination adds about the copy.
    const brief = String(f.brief()?.text);
    expect(brief.length).toBeLessThanOrEqual(32_768 - 400);
    expect(brief).not.toContain("turn 0 ");
    // The destination, as the move's verified peer, pulls the copy page by page.
    const peer = (await peers.hookPeers())[0];
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (to, route, data, timeout) => route === "/v1/health" ? { computer: { id: B_ID } } : original(to, route, data, timeout));
    const headers = { "x-phren-origin": "peer", "x-phren-peer": Buffer.from(JSON.stringify({ name: peer.name, fingerprint: peerFingerprint(peer) })).toString("base64url") };
    const copy = await fetchContinuationConversation(async offset => {
      const page = await request(f.mover, "GET", `/v1/sessions/move/intent?id=${id}&conversation=${offset}`, {}, headers);
      expect(page.status).toBe(200);
      return page.body;
    }, redactPeerHandoff);
    expect(copy).toContain("The very first ask.");
    expect(copy).toContain("turn 0 ");
    expect(copy).toContain("turn 59 ");
    expect(copy).toContain("Finish the parser.");
    expect(copy).not.toContain("earlier messages are missing");
    expect(copy).not.toContain(path.join(root, "checkout"));
    // The intent itself is unchanged, so an older destination still checks and launches it as before.
    expect((await request(f.mover, "GET", `/v1/sessions/move/intent?id=${id}`, {}, headers)).body.brief).toMatchObject({ id, text: brief });
    // Another peer cannot read it.
    const stranger = { ...headers, "x-phren-peer": Buffer.from(JSON.stringify({ name: "third-peer", fingerprint: peerFingerprint({ ...peer, username: "carol" }) })).toString("base64url") };
    expect((await request(f.mover, "GET", `/v1/sessions/move/intent?id=${id}&conversation=0`, {}, stranger)).status).toBe(403);
    // The move is done, so the next pass over the moves removes its copy; the intent itself stays.
    await listMoves();
    expect((await request(f.mover, "GET", `/v1/sessions/move/intent?id=${id}&conversation=0`, {}, headers)).status).toBe(404);
    expect((await request(f.mover, "GET", `/v1/sessions/move/intent?id=${id}`, {}, headers)).body.brief).toMatchObject({ id });
  });

  it("judges a copy with no readable record by whether its record file exists", async () => {
    const intents = path.join(root, "bridge", "move-intents");
    // Copies with no record: one just written (a move in another process records itself first), one two hours old;
    // and one whose record is there but cannot be read (it may be a running move's).
    const fresh = "b0000000-0000-4000-8000-00000000e001", orphan = "b0000000-0000-4000-8000-00000000e002", unreadable = "b0000000-0000-4000-8000-00000000e003";
    for (const other of [fresh, orphan, unreadable]) await saveContinuationConversation(other, "conversation");
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const other of [orphan, unreadable]) await utimes(path.join(intents, `${other}.conversation.md`), twoHours, twoHours);
    await mkdir(path.join(root, "bridge", "moves"), { recursive: true });
    await writeFile(path.join(root, "bridge", "moves", `${unreadable}.json`), "not a move record");
    await listMoves();
    expect(existsSync(path.join(intents, `${fresh}.conversation.md`))).toBe(true);
    expect(existsSync(path.join(intents, `${orphan}.conversation.md`))).toBe(false);
    expect(existsSync(path.join(intents, `${unreadable}.conversation.md`))).toBe(true);
  });

  it("keeps a running move's copy through a pass over the moves", async () => {
    const f = fixture({ exhausted: true });
    // The destination never confirms the launch: the move stays running.
    const original = f.transport.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.transport.mockImplementation(async (to, route, data, timeout) => {
      if (route.startsWith("/v1/sessions/move/launch?server=")) await held;
      return original(to, route, data, timeout);
    });
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" } });
    const id = answer.body.move.id as string;
    const copy = path.join(root, "bridge", "move-intents", `${id}.conversation.md`);
    await vi.waitFor(async () => expect((await readMove(id))?.state).toBe("uncertain"));
    expect(existsSync(copy)).toBe(true);
    await listMoves();
    expect(existsSync(copy)).toBe(true);
    release();
    await f.mover.settled(from.server, from.pane);
    expect((await readMove(id))?.state).toBe("moved");
    await listMoves();
    expect(existsSync(copy)).toBe(false);
  });

  it("keeps the newest messages of a conversation too long to copy whole, and says what it left out", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ role: "agent" as const, text: `turn ${i} ${"z".repeat(1_000)}` }));
    const copy = conversationCopy(entries, text => text.toUpperCase(), 10_000);
    expect(copy.length).toBeLessThanOrEqual(10_000);
    expect(copy).toContain("TURN 29 ");
    expect(copy).not.toContain("TURN 0 ");
    expect(copy).toMatch(/The first \d+ of its 30 messages did not fit/);
    expect(conversationCopy(entries.slice(0, 2), text => text)).not.toContain("did not fit");
    // Only a transcript's end could be read: the copy says earlier messages are missing.
    expect(conversationCopy(entries.slice(0, 2), text => text, 10_000, false)).toContain("earlier messages are missing");
  });

  it("asks the source as usual once a usage limit has passed and the chat went on", async () => {
    const f = fixture({ exhausted: true, recovered: true });
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" } });
    await f.mover.settled(from.server, from.pane);
    const moved = await readMove(answer.body.move.id);
    expect(moved).toMatchObject({ state: "moved", handoff: { source: "agent" } });
    expect(moved?.continuation).toBeUndefined();
    expect(f.deliver).toHaveBeenCalled();
  });

  it("fits a long conversation into its room, newest turns kept, with room left for the original brief", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "agent" as const : "owner" as const, text: `turn ${i} ${"x".repeat(2_000)}` }));
    const body = targetSummaryBody({ from: "Claude", exhausted: true, entries, room: 10_000 });
    expect(body.length).toBeLessThanOrEqual(10_000);
    expect(body).toContain("turn 39 ");
    expect(body).not.toContain("turn 0 ");
    expect(body.indexOf("turn 38 ")).toBeLessThan(body.indexOf("turn 39 "));
    const withBrief = targetSummaryBody({ from: "Claude", exhausted: true, entries, room: 20_000, original: `Build the tokenizer. ${"y".repeat(3_000)}` });
    expect(withBrief.length).toBeLessThanOrEqual(20_000);
    expect(withBrief).toContain("Build the tokenizer.");
    expect(withBrief).not.toContain("was cut to fit");
    expect(targetSummaryBody({ from: "Claude", exhausted: false, entries, room: 5_000 })).toContain("without asking it for a hand-off");
  });

  it("caps the original brief at 8000 characters, cut after it is redacted", () => {
    const entries = [{ role: "owner" as const, text: "Build the tokenizer." }];
    const original = `${"a".repeat(7_950)} SECRETTOKEN ${"b".repeat(4_000)}`;
    const body = targetSummaryBody({ from: "Claude", exhausted: true, entries, room: 100_000, original,
      prepare: text => text.replaceAll("SECRETTOKEN", "[redacted]") });
    const brief = body.slice(body.indexOf("The original brief follows.\n---\n") + "The original brief follows.\n---\n".length);
    expect(brief.length).toBeLessThanOrEqual(8_000);
    expect(brief).toContain("cut to 8000 characters");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("b".repeat(10));
  });

  it("counts a newer owner message with blocks (text and a screenshot) as the chat going on past a usage limit", () => {
    const limit = JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] } });
    const blocks = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Try again now" }, { type: "image", source: { type: "base64", data: "AA==" } }] } });
    const toolResult = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    expect(sourceOutOfUsage([limit], "claude")).toBe(true);
    expect(sourceOutOfUsage([limit, blocks], "claude")).toBe(false);
    // A tool's result is not the owner moving on.
    expect(sourceOutOfUsage([limit, toolResult], "claude")).toBe(true);
  });

  it("keeps a background shell awaited across an interrupt, and leaves it behind once the owner moves on", () => {
    const launch = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test", run_in_background: true } }] } });
    const started = JSON.stringify({ type: "user", toolUseResult: { backgroundTaskId: "b1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] } });
    // Claude files an Escape as a user row of text blocks; it stops the turn but is not the owner moving on.
    const interrupt = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Now look at the docs" }] } });
    expect(finalTurnFromLines([launch, started], "claude").awaited).toBe(1);
    expect(finalTurnFromLines([launch, started, interrupt], "claude").awaited).toBe(1);
    expect(finalTurnFromLines([launch, started, prompt], "claude").awaited).toBeUndefined();
  });

  it("honours an explicit summary-by-target request and refuses it on this computer", async () => {
    const f = fixture();
    const answer = await request(f.mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", computer: "remote" }, continuation: "summary-by-target" });
    expect(answer.status).toBe(200);
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(answer.body.move.id)).toMatchObject({ state: "moved", continuation: "summary-by-target" });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(String(f.brief()?.text)).toContain("Finish the parser.");
    expect(String(f.brief()?.text)).toContain("without asking it for a hand-off");
    const local = await request(fixture().mover, "POST", "/v1/sessions/move", { target: from, to: { harness: "claude", account: "work" }, continuation: "summary-by-target" });
    expect(local.status).toBe(409);
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
    expect(result.status).toBe(409); expect(result.body.error).toContain("Update this Hook");
    expect(await recordedConductor()).toEqual(old); expect(f.deliver).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it("keeps the source open and unannotated when the peer is blocked after launch", async () => {
    const f = fixture({ confirmed: false });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "uncertain", target });
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

describe.skipIf(process.platform === "win32")("continuation computers", () => {
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
    expect(answer.hasCheckout).toBe(true);
    expect(answer.harnesses.find(row => row.source === "claude")?.accounts?.find(login => login.id === "work")).toMatchObject({ fiveHourLeft: 62, weekLeft: 41 });
    expect(JSON.stringify(answer)).not.toContain("private-identity");
    expect((await localMoveAvailability("absent", async () => ({}))).hasCheckout).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("review regressions", () => {
  it("omits process argv from the peer hand-off, including short passwords and environment credentials", async () => {
    const f = fixture({ processes: ["12 server --password=hunter2", "13 worker --token tiny-token", "14 FOO_TOKEN=shortsecret runner", "15 fetch --secret tiny-secret --key small-key"] });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved" });
    expect(JSON.stringify(f.sent)).not.toMatch(/hunter2|tiny-token|shortsecret|tiny-secret|small-key|--password|--token|FOO_TOKEN/);
    expect(f.brief()?.text).toContain("4 child processes running");
  });

  it("redacts a credential reconstructed by normalization while continuing the move", async () => {
    const f = fixture({ text: "ghp_" + "a".repeat(18) + "\x01" + "a".repeat(18) });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved" });
    expect(String(f.brief()?.text)).not.toContain("ghp_");
    expect(String(f.brief()?.text)).toContain("[redacted]");
  });

  it("reports and explicitly launches a non-default Claude login when no account is requested", async () => {
    const availability = facts();
    availability.harnesses[0].accounts[0].usable = false;
    const f = fixture({ availability });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    expect(move).toMatchObject({ to: { account: "work" }, accountChoice: expect.stringContaining("work") });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved", to: { account: "work" } });
    expect(f.sent.find(call => call.route.includes("/launch"))?.data).toMatchObject({ to: { account: "work" } });
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
    const impostor = { ...destination, name: "same-pin-different-hook", address: "impostor.test" };
    const directory = [source, wrong, impostor, ...(known ? [destination] : [])];
    const id = "60000000-0000-4000-8000-000000000006";
    const now = new Date().toISOString();
    await mkdir(path.join(root, "bridge", "dispatches"), { recursive: true });
    await writeFile(path.join(root, "bridge", "dispatches", `${id}.json`), JSON.stringify({
      id, computer: source.name, harness: "claude", project: "repo", label: "existing worker", state: "accepted", target: from, createdAt: now, updatedAt: now,
    }));
    let verifiedComputerId = B_ID;
    const request = vi.fn(async (peer: peers.HookPeer, route: string, data?: Json) => {
      if (route === "/v1/health") return { computer: { id: peer.name === destination.name ? verifiedComputerId : A_ID } };
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
      for (const changed of ["ssh-account", "hook-id"]) {
        const username = destination.username;
        if (changed === "ssh-account") destination.username = "replacement_owner";
        else verifiedComputerId = A_ID;
        const workerCalls = request.mock.calls.filter(([, route]) => route === "/v1/dispatch/workers").length;
        await expect(returns.answerApproval(id, { kind: "allow" } as never, "ask-new")).rejects.toMatchObject({ status: 503 });
        await returns.poll();
        expect(request.mock.calls.filter(([, route]) => route === "/v1/dispatch/workers")).toHaveLength(workerCalls);
        expect((await dispatchStatus())[0].approval?.actionId).toBe("ask-new");
        destination.username = username; verifiedComputerId = B_ID;
      }
      await returns.answerApproval(id, { kind: "allow" } as never, "ask-new");
    }
    expect(request.mock.calls.some(([peer]) => peer.name === wrong.name)).toBe(false);
  });
});

const credentialNames = ["PGPASSWORD", "apiToken", "secret_key", "aws_secret_access_key", "DB_PASS", "passphrase", "credential", "_authToken", "password", "passwd", "pwd", "token", "secret", "api-key", "api_key", "auth", "bearer"];
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

describe.skipIf(process.platform === "win32")("whole outbound hand-off redaction", () => {
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

describe.skipIf(process.platform === "win32")("worker returns home", () => {
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
      if (route === "/v1/health") return { computer: { id: B_ID } };
      expect(peer.name).toBe(peerB.name);
      expect(route).toBe("/v1/dispatch/workers");
      expect(input).toMatchObject({ targets: [{ ...target, dispatch: outward.id }] });
      return { workers: [inwardObservation] };
    });
    const returns = new DispatchReturns({ localComputer: self, peers: async () => [peerB], request: remoteWorkers,
      isLocal: computer => computer === self.name, localWorkers, localAnswer,
      snapshot: async () => ({ panes: [{ pane_id: homeTarget.pane, workspace_id: homeTarget.workspace, tab_id: homeTarget.tab, agent: "claude", terminal_id: "home-terminal" }] }), identity: async () => homeTarget.session,
      localArrival: async id => id === inward.id ? { id, accepted: { target: homeTarget } } as never : undefined });
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
    expect(remoteWorkers.mock.calls.filter(([, route]) => route === "/v1/dispatch/workers")).toHaveLength(1);
  });
});


describe.skipIf(process.platform === "win32")("owner move admission", () => {
  it("two concurrent starts → exactly one proceeds, the other gets 409", async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([1, 2].map(() => f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true })));
    await f.mover.settled(from.server, from.pane);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409, message: "This session is already being moved." } });
    expect(f.sent.filter(call => call.route.includes("/launch"))).toHaveLength(1);
  });

  it.each(["revoked", "changed"])("revoke the peer while the hand-off waits → no launch and no brief sent (%s)", async change => {
    const f = fixture();
    const original = f.deps.deliver;
    f.deps.deliver = async (...args) => {
      if (change === "revoked") await writeFile(path.join(root, "bridge", "hooks.yaml"), "version: 1\ncomputers: []\n");
      else await writeFile(path.join(root, "bridge", "hooks.yaml"), JSON.stringify({ version: 1, computers: [{ ...(await peers.hookPeers())[0], username: "different-owner" }] }));
      return original(...args);
    };
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "failed" });
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
    expect(f.brief()).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("short credentials", () => {
  it.each([true, false])("redacts every short credential form in the whole outbound prompt (agent: %s)", async reply => {
    const f = fixture({ reply, text: ["password=hunter2", "pwd: x1", "--token abc123", "--token=abc", "--password -p secret", "Authorization: Bearer abc", "bearer xyz", "api_key=k", "X-API-Key: k", "https://owner:tiny@example.test/path", "PGPASSWORD=hunter2", "apiToken=abc123", "secret_key=", "aws_secret_access_key=tiny", "DB_PASS=smol", "passphrase: x", "credential: y", "Cookie: k=v", "mysql -pshortpw", "curl -u user:pw", "--auth user:pw", "_authToken=npmshort"].join("\n") });
    if (!reply) { let clock = Date.now(); f.deps.now = () => clock += 1000; f.deps.sleep = async () => {}; }
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" }, handoffTimeoutMs: 5000 }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved" });
    const prompt = String(f.brief()?.text);
    expect(prompt).not.toMatch(/hunter2|x1|abc123|abc|xyz|tiny|\bsecret\b|--password -p secret|api_key=k|X-API-Key: k/);
    expect(prompt).toContain("--password [redacted]");
  });
});

describe.skipIf(process.platform === "win32")("Claude account picker", () => {
  it("lists all local and peer logins, including unusable accounts, with metadata and only the local current login marked", async () => {
    fixture();
    const local = { ...facts(), harnesses: [{ source: "claude", usable: true, accounts: [
      { id: "default", label: "Personal", email: "me@example.test", plan: "Max", signedIn: true, usable: true, fiveHourLeft: 62, weekLeft: 41, fiveHourResetsAt: "2026-10-17T00:00:00Z", weekResetsAt: "2026-10-20T00:00:00Z" },
      { id: "expired", label: "Expired", signedIn: false, usable: false },
    ] }, { source: "codex", usable: true }] };
    expect(await moveComputers("repo", "self", async () => local as never, "default")).toMatchObject({ computers: [
      { self: true, harnesses: [{ accounts: [{ id: "default", email: "me@example.test", plan: "Max", usable: true, current: true, fiveHourLeft: 62, weekLeft: 41, fiveHourResetsAt: "2026-10-17T00:00:00Z", weekResetsAt: "2026-10-20T00:00:00Z" }, { id: "expired", usable: false, current: false }] }, { source: "codex", usable: true }] },
      { self: false, harnesses: [{ accounts: [{ current: false }, { current: false }] }] },
    ] });
  });

  it("opens an interactive account login pane for the owner and refuses invalid, duplicate and peer-originated adds", async () => {
    vi.stubEnv("HOME", root);
    const f = fixture();
    expect((await request(f.mover, "GET", "/v1/health")).body.capabilities.claudeAccountAdd).toBe(true);
    const panes: Json[] = [];
    const prompt = vi.fn(async () => {});
    const commands: string[] = [];
    vi.spyOn(herdr, "rpc").mockImplementation(async (_server, method, params) => {
      if (method === "pane.process_info") return { process_info: { shell_pid: 42, foreground_process_group_id: 42 } };
      if (method === "pane.send_text") { commands.push(String(params?.text)); return {}; }
      if (method === "pane.send_keys") { expect(params).toMatchObject({ pane_id: "w9:p1", keys: ["Enter"] }); return {}; }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const restore = setTerminalProvider({ shellCommand: herdrTerminal.shellCommand, listPanes: async () => panes, create: async () => { panes.push({ server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p1" }); }, prompt } as never);
    try {
      expect((await request(f.mover, "POST", "/v1/accounts/claude/add", { slug: "work" }, { "x-phren-origin": "peer" })).status).toBe(403);
      for (const slug of ["../../bad", "-work", "--", ""]) expect((await request(f.mover, "POST", "/v1/accounts/claude/add", { slug })).status).toBe(400);
      const answer = await request(f.mover, "POST", "/v1/accounts/claude/add", { slug: "work" });
      expect(answer).toMatchObject({ status: 200, body: { target: { server: "default", pane: "w9:p1" }, terminalOnly: true } });
      expect(commands).toEqual(["phren bridge accounts add -- 'work'"]);
      expect(prompt).not.toHaveBeenCalled();
      expect((await request(f.mover, "POST", "/v1/accounts/claude/add", { slug: "work" })).status).toBe(409);
      expect(commands).toHaveLength(1);
    } finally { restore(); }
  });
});


describe.skipIf(process.platform === "win32")("durable peer continuation launch", () => {
  it("reuses the persisted placement after a lost acknowledgement and rejects changed payloads", async () => {
    const input = { computerId: B_ID, project: "repo", to: { harness: "claude" }, label: "Continue", brief: { id: "a0000000-0000-4000-8000-000000000001", text: "Finish the parser" } };
    const launch = vi.fn(async () => ({ target, briefLaunched: true }));
    const first = await launchContinuation(input, launch);
    const restarted = await import("./continuation-launch.js");
    expect(await restarted.launchContinuation(input, launch)).toEqual(first);
    await expect(launchContinuation({ ...input, label: "Different work" }, launch)).rejects.toMatchObject({ status: 409 });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("never launches again after an uncertain receiving-side creation", async () => {
    const input = { computerId: B_ID, project: "repo", to: { harness: "claude" }, label: "Continue", brief: { id: "a0000000-0000-4000-8000-000000000002", text: "Finish the parser" } };
    const { session: _session, ...paneTarget } = target;
    const launch = vi.fn(async (_input, placed) => { await placed(paneTarget); throw new Error("lost creation reply"); });
    await expect(launchContinuation(input, launch)).rejects.toThrow("lost creation reply");
    await expect(launchContinuation(input, launch)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("uncertain") });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await continuationPlacement(input.brief.id)).toMatchObject({ state: "uncertain", paneTarget, worker: false });
  });

  it("reconciles a source restart by the same move id without launching a second pane", async () => {
    const f = fixture({ confirmed: false });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "uncertain", target });
    const calls = f.sent.filter(call => call.route.includes("/launch"));
    const first = calls[0].data;
    let created = 1;
    f.transport.mockImplementation(async (_peer, route, data) => {
      if (route.includes("/availability?")) return facts();
      if (route.includes("/launch")) { if (JSON.stringify(data) !== JSON.stringify(first)) created++; return { target, briefLaunched: true }; }
      if (route.includes("/arrival")) return { arrival: { accepted: { at: new Date().toISOString(), target } } };
      if (route.includes("/panes")) return { panes: [{ id: target.pane, agentStatus: "working" }] };
      throw new Error(route);
    });
    const restarted = new SessionMover(f.deps);
    await restarted.reconcile();
    await restarted.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "moved", handedOffTo: { target } });
    expect(created).toBe(1);
  });

  it("refuses a dispatched worker before hand-off when its dispatcher cannot acknowledge the relocation protocol", async () => {
    const f = fixture();
    f.deps.paneDispatch = async () => "a0000000-0000-4000-8000-000000000003";
    await expect(f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true })).rejects.toMatchObject({ status: 409, message: "Update the dispatching computer's Phren Hook first" });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
  });
});


describe.skipIf(process.platform === "win32")("owner conductor moves through SessionMover", () => {
  it.each([false, true])("moves a projectless conductor with its role and reconciles a lost activation acknowledgement (%s)", async loseAck => {
    const f = fixture();
    f.pane.cwd = path.join(root, "store");
    await recordConductor(from.server, f.pane, "owner", from.session);
    const destinationRoot = path.join(root, "destination");
    await mkdir(destinationRoot);
    const original = f.transport.getMockImplementation()!;
    let a!: ConductorSuccessionService, b!: ConductorSuccessionService;
    let lost = loseAck;
    let releaseAvailability!: () => void, enteredAvailability!: () => void;
    const held = new Promise<void>(resolve => { releaseAvailability = resolve; });
    const entered = new Promise<void>(resolve => { enteredAvailability = resolve; });
    let firstAvailability = true;
    const home = { name: "original-hook", address: "self.test", username: "owner", port: 22, hostKey: KEY, server: "default" };
    f.transport.mockImplementation(async (peer, route, data, timeout) => {
      const self = peer.address === "self.test";
      const service = self ? a : b;
      const url = new URL(route, "http://hook");
      if (url.pathname === "/v1/sessions/move/availability" && firstAvailability) { firstAvailability = false; enteredAvailability(); await held; }
      if (route === "/v1/health") return { computer: { id: self ? A_ID : B_ID }, capabilities: { moveConductorToComputer: true } };
      if (url.pathname === "/v1/conductor/move/status") return service.status(url.searchParams.get("id")!);
      if (url.pathname === "/v1/conductor/move/prepare") return service.prepare(data);
      if (url.pathname === "/v1/conductor/move/launch") return service.launchIntent(url.searchParams.get("id")!);
      if (url.pathname === "/v1/conductor/move/commit") {
        const answer = await service.activate(data);
        if (lost) { lost = false; throw new Error("lost activation acknowledgement"); }
        return answer;
      }
      if (url.pathname === "/v1/sessions/move/launch" && data) {
        expect(data).toMatchObject({ computerId: B_ID, project: "phren-conductor", worker: false });
        expect(String((data?.brief as Json).text)).toContain("until then don't dispatch or answer workers");
        await b.verifiedLaunch(data!);
      }
      return original(peer, route, data, timeout);
    });
    a = new ConductorSuccessionService({ root: path.join(root, "bridge"), computer: { id: A_ID, name: "self" }, snapshot: f.deps.snapshot,
      validate: async () => f.pane, deliver: f.deliver, checkWorkers: async () => {} });
    b = new ConductorSuccessionService({ root: destinationRoot, computer: { id: B_ID, name: "remote" }, peers: async () => [home],
      snapshot: async () => ({ panes: [] }), validate: async () => ({ pane_id: target.pane, terminal_id: "destination-terminal", agent: "claude", agent_status: "working" }),
      deliver: async () => ({ ok: true, delivered: true }), checkWorkers: async () => {} });
    f.deps.succession = a;
    expect((await request(f.mover, "GET", "/v1/health")).body.capabilities.moveConductorToComputer).toBe(true);
    const starting = f.mover.start({ target: from, to: { harness: "claude", computer: "remote", account: "work" } }, { owner: true });
    await entered;
    await expect(a.call("dispatch", {}, from, async () => ({ ok: true }))).rejects.toMatchObject({ status: 409 });
    releaseAvailability();
    const move = await starting;
    await f.mover.settled(from.server, from.pane);
    if (loseAck) {
      expect(await readMove(move.id)).toMatchObject({ state: "uncertain", target });
      expect((await a.status(move.id)).phase).toBe("committed");
      const restarted = new SessionMover(f.deps);
      await restarted.reconcile(); await restarted.settled(from.server, from.pane);
    }
    expect(await readMove(move.id)).toMatchObject({ state: "moved", handedOffTo: { computer: "remote", target }, modeForced: "conductor" });
    expect(await recordedConductor()).toBeUndefined();
    expect((await b.status(move.id))).toMatchObject({ phase: "committed", target });
    expect(f.terminal.closePane).not.toHaveBeenCalled(); expect(f.terminal.sendKeys).not.toHaveBeenCalled(); expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it("rejects peer-originated conductor call impersonation and scoped account-add/protocol requests", async () => {
    const f = fixture();
    expect((await request(f.mover, "POST", "/v1/conductor/call", { action: "dispatch", data: {}, origin: from }, { "x-phren-origin": "peer" })).status).toBe(403);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const answerApproval = vi.fn(async () => {});
    const overrides = { dispatches: { dispatch }, returns: { answerApproval } } as unknown as Partial<RouteContext>;
    const brief = { computer: "remote", project: "repo", harness: "claude", prompt: "Finish parser", label: "Parser" };
    const approval = { id: A_ID, decision: "approve", actionId: "ask-42" };
    expect((await request(f.mover, "POST", "/v1/dispatch", brief, {}, overrides)).status).toBe(200);
    expect((await request(f.mover, "POST", "/v1/dispatch/approve", approval, {}, overrides)).status).toBe(200);
    expect((await request(f.mover, "POST", "/v1/dispatch", brief, { "x-phren-origin": "peer" }, overrides)).status).toBe(403);
    expect((await request(f.mover, "POST", "/v1/dispatch/approve", approval, { "x-phren-origin": "peer" }, overrides)).status).toBe(403);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(answerApproval).toHaveBeenCalledTimes(1);
    for (const scope of ["gitboy-read", "gitboy-write"] as const) for (const route of ["/v1/accounts/claude/add", "/v1/conductor/move/prepare", "/v1/conductor/move/operate", "/v1/sessions/move/launch"]) {
      expect(admitScopedRequest(scope, `POST ${route} HTTP/1.1\r\nHost: phren.local\r\nContent-Length: 0\r\n\r\n`)).toMatchObject({ ok: false, status: 403 });
    }
  });
});


it.skipIf(process.platform === "win32")("keeps the original dispatcher receipt through an immediate worker relocation before its next poll", async () => {
  const f = fixture();
  const dispatch = "d0000000-0000-4000-8000-000000000001";
  await peers.addHookPeer({ name: "dispatcher", address: "dispatcher.test", username: "owner", hostKey: KEY });
  const dispatcherRoot = path.join(root, "dispatcher"), at = new Date().toISOString();
  await mkdir(path.join(dispatcherRoot, "dispatches"), { recursive: true });
  await writeFile(path.join(dispatcherRoot, "dispatches", `${dispatch}.json`), JSON.stringify({ id: dispatch, computer: "worker", harness: "claude", project: "repo", label: "Original worker", state: "accepted", target, createdAt: at, updatedAt: at }));
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (peer, route, data, timeout) => {
    if (peer.name === "dispatcher") {
      expect(timeout).toBe(5000);
      if (route === "/v1/health") return { computer: { id: A_ID }, capabilities: { workerRelocation: 1 } };
      expect(route).toContain(`/v1/dispatch/relocation?id=${dispatch}&session=${from.session}`);
      const savedBridgeHome = process.env.PHREN_BRIDGE_HOME!;
      try {
        vi.stubEnv("PHREN_BRIDGE_HOME", dispatcherRoot);
        const support = await relocationSupport(dispatch, from.session);
        expect(support).toMatchObject({ known: false, knownDispatch: true, workerRelocation: 1 });
        return support;
      } finally { vi.stubEnv("PHREN_BRIDGE_HOME", savedBridgeHome); }
    }
    return original(peer, route, data, timeout);
  });
  await launchContinuation({ computerId: A_ID, project: "repo", to: { harness: "claude" }, label: "Received worker", worker: true, workerDispatch: dispatch, brief: { id: B_ID, text: "Original worker" } }, async () => ({ target: from, briefLaunched: true }));
  f.deps.paneDispatch = async () => B_ID;
  const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
  await f.mover.settled(from.server, from.pane);
  expect(await readMove(move.id)).toMatchObject({ state: "moved", dispatch: B_ID, workerDispatch: dispatch });
  expect(f.sent.find(call => call.route.includes("/launch"))?.data).toMatchObject({ worker: true, workerDispatch: dispatch });
});


it.skipIf(process.platform === "win32")("retains a peer pane immediately when harness startup fails before its launch reply", async () => {
  const f = fixture();
  const original = f.transport.getMockImplementation()!;
  const { session: _session, ...paneTarget } = target;
  f.transport.mockImplementation(async (peer, route, data, timeout) => {
    if (route.startsWith("/v1/sessions/move/launch?server=")) throw new Error("startup reply lost");
    if (route.startsWith("/v1/sessions/move/launch?id=")) return { state: "uncertain", paneTarget };
    return original(peer, route, data, timeout);
  });
  const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
  await f.mover.settled(from.server, from.pane);
  expect(await readMove(move.id)).toMatchObject({ state: "uncertain", paneTarget, placement: "peer" });
  expect((await readMove(move.id))?.handedOffTo).toBeUndefined();
  expect(f.terminal.closePane).not.toHaveBeenCalled();
});


it.skipIf(process.platform === "win32")("lists projectless conductor accounts without requiring an invented project name", async () => {
  const f = fixture();
  vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: [{ source: "claude", installed: true, usable: true, accounts: [{ id: "work", label: "Work", key: "private-key", signedIn: true, usable: true }] }] });
  const answer = await request(f.mover, "GET", "/v1/sessions/move/computers?conductor=1");
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ localClaudeLogins: 1, computers: [{ self: true, hasCheckout: true }, { self: false, online: true }] });
  expect(JSON.stringify(answer.body)).not.toContain("private-key");
});

describe.skipIf(process.platform === "win32")("reviewed peer authorization and recovery", () => {
  it("accepts existing owner clients without a token and refuses peer owner-only actions", async () => {
    const f = fixture();
    expect((await request(f.mover, "GET", "/v1/sessions/move/computers?project=repo")).status).toBe(200);
    expect((await request(f.mover, "GET", "/v1/sessions/moves")).status).toBe(200);
    const peer = { "x-phren-origin": "peer" };
    for (const [method, route, data] of [
      ["GET", "/v1/sessions/move/computers?project=repo", {}],
      ["POST", "/v1/accounts/claude/add", { slug: "work" }],
      ["POST", "/v1/sessions/move", { target: from, to: { computer: "remote", harness: "claude" } }],
      ["POST", "/v1/sessions/move/launch", { computerId: A_ID }],
      ["POST", "/v1/sessions/move/abort", { id: A_ID }],
    ] as const) expect((await request(f.mover, method, route, data, peer)).status, route).toBe(403);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("withholds account email and plan from peers while retaining owner account discovery", async () => {
    const f = fixture();
    vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: [{ source: "claude", usable: true, installed: true, accounts: [{ id: "work", label: "Work", key: "private", email: "owner@example.test", plan: "Max", usable: true, signedIn: true }] }] });
    const owner = await request(f.mover, "GET", "/v1/sessions/move/availability?project=repo");
    expect(JSON.stringify(owner.body)).toContain("owner@example.test");
    const peer = await request(f.mover, "GET", "/v1/sessions/move/availability?project=repo", {}, { "x-phren-origin": "peer" });
    expect(peer.status).toBe(200);
    expect(peer.body.harnesses[0].accounts[0]).toMatchObject({ id: "work", label: "Work", usable: true });
    expect(JSON.stringify(peer.body)).not.toMatch(/owner@example|"plan"|private/);
  });

  it("does not reserve or fence the conductor for an unauthorized request", async () => {
    const f = fixture();
    await recordConductor(from.server, f.pane, "owner", from.session);
    const reserveCaller = vi.fn(() => () => {});
    f.deps.succession = { reserveCaller } as never;
    await expect(f.mover.start({ target: from, to: { harness: "codex" } })).rejects.toMatchObject({ status: 403 });
    await expect(f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } })).rejects.toMatchObject({ status: 403 });
    expect(reserveCaller).not.toHaveBeenCalled();
  });

  it.each(["brief", "oversized brief", "dispatch"])("refuses a move id colliding with an existing %s before asking the chat", async kind => {
    const f = fixture();
    if (kind !== "dispatch") await writeLaunchBrief({ id: A_ID, text: kind === "oversized brief" ? "x".repeat(70_000) : "Existing work" });
    else {
      await mkdir(path.join(root, "bridge", "dispatches"));
      const at = new Date().toISOString();
      await writeFile(path.join(root, "bridge", "dispatches", `${A_ID}.json`), JSON.stringify({ id: A_ID, computer: "self", harness: "claude", project: "repo", label: "Existing", state: "accepted", createdAt: at, updatedAt: at }));
    }
    await expect(f.mover.start({ id: A_ID, target: from, to: { harness: "claude", computer: "remote" } }, { owner: true })).rejects.toMatchObject({ status: 409 });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
  });

  it("reconciles an abandoned receiving intent as not-placed only after a bounded, successful pane inspection", async () => {
    const input = { computerId: B_ID, project: "repo", to: { harness: "claude" }, label: "Continue", brief: { id: A_ID, text: "Finish the parser" } };
    let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const panes = [{ server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p9", label: `move-${A_ID}` }];
    const restore = setTerminalProvider({ listPanes: async () => panes } as never);
    const launch = vi.fn(async () => { throw new Error("crash before placement persisted"); });
    try {
      await expect(launchContinuation(input, launch, { server: "default" })).rejects.toThrow("crash");
      expect((await continuationPlacement(A_ID))?.state).toBe("uncertain");
      clock += 600_001;
      expect((await continuationPlacement(A_ID))?.state).toBe("uncertain");
      panes.length = 0;
      expect((await continuationPlacement(A_ID))?.state).toBe("not-placed");
      await expect(launchContinuation(input, launch, { server: "default" })).rejects.toMatchObject({ status: 409 });
      expect(launch).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it("ends source recovery when the destination confirms no pane exists after ten minutes", async () => {
    const f = fixture();
    let clock = Date.now(), absent = false;
    f.deps.now = () => clock;
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (peer, route, data, timeout) => {
      if (route.startsWith("/v1/sessions/move/launch?server=")) throw new Error("lost launch");
      if (route.startsWith("/v1/sessions/move/launch?id=")) return { state: absent ? "not-placed" : "uncertain" };
      return original(peer, route, data, timeout);
    });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await f.mover.settled(from.server, from.pane);
    clock += 600_001; absent = true;
    const restarted = new SessionMover(f.deps);
    await restarted.reconcile(); await restarted.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "failed", error: expect.stringContaining("no pane exists") });
    expect(f.terminal.closePane).not.toHaveBeenCalled();
  });

  it("accepts an owner abort before commit, un-fences the old conductor and prevents the pending hand-off launching a successor", async () => {
    const f = fixture(); await recordConductor(from.server, f.pane, "owner", from.session);
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (peer, route, data, timeout) => {
      if (route === "/v1/health") return { computer: { id: B_ID }, capabilities: { moveConductorToComputer: true } };
      if (route === "/v1/conductor/move/prepare") return { ok: true };
      return original(peer, route, data, timeout);
    });
    const service = new ConductorSuccessionService({ root: path.join(root, "bridge"), computer: { id: A_ID, name: "self" }, snapshot: f.deps.snapshot, validate: async () => f.pane, deliver: f.deliver, checkWorkers: async () => {} });
    f.deps.succession = service;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const deliver = f.deliver.getMockImplementation()!;
    f.deliver.mockImplementation(async (...args) => { entered(); await held; return deliver(...args); });
    const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
    await ready;
    expect((await request(f.mover, "POST", "/v1/sessions/move/abort", { id: move.id })).status).toBe(200);
    expect((await service.status(move.id)).phase).toBe("aborted");
    expect(await service.call("grants-list", {}, from, async () => ({ grants: [] }))).toEqual({ grants: [] });
    release(); await f.mover.settled(from.server, from.pane);
    expect(await readMove(move.id)).toMatchObject({ state: "failed" });
    expect((await recordedConductor())?.pane).toBe(from.pane);
    expect(f.sent.some(call => call.route.includes("/launch"))).toBe(false);
  });

  it("rejects third peer C on every conductor move route even when C knows B's move id", async () => {
    const f = fixture(); const old = await recordConductor(from.server, f.pane, "owner", from.session);
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (peer, route, data, timeout) => {
      if (route === "/v1/health") return { computer: { id: B_ID }, capabilities: { moveConductorToComputer: true } };
      if (route === "/v1/conductor/move/prepare") return { ok: true };
      return original(peer, route, data, timeout);
    });
    const service = new ConductorSuccessionService({ root: path.join(root, "bridge"), computer: { id: A_ID, name: "self" }, snapshot: f.deps.snapshot, validate: async () => f.pane, deliver: f.deliver, checkWorkers: async () => {} });
    const peer = (await peers.hookPeers())[0];
    const { peerHost } = await import("./dispatch-hosts.js");
    await service.begin(A_ID, old, from, peerHost(peer, f.transport), B_ID);
    const headers = { "x-phren-origin": "peer", "x-phren-peer": Buffer.from(JSON.stringify({ id: "70000000-0000-4000-8000-000000000003", fingerprint: peerFingerprint({ ...peer, username: "carol" }) })).toString("base64url") };
    const overrides = { succession: service };
    for (const path of ["status", "launch", "operation", "notification"]) expect((await request(f.mover, "GET", `/v1/conductor/move/${path}?id=${A_ID}&operationId=${B_ID}&deliveryId=notice-1234567890`, {}, headers, overrides)).status, path).toBe(403);
    for (const path of ["prepare", "commit", "operate", "notice", "ack"]) expect((await request(f.mover, "POST", `/v1/conductor/move/${path}`, { id: A_ID, originId: A_ID }, headers, overrides)).status, path).toBe(403);
    expect((await request(f.mover, "GET", "/v1/sessions/moves", {}, headers, overrides)).status).toBe(200);
    const counterpart = { ...headers, "x-phren-peer": Buffer.from(JSON.stringify({ id: B_ID, fingerprint: peerFingerprint(peer) })).toString("base64url") };
    expect((await request(f.mover, "GET", `/v1/conductor/move/status?id=${A_ID}`, {}, counterpart, overrides)).status).toBe(200);
  });

  it("ignores a peer's claimed home relocation until the pane and that move's local arrival are both verified", async () => {
    const f = fixture(); const peer = (await peers.hookPeers())[0];
    const at = new Date().toISOString(), id = A_ID;
    await mkdir(path.join(root, "bridge", "dispatches"));
    await writeFile(path.join(root, "bridge", "dispatches", `${id}.json`), JSON.stringify({ id, computer: peer.name, harness: "claude", project: "repo", label: "worker", state: "accepted", target, createdAt: at, updatedAt: at }));
    const moved = { id: B_ID, at, from: { harness: "claude" }, to: { harness: "claude", computer: "home" }, target: from, computerId: A_ID, computerFingerprint: peerFingerprint(peer) };
    const local = vi.fn(async () => ({ workers: [] }));
    const returns = new DispatchReturns({ localComputer: { id: A_ID, name: "self" }, peers: async () => [peer], request: async () => ({ workers: [{ state: "unknown", moved }] }), localWorkers: local, snapshot: async () => ({ panes: [f.pane] }), identity: async () => from.session });
    await returns.poll();
    expect((await dispatchStatus())[0]).toMatchObject({ computer: peer.name, target });
    await writeLaunchBrief({ id: B_ID, text: "Return home" });
    await recordBriefArrival(B_ID, "UserPromptSubmit", from);
    await returns.poll();
    expect((await dispatchStatus())[0]).toMatchObject({ computer: "self", computerId: A_ID, target: from });
    expect(local).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform === "win32")("forwards peer-originated hand-off notices at ingress rather than enqueueing them into the fenced old pane", async () => {
  const f = fixture(), deliveryId = `handoff-notice-${"a".repeat(40)}`;
  const forward = vi.fn(async () => ({ delivered: true })), enqueue = vi.fn();
  const response = await request(f.mover, "POST", "/v1/hand-off", { target: from, text: "Hand-off finished", deliveryId }, { "x-phren-origin": "peer" }, { succession: { forward }, handOffs: { enqueue } } as never);
  expect(response).toMatchObject({ status: 200, body: { delivered: true } });
  expect(forward).toHaveBeenCalledWith(from, "Hand-off finished", deliveryId);
  expect(enqueue).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("refuses an authenticated peer launch without a canonical owner-admitted source intent", async () => {
  const f = fixture(), peer = (await peers.hookPeers())[0];
  const enqueue = vi.fn();
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (peer, route, data, timeout) => route.startsWith("/v1/sessions/move/intent?") ? {} : original(peer, route, data, timeout));
  const response = await request(f.mover, "POST", "/v1/sessions/move/launch", { computerId: A_ID, project: "repo", to: { harness: "claude" }, label: "Unadmitted", worker: false, brief: { id: A_ID, text: "Pretend this was admitted" } }, {
    "x-phren-origin": "peer", "x-phren-peer": Buffer.from(JSON.stringify({ name: peer.name, fingerprint: peerFingerprint(peer) })).toString("base64url"),
  }, { handOffs: { enqueue } } as never);
  expect(response.status).toBe(403);
  expect(f.transport.mock.calls.some(([, route]) => route === `/v1/sessions/move/intent?id=${A_ID}`)).toBe(true);
  expect(await continuationPlacement(A_ID)).toBeUndefined();
  expect(enqueue).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("reports a never-received launch as not-placed only after verifying the source's owner-admitted intent", async () => {
  const f = fixture(), peer = (await peers.hookPeers())[0];
  const canonical = { computerId: A_ID, project: "repo", to: { harness: "claude" }, label: "Continue", worker: false, brief: { id: B_ID, text: "Owner-admitted work" } };
  f.transport.mockResolvedValue(canonical);
  const response = await request(f.mover, "GET", `/v1/sessions/move/launch?id=${B_ID}`, {}, {
    "x-phren-origin": "peer", "x-phren-peer": Buffer.from(JSON.stringify({ name: peer.name, fingerprint: peerFingerprint(peer) })).toString("base64url"),
  });
  expect(response).toMatchObject({ status: 200, body: { state: "not-placed" } });
  expect(await continuationPlacement(B_ID)).toBeUndefined();
  expect(f.transport).toHaveBeenCalledWith(expect.objectContaining({ name: peer.name }), `/v1/sessions/move/intent?id=${B_ID}`, undefined, 5000);
});

it.skipIf(process.platform === "win32")("does not accept unrelated new Hooks as proof that a legacy dispatcher's worker can relocate", async () => {
  const f = fixture();
  f.deps.paneDispatch = async () => A_ID;
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (peer, route, data, timeout) => {
    if (route === "/v1/health") return { capabilities: { workerRelocation: 1 } };
    if (route.startsWith("/v1/dispatch/relocation")) return { known: false, knownDispatch: false, workerRelocation: 1 };
    return original(peer, route, data, timeout);
  });
  await expect(f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true })).rejects.toMatchObject({ status: 409, message: "Update the dispatching computer's Phren Hook first" });
  expect(f.deliver).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("redacts credential values from peer error responses as well as successful payloads", async () => {
  const f = fixture();
  const authorize = async () => { throw new BridgeError(409, "PGPASSWORD=hunter2\nCookie: k=v\ncurl -u user:pw", { authority: "owner" }); };
  const response = await request(f.mover, "GET", `/v1/conductor/move/status?id=${A_ID}`, {}, { "x-phren-origin": "peer" }, { succession: { authorize } } as never);
  expect(response.status).toBe(409);
  expect(JSON.stringify(response.body)).not.toMatch(/hunter2|k=v|user:pw/);
  expect(response.body.authority).toBe("owner");
});

it.skipIf(process.platform === "win32")("preserves startingToken in peer pane replies and capabilities in peer health replies", async () => {
  const f = fixture(), startingToken = "ab".repeat(32);
  vi.spyOn(herdr, "panes").mockResolvedValue({ panes: [{ id: "w1:p2", startingToken, agent: "claude" }] });
  const headers = { "x-phren-origin": "peer" };
  const reply = await request(f.mover, "GET", "/v1/workspaces/panes?server=default&groupId=w1&childId=w1:t1", {}, headers);
  expect(reply).toMatchObject({ status: 200, body: { panes: [{ startingToken }] } });
  const health = await request(f.mover, "GET", "/v1/health", {}, headers, { info: { computer: { id: A_ID }, capabilities: { projectHostToken: true, authority: true }, author: "Al", authority: "owner" } } as never);
  expect(health).toMatchObject({ status: 200, body: { capabilities: { projectHostToken: true, authority: true }, author: "Al", authority: "owner" } });
});

it.skipIf(process.platform === "win32")("limits peer move status reads to the move's verified destination", async () => {
  const f = fixture(), original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (peer, route, data, timeout) => route === "/v1/health" ? { computer: { id: B_ID } } : original(peer, route, data, timeout));
  const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
  await f.mover.settled(from.server, from.pane);
  const peer = (await peers.hookPeers())[0];
  const headers = (name: string, fingerprint: string) => ({ "x-phren-origin": "peer", "x-phren-peer": Buffer.from(JSON.stringify({ name, fingerprint })).toString("base64url") });
  expect((await request(f.mover, "GET", `/v1/sessions/move?id=${move.id}`, {}, headers(peer.name, peerFingerprint(peer)))).status).toBe(200);
  expect((await request(f.mover, "GET", `/v1/sessions/move?id=${move.id}`, {}, headers("third-peer", peerFingerprint({ ...peer, username: "carol" })))).status).toBe(403);
  expect((await request(f.mover, "GET", `/v1/sessions/move?id=${move.id}`, {}, { "x-phren-origin": "peer" })).status).toBe(403);
  expect((await request(f.mover, "GET", `/v1/sessions/move?id=${move.id}`)).status).toBe(200);
});

it.skipIf(process.platform === "win32").each([403, 503])("terminates refusals and backs off transient move recovery (%s)", async status => {
  const f = fixture(), original = f.transport.getMockImplementation()!;
  let clock = Date.now(); const created = clock;
  f.deps.now = () => clock;
  f.transport.mockImplementation(async (peer, route, data, timeout) => {
    if (route.startsWith("/v1/sessions/move/launch?server=")) throw new BridgeError(status, "Destination unavailable");
    if (route.startsWith("/v1/sessions/move/launch?id=")) return { state: "uncertain" };
    return original(peer, route, data, timeout);
  });
  const move = await f.mover.start({ target: from, to: { harness: "claude", computer: "remote" } }, { owner: true });
  await f.mover.settled(from.server, from.pane);
  const attempts = () => f.transport.mock.calls.filter(([, route]) => route.startsWith("/v1/sessions/move/launch?server=")).length;
  const recover = async (mover: SessionMover) => { await mover.reconcile(); await mover.settled(from.server, from.pane); };
  await recover(f.mover);
  if (status === 403) {
    expect(await readMove(move.id)).toMatchObject({ state: "failed", error: "Destination unavailable" });
    const count = attempts(); await recover(new SessionMover(f.deps)); expect(attempts()).toBe(count);
  } else {
    expect(await readMove(move.id)).toMatchObject({ state: "uncertain", recovery: { attempts: 1, nextAt: new Date(clock + 5000).toISOString() } });
    const restarted = new SessionMover(f.deps), count = attempts();
    await recover(restarted); expect(attempts()).toBe(count);
    clock += 5000; await recover(restarted);
    expect(await readMove(move.id)).toMatchObject({ recovery: { attempts: 2, nextAt: new Date(clock + 10000).toISOString() } });
    clock = created + 600_001; await recover(restarted);
    expect(await readMove(move.id)).toMatchObject({ state: "failed", error: "Destination unavailable" });
    const ended = attempts(); await recover(restarted); expect(attempts()).toBe(ended);
  }
});

it.skipIf(process.platform === "win32")("delivers Hook return notices directly even when its inherited environment identifies an agent pane", async () => {
  const f = fixture(), at = new Date().toISOString();
  await mkdir(path.join(root, "bridge", "dispatches"));
  await writeFile(path.join(root, "bridge", "dispatches", `${A_ID}.json`), JSON.stringify({ id: A_ID, computer: "self", harness: "claude", project: "repo", label: "Finished", state: "accepted", target, origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: "term-1" }, createdAt: at, updatedAt: at, returned: { state: "done", at, reply: "Done", read: false } }));
  vi.spyOn(terminals, "terminalPaneFromEnv").mockResolvedValue({ server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane });
  const calls = vi.spyOn(hookClient, "hookRequest").mockImplementation(async route => route === "/v1/hand-off" ? { ok: true, delivered: true } : { groups: [] });
  const returns = new DispatchReturns({ snapshot: f.deps.snapshot, identity: f.deps.identity });
  await returns.notify();
  expect((await dispatchStatus())[0].returned?.notifiedAt).toBeDefined();
  expect(calls.mock.calls.some(([route]) => route === "/v1/hand-off")).toBe(true);
  expect(calls.mock.calls.some(([route]) => route === "/v1/conductor/call")).toBe(false);
});
