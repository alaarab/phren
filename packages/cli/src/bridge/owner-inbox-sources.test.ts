import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { OwnerInbox } from "./owner-inbox.js";
import { OwnerInboxPushSweep } from "./owner-inbox-push.js";
import { AGED_CHECK_MS, ownerInboxSources, resetAgedChecks } from "./owner-inbox-sources.js";
import { dispatchStatus, updateReceipt, type Receipt } from "./dispatch.js";
import { paneChatState, recentServers, snapshot, rpc } from "./herdr.js";
import { hookPeers, peerRequest } from "./peers.js";
import { DispatchReturns, workerStates, workerTurnKey } from "./dispatch-returns.js";
import { atomicInPrivateDir, type Json } from "./protocol.js";
vi.mock("./herdr.js", async original => ({ ...await original<object>(), paneChatState: vi.fn(), recentServers: vi.fn(), snapshot: vi.fn(), rpc: vi.fn() }));
vi.mock("./dispatch.js", async original => ({ ...await original<object>(), dispatchStatus: vi.fn(), updateReceipt: vi.fn() }));
vi.mock("./dispatch-returns.js", async original => ({ ...await original<object>(), workerStates: vi.fn() }));
vi.mock("./peers.js", async original => ({ ...await original<object>(), hookPeers: vi.fn(), peerRequest: vi.fn() }));
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex" as const, session: "aaaaaaaa-1111-4111-8111-111111111111" };
let root: string, hooks: AgentHooks, panes: Json[], screen: string;
const box = () => new OwnerInbox(() => ownerInboxSources(hooks), path.join(root, "owner-inbox.json"));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "inbox-sources-")); hooks = new AgentHooks(); screen = "";
  panes = [{ pane_id: target.pane, tab_id: target.tab, workspace_id: target.workspace, agent: "codex", agent_status: "blocked" }];
  vi.mocked(recentServers).mockResolvedValue([{ session: "default" }]);
  vi.mocked(snapshot).mockImplementation(async () => ({ panes }));
  vi.mocked(paneChatState).mockResolvedValue({ sessionId: target.session });
  vi.mocked(rpc).mockImplementation(async (_server, method) => {
    if (method === "agent.read") return { read: { text: screen } };
    throw new Error(`Unexpected method ${method}`);
  });
  vi.mocked(dispatchStatus).mockResolvedValue([]);
  vi.mocked(hookPeers).mockResolvedValue([]);
});
afterEach(async () => { hooks.close(); vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("current owner inbox sources", () => {
  it.each(["working", "idle", "done", "closed"])("retires a blocked pane when it becomes %s without a phone watching", async state => {
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ live: true, target }]);
    if (state === "closed") panes = []; else panes[0].agent_status = state;
    expect((await inbox.run({})).items).toEqual([]);
    expect((await inbox.run({ includeResolved: true })).items).toMatchObject([{ state: "resolved", live: false }]);
  });
  it("drops a remembered terminal approval after the pane resumes", async () => {
    screen = "Choose permissions\n› 1. Read only\n  2. Ask for approval\n  3. Full access";
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ live: true, actionId: expect.any(String) }]);
    panes[0].agent_status = "working"; screen = "Working";
    expect((await inbox.run({})).items).toEqual([]);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
  });
  it("retires answered and auto-resolved served questions", async () => {
    const question = vi.spyOn(hooks, "servedQuestion").mockReturnValue({ actionId: "q1", message: "Choose the target?" });
    panes[0].agent_status = "working";
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ actionId: "q1" }]);
    question.mockReturnValue(undefined);
    expect((await inbox.run({})).items).toEqual([]);
  });
  it("rechecks local dispatch receipts instead of trusting stale needs-you and approval returns", async () => {
    panes = [];
    const id = "bbbbbbbb-1111-4111-8111-111111111111", at = new Date().toISOString();
    vi.mocked(dispatchStatus).mockResolvedValue([{ id, computer: "local", target, project: "phren", label: "pr-finisher", createdAt: at,
      returned: { state: "needs-you", at, question: "Continue?" },
      approval: { actionId: "stale-approval", tool: "Bash", at },
    }] as never);
    let workers: Json[] = [{ state: "idle", completed: true, reply: "Continue?" }];
    vi.mocked(workerStates).mockImplementation(async () => ({ workers }) as never);
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ kind: "needs-you", title: "Continue?", live: true }]);
    workers = [{ state: "working", approval: { actionId: "new-approval", request: "Run tests?" } }];
    expect((await inbox.run({})).items).toMatchObject([{ kind: "blocked", actionId: "new-approval", live: true }]);
    workers = [{ state: "working" }];
    expect((await inbox.run({})).items).toEqual([]);
    workers = [{ state: "blocked" }];
    expect((await inbox.run({})).items).toHaveLength(1);
    workers = [{ state: "gone" }];
    expect((await inbox.run({})).items).toEqual([]);
    // Gone while the returns loop still watches it: its return is that loop's to record, so the receipt stays open.
    expect(updateReceipt).not.toHaveBeenCalled();
    expect(peerRequest).not.toHaveBeenCalled();
  });

  it("never lists a worker parked waiting on CI as needing the owner", async () => {
    panes = [];
    const at = new Date().toISOString();
    // A waiting return is never a candidate row.
    vi.mocked(dispatchStatus).mockResolvedValue([{ id: "bbbbbbbb-1111-4111-8111-111111111112", computer: "local", target, project: "phren", label: "pr-finisher", createdAt: at,
      returned: { state: "waiting", at, waitingOn: "ci", waitingFor: "Waiting on CI for #940." },
      worker: { state: "waiting", since: at, checkedAt: at, sawWorking: true } }] as never);
    expect((await box().run({})).items).toEqual([]);
    expect(workerStates).not.toHaveBeenCalled();
    // An older peer Hook folded the wait into its unfinished reason: still no row.
    vi.mocked(dispatchStatus).mockResolvedValue([{ id: "bbbbbbbb-1111-4111-8111-111111111113", computer: "local", target, project: "phren", label: "pr-finisher", createdAt: at,
      returned: { state: "needs-you", at, question: "Continue?" } }] as never);
    let workers: Json[] = [{ state: "idle", completed: true, reply: "PR #12 is open. Now waiting on CI.", unfinished: "Stopped waiting: Now waiting on CI." }];
    vi.mocked(workerStates).mockImplementation(async () => ({ workers }) as never);
    expect((await box().run({})).items).toEqual([]);
    // A real unfinished reason still is a row.
    workers = [{ state: "idle", completed: true, unfinished: "Stopped with 9 uncommitted files and no PR." }];
    expect((await box().run({})).items).toMatchObject([{ kind: "needs-you", title: "Stopped with 9 uncommitted files and no PR.", live: true }]);
  });

  it("closes a local receipt whose worker is closed, or gone after the returns loop stopped watching it", async () => {
    panes = [];
    const at = new Date().toISOString(), old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const receipt = (id: string, createdAt: string) => ({ id, computer: "local", target, project: "phren", label: "worker", createdAt,
      returned: { state: "blocked", at: createdAt } });
    vi.mocked(dispatchStatus).mockResolvedValue([receipt("cccccccc-1111-4111-8111-000000000001", at), receipt("cccccccc-1111-4111-8111-000000000002", old),
      receipt("cccccccc-1111-4111-8111-000000000003", at)] as never);
    vi.mocked(workerStates).mockResolvedValue({ workers: [{ state: "closed" }, { state: "gone" }, { state: "gone" }] } as never);
    const changed: Json[] = [];
    vi.mocked(updateReceipt).mockImplementation(async (id, change) => {
      const current = { id } as never as Receipt;
      if (change(current)) changed.push({ id, closedAt: current.closedAt });
      return current;
    });
    expect((await box().run({})).items).toEqual([]);
    expect(changed.map(row => row.id).sort()).toEqual(["cccccccc-1111-4111-8111-000000000001", "cccccccc-1111-4111-8111-000000000002"]);
    expect(changed.every(row => typeof row.closedAt === "string")).toBe(true);
  });
});

describe("dispatches on other computers", () => {
  // Each worker in a pane of its own: the inbox keeps one item per pane.
  const remote = (id: string, fields: Json) => ({ id, computer: "Desk", target: { ...target, pane: `w1:p${id.slice(-1)}` }, project: "phren", label: "worker",
    createdAt: new Date().toISOString(), returned: { state: "blocked", at: new Date().toISOString() }, ...fields });

  it("sends one alert from the worker Hook when both Hooks list its approval", async () => {
    const workerInbox = box();
    const dispatchInbox = new OwnerInbox(() => ownerInboxSources(hooks), path.join(root, "dispatch-inbox.json"));
    const device = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workerSend = vi.fn(async () => true), dispatchSend = vi.fn(async () => true);
    const workerPush = new OwnerInboxPushSweep({ ownerInboxPushDevices: () => [device], notifyOwnerInbox: workerSend }, {
      file: path.join(root, "worker-push.json"), isOpenForPush: id => workerInbox.isOpenForPush(id),
    });
    const dispatchPush = new OwnerInboxPushSweep({ ownerInboxPushDevices: () => [device], notifyOwnerInbox: dispatchSend }, {
      file: path.join(root, "dispatch-push.json"), isOpenForPush: id => dispatchInbox.isOpenForPush(id),
    });

    const approval = { actionId: "a-1", tool: "Bash", request: "Run the suite?", at: new Date().toISOString() };
    vi.spyOn(hooks, "workerApproval").mockReturnValue(approval);
    const workerRows = await workerInbox.tick();
    expect(workerRows).toMatchObject([{ actionId: approval.actionId, target }]);
    await workerPush.observe(workerRows);

    panes = [];
    vi.mocked(dispatchStatus).mockResolvedValue([
      remote("dddddddd-1111-4111-8111-000000000001", { approval }),
    ] as never);
    const dispatchRows = await dispatchInbox.tick();
    expect(dispatchRows).toMatchObject([{ actionId: approval.actionId, computer: "Desk", target }]);
    await dispatchPush.observe(dispatchRows);

    expect([...workerSend.mock.calls, ...dispatchSend.mock.calls]).toEqual([
      [{ id: workerRows[0].id, title: approval.request, expiresAt: expect.any(String) }, device],
    ]);
  });

  it("are shown from what the returns loop stored, with no SSH however many ticks run", async () => {
    panes = [];
    const at = new Date().toISOString();
    vi.mocked(dispatchStatus).mockResolvedValue([
      remote("dddddddd-1111-4111-8111-000000000001", { worker: { state: "blocked", since: at, checkedAt: at, sawWorking: true } }),
      remote("dddddddd-1111-4111-8111-000000000002", { approval: { actionId: "a-1", tool: "Bash", request: "Run the suite?", at },
        worker: { state: "working", since: at, checkedAt: at, sawWorking: true } }),
      remote("dddddddd-1111-4111-8111-000000000003", { returned: { state: "needs-you", at, question: "Which branch?" },
        worker: { state: "needs-you", since: at, checkedAt: at, sawWorking: true } }),
      // Back at work after its approval was answered: its last return still says blocked, but nothing waits.
      remote("dddddddd-1111-4111-8111-000000000004", { worker: { state: "working", since: at, checkedAt: at, sawWorking: true } }),
      remote("dddddddd-1111-4111-8111-000000000005", { worker: { state: "gone", since: at, checkedAt: at, sawWorking: true } }),
    ] as never);
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }] as never);
    const inbox = box();
    for (let tick = 0; tick < 50; tick++) await inbox.run({});
    const items = (await inbox.run({})).items;
    expect(items.map(item => [item.dispatch, item.kind, item.title, item.actionId, item.computer])).toEqual([
      ["dddddddd-1111-4111-8111-000000000001", "blocked", "worker needs input", undefined, "Desk"],
      ["dddddddd-1111-4111-8111-000000000002", "blocked", "Run the suite?", "a-1", "Desk"],
      ["dddddddd-1111-4111-8111-000000000003", "needs-you", "Which branch?", undefined, "Desk"],
    ]);
    expect(peerRequest).not.toHaveBeenCalled();
    expect(workerStates).not.toHaveBeenCalled();
  });

  it("follow the stored state: an answered approval or a worker back at work resolves the row", async () => {
    panes = [];
    const at = new Date().toISOString();
    let receipt: Json = remote("dddddddd-1111-4111-8111-000000000006", { approval: { actionId: "a-2", tool: "Bash", request: "Push?", at },
      worker: { state: "working", since: at, checkedAt: at, sawWorking: true } });
    vi.mocked(dispatchStatus).mockImplementation(async () => [receipt] as never);
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ actionId: "a-2", live: true }]);
    // The returns loop saw the approval answered and the worker at work.
    receipt = { ...receipt, approval: undefined };
    expect((await inbox.run({})).items).toEqual([]);
    expect(peerRequest).not.toHaveBeenCalled();
  });

  it("reconciles an old CI wait out of the remote inbox without reopening the return", async () => {
    panes = [];
    vi.stubEnv("PHREN_BRIDGE_HOME", root);
    const actual = await vi.importActual<typeof import("./dispatch.js")>("./dispatch.js");
    vi.mocked(dispatchStatus).mockImplementation(actual.dispatchStatus);
    vi.mocked(updateReceipt).mockImplementation(actual.updateReceipt);
    const id = "dddddddd-1111-4111-8111-000000000007", at = new Date(Date.now() - 60_000).toISOString();
    const notifiedAt = new Date(Date.parse(at) + 1000).toISOString();
    const seen = { state: "done", completed: true, reply: "PR #12 is open. Now waiting on CI.", unfinished: "Stopped waiting: Now waiting on CI." };
    const turn = workerTurnKey(seen);
    await atomicInPrivateDir(path.join(root, "dispatches", `${id}.json`), remote(id, {
      state: "accepted", harness: "codex", createdAt: at, updatedAt: notifiedAt,
      worker: { state: "needs-you", since: at, checkedAt: at, sawWorking: true },
      returned: { state: "needs-you", at, read: true, notifiedAt, turn, reply: seen.reply, question: seen.unfinished },
    }));
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }] as never);
    vi.mocked(peerRequest).mockResolvedValue({ workers: [seen] });
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ dispatch: id, kind: "needs-you", live: true }]);
    await new DispatchReturns().poll();
    const [saved] = await dispatchStatus();
    expect(saved.worker).toMatchObject({ state: "waiting", waitingOn: "ci" });
    expect(saved.returned).toMatchObject({ at, read: true, notifiedAt, turn, state: "waiting", waitingOn: "ci", waitingFor: "Now waiting on CI." });
    expect(saved.returned).not.toHaveProperty("question");
    expect((await inbox.run({})).items).toEqual([]);
    expect((await inbox.run({ includeResolved: true })).items).toMatchObject([{ dispatch: id, state: "resolved", live: false }]);
  });

  describe("past the returns loop's watch", () => {
    const old = () => new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const aged = (id: string, read = true) => remote(id, { createdAt: old(), returned: { state: "blocked", at: old(), read },
      worker: { state: "blocked", since: old(), checkedAt: old(), sawWorking: true } });
    let clock: number;
    beforeEach(() => {
      resetAgedChecks();
      clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }] as never);
      panes = [];
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("are asked about once an hour, and shown only while the computer confirms the wait; the owner can dismiss them", async () => {
      vi.mocked(dispatchStatus).mockResolvedValue([aged("eeeeeeee-1111-4111-8111-000000000001")] as never);
      vi.mocked(peerRequest).mockResolvedValue({ workers: [{ state: "blocked" }] });
      const inbox = box();
      const [item] = (await inbox.run({})).items;
      expect(item).toMatchObject({ kind: "blocked", computer: "Desk", live: true });
      for (let tick = 0; tick < 50; tick++) { clock += 5_000; await inbox.run({}); }
      expect(peerRequest).toHaveBeenCalledTimes(1);
      await inbox.run({ action: "resolve", id: item.id, resolution: "Old; not needed." });
      expect((await inbox.run({})).items).toEqual([]);
      clock += AGED_CHECK_MS;
      await inbox.run({});
      expect(peerRequest).toHaveBeenCalledTimes(2);
    });

    it("close their receipt once the worker is gone, unless its return is unread", async () => {
      vi.mocked(dispatchStatus).mockResolvedValue([aged("eeeeeeee-1111-4111-8111-000000000002"), aged("eeeeeeee-1111-4111-8111-000000000003", false)] as never);
      vi.mocked(peerRequest).mockResolvedValue({ workers: [{ state: "gone" }, { state: "gone" }] });
      const closed: string[] = [];
      vi.mocked(updateReceipt).mockImplementation(async (id, change) => {
        const current = { id } as never as Receipt;
        if (change(current)) closed.push(id);
        return current;
      });
      expect((await box().run({})).items).toEqual([]);
      expect(closed).toEqual(["eeeeeeee-1111-4111-8111-000000000002"]);
    });

    it("are hidden, not resolved, while the computer cannot answer, and it is asked again only an hour later", async () => {
      vi.mocked(dispatchStatus).mockResolvedValue([aged("eeeeeeee-1111-4111-8111-000000000004")] as never);
      vi.mocked(peerRequest).mockResolvedValue({ workers: [{ state: "blocked" }] });
      const inbox = box();
      expect((await inbox.run({})).items).toHaveLength(1);
      clock += AGED_CHECK_MS;
      vi.mocked(peerRequest).mockRejectedValue(new Error("offline"));
      expect((await inbox.run({})).items).toEqual([]);
      for (let tick = 0; tick < 50; tick++) { clock += 5_000; await inbox.run({}); }
      expect(peerRequest).toHaveBeenCalledTimes(2);
      // Back: the same item, still open.
      clock += AGED_CHECK_MS;
      vi.mocked(peerRequest).mockResolvedValue({ workers: [{ state: "blocked" }] });
      expect((await inbox.run({})).items).toHaveLength(1);
      expect((await inbox.run({ includeResolved: true })).items).toHaveLength(1);
    });
  });
});
