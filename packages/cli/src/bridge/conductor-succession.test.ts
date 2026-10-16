import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConductorSuccessionService, preflightConductorWorkers, type ConductorExecutor } from "./conductor-succession.js";
import { clearConductor, readRoleState, recordConductor, recordedConductor, resetRoleState, transferConductor, updateConductorAuthority } from "./conductor-role.js";
import { peerHost } from "./dispatch-hosts.js";
import type { HookPeer } from "./peers.js";
import { HandOffQueue } from "./hand-off-queue.js";
import { DispatchReturns } from "./dispatch-returns.js";
import { dispatchStatus, updateReceipt } from "./dispatch.js";
import { BridgeError, objects, type Json, type Target } from "./protocol.js";

const A = "a0000000-0000-4000-8000-000000000001", B = "b0000000-0000-4000-8000-000000000002", C = "d0000000-0000-4000-8000-000000000003";
const from: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "c0000000-0000-4000-8000-000000000001" };
const target: Target = { ...from, workspace: "w2", tab: "w2:t1", pane: "w2:p1", session: "c0000000-0000-4000-8000-000000000002" };
const pane = (target: Target): Json => ({ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: target.source, agent_status: "idle", terminal_id: `terminal-${target.pane}`, agent_session: { value: target.session } });
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-succession-")); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "a")); await mkdir(path.join(root, "a")); await mkdir(path.join(root, "b")); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRoleState(); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const old = await recordConductor(from.server, pane(from), "owner", from.session);
  const peerA: HookPeer = { name: "origin-local-alias", address: "a.test", username: "alice", port: 22, hostKey: "ssh-ed25519 key-a", server: "default" };
  const peerB: HookPeer = { name: "destination-local-alias", address: "b.test", username: "bob", port: 22, hostKey: "ssh-ed25519 key-b", server: "default" };
  const workerPeer: HookPeer = { ...peerB, name: "worker-local-alias", address: "worker.test" };
  const typed: Array<{ target: Target; text: string; id: string }> = [];
  let handOffFailure = false;
  let workerUsername = workerPeer.username;
  let unreachable = "", lostCommitAck = false, lostOperationAck = false, workerOffline = false, replaced = false, legacy = false;
  let a: ConductorSuccessionService, b: ConductorSuccessionService;
  const execute = vi.fn<ConductorExecutor>(async () => ({ ok: true }));
  const queue = (name: string) => new HandOffQueue({ forward: name === "a" ? (origin, text, id) => a.forward(origin, text, id) : undefined, root: path.join(root, name, "hand-offs"), validate: async target => pane(target), send: async (target, text, id, typing) => { if (handOffFailure && target.pane === "w3:p1") throw new BridgeError(404, "Worker pane disappeared"); await typing(); typed.push({ target, text, id }); return { ok: true, delivered: true }; } });
  let qa = queue("a"), qb = queue("b");
  const request = vi.fn(async (peer: HookPeer, route: string, data?: Json) => {
    if (peer.address === "worker.test") {
      if (workerOffline) throw new Error("offline");
      return { computer: { id: C } };
    }
    const name = peer.address === "a.test" ? "a" : "b";
    if (unreachable === name) throw new Error("offline");
    const service = name === "a" ? a : b;
    const url = new URL(route, "http://hook");
    if (url.pathname === "/v1/health") return { computer: { id: name === "a" ? A : B }, capabilities: { moveConductorToComputer: true } };
    if (url.pathname === "/v1/conductor/move/status") return service.status(url.searchParams.get("id")!);
    if (url.pathname === "/v1/conductor/move/launch") return service.launchIntent(url.searchParams.get("id")!);
    if (url.pathname === "/v1/conductor/move/prepare") return service.prepare(data);
    if (url.pathname === "/v1/conductor/move/commit") {
      const result = await service.activate(data);
      if (lostCommitAck) { lostCommitAck = false; throw new Error("lost commit acknowledgement"); }
      return result;
    }
    if (url.pathname === "/v1/conductor/move/operate") {
      const result = await service.operate(data, execute);
      if (lostOperationAck) { lostOperationAck = false; throw new BridgeError(503, "lost operation acknowledgement"); }
      return result;
    }
    if (url.pathname === "/v1/conductor/move/ack") return service.acknowledge(data, rows => new DispatchReturns().acknowledge(rows));
    if (url.pathname === "/v1/conductor/move/operation") return service.outgoing(url.searchParams.get("id")!, url.searchParams.get("operationId")!);
    if (url.pathname === "/v1/conductor/move/notice") return service.notice(data);
    if (url.pathname === "/v1/conductor/move/notification") return service.notification(url.searchParams.get("id")!, url.searchParams.get("deliveryId")!);
    throw new Error(route);
  });
  const boot = () => {
    resetRoleState(); qa = queue("a"); qb = queue("b");
    a = new ConductorSuccessionService({ root: path.join(root, "a"), computer: { id: A, name: "a" }, peers: async () => [peerB, workerPeer], request,
      snapshot: async () => ({ panes: [pane(from)] }), validate: async target => pane(target), deliver: (target, text, deliveryId) => qa.enqueue({ target, text, deliveryId }),
      checkWorkers: from => preflightConductorWorkers(from, A, async () => [peerB, workerPeer], request) });
    b = new ConductorSuccessionService({ root: path.join(root, "b"), computer: { id: B, name: "b" }, peers: async () => [peerA, { ...workerPeer, username: workerUsername, name: "workers-other-alias" }], request,
      snapshot: async () => ({ panes: [{ ...pane(target), ...(legacy ? { agent_name: "conductor-work" } : {}) }] }), isSuccessor: async origin => origin.pane === target.pane,
      validate: async requested => { if (replaced && requested.pane === target.pane) throw new Error("conversation changed"); return pane(requested); },
      deliver: (target, text, deliveryId) => qb.enqueue({ target, text, deliveryId }), checkWorkers: async () => {} });
  };
  boot();
  const id = randomUUID();
  const begin = () => a.begin(id, old, from, peerHost(peerB, request), B);
  const commit = async () => { await a.prepared(id, target); await a.commit(id); await a.finish(id); };
  return { id, old, begin, commit, boot, get a() { return a; }, get b() { return b; }, typed, request, execute, queue: () => qa, failHandOff: () => { handOffFailure = true; }, wrongWorkerAccount: () => { workerUsername = "other-user"; }, peerA, peerB,
    offline: (name: string) => { unreachable = name; }, loseAck: () => { lostCommitAck = true; }, loseOperationAck: () => { lostOperationAck = true; }, workerOffline: async () => {
      workerOffline = true;
      const id = randomUUID(), at = new Date().toISOString();
      await mkdir(path.join(root, "a", "dispatches"), { recursive: true });
      await writeFile(path.join(root, "a", "dispatches", `${id}.json`), JSON.stringify({ id, computer: workerPeer.name, computerId: C, harness: "claude", project: "repo", label: "existing worker", state: "accepted", target: { ...target, pane: "w3:p1", session: C }, origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: `terminal-${from.pane}` }, createdAt: at, updatedAt: at }));
    }, replace: () => { replaced = true; }, legacy: () => { legacy = true; } };
}

describe("origin-owned remote conductor succession", () => {
  it("prepares without activating, serializes make/start/stop, pauses new calls, then commits exactly one conductor and fences the old chat", async () => {
    const f = await fixture();
    await f.begin();
    expect(await recordedConductor()).toEqual(f.old);
    expect((await readRoleState(path.join(root, "b")))?.conductor).toBeNull();
    await expect(f.b.call("dispatch", {}, target, async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not the conductor yet") });
    await expect(f.a.call("hand_off", {}, from, async () => ({ ok: true }))).rejects.toMatchObject({ status: 409 });
    await expect(recordConductor("default", pane(from), "owner")).rejects.toMatchObject({ status: 409 });
    await expect(clearConductor()).rejects.toMatchObject({ status: 409 });
    await expect(transferConductor(f.old, "default", pane(target), target.session)).rejects.toMatchObject({ status: 409 });
    await f.commit();
    expect(await recordedConductor()).toBeUndefined();
    expect((await readRoleState(path.join(root, "b")))?.conductor).toMatchObject({ pane: target.pane, session: target.session });
    await expect(f.a.call("dispatch", {}, from, async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("fenced") });
    expect(f.typed.filter(row => row.text.includes("You are now the conductor"))).toHaveLength(1);
    expect(f.typed.some(row => row.target.pane === from.pane && row.text.includes("no longer the conductor"))).toBe(true);
  });

  it.each(["preparing", "prepared", "committed"] as const)("recovers both Hooks after restart in %s state", async phase => {
    const f = await fixture(); await f.begin();
    if (phase !== "preparing") await f.a.prepared(f.id, target);
    if (phase === "committed") await f.a.commit(f.id);
    f.boot();
    expect((await f.a.status(f.id)).phase).toBe(phase);
    if (phase === "committed") {
      await f.b.reconcile(); await f.a.reconcile();
      expect((await readRoleState(path.join(root, "b")))?.conductor?.pane).toBe(target.pane);
      expect(await recordedConductor()).toBeUndefined();
    } else {
      expect(await recordedConductor()).toEqual(f.old);
      await f.commit();
      expect((await f.a.status(f.id)).phase).toBe("committed");
    }
  });

  it("reconciles a lost commit acknowledgement and duplicate commits without rollback or duplicate activation delivery", async () => {
    const f = await fixture(); await f.begin(); await f.a.prepared(f.id, target); await f.a.commit(f.id);
    f.loseAck(); await expect(f.a.finish(f.id)).rejects.toThrow("lost commit acknowledgement");
    await f.a.abort(f.id);
    expect((await f.a.status(f.id)).phase).toBe("committed"); expect(await recordedConductor()).toBeUndefined();
    f.boot(); await f.a.commit(f.id); await f.a.reconcile(); await f.a.finish(f.id);
    expect(f.typed.filter(row => row.text.includes("You are now the conductor"))).toHaveLength(1);
    expect((await f.b.status(f.id)).phase).toBe("committed");
  });

  it("rolls back a preparation failure, refuses unreachable workers before changes, and refuses a stale generation at CAS", async () => {
    const f = await fixture(); await f.workerOffline(); await expect(f.begin()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("worker computer is unreachable") });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ address: "worker.test" }), "/v1/health", undefined, 5000);
    expect((await readRoleState())?.succession).toBeUndefined(); expect(await recordedConductor()).toEqual(f.old);
    const g = await fixture(); g.offline("b"); await expect(g.begin()).rejects.toThrow("offline");
    expect((await readRoleState())?.succession).toBeUndefined();
    g.offline(""); await g.begin(); await g.a.prepared(g.id, target);
    await updateConductorAuthority(path.join(root, "a"), async state => ({ ...state, conductor: { ...g.old, since: "2026-10-17T00:00:00.000Z" } }));
    await expect(g.a.commit(g.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("conductor changed") });
    await g.a.abort(g.id); await g.b.reconcile();
    expect((await g.b.status(g.id)).phase).toBe("aborted");
    expect(f.typed.filter(row => row.text.includes("You are now the conductor"))).toHaveLength(0);
  });

  it("refuses a move while a conductor operation is already running", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const operation = f.a.call("dispatch", {}, from, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; });
    await started;
    await expect(f.begin()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("operation in flight") });
    release(); await operation; await f.begin();
  });

  it("authenticates successor operations by reverse pinned fetch, preserves approval action ids on A, and fails closed if A is unreachable", async () => {
    const f = await fixture(); await f.begin(); await f.commit();
    const dispatch = randomUUID(), now = new Date().toISOString();
    const worker = { ...target, pane: "w3:p1", session: "c0000000-0000-4000-8000-000000000003" };
    await mkdir(path.join(root, "a", "dispatches"));
    await writeFile(path.join(root, "a", "dispatches", `${dispatch}.json`), JSON.stringify({ id: dispatch, computer: "a", computerId: A, harness: "claude", project: "repo", label: "existing", state: "accepted", target: worker, origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: `terminal-${from.pane}` }, approval: { actionId: "existing-action-42", tool: "Bash", at: now }, createdAt: now, updatedAt: now }));
    const answer = vi.fn(async () => {});
    const returns = new DispatchReturns({ localComputer: { id: A, name: "a" }, localAnswer: answer, isLocal: () => true });
    f.execute.mockImplementation(async (action, data, origin) => {
      expect(action).toBe("approve");
      await returns.answerApproval(String(data.id), "approve", String(data.actionId), origin); return { ok: true };
    });
    const payload = { id: dispatch, actionId: "existing-action-42", decision: "approve" };
    expect(await f.b.call("approve", payload, target, async () => { throw new Error("must reach A"); })).toEqual({ ok: true });
    expect(answer).toHaveBeenCalledWith(worker, "existing-action-42", "approve");
    expect((await dispatchStatus())[0].approval).toBeUndefined();
    const operation = f.request.mock.calls.find(([, route]) => route === "/v1/conductor/move/operate")![2];
    await f.a.operate(operation, f.execute); expect(answer).toHaveBeenCalledTimes(1);
    await expect(f.a.operate({ ...operation, operationId: randomUUID() }, f.execute)).rejects.toThrow();
    f.offline("a");
    await expect(f.b.call("dispatch", {}, target, async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("unreachable") });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("forwards pending and late returns to B after commit, with durable deduplication (old pane present: %s)", async present => {
    const f = await fixture();
    const dispatch = randomUUID(), now = new Date().toISOString();
    await mkdir(path.join(root, "a", "dispatches"));
    const receipt = { id: dispatch, computer: "a", computerId: A, harness: "claude", project: "repo", label: "late result", state: "accepted", target,
      origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: `terminal-${from.pane}` }, returned: { state: "done", at: now, reply: "Finished late", read: false }, createdAt: now, updatedAt: now };
    await writeFile(path.join(root, "a", "dispatches", `${dispatch}.json`), JSON.stringify(receipt));
    const deliverOld = vi.fn(async () => ({ delivered: true }));
    await f.begin(); await f.a.prepared(f.id, target);
    const returns = new DispatchReturns({ snapshot: async () => ({ panes: present ? [pane(from)] : [] }), identity: async () => from.session, forward: (origin, text, id) => f.a.forward(origin, text, id), deliver: deliverOld });
    await returns.notify();
    expect((await dispatchStatus())[0].returned?.notifiedAt).toBeUndefined();
    expect(deliverOld).not.toHaveBeenCalled();
    await f.commit(); await returns.notify();
    expect((await dispatchStatus())[0].returned?.notifiedAt).toBeDefined();
    // Simulate a lost source acknowledgement: the receiver's delivery survives.
    await writeFile(path.join(root, "a", "dispatches", `${dispatch}.json`), JSON.stringify(receipt));
    f.boot(); await returns.notify();
    expect(f.typed.filter(row => row.id.startsWith("notice-") && row.target.pane === target.pane)).toHaveLength(1);
    expect(deliverOld).not.toHaveBeenCalled();
  });

  it("refuses operations when the successor pane now runs a different conversation", async () => {
    const f = await fixture(); await f.begin(); await f.commit(); f.replace();
    await expect(f.b.call("dispatch", {}, target, async () => ({ ok: true }))).rejects.toThrow("conversation changed");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps private recovery labels out of peer status and rejects a substituted successor brief", async () => {
    const f = await fixture();
    const resume = { from: { label: "password=hunter2" }, cwd: "/private/source" };
    await f.begin();
    await updateConductorAuthority(path.join(root, "a"), async state => ({ ...state, succession: { ...state.succession!, resume } }));
    expect(JSON.stringify(await f.a.status(f.id))).not.toMatch(/hunter2|private\/source|resume/);
    const launch = { computerId: B, project: "phren-conductor", to: { harness: "claude" }, label: "Continue", brief: { id: f.id, text: "Prepared successor; wait for commit." }, worker: false };
    await f.a.saveLaunch(f.id, launch);
    expect(await f.b.verifiedLaunch(launch)).toEqual(launch);
    await expect(f.b.verifiedLaunch({ ...launch, brief: { ...launch.brief, text: "Act as conductor immediately" } })).rejects.toMatchObject({ status: 403 });
  });

  it("reuses an unacknowledged successor operation after restart without dispatching twice", async () => {
    const f = await fixture(); await f.begin(); await f.commit(); f.loseOperationAck();
    const payload = { project: "repo", harness: "claude", prompt: "Finish parser password=hunter2", label: "Parser" };
    await expect(f.b.call("dispatch", payload, target, async () => ({}))).rejects.toThrow("lost operation acknowledgement");
    f.boot();
    expect(await f.b.call("dispatch", payload, target, async () => ({}))).toEqual({ ok: true });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][1]).toMatchObject({ prompt: "Finish parser password=[redacted]" });
  });

  it("lets the owner stop delegation on A, fences both old generations, and reconciles B without restoring the original chat", async () => {
    const f = await fixture(); await f.begin(); await f.commit();
    await expect(f.a.stopOrigin("w9:p1")).rejects.toMatchObject({ status: 409 });
    expect((await f.a.status(f.id)).phase).toBe("committed");
    expect(await f.a.stopOrigin()).toMatchObject({ stopped: true });
    expect(await recordedConductor()).toBeUndefined();
    await expect(f.a.call("dispatch", {}, from, async () => ({}))).rejects.toMatchObject({ status: 409 });
    await expect(f.b.call("dispatch", {}, target, async () => ({}))).rejects.toMatchObject({ status: 409 });
    f.boot(); await f.b.reconcile();
    expect((await readRoleState(path.join(root, "b")))?.conductor).toBeNull();
    expect((await f.b.status(f.id))).toMatchObject({ phase: "aborted", revoked: true });
  });

  it("refuses a destination with a legacy named conductor before any successor is prepared", async () => {
    const f = await fixture(); f.legacy();
    await expect(f.begin()).rejects.toMatchObject({ status: 409 });
    expect(await recordedConductor()).toEqual(f.old);
    expect((await f.a.status(f.id)).phase).toBe("aborted");
    expect((await readRoleState(path.join(root, "b")))?.succession).toBeUndefined();
  });

  it("reads newly arrived returns on every call and withholds credential text from peer replies", async () => {
    const f = await fixture();
    const firstId = randomUUID(), secondId = randomUUID(), at = new Date().toISOString();
    const worker = { ...target, workspace: "w3", tab: "w3:t1", pane: "w3:p1", session: C };
    await mkdir(path.join(root, "a", "dispatches"));
    for (const id of [firstId, secondId]) await writeFile(path.join(root, "a", "dispatches", `${id}.json`), JSON.stringify({ id, computer: "a", computerId: A, harness: "claude", project: "repo", label: "existing worker", state: "accepted", target: worker,
      origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: `terminal-${from.pane}` }, createdAt: at, updatedAt: at,
      ...(id === firstId ? { returned: { state: "done", at, reply: "First result", read: false } } : {}) }));
    await f.begin(); await f.commit();
    const returns = new DispatchReturns({ localComputer: { id: A, name: "a" } });
    f.execute.mockImplementation(async action => { expect(action).toBe("returns"); return { returns: await returns.take(false) }; });
    const first = await f.b.call("returns", {}, target, async () => ({}));
    expect(objects(first.returns).map(row => row.id)).toEqual([firstId]);
    const pat = "ghp_" + "a".repeat(36);
    await updateReceipt(secondId, receipt => { receipt.returned = { state: "done", at, reply: `Second result password=hunter2\nAuthorization: Bearer abc\nStandalone ${pat}`, read: false }; return true; });
    const second = await f.b.call("returns", {}, target, async () => ({}));
    expect(objects(second.returns).map(row => row.id)).toEqual([secondId]);
    expect(JSON.stringify(second)).not.toMatch(/hunter2|Bearer abc|ghp_/);
    expect((await f.b.call("returns", {}, target, async () => ({}))).returns).toEqual([]);
  });

  it("allows a fresh intent after a definitive permission refusal without replaying an uncertain operation", async () => {
    const f = await fixture(); await f.begin(); await f.commit();
    f.execute.mockRejectedValueOnce(new BridgeError(403, "A standing grant is required")).mockResolvedValue({ ok: true });
    const data = { project: "repo", harness: "claude", prompt: "Finish parser", label: "Parser" };
    await expect(f.b.call("dispatch", data, target, async () => ({}))).rejects.toMatchObject({ status: 403 });
    expect(await f.b.call("dispatch", data, target, async () => ({}))).toEqual({ ok: true });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

});

describe("reviewed conductor recovery and identity contracts", () => {
  it.each(["mid-read", "lost-ack"])("retries returns after a 503 %s without consuming them before successor acknowledgement", async failure => {
    const f = await fixture(); await f.begin(); await f.commit();
    const id = randomUUID(), at = new Date().toISOString();
    await mkdir(path.join(root, "a", "dispatches"));
    await writeFile(path.join(root, "a", "dispatches", `${id}.json`), JSON.stringify({ id, computer: "a", computerId: A, harness: "claude", project: "repo", label: "result", state: "accepted", target, createdAt: at, updatedAt: at, returned: { state: "done", at, reply: "Keep this result", read: false } }));
    const returns = new DispatchReturns();
    f.execute.mockImplementation(async () => ({ returns: await returns.take(false) }));
    if (failure === "mid-read") f.execute.mockImplementationOnce(async () => { await returns.take(false); throw new BridgeError(503, "interrupted read"); });
    else f.loseOperationAck();
    await expect(f.b.call("returns", {}, target, async () => ({}))).rejects.toMatchObject({ status: 503 });
    expect((await dispatchStatus())[0].returned?.read).toBe(false);
    f.boot();
    expect(objects((await f.b.call("returns", {}, target, async () => ({}))).returns)).toMatchObject([{ id, reply: "Keep this result" }]);
    expect((await dispatchStatus())[0].returned?.read).toBe(true);
    expect((await f.b.call("returns", {}, target, async () => ({}))).returns).toEqual([]);
  });

  it("starts a fresh grants-list read after an execution crash and restart", async () => {
    const f = await fixture(); await f.begin(); await f.commit();
    f.execute.mockRejectedValueOnce(new Error("crash during grants-list")).mockResolvedValue({ grants: [{ id: "standing" }] });
    await expect(f.b.call("grants-list", {}, target, async () => ({}))).rejects.toThrow("crash");
    f.boot();
    expect(await f.b.call("grants-list", {}, target, async () => ({}))).toEqual({ grants: [{ id: "standing" }] });
    const ids = f.request.mock.calls.filter(([, route]) => route === "/v1/conductor/move/operate").map(([, , data]) => data?.operationId);
    expect(new Set(ids).size).toBe(2);
  });

  it("resolves the successor's omitted computer and differing peer alias in A's own directory", async () => {
    const f = await fixture(); await f.begin(); await f.commit();
    await f.b.call("hand_off", { target, text: "Continue here" }, target, async () => { throw new Error("local bypass"); });
    expect(f.execute.mock.calls[0][1]).toMatchObject({ computer: "destination-local-alias", target });
    await f.b.call("dispatch", { computer: "workers-other-alias", project: "repo", harness: "claude", prompt: "Finish", label: "worker" }, target, async () => ({}));
    expect(f.execute.mock.calls[1][1].computer).toBe("worker-local-alias");
    await expect(f.b.call("dispatch", { computer: "unknown-alias" }, target, async () => ({}))).rejects.toMatchObject({ status: 409 });
  });

  it.each(["delivered", "failed"])("forwards %s hand-off notices to the successor and deduplicates them across restart", async outcome => {
    const f = await fixture(); await f.begin(); await f.commit();
    if (outcome === "failed") f.failHandOff();
    await f.queue().enqueue({ target: { ...from, pane: "w3:p1" }, origin: from, text: "Do the work", deliveryId: "work-message-12345" });
    await f.queue().tick();
    f.boot(); await f.queue().tick();
    const notices = f.typed.filter(row => row.id.startsWith("handoff-notice-"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target, text: `Hand-off work-message-12345: ${outcome}.` });
  });

  it("fences automatic account-failover dispatch during preparation and validates the delegated generation after commit", async () => {
    const f = await fixture(); await f.begin();
    const dispatch = vi.fn(async () => ({ ok: true }));
    await expect(f.a.automatic("dispatch", {}, from, dispatch)).rejects.toMatchObject({ status: 409 });
    expect(dispatch).not.toHaveBeenCalled();
    await f.commit();
    expect(await f.a.automatic("dispatch", {}, from, dispatch)).toEqual({ ok: true });
    f.offline("b");
    await expect(f.a.automatic("dispatch", {}, from, dispatch)).rejects.toMatchObject({ status: 409 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("pins legacy receipt workers across aliases (SSH account changed: %s)", async changed => {
    const f = await fixture();
    const id = randomUUID(), at = new Date().toISOString();
    await mkdir(path.join(root, "a", "dispatches"));
    await writeFile(path.join(root, "a", "dispatches", `${id}.json`), JSON.stringify({ id, computer: "worker-local-alias", harness: "claude", project: "repo", label: "legacy worker", state: "accepted", target, origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: "old" }, createdAt: at, updatedAt: at }));
    if (changed) {
      f.wrongWorkerAccount();
      await expect(f.begin()).rejects.toMatchObject({ status: 409 });
      expect(await recordedConductor()).toEqual(f.old);
      expect((await f.a.status(f.id)).phase).toBe("aborted");
    } else {
      await f.begin(); await f.commit();
      expect((await f.b.status(f.id)).target).toEqual(target);
    }
  });

  it("serializes concurrent finish and activation calls for the same move", async () => {
    const f = await fixture(); await f.begin(); await f.a.prepared(f.id, target); const state = await f.a.commit(f.id);
    await Promise.all([f.a.finish(f.id), f.a.finish(f.id), f.b.activate({ id: f.id, generation: state.generation }), f.b.activate({ id: f.id, generation: state.generation })]);
    expect(f.request.mock.calls.filter(([, route]) => route === "/v1/conductor/move/commit")).toHaveLength(1);
    expect(f.typed.filter(row => row.id === `move-${f.id}-conductor-confirmed`)).toHaveLength(1);
  });
});

it("redacts embedded short credentials in forwarded operations, notices and responses", async () => {
  const f = await fixture(); await f.begin(); await f.commit();
  const text = ["PGPASSWORD=hunter2", "apiToken=abc123", "secret_key=", "aws_secret_access_key=awsvalue", "DB_PASS=dbvalue", "passphrase: phrasevalue", "credential: credentialvalue", "Cookie: k=v", "mysql -pmysqlvalue", "curl -u user:pw", "--auth user:pw", "_authToken=npmvalue"].join("\n");
  f.execute.mockResolvedValue({ reply: text, startingToken: "ab".repeat(32), authority: "owner", author: "Al" });
  const response = await f.b.call("hand_off", { target, text }, target, async () => ({}));
  expect(response).toMatchObject({ startingToken: "ab".repeat(32), authority: "owner", author: "Al" });
  await f.a.forward(from, text, "notice-12345678901234567890123456789012");
  for (const outbound of [JSON.stringify(f.execute.mock.calls[0][1]), JSON.stringify(response), f.typed.at(-1)!.text]) {
    expect(outbound).not.toMatch(/hunter2|abc123|awsvalue|dbvalue|phrasevalue|credentialvalue|k=v|mysqlvalue|user:pw|npmvalue|objectvalue/);
    expect(outbound).toContain("[redacted]");
    expect(outbound).toContain("secret_key=[redacted]");
  }
});
