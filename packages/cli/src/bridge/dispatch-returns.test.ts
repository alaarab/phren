import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchService, dispatchStatus, updateReceipt, type Receipt } from "./dispatch.js";
import { DispatchReturns, NOTICE_MS, noticeLine, observe, POLL_MS, REPLY_LIMIT, workerStates, type WorkerReaders } from "./dispatch-returns.js";
import { findPane } from "./herdr.js";
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

function readers(snapshot: () => Json, reply?: { completed: boolean; lastAssistant?: string }): WorkerReaders {
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

  it("waits for an idle worker that never started, and upgrades a starting target", () => {
    const starting = { server: "default", workspace: "w1P", tab: "w1P:t2", pane: "w1P:p2", source: "claude" as const, starting: true as const, startingToken: "a".repeat(64) };
    const value = receipt({ target: starting, createdAt: new Date(0).toISOString() });
    observe(value, { state: "idle", session: workerTarget.session, completed: false }, 1000);
    expect(value.worker!.state).toBe("working");
    expect(value.target).toEqual(workerTarget);
    observe(value, { state: "idle", completed: false }, 10 * 60 * 1000);
    expect(value.returned).toMatchObject({ state: "done" });
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
  let finalTurn: { completed: boolean; lastAssistant?: string } | undefined;
  const deliver = vi.fn(async () => ({ delivered: true }));

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
      `Return: Linuxbox parser checks done, Parser checks done, tests passed. (dispatch ${placed.id}). Call dispatch_returns.`);
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
    expect(deliver).toHaveBeenLastCalledWith(expect.anything(), `Return: Linuxbox parser checks blocked (dispatch ${placed.id}). Call dispatch_returns.`);
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
