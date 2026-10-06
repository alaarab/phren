// Dispatch returns from the worker's own turn events: the Hook records
// SessionStart / UserPromptSubmit / Stop per pane (turn-records.ts), the
// worker's Hook answers /v1/dispatch/workers from that record, and the
// dispatching Hook turns it into done, failed or still working.
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks, stopFacts } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { BACKGROUND_WAIT_MS, DispatchReturns, INTERRUPTED, noticeDeliveryId, noticeLine, observe, POLL_MS, workerStates, type WorkerReaders } from "./dispatch-returns.js";
import { rpc, snapshot } from "./herdr.js";
import { atomicInPrivateDir, type Json, type Target } from "./protocol.js";
import { ENDLESS_COMMAND, finalTurnFromLines, type FinalTurn } from "./schedule-watch.js";
import { nextTurn, noteTurn, readTurn, turnPhase, type TurnRecord } from "./turn-records.js";
import { StallDetector } from "./stalls.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(),
}));

const session = "00000003-1111-4111-8111-111111111111";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t2", pane: "w1:p2", source: "claude", session };
const workerPane = { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent: "claude", terminal_id: "term-w", agent_status: "idle",
  agent_session: { kind: "id", agent: "claude", value: session } };

let bridge: string;
beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "phren-turns-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

const event = (name: string, extra: Partial<Parameters<typeof nextTurn>[1]> = {}) =>
  ({ event: name, terminal: "term-w", source: "claude" as const, session, ...extra });

describe("the turn record", () => {
  it("orders prompt and Stop by event, not by clock", () => {
    let record = nextTurn(undefined, event("SessionStart"))!;
    expect(turnPhase(record)).toEqual({ phase: "unprompted" });
    record = nextTurn(record, event("UserPromptSubmit"))!;
    expect(turnPhase(record)).toMatchObject({ phase: "working" });
    // Same millisecond, still after the prompt.
    record = nextTurn(record, event("Stop", { at: Date.parse(record.prompt!.at), background: 2, reply: "  Done.  " }))!;
    expect(turnPhase(record)).toEqual({ phase: "ended", at: record.prompt!.at, background: 2, reply: "Done." });
    // A task-notification wakes the worker: a new prompt, working again.
    record = nextTurn(record, event("UserPromptSubmit"))!;
    expect(turnPhase(record).phase).toBe("working");
    expect(nextTurn(record, event("PreToolUse"))).toBeUndefined();
  });

  it("starts over for another conversation or terminal in the pane, and caps the reply", () => {
    const first = nextTurn(nextTurn(undefined, event("UserPromptSubmit"))!, event("Stop"))!;
    const other = nextTurn(first, event("SessionStart", { session: "00000009-1111-4111-8111-111111111111" }))!;
    expect(other).toMatchObject({ seq: 1, session: "00000009-1111-4111-8111-111111111111" });
    expect(other.prompt).toBeUndefined();
    expect(nextTurn(first, event("SessionStart", { terminal: "term-x" }))!.stop).toBeUndefined();
    const long = nextTurn(first, event("Stop", { reply: "é".repeat(5000) }))!;
    expect(Buffer.byteLength(long.stop!.reply!)).toBeLessThanOrEqual(4000);
    expect(long.stop!.truncated).toBe(true);
  });

  it("persists per pane and keeps concurrent events in order", async () => {
    await Promise.all([noteTurn("default", "w1:p2", event("UserPromptSubmit")), noteTurn("default", "w1:p2", event("Stop", { background: 0 }))]);
    expect(turnPhase((await readTurn("default", "w1:p2"))!)).toMatchObject({ phase: "ended" });
    expect(await readTurn("default", "w1:p9")).toBeUndefined();
  });
});

describe("what a Stop payload says", () => {
  it("counts Claude Code's in-flight background tasks and keeps the last message", () => {
    expect(stopFacts({ background_tasks: [{ id: "b1", type: "shell", status: "running" }, { id: "a2", type: "subagent", status: "pending" },
      { id: "b3", type: "shell", status: "completed" }], last_assistant_message: "Tests pass." })).toEqual({ background: 2, reply: "Tests pass." });
    expect(stopFacts({ background_tasks: [] })).toEqual({ background: 0 });
    // Codex and older Claude Code say nothing about background work.
    expect(stopFacts({ last_assistant_message: "  " })).toEqual({});
  });
});

describe("the transcript's own record of a turn", () => {
  const line = (value: Json) => JSON.stringify(value);
  const assistant = (text: string) => line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
  const result = (toolUseResult: Json) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }, toolUseResult });
  const notice = (id: string, status?: string) => `<task-notification>\n<task-id>${id}</task-id>\n${status ? `<status>${status}</status>\n` : ""}<summary>x</summary>\n</task-notification>`;
  const user = (content: string) => line({ type: "user", message: { role: "user", content }, origin: { kind: "task-notification" } });

  it("counts Claude background shells, subagents and monitors until they end", () => {
    const started = [line({ type: "user", message: { role: "user", content: "Run the suite" } }),
      result({ backgroundTaskId: "bshell001" }), result({ isAsync: true, status: "async_launched", agentId: "aagent0001" }),
      result({ taskId: "bmonitor01", timeoutMs: 3600000, persistent: false }), result({ taskId: "bforever1", timeoutMs: 0, persistent: true }),
      assistant("Running in the background.")];
    expect(finalTurnFromLines(started, "claude")).toMatchObject({ completed: true, background: 3 });
    const ended = [...started, user(notice("bshell001", "completed")), assistant("Shell done."),
      // A monitor event is not its end.
      user(notice("bmonitor01")), assistant("Still watching."),
      line({ type: "attachment", attachment: { type: "queued_command", prompt: notice("aagent0001", "completed") } }),
      result({ message: "Successfully stopped task: bmonitor01 (watch)", task_id: "bmonitor01", task_type: "local_bash" }), assistant("All done.")];
    expect(finalTurnFromLines(ended, "claude")).toEqual({ completed: true, lastAssistant: "All done." });
  });

  it("reads finishes an idle session only queued, and when each task finished", () => {
    const queued = (operation: string, id: string, timestamp: string) => line({ type: "queue-operation", operation, timestamp, content: notice(id, "completed") });
    const lines = [line({ type: "user", message: { role: "user", content: "Build" } }),
      result({ backgroundTaskId: "bshell001" }), result({ backgroundTaskId: "bshell002" }), assistant("Building."),
      queued("enqueue", "bshell001", "2026-09-29T09:01:00.000Z"),
      // Its later removal is the same finish, not a second one.
      queued("remove", "bshell001", "2026-09-29T09:05:00.000Z"),
      line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-29T09:02:00.000Z", content: notice("bmonitor01") })];
    expect(finalTurnFromLines(lines, "claude")).toEqual({ completed: true, lastAssistant: "Building.", background: 1, finishedTasks: ["2026-09-29T09:01:00.000Z"], awaited: 1 });
  });

  it("awaits only shells and monitors started since the owner's last prompt, and no endless stream", () => {
    // talk-while-working on the Mini, 2026-09-29: 8 shells running, none of them waited on.
    const launch = (id: string, command: string) => [
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command, run_in_background: true } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "ok" }] }, toolUseResult: { backgroundTaskId: id } })];
    const owner = (content: string) => line({ type: "user", message: { role: "user", content } });
    const earlier = [owner("Build and watch the simulator"), ...launch("bbuild0", "pnpm build"), ...launch("btail00", "xcrun simctl spawn booted log stream --level debug"),
      ...launch("bfollow", "tail -F /tmp/app.log"), ...launch("bwatch0", "pnpm vitest --watch"), ...launch("bserve0", "pnpm run dev"),
      result({ taskId: "bmonitor01", timeoutMs: 600000, persistent: false }), result({ isAsync: true, status: "async_launched", agentId: "aagent0001" }), assistant("Building.")];
    // The build, the monitor and the agent run; the agent is the child tree's to count.
    expect(finalTurnFromLines(earlier, "claude")).toMatchObject({ completed: true, background: 7, awaited: 2 });
    // A notification waking the session is not the owner moving on.
    const woken = [...earlier, user(notice("bmonitor01", "completed")), assistant("The monitor fired.")];
    expect(finalTurnFromLines(woken, "claude")).toMatchObject({ completed: true, background: 6, awaited: 1 });
    // Once the owner moves on, what earlier turns left running is a leftover.
    const later = [...woken, owner("Thanks, what next?"), assistant("Next is the icon.")];
    const final = finalTurnFromLines(later, "claude");
    expect(final).toMatchObject({ completed: true, background: 6 });
    expect(final.awaited).toBeUndefined();
    // A new build started after that prompt is awaited again, until it ends.
    const again = [...later, ...launch("bbuild1", "xcodebuild test"), assistant("Testing.")];
    expect(finalTurnFromLines(again, "claude")).toMatchObject({ background: 7, awaited: 1 });
    expect(finalTurnFromLines([...again, user(notice("bbuild1", "failed")), assistant("Tests failed.")], "claude").awaited).toBeUndefined();
  });

  it("awaits a shell started before the dispatcher's prompt once the agent reads it again", () => {
    // ios-fast-voice2 (Mini, 2026-10-01): its MacBook test run outran the Bash
    // timeout into the background, the conductor's hand_off arrived, the agent
    // read the run's output and ended on "Now waiting on the MacBook rerun."
    const owner = (content: string) => line({ type: "user", message: { role: "user", content } });
    const call = (id: string, command: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
    const run = [owner("Fix the voice tests"), call("toolu_mbp", "ssh mbp 'xcodebuild test -only-testing:TalkVoiceTests'"),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mbp", content: "moved to the background" }] }, toolUseResult: { backgroundTaskId: "boj3ma6t7" } }),
      assistant("I'll push and open the PR when it reports back."), owner("Conductor: the sibling's PR is open now.")];
    expect(finalTurnFromLines([...run, call("toolu_git", "git merge-tree HEAD origin/x"), assistant("Done.")], "claude")).toMatchObject({ background: 1 });
    expect(finalTurnFromLines([...run, call("toolu_git", "git merge-tree HEAD origin/x"), assistant("Done.")], "claude").awaited).toBeUndefined();
    const read = [...run, call("toolu_cat", "cat /private/tmp/claude-501/x/tasks/boj3ma6t7.output | tail -8"), assistant("Now waiting on the MacBook rerun.")];
    expect(finalTurnFromLines(read, "claude")).toMatchObject({ completed: true, background: 1, awaited: 1 });
    expect(finalTurnFromLines([...read, user(notice("boj3ma6t7", "completed")), assistant("Pushed.")], "claude")).toEqual({ completed: true, lastAssistant: "Pushed." });
  });

  it("counts the endless streams among the running shells", () => {
    const launch = (id: string, command: string) => [
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command, run_in_background: true } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "ok" }] }, toolUseResult: { backgroundTaskId: id } })];
    const lines = [line({ type: "user", message: { role: "user", content: "Go" } }), ...launch("btail00", "tail -f /tmp/x"), ...launch("bbuild0", "pnpm build"), assistant("Building.")];
    expect(finalTurnFromLines(lines, "claude")).toMatchObject({ background: 2, awaited: 1, endless: 1 });
  });

  it("recognizes commands that run until killed", () => {
    for (const command of ["tail -f log", "tail -F /tmp/x", "tail --follow=name x", "journalctl --user -fu phren-hook", "log stream --predicate x",
      "adb logcat", "watch -n1 ls", "cd app && watch -n5 make", "sudo watch df", "tsc --watch", "inotifywait -m .", "fswatch src", "npm run dev", "pnpm dev", "bun preview", "python3 -m http.server 8000", "sleep infinity"]) {
      expect(ENDLESS_COMMAND.test(command), command).toBe(true);
    }
    for (const command of ["pnpm build", "tail -n 50 log", "xcodebuild test", "npm test", "sleep 60 && curl x", "journalctl -n 20", "git log --stat", "npm run devtools-build",
      "grep watch file", "rg -n 'watch ' src"]) {
      expect(ENDLESS_COMMAND.test(command), command).toBe(false);
    }
  });

  it("marks a turn the owner interrupted, in Claude and in Codex", () => {
    const claude = [line({ type: "user", message: { role: "user", content: "Go" } }),
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })];
    expect(finalTurnFromLines(claude, "claude")).toEqual({ completed: false, interrupted: true });
    const codex = [line({ type: "response_item", payload: { type: "message", role: "user", content: "Go" } }),
      line({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })];
    expect(finalTurnFromLines(codex, "codex")).toEqual({ completed: false, interrupted: true });
  });
});

describe("the worker's Hook answering from turn events", () => {
  let record: TurnRecord | undefined, final: FinalTurn | undefined, status: string, now: number;
  const readers = (): WorkerReaders => ({
    snapshot: async () => ({ panes: [{ ...workerPane, agent_status: status }] }),
    identity: async () => session, finalTurn: async () => final, turn: async () => record, now: () => now,
  });
  const turn = (...names: [string, Partial<Parameters<typeof nextTurn>[1]>?][]) =>
    names.reduce<TurnRecord | undefined>((value, [name, extra]) => nextTurn(value, event(name, { at: now, ...extra })), undefined);
  const ask = async () => (await workerStates({ targets: [target] }, readers())).workers[0];

  beforeEach(() => { now = Date.parse("2026-09-27T12:00:00Z"); status = "idle"; final = undefined; record = undefined; });

  it("keeps a worker whose prompt has no Stop working, however long the pane looks idle", async () => {
    record = turn(["SessionStart"], ["UserPromptSubmit"]);
    now += 60 * 60 * 1000;
    expect(await ask()).toEqual({ state: "working", session, hook: true });
    const value = receipt();
    observe(value, await ask(), now);
    expect(value.worker!.state).toBe("working");
    expect(value.returned).toBeUndefined();
  });

  it("is done when a Stop arrived after the prompt, with the Stop's own reply", async () => {
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "Parser checks done." }]);
    final = { completed: false };
    expect(await ask()).toEqual({ state: "done", session, hook: true, completed: true, endedAt: record!.stop!.at, stopSeq: record!.stop!.seq, reply: "Parser checks done." });
    // The transcript still carries a usage limit Codex ended the turn on.
    final = { completed: true, error: "You've hit your usage limit." };
    expect(await ask()).toMatchObject({ state: "done", error: "You've hit your usage limit." });
  });

  it("waits on the awaited tasks the transcript shows, then counts the worker done once the wait expires", async () => {
    record = turn(["UserPromptSubmit"], ["Stop", { background: 2, reply: "Suite started." }]);
    final = { completed: true, awaited: 2 };
    expect(await ask()).toEqual({ state: "working", session, hook: true, background: 2 });
    const value = receipt();
    observe(value, await ask(), now);
    expect(value.worker!.state).toBe("working");
    expect(BACKGROUND_WAIT_MS).toBe(2 * 60 * 60 * 1000);
    now += BACKGROUND_WAIT_MS - 1;
    expect(await ask()).toMatchObject({ state: "working", background: 2 });
    now += 1;
    const late = await ask();
    expect(late).toMatchObject({ state: "done", reply: "Suite started." });
    observe(value, late, now);
    expect(value.returned).toMatchObject({ state: "done" });
    expect(noticeLine([value])).toContain("parser checks done (after 2 background tasks finished), Suite started.");
  });

  it("counts the Stop's awaited tasks down as the transcript shows them finish, and returns once none are left", async () => {
    record = turn(["UserPromptSubmit"], ["Stop", { background: 2, reply: "Suite started." }]);
    const value = receipt();
    final = { completed: true, awaited: 2 };
    observe(value, await ask(), now);
    const at = (ms: number) => new Date(now + ms).toISOString();
    // A finish from before the Stop was not in its count; one after it was.
    final = { completed: true, awaited: 1, finishedTasks: [at(-5_000), at(60_000)] };
    now += 120_000;
    expect(await ask()).toEqual({ state: "working", session, hook: true, background: 1 });
    final = { completed: true, finishedTasks: [at(-5_000), at(60_000), at(90_000)] };
    const done = await ask();
    expect(done).toEqual({ state: "done", session, hook: true, completed: true, endedAt: expect.any(String), stopSeq: record!.stop!.seq, reply: "Suite started." });
    observe(value, done, now);
    expect(noticeLine([value])).toContain("parser checks done (after 2 background tasks finished), Suite started.");
  });

  it("reads awaited background work from the transcript when the Stop said nothing about it", async () => {
    record = turn(["UserPromptSubmit"], ["Stop"]);
    final = { completed: true, lastAssistant: "Started the gate.", awaited: 1 };
    expect(await ask()).toEqual({ state: "working", session, hook: true, background: 1 });
  });

  it("returns a worker whose Stop named only a leftover shell done, and one whose sub-agent still runs working", async () => {
    // A Stop whose count is a log tail or a dev server no one awaits.
    record = turn(["UserPromptSubmit"], ["Stop", { background: 6, reply: "Left it running." }]);
    final = { completed: true, endless: 6 };
    expect(await ask()).toEqual({ state: "done", session, hook: true, completed: true, endedAt: record!.stop!.at, stopSeq: record!.stop!.seq, reply: "Left it running." });
    // A leftover that is no stream (a build from an earlier exchange) does not
    // hold the return, but rides along so the pane is not closed on it.
    final = { completed: true, endless: 4 };
    expect(await ask()).toMatchObject({ state: "done", completed: true, background: 2 });
    // The same Stop with a sub-agent the child tree still reports running.
    const withChild = await workerStates({ targets: [target] }, { ...readers(), children: async () => 1 });
    expect(withChild.workers[0]).toEqual({ state: "working", session, hook: true, background: 1 });
  });

  it("keeps a worker whose reply waits on a task it left running working, and never done", async () => {
    // ios-fast-voice2 (Mini, 2026-10-01): returned done, its pane closed, its
    // MacBook test run going and its PR unopened.
    const reply = "There's one conflict in TalkVoice.swift. I'll resolve it on the follow-up branch, where both sets of changes meet. Now waiting on the MacBook rerun.";
    record = turn(["UserPromptSubmit"], ["Stop", { background: 1, reply }]);
    final = { completed: true, background: 1, lastAssistant: reply };
    expect(await ask()).toEqual({ state: "working", session, hook: true, background: 1 });
    const value = receipt();
    observe(value, await ask(), now);
    expect(value.worker!.state).toBe("working");
    // Once the run reports back, the next Stop is the turn's end.
    final = { completed: true, lastAssistant: reply, finishedTasks: [new Date(now + 1_000).toISOString()] };
    now += 2_000;
    const ended = await ask();
    expect(ended).toMatchObject({ state: "done", unfinished: "Stopped mid-task: I'll resolve it on the follow-up branch, where both sets of changes meet." });
    expect(ended).not.toHaveProperty("background");
    observe(value, ended, now);
    expect(value.returned).toMatchObject({ state: "needs-you" });
    // The same wait with nothing running is no done either.
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "PR #12 is open. Now waiting on CI." }]);
    final = { completed: true };
    expect(await ask()).toMatchObject({ state: "done", unfinished: "Stopped waiting: Now waiting on CI." });
  });

  it("never reports a worker stalled while its finished turn still awaits a background shell", async () => {
    // ios-chat-code-links (Mini, 2026-10-01): the turn ended while an awaited
    // xcodebuild queued on a lock; screen and transcript sat still for minutes.
    const detector = new StallDetector({ now: () => now, threshold: () => 300_000, screen: async () => "1 shell still running", transcript: async () => "same" });
    const watched = (): WorkerReaders => ({ ...readers(), stall: (seen, pane, live) => detector.observe(seen, pane, live) });
    const poll = async () => (await workerStates({ targets: [target] }, watched())).workers[0];
    record = turn(["UserPromptSubmit"], ["Stop", { background: 1, reply: "Waiting on the build." }]);
    final = { completed: true, awaited: 1 };
    for (let minute = 0; minute <= 15; minute += 1) {
      const seen = await poll();
      expect(seen).toEqual({ state: "working", session, hook: true, background: 1 });
      now += 60_000;
    }
    // Herdr can show the pane working too; the transcript's awaited shell still holds it.
    status = "working"; record = turn(["UserPromptSubmit"]);
    now += 600_000; expect(await poll()).not.toHaveProperty("stalled");
    // With nothing awaited, the same stillness is a stall.
    final = { completed: false };
    now += 300_000; expect(await poll()).toMatchObject({ state: "working", stalled: true });
  });

  it("returns a turn that ended announcing a next step, or with uncommitted work and no PR, as needs-you", async () => {
    // hook-permission-mode (OpenCode, Devbox, 2026-09-30) returned done on
    // this reply with nothing run after it, and its pane was closed.
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "The worktree lacks node_modules. Let me install dependencies." }]);
    const announced = await ask();
    expect(announced).toMatchObject({ state: "done", completed: true, unfinished: "Stopped mid-task: Let me install dependencies." });
    const value = receipt();
    observe(value, announced, now);
    expect(value.returned).toMatchObject({ state: "needs-you", question: "Stopped mid-task: Let me install dependencies.",
      reply: "The worktree lacks node_modules. Let me install dependencies." });
    expect(noticeLine([value])).toContain("parser checks needs you, Stopped mid-task: Let me install dependencies.");
    // Nine edited files left where the agent stopped, and no PR reported.
    const uncommitted = vi.fn(async (_directory: string) => 9);
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "Updated the permission mode.", cwd: "/work/phren-wt" }]);
    expect(record!.stop!.cwd).toBe("/work/phren-wt");
    const dirty = (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0];
    expect(dirty).toMatchObject({ state: "done", unfinished: "Stopped with 9 uncommitted files and no PR." });
    expect(uncommitted).toHaveBeenCalledWith("/work/phren-wt");
    const left = receipt();
    observe(left, dirty, now);
    expect(left.returned).toMatchObject({ state: "needs-you", question: "Stopped with 9 uncommitted files and no PR." });
    // A clean checkout with an ordinary closing line is done.
    uncommitted.mockResolvedValue(0);
    const clean = (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0];
    expect(clean).not.toHaveProperty("unfinished");
    const fresh = receipt();
    observe(fresh, clean, now + 1);
    expect(fresh.returned).toMatchObject({ state: "done" });
  });

  // Review of #283: a checkout read that timed out read as clean (done, pane
  // closed), and the same turn read needs-you a minute later: two returns.
  it("returns one finished turn once, however its checkout reads on later polls", async () => {
    const uncommitted = vi.fn(async (_directory: string): Promise<number | "unknown" | undefined> => "unknown");
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "Updated the permission mode.", cwd: "/work/phren-wt" }]);
    const unknown = (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0];
    expect(unknown).toMatchObject({ state: "done", unchecked: true });
    expect(unknown).not.toHaveProperty("unfinished");
    const value = receipt();
    expect(observe(value, unknown, now)).toBe(true);
    const first = value.returned!;
    expect(first).toMatchObject({ state: "done" });
    // Git answers on the next poll: nine files. The same turn is not returned again.
    uncommitted.mockResolvedValue(9);
    const dirty = (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0];
    expect(dirty).toMatchObject({ unfinished: "Stopped with 9 uncommitted files and no PR." });
    expect(observe(value, dirty, now + 15_000)).toBe(false);
    expect(value.returned).toBe(first);
    // The reverse: needs-you, then the owner commits the edits. Still one return.
    const other = receipt();
    observe(other, dirty, now);
    uncommitted.mockResolvedValue(0);
    expect(observe(other, (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0], now + 15_000)).toBe(false);
    expect(other.returned).toMatchObject({ state: "needs-you" });
    // A new turn is a new return.
    now += 60_000;
    record = nextTurn(record, event("UserPromptSubmit", { at: now }));
    record = nextTurn(record, event("Stop", { at: now + 1, reply: "Committed and pushed." }));
    expect(observe(other, (await workerStates({ targets: [target] }, { ...readers(), uncommitted })).workers[0], now + 2)).toBe(true);
    expect(other.returned).toMatchObject({ state: "done", reply: "Committed and pushed." });
  });

  it("asks git only about a checkout that is the worker's own", async () => {
    const uncommitted = vi.fn(async (_directory: string) => 4);
    record = turn(["UserPromptSubmit"], ["Stop", { reply: "Updated the permission mode.", cwd: "/work/phren" }]);
    const shared = vi.fn(async (_directory: string, folders: readonly unknown[]) => folders.includes("/work/phren"));
    const owner = { pane_id: "owner", workspace_id: "w1", tab_id: "t2", terminal_id: "term-owner", agent: "claude", agent_status: "idle", cwd: "/work/phren" };
    const both: WorkerReaders = { ...readers(), uncommitted, shared, snapshot: async () => ({ panes: [{ ...workerPane, agent_status: status }, owner] }) };
    expect((await workerStates({ targets: [target] }, both)).workers[0]).not.toHaveProperty("unfinished");
    expect(shared).toHaveBeenCalledWith("/work/phren", [undefined, "/work/phren"]);
    expect(uncommitted).not.toHaveBeenCalled();
    // Alone in its checkout, its changes are its own.
    const alone: WorkerReaders = { ...readers(), uncommitted, shared };
    expect((await workerStates({ targets: [target] }, alone)).workers[0]).toMatchObject({ unfinished: "Stopped with 4 uncommitted files and no PR." });
  });

  it("reports an interrupted turn as failed, and a finished turn whose Stop never arrived as done", async () => {
    record = turn(["UserPromptSubmit"]);
    final = { completed: false, interrupted: true };
    const interrupted = await ask();
    expect(interrupted).toEqual({ state: "done", session, hook: true, completed: true, interrupted: true });
    const value = receipt();
    observe(value, interrupted, now);
    expect(value.returned).toMatchObject({ state: "failed", error: INTERRUPTED });
    // Still working in Herdr: the transcript is not consulted.
    status = "working";
    expect(await ask()).toEqual({ state: "working", session, hook: true });
    status = "idle";
    final = { completed: true, lastAssistant: "Done anyway." };
    expect(await ask()).toMatchObject({ state: "done", completed: true, reply: "Done anyway." });
  });

  it("waits for a worker that has not taken its brief yet, and passes a blocked pane through", async () => {
    record = turn(["SessionStart"]);
    const value = receipt();
    observe(value, await ask(), now);
    observe(value, await ask(), now + 24 * 60 * 60 * 1000);
    expect(value.worker!.state).toBe("working");
    status = "blocked";
    record = turn(["UserPromptSubmit"]);
    expect(await ask()).toEqual({ state: "blocked", session, hook: true });
  });

  it("ignores a record of another conversation or terminal, falling back to the pane", async () => {
    record = { ...turn(["UserPromptSubmit"])!, session: "00000009-1111-4111-8111-111111111111" };
    final = { completed: true, lastAssistant: "Old heuristics." };
    expect(await ask()).toEqual({ state: "idle", session, completed: true, reply: "Old heuristics." });
    record = { ...turn(["UserPromptSubmit"])!, terminal: "term-old" };
    expect((await ask()).hook).toBeUndefined();
  });

  it("matches the record by dispatch id when both sides name one", async () => {
    const mine = "40000000-0000-4000-8000-000000000001", other = "40000000-0000-4000-8000-000000000002";
    record = turn(["SessionStart", { dispatch: mine }], ["UserPromptSubmit"], ["Stop", { reply: "Mine." }]);
    expect(record!.dispatch).toBe(mine);
    const askFor = async (dispatch: string) => (await workerStates({ targets: [{ ...target, dispatch }] }, readers())).workers[0];
    expect(await askFor(mine)).toMatchObject({ state: "done", hook: true, reply: "Mine." });
    // Another dispatch's worker in this pane is not this receipt's return.
    expect((await askFor(other)).hook).toBeUndefined();
  });

  it("names each finished turn by its Stop, so the same reply twice is two returns", () => {
    const value = receipt();
    observe(value, { state: "done", hook: true, completed: true, endedAt: "2026-09-27T12:00:00.000Z", reply: "Done." }, now);
    const first = value.returned!.turn;
    expect(observe(value, { state: "done", hook: true, completed: true, endedAt: "2026-09-27T12:00:00.000Z", reply: "Done." }, now + 1)).toBe(false);
    expect(observe(value, { state: "done", hook: true, completed: true, endedAt: "2026-09-27T12:05:00.000Z", reply: "Done." }, now + 2)).toBe(true);
    expect(value.returned!.turn).not.toBe(first);
  });
});

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  const at = new Date(0).toISOString();
  return { id: "40000000-0000-4000-8000-000000000001", computer: "Devbox", project: "phren", harness: "claude", label: "parser checks",
    createdAt: at, updatedAt: at, state: "accepted", target, ...overrides } as Receipt;
}

// The Hook's agent socket is a Unix domain socket at a file path, which Node cannot listen on under Windows.
describe.skipIf(process.platform === "win32")("the Hook recording a worker's turn events", () => {
  let hooks: AgentHooks;
  const post = (body: unknown): Promise<string> => new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  beforeEach(async () => {
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [workerPane] });
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    hooks = new AgentHooks();
    await hooks.start();
  });
  afterEach(() => hooks.close());

  it("records the prompt and the Stop with its background count and reply", async () => {
    expect(await post({ target, event: "SessionStart", dispatchId: "40000000-0000-4000-8000-000000000001" })).toBe("{}");
    expect((await readTurn("default", "w1:p2"))!.dispatch).toBe("40000000-0000-4000-8000-000000000001");
    expect(turnPhase((await readTurn("default", "w1:p2"))!)).toEqual({ phase: "unprompted" });
    expect(await post({ target, event: "UserPromptSubmit", prompt: "Run the parser checks" })).toBe("{}");
    expect(turnPhase((await readTurn("default", "w1:p2"))!).phase).toBe("working");
    await post({ target, event: "Stop", background: 1, reply: "Started the suite." });
    expect(turnPhase((await readTurn("default", "w1:p2"))!)).toMatchObject({ phase: "ended", background: 1, reply: "Started the suite." });
  });

  it("confirms a picture send, which Claude submits with an [Image #N] label in place of its path", async () => {
    await post({ target, event: "SessionStart" });
    const typed = "Look at this probe picture\n\nAttached files on this computer:\n/Users/me/.local/share/phren/bridge/uploads/s/1c74-Screen Shot.png";
    const delivery = hooks.deliveries.expect(target, typed, 1_500);
    expect(await post({ target, event: "UserPromptSubmit", prompt: "[Image #26]Look at this probe picture\nAttached files on this computer:" })).toBe("{}");
    expect(await delivery).toBe("delivered");
  });

  it("settles the same words typed twice into a pane by conversation, then oldest first", async () => {
    await post({ target, event: "SessionStart" });
    const first = { ...target, session: "00000009-1111-4111-8111-111111111111" };
    const toFirst = hooks.deliveries.expect(first, "Same words", 1_500, undefined, "same-words-1"), toThis = hooks.deliveries.expect(target, "Same words", 1_500, undefined, "same-words-2");
    hooks.deliveries.queue("same-words-1", first); hooks.deliveries.queue("same-words-2", target);
    expect(await post({ target, event: "UserPromptSubmit", prompt: "Same words" })).toBe("{}");
    expect(await toThis).toBe("delivered");
    expect(hooks.deliveries.status("same-words-2", target).state).toBe("delivered");
    expect(hooks.deliveries.status("same-words-1", first).state).toBe("queued");
    expect(hooks.deliveries.pending(first, "Same words")).toBe(true);
    void toFirst;
  });

  it("settles a phone message by its delivery id, and keeps only a hash of the typed words", async () => {
    await post({ target, event: "SessionStart" });
    const queued = hooks.deliveries.expect(target, "Run the suite again", 1, undefined, "by-id-0001");
    expect(await queued).toBe("pending");
    // Not answered yet: the phone has no reply to ask about.
    expect(hooks.deliveries.status("by-id-0001", target).state).toBe("unknown");
    hooks.deliveries.queue("by-id-0001", target);
    expect(hooks.deliveries.forPane(target)).toEqual([{ deliveryId: "by-id-0001", state: "queued", session: target.session }]);
    expect(JSON.stringify((hooks.deliveries as unknown as { records: unknown[] }).records)).not.toContain("suite");
    expect(await post({ target, event: "UserPromptSubmit", prompt: "<pasted_content id=\"3\">\nRun the suite   again\n</pasted_content id=\"3\">" })).toBe("{}");
    expect(hooks.deliveries.status("by-id-0001", target).state).toBe("delivered");
    // One the Hook answered uncertain still turns delivered when its hook takes it.
    const uncertain = hooks.deliveries.expect(target, "Check the logs", 1, undefined, "by-id-0002");
    expect(await uncertain).toBe("pending");
    expect(await post({ target, event: "UserPromptSubmit", prompt: "Check the logs" })).toBe("{}");
    expect(hooks.deliveries.status("by-id-0002", target).state).toBe("delivered");
    // A late queue call never moves a settled message back.
    hooks.deliveries.queue("by-id-0002", target);
    expect(hooks.deliveries.status("by-id-0002", target).state).toBe("delivered");
  });

  it("delivers a message queued for a conversation the pane has since replaced to the one there now", async () => {
    await post({ target, event: "SessionStart" });
    // Sent while the pane showed an older conversation (a Codex thread change, a /clear).
    const meant = { ...target, session: "00000009-1111-4111-8111-111111111111" };
    const delivery = hooks.deliveries.expect(meant, "Only for the pane", 1, undefined, "rotated-0001");
    expect(await delivery).toBe("pending");
    hooks.deliveries.queue("rotated-0001", meant);
    expect(await post({ target, event: "UserPromptSubmit", prompt: "Only for the pane" })).toBe("{}");
    // Asked by either conversation's target: the record belongs to the pane.
    expect(hooks.deliveries.status("rotated-0001", meant)).toEqual({ state: "delivered", session: target.session });
    expect(hooks.deliveries.forPane(target)).toEqual([{ deliveryId: "rotated-0001", state: "delivered", session: target.session }]);
    expect(turnPhase((await readTurn("default", "w1:p2"))!).phase).toBe("working");
  });
});

describe("notices to the dispatching agent", () => {
  const origin = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", agent: "claude" as const, terminal: "term-c" };
  const conductor = (agent_status: string) => ({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", terminal_id: "term-c", agent_status }] });

  it("tells a conductor that was busy on the next tick, under a stable delivery id", async () => {
    const value = receipt({ origin });
    observe(value, { state: "done", hook: true, completed: true, endedAt: "2026-09-27T12:00:00.000Z", reply: "Done." }, 1);
    await atomicInPrivateDir(path.join(bridge, "dispatches", `${value.id}.json`), value);
    let clock = Date.parse("2026-09-27T12:00:00Z"), local = conductor("working");
    const deliver = vi.fn(async (_target: Target, _text: string, _id: string) => ({ delivered: true }));
    const returns = new DispatchReturns({ peers: async () => [], isLocal: () => false, snapshot: async () => local,
      identity: async () => "00000002-1111-4111-8111-111111111111", deliver, now: () => clock });
    await returns.tick();
    expect(deliver).not.toHaveBeenCalled();
    // Five seconds later, well before the next poll, the conductor has stopped.
    local = conductor("idle"); clock += 5_000;
    expect(clock - Date.parse("2026-09-27T12:00:00Z")).toBeLessThan(POLL_MS);
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, text, id] = deliver.mock.calls[0];
    expect(text).toBe(noticeLine([value]));
    expect(id).toBe(noticeDeliveryId([value]));
    expect(id).toMatch(/^notice-[a-f0-9]{32}$/);
    expect((await dispatchStatus())[0].returned).toMatchObject({ notifiedAt: expect.any(String) });
    // Told once: a later tick types nothing more.
    clock += 5_000;
    await returns.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
