// Dispatch returns carry the worker session's task ledger (task/session-tasks.ts,
// issue #934): the receiving Hook's observation lists the tasks the worker took
// on, a turn that ended owing one returns as needs-you naming the bids through
// the existing `unfinished` reason, and the receipt keeps the latest rows for
// `dispatch_returns`. A peer that sends no `tasks` reads as before.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchStatus, updateReceipt, type Receipt } from "./dispatch.js";
import { observe, returnRow, workerStates, type WorkerReaders } from "./dispatch-returns.js";
import type { FinalTurn } from "./schedule-watch.js";
import { nextTurn, type TurnRecord } from "./turn-records.js";
import type { SessionTaskResolution, SessionTaskState } from "../task/session-tasks.js";
import { atomicInPrivateDir, type Json, type Target } from "./protocol.js";

const session = "00000003-1111-4111-8111-111111111111";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t2", pane: "w1:p2", source: "claude", session };
const dispatch = "50000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-11-26T12:00:00Z");

const pane = (): Json => ({ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent: "claude", terminal_id: "term-w", agent_status: "idle",
  agent_session: { kind: "id", agent: "claude", value: session } });

/** A ledger row, as `sessionTaskStates` would read it back. */
const task = (resolution: SessionTaskResolution, stableId: string, over: Partial<SessionTaskState> = {}): SessionTaskState =>
  ({ store: "/primary", project: "phren", stableId, title: "Close the wire panel", section: "Active", resolution, ...over });

/** A prompt with its Stop, as the worker's own hooks recorded it. */
const endedTurn = (reply = "Done."): TurnRecord => nextTurn(
  nextTurn(undefined, { event: "UserPromptSubmit", terminal: "term-w", source: "claude", session, at: now })!,
  { event: "Stop", terminal: "term-w", source: "claude", session, at: now + 1000, reply })!;

/** Fake readers over one idle pane and its recorded turn; no `sessionTasks`
 * reader stands in for an older worker Hook. */
const readers = (states?: SessionTaskState[], over: Partial<WorkerReaders> = {}): WorkerReaders => ({
  snapshot: async () => ({ panes: [pane()] }),
  identity: async () => session,
  finalTurn: async () => undefined,
  turn: async () => endedTurn(),
  now: () => now,
  ...(states ? { sessionTasks: () => states } : {}),
  ...over,
});

const receipt = (): Receipt => ({ id: dispatch, computer: "Desk", project: "phren", harness: "claude", label: "wire panel",
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), state: "accepted", target } as Receipt);

let bridge: string;
beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "phren-returns-tasks-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

describe("the worker session's task ledger in dispatch returns", () => {
  it("returns a turn that still owes a task as needs-you, naming the bid", async () => {
    const answer = await workerStates({ targets: [target] }, readers([task("open", "aaaa0001")]));
    expect(answer.workers[0]).toMatchObject({ state: "done", session, completed: true, hook: true,
      tasks: [{ project: "phren", stableId: "aaaa0001", title: "Close the wire panel", section: "Active", resolution: "open" }],
      unfinished: "1 task(s) not settled: bid:aaaa0001" });
    const value = receipt();
    observe(value, answer.workers[0], now);
    expect(value.returned).toMatchObject({ state: "needs-you", question: "1 task(s) not settled: bid:aaaa0001", read: false,
      tasks: [{ project: "phren", stableId: "aaaa0001", resolution: "open" }] });
  });

  it("lists the tasks the session settled and reads the turn done", async () => {
    const states = [task("done", "aaaa0001", { section: "Done" }), task("queue", "bbbb0002", { section: "Queue" }), task("parked", "cccc0003")];
    const answer = await workerStates({ targets: [target] }, readers(states));
    expect(answer.workers[0]).toMatchObject({ state: "done", completed: true,
      tasks: states.map(state => expect.objectContaining({ stableId: state.stableId, resolution: state.resolution })) });
    expect(answer.workers[0]).not.toHaveProperty("unfinished");
    const value = receipt();
    observe(value, answer.workers[0], now);
    expect(value.returned).toMatchObject({ state: "done",
      tasks: [{ resolution: "done" }, { resolution: "queue" }, { resolution: "parked" }] });
  });

  it("adds nothing without a ledger, and an older peer's return reads unchanged", async () => {
    const empty = await workerStates({ targets: [target] }, readers([]));
    expect(empty.workers[0]).not.toHaveProperty("tasks");
    expect(empty.workers[0]).not.toHaveProperty("unfinished");
    const older = await workerStates({ targets: [target] }, readers(undefined));
    expect(older.workers[0]).toEqual(empty.workers[0]);
    const value = receipt();
    observe(value, older.workers[0], now);
    expect(value.returned).toMatchObject({ state: "done" });
    expect(value.returned).not.toHaveProperty("tasks");
  });

  it("keeps the reply's own unfinished reason; the tasks it owes only fill in", async () => {
    const withReply = (reply: string): WorkerReaders => ({ ...readers([task("open", "aaaa0001")]), turn: async () => endedTurn(reply) });
    const answer = await workerStates({ targets: [target] }, withReply("Let me run the tests."));
    expect(answer.workers[0]).toMatchObject({ state: "done", unfinished: "Stopped mid-task: Let me run the tests.",
      tasks: [{ stableId: "aaaa0001", resolution: "open" }] });
  });

  it("leaves a turn that waits on CI waiting, with the task it still owes on the return", async () => {
    const waiting: WorkerReaders = { ...readers([task("open", "aaaa0001")]), turn: async () => endedTurn("Opened #940. Waiting on CI for #940.") };
    const answer = await workerStates({ targets: [target] }, waiting);
    expect(answer.workers[0]).toMatchObject({ state: "done", waiting: "Waiting on CI for #940.", tasks: [{ stableId: "aaaa0001", resolution: "open" }] });
    expect(answer.workers[0]).not.toHaveProperty("unfinished");
    const value = receipt();
    observe(value, answer.workers[0], now);
    expect(value.returned).toMatchObject({ state: "waiting", waitingOn: "ci", tasks: [{ stableId: "aaaa0001", resolution: "open" }] });
    expect(value.returned).not.toHaveProperty("question");
  });

  it("reads the ledger on the snapshot path too, without a turn record", async () => {
    const final: FinalTurn = { completed: true, lastAssistant: "Done." };
    const answer = await workerStates({ targets: [target] }, readers([task("open", "aaaa0001")], { turn: undefined, finalTurn: async () => final }));
    expect(answer.workers[0]).toMatchObject({ state: "idle", session, completed: true,
      tasks: [{ stableId: "aaaa0001", resolution: "open" }], unfinished: "1 task(s) not settled: bid:aaaa0001" });
    expect(answer.workers[0]).not.toHaveProperty("hook");
  });

  it("counts an open task past 32 settled ones, and sends open rows first", async () => {
    const settled = Array.from({ length: 32 }, (_, index) => task("done", index.toString(16).padStart(8, "0"), { section: "Done" }));
    const answer = await workerStates({ targets: [target] }, readers([...settled, task("open", "ffff0001")]));
    expect(answer.workers[0].unfinished).toBe("1 task(s) not settled: bid:ffff0001");
    expect(answer.workers[0].tasks).toHaveLength(32);
    expect(answer.workers[0].tasks?.[0]).toMatchObject({ stableId: "ffff0001", resolution: "open" });
  });

  it("bounds what it carries: 32 rows, and a reason capped at 200 characters", async () => {
    const many = Array.from({ length: 40 }, (_, index) => task("open", index.toString(16).padStart(8, "0")));
    const answer = await workerStates({ targets: [target] }, readers(many));
    expect(answer.workers[0].tasks?.length).toBe(32);
    const reason = answer.workers[0].unfinished!;
    expect(reason.length).toBeLessThanOrEqual(200);
    // Every open task is still owed even though only 32 rows travel.
    expect(reason).toMatch(/^40 task\(s\) not settled: bid:/);
  });

  it("keeps the latest tasks on the receipt's returned record and its return row", async () => {
    await atomicInPrivateDir(path.join(bridge, "dispatches", `${dispatch}.json`), receipt());
    const observation = (await workerStates({ targets: [target] }, readers([task("open", "aaaa0001")]))).workers[0];
    await updateReceipt(dispatch, value => observe(value, observation, now));
    const stored = (await dispatchStatus()).find(value => value.id === dispatch)!;
    expect(stored.returned).toMatchObject({ state: "needs-you", question: "1 task(s) not settled: bid:aaaa0001",
      tasks: [{ project: "phren", stableId: "aaaa0001", title: "Close the wire panel", section: "Active", resolution: "open" }] });
    expect(returnRow(stored)).toMatchObject({ tasks: [{ stableId: "aaaa0001", resolution: "open" }] });
  });
});
