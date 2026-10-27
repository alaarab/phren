import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopFacts } from "./agent-hook-callback.js";
import { latestStopTasks, noteTurn, readTurn, STOP_TASKS_LIMIT } from "./turn-records.js";

const session = "00000005-1111-4111-8111-111111111111";
const turn = (event: string, extra: Partial<Parameters<typeof noteTurn>[2]> = {}) =>
  ({ event, terminal: "term-1", source: "claude" as const, session, ...extra });

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
