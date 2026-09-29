import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus, updateReceipt, type Receipt } from "./dispatch.js";
import { BACKGROUND_WAIT_MS, LAUNCH_GRACE_MS, DispatchReturns, hookWorkers, NOTICE_MS, noticeLine, observe, POLL_MS, REPLY_LIMIT, returnRow, workerStates, type WorkerReaders } from "./dispatch-returns.js";
import { findPane } from "./herdr.js";
import { LOST_TURN } from "./codex-servers.js";
import { localHost } from "./dispatch-hosts.js";
import { hookPeers, peerRequest } from "./peers.js";
import { object, objects, provider, type Json } from "./protocol.js";

vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));

// The fake Herdr answers only with the recorded 0.9.1 snapshot. A test may
// move a pane to another status, but only to one the recorded schema allows.
const HERDR = "0.9.1";
const recorded = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/herdr/${HERDR}/${file}`, import.meta.url), "utf8"));
const statuses: string[] = recorded("schema.json").schemas.success_response.$defs.AgentStatus.enum;
function herdrSnapshot(overrides: Record<string, string> = {}, without: string[] = []): Json {
  const snapshot = structuredClone(recorded("snapshot.json").result.snapshot) as Json;
  snapshot.panes = objects(snapshot.panes).filter(pane => !without.includes(String(pane.pane_id))).map(pane => {
    const status = overrides[String(pane.pane_id)];
    if (status === undefined) return pane;
    if (!statuses.includes(status)) throw new Error(`Herdr ${HERDR} has no agent status ${status}`);
    return { ...pane, agent_status: status };
  });
  return snapshot;
}
/** Herdr's explicit session id, as the recorded panes carry it. */
const recordedIdentity = async (_server: string, pane: Json) => {
  const session = object(pane.agent_session);
  return session.kind === "id" && typeof session.value === "string" ? session.value : undefined;
};

const conductorPane = { server: "default", workspace: "w1P", tab: "w1P:t1", pane: "w1P:p1" };
const workerTarget = { server: "default", workspace: "w1P", tab: "w1P:t2", pane: "w1P:p2", source: "claude" as const,
  session: "00000003-1111-4111-8111-111111111111" };
const workingTarget = { server: "default", workspace: "w13", tab: "w13:t2", pane: "w13:p2", source: "claude" as const,
  session: "00000001-1111-4111-8111-111111111111" };
const remoteID = "30000000-0000-4000-8000-000000000001";
const brief = { computer: "Linuxbox", project: "phren", harness: "claude", prompt: "Run the parser checks", label: "parser checks" };

function readers(snapshot: () => Json, reply?: { completed: boolean; lastAssistant?: string; background?: number }): WorkerReaders {
  return { snapshot: async () => snapshot(), identity: recordedIdentity, finalTurn: async () => reply };
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  const at = new Date(0).toISOString();
  return { id: "40000000-0000-4000-8000-000000000001", computer: "Linuxbox", project: "phren", harness: "claude", label: "parser checks",
    createdAt: at, updatedAt: at, state: "accepted", target: workerTarget, ...overrides } as Receipt;
}

describe("the receiving Hook's worker states", () => {
  it("reads working, finished, blocked and gone panes from the shared Herdr snapshot", async () => {
    const long = "é".repeat(REPLY_LIMIT);
    const answer = await workerStates({ targets: [workingTarget, workerTarget,
      { ...workerTarget, pane: "w1P:p9" }, { ...workerTarget, session: "00000009-1111-4111-8111-111111111111" }] },
    readers(() => herdrSnapshot(), { completed: true, lastAssistant: long }));
    expect(answer.workers[0]).toEqual({ state: "working", session: workingTarget.session });
    expect(answer.workers[1]).toMatchObject({ state: "done", session: workerTarget.session, completed: true, truncated: true });
    expect(Buffer.byteLength(answer.workers[1].reply!)).toBeLessThanOrEqual(REPLY_LIMIT);
    // A missing pane, or another conversation in it, is a gone worker.
    expect(answer.workers[2]).toEqual({ state: "gone" });
    expect(answer.workers[3]).toEqual({ state: "gone" });
    const blocked = await workerStates({ targets: [workerTarget] }, readers(() => herdrSnapshot({ "w1P:p2": "blocked" })));
    expect(blocked.workers[0]).toEqual({ state: "blocked", session: workerTarget.session });
  });

  it("refreshes a cached snapshot once before calling a new Codex pane gone", async () => {
    const freshSnapshot = vi.fn(async () => herdrSnapshot());
    const answer = await workerStates({ targets: [workerTarget, workingTarget] }, {
      ...readers(() => ({ panes: [] })), freshSnapshot,
    });
    expect(answer.workers.map(row => row.state)).toEqual(["done", "working"]);
    expect(freshSnapshot).toHaveBeenCalledTimes(1);
    freshSnapshot.mockRejectedValueOnce(new Error("offline"));
    expect((await workerStates({ targets: [workerTarget] }, { ...readers(() => ({ panes: [] })), freshSnapshot })).workers[0].state).toBe("unavailable");
  });

  it("allows a new Codex launch to appear, but reports a missing established worker immediately", () => {
    const fresh = receipt({ brief: "launch", harness: "codex", target: { ...workerTarget, source: "codex" } });
    expect(observe(fresh, { state: "gone" }, LAUNCH_GRACE_MS - 1)).toBe(false);
    expect(fresh.returned).toBeUndefined();
    expect(observe(fresh, { state: "gone" }, LAUNCH_GRACE_MS)).toBe(true);
    expect(fresh.returned?.state).toBe("gone");
    const established = receipt(); observe(established, { state: "working" }, 1);
    observe(established, { state: "gone" }, 2); expect(established.returned?.state).toBe("gone");
    established.closedAt = new Date(3).toISOString();
    expect(observe(established, { state: "gone" }, 4)).toBe(false);
  });

  it("keeps an idle pane with no turn record working while its finished turn left background tasks", async () => {
    const answer = await workerStates({ targets: [workerTarget] }, readers(() => herdrSnapshot(), { completed: true, lastAssistant: "Started.", background: 4 }));
    expect(answer.workers[0]).toEqual({ state: "working", session: workerTarget.session, completed: true, background: 4, reply: "Started." });
    const settled = await workerStates({ targets: [workerTarget] }, readers(() => herdrSnapshot(), { completed: true, lastAssistant: "Done." }));
    expect(settled.workers[0]).toMatchObject({ state: "done", completed: true });
  });

  it("carries what the worker waits on from the approval reader, for a full target only", async () => {
    const card = { actionId: "act-1", tool: "Bash", request: "Run: rm -rf build" };
    const approval = vi.fn((_target: unknown) => card);
    const answer = await workerStates({ targets: [workingTarget, { ...workerTarget, pane: "w1P:p9" }] },
      { ...readers(() => herdrSnapshot()), approval });
    expect(answer.workers[0]).toEqual({ state: "working", session: workingTarget.session, approval: card });
    expect(answer.workers[1]).toEqual({ state: "gone" });
    // The reader gets the plain target, without the dispatch id.
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(workingTarget);
    const starting = { server: "default", workspace: "w13", tab: "w13:t2", pane: "w13:p2", source: "claude" as const, starting: true, startingToken: "a".repeat(64) };
    expect((await workerStates({ targets: [starting] }, { ...readers(() => herdrSnapshot()), approval })).workers[0]).not.toHaveProperty("approval");
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it("leases the panes and reads approvals through the Hook's own methods", async () => {
    const hooks = { leaseDispatch: vi.fn(), workerApproval: vi.fn() };
    const seen = hookWorkers(hooks);
    await seen({ targets: [{ ...workingTarget, dispatch: remoteID }] }).catch(() => undefined);
    expect(hooks.leaseDispatch).toHaveBeenCalledWith([expect.objectContaining({ pane: workingTarget.pane, server: "default" })]);
  });

  it("returns a Codex worker whose app-server ended mid-turn as failed, not working forever", async () => {
    const codex = { ...workingTarget, source: "codex" as const };
    const at = new Date(5_000).toISOString();
    const lost = vi.fn((_server: string, _pane: string, session?: string) => session === codex.session ? { threadId: codex.session, turn: "turn-1", at } : undefined);
    // The recorded pane, running Codex.
    const snapshot = () => { const value = herdrSnapshot(); value.panes = objects(value.panes).map(pane => pane.pane_id === codex.pane ? { ...pane, agent: "codex" } : pane); return value; };
    const answer = await workerStates({ targets: [codex, { ...workerTarget }] }, { ...readers(snapshot), lost });
    expect(answer.workers[0]).toEqual({ state: "done", session: codex.session, completed: true, endedAt: at, error: LOST_TURN });
    // Only a Codex pane can lose its app-server.
    expect(answer.workers[1]).toMatchObject({ state: "done", session: workerTarget.session });
    expect(lost).toHaveBeenCalledTimes(1);
    const value = receipt({ target: codex });
    observe(value, { state: "working", session: codex.session }, 1_000);
    expect(observe(value, answer.workers[0], 6_000)).toBe(true);
    expect(value.returned).toMatchObject({ state: "failed", error: LOST_TURN });
  });

  it("reports an unreachable Herdr as unavailable and refuses malformed requests", async () => {
    const failing: WorkerReaders = { ...readers(() => ({})), snapshot: async () => { throw new Error("no socket"); } };
    expect((await workerStates({ targets: [workerTarget] }, failing)).workers).toEqual([{ state: "unavailable" }]);
    await expect(workerStates({ targets: [] })).rejects.toThrow();
    await expect(workerStates({ targets: [workerTarget], extra: true })).rejects.toThrow();
  });
});

describe("recording transitions", () => {
  it("records done with the final reply once, and a later finished turn as a new return", () => {
    const value = receipt();
    expect(observe(value, { state: "working", session: workerTarget.session }, 1000)).toBe(true);
    expect(value.worker).toMatchObject({ state: "working", sawWorking: true });
    expect(value.returned).toBeUndefined();
    expect(observe(value, { state: "done", completed: true, reply: "Parser checks done, tests passed." }, 2000)).toBe(true);
    expect(value.returned).toMatchObject({ state: "done", reply: "Parser checks done, tests passed.", read: false });
    const first = value.returned!.turn;
    // Herdr turns done into idle once someone looks; the same reply is no new return.
    expect(observe(value, { state: "idle", completed: true, reply: "Parser checks done, tests passed." }, 3000)).toBe(false);
    expect(observe(value, { state: "idle", completed: true, reply: "Follow-up done." }, 4000)).toBe(true);
    expect(value.returned!.turn).not.toBe(first);
  });

  it("records a turn the harness ended on an error as failed, never done", () => {
    const limit = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 6:12 AM.";
    const value = receipt();
    observe(value, { state: "working" }, 1000);
    expect(observe(value, { state: "done", completed: true, error: limit }, 2000)).toBe(true);
    expect(value.worker!.state).toBe("failed");
    expect(value.returned).toMatchObject({ state: "failed", error: limit, read: false });
    expect(value.returned!.reply).toBeUndefined();
    expect(noticeLine([value])).toContain("failed, You’ve hit your usage limit.");
    // Herdr turning done into idle is no new return.
    expect(observe(value, { state: "idle", completed: true, error: limit }, 3000)).toBe(false);
  });

  it("names a question, a blocked pane and a gone worker, and ignores silence", () => {
    const value = receipt();
    observe(value, { state: "working" }, 1000);
    observe(value, { state: "done", completed: true, reply: "Two ways to fix it:\n1. Patch the parser\n2. Rewrite the lexer\nWhich do you prefer?" }, 2000);
    expect(value.returned).toMatchObject({ state: "needs-you", question: "Which do you prefer?" });
    observe(value, { state: "blocked" }, 3000);
    expect(value.returned).toMatchObject({ state: "blocked", read: false });
    expect(value.returned!.reply).toBeUndefined();
    expect(observe(value, { state: "unavailable" }, 4000)).toBe(false);
    observe(value, { state: "gone" }, 5000);
    expect(value.worker!.state).toBe("gone");
  });

  it("waits for an idle worker that never started, however long, and upgrades a starting target", () => {
    const starting = { server: "default", workspace: "w1P", tab: "w1P:t2", pane: "w1P:p2", source: "claude" as const, starting: true as const, startingToken: "a".repeat(64) };
    const value = receipt({ target: starting, createdAt: new Date(0).toISOString() });
    observe(value, { state: "idle", session: workerTarget.session, completed: false }, 1000);
    expect(value.worker!.state).toBe("working");
    expect(value.target).toEqual(workerTarget);
    // No idle guess: a worker never seen working with no finished turn has not returned.
    observe(value, { state: "idle", completed: false }, 10 * 60 * 1000);
    expect(value.returned).toBeUndefined();
    // Seen working, then idle with no turn in the transcript, is the old sign it stopped.
    observe(value, { state: "working" }, 11 * 60 * 1000);
    observe(value, { state: "idle", completed: false }, 12 * 60 * 1000);
    expect(value.returned).toMatchObject({ state: "done" });
  });

  it("remembers the most background work seen and says what the worker waited on", () => {
    const value = receipt();
    expect(observe(value, { state: "working", background: 3 }, 1000)).toBe(true);
    // The same state with more work is a change to the receipt, not a new return.
    expect(observe(value, { state: "working", background: 7 }, 2000)).toBe(true);
    expect(observe(value, { state: "working", background: 2 }, 3000)).toBe(false);
    expect(observe(value, { state: "working", background: 7 }, 3500)).toBe(false);
    expect(value.worker).toMatchObject({ state: "working", background: 7 });
    expect(value.returned).toBeUndefined();
    expect(observe(value, { state: "done", completed: true, reply: "Suite passed." }, 4000)).toBe(true);
    expect(value.returned).toMatchObject({ state: "done", waited: 7 });
    expect(value.returned!.background).toBeUndefined();
    expect(noticeLine([value])).toContain("parser checks done (after 7 background tasks finished), Suite passed.");
    expect(returnRow(value)).toMatchObject({ state: "done", waited: 7 });
    // Work still running after the wait keeps the still-running wording, not both.
    const late = receipt();
    observe(late, { state: "working", background: 1 }, 1000);
    observe(late, { state: "done", completed: true, reply: "Left a server.", background: 1 }, 2000);
    expect(late.returned).toMatchObject({ background: 1 });
    expect(late.returned!.waited).toBeUndefined();
    expect(noticeLine([late])).toContain("parser checks done (1 background task still running)");
    expect(noticeLine([late])).not.toContain("after");
    expect(returnRow(late)).not.toHaveProperty("waited");
    // A worker that never had background work says nothing about it.
    const plain = receipt();
    observe(plain, { state: "working" }, 1000); observe(plain, { state: "done", completed: true, reply: "Ok." }, 2000);
    expect(plain.returned).not.toHaveProperty("waited");
  });

  it("bounds a record-less finished turn's background wait from when it was first seen", () => {
    const waiting = { state: "working", completed: true, background: 2, reply: "Started the server.", session: "s" } as const;
    const value = receipt();
    expect(observe(value, waiting, 1000)).toBe(true);
    expect(value.worker).toMatchObject({ state: "working", background: 2, waitingSince: new Date(1000).toISOString() });
    // Still waiting just short of the bound: the start does not move.
    expect(observe(value, { ...waiting, background: 3 }, 1000 + BACKGROUND_WAIT_MS - 1)).toBe(true);
    expect(value.worker).toMatchObject({ state: "working", background: 3, waitingSince: new Date(1000).toISOString() });
    expect(value.returned).toBeUndefined();
    // Exactly at the bound it is a finished turn, with what still runs and its reply.
    expect(observe(value, { ...waiting, background: 3 }, 1000 + BACKGROUND_WAIT_MS)).toBe(true);
    expect(value.worker).toMatchObject({ state: "done" });
    expect(value.worker).not.toHaveProperty("waitingSince");
    expect(value.returned).toMatchObject({ state: "done", background: 3, reply: "Started the server." });
    expect(noticeLine([value])).toContain("done (3 background tasks still running)");
    // An error or a question in the reply is judged as for any finished turn.
    const failed = receipt();
    observe(failed, { ...waiting, error: "usage limit" }, 0);
    observe(failed, { ...waiting, error: "usage limit" }, BACKGROUND_WAIT_MS);
    expect(failed.returned).toMatchObject({ state: "failed", error: "usage limit" });
  });

  it("starts the background wait again once the worker is plainly working", () => {
    const waiting = { state: "working", completed: true, background: 1, reply: "Started." } as const;
    const value = receipt();
    observe(value, waiting, 1000);
    expect(observe(value, { state: "working" }, 2000)).toBe(true);
    expect(value.worker).not.toHaveProperty("waitingSince");
    observe(value, waiting, 3000);
    expect(value.worker!.waitingSince).toBe(new Date(3000).toISOString());
    observe(value, waiting, 3000 + BACKGROUND_WAIT_MS - 1);
    expect(value.returned).toBeUndefined();
  });

  it("never force-finishes an observation from the worker's own hooks", () => {
    const value = receipt();
    observe(value, { state: "working", hook: true, completed: true, background: 2 }, 0);
    observe(value, { state: "working", hook: true, completed: true, background: 2 }, BACKGROUND_WAIT_MS * 3);
    expect(value.worker).toMatchObject({ state: "working" });
    expect(value.worker).not.toHaveProperty("waitingSince");
    expect(value.returned).toBeUndefined();
  });

  it("writes one plain line per notice", () => {
    const done = receipt(); observe(done, { state: "working" }, 1); observe(done, { state: "done", completed: true, reply: "**Parser checks done**, tests passed.\nDetails follow." }, 2);
    expect(noticeLine([done])).toBe(`Return: Linuxbox parser checks done, Parser checks done, tests passed. (dispatch ${done.id}). Call dispatch_returns.`);
    const gone = receipt({ id: "40000000-0000-4000-8000-000000000002", computer: "Desk", label: "nav checks" }); observe(gone, { state: "gone" }, 3);
    const line = noticeLine([done, gone]);
    expect(line).toMatch(/^Returns: 2 dispatches \(Linuxbox parser checks done, .*; Desk nav checks gone\)\. Call dispatch_returns\.$/);
    expect(line).not.toMatch(/[\x00-\x1f]/);
  });
});

describe("the dispatching Hook's returns loop", () => {
  let root: string;
  let clock: number;
  let remote: Json;
  let local: Json;
  let finalTurn: { completed: boolean; lastAssistant?: string; background?: number } | undefined;
  const deliver = vi.fn(async (_target: unknown, _text: string, _id: string) => ({ delivered: true }));

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-returns-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    clock = Date.parse("2026-09-23T12:00:00Z");
    remote = herdrSnapshot({ "w1P:p2": "working" }); local = herdrSnapshot();
    finalTurn = undefined;
    deliver.mockClear();
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Linuxbox", address: "linuxbox.example", username: "sam", port: 22, hostKey: "unused", server: "default" }]);
    // The peer answers placement like dispatch.test.ts, and worker states with
    // the receiving Hook's own code over the recorded Herdr snapshot.
    vi.mocked(peerRequest).mockImplementation(async (_peer, route, data) => {
      if (route === "/v1/dispatch/capacity") return { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 };
      if (route.startsWith("/v1/workspaces/launch")) return { ok: true, target: workerTarget };
      if (route === "/v1/dispatch/workers") return { ...await workerStates(data, readers(() => remote, finalTurn)) };
      return { ok: true };
    });
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

  const service = () => new DispatchService({ computerID: "10000000-0000-4000-8000-000000000001", validateParentTarget: async () => ({}),
    originAgent: async origin => {
      const pane = findPane(local, origin);
      const agent = provider.safeParse(pane?.agent);
      return agent.success ? { agent: agent.data, terminal: String(pane!.terminal_id) } : undefined;
    } });
  const loop = () => new DispatchReturns({ snapshot: async () => local, identity: recordedIdentity, deliver, now: () => clock });

  it("carries the background work the worker waited on through the receipt file into the return", async () => {
    remote = herdrSnapshot();
    finalTurn = { completed: true, lastAssistant: "Started the gate.", background: 5 };
    const placed = await service().dispatch(brief, conductorPane);
    const returns = loop();
    await returns.tick();
    expect((await dispatchStatus())[0].worker).toMatchObject({ state: "working", background: 5, waitingSince: new Date(clock).toISOString() });
    finalTurn = { completed: true, lastAssistant: "Gate passed." };
    clock += POLL_MS;
    await returns.tick();
    const [saved] = await dispatchStatus();
    expect(saved.returned).toMatchObject({ state: "done", waited: 5 });
    expect(deliver).toHaveBeenCalledWith(expect.anything(), `Return: Linuxbox parser checks done (after 5 background tasks finished), Gate passed. (dispatch ${placed.id}). Call dispatch_returns.`, expect.any(String));
  });

  it("keeps the dispatching pane, follows the worker to done and tells an idle conductor once", async () => {
    const placed = await service().dispatch(brief, conductorPane);
    expect(placed).toMatchObject({ state: "accepted", origin: { ...conductorPane, agent: "claude", terminal: "term_65bfee7e1f1752" } });
    const returns = loop();
    await returns.tick();
    expect((await dispatchStatus())[0].worker).toMatchObject({ state: "working", sawWorking: true });
    expect(deliver).not.toHaveBeenCalled();

    remote = herdrSnapshot();
    finalTurn = { completed: true, lastAssistant: "Parser checks done, tests passed." };
    clock += POLL_MS;
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ ...conductorPane, source: "claude", session: "00000002-1111-4111-8111-111111111111" },
      `Return: Linuxbox parser checks done, Parser checks done, tests passed. (dispatch ${placed.id}). Call dispatch_returns.`, expect.stringMatching(/^notice-[a-f0-9]{32}$/));
    expect((await dispatchStatus())[0].returned).toMatchObject({ state: "done", read: false, notifiedAt: expect.any(String) });

    clock += POLL_MS;
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);

    const rows = await returns.take();
    expect(rows).toEqual([{ id: placed.id, computer: "Linuxbox", project: "phren", label: "parser checks", harness: "claude",
      state: "done", at: expect.any(String), reply: "Parser checks done, tests passed.", target: workerTarget }]);
    expect(await returns.take()).toEqual([]);
    const stored = await readFile(path.join(root, `dispatches/${placed.id}.json`), "utf8");
    expect(stored).not.toContain(brief.prompt);
  });

  it("never interrupts a working conductor and rate-limits notices per pane", async () => {
    const placed = await service().dispatch(brief, conductorPane);
    remote = herdrSnapshot({ "w1P:p2": "blocked" });
    local = herdrSnapshot({ "w1P:p1": "working" });
    const returns = loop();
    await returns.tick();
    expect((await dispatchStatus())[0].returned).toMatchObject({ state: "blocked" });
    expect(deliver).not.toHaveBeenCalled();

    local = herdrSnapshot();
    clock += POLL_MS;
    deliver.mockResolvedValueOnce({ delivered: false });
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    // A failed delivery waits out the notice window before trying again.
    clock += POLL_MS;
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    clock += NOTICE_MS;
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith(expect.anything(), `Return: Linuxbox parser checks blocked (dispatch ${placed.id}). Call dispatch_returns.`, expect.any(String));
    // The retry names the same notice, so a first attempt that did type is not typed again.
    const ids = (deliver.mock.calls as unknown as [unknown, string, string][]).map(call => call[2]);
    expect(ids.at(-1)).toBe(ids.at(-2));
  });

  it("skips a replaced conductor, records a gone worker and stops watching it", async () => {
    await service().dispatch(brief, conductorPane);
    await service().dispatch(brief);
    // Another terminal now sits in the conductor's pane.
    local = herdrSnapshot();
    local.panes = objects(local.panes).map(pane => pane.pane_id === conductorPane.pane ? { ...pane, terminal_id: "term_other" } : pane);
    remote = herdrSnapshot({}, ["w1P:p2"]);
    const returns = loop();
    await returns.tick();
    const receipts = await dispatchStatus();
    expect(receipts.map(value => value.returned?.state)).toEqual(["gone", "gone"]);
    expect(receipts.some(value => value.origin)).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    vi.mocked(peerRequest).mockClear();
    clock += POLL_MS;
    await returns.tick();
    expect(vi.mocked(peerRequest)).not.toHaveBeenCalled();
  });

  it("follows a dispatch placed on this computer through its own Hook, never over SSH", async () => {
    // This computer's Hook answers placement; its worker states come from
    // the same code, called in-process by the returns loop.
    const localHook = vi.fn(async (route: string) => route === "/v1/dispatch/capacity"
      ? { product: "phren-hook", protocol: 1, computer: { id: remoteID }, servers: ["default"], working: 0 }
      : route.startsWith("/v1/workspaces/launch") ? { ok: true, target: workerTarget } : { ok: true });
    const here = new DispatchService(undefined, () => localHost("default", ["Laptop"], localHook as never));
    const placed = await here.dispatch({ ...brief, computer: "Laptop" });
    expect(placed).toMatchObject({ ok: true, computer: "Laptop" });
    const localWorkers = vi.fn(async (input: Json) => ({ ...await workerStates(input, readers(() => remote, finalTurn)) }));
    const watching = new DispatchReturns({ snapshot: async () => local, identity: recordedIdentity, deliver, now: () => clock,
      isLocal: computer => computer === "Laptop", localWorkers });
    await watching.tick();
    expect(localWorkers).toHaveBeenCalledWith({ targets: [expect.objectContaining({ pane: workerTarget.pane })] });
    expect(vi.mocked(peerRequest)).not.toHaveBeenCalled();
    expect((await dispatchStatus())[0].worker).toBeDefined();
  });

  it("records nothing while a peer is unreachable and leaves placing receipts alone", async () => {
    const placed = await service().dispatch(brief);
    vi.mocked(peerRequest).mockRejectedValue(new Error("offline"));
    await loop().tick();
    expect((await dispatchStatus())[0].worker).toBeUndefined();
    const file = path.join(root, `dispatches/${placed.id}.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), state: "sending" }));
    expect(await updateReceipt(String(placed.id), () => true)).toBeUndefined();
  });
});

describe("worker approvals", () => {
  const ask = { actionId: "action-1", tool: "Bash", request: "Run: rm -rf build", requestKind: "command" };
  const withAsk = (extra: Json = {}) => ({ state: "blocked", hook: true, approval: { ...ask, ...extra } });

  it("records a new approval as an unread blocked return with its question, once", () => {
    const value = receipt();
    expect(observe(value, withAsk(), 1000)).toBe(true);
    expect(value.approval).toEqual({ ...ask, at: new Date(1000).toISOString() });
    expect(value.returned).toEqual({ state: "blocked", at: new Date(1000).toISOString(), read: false, question: "Approval: Run: rm -rf build" });
    value.returned!.read = true;
    expect(observe(value, withAsk(), 2000)).toBe(false);
    expect(value.returned!.read).toBe(true);
    // A different request is a new return.
    expect(observe(value, withAsk({ actionId: "action-2", request: undefined, title: "Trust this folder?" }), 3000)).toBe(true);
    expect(value.returned).toMatchObject({ read: false, question: "Approval: Trust this folder?", at: new Date(3000).toISOString() });
  });

  it("clears the approval when the worker no longer waits, and ignores an invalid one", () => {
    const value = receipt();
    observe(value, withAsk(), 1000);
    expect(observe(value, { state: "blocked", hook: true, approval: { tool: 3 } }, 2000)).toBe(false);
    expect(value.approval).toBeDefined();
    expect(observe(value, { state: "working", hook: true }, 3000)).toBe(true);
    expect(value.approval).toBeUndefined();
    expect(observe(value, { state: "working", hook: true }, 4000)).toBe(false);
  });

  it("says who needs approval in the notice and the row, and the notice still reads as a return", () => {
    const value = receipt();
    observe(value, withAsk({ terminal: true }), 1000);
    const line = noticeLine([value]);
    expect(line).toBe(`Return: Linuxbox parser checks needs approval, Run: rm -rf build (dispatch ${value.id}; answer with dispatch_approve). Call dispatch_returns.`);
    expect(line).toMatch(/^\s*returns?:\s+[^\n]+\bCall dispatch_returns\.\s*$/i);
    expect(noticeLine([value, receipt({ id: "40000000-0000-4000-8000-000000000002" })].map(item => { if (!item.returned) observe(item, { state: "gone" }, 2000); return item; })))
      .toMatch(/^Returns: 2 dispatches \(Linuxbox parser checks needs approval, Run: rm -rf build; .*\)\. Call dispatch_returns\.$/);
    expect(returnRow(value)).toMatchObject({ state: "blocked", approval: { actionId: "action-1", tool: "Bash", request: "Run: rm -rf build", terminal: true } });
    expect(returnRow(value).approval).not.toHaveProperty("expiresAt");
  });

  describe("through the returns loop", () => {
    let root: string;
    let clock: number;
    let observed: Json;
    let owner: Record<string, unknown> | undefined;
    const answers: Json[] = [];
    const peer = { name: "Linuxbox", address: "linuxbox.example", username: "sam", port: 22, hostKey: "unused", server: "default" };
    const request = vi.fn(async (_peer: unknown, route: string, data?: Json) => {
      if (route === "/v1/dispatch/workers") return { workers: [observed] };
      if (route === "/v1/approvals/answer") { answers.push(data!); if (owner) throw owner; }
      return { ok: true };
    });
    const onApproval = vi.fn((_receipt: Receipt, _approval: unknown): boolean | void => undefined);
    const grants = vi.fn(async (_query: unknown) => undefined as { scope: string } | undefined);
    const loop = (extra: Record<string, unknown> = {}) => new DispatchReturns({ peers: async () => [peer], request: request as never, now: () => clock, findGrant: grants as never,
      snapshot: async () => ({}), identity: recordedIdentity, deliver: async () => ({ delivered: true }), onApproval, ...extra });
    const seed = async (overrides: Partial<Receipt> = {}) => {
      const value = receipt({ createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(), ...overrides });
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "dispatches"), { recursive: true });
      await writeFile(path.join(root, "dispatches", `${value.id}.json`), JSON.stringify(value));
      return value;
    };

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "phren-approvals-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
      clock = Date.parse("2026-09-23T12:00:00Z"); answers.length = 0; owner = undefined;
      observed = { state: "blocked", session: workerTarget.session, hook: true, approval: ask };
      request.mockClear(); onApproval.mockReset(); grants.mockReset().mockResolvedValue(undefined);
    });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

    it("calls onApproval once per new approval, and never for a poll that sees the same one", async () => {
      await seed();
      const returns = loop();
      await returns.poll();
      expect(onApproval).toHaveBeenCalledTimes(1);
      expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ computer: "Linuxbox" }), expect.objectContaining({ actionId: "action-1" }));
      await returns.poll();
      expect(onApproval).toHaveBeenCalledTimes(1);
      const [saved] = await dispatchStatus();
      expect(saved.approval).toMatchObject({ actionId: "action-1", tool: "Bash" });
      expect(saved.approval).not.toHaveProperty("pushed");
      expect(saved.returned).toMatchObject({ state: "blocked", read: false, question: "Approval: Run: rm -rf build" });
    });

    it("records that this Hook pushed it, and skips what the worker's Hook already pushed", async () => {
      await seed();
      onApproval.mockReturnValue(true);
      await loop().poll();
      expect((await dispatchStatus())[0].approval).toMatchObject({ pushed: true });
      onApproval.mockClear();
      observed = { ...observed, approval: { ...ask, actionId: "action-2", pushed: true } };
      await loop().poll();
      expect(onApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actionId: "action-2", pushed: true }));
    });

    it("answers a conductor call under a standing grant, and it never becomes a return", async () => {
      await seed();
      const conductor = { action: "dispatch", project: "phren", computer: "Linuxbox" };
      observed = { state: "blocked", session: workerTarget.session, hook: true, approval: { ...ask, tool: "mcp__phren__dispatch", conductor } };
      grants.mockResolvedValue({ scope: "global" });
      await loop().poll();
      expect(grants).toHaveBeenCalledWith({ action: "dispatch", project: "phren", computer: "Linuxbox" });
      expect(answers).toEqual([{ target: workerTarget, actionId: "action-1", decision: "approve" }]);
      expect(request.mock.calls.find(call => call[1] === "/v1/approvals/answer")![0]).toBe(peer);
      const [saved] = await dispatchStatus();
      expect(saved.approval).toBeUndefined();
      expect(saved.returned?.question).toBeUndefined();
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("leaves a conductor call with no grant, or whose answer failed, for the owner", async () => {
      await seed();
      const conductor = { action: "hand_off", computer: "Linuxbox" };
      observed = { state: "blocked", session: workerTarget.session, hook: true, approval: { ...ask, conductor } };
      await loop().poll();
      expect(answers).toEqual([]);
      expect((await dispatchStatus())[0].approval).toMatchObject({ actionId: "action-1", conductor });
      await rm(path.join(root, "dispatches"), { recursive: true }); await seed();
      grants.mockResolvedValue({ scope: "global" }); owner = { message: "offline" };
      await loop().poll();
      expect(answers).toHaveLength(1);
      expect((await dispatchStatus())[0].approval).toBeDefined();
    });

    it("sends the decision to the worker's peer and clears the approval", async () => {
      const value = await seed();
      const returns = loop();
      await returns.poll();
      await returns.answerApproval(value.id, "deny", "action-1");
      expect(answers).toEqual([{ target: workerTarget, actionId: "action-1", decision: "deny" }]);
      const [saved] = await dispatchStatus();
      expect(saved.approval).toBeUndefined();
      // The return stays for the conductor to read.
      expect(saved.returned).toMatchObject({ state: "blocked", read: false });
      await expect(returns.answerApproval(value.id, "approve", "action-1")).rejects.toMatchObject({ status: 409, message: "This worker is not waiting on an approval." });
    });

    it("refuses a different action id, and clears an approval its Hook says is no longer pending", async () => {
      const value = await seed();
      const returns = loop();
      await returns.poll();
      await expect(returns.answerApproval(value.id, "approve", "action-9")).rejects.toMatchObject({ status: 409 });
      expect(answers).toEqual([]);
      const { BridgeError } = await import("./protocol.js");
      owner = new BridgeError(409, "This approval is no longer pending.") as never;
      await expect(returns.answerApproval(value.id, "approve", "action-1")).rejects.toMatchObject({ status: 409, message: "This approval is no longer pending." });
      expect((await dispatchStatus())[0].approval).toBeUndefined();
    });

    it("lets only the dispatching agent answer, never the worker itself, and anyone with no pane", async () => {
      const origin = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", agent: "claude" as const, terminal: "term-1" };
      const value = await seed({ origin });
      const returns = loop({ peers: async () => [], isLocal: (computer: string) => computer === "Linuxbox", localWorkers: async () => ({ workers: [observed] }), localAnswer: async (target: unknown, actionId: string, decision: string) => { answers.push({ target, actionId, decision } as never); } });
      await returns.poll();
      const pane = (over: object) => ({ server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", ...over });
      await expect(returns.answerApproval(value.id, "approve", "action-1", pane({ pane: "w9:p9" }))).rejects.toMatchObject({ status: 403 });
      await expect(returns.answerApproval(value.id, "approve", "action-1", pane({ workspace: "w1P", tab: "w1P:t2", pane: workerTarget.pane, server: workerTarget.server }))).rejects.toMatchObject({ status: 403 });
      expect(answers).toEqual([]);
      await returns.answerApproval(value.id, "approve", "action-1", pane({}));
      expect(answers).toHaveLength(1);
    });

    it("lets no agent pane answer a dispatch with no recorded origin, only the owner without a pane", async () => {
      const value = await seed();
      const returns = loop({ peers: async () => [], isLocal: (computer: string) => computer === "Linuxbox", localWorkers: async () => ({ workers: [observed] }), localAnswer: async () => {} });
      await returns.poll();
      await expect(returns.answerApproval(value.id, "approve", "action-1", { server: workerTarget.server, workspace: workerTarget.workspace, tab: workerTarget.tab, pane: workerTarget.pane })).rejects.toMatchObject({ status: 403 });
      await expect(returns.answerApproval(value.id, "approve", "action-1", { server: "default", workspace: "w3", tab: "w3:t1", pane: "w3:p1" })).rejects.toMatchObject({ status: 403 });
      await expect(returns.answerApproval(value.id, "approve", "action-1")).resolves.toBeUndefined();
    });

    it("answers a dispatch placed on this computer without SSH", async () => {
      const value = await seed({ computer: "Laptop" });
      const localAnswer = vi.fn(async () => {});
      const returns = loop({ peers: async () => [], isLocal: (computer: string) => computer === "Laptop", localWorkers: async () => ({ workers: [observed] }), localAnswer });
      await returns.poll();
      await returns.answerApproval(value.id, "approve", "action-1");
      expect(localAnswer).toHaveBeenCalledWith(workerTarget, "action-1", "approve");
      expect(request).not.toHaveBeenCalled();
    });
  });
});


it("returns a stall once, then watches progress without claiming completion", () => {
  const current = receipt();
  const seen = { state: "working", stalled: true, stalledSince: new Date(0).toISOString(), stallFor: 301 };
  expect(observe(current, seen, 301000)).toBe(true);
  expect(returnRow(current)).toMatchObject({ state: "stalled", stalled: true, stallFor: 301 });
  current.returned!.read = true;
  observe(current, seen, 302000);
  expect(current.returned!.read).toBe(true);
  observe(current, { state: "working" }, 303000);
  expect(current.worker!.state).toBe("working");
  observe(current, { state: "done", completed: true, reply: "Checks passed" }, 304000);
  expect(returnRow(current)).toMatchObject({ state: "done", reply: "Checks passed" });
});
