import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopFacts } from "./agent-hook-callback.js";
import { latestStopTasks, nextTurn, noteTurn, opencodeTurn, readTurn, STOP_TASKS_LIMIT, turnPhase } from "./turn-records.js";

const session = "00000005-1111-4111-8111-111111111111";
const turn = (event: string, extra: Partial<Parameters<typeof noteTurn>[2]> = {}) =>
  ({ event, input: "owner" as const, terminal: "term-1", source: "claude" as const, session, ...extra });

let bridge: string;
beforeEach(async () => {
  bridge = await mkdtemp(path.join(tmpdir(), "phren-turn-records-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

describe("a Stop's background task list", () => {
  it("keeps a running agent listed after 64 finished tasks", async () => {
    const tasks = [...Array.from({ length: 64 }, (_, i) => ({ id: `bshell${i}`, status: "completed" })), { id: "a1", status: "running" }];
    await noteTurn("default", "w1:p1", turn("Stop", stopFacts({ background_tasks: tasks })));
    expect((await readTurn("default", "w1:p1"))!.stop).toMatchObject({ background: 1, tasks: { running: ["a1"], finished: tasks.slice(0, 64).map(task => task.id) } });
    expect((await readTurn("default", "w1:p1"))!.stop!.tasks!.truncated).toBeUndefined();
  });

  it("keeps running tasks first past the limit and says the list was cut", async () => {
    const finished = Array.from({ length: STOP_TASKS_LIMIT }, (_, i) => ({ id: `b${"x".repeat(100)}${i}`, status: "completed" }));
    const running = Array.from({ length: 3 }, (_, i) => ({ id: `a${"y".repeat(120)}${i}`, status: "running" }));
    await noteTurn("default", "w1:p1", turn("Stop", { ...stopFacts({ background_tasks: [...finished, ...running] }), reply: "\u0001".repeat(4000) }));
    const tasks = (await readTurn("default", "w1:p1"))!.stop!.tasks!;
    expect(tasks.running).toEqual(running.map(task => task.id));
    expect(tasks.finished).toHaveLength(STOP_TASKS_LIMIT - 3);
    expect(tasks.truncated).toBe(true);
  });

  it("sheds tasks rather than write a record too large to read back", async () => {
    const running = Array.from({ length: STOP_TASKS_LIMIT }, (_, i) => ({ id: `a${"y".repeat(120)}${i}`, status: "running" }));
    await noteTurn("default", "w1:p1", turn("Stop", { ...stopFacts({ background_tasks: running }), reply: "\u0001".repeat(4000),
      cwd: "/" + "目".repeat(4095), terminal: "\u0002".repeat(200) }));
    const stop = (await readTurn("default", "w1:p1"))!.stop!;
    expect(stop.cwd).toHaveLength(4096);
    expect(stop.tasks!.running.length).toBeGreaterThan(100);
    expect(stop.tasks!.running).toEqual(running.slice(0, stop.tasks!.running.length).map(task => task.id));
    expect(stop.tasks!.truncated).toBe(true);
  });
});

describe("the conversation's newest record", () => {
  it("prefers, at the same millisecond, the pane that went on past its Stop", async () => {
    const at = Date.now();
    await noteTurn("default", "w1:p2", turn("Stop", { terminal: "term-2", at: at - 1_000, backgroundTasks: [{ id: "aold", running: true }] }));
    await noteTurn("default", "w1:p2", turn("SessionStart", { terminal: "term-2", start: "compact", at }));
    // The closed pane's Stop, written in that same millisecond, sorts first and second alike.
    for (const [index, pane] of ["w1:p1", "w1:p3"].entries()) {
      await noteTurn("default", pane, turn("Stop", { terminal: `term-${pane}`, at, backgroundTasks: [{ id: "adead", running: true }] }));
      vi.useFakeTimers({ now: at + 3_000 * (index + 1), toFake: ["Date"] });
      expect(await latestStopTasks("claude", session)).toMatchObject({ running: ["aold"] });
      vi.useRealTimers();
      await rm(path.join(bridge, "turns", "default", encodeURIComponent(pane) + ".json"));
    }
  });
});

describe("OpenCode's advancing turn sequence", () => {
  it("keeps a conversation's Stop sequence across a reload", async () => {
    const store = path.join(bridge, "store"), folder = path.join(store, ".runtime", "sessions");
    await mkdir(folder, { recursive: true });
    vi.stubEnv("PHREN_PATH", store);
    const file = path.join(folder, "opencode-status-41.json");
    const stamp = (busyAt: string, idleAt: string) =>
      writeFile(file, JSON.stringify({ status: "idle", session: "ses_reload", at: idleAt, busyAt, idleAt }));
    await stamp("2026-09-01T00:00:01Z", "2026-09-01T00:00:02Z");
    expect((await opencodeTurn([41], "term-o"))!.stop!.seq).toBe(2);
    vi.resetModules();
    const reloaded = await import("./turn-records.js");
    await stamp("2026-09-01T00:00:03Z", "2026-09-01T00:00:04Z");
    expect((await reloaded.opencodeTurn([41], "term-o"))!.stop!.seq).toBe(4);
  });
});

describe("automatic input keeps the owner's turn", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 1, 15, 0, 0, ms)).toISOString();
  const prompt = () => turn("UserPromptSubmit", { at: Date.parse(at(0)) });

  it("does not advance the owner prompt, generation or completion identity", () => {
    const owner = nextTurn(undefined, prompt())!;
    const notified = nextTurn(owner, turn("UserPromptSubmit", { at: Date.parse(at(1_000)), input: "notification" }))!;
    expect(notified.prompt).toEqual(owner.prompt);
    expect(notified.notification).toMatchObject({ at: at(1_000), reason: "input:notification" });
    expect(turnPhase(notified)).toEqual({ phase: "working", since: owner.prompt!.at });
    // A genuine final Stop still ends the owner's turn.
    const stopped = nextTurn(notified, turn("Stop", { at: Date.parse(at(2_000)), reply: "Done." }))!;
    expect(turnPhase(stopped)).toMatchObject({ phase: "ended", reply: "Done." });
    expect(stopped.prompt).toEqual(owner.prompt);
  });

  it("keeps the owner anchor across a reload after a notification", async () => {
    await noteTurn("default", "w1:p1", prompt());
    const owner = (await readTurn("default", "w1:p1"))!.prompt;
    await noteTurn("default", "w1:p1", turn("UserPromptSubmit", { at: Date.parse(at(1_000)), input: "notification" }));
    const reloaded = await readTurn("default", "w1:p1");
    expect(reloaded!.prompt).toEqual(owner);
    expect(reloaded!.notification).toMatchObject({ reason: "input:notification" });
    expect(turnPhase(reloaded!)).toEqual({ phase: "working", since: owner!.at });
  });

  it("does not let a notification-associated Stop end a working foreground turn", () => {
    const owner = nextTurn(undefined, prompt())!;
    const notified = nextTurn(owner, turn("UserPromptSubmit", { at: Date.parse(at(1_000)), input: "notification" }))!;
    const stopped = nextTurn(notified, turn("Stop", { at: Date.parse(at(2_000)), notificationStop: true, background: 1 }))!;
    expect(stopped.stop).toBeUndefined();
    expect(stopped.notification).toMatchObject({ reason: "stop:notification" });
    expect(turnPhase(stopped)).toEqual({ phase: "working", since: owner.prompt!.at });
  });
});
